// Context assembly: a symbol-aware chunk index with BM25 ranking and a hard token budget.
//
// Strategy (also described in WRITEUP.md):
//  1. Index every text source file once (skip VCS/venv/build dirs). Python is chunked per
//     top-level def/class (with decorators; long classes split per method), docs per heading,
//     everything else in 60-line windows.
//  2. Terms = identifiers split on snake/camel case + light stemming; path segments are
//     indexed too with a boost, so "cli" matches src/flask/cli.py.
//  3. For a request: explicit @file / @symbol mentions are included first (capped at 45% of
//     the budget), then a compact repo map (<=15%), then BM25-ranked chunks, at most 3 per
//     file, until the budget is spent. Every included item carries the terms that matched,
//     which the panel shows as "why".
import * as fs from "fs";
import * as path from "path";

export interface Chunk {
  id: number;
  file: string; // workspace-relative, forward slashes
  start: number; // 1-based inclusive
  end: number;
  title: string;
  text: string;
  tf: Map<string, number>;
  len: number;
}

export interface SymbolDef {
  name: string;
  kind: "class" | "function" | "method" | "heading" | "command";
  file: string;
  line: number;
  endLine: number;
  signature: string;
  parent?: string;
}

export interface ContextItem {
  file: string;
  start: number;
  end: number;
  title: string;
  tokens: number;
  score: number;
  reason: string;
  source: "mention" | "retrieval" | "repo-map";
}

export interface AssembledContext {
  text: string;
  items: ContextItem[];
  usedTokens: number;
  budgetTokens: number;
  query: string[];
}

const SKIP_DIRS = new Set([
  ".git", ".venv", "venv", "env", "node_modules", "__pycache__", ".tox", ".mypy_cache",
  ".pytest_cache", "build", "dist", "out", ".idea", ".vscode", "site-packages", ".nox", "htmlcov",
]);
const TEXT_EXT = new Set([
  ".py", ".pyi", ".rst", ".md", ".txt", ".toml", ".cfg", ".ini", ".yaml", ".yml", ".json",
  ".js", ".ts", ".tsx", ".jsx", ".html", ".css", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".sh",
]);
const STOP = new Set(
  "a an the and or of to in on for with as by is are be it this that from at into any all must its their should would will can not no do does use used using also well add new make value values".split(
    " ",
  ),
);

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export type Role = "impl" | "test" | "docs" | "other";
export function roleOf(file: string): Role {
  const f = file.toLowerCase();
  if (/(^|\/)(tests?|testing)\//.test(f) || /(^|\/)test_[^/]+\.py$|_test\.(py|go|ts|js)$|\.(spec|test)\.[jt]sx?$/.test(f)) return "test";
  if (/\.(rst|md|txt)$/.test(f) || f.startsWith("docs/")) return /^(changes|changelog|history)/.test(f) ? "other" : "docs";
  if (/\.(py|pyi|js|ts|tsx|jsx|go|rs|java|c|h|cpp)$/.test(f)) return "impl";
  return "other";
}

function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    const whole = raw.toLowerCase();
    if (whole.length > 2 && !STOP.has(whole)) out.push(stem(whole));
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[_\s]+/)
      .map((p) => p.toLowerCase())
      .filter((p) => p.length > 1 && !STOP.has(p));
    if (parts.length > 1) for (const p of parts) out.push(stem(p));
  }
  return out;
}

