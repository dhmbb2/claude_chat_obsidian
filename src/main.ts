import type { EditorView } from "@codemirror/view";
import { App, debounce, MarkdownView, Notice, Plugin, PluginSettingTab, setIcon, Setting } from "obsidian";
import { findClaude, type AgentConfig, type ChatMessage, type Effort } from "./agent";
import { lineOf, lineSpan, locate, sourceAnchor, sourceOffsetIn, type Anchor, type SourceRange } from "./anchors";
import { editorView, marksExtension, refreshAllEditors } from "./editor";
import { closeDropdown } from "./ui";
import { GuideJobs, type GuideJob } from "./jobs";
import { decoratePreview, layoutMarks, previewSections, sectionAt, type NoteMark } from "./marks";
import { NewGuideModal } from "./modal";
import { project, type Projection } from "./plaintext";
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
  inEditor: boolean;
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
  private pending: { path: string; anchor: Anchor } | null = null; // selection awaiting its first question
  private activeThread: string | null = null; // thread open in the side chat
  private anchorsUpgraded = false;

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

    // Reading view: put the left-margin markers back whenever blocks of a note render.
    this.registerMarkdownPostProcessor((_el, ctx) => {
      if (this.data.threads[ctx.sourcePath]?.length || this.pending?.path === ctx.sourcePath) this.decorateSoon();
    });
    this.registerEvent(this.app.workspace.on("layout-change", () => this.decorateSoon()));
    // Editing view: the same markers as a CodeMirror layer.
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
      document.querySelectorAll(".sa-gm").forEach((m) => m.remove());
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
      if (this.sideChat.isIdle && !this.sideChat.contains(target) && !target.closest?.(".sa-gm, .sa-thread, .sa-dropdown, .modal-container, .menu")) {
        this.sideChat.close();
      }
    });
    // A marker is not text: keep the editor from moving the cursor or starting a selection on it.
    this.registerDomEvent(
      document,
      "mousedown",
      (e) => {
        if (!(e.target as HTMLElement).closest?.(".sa-gm[data-tid]")) return;
        e.preventDefault();
        e.stopPropagation();
      },
      { capture: true },
    );
    this.registerDomEvent(document, "click", (e) => {
      const mark = (e.target as HTMLElement).closest?.(".sa-gm[data-tid]") as HTMLElement | null;
      if (!mark) return;
      e.stopPropagation();
      this.sideChat.openThread(mark.dataset.path!, mark.dataset.tid!);
    });
    this.registerDomEvent(document, "mouseover", (e) => {
      const mark = (e.target as HTMLElement).closest?.(".sa-gm[data-tid]") as HTMLElement | null;
      document.querySelectorAll(".sa-gm.is-hover").forEach((m) => m.removeClass("is-hover"));
      if (mark) document.querySelectorAll(`.sa-gm[data-tid="${mark.dataset.tid}"]`).forEach((m) => m.addClass("is-hover"));
    });
    this.registerDomEvent(document, "keydown", (e) => {
      if (e.key === "Escape" && this.sideChat.isOpen) this.sideChat.close();
    });
    this.registerDomEvent(
      document,
      "scroll",
      (e) => {
        this.sideChat.position();
        // reading view attaches blocks as they scroll in; extend the markers to them
        if ((e.target as HTMLElement).closest?.(".markdown-reading-view")) this.decorateSoon();
      },
      { capture: true },
    );
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
      this.refreshMarks();
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
    this.refreshMarks();
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
    await this.save();
    this.refreshMarks();
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

  /** What to mark in this note: its threads, plus a selection waiting for its first question. */
  marksFor(path: string, doc: string): NoteMark[] {
    let proj: Projection | undefined;
    const lazyProj = () => (proj ??= project(doc));
    const found: Parameters<typeof layoutMarks>[1] = [];
    for (const t of this.data.threads[path] ?? []) {
      const range = locate(doc, t.anchor, lazyProj);
      if (!range) continue;
      if (t.anchor.v !== 2) {
        // saved by an older version (rendered text): store it as source from now on
        const upgraded = sourceAnchor(doc, range.from, range.to);
        if (upgraded) {
          t.anchor = upgraded.anchor;
          this.anchorsUpgraded = true;
          this.saveUpgradedSoon();
        }
      }
      found.push({ ...range, id: t.id, state: t.id === this.activeThread ? "active" : "" });
    }
    if (this.pending?.path === path) {
      const range = locate(doc, this.pending.anchor);
      if (range) found.push({ ...range, id: null, state: "pending" });
    }
    return layoutMarks(doc, found);
  }

  private saveUpgradedSoon = debounce(() => {
    if (!this.anchorsUpgraded) return;
    this.anchorsUpgraded = false;
    this.save();
  }, 2000);

  setPending(p: { path: string; anchor: Anchor } | null) {
    if (!p && !this.pending) return;
    this.pending = p;
    this.refreshMarks();
  }

  pushUndo(path: string, content: string) {
    const stack = (this.data.undo[path] ??= []);
    stack.push(content);
    if (stack.length > MAX_UNDO) stack.shift();
  }

  setActiveMark(threadId: string | null) {
    if (this.activeThread === threadId) return;
    this.activeThread = threadId;
    this.refreshMarks();
  }

  /** From the sidebar list: bring the passage on screen and open its thread. */
  async revealThread(path: string, id: string) {
    const selector = `.sa-gm[data-tid="${id}"]`;
    let mark = visibleMarks(selector)[0];
    // The sidebar has focus here, so find the note's own view rather than the active one.
    const view = this.app.workspace
      .getLeavesOfType("markdown")
      .map((l) => l.view)
      .find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === path);
    const thread = this.getThread(path, id);
    if (!mark && thread && view) {
      // Not rendered yet (both views only render near the viewport): scroll to its line first.
      const src = view.getViewData();
      const where = locate(src, thread.anchor);
      if (where) {
        const line = lineOf(src, where.from);
        if (view.getMode() === "preview") view.previewMode.applyScroll(Math.max(0, line - 3));
        else view.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
        for (let i = 0; i < 10 && !mark; i++) {
          await sleep(100);
          this.decoratePreviews();
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

  /**
   * The current selection in the active note, in either reading or editing view,
   * as a range of the note's Markdown. A selection that runs through formulas,
   * tables or callouts takes in their source too.
   */
  private readSelection(): Selected | null {
    const view = this.activeNoteView();
    if (!view?.file) return null;
    const path = view.file.path;
    const doc = view.getViewData();
    let proj: Projection | undefined;
    const lazyProj = () => (proj ??= project(doc));

    const domSel = window.getSelection();
    const range = domSel && !domSel.isCollapsed && domSel.rangeCount ? domSel.getRangeAt(0) : null;
    const onScreen = range && view.contentEl.contains(range.commonAncestorContainer) ? range : null;
    let from: number | null;
    let to: number | null;
    let rect = onScreen ? lastRect(onScreen) : { left: 0, top: 0, bottom: 0 };

    if (view.getMode() === "source") {
      const cm = editorView(view.editor);
      if (!onScreen || !cm) {
        // keyboard selection that the DOM does not mirror
        if (!view.editor.somethingSelected()) return null;
        from = view.editor.posToOffset(view.editor.getCursor("from"));
        to = view.editor.posToOffset(view.editor.getCursor("to"));
        const c = cm?.coordsAtPos(to);
        if (c) rect = { left: c.right, top: c.top, bottom: c.bottom };
      } else {
        from = editorOffset(cm, lazyProj, onScreen.startContainer, onScreen.startOffset, "start");
        to = editorOffset(cm, lazyProj, onScreen.endContainer, onScreen.endOffset, "end");
      }
    } else {
      if (!onScreen) return null;
      from = previewOffset(view, doc, lazyProj, onScreen, "start");
      to = previewOffset(view, doc, lazyProj, onScreen, "end");
    }
    if (from === null || to === null) return null;
    const res = sourceAnchor(doc, Math.min(from, to), Math.max(from, to));
    return res ? { path, anchor: res.anchor, inEditor: view.getMode() === "source", rect } : null;
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
    this.clearSelection(sel);
    this.sideChat.openNew(sel.path, sel.anchor, sel.rect);
  }

  private async quoteToAgent(sel: Selected) {
    this.clearSelection(sel);
    await this.revealAgentView();
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    if (view instanceof AgentView) {
      if (!view.ready) await view.onOpen();
      view.addQuote(sel.path, sel.anchor);
    }
  }

  /** Drop the text selection once it has been used, so the marker shows. */
  private clearSelection(sel: Selected) {
    window.getSelection()?.removeAllRanges();
    const editor = sel.inEditor ? this.activeNoteView()?.editor : null;
    editor?.setCursor(editor.getCursor("to"));
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

  /** Redraw the markers in every open note, in both views. */
  refreshMarks() {
    refreshAllEditors(this.editorViews());
    this.decoratePreviews();
  }

  private decoratePreviews() {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.getMode() !== "preview" || !view.file) continue;
      decoratePreview(view, this.marksFor(view.file.path, view.getViewData()));
    }
  }

  private decorateSoon = debounce(() => this.decoratePreviews(), 60);

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

/** Source offset of a selection endpoint in the editor. */
function editorOffset(cm: EditorView, proj: () => Projection, node: Node, offset: number, side: "start" | "end"): number {
  // Live Preview draws formulas, tables and callouts as widgets; find the outermost one around the endpoint.
  let widget: HTMLElement | null = null;
  for (let el = node instanceof HTMLElement ? node : node.parentElement; el && el !== cm.contentDOM; el = el.parentElement) {
    if (el.contentEditable === "false") widget = el;
  }
  if (!widget) return cm.posAtDOM(node, offset);
  const line = widget.closest<HTMLElement>(".cm-line");
  if (line) {
    // an inline widget (formula) inside an ordinary line
    const l = cm.state.doc.lineAt(cm.posAtDOM(line, 0));
    return sourceOffsetIn(line, { from: l.from, to: l.to }, proj(), node, offset, side);
  }
  // a block widget: map within the source it renders
  const start = cm.posAtDOM(widget, 0);
  const block = cm.lineBlockAt(start);
  const range = { from: Math.min(block.from, start), to: Math.max(block.to, cm.posAtDOM(widget, widget.childNodes.length)) };
  return sourceOffsetIn(widget, range, proj(), node, offset, side);
}

/** Source offset of a selection endpoint in reading view. */
function previewOffset(view: MarkdownView, doc: string, proj: () => Projection, range: Range, side: "start" | "end"): number | null {
  const node = side === "start" ? range.startContainer : range.endContainer;
  const offset = side === "start" ? range.startOffset : range.endOffset;
  const section = sectionAt(view, node);
  if (section) return sourceOffsetIn(section.el, lineSpan(doc, ...section.lines), proj(), node, offset, side);
  // The endpoint is between blocks: use the first / last block the selection touches.
  const touched = (previewSections(view) ?? []).filter((s) => s.el.isConnected && range.intersectsNode(s.el));
  const s = side === "start" ? touched[0] : touched[touched.length - 1];
  if (!s) return null;
  const span: SourceRange = lineSpan(doc, s.start.line, s.end.line);
  return side === "start" ? span.from : span.to;
}

/** Where the selection ends (for the toolbar), and where it starts vertically (so the card can sit above all of it). */
function lastRect(range: Range) {
  const rects = range.getClientRects();
  const whole = range.getBoundingClientRect();
  const r = rects[rects.length - 1] ?? whole;
  return { left: r.right, top: whole.top, bottom: r.bottom };
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
