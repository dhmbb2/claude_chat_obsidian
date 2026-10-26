// Text-quote anchors inside one rendered reading-view block.
// Reading view renders a note as a list of block <div>s (one per paragraph,
// list, callout…) and only keeps nearby blocks in the DOM, so an anchor is the
// quoted text plus a little context on either side, matched block by block.

export interface Anchor {
  exact: string;
  prefix: string;
  suffix: string;
}

const CONTEXT = 40;
// Rendered-but-not-text parts: MathJax output, buttons, fold arrows, properties.
const SKIP = "mjx-container, .MathJax, .copy-code-button, .collapse-indicator, .metadata-container, .frontmatter-container";

export function blockOf(node: Node | null): HTMLElement | null {
  const el = node instanceof HTMLElement ? node : node?.parentElement;
  return (el?.closest(".markdown-preview-sizer > div") as HTMLElement | null) ?? null;
}

export function textNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

const blockText = (root: HTMLElement) => textNodes(root).map((n) => n.data).join("");

/** Anchor for text[start, end), with context taken only from [lo, hi) (the same line or block). */
export function anchorFromText(text: string, start: number, end: number, lo = 0, hi = text.length): Anchor | null {
  const exact = text.slice(start, end);
  if (!exact.trim()) return null;
  return { exact, prefix: text.slice(Math.max(lo, start - CONTEXT), start), suffix: text.slice(end, Math.min(hi, end + CONTEXT)) };
}

export function anchorFromRange(block: HTMLElement, range: Range): Anchor | null {
  let pos = 0;
  let start = -1;
  let end = -1;
  for (const n of textNodes(block)) {
    const len = n.data.length;
    if (range.intersectsNode(n)) {
      const s = n === range.startContainer ? range.startOffset : 0;
      const e = n === range.endContainer ? range.endOffset : len;
      if (e > s) {
        if (start < 0) start = pos + s;
        end = pos + e;
      }
    }
    pos += len;
  }
  return start < 0 ? null : anchorFromText(blockText(block), start, end);
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
export function locateAnchor(text: string, a: Anchor): { start: number; end: number } | null {
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

function wrap(block: HTMLElement, start: number, end: number, make: () => HTMLElement): HTMLElement[] {
  const targets: [Text, number, number][] = [];
  let pos = 0;
  for (const n of textNodes(block)) {
    const s = Math.max(start, pos);
    const e = Math.min(end, pos + n.data.length);
    if (s < e) targets.push([n, s - pos, e - pos]);
    pos += n.data.length;
  }
  const spans: HTMLElement[] = [];
  for (const [n, s, e] of targets) {
    if (!n.data.slice(s, e).trim()) continue; // whitespace between block elements
    const node = s > 0 ? n.splitText(s) : n;
    if (e - s < node.data.length) node.splitText(e - s);
    const span = make();
    node.parentNode!.insertBefore(span, node);
    span.append(node);
    spans.push(span);
  }
  return spans;
}

/** Marks the anchor's passage in this block; returns the created spans (empty if not found here). */
export function markAnchor(block: HTMLElement, anchor: Anchor, make: () => HTMLElement): HTMLElement[] {
  const where = locateAnchor(blockText(block), anchor);
  return where ? wrap(block, where.start, where.end, make) : [];
}

export function unmark(spans: Iterable<HTMLElement>) {
  for (const span of spans) {
    const parent = span.parentNode;
    if (!parent) continue;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    span.remove();
    parent.normalize();
  }
}
