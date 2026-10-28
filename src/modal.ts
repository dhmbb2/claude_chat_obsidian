// "New study guide" dialog: a topic / pasted text / link, optionally with the
// open note or PDF as material. Generation runs as a background job (jobs.ts).
import { Modal, setIcon, TFile } from "obsidian";
import { choicePicker, Composer } from "./ui";
import type StudyAgentPlugin from "./main";

const MATERIAL_EXTENSIONS = ["md", "txt", "pdf"];

export class NewGuideModal extends Modal {
  constructor(private plugin: StudyAgentPlugin) {
    super(plugin.app);
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass("sa-root", "sa-new-modal");
    const hero = contentEl.createDiv({ cls: "sa-new-hero" });
    setIcon(hero.createDiv({ cls: "sa-greeting-spark" }), "sparkle");
    hero.createDiv({ cls: "sa-new-title", text: "今天想学点什么？" });
    hero.createDiv({ cls: "sa-new-desc", text: "写一个主题，或者粘贴一段文字、一个链接，Claude 会整理成一篇循序渐进的学习笔记。" });

    const s = this.plugin.data.settings;
    const composer = new Composer(contentEl, "例如：Model Predictive Control，面向有控制基础的研究生，重点讲 QP 形式和滚动时域", () => this.generate(composer, status, useMaterial ? material : null));
    composer.el.addClass("sa-new-composer");
    choicePicker(
      composer.tools,
      () => ({ model: s.guideModel, effort: s.guideEffort }),
      (c) => {
        s.guideModel = c.model;
        s.guideEffort = c.effort;
        this.plugin.save();
      },
    );

    const options = contentEl.createDiv({ cls: "sa-new-options" });
    const active = this.app.workspace.getActiveFile();
    const material = active && MATERIAL_EXTENSIONS.includes(active.extension) ? active : null;
    let useMaterial = false;
    if (material) {
      const chip = options.createDiv({ cls: "sa-attach" });
      setIcon(chip.createSpan({ cls: "sa-attach-icon" }), material.extension === "pdf" ? "file-text" : "file");
      chip.createSpan({ text: `用「${material.basename}」作为材料` });
      chip.onclick = () => {
        useMaterial = !useMaterial;
        chip.toggleClass("is-on", useMaterial);
      };
    }
    options.createDiv({ cls: "sa-new-folder", text: `保存到 ${s.guideFolder || "/"} · 在侧边栏「生成」里看进度` });

    const status = contentEl.createDiv({ cls: "sa-new-status" });
    composer.focus();
  }

  /** Hand the request to a background job; its progress shows in the sidebar's 生成 tab. */
  private generate(composer: Composer, status: HTMLElement, material: TFile | null) {
    const request = composer.value;
    if (!request.trim() && !material) {
      status.setText("先写一个主题，或者选上「作为材料」。");
      status.addClass("is-error");
      composer.focus();
      return;
    }
    const s = this.plugin.data.settings;
    this.plugin.jobs.start(request, material, { model: s.guideModel, effort: s.guideEffort });
    this.close();
    this.plugin.showJobs();
  }

  onClose() {
    this.contentEl.empty();
  }
}
