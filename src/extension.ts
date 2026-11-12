// Forge Agent: an editor-native coding agent whose loop runs on TrueForge.
//   VS Code  --(TrueForge SDK: sessions, streamed turns, approvals)-->  TrueForge (local)
//   TrueForge --(MCP over HTTP: read/search/propose/run)-->  this extension's MCP server
// The extension never calls a model provider; it only renders TrueForge's event stream,
// owns the editor capabilities, and turns TrueForge tool approvals into hunk-by-hunk review.
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type * as http from "http";
import { RepoIndex, assembleContext } from "./core/context";
import { EditorHost, Proposal, buildProposal, startMcpHttp, runProcess, WRITE_TOOLS, MCP_SERVER_NAME } from "./core/tools";
import { ForgeRunner, PendingToolCall, ApprovalDecision, camelize } from "./core/runner";
import { setupTrueForge, getOrCreateToken, listConfiguredModels } from "./core/setup";
import { ReviewManager, PROPOSAL_SCHEME, ORIGINAL_SCHEME, hunkPreview, ReviewSession, AppliedChange } from "./vscode/review";
import { AgentPanel, FromWebview } from "./vscode/panel";
import { INLINE_INSTRUCTIONS, pickRange, buildInlinePrompt, extractCode, buildInlineProposal } from "./vscode/inline";
import { hunkStats } from "./core/hunks";

interface Run {
  id: string;
  kind: "agent" | "inline";
  ac: AbortController;
  applied: number;
  sessionId?: string;
}

let out: vscode.OutputChannel;
const log = (s: string) => out?.appendLine(`[${new Date().toLocaleTimeString()}] ${s}`);

export interface ForgeApi {
  ready: Promise<boolean>;
  reviews: ReviewManager;
  runAgent(text: string): Promise<unknown>;
  inlineEdit(instruction: string): Promise<unknown>;
  cancel(): void;
  events: any[];
  isBusy(): boolean;
}

