import type { EditorView } from "@codemirror/view";
import { App, MarkdownView, Notice, Plugin, PluginSettingTab, setIcon, Setting } from "obsidian";
import { findClaude, type AgentConfig, type ChatMessage, type Effort } from "./agent";
import { anchorFromRange, blockOf, locateAnchor, markAnchor, unmark, type Anchor } from "./anchors";
import { anchorFromEditor, anchorFromSource, editorView, marksExtension, refreshAllEditors } from "./editor";
import { closeDropdown } from "./ui";
import { GuideJobs, type GuideJob } from "./jobs";
import { NewGuideModal } from "./modal";
import { project } from "./plaintext";
import { SideChat, visibleMarks } from "./sidechat";
import { AgentView, VIEW_TYPE } from "./view";

interface Settings {
  claudePath: string;
  guideFolder: string;
  // model ("" = Claude Code's default) and thinking effort, per place they are picked
  agentModel: string;
  agentEffort: Effort;
  sideModel: string;
  sideEffort: Effort;
  guideModel: string;
  guideEffort: Effort;
  // side-chat card: size, and where the user moved it (null = next to its passage)
  sideWidth: number;
  sideHeight: number;
  sideLeft: number | null;
  sideTop: number | null;
}

export interface Thread {
  id: string;
  anchor: Anchor;
  messages: ChatMessage[];
  createdAt: string;
}

export type ChatEntry = ChatMessage & { edits?: number; undone?: boolean };

interface PluginData {
  settings: Settings;
  threads: Record<string, Thread[]>; // by note path
  chats: Record<string, ChatEntry[]>; // main-agent conversation, by note path
  undo: Record<string, string[]>; // note content before each agent edit, by note path
  jobs: GuideJob[]; // study-guide generations, newest first
}

interface Selected {
  path: string;
  anchor: Anchor;
  block: HTMLElement | null; // reading view block; null in editing view
  rect: { left: number; top: number; bottom: number };
}

const DEFAULT_SETTINGS: Settings = {
  claudePath: "",
  guideFolder: "Study Guides",
  agentModel: "",
  agentEffort: "medium",
  sideModel: "",
  sideEffort: "low",
  guideModel: "",
  guideEffort: "high",
  sideWidth: 640,
  sideHeight: 640,
  sideLeft: null,
  sideTop: null,
};
const MAX_UNDO = 10;

export default class StudyAgentPlugin extends Plugin {
  data!: PluginData;
  jobs!: GuideJobs;
  private jobsStatus!: HTMLElement;
  private sideChat!: SideChat;
  private askBtn!: HTMLElement;
  private selection: Selected | null = null;
  private pending: { path: string; anchor: Anchor } | null = null; // editing-view selection awaiting its first question

