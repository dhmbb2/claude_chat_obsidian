// The floating side-chat card: ask about a highlighted passage, or reopen
// the questions already asked about it from its left-margin marker. It can be moved (drag the
// top bar; double-click it to snap back next to the passage) and resized from
// its right / bottom edges; both are remembered.
import { Component, MarkdownRenderer, TFile } from "obsidian";
import { sideChatReply, type ChatMessage } from "./agent";
import type { Anchor } from "./anchors";
import { choicePicker, Composer, iconButton, thinking } from "./ui";
import type StudyAgentPlugin from "./main";

interface OpenState {
  path: string;
  threadId: string | null; // null until the first question is answered
  anchor: Anchor;
  fallback: { left: number; top: number; bottom: number } | null; // where the selection was
  orphan: boolean;
}

const MIN_W = 340;
const MIN_H = 220;

export class SideChat {
  readonly el: HTMLElement;
  private barEl: HTMLElement;
  private quoteEl: HTMLElement;
  private noticeEl: HTMLElement;
  private bodyEl: HTMLElement;
  private composer: Composer;
  private deleteBtn: HTMLElement;
  private state: OpenState | null = null;
  private component: Component | null = null;
  private busy = false;

  constructor(private plugin: StudyAgentPlugin) {
    this.el = document.body.createDiv({ cls: "sa-root sa-card" });
    this.el.hide();

    this.barEl = this.el.createDiv({ cls: "sa-card-bar", attr: { title: "拖动移动 · 双击贴回原文" } });
    this.quoteEl = this.barEl.createDiv({ cls: "sa-quote" });
    this.quoteEl.onclick = () => this.renderQuote(!this.quoteEl.hasClass("is-full"));
    this.deleteBtn = iconButton(this.barEl, "trash-2", "删除这条提问记录", () => this.deleteThread());
    iconButton(this.barEl, "x", "关闭（Esc）", () => this.close());
    this.makeMovable();

    this.noticeEl = this.el.createDiv({ cls: "sa-card-notice" });
    this.bodyEl = this.el.createDiv({ cls: "sa-card-body" });
    this.composer = new Composer(this.el.createDiv({ cls: "sa-card-foot" }), "问 Claude…", () => this.ask(), { compact: true });
    const s = plugin.data.settings;
    choicePicker(
      this.composer.tools,
      () => ({ model: s.sideModel, effort: s.sideEffort }),
      (c) => {
        s.sideModel = c.model;
        s.sideEffort = c.effort;
        plugin.save();
      },
    );
    for (const edge of ["e", "s", "se"] as const) this.makeResizable(this.el.createDiv({ cls: `sa-edge sa-edge-${edge}` }), edge);
  }

  get isOpen() {
    return this.state !== null;
  }

  /** Open on a selection that has no question yet and nothing typed. */
  get isIdle() {
    return !!this.state && !this.state.threadId && !this.busy && !this.composer.value.trim();
  }

  contains(node: Node) {
    return this.el.contains(node);
  }

  /** A fresh selection: mark it as pending and wait for the first question. */
  openNew(path: string, anchor: Anchor, fallback: OpenState["fallback"]) {
    this.close();
    this.state = { path, threadId: null, anchor, fallback, orphan: false };
    this.plugin.setPending({ path, anchor });
    this.render([]);
  }

  /** Reopen an existing thread next to its mark (or near the top if its passage is not on screen). */
  openThread(path: string, threadId: string) {
    const thread = this.plugin.getThread(path, threadId);
    if (!thread) return;
    this.close();
    const orphan = !this.marksFor(threadId).length;
    const state: OpenState = { path, threadId, anchor: thread.anchor, fallback: null, orphan };
    this.state = state;
    this.render(thread.messages);
    this.plugin.setActiveMark(threadId);
    // The passage may be mid re-render (e.g. right after an edit); look once more.
    if (orphan) {
      window.setTimeout(() => {
        if (this.state !== state || !this.marksFor(threadId).length) return;
        state.orphan = false;
        this.noticeEl.hide();
        this.plugin.setActiveMark(threadId);
        this.position();
      }, 500);
    }
  }

  close() {
    if (!this.state) return;
    if (!this.state.threadId) this.plugin.setPending(null);
    this.state = null;
    this.component?.unload();
    this.component = null;
    this.el.removeClass("is-open");
    this.el.hide();
    this.plugin.setActiveMark(null);
  }

  // ---------- size and place ----------

