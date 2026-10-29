// Editing view (Live Preview / source): the left-margin markers, drawn as a
// CodeMirror layer from line-block geometry, so a passage that runs through a
// rendered table, formula or callout is covered just like plain lines.
import { StateEffect } from "@codemirror/state";
import { EditorView, layer, type LayerMarker, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, type Editor } from "obsidian";
import { markerEl, markerX, type MarkSource, type NoteMark } from "./marks";

export const refreshMarks = StateEffect.define<null>();

class Marker implements LayerMarker {
  constructor(
    readonly mark: NoteMark,
    readonly path: string,
    readonly left: number,
    readonly top: number,
    readonly height: number,
  ) {}

  draw() {
    const el = markerEl(this.mark, this.path, true);
    this.place(el);
    return el;
  }

  update(el: HTMLElement, prev: Marker) {
    if (prev.mark.id !== this.mark.id || prev.mark.state !== this.mark.state || prev.path !== this.path) return false;
    this.place(el);
    return true;
  }

  eq(o: Marker) {
    return (
      o.mark.id === this.mark.id &&
      o.mark.state === this.mark.state &&
      o.path === this.path &&
      o.left === this.left &&
      o.top === this.top &&
      o.height === this.height
    );
  }

  private place(el: HTMLElement) {
    el.style.left = `${this.left}px`;
    el.style.top = `${this.top}px`;
    el.style.height = `${this.height}px`;
  }
}

export function marksExtension(source: MarkSource) {
  return layer({
    above: true,
    class: "sa-gm-layer", // one class: CodeMirror passes it to classList.add
    update: (u: ViewUpdate) =>
      u.docChanged ||
      u.viewportChanged ||
      u.geometryChanged ||
      u.heightChanged ||
      u.transactions.some((t) => t.effects.some((e) => e.is(refreshMarks))),
    markers(view: EditorView) {
      const path = view.state.field(editorInfoField, false)?.file?.path;
      if (!path) return [];
      const marks = source.marksFor(path, view.state.doc.toString());
      if (!marks.length) return [];
      // Layer coordinates start at the scroller's scrolled content origin.
      const scroller = view.scrollDOM.getBoundingClientRect();
      const baseLeft = scroller.left - view.scrollDOM.scrollLeft;
      const baseTop = scroller.top - view.scrollDOM.scrollTop;
      const contentLeft = view.contentDOM.getBoundingClientRect().left;
      return marks.map((m) => {
        const first = view.lineBlockAt(m.from);
        const last = view.lineBlockAt(Math.max(m.from, m.to - 1));
        const top = view.documentTop + first.top - baseTop;
        return new Marker(m, path, contentLeft - baseLeft - markerX(m.lane), top, view.documentTop + last.bottom - baseTop - top);
      });
    },
  });
}

export function editorView(editor: Editor): EditorView | undefined {
  return (editor as unknown as { cm?: EditorView }).cm;
}

export function refreshAllEditors(views: EditorView[]) {
  for (const v of views) v.dispatch({ effects: refreshMarks.of(null) });
}