const PY_DEF = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const PY_CLASS = /^(\s*)class\s+([A-Za-z_]\w*)/;
const PY_CLICK = /^\s*@[\w.]*command\(\s*["']([\w-]+)["']/;

export class RepoIndex {
  root = "";
  files: string[] = [];
  chunks: Chunk[] = [];
  symbols: SymbolDef[] = [];
  private df = new Map<string, number>();
  private avgLen = 1;
  builtAt = 0;
  totalLines = 0;

  build(root: string, maxFiles = 6000): this {
    this.root = root;
    this.files = [];
    this.chunks = [];
    this.symbols = [];
    this.df.clear();
    this.totalLines = 0;
    const walk = (dir: string) => {
      if (this.files.length >= maxFiles) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".") && e.name !== ".github") {
          if (e.isDirectory()) continue;
        }
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !e.name.endsWith(".egg-info")) walk(full);
        } else if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) {
          try {
            if (fs.statSync(full).size > 400_000) continue;
          } catch {
            continue;
          }
          this.files.push(path.relative(root, full).split(path.sep).join("/"));
        }
      }
    };
    walk(root);
    for (const f of this.files) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(root, f), "utf8");
      } catch {
        continue;
      }
      this.indexFile(f, text);
    }
    this.finish();
    this.builtAt = Date.now();
    return this;
  }

  /** Re-index one file after an accepted edit. */
  updateFile(rel: string, text: string | null) {
    this.chunks = this.chunks.filter((c) => c.file !== rel);
    this.symbols = this.symbols.filter((s) => s.file !== rel);
    if (text !== null) {
      if (!this.files.includes(rel)) this.files.push(rel);
      this.indexFile(rel, text);
    }
    this.finish();
  }

  private finish() {
    this.df.clear();
    let total = 0;
    this.chunks.forEach((c, i) => {
      c.id = i;
      total += c.len;
      for (const t of c.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    });
    this.avgLen = Math.max(1, total / Math.max(1, this.chunks.length));
  }

  private addChunk(file: string, lines: string[], start: number, end: number, title: string) {
    const text = lines.slice(start - 1, end).join("\n");
    if (!text.trim()) return;
    const tf = new Map<string, number>();
    const pathTerms = tokenize(file.replace(/[/.]/g, " "));
    for (const t of tokenize(title + "\n" + text)) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of pathTerms) tf.set(t, (tf.get(t) ?? 0) + 3); // path boost
    let len = 0;
    for (const v of tf.values()) len += v;
    this.chunks.push({ id: 0, file, start, end, title, text, tf, len });
  }

  private indexFile(file: string, text: string) {
    const lines = text.split(/\r?\n/);
    this.totalLines += lines.length;
    const ext = path.extname(file).toLowerCase();
    if (ext === ".py" || ext === ".pyi") return this.indexPython(file, lines);
    if (ext === ".rst" || ext === ".md") return this.indexDoc(file, lines);
    for (let s = 1; s <= lines.length; s += 60)
      this.addChunk(file, lines, s, Math.min(lines.length, s + 59), `${file}:${s}`);
  }

  private indexPython(file: string, lines: string[]) {
    type Top = { name: string; kind: "class" | "function"; start: number; defLine: number; cli?: string };
    const tops: Top[] = [];
    let pendingDeco = -1;
    let clickName: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^@/.test(l)) {
        if (pendingDeco < 0) pendingDeco = i;
        const c = PY_CLICK.exec(l);
        if (c) clickName = c[1];
        continue;
      }
      const d = PY_DEF.exec(l);
      const c = PY_CLASS.exec(l);
      const m = d ?? c;
      if (m && m[1] === "") {
        const start = pendingDeco >= 0 ? pendingDeco : i;
        tops.push({ name: m[2], kind: c ? "class" : "function", start: start + 1, defLine: i + 1, cli: clickName ?? undefined });
        this.symbols.push({
          name: m[2],
          kind: c ? "class" : "function",
          file,
          line: i + 1,
          endLine: i + 1,
          signature: l.trim().replace(/:\s*$/, ""),
        });
        if (clickName)
          this.symbols.push({
            name: clickName,
            kind: "command",
            file,
            line: i + 1,
            endLine: i + 1,
            signature: `CLI command "${clickName}" -> ${m[2]}`,
          });
      } else if (m && m[1] !== "" && d) {
        const parent = tops.length ? tops[tops.length - 1] : undefined;
        if (parent && parent.kind === "class")
          this.symbols.push({
            name: m[2],
            kind: "method",
            file,
            line: i + 1,
            endLine: i + 1,
            signature: l.trim().replace(/:\s*$/, ""),
            parent: parent.name,
          });
      }
      if (l.trim() && !/^\s/.test(l) && !/^@/.test(l)) {
        pendingDeco = -1;
        clickName = null;
      }
    }
    // Module header (imports, constants) as its own chunk.
    const firstTop = tops.length ? tops[0].start : lines.length + 1;
    if (firstTop > 1) this.addChunk(file, lines, 1, Math.min(firstTop - 1, 80), `${file} (module header)`);
    for (let t = 0; t < tops.length; t++) {
      const start = tops[t].start;
      let end = (t + 1 < tops.length ? tops[t + 1].start : lines.length + 1) - 1;
      while (end > start && !lines[end - 1].trim()) end--;
      const sym = this.symbols.find((s) => s.file === file && s.line === tops[t].defLine && s.kind !== "command");
      if (sym) sym.endLine = end;
      const title = tops[t].cli ? `built-in cli command "${tops[t].cli}" (${tops[t].name})` : `${tops[t].kind} ${tops[t].name}`;
      if (end - start > 120 && tops[t].kind === "class") {
        // split per method
        const methods = this.symbols.filter(
          (s) => s.file === file && s.kind === "method" && s.parent === tops[t].name && s.line > start && s.line <= end,
        );
        // Method start = its def line moved up over its decorators.
        const starts = methods.map((m) => {
          let ms = m.line;
          while (ms - 1 > start && /^\s*@/.test(lines[ms - 2])) ms--;
          return ms;
        });
        if (!methods.length) {
          this.addChunk(file, lines, start, end, title);
        } else {
          if (starts[0] > start) this.addChunk(file, lines, start, starts[0] - 1, title);
          for (let k = 0; k < methods.length; k++) {
            const mEnd = k + 1 < methods.length ? starts[k + 1] - 1 : end;
            methods[k].endLine = mEnd;
            this.addChunk(file, lines, starts[k], mEnd, `${tops[t].name}.${methods[k].name}`);
          }
        }
      } else {
        this.addChunk(file, lines, start, end, title);
      }
    }
  }

  private indexDoc(file: string, lines: string[]) {
    const heads: Array<{ line: number; title: string }> = [];
    for (let i = 1; i < lines.length; i++) {
      if (/^([=\-~^"#*+])\1{2,}\s*$/.test(lines[i]) && lines[i - 1].trim() && !/^([=\-~^"#*+])\1+/.test(lines[i - 1]))
        heads.push({ line: i, title: lines[i - 1].trim() });
      else if (/^#{1,4}\s+\S/.test(lines[i - 1])) heads.push({ line: i, title: lines[i - 1].replace(/^#+\s*/, "") });
    }
    if (!heads.length) {
      for (let s = 1; s <= lines.length; s += 60)
        this.addChunk(file, lines, s, Math.min(lines.length, s + 59), `${file}:${s}`);
      return;
    }
    if (heads[0].line > 1) this.addChunk(file, lines, 1, heads[0].line - 1, `${file} (intro)`);
    for (let h = 0; h < heads.length; h++) {
      const start = heads[h].line;
      const end = h + 1 < heads.length ? heads[h + 1].line - 1 : lines.length;
      this.symbols.push({ name: heads[h].title, kind: "heading", file, line: start, endLine: end, signature: heads[h].title });
      for (let s = start; s <= end; s += 80)
        this.addChunk(file, lines, s, Math.min(end, s + 79), `section "${heads[h].title}"`);
    }
  }

  search(query: string | string[], k = 10, filter?: (c: Chunk) => boolean) {
    const q = Array.isArray(query) ? query : tokenize(query);
    const uniq = [...new Set(q)];
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i + 1 < q.length; i++) if (q[i] !== q[i + 1]) pairs.push([q[i], q[i + 1]]);
    const N = this.chunks.length;
    const k1 = 1.2;
    const b = 0.75;
    const scored: Array<{ chunk: Chunk; score: number; matched: string[] }> = [];
    for (const c of this.chunks) {
      if (filter && !filter(c)) continue;
      let s = 0;
      const matched: string[] = [];
      for (const t of uniq) {
        const f = c.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.len) / this.avgLen)));
        matched.push(t);
      }
      if (s <= 0) continue;
      // Adjacent query terms that co-occur ("cli command", "debug flag") are strong evidence.
      for (const [x, y] of pairs) if (c.tf.has(x) && c.tf.has(y)) s += 0.6;
      // Prior: code over prose, so docs/changelogs don't drown the implementation.
      s *= roleOf(c.file) === "docs" ? 0.75 : roleOf(c.file) === "other" ? 0.6 : 1;
      scored.push({ chunk: c, score: s, matched });
    }
    scored.sort((x, y) => y.score - x.score);
    return scored.slice(0, k);
  }

  findSymbol(name: string): SymbolDef[] {
    const n = name.replace(/\(\)$/, "");
    const [cls, meth] = n.includes(".") ? n.split(".", 2) : [undefined, n];
    const exact = this.symbols.filter((s) => s.name === meth && (!cls || s.parent === cls || s.file.includes(cls)));
    if (exact.length) return exact;
    const lower = meth.toLowerCase();
    return this.symbols.filter((s) => s.name.toLowerCase().includes(lower)).slice(0, 20);
  }

  /** One line per file with its top-level symbols, trimmed to `maxTokens`. */
  repoMap(maxTokens = 1500, prefix = ""): string {
    const byFile = new Map<string, string[]>();
    for (const s of this.symbols) {
      if (s.kind === "method" || s.kind === "heading") continue;
      if (prefix && !s.file.startsWith(prefix)) continue;
      const arr = byFile.get(s.file) ?? [];
      arr.push(s.kind === "command" ? `cmd:${s.name}` : s.name);
      byFile.set(s.file, arr);
    }
    const out: string[] = [];
    let used = 0;
    const files = [...byFile.keys()].sort((a, b) => {
      const pa = a.startsWith("src/") ? 0 : a.startsWith("tests/") ? 1 : 2;
      const pb = b.startsWith("src/") ? 0 : b.startsWith("tests/") ? 1 : 2;
      return pa - pb || a.localeCompare(b);
    });
    const docFiles = this.files.filter((f) => /\.(rst|md)$/.test(f) && (!prefix || f.startsWith(prefix)));
    for (const f of files) {
      const syms = byFile.get(f)!;
      const line = `${f}: ${syms.slice(0, 25).join(", ")}${syms.length > 25 ? ` …(+${syms.length - 25})` : ""}`;
      const t = estimateTokens(line) + 1;
      if (used + t > maxTokens) {
        out.push(`… (${files.length - out.length} more files; use repo_map with a path prefix)`);
        return out.join("\n");
      }
      out.push(line);
      used += t;
    }
    const docs = `docs: ${docFiles.join(", ")}`;
    if (used + estimateTokens(docs) <= maxTokens) out.push(docs);
    return out.join("\n");
  }

  readRange(file: string, start: number, end: number): string {
    const c = this.chunks.find((x) => x.file === file && x.start === start && x.end === end);
    if (c) return c.text;
    try {
      return fs.readFileSync(path.join(this.root, file), "utf8").split(/\r?\n/).slice(start - 1, end).join("\n");
    } catch {
      return "";
    }
  }
}

