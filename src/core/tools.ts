// The editor's capabilities, exposed to the TrueForge agent as an MCP server (streamable HTTP).
// The agent — not the extension — decides what to read, search, change and run.
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { RepoIndex, estimateTokens } from "./context";
import { applyTextEdits, TextEdit } from "./edits";
import { computeHunks, Hunk } from "./hunks";

export const MCP_SERVER_NAME = "vscode-editor";
export const WRITE_TOOLS = ["propose_edit", "create_file"];
export const APPROVAL_TOOLS = ["propose_edit", "create_file", "run_command"];

export interface Proposal {
  key: string;
  tool: "propose_edit" | "create_file";
  path: string; // workspace-relative
  isNew: boolean;
  original: string;
  proposed: string;
  hunks: Hunk[];
  summary: string;
  notes: string[];
}

export interface EditorHost {
  readonly root: string;
  readonly index: RepoIndex;
  /** Current text of a workspace file (unsaved editor buffer wins), or null if missing. */
  readText(rel: string): Promise<string | null>;
  /**
   * Called when the agent executes an approved write tool. The host applies only the hunks
   * the user accepted during review (or reviews now if no decision exists) and returns a
   * report for the agent.
   */
  executeProposal(p: Proposal): Promise<string>;
  runCommand(command: string, timeoutSec: number): Promise<{ code: number | null; output: string }>;
  log(msg: string): void;
}

