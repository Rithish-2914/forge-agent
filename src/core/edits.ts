// Turn an agent's search/replace edits into a full proposed file, refusing edits whose
// `old_text` does not exist (the "confidently edits a symbol that does not exist" failure).

export interface TextEdit {
  old_text: string;
  new_text: string;
}

export type EditResult =
  | { ok: true; content: string; notes: string[] }
  | { ok: false; error: string };

const LINE_NO_PREFIX = /^\s*\d+\s*[|│:]\s?/;

function stripLineNumbers(s: string): string {
  const lines = s.split(/\r?\n/);
  if (lines.every((l) => l === "" || LINE_NO_PREFIX.test(l)))
    return lines.map((l) => l.replace(LINE_NO_PREFIX, "")).join("\n");
  return s;
}

function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

/** Find `needle` in `hay` exactly, else with trailing whitespace ignored per line. */
function locate(hay: string, needle: string): { start: number; end: number } | "ambiguous" | null {
  const first = hay.indexOf(needle);
  if (first >= 0) {
    if (hay.indexOf(needle, first + 1) >= 0) return "ambiguous";
    return { start: first, end: first + needle.length };
  }
  // Fuzzy: compare line arrays with trimEnd.
  const h = hay.split("\n");
  const n = needle.split("\n").map((l) => l.trimEnd());
  while (n.length && n[n.length - 1] === "") n.pop();
  if (!n.length) return null;
  let found: number | null = null;
  for (let i = 0; i + n.length <= h.length; i++) {
    let ok = true;
    for (let j = 0; j < n.length; j++)
      if (h[i + j].trimEnd() !== n[j]) {
        ok = false;
        break;
      }
    if (ok) {
      if (found !== null) return "ambiguous";
      found = i;
    }
  }
  if (found === null) return null;
  const start = h.slice(0, found).join("\n").length + (found > 0 ? 1 : 0);
  const end = start + h.slice(found, found + n.length).join("\n").length;
  return { start, end };
}

export function applyTextEdits(original: string, edits: TextEdit[]): EditResult {
  const crlf = original.includes("\r\n");
  let text = normalizeEol(original);
  const notes: string[] = [];
  for (let i = 0; i < edits.length; i++) {
    let oldT = normalizeEol(edits[i].old_text ?? "");
    const newT = normalizeEol(edits[i].new_text ?? "");
    if (oldT === "") {
      // Empty old_text = append.
      text = text.endsWith("\n") || text === "" ? text + newT : text + "\n" + newT;
      notes.push(`edit ${i + 1}: appended`);
      continue;
    }
    let loc = locate(text, oldT);
    if (loc === null) {
      const stripped = stripLineNumbers(oldT);
      if (stripped !== oldT) {
        oldT = stripped;
        loc = locate(text, oldT);
        if (loc) notes.push(`edit ${i + 1}: ignored line-number prefixes in old_text`);
      }
    }
    if (loc === null)
      return {
        ok: false,
        error: `edit ${i + 1}: old_text was not found in the file. Re-read the file with read_file and copy old_text verbatim (without line numbers).`,
      };
    if (loc === "ambiguous")
      return {
        ok: false,
        error: `edit ${i + 1}: old_text matches more than one place. Include more surrounding lines so it is unique.`,
      };
    text = text.slice(0, loc.start) + newT + text.slice(loc.end);
  }
  return { ok: true, content: crlf ? text.replace(/\n/g, "\r\n") : text, notes };
}
