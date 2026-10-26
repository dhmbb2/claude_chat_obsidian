// "New study guide" dialog: a topic / pasted text / link, optionally with the
// open note or PDF as material. The result is saved as a normal Markdown note.
import { Modal, Notice, normalizePath, setIcon, TFile } from "obsidian";
import { generateGuide, type GuideSource } from "./agent";
import { choicePicker, Composer, thinking } from "./ui";
import type StudyAgentPlugin from "./main";

const MATERIAL_EXTENSIONS = ["md", "txt", "pdf"];

export class NewGuideModal extends Modal {
  private busy = false;

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
    options.createDiv({ cls: "sa-new-folder", text: `保存到 ${s.guideFolder || "/"}` });

    const status = contentEl.createDiv({ cls: "sa-new-status" });
    composer.focus();
  }

  private async generate(composer: Composer, status: HTMLElement, material: TFile | null) {
    const request = composer.value;
    if (this.busy) return;
    if (!request.trim() && !material) {
      status.setText("先写一个主题，或者选上「作为材料」。");
      status.addClass("is-error");
      composer.focus();
      return;
    }
    this.busy = true;
    composer.setBusy(true);
    status.removeClass("is-error");
    status.empty();
    const row = thinking(status, "");
    const label = row.querySelector(".sa-thinking-label")!;
    const started = Date.now();
    const tick = () =>
      (label.textContent = `正在写学习指南 · ${Math.round((Date.now() - started) / 1000)}s　通常 1–3 分钟，可以先关掉窗口，好了会自动打开`);
    tick();
    const timer = window.setInterval(tick, 1000);
    try {
      const src: GuideSource = { request };
      if (material) {
        src.material =
          material.extension === "pdf"
            ? { name: material.name, pdf: await this.app.vault.readBinary(material) }
            : { name: material.name, text: await this.app.vault.read(material) };
      }
      const s = this.plugin.data.settings;
      const markdown = await generateGuide(this.plugin.agentConfig(), { model: s.guideModel, effort: s.guideEffort }, src);
      const file = await this.save(markdown, request, material);
      this.close();
      await this.app.workspace.getLeaf(false).openFile(file);
      this.plugin.revealAgentView();
      new Notice(`学习指南已生成：${file.basename}`);
    } catch (err) {
      status.empty();
      status.addClass("is-error");
      status.setText((err as Error).message);
      new Notice(`生成失败：${(err as Error).message}`, 8000);
    } finally {
      window.clearInterval(timer);
      this.busy = false;
      composer.setBusy(false);
    }
  }

  private async save(markdown: string, request: string, material: TFile | null): Promise<TFile> {
    const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || "学习指南";
    const folder = normalizePath(this.plugin.data.settings.guideFolder || "/");
    if (folder !== "/" && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const base = title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "学习指南";
    let path = normalizePath(`${folder}/${base}.md`);
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${folder}/${base} ${i}.md`);

    const source = material ? `"[[${material.path}]]"` : JSON.stringify(request.trim().split("\n")[0].slice(0, 120));
    const frontmatter = `---\ntags:\n  - study-guide\nsource: ${source}\n---\n\n`;
    // The file name carries the title (Obsidian shows it as the inline title), so drop the H1.
    const body = markdown.replace(/^#\s+.+\n+/, "");
    return this.app.vault.create(path, frontmatter + body);
  }

  onClose() {
    this.contentEl.empty();
  }
}
