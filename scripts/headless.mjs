// Headless harness: runs the same runner + MCP server + context engine the extension uses,
// against a workspace folder, auto-accepting every hunk. For CI-style checks of the plumbing.
//   node scripts/headless.mjs <workspace> "<request>" [--models a,b]
//   node scripts/headless.mjs <workspace> "<instruction>" --inline --file <rel> --symbol <name> --models a,b [--apply]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "out", "core");
const { RepoIndex, assembleContext } = require(path.join(out, "context.js"));
const { startMcpHttp, runProcess, APPROVAL_TOOLS, buildProposal } = require(path.join(out, "tools.js"));
const { ForgeRunner } = require(path.join(out, "runner.js"));
const { setupTrueForge, getOrCreateToken } = require(path.join(out, "setup.js"));
const { applyHunks } = require(path.join(out, "hunks.js"));

const args = process.argv.slice(2);
const root = path.resolve(args[0]);
const request = args[1];
const mi = args.indexOf("--models");
const models = mi >= 0 ? args[mi + 1].split(",") : [];
const extRoot = path.resolve(out, "..", "..");
const TF = process.env.TRUEFORGE_URL ?? "http://localhost:8790";
const PORT = Number(process.env.FORGE_MCP_PORT ?? 7465);

const t0 = Date.now();
const index = new RepoIndex().build(root);
console.log(`[index] ${index.files.length} files, ${index.chunks.length} chunks, ${index.symbols.length} symbols, ${index.totalLines} lines in ${Date.now() - t0}ms`);

const decisions = new Map();
let appliedEdits = 0;
const host = {
  root,
  index,
  async readText(rel) {
    try {
      return fs.readFileSync(path.join(root, rel), "utf8");
    } catch {
      return null;
    }
  },
  async executeProposal(p) {
    const d = decisions.get(p.key);
    const accepted = d ?? new Set(p.hunks.map((h) => h.index));
    const next = applyHunks(p.original, p.hunks, accepted);
    fs.mkdirSync(path.dirname(path.join(root, p.path)), { recursive: true });
    fs.writeFileSync(path.join(root, p.path), next);
    index.updateFile(p.path, next);
    if (accepted.size) appliedEdits++;
    console.log(`[apply] ${p.path}: ${accepted.size}/${p.hunks.length} hunks`);
    return `Applied ${accepted.size} of ${p.hunks.length} hunks to ${p.path}.`;
  },
  runCommand: (c, t) => runProcess(c, root, t),
  log: (m) => console.log("[mcp]", m),
};

if (args.includes("--inline")) await inlineMode();

/** Inline edit exactly as the extension does it (same prompt, same runner, same proposal), without VS Code.
 *  --file <rel> --symbol <name> picks the range; hunks are printed, and written only with --apply. */
async function inlineMode() {
  const { INLINE_INSTRUCTIONS, buildInlinePrompt, extractCode, buildInlineProposal } = require(path.join(out, "..", "vscode", "inline.js"));
  const opt = (n) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined);
  const rel = opt("--file");
  const sym = index.findSymbol(opt("--symbol")).find((s) => s.file === rel);
  if (!sym) throw new Error(`symbol ${opt("--symbol")} not found in ${rel}`);
  const original = fs.readFileSync(path.join(root, rel), "utf8");
  const req = { rel, languageId: "python", original, startLine: sym.line - 1, endLine: sym.endLine - 1, instruction: request };
  const { prompt } = buildInlinePrompt(req, index, 1500);
  console.log(`[inline] ${rel}:${sym.line}-${sym.endLine} (${sym.name}), prompt ~${Math.ceil(prompt.length / 4)} tokens`);
  const runner = await new ForgeRunner(TF).init();
  let reply = "";
  const res = await runner.run(
    {
      input: prompt,
      baseSpec: { model: { name: models[0], params: { temperature: 0, maxTokens: 4096 } }, instructions: INLINE_INSTRUCTIONS, config: { dynamicSubAgents: { enabled: false }, askUserQuestions: { enabled: false } } },
      models,
      retries: 1,
      firstTokenTimeoutMs: 45000,
      signal: new AbortController().signal,
      hasSideEffects: () => false,
    },
    {
      onStatus: (m, l) => console.log(`[status:${l ?? "info"}] ${m}`),
      onSession: (s) => console.log(`[session] ${s.sessionId} model=${s.model}`),
      onDelta: (t) => (reply += t),
      onMessage: (t, th, id, streamed) => {
        if (!streamed && t) reply = t;
      },
      onApproval: async (p) => p.map((x) => ({ toolCallId: x.toolCallId, threadId: x.threadId, allow: false, reason: "inline edits have no tools" })),
    },
  );
  console.log(`[result] ${res.status} model=${res.model ?? "-"}${res.error ? " error=" + res.error : ""}`);
  if (res.status !== "done") process.exit(1);
  const code = extractCode(reply, original.split(/\r?\n/).slice(req.startLine, req.endLine + 1).join("\n"));
  if (code === null) {
    console.log("[inline] model returned no code");
    process.exit(1);
  }
  const prop = buildInlineProposal(req, code);
  for (const h of prop.hunks) console.log(`[hunk ${h.index}] @${h.origStart + 1}\n${h.removed.map((l) => "- " + l).join("\n")}\n${h.added.map((l) => "+ " + l).join("\n")}`);
  if (args.includes("--apply")) {
    fs.writeFileSync(path.join(root, rel), applyHunks(original, prop.hunks, new Set(prop.hunks.map((h) => h.index))));
    console.log(`[apply] ${rel}: ${prop.hunks.length} hunks`);
  } else console.log("[inline] review only: nothing written (pass --apply to accept all)");
  process.exit(0);
}

