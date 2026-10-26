// Plain-text projection of a note's Markdown source: roughly the text reading
// view shows (no syntax markers, no math, no frontmatter), with a map from each
// plain character back to its source offset. This lets an anchor created in one
// view be found in the other.

export interface Projection {
  text: string;
  toSrc: number[]; // plain index → source offset
}

// Blockquote / callout / heading / list markers at the start of a line.
const LINE_PREFIX = /^(?:\s*>)*\s*(?:\[![^\]]+\][+-]?\s*)?(?:#{1,6}\s+|[-*+]\s+(?:\[.\]\s+)?|\d+[.)]\s+)?/;
const unquote = (line: string) => line.replace(/^(\s*>)*\s*/, "");

export function project(src: string): Projection {
  const out: string[] = [];
  const toSrc: number[] = [];
  const push = (ch: string, i: number) => {
    out.push(ch);
    toSrc.push(i);
  };

  let i = src.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)?.[0].length ?? 0;
  let inFence = false;
  let inMath = false;
  while (i < src.length) {
    const nl = src.indexOf("\n", i);
    const end = nl === -1 ? src.length : nl;
    const line = src.slice(i, end);
    const body = unquote(line).trim();

    if (/^(```|~~~)/.test(body)) {
      inFence = !inFence;
    } else if (inFence) {
      for (let k = i; k < end; k++) push(src[k], k);
    } else if (body.startsWith("$$")) {
      // "$$" opens/closes a display block; "$$ x $$" on one line is a whole block.
      if (!(body.length > 4 && body.endsWith("$$"))) inMath = !inMath;
    } else if (inMath) {
      // display math is not text
    } else if (/^([-*_])(\s*\1){2,}$/.test(body) || /^\|?[\s|:-]*-{3,}[\s|:-]*$/.test(body)) {
      // horizontal rule / table separator row
    } else {
      inline(src, i + (line.match(LINE_PREFIX)?.[0].length ?? 0), end, push);
    }
    if (nl === -1) break;
    push("\n", end);
    i = end + 1;
  }
  return { text: out.join(""), toSrc };
}

function inline(src: string, start: number, end: number, push: (ch: string, i: number) => void) {
  let k = start;
  const rest = () => src.slice(k, end);
  while (k < end) {
    const c = src[k];
    const next = src[k + 1];
    if (c === "\\" && k + 1 < end) {
      push(next, k + 1);
      k += 2;
    } else if (c === "$") {
      const close = src.indexOf("$", k + 1);
      k = close !== -1 && close < end ? close + 1 : k + 1; // inline math is not text
    } else if (c === "`" || c === "*" || c === "|") {
      k++;
    } else if ((c === "~" || c === "=" || c === "_") && next === c) {
      k += 2;
    } else if (c === "!" && src.startsWith("![[", k)) {
      const close = src.indexOf("]]", k);
      k = close !== -1 && close < end ? close + 2 : k + 1;
    } else if (c === "[" && next === "[") {
      // [[target|alias]] shows the alias (or the target)
      const close = src.indexOf("]]", k);
      if (close === -1 || close > end) {
        push(c, k++);
        continue;
      }
      const bar = src.lastIndexOf("|", close);
      for (let q = bar > k ? bar + 1 : k + 2; q < close; q++) push(src[q], q);
      k = close + 2;
    } else if (c === "[" && /^\[[^\]]*\]\([^)]*\)/.test(rest())) {
      const m = /^\[([^\]]*)\]\([^)]*\)/.exec(rest())!;
      for (let q = 0; q < m[1].length; q++) push(src[k + 1 + q], k + 1 + q);
      k += m[0].length;
    } else if (c === "<" && /^<\/?[a-zA-Z][^>]*>/.test(rest())) {
      k += /^<\/?[a-zA-Z][^>]*>/.exec(rest())![0].length;
    } else {
      push(c, k++);
    }
  }
}

/** Plain index of the first plain character at or after a source offset. */
export function plainIndex(p: Projection, srcOffset: number): number {
  let lo = 0;
  let hi = p.toSrc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (p.toSrc[mid] < srcOffset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
