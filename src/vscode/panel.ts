import * as vscode from "vscode";
import * as crypto from "crypto";

export type ToWebview = Record<string, any> & { t: string };
export type FromWebview = Record<string, any> & { t: string };

export class AgentPanel implements vscode.WebviewViewProvider {
  static readonly viewId = "forgeAgent.panel";
  private view?: vscode.WebviewView;
  private backlog: ToWebview[] = [];
  onMessage?: (m: FromWebview) => void;

  constructor(private extUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extUri, "media")] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m) => this.onMessage?.(m));
    view.onDidDispose(() => (this.view = undefined));
  }

  post(m: ToWebview) {
    if (this.view) this.view.webview.postMessage(m);
    else {
      this.backlog.push(m);
      if (this.backlog.length > 2000) this.backlog.shift();
    }
  }

  flush() {
    if (!this.view) return;
    for (const m of this.backlog.splice(0)) this.view.webview.postMessage(m);
  }

  async reveal() {
    await vscode.commands.executeCommand(`${AgentPanel.viewId}.focus`);
  }

  private html(w: vscode.Webview) {
    const nonce = crypto.randomBytes(16).toString("hex");
    const js = w.asWebviewUri(vscode.Uri.joinPath(this.extUri, "media", "panel.js"));
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.extUri, "media", "panel.css"));
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"></head>
<body>
<header id="bar"><span id="model" title="Active model">model: …</span><span id="session"></span><span class="grow"></span>
<button id="undo" title="Undo the last change Forge applied" disabled>↶ Undo</button><button id="newchat" title="New conversation">＋</button></header>
<main id="log"><div class="hint">Ask for a change. Forge finds the files itself; mention <code>@file</code> or <code>@symbol</code> to pin context. Every edit is shown hunk by hunk before it touches disk.</div></main>
<footer><div id="suggest" hidden></div>
<textarea id="input" rows="3" placeholder="Describe the change…  (Enter to send, Shift+Enter for newline, @ to mention)"></textarea>
<div class="row"><span id="busy" hidden><span class="spin"></span> working…</span><span class="grow"></span><button id="stop" hidden title="Cancel the run (nothing half-applied)">■ Stop</button><button id="send">Send</button></div></footer>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
  }
}
