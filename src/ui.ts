// Small UI pieces shared by the side-chat card, the sidebar and the dialog,
// styled after the Claude app (see styles.css).
import { setIcon, setTooltip } from "obsidian";
import type { Effort, ModelChoice } from "./agent";

// ---------- model / effort choices ----------

export interface Option<T> {
  value: T;
  label: string;
  desc?: string;
}

export const MODELS: Option<string>[] = [
  { value: "", label: "默认", desc: "跟随 Claude Code 的默认模型" },
  { value: "claude-opus-5-5", label: "Opus 5.5", desc: "最强，适合复杂的讲解与改写" },
  { value: "claude-sonnet-5-5", label: "Sonnet 5.5", desc: "速度与能力兼顾" },
  { value: "claude-haiku-5-5", label: "Haiku 5.5", desc: "最快，适合简单问题" },
];

export const EFFORTS: Option<Effort>[] = [
  { value: "low", label: "低", desc: "几乎不思考，回答最快" },
  { value: "medium", label: "中", desc: "适合大多数问题和修改" },
  { value: "high", label: "高", desc: "更仔细地推敲" },
  { value: "xhigh", label: "超高", desc: "复杂的推导和长篇改写" },
  { value: "max", label: "最高", desc: "不计时间和用量" },
];

export const modelLabel = (v: string) => MODELS.find((m) => m.value === v)?.label ?? v;
export const effortLabel = (v: Effort) => EFFORTS.find((e) => e.value === v)?.label ?? v;

// ---------- dropdown ----------

let openDropdown: HTMLElement | null = null;

export function closeDropdown() {
  openDropdown?.remove();
  openDropdown = null;
}

export interface DropdownSection<T> {
  title: string;
  options: Option<T>[];
  current: T;
  onPick: (v: T) => void;
}

/** A Claude-style menu: one or more titled lists of options, a check on each current one. */
export function showDropdown(anchor: HTMLElement, sections: DropdownSection<any>[]) {
  closeDropdown();
  const menu = document.body.createDiv({ cls: "sa-root sa-dropdown" });
  openDropdown = menu;
  for (const sec of sections) {
    menu.createDiv({ cls: "sa-dropdown-title", text: sec.title });
    for (const o of sec.options) {
      const item = menu.createDiv({ cls: `sa-dropdown-item${o.value === sec.current ? " is-selected" : ""}` });
      const text = item.createDiv({ cls: "sa-dropdown-text" });
      text.createDiv({ cls: "sa-dropdown-label", text: o.label });
      if (o.desc) text.createDiv({ cls: "sa-dropdown-desc", text: o.desc });
      setIcon(item.createDiv({ cls: "sa-dropdown-check" }), "check");
      item.onclick = (e) => {
        e.stopPropagation();
        closeDropdown();
        sec.onPick(o.value);
      };
    }
  }
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const above = r.top - h - 6 > 8;
  menu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
  menu.style.top = `${above ? r.top - h - 6 : Math.min(r.bottom + 6, window.innerHeight - h - 8)}px`;
  menu.addClass("is-open");
  // close on the next outside click
  window.setTimeout(() => {
    const away = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        closeDropdown();
        document.removeEventListener("mousedown", away, true);
      }
    };
    document.addEventListener("mousedown", away, true);
  }, 0);
}

/** One small "Opus 5.5 · 中 ⌄" button for both the model and the thinking effort. */
export function choicePicker(parent: HTMLElement, get: () => ModelChoice, set: (c: ModelChoice) => void): HTMLElement {
  const btn = parent.createDiv({ cls: "sa-picker", attr: { "aria-label": "模型与思考力度" } });
  const render = () => {
    const c = get();
    btn.empty();
    btn.createSpan({ text: `${modelLabel(c.model)} · ${effortLabel(c.effort)}` });
    setIcon(btn.createSpan({ cls: "sa-picker-chevron" }), "chevron-down");
  };
  render();
  btn.onclick = (e) => {
    e.stopPropagation();
    const c = get();
    showDropdown(btn, [
      { title: "模型", options: MODELS, current: c.model, onPick: (model: string) => (set({ ...get(), model }), render()) },
      { title: "思考力度", options: EFFORTS, current: c.effort, onPick: (effort: Effort) => (set({ ...get(), effort }), render()) },
    ]);
  };
  return btn;
}

// ---------- misc ----------

export function iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
  const btn = parent.createDiv({ cls: "sa-icon-btn", attr: { "aria-label": label } });
  setIcon(btn, icon);
  setTooltip(btn, label);
  btn.onclick = (e) => {
    e.stopPropagation();
    onClick();
  };
  return btn;
}

/** Claude-style "thinking" indicator: a pulsing spark and an optional label. */
export function thinking(parent: HTMLElement, label = "思考中") {
  const row = parent.createDiv({ cls: "sa-thinking" });
  setIcon(row.createSpan({ cls: "sa-spark" }), "sparkle");
  row.createSpan({ cls: "sa-thinking-label", text: label });
  return row;
}

/** Claude-style composer: auto-growing textarea, a row of pickers, and the send button. */
export class Composer {
  readonly el: HTMLElement;
  readonly tools: HTMLElement;
  /** Shown above the input, e.g. quoted passages; hidden while empty. */
  readonly attachments: HTMLElement;
  private input: HTMLTextAreaElement;
  private send: HTMLElement;

  constructor(parent: HTMLElement, placeholder: string, onSend: () => void, opts: { compact?: boolean } = {}) {
    this.el = parent.createDiv({ cls: `sa-composer${opts.compact ? " is-compact" : ""}` });
    this.attachments = this.el.createDiv({ cls: "sa-attachments" });
    this.input = this.el.createEl("textarea", { attr: { rows: "1", placeholder } });
    // compact: textarea, picker and send button share one row
    const row = opts.compact ? this.el : this.el.createDiv({ cls: "sa-composer-row" });
    this.tools = row.createDiv({ cls: "sa-composer-tools" });
    this.send = row.createDiv({ cls: "sa-send", attr: { "aria-label": "发送（Enter）" } });
    setIcon(this.send, "arrow-up");
    this.send.onclick = () => onSend();
    this.input.addEventListener("input", () => this.sync());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        onSend();
      }
    });
    this.el.addEventListener("mousedown", (e) => {
      if (e.target === this.el) {
        e.preventDefault();
        this.focus();
      }
    });
    this.sync();
  }

  get value() {
    return this.input.value;
  }
  set value(v: string) {
    this.input.value = v;
    this.sync();
  }
  clear() {
    this.value = "";
  }
  focus() {
    this.input.focus({ preventScroll: true });
  }
  setPlaceholder(text: string) {
    this.input.placeholder = text;
  }
  setBusy(busy: boolean) {
    this.el.toggleClass("is-busy", busy);
  }
  setDisabled(disabled: boolean) {
    this.input.disabled = disabled;
    this.el.toggleClass("is-disabled", disabled);
  }

  private sync() {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight, 200)}px`;
    this.send.toggleClass("is-empty", !this.input.value.trim());
  }
}
