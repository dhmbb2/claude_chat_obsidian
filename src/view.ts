// Right-sidebar view: the main agent for the active note, plus the list of
// questions asked on it.
import { Component, ItemView, MarkdownRenderer, Menu, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { editorTurn, type Quote } from "./agent";
import { choicePicker, Composer, iconButton, thinking } from "./ui";
import type StudyAgentPlugin from "./main";
import type { ChatEntry } from "./main";

export const VIEW_TYPE = "study-agent";

const SUGGESTIONS = ["加一个具体的数值例子", "用更直观的比喻重写第 1 节", "把我的划线提问整理进正文", "在结尾补 3 道练习题"];

export class AgentView extends ItemView {
  ready = false;
  private file: TFile | null = null;
  private tab: "chat" | "threads" = "chat";
  private busyPath: string | null = null;
  private renderComponent = new Component();
  private titleEl!: HTMLElement;
  private moreBtn!: HTMLElement;
  private chatTab!: HTMLElement;
  private threadsTab!: HTMLElement;
  private chatPane!: HTMLElement;
  private logEl!: HTMLElement;
  private threadsEl!: HTMLElement;
  private composer!: Composer;
  private quotes: Quote[] = []; // passages quoted into the next message

  constructor(leaf: WorkspaceLeaf, private plugin: StudyAgentPlugin) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "学习助手";
  }
  getIcon() {
    return "graduation-cap";
  }

  onload() {
    // Obsidian does not always call onOpen for a sidebar view restored at startup
    // or rebuilt after the plugin reloads, so open it ourselves if it has not been.
    window.setTimeout(() => {
      if (!this.ready && this.containerEl.isConnected) this.onOpen();
    }, 0);
  }

  async onOpen() {
    if (this.ready) return;
    this.ready = true;
    const root = this.contentEl;
    root.empty();
    root.addClass("sa-root", "sa-view");

    const head = root.createDiv({ cls: "sa-view-head" });
    const titleRow = head.createDiv({ cls: "sa-view-title-row" });
    this.titleEl = titleRow.createDiv({ cls: "sa-view-title" });
    this.moreBtn = iconButton(titleRow, "more-horizontal", "更多", () => this.openMenu());
    const tabs = head.createDiv({ cls: "sa-tabs" });
    this.chatTab = tabs.createDiv({ cls: "sa-tab", text: "对话" });
    this.threadsTab = tabs.createDiv({ cls: "sa-tab" });
    this.chatTab.onclick = () => this.setTab("chat");
    this.threadsTab.onclick = () => this.setTab("threads");

    this.chatPane = root.createDiv({ cls: "sa-pane" });
    this.logEl = this.chatPane.createDiv({ cls: "sa-log" });
    const foot = this.chatPane.createDiv({ cls: "sa-view-foot" });
    this.composer = new Composer(foot, "让 Claude 修改这篇笔记…", () => this.send());
    const s = this.plugin.data.settings;
    choicePicker(
      this.composer.tools,
      () => ({ model: s.agentModel, effort: s.agentEffort }),
      (c) => {
        s.agentModel = c.model;
        s.agentEffort = c.effort;
        this.plugin.save();
      },
    );

    this.threadsEl = root.createDiv({ cls: "sa-pane sa-thread-list" });

    this.addChild(this.renderComponent);
    this.registerEvent(this.app.workspace.on("file-open", () => this.syncFile()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.syncFile()));
    this.file = null;
    this.syncFile();
    if (!this.file) this.render();
  }

  /** Follow the note the user is looking at. */
  syncFile() {
    if (!this.ready) return;
    const f = this.app.workspace.getActiveFile();
    const next = f && f.extension === "md" ? f : this.file && this.app.vault.getAbstractFileByPath(this.file.path) ? this.file : null;
    if (next !== this.file) {
      this.file = next;
      this.quotes = [];
      this.renderQuotes();
      this.render();
    } else {
      this.renderThreads();
    }
  }

  render() {
    this.titleEl.setText(this.file ? this.file.basename : "学习助手");
    this.renderChat();
    this.renderThreads();
    this.setTab(this.tab);
  }

  private setTab(tab: "chat" | "threads") {
    this.tab = tab;
    this.chatTab.toggleClass("is-active", tab === "chat");
    this.threadsTab.toggleClass("is-active", tab === "threads");
    this.chatPane.toggle(tab === "chat");
    this.threadsEl.toggle(tab === "threads");
  }

  private openMenu() {
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle("清空这篇笔记的对话")
        .setIcon("eraser")
        .setDisabled(!this.file || !this.plugin.data.chats[this.file.path]?.length)
        .onClick(() => this.clearChat()),
    );
    menu.addItem((i) => i.setTitle("新建学习指南").setIcon("graduation-cap").onClick(() => this.plugin.openNewGuide()));
    menu.addItem((i) => i.setTitle("插件设置").setIcon("settings").onClick(() => this.plugin.openSettings()));
    const r = this.moreBtn.getBoundingClientRect();
    menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
  }

  private renderChat() {
    this.renderComponent.unload();
    this.renderComponent = this.addChild(new Component());
    this.logEl.empty();
    const path = this.file?.path;
    this.composer.setDisabled(!this.file || this.busyPath !== null);
    if (!path) {
      this.greeting("打开一篇笔记", "学习助手会针对当前打开的笔记工作。");
      return;
    }
    const messages = this.plugin.data.chats[path] ?? [];
    const busyHere = this.busyPath === path;
    if (!messages.length && !busyHere) {
      const box = this.greeting("想怎么改这篇笔记？", "Claude 会直接编辑笔记，每次修改都可以撤销。");
      const chips = box.createDiv({ cls: "sa-chips" });
      for (const s of SUGGESTIONS) {
        const chip = chips.createDiv({ cls: "sa-chip", text: s });
        chip.onclick = () => {
          this.composer.value = s;
          this.send();
        };
      }
    }
    const undoable = this.undoableIndex(path);
    messages.forEach((m, i) => this.appendMessage(m, i === undoable));
    if (busyHere) thinking(this.logEl.createDiv({ cls: "sa-msg sa-assistant" }), "正在阅读并修改笔记");
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  /** The latest edit that the undo stack can still revert. */
  private undoableIndex(path: string): number {
    if (!this.plugin.data.undo[path]?.length) return -1;
    const msgs = this.plugin.data.chats[path] ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].edits && !msgs[i].undone) return i;
    return -1;
  }

  private appendMessage(m: ChatEntry, canUndo: boolean) {
    const row = this.logEl.createDiv({ cls: `sa-msg sa-${m.role}` });
    if (m.role === "user") {
      for (const q of m.quotes ?? []) row.createDiv({ cls: "sa-msg-quote", text: q.exact });
      row.createDiv({ cls: "sa-bubble", text: m.text });
      return;
    }
    const body = row.createDiv({ cls: "sa-prose markdown-rendered" });
    MarkdownRenderer.render(this.app, m.text, body, "", this.renderComponent);
    if (m.edits) {
      const pill = row.createDiv({ cls: `sa-change${m.undone ? " is-undone" : ""}` });
      setIcon(pill.createSpan({ cls: "sa-change-icon" }), m.undone ? "rotate-ccw" : "file-pen-line");
      pill.createSpan({ text: m.undone ? "已撤销这次修改" : `修改了笔记 ${m.edits} 处` });
      if (canUndo) pill.createSpan({ cls: "sa-change-undo", text: "撤销" }).onclick = () => this.undo();
    }
  }

  renderThreads() {
    if (!this.ready) return;
    const path = this.file?.path;
    const threads = path ? this.plugin.data.threads[path] ?? [] : [];
    this.threadsTab.empty();
    this.threadsTab.appendText("划线提问");
    if (threads.length) this.threadsTab.createSpan({ cls: "sa-count", text: String(threads.length) });
    this.threadsEl.empty();
    if (!threads.length) {
      const box = this.threadsEl.createDiv({ cls: "sa-greeting" });
      box.createDiv({ cls: "sa-greeting-title", text: "还没有划线提问" });
      box.createDiv({ cls: "sa-greeting-desc", text: "在笔记里选中一段文字，点「问 Claude」。问过的地方会留下灰色虚线，点一下就能回到这次对话。" });
      return;
    }
    for (const t of [...threads].reverse()) {
      const item = this.threadsEl.createDiv({ cls: "sa-thread" });
      item.createDiv({ cls: "sa-thread-quote", text: t.anchor.exact });
      const questions = t.messages.filter((m) => m.role === "user");
      item.createDiv({ cls: "sa-thread-q", text: questions.at(-1)?.text ?? "" });
      item.createDiv({ cls: "sa-thread-meta", text: `${questions.length} 个问题 · ${formatDate(t.createdAt)}` });
      item.onclick = () => this.plugin.revealThread(path!, t.id);
    }
  }

  private greeting(title: string, desc: string): HTMLElement {
    const box = this.logEl.createDiv({ cls: "sa-greeting" });
    setIcon(box.createDiv({ cls: "sa-greeting-spark" }), "sparkle");
    box.createDiv({ cls: "sa-greeting-title", text: title });
    box.createDiv({ cls: "sa-greeting-desc", text: desc });
    return box;
  }

  /** Quote a passage of the note into the next message. */
  addQuote(path: string, quote: Quote) {
    if (this.file?.path !== path) {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) return;
      this.file = f;
      this.quotes = [];
      this.render();
    }
    if (!this.quotes.some((q) => q.exact === quote.exact)) this.quotes.push(quote);
    this.renderQuotes();
    this.setTab("chat");
    this.composer.focus();
  }

  private renderQuotes() {
    const box = this.composer.attachments;
    box.empty();
    this.quotes.forEach((q, i) => {
      const chip = box.createDiv({ cls: "sa-quote-chip" });
      chip.createDiv({ cls: "sa-quote-chip-text", text: q.exact });
      iconButton(chip, "x", "移除这段引用", () => {
        this.quotes.splice(i, 1);
        this.renderQuotes();
      });
    });
  }

  private async send() {
    const file = this.file;
    const message = this.composer.value.trim();
    if (!file || !message || this.busyPath) return;
    const path = file.path;
    const chat = (this.plugin.data.chats[path] ??= []);
    const history = chat.slice();
    const quotes = this.quotes;
    chat.push({ role: "user", text: message, ...(quotes.length ? { quotes } : {}) });
    this.quotes = [];
    this.renderQuotes();
    this.composer.clear();
    this.busyPath = path;
    this.renderChat();

    const before = await this.app.vault.read(file);
    const s = this.plugin.data.settings;
    try {
      const { reply, edits } = await editorTurn(
        this.plugin.agentConfig(),
        { model: s.agentModel, effort: s.agentEffort },
        {
          note: before,
          history,
          threads: this.plugin.threadsDigest(path),
          message,
          quotes,
          ops: {
            edit: async (oldStr, newStr) => {
              let error: string | null = null;
              await this.app.vault.process(file, (data) => {
                const count = data.split(oldStr).length - 1;
                if (count === 1) return data.replace(oldStr, () => newStr);
                error =
                  count === 0 ? "old_str was not found in the current note. Copy it exactly." : `old_str appears ${count} times; include more context so it is unique.`;
                return data;
              });
              return error;
            },
            rewrite: async (content) => {
              await this.app.vault.modify(file, content);
            },
          },
        },
      );
      if (edits) this.plugin.pushUndo(path, before);
      chat.push({ role: "assistant", text: reply, ...(edits ? { edits } : {}) });
    } catch (err) {
      chat.pop();
      this.composer.value = message;
      this.quotes = quotes;
      this.renderQuotes();
      new Notice((err as Error).message, 8000);
    } finally {
      this.busyPath = null;
      await this.plugin.save();
      this.renderChat();
    }
  }

  private async undo() {
    const file = this.file;
    if (!file) return;
    const path = file.path;
    const index = this.undoableIndex(path);
    const snapshot = this.plugin.data.undo[path]?.pop();
    if (snapshot === undefined || index < 0) return;
    await this.app.vault.modify(file, snapshot);
    this.plugin.data.chats[path][index].undone = true;
    await this.plugin.save();
    this.renderChat();
  }

  private async clearChat() {
    if (!this.file || !confirm("清空和 Claude 关于这篇笔记的对话？（笔记和划线提问不受影响）")) return;
    delete this.plugin.data.chats[this.file.path];
    await this.plugin.save();
    this.renderChat();
  }
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