export interface Mention {
  kind: "file" | "symbol";
  value: string;
}

export function parseMentions(text: string): { mentions: Mention[]; clean: string } {
  const mentions: Mention[] = [];
  const clean = text.replace(/@(file|symbol):?([\w./\\-]+(?:\.[\w]+)?)|@([\w./-]+\.[A-Za-z]{1,5})\b/g, (m, kind, v1, v2) => {
    if (kind === "symbol") mentions.push({ kind: "symbol", value: v1 });
    else mentions.push({ kind: "file", value: (v1 ?? v2).replace(/\\/g, "/") });
    return m;
  });
  return { mentions, clean };
}

function numbered(text: string, start: number): string {
  return text
    .split("\n")
    .map((l, i) => `${String(start + i).padStart(4)}| ${l}`)
    .join("\n");
}

export function assembleContext(
  index: RepoIndex,
  request: string,
  opts: { budgetTokens: number; extraFiles?: Array<{ file: string; text: string }> },
): AssembledContext {
  const budget = opts.budgetTokens;
  const { mentions } = parseMentions(request);
  const items: ContextItem[] = [];
  const parts: string[] = [];
  let used = 0;
  const seen = new Set<string>();
  const add = (item: ContextItem, body: string) => {
    parts.push(body);
    items.push(item);
    used += item.tokens;
    seen.add(`${item.file}:${item.start}`);
  };

  // 1. explicit mentions
  const mentionCap = Math.floor(budget * 0.45);
  for (const m of mentions) {
    if (used >= mentionCap) break;
    if (m.kind === "file") {
      const f = index.files.find((x) => x === m.value || x.endsWith("/" + m.value)) ?? m.value;
      let text: string;
      try {
        text = fs.readFileSync(path.join(index.root, f), "utf8");
      } catch {
        continue;
      }
      let lines = text.split(/\r?\n/);
      let end = lines.length;
      const room = mentionCap - used;
      while (estimateTokens(lines.slice(0, end).join("\n")) > room && end > 20) end = Math.floor(end * 0.8);
      lines = lines.slice(0, end);
      const body = numbered(lines.join("\n"), 1);
      add(
        { file: f, start: 1, end, title: "whole file", tokens: estimateTokens(body), score: 99, reason: `@${m.value} mentioned`, source: "mention" },
        `### ${f} (lines 1-${end}${end < text.split(/\r?\n/).length ? ", truncated" : ""}) — mentioned by user\n${body}`,
      );
    } else {
      for (const s of index.findSymbol(m.value).slice(0, 3)) {
        const body = numbered(index.readRange(s.file, s.line, s.endLine), s.line);
        const t = estimateTokens(body);
        if (used + t > mentionCap) break;
        add(
          { file: s.file, start: s.line, end: s.endLine, title: s.signature, tokens: t, score: 99, reason: `@symbol ${m.value}`, source: "mention" },
          `### ${s.file}:${s.line}-${s.endLine} — ${s.signature} (mentioned by user)\n${body}`,
        );
      }
    }
  }

  // 2. repo map
  const mapBody = index.repoMap(Math.floor(budget * 0.15));
  const mapT = estimateTokens(mapBody);
  if (used + mapT < budget) {
    parts.push(`### Repository map (top-level symbols per file)\n${mapBody}`);
    items.push({ file: "(repo map)", start: 0, end: 0, title: `${index.files.length} files`, tokens: mapT, score: 0, reason: "orientation", source: "repo-map" });
    used += mapT;
  }

  // 3. retrieval
  const q = tokenize(request.replace(/@\S+/g, " "));
  const raw = index.search(q, 150);
  // File-level evidence: a file with several relevant chunks (e.g. the module that defines
  // all the CLI commands) beats a file with one chunk that happens to repeat a common word.
  const byFile = new Map<string, number[]>();
  for (const h of raw) byFile.set(h.chunk.file, [...(byFile.get(h.chunk.file) ?? []), h.score]);
  const fileScore = new Map<string, number>();
  for (const [f, sc] of byFile) {
    const s = sc.sort((x, y) => y - x);
    fileScore.set(f, s[0] + 0.5 * (s[1] ?? 0) + 0.25 * (s[2] ?? 0) + 0.1 * s.slice(3, 10).reduce((a, b) => a + b, 0));
  }
  const ranked = raw
    .map((h) => ({ ...h, score: h.score + 0.35 * (fileScore.get(h.chunk.file) ?? 0) }))
    .sort((x, y) => y.score - x.score);
  // Role-balanced order: a code change usually spans implementation, tests and docs, so the
  // best chunk of each role goes first, then everything else by score.
  const firsts: typeof ranked = [];
  const wantDocs = /\b(docs?|document\w*|readme)\b/i.test(request);
  for (const role of ["impl", "test", ...(wantDocs ? ["docs"] : [])] as Role[]) {
    const best = ranked.filter((h) => roleOf(h.chunk.file) === role).slice(0, role === "impl" ? 2 : 1);
    firsts.push(...best);
  }
  const hits = [...firsts, ...ranked.filter((h) => !firsts.includes(h))];
  const docsCap = Math.floor(budget * 0.3);
  let docsUsed = 0;
  const perFile = new Map<string, number>();
  for (const h of hits) {
    const c = h.chunk;
    if (seen.has(`${c.file}:${c.start}`)) continue;
    if ((perFile.get(c.file) ?? 0) >= 3) continue;
    let text = c.text;
    let end = c.end;
    if (c.end - c.start > 90) {
      text = text.split("\n").slice(0, 90).join("\n");
      end = c.start + 89;
    }
    const body = numbered(text, c.start);
    const t = estimateTokens(body) + 20;
    if (used + t > budget) continue;
    const role = roleOf(c.file);
    if ((role === "docs" || role === "other") && docsUsed + t > docsCap) continue;
    if (role === "docs" || role === "other") docsUsed += t;
    perFile.set(c.file, (perFile.get(c.file) ?? 0) + 1);
    add(
      {
        file: c.file,
        start: c.start,
        end,
        title: c.title,
        tokens: t,
        score: Math.round(h.score * 10) / 10,
        reason: `${firsts.includes(h) ? `best ${roleOf(c.file)} match; ` : ""}matched: ${h.matched.slice(0, 6).join(", ")}`,
        source: "retrieval",
      },
      `### ${c.file}:${c.start}-${end} — ${c.title} (score ${h.score.toFixed(1)}; matched ${h.matched.slice(0, 6).join(", ")})\n${body}`,
    );
    if (used > budget * 0.97) break;
  }

  const header =
    `<context budget_tokens="${budget}" used_tokens="${used}" indexed_files="${index.files.length}" indexed_lines="${index.totalLines}">\n` +
    `The editor pre-selected these snippets for the request (BM25 over symbol-level chunks). ` +
    `They are a starting point, not the whole truth: read files before editing them.\n\n`;
  return { text: header + parts.join("\n\n") + "\n</context>", items, usedTokens: used, budgetTokens: budget, query: [...new Set(q)] };
}
