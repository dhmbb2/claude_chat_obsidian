// Study-guide generation runs in the background. Each run is a job listed in the
// sidebar's 生成 tab, so it is clear whether a guide is still being written,
// finished, or failed. Jobs are saved: one cut off by quitting Obsidian shows up
// as interrupted on the next start.
import { normalizePath, Notice, TFile } from "obsidian";
import { CancelledError, generateGuide, type GuideSource, type ModelChoice, type Progress } from "./agent";
import type StudyAgentPlugin from "./main";

export type JobStatus = "running" | "done" | "failed" | "interrupted" | "cancelled";

export interface GuideJob extends ModelChoice {
  id: string;
  title: string; // the request's first line, then the saved note's name
  request: string;
  materialPath: string | null;
  status: JobStatus;
  startedAt: string;
  finishedAt?: string;
  notePath?: string; // the saved guide
  error?: string;
}

const MAX_JOBS = 30;

export class GuideJobs {
  private live = new Map<string, { controller: AbortController; progress: Progress | null; stopping: boolean }>();
  private unloading = false;

  constructor(private plugin: StudyAgentPlugin) {}

  /** Jobs that were still running when Obsidian last quit never finished. */
  static restore(jobs: GuideJob[] = []): GuideJob[] {
    for (const j of jobs) if (j.status === "running") j.status = "interrupted";
    return jobs;
  }

  get list(): GuideJob[] {
    return this.plugin.data.jobs;
  }

  get runningCount(): number {
    return this.list.filter((j) => j.status === "running").length;
  }

  progress(id: string): Progress | null {
    return this.live.get(id)?.progress ?? null;
  }

  /** Stop was clicked; the CLI takes a moment to exit. */
  isStopping(id: string): boolean {
    return this.live.get(id)?.stopping ?? false;
  }

  start(request: string, material: TFile | null, choice: ModelChoice): GuideJob {
    const firstLine = request.trim().split("\n")[0].slice(0, 80);
    const job: GuideJob = {
      id: Math.random().toString(36).slice(2, 10),
      title: firstLine || (material ? `「${material.basename}」` : "学习指南"),
      request,
      materialPath: material?.path ?? null,
      ...choice,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.list.unshift(job);
    this.list.splice(MAX_JOBS);
    void this.run(job, material);
    return job;
  }

  retry(job: GuideJob) {
    const material = job.materialPath ? this.plugin.app.vault.getAbstractFileByPath(job.materialPath) : null;
    if (job.materialPath && !(material instanceof TFile)) {
      new Notice(`找不到材料「${job.materialPath}」，可能已被移动或删除。`);
      return;
    }
    this.remove(job.id);
    this.start(job.request, material as TFile | null, { model: job.model, effort: job.effort });
  }

  cancel(id: string) {
    const live = this.live.get(id);
    if (!live || live.stopping) return;
    live.stopping = true;
    live.controller.abort();
    this.plugin.refreshJobs();
  }

  remove(id: string) {
    this.cancel(id);
    this.plugin.data.jobs = this.list.filter((j) => j.id !== id);
    this.changed();
  }

  clearFinished() {
    this.plugin.data.jobs = this.list.filter((j) => j.status === "running");
    this.changed();
  }

  /** The plugin is being disabled: stop the runs, and report them as interrupted. */
  stopAll() {
    this.unloading = true;
    for (const { controller } of this.live.values()) controller.abort();
  }

  notePathRenamed(oldPath: string, newPath: string) {
    for (const j of this.list) {
      if (j.notePath === oldPath) j.notePath = newPath;
      if (j.materialPath === oldPath) j.materialPath = newPath;
    }
  }

  private async run(job: GuideJob, material: TFile | null) {
    const controller = new AbortController();
    const live = { controller, progress: null as Progress | null, stopping: false };
    this.live.set(job.id, live);
    this.changed();
    const { app } = this.plugin;
    try {
      const src: GuideSource = { request: job.request };
      if (material) {
        src.material =
          material.extension === "pdf"
            ? { name: material.name, pdf: await app.vault.readBinary(material) }
            : { name: material.name, text: await app.vault.read(material) };
      }
      const markdown = await generateGuide(this.plugin.agentConfig(), job, src, {
        signal: controller.signal,
        onProgress: (p) => (live.progress = p),
      });
      const file = await this.save(markdown, job.request, material);
      job.status = "done";
      job.notePath = file.path;
      job.title = file.basename;
      await app.workspace.getLeaf("tab").openFile(file);
      new Notice(`学习指南已生成：${file.basename}`);
    } catch (err) {
      if (err instanceof CancelledError) {
        job.status = this.unloading ? "interrupted" : "cancelled";
      } else {
        job.status = "failed";
        job.error = (err as Error).message;
        new Notice(`学习指南生成失败：${job.title}\n${job.error}\n\n在侧边栏「生成」里可以重试。`, 10000);
      }
    } finally {
      job.finishedAt = new Date().toISOString();
      this.live.delete(job.id);
      this.changed();
    }
  }

  private async save(markdown: string, request: string, material: TFile | null): Promise<TFile> {
    const { vault } = this.plugin.app;
    const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || "学习指南";
    const folder = normalizePath(this.plugin.data.settings.guideFolder || "/");
    if (folder !== "/" && !vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
    const base = title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "学习指南";
    let path = normalizePath(`${folder}/${base}.md`);
    for (let i = 2; vault.getAbstractFileByPath(path); i++) path = normalizePath(`${folder}/${base} ${i}.md`);

    const source = material ? `"[[${material.path}]]"` : JSON.stringify(request.trim().split("\n")[0].slice(0, 120));
    const frontmatter = `---\ntags:\n  - study-guide\nsource: ${source}\n---\n\n`;
    // The file name carries the title (Obsidian shows it as the inline title), so drop the H1.
    const body = markdown.replace(/^#\s+.+\n+/, "");
    return vault.create(path, frontmatter + body);
  }

  /** Save, and redraw the 生成 tab and the status bar. */
  private changed() {
    void this.plugin.save();
    if (!this.unloading) this.plugin.refreshJobs();
  }
}