  async onload() {
    const saved = (await this.loadData()) ?? {};
    this.data = {
      settings: { ...DEFAULT_SETTINGS, ...settingsFrom(saved.settings) },
      threads: saved.threads ?? {},
      chats: saved.chats ?? {},
      undo: saved.undo ?? {},
      jobs: GuideJobs.restore(saved.jobs),
    };
    this.jobs = new GuideJobs(this);
    if (!this.data.settings.claudePath) this.data.settings.claudePath = findClaude();

    this.registerView(VIEW_TYPE, (leaf) => new AgentView(leaf, this));
    this.addSettingTab(new SettingsTab(this.app, this));
    this.addRibbonIcon("graduation-cap", "新建学习指南", () => this.openNewGuide());
    this.addRibbonIcon("messages-square", "打开学习助手侧边栏", () => this.revealAgentView());
    this.addCommand({ id: "new-guide", name: "新建学习指南", callback: () => this.openNewGuide() });
    this.addCommand({ id: "open-agent", name: "打开学习助手侧边栏", callback: () => this.revealAgentView() });
    this.addCommand({ id: "show-jobs", name: "查看学习指南的生成进度", callback: () => this.showJobs() });

    // Status bar: how many guides are being written; click for the 生成 tab.
    this.jobsStatus = this.addStatusBarItem();
    this.jobsStatus.addClass("sa-root", "sa-jobs-status", "mod-clickable");
    this.jobsStatus.onclick = () => this.showJobs();
    this.renderJobsStatus();
    this.register(() => this.jobs.stopAll());
    this.addCommand({
      id: "ask-selection",
      name: "对选中文字提问",
      checkCallback: (checking) => {
        const sel = this.readSelection();
        if (checking) return !!sel;
        if (sel) this.ask(sel);
        return true;
      },
    });
    this.addCommand({
      id: "quote-selection",
      name: "引用选中文字到学习助手",
      checkCallback: (checking) => {
        const sel = this.readSelection();
        if (checking) return !!sel;
        if (sel) this.quoteToAgent(sel);
        return true;
      },
    });

    // Reading view: draw the dashed marks whenever a block of a note renders.
    this.registerMarkdownPostProcessor((el, ctx) => {
      const path = ctx.sourcePath;
      if (!this.data.threads[path]?.length) return;
      const apply = () => {
        for (const t of this.data.threads[path] ?? []) {
          if (el.querySelector(`.sa-mark[data-tid="${t.id}"]`)) continue;
          markAnchor(el, t.anchor, () => this.decorateMark(createSpan({ cls: "sa-mark" }), t.id, path));
        }
      };
      apply();
      // Callouts fill in their body after post-processors run, so look again shortly.
      window.setTimeout(apply, 0);
      window.setTimeout(apply, 300);
    });
    // Editing view: the same marks as editor decorations.
    this.registerEditorExtension(marksExtension(this));

    this.sideChat = new SideChat(this);
    // Selection toolbar: ask about the passage here, or quote it to the sidebar agent.
    this.askBtn = document.body.createDiv({ cls: "sa-root sa-ask" });
    const askHere = this.askBtn.createDiv({ cls: "sa-ask-btn", attr: { "aria-label": "就这段开一个划线提问" } });
    setIcon(askHere.createSpan({ cls: "sa-ask-icon" }), "sparkle");
    askHere.createSpan({ text: "问 Claude" });
    const quote = this.askBtn.createDiv({ cls: "sa-ask-btn", attr: { "aria-label": "引用到右侧学习助手的输入框" } });
    setIcon(quote.createSpan({ cls: "sa-ask-icon" }), "quote");
    quote.createSpan({ text: "引用" });
    this.askBtn.hide();
    this.register(() => {
      this.sideChat.close();
      this.sideChat.el.remove();
      this.askBtn.remove();
      closeDropdown();
      unmark(document.querySelectorAll<HTMLElement>(".sa-mark"));
    });
    this.askBtn.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
    askHere.addEventListener("click", () => {
      const sel = this.selection;
      this.hideAsk();
      if (sel) this.ask(sel);
    });
    quote.addEventListener("click", () => {
      const sel = this.selection;
      this.hideAsk();
      if (sel) this.quoteToAgent(sel);
    });

    this.registerDomEvent(document, "mouseup", (e) => window.setTimeout(() => this.onSelectionEnd(e.target as Node), 0));
    this.registerDomEvent(document, "keyup", (e) => {
      if (e.shiftKey || e.key === "Shift") this.onSelectionEnd(document.activeElement);
    });
    this.registerDomEvent(document, "mousedown", (e) => {
      const target = e.target as HTMLElement;
      if (!this.askBtn.contains(target)) this.hideAsk();
      // A conversation stays open while you read on; an unasked selection goes away.
      if (this.sideChat.isIdle && !this.sideChat.contains(target) && !target.closest?.(".sa-mark, .sa-thread, .sa-dropdown, .modal-container, .menu")) {
        this.sideChat.close();
      }
    });
    this.registerDomEvent(document, "click", (e) => {
      const mark = (e.target as HTMLElement).closest?.(".sa-mark[data-tid]") as HTMLElement | null;
      if (!mark || !window.getSelection()?.isCollapsed) return;
      this.sideChat.openThread(mark.dataset.path!, mark.dataset.tid!);
    });
    this.registerDomEvent(document, "mouseover", (e) => {
      const mark = (e.target as HTMLElement).closest?.(".sa-mark[data-tid]") as HTMLElement | null;
      document.querySelectorAll(".sa-mark.sa-hover").forEach((m) => m.removeClass("sa-hover"));
      if (mark) document.querySelectorAll(`.sa-mark[data-tid="${mark.dataset.tid}"]`).forEach((m) => m.addClass("sa-hover"));
    });
    this.registerDomEvent(document, "keydown", (e) => {
      if (e.key === "Escape" && this.sideChat.isOpen) this.sideChat.close();
    });
    this.registerDomEvent(document, "scroll", () => this.sideChat.position(), { capture: true });
    this.registerDomEvent(window, "resize", () => this.sideChat.position());

    // Keep per-note data attached to the note when it is renamed or deleted.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        for (const key of ["threads", "chats", "undo"] as const) {
          const table = this.data[key] as Record<string, unknown>;
          if (oldPath in table) {
            table[file.path] = table[oldPath];
            delete table[oldPath];
          }
        }
        this.jobs.notePathRenamed(oldPath, file.path);
        this.save();
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        delete this.data.threads[file.path];
        delete this.data.chats[file.path];
        delete this.data.undo[file.path];
        this.save();
      }),
    );

    // Notes already open were rendered before this plugin's marks existed.
    this.app.workspace.onLayoutReady(async () => {
      this.rerenderPreviews();
      this.refreshEditors();
      // A sidebar restored at startup is not always opened; make sure it is set up.
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        await leaf.loadIfDeferred();
        if (leaf.view instanceof AgentView && !leaf.view.ready) await leaf.view.onOpen();
      }
    });
  }

  async save() {
    await this.saveData(this.data);
  }

  agentConfig(): AgentConfig {
    return { claudePath: this.data.settings.claudePath };
  }

  openNewGuide() {
    new NewGuideModal(this).open();
  }

  openSettings() {
    const setting = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
    setting.open();
    setting.openTabById(this.manifest.id);
  }

  // ---------- threads ----------

  getThread(path: string, id: string) {
    return this.data.threads[path]?.find((t) => t.id === id);
  }

  async addThread(path: string, anchor: Anchor, messages: ChatMessage[]): Promise<Thread> {
    const thread: Thread = { id: Math.random().toString(36).slice(2, 10), anchor, messages, createdAt: new Date().toISOString() };
    (this.data.threads[path] ??= []).push(thread);
    await this.save();
    this.refreshEditors();
    this.refreshViews();
    return thread;
  }

  async appendToThread(path: string, id: string, messages: ChatMessage[]) {
    this.getThread(path, id)?.messages.push(...messages);
    await this.save();
    this.refreshViews();
  }

  async deleteThread(path: string, id: string) {
    this.data.threads[path] = (this.data.threads[path] ?? []).filter((t) => t.id !== id);
    unmark(document.querySelectorAll<HTMLElement>(`.markdown-reading-view .sa-mark[data-tid="${id}"]`));
    await this.save();
    this.refreshEditors();
    this.refreshViews();
  }

  threadsDigest(path: string): string {
    return (this.data.threads[path] ?? [])
      .map((t, i) => {
        const qa = t.messages.map((m) => `${m.role === "user" ? "Q" : "A"}: ${m.text}`).join("\n");
        return `[${i + 1}] passage: "${t.anchor.exact}"\n${qa}`;
      })
      .join("\n\n");
  }

  /** For the editor extension: what to mark in this note. */
  marksFor(path: string) {
    const marks: { id: string | null; anchor: Anchor }[] = (this.data.threads[path] ?? []).map((t) => ({ id: t.id, anchor: t.anchor }));
    if (this.pending?.path === path) marks.push({ id: null, anchor: this.pending.anchor });
    return marks;
  }

  setPending(p: { path: string; anchor: Anchor } | null) {
    if (!p && !this.pending) return;
    this.pending = p;
    this.refreshEditors();
  }

  pushUndo(path: string, content: string) {
    const stack = (this.data.undo[path] ??= []);
    stack.push(content);
    if (stack.length > MAX_UNDO) stack.shift();
  }

  decorateMark(span: HTMLElement, threadId: string, path: string): HTMLElement {
    span.dataset.tid = threadId;
    span.dataset.path = path;
    span.setAttr("aria-label", "查看提问记录");
    return span;
  }

  setActiveMark(threadId: string | null) {
    document.querySelectorAll(".sa-mark.sa-active").forEach((m) => m.removeClass("sa-active"));
    if (threadId) document.querySelectorAll(`.sa-mark[data-tid="${threadId}"]`).forEach((m) => m.addClass("sa-active"));
  }

  /** From the sidebar list: bring the passage on screen and open its thread. */
  async revealThread(path: string, id: string) {
    const selector = `.sa-mark[data-tid="${id}"]`;
    let mark = visibleMarks(selector)[0];
    // The sidebar has focus here, so find the note's own view rather than the active one.
    const view = this.app.workspace
      .getLeavesOfType("markdown")
      .map((l) => l.view)
      .find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === path);
    const thread = this.getThread(path, id);
    if (!mark && thread && view?.file?.path === path) {
      // Not rendered yet (both views only render near the viewport): scroll to its line first.
      const src = view.getViewData();
      const proj = project(src);
      const where = locateAnchor(proj.text, thread.anchor);
      if (where) {
        const line = src.slice(0, proj.toSrc[where.start]).split("\n").length - 1;
        if (view.getMode() === "preview") view.previewMode.applyScroll(Math.max(0, line - 3));
        else view.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
        for (let i = 0; i < 10 && !mark; i++) {
          await sleep(100);
          mark = visibleMarks(selector)[0];
        }
      }
    }
    mark?.scrollIntoView({ block: "center" });
    window.setTimeout(() => this.sideChat.openThread(path, id), mark ? 150 : 0);
  }

  // ---------- selection ----------

  activeNoteView(): MarkdownView | null {
    return this.app.workspace.getActiveViewOfType(MarkdownView);
  }

  /** The current selection in the active note, in either reading or editing view. */
  private readSelection(): Selected | null {
    const view = this.activeNoteView();
    if (!view?.file) return null;
    const path = view.file.path;

    const domSel = window.getSelection();
    const range = domSel && !domSel.isCollapsed && domSel.rangeCount ? domSel.getRangeAt(0) : null;
    const onScreen = range && view.contentEl.contains(range.commonAncestorContainer) ? range : null;

    if (view.getMode() === "source") {
      if (!onScreen) {
        // keyboard selection that the DOM does not mirror
        const sel = anchorFromEditor(view.editor);
        return sel ? { path, anchor: sel.anchor, block: null, rect: sel.rect } : null;
      }
      // Live Preview draws callouts, tables and embeds as rendered widgets: a selection
      // there is in rendered text, so anchor it like reading view does.
      const widget = onScreen.startContainer.parentElement?.closest<HTMLElement>(".cm-content [contenteditable=false]");
      if (widget) return this.fromRenderedRange(path, widget, onScreen);
      const cm = editorView(view.editor);
      if (!cm) return null;
      const res = anchorFromSource(
        view.editor.getValue(),
        cm.posAtDOM(onScreen.startContainer, onScreen.startOffset),
        cm.posAtDOM(onScreen.endContainer, onScreen.endOffset),
      );
      return res ? { path, anchor: res.anchor, block: null, rect: lastRect(onScreen) } : null;
    }

    if (!onScreen) return null;
    const block = blockOf(onScreen.startContainer);
    return block ? this.fromRenderedRange(path, block, onScreen) : null;
  }

  /** A selection in rendered text (a reading-view block or a Live Preview widget). */
  private fromRenderedRange(path: string, block: HTMLElement, range: Range): Selected | null {
    // A question is about one block; clip a selection that runs past it.
    const clipped = range.cloneRange();
    if (!block.contains(range.endContainer)) clipped.setEnd(block, block.childNodes.length);
    const anchor = anchorFromRange(block, clipped);
    return anchor ? { path, anchor, block, rect: lastRect(clipped) } : null;
  }

  private onSelectionEnd(target: Node | null) {
    const view = this.activeNoteView();
    if (!target || !view || !view.contentEl.contains(target)) return this.hideAsk();
    const sel = this.readSelection();
    if (!sel) return this.hideAsk();
    this.selection = sel;
    this.askBtn.show();
    const w = this.askBtn.offsetWidth;
    this.askBtn.style.left = `${Math.max(12, Math.min(sel.rect.left - w / 2, window.innerWidth - w - 12))}px`;
    this.askBtn.style.top = `${sel.rect.bottom + 8}px`;
    this.askBtn.removeClass("is-visible");
    void this.askBtn.offsetWidth; // restart the entrance animation
    this.askBtn.addClass("is-visible");
  }

  private ask(sel: Selected) {
    window.getSelection()?.removeAllRanges();
    if (!sel.block) {
      // collapse the editor selection so the pending mark is visible
      const editor = this.activeNoteView()?.editor;
      editor?.setCursor(editor.getCursor("to"));
    }
    this.sideChat.openNew(sel.path, sel.anchor, sel.block, sel.rect);
  }

  private async quoteToAgent(sel: Selected) {
    window.getSelection()?.removeAllRanges();
    const editor = sel.block ? null : this.activeNoteView()?.editor;
    editor?.setCursor(editor.getCursor("to"));
    await this.revealAgentView();
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    if (view instanceof AgentView) {
      if (!view.ready) await view.onOpen();
      view.addQuote(sel.path, sel.anchor);
    }
  }

  private hideAsk() {
    this.askBtn.hide();
    this.askBtn.removeClass("is-visible");
  }

  // ---------- views ----------

  private editorViews(): EditorView[] {
    const views: EditorView[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const cm = leaf.view instanceof MarkdownView ? (leaf.view.editor as unknown as { cm?: EditorView }).cm : undefined;
      if (cm) views.push(cm);
    }
    return views;
  }

  refreshEditors() {
    refreshAllEditors(this.editorViews());
  }

  private rerenderPreviews() {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView && leaf.view.getMode() === "preview") leaf.view.previewMode.rerender(true);
    }
  }

  refreshViews() {
    // A sidebar leaf that has never been shown holds a deferred placeholder view.
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (leaf.view instanceof AgentView) leaf.view.renderThreads();
  }

  // ---------- guide generation ----------

  /** Redraw everything that shows generation jobs. */
  refreshJobs() {
    this.renderJobsStatus();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (leaf.view instanceof AgentView) leaf.view.renderJobs();
  }

  private renderJobsStatus() {
    const n = this.jobs.runningCount;
    this.jobsStatus.toggle(n > 0);
    this.jobsStatus.empty();
    if (!n) return;
    setIcon(this.jobsStatus.createSpan({ cls: "sa-spark" }), "sparkle");
    this.jobsStatus.createSpan({ text: `正在生成 ${n} 篇学习指南` });
  }

  async showJobs() {
    await this.revealAgentView();
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    if (view instanceof AgentView) view.showJobs();
  }

  async revealAgentView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE });
    }
    this.app.workspace.revealLeaf(leaf);
  }
}