const token = getOrCreateToken();
const srv = await startMcpHttp(host, PORT, token);
const mcpUrl = `http://localhost:${PORT}/mcp`;
const { agentDef, models: cfgModels } = await setupTrueForge({ trueforgeUrl: TF, extRoot, mcpUrl, token, preferredModels: models, log: (s) => console.log("[setup]", s) });

const ctx = assembleContext(index, request, { budgetTokens: 8000 });
console.log(`[context] ${ctx.usedTokens}/${ctx.budgetTokens} tokens, query terms: ${ctx.query.join(" ")}`);
for (const it of ctx.items) console.log(`   ${it.source.padEnd(9)} ${it.file}:${it.start}-${it.end}  ${it.title}  (${it.reason}, ${it.tokens} tok)`);

const runner = await new ForgeRunner(TF).init();
const ac = new AbortController();
process.on("SIGINT", () => ac.abort());
const res = await runner.run(
  {
    input: `${request}\n\n${ctx.text}`,
    agentName: agentDef.name,
    baseSpec: agentDef.manifest,
    models: models.length ? models : cfgModels,
    retries: 1,
    firstTokenTimeoutMs: 60000,
    signal: ac.signal,
    hasSideEffects: () => appliedEdits > 0,
  },
  {
    onStatus: (m, l) => console.log(`[status:${l ?? "info"}] ${m}`),
    onSession: (s) => console.log(`[session] ${s.sessionId} model=${s.model} named=${s.viaAgentName}  ${TF}/sessions/${s.sessionId}`),
    onDelta: (t) => process.stdout.write(t),
    onMessage: (t, th, id, streamed) => {
      if (!streamed && t) console.log(`\n[message ${th}] ${t}`);
    },
    onToolCall: (c) => console.log(`\n[tool] ${c.server ?? ""}.${c.name} ${JSON.stringify(c.args).slice(0, 160)}`),
    onToolResult: (r) => console.log(`[tool result] ${r.content.slice(0, 160).replace(/\n/g, " âŽ ")}`),
    onThread: (t) => console.log(`[thread] ${t.threadId} ${t.title}`),
    onCompaction: (p) => console.log(`[compaction] ${p}`),
    async onApproval(pending) {
      const out = [];
      for (const p of pending) {
        if (APPROVAL_TOOLS.includes(p.name) && p.name !== "run_command") {
          const prop = await buildProposal(host, p.name, p.args);
          if ("error" in prop) {
            console.log(`[review] auto-deny ${p.name}: ${prop.error}`);
            out.push({ toolCallId: p.toolCallId, threadId: p.threadId, allow: false, reason: prop.error });
            continue;
          }
          decisions.set(prop.key, new Set(prop.hunks.map((h) => h.index)));
          console.log(`[review] ${prop.path}: ${prop.hunks.length} hunks -> accept all`);
        } else console.log(`[review] approve ${p.name} ${JSON.stringify(p.args).slice(0, 120)}`);
        out.push({ toolCallId: p.toolCallId, threadId: p.threadId, allow: true });
      }
      return out;
    },
  },
);
console.log(`\n[result] ${res.status} model=${res.model ?? "-"} attempts=${JSON.stringify(res.attempts)}${res.error ? " error=" + res.error : ""}`);
srv.close();
process.exit(res.status === "done" ? 0 : 1);