  /** Saved size; a card with no conversation yet only takes the height it needs. */
  private applySize(hasMessages: boolean) {
    const s = this.plugin.data.settings;
    const height = Math.min(s.sideHeight, window.innerHeight - 24);
    this.el.style.width = `${Math.min(s.sideWidth, window.innerWidth - 24)}px`;
    this.el.style.height = hasMessages ? `${height}px` : "";
    this.el.style.maxHeight = `${height}px`;
  }

  /** Where the user put it, or next to its passage; always kept inside the window. */
  position() {
    const s = this.state;
    if (!s) return;
    const settings = this.plugin.data.settings;
    const width = this.el.offsetWidth;
    const height = this.el.offsetHeight;
    let left: number;
    let top: number;
    // the passage's marker: one per block it spans in reading view
    const marks = s.threadId ? this.marksFor(s.threadId) : [];
    if (settings.sideLeft !== null && settings.sideTop !== null) {
      left = settings.sideLeft;
      top = settings.sideTop;
    } else if (marks.length) {
      const rects = marks.map((m) => m.getBoundingClientRect());
      const r = { left: Math.max(...rects.map((x) => x.right)) + 8, top: Math.min(...rects.map((x) => x.top)), bottom: Math.max(...rects.map((x) => x.bottom)) };
      left = r.left;
      top = r.bottom + 10;
      if (top + height > window.innerHeight - 12 && r.top - height - 10 > 12) top = r.top - height - 10;
    } else if (s.fallback) {
      left = s.fallback.left - width / 2;
      top = s.fallback.bottom + 10;
      if (top + height > window.innerHeight - 12 && s.fallback.top - height - 10 > 12) top = s.fallback.top - height - 10;
    } else {
      const r = (this.plugin.activeNoteView()?.contentEl ?? document.body).getBoundingClientRect();
      left = r.left + (r.width - width) / 2;
      top = r.top + 56;
    }
    this.el.style.left = `${Math.max(12, Math.min(left, window.innerWidth - width - 12))}px`;
    this.el.style.top = `${Math.max(12, Math.min(top, window.innerHeight - height - 12))}px`;
  }

