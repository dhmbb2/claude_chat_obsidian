// Left-margin markers for passages with questions: a thin bar beside the lines
// the passage spans, with a small icon at its top. Both views draw them from the
// same source line range, so a passage looks the same in reading and editing
// view, tables and formulas included.
import { MarkdownView, setIcon, setTooltip } from "obsidian";
import { lineOf, type SourceRange } from "./anchors";

export interface NoteMark extends SourceRange {
  id: string | null; // null: a selection with no question yet
  state: "" | "pending" | "active";
  lines: [number, number]; // first and last source line
  lane: number; // overlapping passages sit side by side
}

export interface MarkSource {
  /** Threads (and a pending, not-yet-asked selection) to mark in this note. */
  marksFor(path: string, doc: string): NoteMark[];
}

const GUTTER = 22; // px from the text's left edge to the first lane
const LANE = 9;

export const markerX = (lane: number) => GUTTER + lane * LANE;

/** Line numbers and lanes for located passages. */
export function layoutMarks(doc: string, found: (SourceRange & Pick<NoteMark, "id" | "state">)[]): NoteMark[] {
  const marks: NoteMark[] = found
    .map((f) => ({ ...f, lines: [lineOf(doc, f.from), lineOf(doc, f.to - 1)] as [number, number], lane: 0 }))
    .sort((a, b) => a.lines[0] - b.lines[0] || b.lines[1] - a.lines[1]);
  const laneEnds: number[] = []; // last line used in each lane
  for (const m of marks) {
    let lane = laneEnds.findIndex((end) => end < m.lines[0]);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = m.lines[1];
    m.lane = lane;
  }
  return marks;
}

export function markerEl(m: NoteMark, path: string, head: boolean): HTMLElement {
  const el = createDiv({ cls: "sa-gm" });
  if (m.state) el.addClass(`is-${m.state}`);
  if (m.id) {
    el.dataset.tid = m.id;
    el.dataset.path = path;
  }
  el.createDiv({ cls: "sa-gm-bar" });
  if (head) {
    const icon = el.createDiv({ cls: "sa-gm-icon" });
    setIcon(icon, "message-circle");
    if (m.id) setTooltip(icon, "查看提问记录", { placement: "left" });
  }
  return el;
}

// ---------- reading view ----------

interface PreviewSection {
  el: HTMLElement;
  start: { line: number };
  end: { line: number };
}

/** Reading view's rendered blocks with their source lines (internal API; null if it changes). */
export function previewSections(view: MarkdownView): PreviewSection[] | null {
  const sections = (view.previewMode as unknown as { renderer?: { sections?: PreviewSection[] } }).renderer?.sections;
  return Array.isArray(sections) && sections.every((s) => s.el && typeof s.start?.line === "number") ? sections : null;
}

/**
 * Draw the markers for reading view in an overlay inside its scroller, one per
 * passage, from the top of its first rendered block to the bottom of its last.
 * (A marker inside a block would be clipped by blocks that scroll sideways,
 * like tables.) Blocks far from the viewport are not in the DOM; the plugin
 * calls this again as they scroll in.
 */
export function decoratePreview(view: MarkdownView, marks: NoteMark[]) {
  const sections = previewSections(view);
  const path = view.file?.path;
  const scroller = view.previewMode.containerEl.querySelector<HTMLElement>(".markdown-preview-view");
  if (!sections || !path || !scroller) return;
  let overlay = scroller.querySelector<HTMLElement>(":scope > .sa-gm-overlay");
  if (!marks.length) return overlay?.remove();
  overlay ??= scroller.createDiv({ cls: "sa-root sa-gm-overlay" });
  overlay.empty();
  const origin = overlay.getBoundingClientRect();
  for (const m of marks) {
    const shown = sections.filter((s) => s.end.line >= m.lines[0] && s.start.line <= m.lines[1] && s.el.isConnected);
    if (!shown.length) continue;
    const first = shown[0].el.getBoundingClientRect();
    const last = shown[shown.length - 1].el.getBoundingClientRect();
    const el = markerEl(m, path, shown[0].start.line <= m.lines[0]);
    el.style.left = `${first.left - origin.left - markerX(m.lane)}px`;
    el.style.top = `${first.top - origin.top}px`;
    el.style.height = `${last.bottom - first.top}px`;
    overlay.append(el);
  }
}

/** The section of a reading view that holds this node, with its source range. */
export function sectionAt(view: MarkdownView, node: Node): { el: HTMLElement; lines: [number, number] } | null {
  const s = previewSections(view)?.find((x) => x.el.contains(node));
  return s ? { el: s.el, lines: [s.start.line, s.end.line] } : null;
}