export async function activate(ctx: vscode.ExtensionContext): Promise<ForgeApi | undefined> {
  out = vscode.window.createOutputChannel("Forge Agent");
  const folder = vscode.workspace.workspaceFolders?.[0];
  const cfg = () => vscode.workspace.getConfiguration("forgeAgent");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "forgeAgent.openPanel";
  status.text = "$(sparkle) Forge";
  status.show();
  ctx.subscriptions.push(out, status);

  const panel = new AgentPanel(ctx.extensionUri);
  const events: any[] = [];
  const rawPost = panel.post.bind(panel);
  panel.post = (m) => {
    events.push(m);
    if (events.length > 5000) events.splice(0, 1000);
    rawPost(m);
  };
  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider(AgentPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } }));

  if (!folder) {
    status.text = "$(sparkle) Forge: open a folder";
    return undefined;
  }
  const root = folder.uri.fsPath;
  const index = new RepoIndex();
  const reviews = new ReviewManager(root, index, log);
  ctx.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, reviews),
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, reviews),
    vscode.languages.registerCodeLensProvider({ scheme: PROPOSAL_SCHEME }, reviews),
  );

  let runner = new ForgeRunner(cfg().get<string>("trueforgeUrl")!);
  let agentDef: any = null;
  let modelChain: string[] = [];
  let tfSession: string | undefined;
  let run: Run | null = null;
  const decisions = new Map<string, Set<number>>();
  const approvalWaiters = new Map<string, (allow: boolean) => void>();

  // ---------------- index ----------------
  const buildIndex = () => {
    const t = Date.now();
    index.build(root);
    log(`indexed ${index.files.length} files / ${index.chunks.length} chunks / ${index.totalLines} lines in ${Date.now() - t}ms`);
  };
  buildIndex();
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "**/*"));
  const reindex = (uri: vscode.Uri) => {
    const rel = path.relative(root, uri.fsPath).split(path.sep).join("/");
    if (rel.startsWith("..") || /(^|\/)(\.git|\.venv|node_modules|__pycache__)\//.test(rel)) return;
    if (!index.files.includes(rel) && !/\.(py|rst|md|txt|toml|cfg|ts|js|json|ya?ml)$/.test(rel)) return;
    fs.readFile(uri.fsPath, "utf8", (err, text) => index.updateFile(rel, err ? null : text));
  };
  watcher.onDidChange(reindex);
  watcher.onDidCreate(reindex);
  watcher.onDidDelete(reindex);
  ctx.subscriptions.push(watcher);

  // ---------------- editor host (what the MCP tools act on) ----------------
  const host: EditorHost = {
    root,
    index,
    async readText(rel) {
      const abs = path.join(root, rel);
      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.toLowerCase() === abs.toLowerCase());
      if (open) return open.getText();
      try {
        return fs.readFileSync(abs, "utf8");
      } catch {
        return null;
      }
    },
    async executeProposal(p: Proposal) {
      if (!run || run.ac.signal.aborted) return "NOT APPLIED: the run was cancelled by the user. The workspace is unchanged.";
      let accepted = decisions.get(p.key);
      decisions.delete(p.key);
      if (!accepted) {
        // No approval step happened (e.g. the agent was configured without approvals): review now.
        accepted = await reviews.review(p, "agent", run.ac.signal);
      }
      if (run.ac.signal.aborted) return "NOT APPLIED: the run was cancelled by the user.";
      if (!accepted.size) return `NOT APPLIED: the user rejected every hunk of this change to ${p.path}. Do not propose it again unless asked.`;
      try {
        await reviews.apply(p, accepted, `${p.tool} ${p.path}`, run.id);
        run.applied++;
      } catch (e: any) {
        return `NOT APPLIED: ${e.message}`;
      }
      const all = p.hunks.map((h) => h.index);
      const rejected = all.filter((i) => !accepted!.has(i));
      return (
        `Applied ${accepted.size} of ${p.hunks.length} hunk(s) to ${p.path}` +
        (rejected.length ? `. The user REJECTED hunk(s) ${rejected.map((i) => i + 1).join(", ")}: ${rejected.map((i) => hunkStats(p.hunks[i])).join("; ")} — leave those parts as they are.` : ".") +
        ` The file on disk now reflects only the accepted hunks.`
      );
    },
    async runCommand(command, timeoutSec) {
      panel.post({ t: "status", msg: `$ ${command}`, level: "info" });
      const r = await runProcess(command, root, timeoutSec, run?.ac.signal);
      panel.post({ t: "status", msg: `exit ${r.code}\n${r.output.slice(-1500)}`, level: r.code === 0 ? "info" : "warn" });
      return r;
    },
    log,
  };

  // ---------------- MCP server + TrueForge registration ----------------
  let mcpServer: http.Server | null = null;
  let mcpPort = 0;
  const token = getOrCreateToken();
  const startMcp = async () => {
    if (mcpServer) return;
    const base = cfg().get<number>("mcpPort") ?? 7465;
    for (let p = base; p < base + 10; p++) {
      try {
        mcpServer = await startMcpHttp(host, p, token);
        mcpPort = p;
        log(`MCP server ${MCP_SERVER_NAME} listening on http://127.0.0.1:${p}/mcp`);
        return;
      } catch (e: any) {
        if (e?.code !== "EADDRINUSE") throw e;
      }
    }
    throw new Error("no free port for the MCP server");
  };
  ctx.subscriptions.push({ dispose: () => mcpServer?.close() });

  const connect = async (interactive = false): Promise<boolean> => {
    runner = new ForgeRunner(cfg().get<string>("trueforgeUrl")!);
    status.text = "$(sync~spin) Forge: connecting…";
    try {
      await startMcp();
      const down = await runner.ping();
      if (down) throw new Error(down);
      const mcpUrl = `http://${cfg().get<string>("mcpPublicHost") ?? "localhost"}:${mcpPort}/mcp`;
      const r = await setupTrueForge({ trueforgeUrl: runner.baseUrl, extRoot: ctx.extensionPath, mcpUrl, token, preferredModels: cfg().get<string[]>("models") ?? [], log });
      agentDef = r.agentDef;
      modelChain = r.models;
      status.text = `$(sparkle) Forge: ${modelChain[0]}`;
      status.tooltip = `TrueForge ${runner.baseUrl}\nmodels (fallback order): ${modelChain.join(" → ")}\nMCP: ${mcpUrl}`;
      panel.post({ t: "state", busy: !!run, model: modelChain.join(" → ") });
      return true;
    } catch (e: any) {
      status.text = "$(warning) Forge: not connected";
      status.tooltip = String(e?.message ?? e);
      log(`connect failed: ${e?.message ?? e}`);
      panel.post({ t: "status", msg: String(e?.message ?? e), level: "error" });
      if (interactive) vscode.window.showErrorMessage(`Forge: ${e?.message ?? e}`, "Retry").then((p) => p && connect(true));
      return false;
    }
  };
  const ready = cfg().get<boolean>("autoSetup") !== false ? connect() : Promise.resolve(false);

  const currentModels = async () => {
    const pref = cfg().get<string[]>("models") ?? [];
    const available = await listConfiguredModels(runner.baseUrl);
    const chain = (pref.length ? pref : modelChain).filter((m) => !available.length || available.includes(m));
    return chain.length ? chain : modelChain;
  };

  const setBusy = (b: boolean) => {
    vscode.commands.executeCommand("setContext", "forgeAgent.busy", b);
    panel.post({ t: "state", busy: b, undoDepth: reviews.undoDepth });
    status.text = b ? "$(sync~spin) Forge: working… (Ctrl+Alt+X to stop)" : `$(sparkle) Forge: ${modelChain[0] ?? "not connected"}`;
  };

  // ---------------- review UI bridge ----------------
  reviews.ui = {
    showReview(r: ReviewSession) {
      panel.post({
        t: "review",
        id: r.id,
        path: r.proposal.path,
        isNew: r.proposal.isNew,
        origin: r.origin,
        summary: r.proposal.summary,
        notes: r.proposal.notes,
        hunks: r.proposal.hunks.map((h) => ({ index: h.index, stats: hunkStats(h), preview: hunkPreview(h) })),
      });
      if (r.origin === "agent") panel.reveal();
    },
    updateReview: (r) => panel.post({ t: "reviewUpdate", id: r.id, states: r.states }),
    endReview: (r, accepted) => panel.post({ t: "reviewEnd", id: r.id, states: r.states, accepted: accepted.length }),
    applied: (c: AppliedChange, depth) => panel.post({ t: "applied", file: c.file, label: c.label, undoDepth: depth }),
  };

  // ---------------- runs ----------------
  const commonCallbacks = (r: Run) => ({
    onStatus: (msg: string, level?: "info" | "warn" | "error") => {
      panel.post({ t: "status", msg, level: level ?? "info" });
      log(`[${level ?? "info"}] ${msg}`);
    },
    onSession: (s: { sessionId: string; model: string; attempt: number; viaAgentName: boolean }) => {
      r.sessionId = s.sessionId;
      tfSession = s.sessionId;
      panel.post({ t: "state", session: s.sessionId, model: s.model });
      panel.post({ t: "status", msg: `TrueForge session ${s.sessionId} · model ${s.model}${s.viaAgentName ? ` · agent ${agentDef?.name}` : " · inline spec"}`, level: "info" });
    },
    onDelta: (text: string, thread: string) => panel.post({ t: "delta", text, thread }),
    onMessage: (text: string, thread: string, _id: string, streamed: boolean) => panel.post({ t: "message", text, thread, streamed }),
    onToolCall: (c: PendingToolCall) => panel.post({ t: "tool", id: c.toolCallId, name: c.name, server: c.server, args: c.args, thread: c.threadId }),
    onToolResult: (x: { toolCallId: string; content: string }) => panel.post({ t: "toolResult", id: x.toolCallId, content: x.content }),
    onThread: (t: { threadId: string; title: string }) => panel.post({ t: "thread", id: t.threadId, title: t.title }),
    onCompaction: (phase: string) => panel.post({ t: "status", msg: `TrueForge context compaction ${phase}`, level: "info" }),
  });

  const approve = async (r: Run, pending: PendingToolCall[]): Promise<ApprovalDecision[]> => {
    const outD: ApprovalDecision[] = [];
    for (const p of pending) {
      if (r.ac.signal.aborted) {
        outD.push({ toolCallId: p.toolCallId, threadId: p.threadId, allow: false, reason: "run cancelled" });
        continue;
      }
      if (WRITE_TOOLS.includes(p.name)) {
        const prop = await buildProposal(host, p.name, p.args);
        if ("error" in prop) {
          panel.post({ t: "status", msg: `Auto-rejected ${p.name}: ${prop.error}`, level: "warn" });
          outD.push({ toolCallId: p.toolCallId, threadId: p.threadId, allow: false, reason: prop.error });
          continue;
        }
        const accepted = await reviews.review(prop, "agent", r.ac.signal);
        if (accepted.size) {
          decisions.set(prop.key, accepted);
          outD.push({ toolCallId: p.toolCallId, threadId: p.threadId, allow: true });
        } else outD.push({ toolCallId: p.toolCallId, threadId: p.threadId, allow: false, reason: `The user rejected every hunk of this change to ${prop.path}. Do not propose it again unless asked.` });
      } else {
        const allow = await new Promise<boolean>((resolve) => {
          approvalWaiters.set(p.toolCallId, resolve);
          r.ac.signal.addEventListener("abort", () => resolve(false));
          panel.post({ t: "approval", id: p.toolCallId, name: p.name, args: p.args });
          panel.reveal();
        });
        approvalWaiters.delete(p.toolCallId);
        outD.push({ toolCallId: p.toolCallId, threadId: p.threadId, allow, reason: allow ? undefined : "denied by the user" });
      }
    }
    return outD;
  };

  const finishRun = async (r: Run, res: { status: string; error?: string }) => {
    if (res.status === "cancelled") {
      const kept = r.applied;
      panel.post({
        t: "status",
        msg: `Cancelled. No edit was half-applied${kept ? `; ${kept} change(s) you accepted before cancelling are kept (↶ Undo reverts them)` : " and the workspace is unchanged"}.`,
        level: "warn",
      });
    }
    panel.post({ t: "done", status: res.status, error: res.error });
    run = null;
    setBusy(false);
  };

  const runAgent = async (text: string) => {
    if (run) return vscode.window.showWarningMessage("Forge is already working. Stop it first.");
    if (!agentDef && !(await connect(true))) return;
    const r: Run = { id: `run${Date.now()}`, kind: "agent", ac: new AbortController(), applied: 0 };
    run = r;
    setBusy(true);
    panel.post({ t: "user", text });
    try {
      const c = assembleContext(index, text, { budgetTokens: cfg().get<number>("contextBudgetTokens") ?? 8000 });
      panel.post({ t: "context", items: c.items, used: c.usedTokens, budget: c.budgetTokens, query: c.query, indexedFiles: index.files.length, indexedLines: index.totalLines });
      const ed = vscode.window.activeTextEditor;
      const openHint = ed && ed.document.uri.fsPath.startsWith(root) ? `\n(The user has ${path.relative(root, ed.document.uri.fsPath).split(path.sep).join("/")} open.)` : "";
      const res = await runner.run(
        {
          input: `${text}${openHint}\n\n${c.text}`,
          agentName: agentDef.name,
          baseSpec: camelize(agentDef.manifest),
          models: await currentModels(),
          retries: cfg().get<number>("retries") ?? 2,
          firstTokenTimeoutMs: (cfg().get<number>("firstTokenTimeoutSec") ?? 45) * 1000,
          signal: r.ac.signal,
          hasSideEffects: () => r.applied > 0,
        },
        { ...commonCallbacks(r), onApproval: (p) => approve(r, p) },
      );
      await finishRun(r, res);
    } catch (e: any) {
      panel.post({ t: "status", msg: `Unexpected error: ${e?.message ?? e}`, level: "error" });
      log(e?.stack ?? String(e));
      await finishRun(r, { status: "error" });
    }
  };

  const inlineEdit = async (instructionArg?: unknown) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") return vscode.window.showInformationMessage("Forge: open a file and select code first.");
    if (run) return vscode.window.showWarningMessage("Forge is already working. Stop it first.");
    const doc = editor.document;
    const rel = path.relative(root, doc.uri.fsPath).split(path.sep).join("/");
    const { start, end } = pickRange(editor, index, rel);
    editor.selection = new vscode.Selection(start, 0, end, doc.lineAt(end).text.length);
    const instruction = typeof instructionArg === "string" ? instructionArg : await vscode.window.showInputBox({
      title: `Forge inline edit · ${rel}:${start + 1}-${end + 1}`,
      prompt: "Describe the change to the selected code",
      placeHolder: "e.g. handle None, add a docstring, make it case-insensitive…",
      ignoreFocusOut: true,
    });
    if (!instruction) return;
    if (!agentDef && !(await connect(true))) return;
    const original = doc.getText();
    const req = { rel, languageId: doc.languageId, original, startLine: start, endLine: end, instruction };
    const { prompt, related } = buildInlinePrompt(req, index, 1500);
    const r: Run = { id: `inline${Date.now()}`, kind: "inline", ac: new AbortController(), applied: 0 };
    run = r;
    setBusy(true);
    panel.post({ t: "user", text: `✎ Inline edit ${rel}:${start + 1}-${end + 1}\n${instruction}` });
    panel.post({
      t: "context",
      items: [{ file: rel, start: start + 1, end: end + 1, title: "selection", tokens: Math.ceil(prompt.length / 4), score: 99, reason: "selection ±60 lines", source: "mention" }].concat(
        related.map((x) => ({ file: x.split(":")[0], start: Number(x.split(":")[1]), end: Number(x.split(":")[1]), title: "definition", tokens: 0, score: 0, reason: "symbol used in selection", source: "retrieval" })),
      ),
      used: Math.ceil(prompt.length / 4),
      budget: Math.ceil(prompt.length / 4) + 1500,
      query: [],
      indexedFiles: index.files.length,
      indexedLines: index.totalLines,
    });
    let reply = "";
    const deco = vscode.window.createTextEditorDecorationType({ after: { margin: "0 0 0 1em", color: new vscode.ThemeColor("editorCodeLens.foreground") }, isWholeLine: true });
    try {
      const res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Forge", cancellable: true },
        async (progress, token) => {
          token.onCancellationRequested(() => r.ac.abort());
          progress.report({ message: "asking TrueForge…" });
          const models = await currentModels();
          return runner.run(
            {
              input: prompt,
              baseSpec: { model: { name: models[0], params: { temperature: 0, maxTokens: 4096 } }, instructions: INLINE_INSTRUCTIONS, config: { dynamicSubAgents: { enabled: false }, askUserQuestions: { enabled: false } } },
              models,
              retries: cfg().get<number>("retries") ?? 2,
              firstTokenTimeoutMs: (cfg().get<number>("firstTokenTimeoutSec") ?? 45) * 1000,
              signal: r.ac.signal,
              hasSideEffects: () => false,
            },
            {
              ...commonCallbacks(r),
              onSession: (s) => {
                commonCallbacks(r).onSession(s);
                progress.report({ message: `${s.model} · streaming…` });
              },
              onDelta: (text, thread) => {
                reply += text;
                panel.post({ t: "delta", text, thread });
                const last = reply.trimEnd().split("\n").pop() ?? "";
                progress.report({ message: `${reply.length} chars · ${last.slice(0, 60)}` });
                editor.setDecorations(deco, [{ range: new vscode.Range(end, 0, end, 0), renderOptions: { after: { contentText: `  ⟳ Forge writing… ${reply.length} chars` } } }]);
              },
              onMessage: (text, thread, id, streamed) => {
                if (!streamed && text) reply = text;
                commonCallbacks(r).onMessage(text, thread, id, streamed);
              },
              onApproval: async (p) => p.map((x) => ({ toolCallId: x.toolCallId, threadId: x.threadId, allow: false, reason: "inline edits have no tools" })),
            },
          );
        },
      );
      deco.dispose();
      if (res.status !== "done") {
        if (res.status === "error") vscode.window.showErrorMessage(`Forge inline edit failed: ${res.error}`);
        await finishRun(r, res);
        return;
      }
      const code = extractCode(reply, original.split(/\r?\n/).slice(start, end + 1).join("\n"));
      if (code === null) {
        panel.post({ t: "status", msg: "The model returned no code; nothing changed.", level: "warn" });
        await finishRun(r, { status: "done" });
        return;
      }
      const prop = buildInlineProposal(req, code);
      if (!prop.hunks.length) {
        vscode.window.showInformationMessage("Forge: the model proposed no change.");
        await finishRun(r, { status: "done" });
        return;
      }
      // the document may have been edited while the model was writing
      if (doc.getText() !== original) {
        vscode.window.showWarningMessage("Forge: the file changed while generating; proposal discarded.");
        await finishRun(r, { status: "done" });
        return;
      }
      setBusy(false);
      const accepted = await reviews.review(prop, "inline", r.ac.signal);
      if (accepted.size) {
        await reviews.apply(prop, accepted, "inline edit", r.id);
        r.applied++;
        vscode.window.showInformationMessage(`Forge: applied ${accepted.size}/${prop.hunks.length} hunk(s). Undo with Ctrl+Z or “Forge: Undo Last Change”.`);
      } else vscode.window.showInformationMessage("Forge: all hunks rejected; file unchanged.");
      await finishRun(r, { status: "done" });
    } catch (e: any) {
      deco.dispose();
      vscode.window.showErrorMessage(`Forge inline edit failed: ${e?.message ?? e}`);
      await finishRun(r, { status: "error" });
    }
  };

  const cancel = () => {
    if (!run) return;
    log(`cancel ${run.id}`);
    run.ac.abort();
    for (const rv of reviews.activeReviews) reviews.finish(rv.id, true);
  };

  // ---------------- panel messages ----------------
  panel.onMessage = async (m: FromWebview) => {
    switch (m.t) {
      case "ready":
        panel.flush();
        panel.post({ t: "state", busy: !!run, model: modelChain.join(" → "), undoDepth: reviews.undoDepth, session: tfSession ?? null });
        break;
      case "send":
        runAgent(m.text);
        break;
      case "cancel":
        cancel();
        break;
      case "hunk":
        reviews.decide(m.id, m.idx, m.accept);
        break;
      case "reviewAll":
        reviews.decideAll(m.id, m.accept);
        break;
      case "showDiff": {
        const rv = reviews.getReview(m.id);
        if (rv && !rv.done) {
          const q = `id=${rv.id}`;
          vscode.commands.executeCommand("vscode.diff", vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: `/${rv.proposal.path}`, query: q }), vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: `/${rv.proposal.path}`, query: q }), `${path.basename(rv.proposal.path)}: Forge proposal`);
        }
        break;
      }
      case "approve":
        approvalWaiters.get(m.id)?.(!!m.allow);
        break;
      case "undo":
        vscode.commands.executeCommand("forgeAgent.undoLast");
        break;
      case "openSession":
        vscode.commands.executeCommand("forgeAgent.openSession");
        break;
      case "newChat":
        if (run) cancel();
        tfSession = undefined;
        panel.post({ t: "clear" });
        panel.post({ t: "state", session: null });
        break;
      case "suggest": {
        const p = String(m.prefix ?? "").toLowerCase().replace(/^(file|symbol):/, "");
        const files = index.files.filter((f) => f.toLowerCase().includes(p)).slice(0, 8).map((f) => ({ label: f, kind: "file", insert: `@${f}` }));
        const syms = p.length >= 2 ? index.symbols.filter((s) => s.kind !== "heading" && s.name.toLowerCase().startsWith(p)).slice(0, 8).map((s) => ({ label: `${s.parent ? s.parent + "." : ""}${s.name}`, kind: `${s.kind} · ${s.file}`, insert: `@symbol:${s.parent ? s.parent + "." : ""}${s.name}` })) : [];
        panel.post({ t: "suggest", items: [...files, ...syms].slice(0, 12) });
        break;
      }
    }
  };

  // ---------------- commands ----------------
  ctx.subscriptions.push(
    vscode.commands.registerCommand("forgeAgent.inlineEdit", inlineEdit),
    vscode.commands.registerCommand("forgeAgent.openPanel", () => panel.reveal()),
    vscode.commands.registerCommand("forgeAgent.cancel", cancel),
    vscode.commands.registerCommand("forgeAgent.connect", () => connect(true)),
    vscode.commands.registerCommand("forgeAgent.reindex", () => {
      buildIndex();
      vscode.window.showInformationMessage(`Forge: indexed ${index.files.length} files (${index.totalLines} lines).`);
    }),
    vscode.commands.registerCommand("forgeAgent.hunk", (id: string, idx: number, accept: boolean | null) => reviews.decide(id, idx, accept)),
    vscode.commands.registerCommand("forgeAgent.acceptAll", () => reviews.decideAll(undefined, true)),
    vscode.commands.registerCommand("forgeAgent.rejectAll", () => reviews.decideAll(undefined, false)),
    vscode.commands.registerCommand("forgeAgent.undoLast", async () => {
      try {
        const c = await reviews.undoLast();
        if (!c) return vscode.window.showInformationMessage("Forge: nothing to undo.");
        panel.post({ t: "status", msg: `↶ reverted ${c.label} (${c.file})`, level: "info" });
        panel.post({ t: "state", undoDepth: reviews.undoDepth });
        vscode.window.showInformationMessage(`Forge: reverted ${c.file}.`);
      } catch (e: any) {
        if (e?.message !== "undo cancelled") vscode.window.showErrorMessage(`Forge undo failed: ${e?.message ?? e}`);
      }
    }),
    vscode.commands.registerCommand("forgeAgent.openSession", () => {
      if (!tfSession) return vscode.window.showInformationMessage("Forge: no TrueForge session yet.");
      vscode.env.openExternal(vscode.Uri.parse(`${runner.baseUrl.replace(/\/$/, "")}/sessions/${tfSession}`));
    }),
    vscode.commands.registerCommand("forgeAgent.ask", async () => {
      const text = await vscode.window.showInputBox({ prompt: "Forge agent: describe the change", ignoreFocusOut: true });
      if (text) {
        await panel.reveal();
        runAgent(text);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("forgeAgent")) connect();
    }),
  );
  return { ready, reviews, runAgent: (t) => runAgent(t), inlineEdit: (i) => inlineEdit(i), cancel, events, isBusy: () => !!run };
}

export function deactivate() {}
