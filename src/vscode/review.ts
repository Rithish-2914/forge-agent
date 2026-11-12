// Hunk-by-hunk review of a proposed change, and undoable application.
// Nothing touches the file until the user accepts; applied changes go through WorkspaceEdit
// (so Ctrl+Z works) and are also recorded for Forge's own "Undo last change".
import * as vscode from "vscode";
import * as path from "path";
import { Proposal } from "../core/tools";
import { applyHunks, Hunk } from "../core/hunks";
import { RepoIndex } from "../core/context";

export const PROPOSAL_SCHEME = "forge-proposal";
export const ORIGINAL_SCHEME = "forge-original";

export type HunkState = "pending" | "accepted" | "rejected";

export interface ReviewSession {
  id: string;
  proposal: Proposal;
  states: HunkState[];
  origin: "agent" | "inline";
  resolve: (accepted: Set<number>) => void;
  done: boolean;
}

export interface AppliedChange {
  id: string;
  file: string;
  before: string | null; // null = file did not exist
  after: string;
  label: string;
  runId?: string;
  at: number;
}

export interface ReviewUi {
  showReview(r: ReviewSession): void;
  updateReview(r: ReviewSession): void;
  endReview(r: ReviewSession, accepted: number[]): void;
  applied(c: AppliedChange, stack: number): void;
}

let seq = 0;

export class ReviewManager implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider {
  private reviews = new Map<string, ReviewSession>();
  private undoStack: AppliedChange[] = [];
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  private _onLens = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onLens.event;
  ui?: ReviewUi;

  constructor(private root: string, private index: RepoIndex, private log: (s: string) => void) {}

  get activeReviews() {
    return [...this.reviews.values()].filter((r) => !r.done);
  }
  get undoDepth() {
    return this.undoStack.length;
  }

  // ---------- virtual documents for the diff editor ----------
  provideTextDocumentContent(uri: vscode.Uri): string {
    const id = new URLSearchParams(uri.query).get("id") ?? "";
    const r = this.reviews.get(id);
    if (!r) return "";
    if (uri.scheme === ORIGINAL_SCHEME) return r.proposal.original;
    return this.previewText(r);
  }

  /** Original + accepted + pending hunks (rejected hunks drop out of the preview). */
  private previewText(r: ReviewSession): string {
    const show = new Set(r.proposal.hunks.filter((h) => r.states[h.index] !== "rejected").map((h) => h.index));
    return applyHunks(r.proposal.original, r.proposal.hunks, show);
  }

