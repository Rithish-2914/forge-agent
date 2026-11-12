// Inline edit: select code, press Ctrl+Alt+K, describe the change. The reply streams from
// TrueForge, becomes a proposal, and is reviewed hunk by hunk in a diff editor.
import * as vscode from "vscode";
import * as path from "path";
import { computeHunks } from "../core/hunks";
import { Proposal } from "../core/tools";
import { RepoIndex, estimateTokens, parseMentions } from "../core/context";

export const INLINE_INSTRUCTIONS = `You are Forge's inline editor inside VS Code. You receive a file excerpt with a <selection> and an instruction.
Rewrite ONLY the selected code so it satisfies the instruction, keeping everything else (style, indentation, names, type hints) as it is.
Reply with exactly one fenced code block containing the complete replacement for the selection and nothing outside it. No explanations.`;

export interface InlineRequest {
  rel: string;
  languageId: string;
  original: string;
  startLine: number; // 0-based inclusive
  endLine: number; // 0-based inclusive
  instruction: string;
}

export function pickRange(editor: vscode.TextEditor, index: RepoIndex, rel: string): { start: number; end: number } {
  const sel = editor.selection;
  if (!sel.isEmpty) {
    let end = sel.end.line;
    if (sel.end.character === 0 && end > sel.start.line) end--; // selection ending at column 0
    return { start: sel.start.line, end };
  }
  // No selection: use the innermost function/class around the cursor.
  const line = sel.active.line + 1;
  const syms = index.symbols
    .filter((s) => s.file === rel && s.line <= line && s.endLine >= line && s.kind !== "heading" && s.kind !== "command")
    .sort((a, b) => a.endLine - a.line - (b.endLine - b.line));
  if (syms.length) return { start: syms[0].line - 1, end: syms[0].endLine - 1 };
  return { start: sel.active.line, end: sel.active.line };
}

export function buildInlinePrompt(req: InlineRequest, index: RepoIndex, budgetTokens: number): { prompt: string; related: string[] } {
  const lines = req.original.split(/\r?\n/);
  const ctxLines = 60;
  const before = lines.slice(Math.max(0, req.startLine - ctxLines), req.startLine).join("\n");
  const selection = lines.slice(req.startLine, req.endLine + 1).join("\n");
  const after = lines.slice(req.endLine + 1, req.endLine + 1 + ctxLines).join("\n");
  // Related definitions: identifiers used in the selection that are defined in OTHER places,
  // plus @mentions in the instruction. Small budget: inline edits must be fast.
  const related: string[] = [];
  const parts: string[] = [];
  let used = 0;
  const ids = new Set((selection.match(/[A-Za-z_]\w{2,}/g) ?? []).filter((w) => !/^(self|None|True|False|return|import|from|def|class|elif|else|lambda|with|yield|async|await|raise|except|finally|while|for|not|and|the)$/.test(w)));
  const { mentions } = parseMentions(req.instruction);
  for (const m of mentions) if (m.kind === "symbol") ids.add(m.value);
  for (const id of ids) {
    for (const d of index.findSymbol(id)) {
      if (d.name !== id && !mentions.some((m) => m.value === id)) continue;
      if (d.file === req.rel && d.line - 1 >= req.startLine && d.line - 1 <= req.endLine) continue;
      const mentioned = mentions.some((m) => m.value === id);
      if (d.kind === "heading" || (d.kind === "method" && !mentioned)) continue;
      if (!mentioned && d.file !== req.rel && /(^|\/)(tests?|examples|docs)\//.test(d.file)) continue;
      const body = index.readRange(d.file, d.line, Math.min(d.endLine, d.line + 40));
      const t = estimateTokens(body);
      if (used + t > budgetTokens) continue;
      used += t;
      related.push(`${d.file}:${d.line}`);
      parts.push(`# ${d.file}:${d.line}\n${body}`);
      break;
    }
  }
  const lang = req.languageId || path.extname(req.rel).slice(1);
  const prompt =
    `File: ${req.rel} (${lang}). Edit the selected lines ${req.startLine + 1}-${req.endLine + 1}.\n\n` +
    `Instruction: ${req.instruction}\n\n` +
    `<before>\n${before}\n</before>\n<selection lines="${req.startLine + 1}-${req.endLine + 1}">\n${selection}\n</selection>\n<after>\n${after}\n</after>\n` +
    (parts.length ? `\nRelated definitions elsewhere in the repo (read-only):\n<related>\n${parts.join("\n\n")}\n</related>\n` : "") +
    `\nReply with ONLY the full replacement for the selection in one fenced \`\`\`${lang} code block.`;
  return { prompt, related };
}

export function extractCode(reply: string, selection: string): string | null {
  const blocks = [...reply.matchAll(/```[^\n`]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  let code = blocks.length ? blocks.sort((a, b) => b.length - a.length)[0] : null;
  if (code === null) {
    const t = reply.trim();
    if (!t) return null;
    code = t; // model ignored the fence instruction
  }
  code = code.replace(/\n$/, "");
  // Re-indent if the model dropped the selection's base indentation.
  const baseSel = /^[ \t]*/.exec(selection.split(/\r?\n/).find((l) => l.trim()) ?? "")![0];
  const baseNew = /^[ \t]*/.exec(code.split("\n").find((l) => l.trim()) ?? "")![0];
  if (baseSel.length > baseNew.length && baseNew === "")
    code = code
      .split("\n")
      .map((l) => (l.trim() ? baseSel + l : l))
      .join("\n");
  return code;
}

export function buildInlineProposal(req: InlineRequest, code: string): Proposal {
  const eol = req.original.includes("\r\n") ? "\r\n" : "\n";
  const lines = req.original.split(/\r?\n/);
  const next = [...lines.slice(0, req.startLine), ...code.split(/\r?\n/), ...lines.slice(req.endLine + 1)].join(eol);
  return {
    key: `${req.rel}\n${next}`,
    tool: "propose_edit",
    path: req.rel,
    isNew: false,
    original: req.original,
    proposed: next,
    hunks: computeHunks(req.original, next),
    summary: `Inline edit: ${req.instruction}`,
    notes: [],
  };
}
