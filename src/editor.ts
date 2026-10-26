// Editing view (Live Preview / source): dashed marks as CodeMirror decorations,
// and turning an editor selection into an anchor.
import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, type Editor } from "obsidian";
import { anchorFromText, locateAnchor, type Anchor } from "./anchors";
import { plainIndex, project } from "./plaintext";

export const refreshMarks = StateEffect.define<null>();

export interface MarkSource {
  /** Threads (and a pending, not-yet-asked selection) to mark in this note. */
  marksFor(path: string): { id: string | null; anchor: Anchor }[];
}

export function marksExtension(source: MarkSource) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, source);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.transactions.some((t) => t.effects.some((e) => e.is(refreshMarks)))) {
          this.decorations = build(u.view, source);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

function build(view: EditorView, source: MarkSource): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const path = view.state.field(editorInfoField, false)?.file?.path;
  const marks = path ? source.marksFor(path) : [];
  if (!path || !marks.length) return builder.finish();

  const proj = project(view.state.doc.toString());
  const ranges: { from: number; to: number; deco: Decoration }[] = [];
  for (const m of marks) {
    const where = locateAnchor(proj.text, m.anchor);
    if (!where) continue;
    const deco = Decoration.mark({
      class: m.id ? "sa-mark" : "sa-mark sa-pending",
      attributes: m.id ? { "data-tid": m.id, "data-path": path, "aria-label": "查看提问记录" } : {},
    });
    ranges.push({ from: proj.toSrc[where.start], to: proj.toSrc[where.end - 1] + 1, deco });
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  for (const r of ranges) builder.add(r.from, r.to, r.deco);
  return builder.finish();
}

/** Anchor for source range [from, to) of a note, clipped to its first line, with context from that line. */
export function anchorFromSource(doc: string, from: number, to: number): { anchor: Anchor; endSrc: number } | null {
  const proj = project(doc);
  const start = plainIndex(proj, from);
  const lineStart = proj.text.lastIndexOf("\n", start - 1) + 1;
  const nl = proj.text.indexOf("\n", start);
  const lineEnd = nl === -1 ? proj.text.length : nl;
  const end = Math.min(plainIndex(proj, to), lineEnd);
  const anchor = end > start ? anchorFromText(proj.text, start, end, lineStart, lineEnd) : null;
  return anchor ? { anchor, endSrc: proj.toSrc[end - 1] + 1 } : null;
}

export function editorView(editor: Editor): EditorView | undefined {
  return (editor as unknown as { cm?: EditorView }).cm;
}

/** The editor's own selection (e.g. made with the keyboard) as an anchor, plus where to show the ask button. */
export function anchorFromEditor(editor: Editor): { anchor: Anchor; rect: { left: number; top: number; bottom: number } } | null {
  if (!editor.somethingSelected()) return null;
  const from = editor.posToOffset(editor.getCursor("from"));
  const to = editor.posToOffset(editor.getCursor("to"));
  const res = anchorFromSource(editor.getValue(), from, to);
  if (!res) return null;
  const coords = editorView(editor)?.coordsAtPos(res.endSrc);
  const rect = coords ? { left: coords.right, top: coords.top, bottom: coords.bottom } : { left: 0, top: 0, bottom: 0 };
  return { anchor: res.anchor, rect };
}

export function refreshAllEditors(views: EditorView[]) {
  for (const v of views) v.dispatch({ effects: refreshMarks.of(null) });
}
