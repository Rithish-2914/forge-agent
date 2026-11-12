// End-to-end test that runs INSIDE a real VS Code extension host (--extensionTestsPath).
// Uses the dev-only mock providers (scripts/mock-model.mjs) registered in TrueForge as
// "mock" (works) and "mockfail" (always 401). Run on a throwaway clone of the repo.
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const cp = require("child_process");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${what}`);
}
const results = [];
function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function setModels(models) {
  await vscode.workspace.getConfiguration("forgeAgent").update("models", models, vscode.ConfigurationTarget.Global);
  await sleep(2500); // extension re-registers with TrueForge on config change
}

exports.run = async function () {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const git = (a) => cp.execSync(`git ${a}`, { cwd: root }).toString().trim();
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "forge-agent");
  const api = await ext.activate();
  const connected = await api.ready;
  check("connects to TrueForge + registers MCP/agent", connected);
  try {
    // ---------- A: inline edit, per-hunk review, undo ----------
    await setModels(["mock/mock-coder"]);
    const helpers = path.join(root, "src", "flask", "helpers.py");
    const before = fs.readFileSync(helpers, "utf8");
    const doc = await vscode.workspace.openTextDocument(helpers);
    const ed = await vscode.window.showTextDocument(doc);
    const line = doc.getText().split(/\r?\n/).findIndex((l) => l.startsWith("def get_debug_flag"));
    ed.selection = new vscode.Selection(line, 0, line + 5, 0);
    const p = api.inlineEdit("Treat 'off' and 'n' as false too");
    const rv = await until(() => api.reviews.activeReviews[0], 60000, "inline review");
    check("inline: proposal rendered as review (no write yet)", fs.readFileSync(helpers, "utf8") === before, `${rv.proposal.hunks.length} hunk(s)`);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.input && t.input.modified && t.input.modified.scheme);
    check("inline: diff editor opened with proposal", tabs.includes("forge-proposal"));
    api.reviews.decide(rv.id, 0, true);
    for (let i = 1; i < rv.proposal.hunks.length; i++) api.reviews.decide(rv.id, i, false);
    await p;
    const after = fs.readFileSync(helpers, "utf8");
    check("inline: accepted hunk written to disk", after !== before && after.includes("edited by mock model"));
    check("inline: streamed deltas reached the panel", api.events.some((e) => e.t === "delta"));
    await vscode.commands.executeCommand("forgeAgent.undoLast");
    await sleep(500);
    check("inline: undo restores the file", fs.readFileSync(helpers, "utf8") === before);
    check("inline: git status clean after undo", git("status --porcelain") === "", git("status --porcelain"));

    // ---------- B: agent mode through TrueForge tools + approval-driven review ----------
    const readme = path.join(root, "README.md");
    const r0 = fs.readFileSync(readme, "utf8");
    const runP = api.runAgent("Update the readme");
    const rv2 = await until(() => api.reviews.activeReviews[0], 90000, "agent review");
    check("agent: tool calls via MCP before the edit", api.events.some((e) => e.t === "tool" && e.name === "read_file"));
    check("agent: context card shown", api.events.some((e) => e.t === "context" && e.items.length > 1));
    check("agent: nothing written during review", fs.readFileSync(readme, "utf8") === r0);
    api.reviews.decideAll(rv2.id, true);
    await runP;
    check("agent: approved edit applied via MCP", fs.readFileSync(readme, "utf8").includes("Edited by the mock model"));
    check("agent: session id surfaced", api.events.some((e) => e.t === "state" && e.session));
    await vscode.commands.executeCommand("forgeAgent.undoLast");
    await sleep(500);
    check("agent: undo restores README", fs.readFileSync(readme, "utf8") === r0);

    // ---------- cancellation mid-review ----------
    const runC = api.runAgent("Update the readme");
    await until(() => api.reviews.activeReviews[0], 90000, "review to cancel");
    const t0 = Date.now();
    api.cancel();
    await runC;
    await sleep(1500);
    check("cancel: run ends promptly", Date.now() - t0 < 5000, `${Date.now() - t0}ms`);
    check("cancel: workspace unchanged", git("status --porcelain") === "", git("status --porcelain"));
    check("cancel: editor not busy", !api.isBusy());

    // ---------- C: resilience ----------
    await setModels(["mockfail/mock-coder", "mock/mock-coder"]);
    ed.selection = new vscode.Selection(line, 0, line + 5, 0);
    await vscode.window.showTextDocument(doc);
    const n0 = api.events.length;
    const pf = api.inlineEdit("Treat 'off' and 'n' as false too");
    const rv3 = await until(() => api.reviews.activeReviews[0], 60000, "fallback review");
    const warn = api.events.slice(n0).find((e) => e.t === "status" && /Falling back/.test(e.msg));
    check("fallback: second model took over automatically", !!warn, warn && warn.msg.slice(0, 120));
    api.reviews.decideAll(rv3.id, false);
    await pf;
    check("fallback: rejecting all leaves file unchanged", fs.readFileSync(helpers, "utf8") === before);

    await setModels(["mockfail/mock-coder"]);
    await vscode.window.showTextDocument(doc);
    const n1 = api.events.length;
    const t1 = Date.now();
    await api.inlineEdit("Treat 'off' and 'n' as false too");
    const err = api.events.slice(n1).find((e) => e.t === "status" && e.level === "error");
    check("all-fail: clear error message, no hang", !!err && Date.now() - t1 < 30000, err && err.msg.slice(0, 140));
    check("all-fail: git status clean", git("status --porcelain") === "", git("status --porcelain"));
  } catch (e) {
    check("unexpected exception", false, e.stack || String(e));
  } finally {
    await vscode.workspace.getConfiguration("forgeAgent").update("models", undefined, vscode.ConfigurationTarget.Global);
    const report = results.join("\n");
    fs.writeFileSync(process.env.FORGE_E2E_REPORT || path.join(require("os").tmpdir(), "forge-e2e.txt"), report);
    console.log(report);
  }
};