  private uris(r: ReviewSession) {
    const name = path.basename(r.proposal.path);
    const q = `id=${r.id}`;
    return {
      left: vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: `/${r.proposal.path}`, query: q }),
      right: vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: `/${r.proposal.path}`, query: q }),
      title: `${name}: Forge proposal (${r.proposal.isNew ? "new file" : `${r.proposal.hunks.length} hunk${r.proposal.hunks.length === 1 ? "" : "s"}`})`,
    };
  }

  // ---------- code lenses on the proposal side of the diff ----------
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (doc.uri.scheme !== PROPOSAL_SCHEME) return [];
    const id = new URLSearchParams(doc.uri.query).get("id") ?? "";
    const r = this.reviews.get(id);
    if (!r || r.done) return [];
    const lenses: vscode.CodeLens[] = [];
    // map each hunk to its line in the preview text
    let delta = 0;
    for (const h of r.proposal.hunks) {
      const line = Math.max(0, h.origStart + delta);
      const range = new vscode.Range(line, 0, line, 0);
      const st = r.states[h.index];
      if (st === "pending") {
        lenses.push(new vscode.CodeLens(range, { title: `$(check) Accept hunk ${h.index + 1}`, command: "forgeAgent.hunk", arguments: [r.id, h.index, true] }));
        lenses.push(new vscode.CodeLens(range, { title: `$(close) Reject`, command: "forgeAgent.hunk", arguments: [r.id, h.index, false] }));
      } else lenses.push(new vscode.CodeLens(range, { title: st === "accepted" ? `✓ hunk ${h.index + 1} accepted (click to undo)` : `✗ hunk ${h.index + 1} rejected (click to undo)`, command: "forgeAgent.hunk", arguments: [r.id, h.index, null] }));
      if (st !== "rejected") delta += h.added.length - h.removed.length;
    }
    return lenses;
  }

  // ---------- review lifecycle ----------
  review(p: Proposal, origin: "agent" | "inline", token?: AbortSignal): Promise<Set<number>> {
    const id = `r${++seq}`;
    return new Promise<Set<number>>((resolve) => {
      const r: ReviewSession = { id, proposal: p, states: p.hunks.map(() => "pending"), origin, resolve, done: false };
      this.reviews.set(id, r);
      token?.addEventListener("abort", () => this.finish(id, true));
      const { left, right, title } = this.uris(r);
      vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: false, preserveFocus: origin === "agent" });
      vscode.commands.executeCommand("setContext", "forgeAgent.reviewing", true);
      this.ui?.showReview(r);
    });
  }

  decide(id: string, hunk: number, accept: boolean | null) {
    const r = this.reviews.get(id);
    if (!r || r.done) return;
    r.states[hunk] = accept === null ? "pending" : accept ? "accepted" : "rejected";
    this.refresh(r);
    if (r.states.every((s) => s !== "pending")) this.finish(id);
  }

  decideAll(id: string | undefined, accept: boolean) {
    const r = id ? this.reviews.get(id) : this.activeReviews[0];
    if (!r || r.done) return;
    r.states = r.states.map((s) => (s === "pending" ? (accept ? "accepted" : "rejected") : s));
    this.finish(r.id);
  }

  /** Apply = accept the pending ones the user left untouched? No: pending hunks are rejected. */
  finish(id: string, cancelled = false) {
    const r = this.reviews.get(id);
    if (!r || r.done) return;
    if (cancelled) r.states = r.states.map(() => "rejected");
    r.done = true;
    const accepted = r.states.map((s, i) => (s === "accepted" ? i : -1)).filter((i) => i >= 0);
    this.refresh(r);
    this.ui?.endReview(r, accepted);
    if (!this.activeReviews.length) vscode.commands.executeCommand("setContext", "forgeAgent.reviewing", false);
    this.closeDiff(r);
    r.resolve(new Set(accepted));
  }

  private refresh(r: ReviewSession) {
    const { right } = this.uris(r);
    this._onDidChange.fire(right);
    this._onLens.fire();
    this.ui?.updateReview(r);
  }

  private async closeDiff(r: ReviewSession) {
    const { right } = this.uris(r);
    for (const g of vscode.window.tabGroups.all)
      for (const t of g.tabs) {
        const input: any = t.input;
        if (input?.modified?.toString?.() === right.toString()) await vscode.window.tabGroups.close(t).then(undefined, () => {});
      }
  }

  getReview(id: string) {
    return this.reviews.get(id);
  }

  // ---------- applying and undo ----------
  async apply(p: Proposal, accepted: Set<number>, label: string, runId?: string): Promise<AppliedChange | null> {
    if (!accepted.size) return null;
    const next = p.isNew ? p.proposed : applyHunks(p.original, p.hunks, accepted);
    const uri = vscode.Uri.file(path.join(this.root, p.path));
    const before = await this.currentText(uri);
    if (before !== null && before !== p.original && !p.isNew) {
      throw new Error(`${p.path} changed while the proposal was under review; not applied. Ask the agent to re-read it.`);
    }
    await this.writeWhole(uri, before, next);
    const change: AppliedChange = { id: `c${++seq}`, file: p.path, before, after: next, label, runId, at: Date.now() };
    this.undoStack.push(change);
    this.index.updateFile(p.path, next);
    this.ui?.applied(change, this.undoStack.length);
    this.log(`applied ${accepted.size}/${p.hunks.length} hunks to ${p.path}`);
    return change;
  }

  private async currentText(uri: vscode.Uri): Promise<string | null> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    if (open) return open.getText();
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    } catch {
      return null;
    }
  }

  /** One atomic WorkspaceEdit per file, then save, so a cancel can never leave half a file. */
  private async writeWhole(uri: vscode.Uri, before: string | null, next: string) {
    const we = new vscode.WorkspaceEdit();
    if (before === null) {
      we.createFile(uri, { ignoreIfExists: true });
      we.insert(uri, new vscode.Position(0, 0), next);
    } else {
      const doc = await vscode.workspace.openTextDocument(uri);
      we.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), next);
    }
    const ok = await vscode.workspace.applyEdit(we);
    if (!ok) throw new Error(`VS Code refused the edit to ${uri.fsPath}`);
    const doc = await vscode.workspace.openTextDocument(uri);
    await doc.save();
  }

  async undoLast(): Promise<AppliedChange | null> {
    const c = this.undoStack.pop();
    if (!c) return null;
    await this.revert(c);
    return c;
  }

  async undoRun(runId: string): Promise<AppliedChange[]> {
    const mine = this.undoStack.filter((c) => c.runId === runId).reverse();
    for (const c of mine) await this.revert(c);
    this.undoStack = this.undoStack.filter((c) => c.runId !== runId);
    return mine;
  }

  private async revert(c: AppliedChange) {
    const uri = vscode.Uri.file(path.join(this.root, c.file));
    const now = await this.currentText(uri);
    if (now !== null && now !== c.after) {
      const pick = await vscode.window.showWarningMessage(`${c.file} was edited after Forge changed it. Revert Forge's change anyway (your later edits to this file are lost)?`, { modal: true }, "Revert");
      if (pick !== "Revert") {
        this.undoStack.push(c);
        throw new Error("undo cancelled");
      }
    }
    if (c.before === null) {
      const we = new vscode.WorkspaceEdit();
      we.deleteFile(uri, { ignoreIfNotExists: true });
      await vscode.workspace.applyEdit(we);
      this.index.updateFile(c.file, null);
    } else {
      await this.writeWhole(uri, now, c.before);
      this.index.updateFile(c.file, c.before);
    }
    this.log(`reverted ${c.label} (${c.file})`);
  }
}

export function hunkPreview(h: Hunk): string {
  return [...h.before.map((l) => "  " + l), ...h.removed.map((l) => "- " + l), ...h.added.map((l) => "+ " + l), ...h.after.map((l) => "  " + l)].join("\n");
}