export function safeRel(root: string, p: string): string {
  const cleaned = String(p ?? "").replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
  const abs = path.resolve(root, cleaned);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path escapes the workspace: ${p}`);
  return rel.split(path.sep).join("/");
}

/** Shared by the approval step (to render the review) and the tool execution (to apply). */
export async function buildProposal(
  host: Pick<EditorHost, "root" | "readText">,
  tool: string,
  args: any,
): Promise<Proposal | { error: string }> {
  try {
    const rel = safeRel(host.root, args?.path);
    const current = await host.readText(rel);
    if (tool === "create_file") {
      const content = String(args?.content ?? "");
      const original = current ?? "";
      return {
        key: `${rel}\n${content}`,
        tool: "create_file",
        path: rel,
        isNew: current === null,
        original,
        proposed: content,
        hunks: computeHunks(original, content),
        summary: String(args?.summary ?? ""),
        notes: current === null ? [] : ["file already existed; create_file replaces its content"],
      };
    }
    if (tool === "propose_edit") {
      if (current === null) return { error: `File not found: ${rel}. Use create_file for new files.` };
      let edits: TextEdit[] = Array.isArray(args?.edits) ? args.edits : [];
      if (!edits.length && typeof args?.old_text === "string") edits = [{ old_text: args.old_text, new_text: args.new_text ?? "" }];
      if (!edits.length) return { error: "propose_edit needs `edits`: [{old_text, new_text}]" };
      const r = applyTextEdits(current, edits);
      if (!r.ok) return { error: `${rel}: ${r.error}` };
      if (r.content === current) return { error: `${rel}: the edits produce no change.` };
      return {
        key: `${rel}\n${r.content}`,
        tool: "propose_edit",
        path: rel,
        isNew: false,
        original: current,
        proposed: r.content,
        hunks: computeHunks(current, r.content),
        summary: String(args?.summary ?? ""),
        notes: r.notes,
      };
    }
    return { error: `not a write tool: ${tool}` };
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

function numbered(lines: string[], start: number) {
  return lines.map((l, i) => `${String(start + i).padStart(5)}| ${l}`).join("\n");
}

export function createMcpServer(host: EditorHost): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: "0.1.0" });
  const RO = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    "repo_map",
    {
      title: "Repository map",
      description:
        "Compact map of the workspace: one line per source file with its top-level classes/functions (and CLI commands). Use first to orient in a large repo. Optional path_prefix narrows it (e.g. 'src/flask/').",
      inputSchema: { path_prefix: z.string().optional(), max_tokens: z.number().int().optional() },
      annotations: RO,
    },
    async ({ path_prefix, max_tokens }) => text(host.index.repoMap(Math.min(max_tokens ?? 2500, 6000), path_prefix ?? "")),
  );

  server.registerTool(
    "search_code",
    {
      title: "Search code",
      description:
        "Search the workspace. mode 'ranked' (default) = BM25 over symbol-level chunks for a natural-language or identifier query; mode 'regex' = literal/regex grep returning matching lines. Returns path:line ranges you can read_file.",
      inputSchema: {
        query: z.string(),
        mode: z.enum(["ranked", "regex"]).optional(),
        path_prefix: z.string().optional(),
        max_results: z.number().int().optional(),
      },
      annotations: RO,
    },
    async ({ query, mode, path_prefix, max_results }) => {
      const k = Math.min(max_results ?? 10, 30);
      if (mode === "regex") {
        let re: RegExp;
        try {
          re = new RegExp(query);
        } catch {
          re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        }
        const out: string[] = [];
        for (const f of host.index.files) {
          if (path_prefix && !f.startsWith(path_prefix)) continue;
          const t = await host.readText(f);
          if (t === null) continue;
          const lines = t.split(/\r?\n/);
          for (let i = 0; i < lines.length && out.length < k * 5; i++)
            if (re.test(lines[i])) out.push(`${f}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
        }
        return text(out.length ? out.join("\n") : "no matches");
      }
      const hits = host.index.search(query, k, path_prefix ? (c) => c.file.startsWith(path_prefix) : undefined);
      if (!hits.length) return text("no matches");
      return text(
        hits
          .map((h) => {
            const preview = h.chunk.text.split("\n").slice(0, 4).join("\n");
            return `${h.chunk.file}:${h.chunk.start}-${h.chunk.end}  ${h.chunk.title}  (score ${h.score.toFixed(1)}; matched ${h.matched.join(", ")})\n${preview}`;
          })
          .join("\n---\n"),
      );
    },
  );

  server.registerTool(
    "find_symbol",
    {
      title: "Find symbol",
      description: "Find where a class, function, method (Class.method), CLI command or doc heading is defined. Returns file, line range and signature.",
      inputSchema: { name: z.string() },
      annotations: RO,
    },
    async ({ name }) => {
      const defs = host.index.findSymbol(name);
      if (!defs.length) return text(`No symbol named '${name}' exists in the workspace index. Do not edit it; search instead.`);
      return text(defs.map((d) => `${d.file}:${d.line}-${d.endLine}  ${d.kind}  ${d.parent ? d.parent + "." : ""}${d.signature}`).join("\n"));
    },
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        "Read a workspace file with line numbers ('  12| code'). Use start_line/end_line for big files (max 400 lines per call). When you later copy text into propose_edit.old_text, drop the line-number prefix.",
      inputSchema: { path: z.string(), start_line: z.number().int().optional(), end_line: z.number().int().optional() },
      annotations: RO,
    },
    async ({ path: p, start_line, end_line }) => {
      const rel = safeRel(host.root, p);
      const t = await host.readText(rel);
      if (t === null) return text(`File not found: ${rel}`);
      const lines = t.split(/\r?\n/);
      const s = Math.max(1, start_line ?? 1);
      const e = Math.min(lines.length, end_line ?? Math.min(lines.length, s + 399), s + 399);
      const more = e < lines.length ? `\n… (${lines.length - e} more lines; call again with start_line=${e + 1})` : "";
      return text(`${rel} (lines ${s}-${e} of ${lines.length})\n${numbered(lines.slice(s - 1, e), s)}${more}`);
    },
  );

  server.registerTool(
    "list_dir",
    {
      title: "List directory",
      description: "List files and folders in a workspace directory.",
      inputSchema: { path: z.string().optional() },
      annotations: RO,
    },
    async ({ path: p }) => {
      const rel = safeRel(host.root, p ?? ".");
      try {
        const ents = fs.readdirSync(path.join(host.root, rel), { withFileTypes: true }).filter((e) => !e.name.startsWith(".") || e.name === ".github");
        return text(ents.map((e) => (e.isDirectory() ? e.name + "/" : e.name)).join("\n") || "(empty)");
      } catch (e: any) {
        return text(`Cannot list ${rel}: ${e.message}`);
      }
    },
  );

  server.registerTool(
    "propose_edit",
    {
      title: "Propose edit",
      description:
        "Propose changes to an existing file as exact search/replace pairs. Each old_text must be copied verbatim from the current file (no line-number prefixes) and be unique; include 2-3 surrounding lines. The user reviews every hunk in the editor and may accept some and reject others; the result tells you exactly which hunks were applied. Nothing is written until the user accepts.",
      inputSchema: {
        path: z.string(),
        edits: z.array(z.object({ old_text: z.string(), new_text: z.string() })),
        summary: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const p = await buildProposal(host, "propose_edit", args);
      if ("error" in p) return { ...text(`NOT APPLIED: ${p.error}`), isError: true };
      return text(await host.executeProposal(p));
    },
  );

  server.registerTool(
    "create_file",
    {
      title: "Create file",
      description: "Create a new file (or fully replace a small one) with the given content. Reviewed by the user like propose_edit.",
      inputSchema: { path: z.string(), content: z.string(), summary: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const p = await buildProposal(host, "create_file", args);
      if ("error" in p) return { ...text(`NOT APPLIED: ${p.error}`), isError: true };
      return text(await host.executeProposal(p));
    },
  );

  server.registerTool(
    "run_command",
    {
      title: "Run terminal command",
      description:
        "Run a shell command in the workspace root (e.g. 'python -m pytest tests/test_cli.py -q'). The project's .venv is on PATH if present. Needs user approval. Output is truncated to the last 6000 characters.",
      inputSchema: { command: z.string(), timeout_sec: z.number().int().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ command, timeout_sec }) => {
      const r = await host.runCommand(command, Math.min(timeout_sec ?? 120, 600));
      return text(`exit code: ${r.code}\n${r.output}`);
    },
  );

  server.registerTool(
    "git_diff",
    {
      title: "Git diff",
      description: "Show `git diff` of the workspace (what has been applied so far).",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      const r = await runProcess("git --no-pager diff --stat && git --no-pager diff", host.root, 30);
      return text(r.output || "(no changes)");
    },
  );

  return server;
}

export function runProcess(command: string, cwd: string, timeoutSec: number, signal?: AbortSignal): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const venv of [".venv", "venv"]) {
      const bin = path.join(cwd, venv, process.platform === "win32" ? "Scripts" : "bin");
      if (fs.existsSync(bin)) {
        const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
        env[key] = bin + path.delimiter + (env[key] ?? "");
        env.VIRTUAL_ENV = path.join(cwd, venv);
        break;
      }
    }
    env.PYTHONIOENCODING = "utf-8";
    const child = spawn(command, { cwd, env, shell: true, windowsHide: true });
    let out = "";
    const onData = (d: Buffer) => {
      out += d.toString();
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const kill = () => {
      try {
        if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
        else child.kill("SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => {
      out += `\n[timed out after ${timeoutSec}s]`;
      kill();
    }, timeoutSec * 1000);
    signal?.addEventListener("abort", () => {
      out += "\n[cancelled]";
      kill();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: out.length > 6000 ? "…" + out.slice(-6000) : out });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, output: String(e) });
    });
  });
}

/** Starts the MCP HTTP endpoint at http://<host>:<port>/mcp, guarded by a bearer token. */
export function startMcpHttp(host: EditorHost, port: number, token: string, bind = "127.0.0.1"): Promise<http.Server> {
  const srv = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, root: host.root }));
        return;
      }
      if (url.pathname !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      if ((req.headers["authorization"] ?? "") !== `Bearer ${token}`) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" }).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      const server = createMcpServer(host);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      const method = Array.isArray(body) ? body.map((b: any) => b.method).join(",") : body?.method;
      if (method === "tools/call") host.log(`MCP tools/call ${body?.params?.name}`);
      await transport.handleRequest(req as any, res, body);
    } catch (e: any) {
      host.log(`MCP error: ${e?.stack ?? e}`);
      if (!res.headersSent) res.writeHead(500).end(String(e?.message ?? e));
    }
  });
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, bind, () => resolve(srv));
  });
}

export { estimateTokens };
