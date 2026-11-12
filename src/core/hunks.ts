// Line-level diff -> independent hunks that can be accepted or rejected one by one.
// No dependency: LCS on the trimmed middle (common prefix/suffix removed first), which is
// small for the edits a coding agent proposes.

export interface Hunk {
  index: number;
  /** 0-based line in the ORIGINAL text where the hunk starts. */
  origStart: number;
  removed: string[];
  added: string[];
  /** Context lines shown around the hunk in previews. */
  before: string[];
  after: string[];
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function computeHunks(original: string, proposed: string, context = 2): Hunk[] {
  const a = splitLines(original);
  const b = splitLines(proposed);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  )
    suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);

  // LCS table on the middle section.
  const n = am.length;
  const m = bm.length;
  const ops: Array<{ t: "=" | "-" | "+"; line: string }> = [];
  if (n * m > 4_000_000) {
    // Too big for a table: treat the middle as one replacement.
    for (const l of am) ops.push({ t: "-", line: l });
    for (const l of bm) ops.push({ t: "+", line: l });
  } else {
    const dp: Uint32Array[] = [];
    for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        ops.push({ t: "=", line: am[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ t: "-", line: am[i++] });
      } else {
        ops.push({ t: "+", line: bm[j++] });
      }
    }
    while (i < n) ops.push({ t: "-", line: am[i++] });
    while (j < m) ops.push({ t: "+", line: bm[j++] });
  }

  // Group runs of -/+ into hunks. Equal runs of 1 line between changes are merged so a
  // single logical edit is not split into confetti.
  const hunks: Hunk[] = [];
  let origLine = pre;
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === "=") {
      origLine++;
      k++;
      continue;
    }
    const start = origLine;
    const removed: string[] = [];
    const added: string[] = [];
    while (k < ops.length) {
      if (ops[k].t === "-") {
        removed.push(ops[k].line);
        origLine++;
        k++;
      } else if (ops[k].t === "+") {
        added.push(ops[k].line);
        k++;
      } else if (k + 1 < ops.length && ops[k + 1].t !== "=" && ops[k].t === "=") {
        // single equal line sandwiched between changes: absorb it
        removed.push(ops[k].line);
        added.push(ops[k].line);
        origLine++;
        k++;
      } else break;
    }
    hunks.push({
      index: hunks.length,
      origStart: start,
      removed,
      added,
      before: a.slice(Math.max(0, start - context), start),
      after: a.slice(start + removed.length, start + removed.length + context),
    });
  }
  return hunks;
}

/** Rebuild text from the original applying only the hunks whose index is in `accepted`. */
export function applyHunks(original: string, hunks: Hunk[], accepted: Set<number>): string {
  const eol = detectEol(original);
  const a = splitLines(original);
  const out: string[] = [];
  let pos = 0;
  for (const h of [...hunks].sort((x, y) => x.origStart - y.origStart)) {
    while (pos < h.origStart) out.push(a[pos++]);
    if (accepted.has(h.index)) out.push(...h.added);
    else out.push(...h.removed);
    pos += h.removed.length;
  }
  while (pos < a.length) out.push(a[pos++]);
  return out.join(eol);
}

export function hunkStats(h: Hunk): string {
  return `-${h.removed.length} +${h.added.length} @ line ${h.origStart + 1}`;
}