function lastRect(range: Range) {
  const rects = range.getClientRects();
  const r = rects[rects.length - 1] ?? range.getBoundingClientRect();
  return { left: r.right, top: r.top, bottom: r.bottom };
}

/** Saved settings, carrying the old single `model` setting over to the per-place pickers. */
function settingsFrom(saved: (Partial<Settings> & { model?: string }) | undefined): Partial<Settings> {
  if (!saved) return {};
  const { model, ...rest } = saved;
  return model ? { agentModel: model, sideModel: model, guideModel: model, ...rest } : rest;
}

class SettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: StudyAgentPlugin) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.data.settings;
    containerEl.empty();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "通过 Claude Agent SDK 调用本机的 claude 命令行，使用你的 Claude Code 登录（Pro/Max 套餐）。第一次使用前在终端运行 `claude auth login`。模型和思考力度在各个输入框下方切换，会分别记住。",
    });

    new Setting(containerEl)
      .setName("claude 命令行路径")
      .setDesc("终端运行 `which claude` 可以查到。")
      .addText((t) =>
        t
          .setPlaceholder("/Users/you/.local/bin/claude")
          .setValue(s.claudePath)
          .onChange(async (v) => {
            s.claudePath = v.trim();
            await this.plugin.save();
          }),
      )
      .addButton((b) =>
        b.setButtonText("自动检测").onClick(async () => {
          s.claudePath = findClaude();
          await this.plugin.save();
          new Notice(s.claudePath ? `找到：${s.claudePath}` : "没找到 claude，请手动填写路径。");
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("学习指南文件夹")
      .setDesc("新生成的指南保存到这里。")
      .addText((t) =>
        t.setValue(s.guideFolder).onChange(async (v) => {
          s.guideFolder = v.trim();
          await this.plugin.save();
        }),
      );
  }
}
