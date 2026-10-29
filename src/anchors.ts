// Anchors: where in a note a question was asked. An anchor is a range of the
// note's Markdown source (so it includes formulas, tables and callout syntax),
// stored as the exact source text plus a little context on either side so it
// can be found again after the note is edited.
import { plainIndex, project, type Projection } from "./plaintext";

export interface Anchor {
  exact: string;
  prefix: string;
  suffix: string;
  v?: 2; // source anchor; anchors saved by older versions hold rendered text instead
}

export interface SourceRange {
  from: number;
  to: number;
}

const CONTEXT = 40;
const EMPHASIS = "*~=`";
// Rendered-but-not-text parts: MathJax output, buttons, fold arrows, properties.
const SKIP =
  "mjx-container, .MathJax, .copy-code-button, .collapse-indicator, .metadata-container, .frontmatter-container, .edit-block-button";

/** Anchor for source[from, to), trimmed of surrounding whitespace and widened over adjacent **, ~~, ==, ` markers. */
export function sourceAnchor(doc: string, from: number, to: number): { anchor: Anchor; range: SourceRange } | null {
  while (from < to && /\s/.test(doc[from])) from++;
  while (to > from && /\s/.test(doc[to - 1])) to--;
  if (from >= to) return null;
  while (from > 0 && EMPHASIS.includes(doc[from - 1])) from--;
  while (to < doc.length && EMPHASIS.includes(doc[to])) to++;
  return {
    anchor: { exact: doc.slice(from, to), prefix: doc.slice(Math.max(0, from - CONTEXT), from), suffix: doc.slice(to, to + CONTEXT), v: 2 },
    range: { from, to },
  };
}

/** Where the anchor's passage is in the note now, or null if it was edited away. */
export function locate(doc: string, a: Anchor, proj?: () => Projection): SourceRange | null {
  if (a.v === 2) {
    const where = bestMatch(doc, a);
    return where && { from: where.start, to: where.end };
  }
  // Older anchors hold rendered text: find it in the plain-text projection.
  const p = proj?.() ?? project(doc);
  const where = bestMatch(p.text, a);
  return where && { from: p.toSrc[where.start], to: p.toSrc[where.end - 1] + 1 };
}

const commonPrefix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};
const commonSuffix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
};

// Best occurrence of the quote in this text, if its surroundings match well
// enough that it is the passage the question was about.
function bestMatch(text: string, a: Anchor): { start: number; end: number } | null {
  let best = -1;
  let bestScore = -1;
  for (let i = text.indexOf(a.exact); i !== -1; i = text.indexOf(a.exact, i + 1)) {
    const before = text.slice(Math.max(0, i - a.prefix.length), i);
    const after = text.slice(i + a.exact.length, i + a.exact.length + a.suffix.length);
    const score = commonSuffix(before, a.prefix) + commonPrefix(after, a.suffix);
    if (score > bestScore) [best, bestScore] = [i, score];
  }
  const need = a.prefix.length + a.suffix.length;
  if (best < 0 || (need > 0 && bestScore < need * 0.5)) return null;
  return { start: best, end: best + a.exact.length };
}

// ---------- rendered selection → source ----------

export function textNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

/**
 * Source offset of a selection endpoint inside rendered Markdown: a reading-view
 * block, or a widget Live Preview draws (callout, table, formula). `block` shows
 * source[from, to). The rendered text and the plain-text projection of that
 * source hold the same non-space characters (formulas are in neither), so the
 * endpoint is matched by counting those. An endpoint inside a formula takes in
 * the whole formula.
 */
export function sourceOffsetIn(
  block: HTMLElement,
  range: SourceRange,
  proj: Projection,
  node: Node,
  offset: number,
  side: "start" | "end",
): number {
  const el = node instanceof Element ? node : node.parentElement;
  const inFormula = !!el?.closest(SKIP);

  // Non-space rendered characters before the endpoint.
  const point = document.createRange();
  point.setStart(node, offset);
  let before = 0;
  const rendered: string[] = [];
  for (const n of textNodes(block)) {
    const chars = n.data.replace(/\s/g, "");
    rendered.push(chars);
    if (n === node) before += n.data.slice(0, offset).replace(/\s/g, "").length;
    else if (point.comparePoint(n, n.data.length) <= 0) before += chars.length; // wholly before the endpoint
  }
  const renderedText = rendered.join("");

  // The block's plain characters and their source offsets.
  const plain: number[] = []; // source offset of each non-space plain char
  let plainText = "";
  for (let i = plainIndex(proj, range.from); i < proj.text.length && proj.toSrc[i] < range.to; i++) {
    if (/\s/.test(proj.text[i])) continue;
    plain.push(proj.toSrc[i]);
    plainText += proj.text[i];
  }

  const k = align(renderedText, plainText, before, side);
  // Start: the first plain char at or after the endpoint; inside a formula, right after the text before it.
  // End: right after the last plain char before the endpoint; inside a formula, the text after it.
  if (side === "start") {
    if (inFormula) return k > 0 ? plain[k - 1] + 1 : range.from;
    return k < plain.length ? plain[k] : range.to;
  }
  if (inFormula) return k < plain.length ? plain[k] : range.to;
  return k > 0 ? plain[k - 1] + 1 : range.from;
}

/** Index in `plain` that matches index `k` in `rendered` (usually the same text). */
function align(rendered: string, plain: string, k: number, side: "start" | "end"): number {
  if (rendered === plain) return k;
  // Rendered extras (a callout's default title, list numbers) shift things: match nearby text.
  const N = 8;
  const probe = side === "start" ? rendered.slice(k, k + N) : rendered.slice(Math.max(0, k - N), k);
  const guess = Math.round((k * plain.length) / Math.max(1, rendered.length));
  let best = -1;
  if (probe) {
    for (let i = plain.indexOf(probe); i !== -1; i = plain.indexOf(probe, i + 1)) {
      const at = side === "start" ? i : i + probe.length;
      if (best < 0 || Math.abs(at - guess) < Math.abs(best - guess)) best = at;
    }
  }
  return Math.max(0, Math.min(plain.length, best >= 0 ? best : guess));
}

/** Line number of a source offset. */
export function lineOf(doc: string, offset: number): number {
  let line = 0;
  for (let i = doc.indexOf("\n"); i !== -1 && i < offset; i = doc.indexOf("\n", i + 1)) line++;
  return line;
}

/** Source offsets where lines [start, end] begin and end. */
export function lineSpan(doc: string, start: number, end: number): SourceRange {
  let from = 0;
  for (let l = 0; l < start && from !== -1; l++) from = doc.indexOf("\n", from) + 1 || -1;
  if (from < 0) return { from: doc.length, to: doc.length };
  let to = from;
  for (let l = start; l <= end; l++) {
    const nl = doc.indexOf("\n", to);
    if (nl === -1) return { from, to: doc.length };
    to = l === end ? nl : nl + 1;
  }
  return { from, to };
}