  /** Drag the top bar to move the card; double-click it to snap back next to the passage. */
  private makeMovable() {
    this.barEl.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest(".sa-icon-btn") || e.button !== 0) return;
      const r = this.el.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      let moved = false;
      const move = (ev: PointerEvent) => {
        if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return;
        moved = true;
        this.el.addClass("is-dragging");
        const left = Math.max(12, Math.min(ev.clientX - dx, window.innerWidth - r.width - 12));
        const top = Math.max(12, Math.min(ev.clientY - dy, window.innerHeight - 40));
        this.el.style.left = `${left}px`;
        this.el.style.top = `${top}px`;
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        this.el.removeClass("is-dragging");
        if (!moved) return;
        // the click that ends a drag should not also toggle the quote
        const swallow = (ev: Event) => ev.stopPropagation();
        window.addEventListener("click", swallow, true);
        window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
        const s = this.plugin.data.settings;
        s.sideLeft = parseFloat(this.el.style.left);
        s.sideTop = parseFloat(this.el.style.top);
        this.plugin.save();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    this.barEl.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".sa-icon-btn")) return;
      const s = this.plugin.data.settings;
      s.sideLeft = null;
      s.sideTop = null;
      this.plugin.save();
      this.position();
    });
  }

  /** Drag the right edge, bottom edge or corner to resize. */
  private makeResizable(handle: HTMLElement, edge: "e" | "s" | "se") {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const start = { x: e.clientX, y: e.clientY, w: this.el.offsetWidth, h: this.el.offsetHeight };
      const r = this.el.getBoundingClientRect();
      this.el.addClass("is-dragging");
      const move = (ev: PointerEvent) => {
        if (edge !== "s") {
          const w = Math.max(MIN_W, Math.min(start.w + ev.clientX - start.x, window.innerWidth - r.left - 12));
          this.el.style.width = `${w}px`;
        }
        if (edge !== "e") {
          const h = Math.max(MIN_H, Math.min(start.h + ev.clientY - start.y, window.innerHeight - r.top - 12));
          this.el.style.height = `${h}px`;
          this.el.style.maxHeight = `${h}px`;
        }
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        this.el.removeClass("is-dragging");
        const s = this.plugin.data.settings;
        s.sideWidth = this.el.offsetWidth;
        if (edge !== "e") s.sideHeight = this.el.offsetHeight;
        this.plugin.save();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  private marksFor(threadId: string): HTMLElement[] {
    return visibleMarks(`.sa-gm[data-tid="${threadId}"]`);
  }

  // ---------- content ----------

  private render(messages: ChatMessage[]) {
    const s = this.state!;
    this.component?.unload();
    this.component = new Component();
    this.component.load();

    this.renderQuote(false);
    this.noticeEl.setText("这段原文现在不在屏幕上，或已经被修改过。");
    this.noticeEl.toggle(s.orphan);
    this.deleteBtn.toggle(!!s.threadId);
    this.bodyEl.empty();
    this.bodyEl.toggleClass("is-empty", !messages.length);
    for (const m of messages) this.renderMessage(m);
    this.composer.setPlaceholder(messages.length ? "继续追问…" : "就这段问 Claude…");
    this.composer.clear();

    this.el.show();
    this.el.addClass("is-open");
    this.applySize(messages.length > 0);
    this.position();
    this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
    this.composer.focus();
  }

  /** The passage: one line of its Markdown, or rendered in full (formulas and tables too) when expanded. */
  private renderQuote(full: boolean) {
    const s = this.state;
    if (!s) return;
    this.quoteEl.empty();
    this.quoteEl.toggleClass("is-full", full);
    if (full) MarkdownRenderer.render(this.plugin.app, s.anchor.exact, this.quoteEl.createDiv({ cls: "markdown-rendered" }), s.path, this.component!);
    else this.quoteEl.setText(s.anchor.exact.replace(/\s+/g, " "));
  }

  private renderMessage(m: ChatMessage): HTMLElement {
    if (this.bodyEl.hasClass("is-empty")) {
      // first message of a new thread: grow to the saved size
      this.bodyEl.removeClass("is-empty");
      this.applySize(true);
      this.position();
    }
    if (m.role === "user") {
      const row = this.bodyEl.createDiv({ cls: "sa-msg sa-user" });
      row.createDiv({ cls: "sa-bubble", text: m.text });
      return row;
    }
    const row = this.bodyEl.createDiv({ cls: "sa-msg sa-assistant" });
    const body = row.createDiv({ cls: "sa-prose markdown-rendered" });
    MarkdownRenderer.render(this.plugin.app, m.text, body, "", this.component!);
    return row;
  }

  private async ask() {
    const s = this.state;
    const question = this.composer.value.trim();
    if (!s || !question || this.busy) return;
    const file = this.plugin.app.vault.getAbstractFileByPath(s.path);
    if (!(file instanceof TFile)) return;
    this.busy = true;
    this.composer.clear();
    this.composer.setBusy(true);
    this.renderMessage({ role: "user", text: question });
    const pending = this.bodyEl.createDiv({ cls: "sa-msg sa-assistant" });
    thinking(pending);
    this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
    try {
      const settings = this.plugin.data.settings;
      const history = s.threadId ? this.plugin.getThread(s.path, s.threadId)!.messages : [];
      const reply = await sideChatReply(
        this.plugin.agentConfig(),
        { model: settings.sideModel, effort: settings.sideEffort },
        { note: await this.plugin.app.vault.cachedRead(file), quote: s.anchor.exact, history, question },
      );
      const turn: ChatMessage[] = [
        { role: "user", text: question },
        { role: "assistant", text: reply },
      ];
      if (s.threadId) {
        await this.plugin.appendToThread(s.path, s.threadId, turn);
      } else {
        const thread = await this.plugin.addThread(s.path, s.anchor, turn);
        // The pending marker becomes the thread's marker.
        s.threadId = thread.id;
        this.plugin.setPending(null);
        this.deleteBtn.show();
        this.plugin.setActiveMark(thread.id);
      }
      if (this.state !== s) return; // closed while waiting
      pending.remove();
      this.renderMessage(turn[1]);
      this.composer.setPlaceholder("继续追问…");
    } catch (err) {
      pending.empty();
      pending.createDiv({ cls: "sa-error", text: (err as Error).message });
      if (this.state === s) this.composer.value = question;
    } finally {
      this.busy = false;
      this.composer.setBusy(false);
      this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
    }
  }

  private async deleteThread() {
    const s = this.state;
    if (!s?.threadId || !confirm("删除这条提问记录？（笔记内容不受影响）")) return;
    const id = s.threadId;
    this.close();
    await this.plugin.deleteThread(s.path, id);
  }
}

/** Marks that are on screen. A note open in reading view keeps its hidden editor in the DOM, and vice versa. */
export function visibleMarks(selector: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((m) => m.getClientRects().length > 0);
}
