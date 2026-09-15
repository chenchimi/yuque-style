import { App, Modal, Notice, Setting, TextComponent } from "obsidian";
import type { YuqueStylePlugin } from "../main";
import { YuqueApi, YuqueRepo, nsPath } from "./api";
import { syncAllTasks, syncTask, type SyncLogFn } from "./sync";
import type { YuqueSyncTask } from "../main";

/** 同步进度弹窗：滚动日志 */
export class SyncModal extends Modal {
  private logEl!: HTMLElement;

  constructor(app: App, private title: string) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    this.contentEl.empty();
    this.logEl = this.contentEl.createDiv({ cls: "yuque-sync-log" });
    this.modalEl.addClass("yuque-sync-modal");
  }

  log(msg: string, type: "info" | "success" | "error" = "info"): void {
    if (!this.logEl) return;
    const line = this.logEl.createDiv({ cls: `yuque-sync-log-line yuque-sync-${type}` });
    line.setText(`[${new Date().toLocaleTimeString()}] ${msg}`);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 打开同步进度弹窗并执行回调 */
export async function runWithSyncModal(
  plugin: YuqueStylePlugin,
  title: string,
  fn: (log: SyncLogFn, modal: SyncModal) => Promise<void>,
): Promise<void> {
  const modal = new SyncModal(plugin.app, title);
  modal.open();
  const log: SyncLogFn = (msg, type) => modal.log(msg, type);
  try {
    await fn(log, modal);
  } catch (e) {
    console.error("[yuque-style] 同步出错", e);
    log(`出错：${(e as Error).message}`, "error");
  } finally {
    log("—— 结束 ——");
  }
}

/**
 * 「添加同步任务」单弹窗向导：
 * 知识库下拉 + 同步范围 +（可选）文档勾选列表 + 目标文件夹，全部在一个 Modal 内完成，
 * 不做弹窗链切换（旧版连续弹窗在部分 Obsidian 版本上会被吞掉）。
 */
class AddTaskModal extends Modal {
  private repos: YuqueRepo[] = [];
  private repoIdx = 0;
  private mode: "all" | "selected" = "all";
  private targetFolder = "";
  private docList: { slug: string; title: string }[] = [];
  private checkedDocs = new Set<string>();
  private confirmBtn: HTMLButtonElement | null = null;
  private bodyEl!: HTMLElement;
  private docSectionEl: HTMLElement | null = null;

  constructor(
    private plugin: YuqueStylePlugin,
    private onConfirm: (task: YuqueSyncTask | null) => void,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.titleEl.setText("添加语雀同步任务");
    this.contentEl.empty();
    this.bodyEl = this.contentEl.createDiv();

    const loading = this.bodyEl.createEl("p", { text: "正在获取知识库列表…" });

    new Setting(this.contentEl).addButton((b) => {
      this.confirmBtn = b.buttonEl;
      b.setButtonText("创建并同步")
        .setCta()
        .onClick(async () => {
          const task = await this.buildTask();
          if (!task) return; // 校验失败（未勾选文档等），弹窗保持打开
          // 先回调再关闭：确保 onConfirm 先于 onClose 的取消逻辑执行
          this.onConfirm(task);
          this.close();
        });
      b.buttonEl.disabled = true;
      b.buttonEl.style.opacity = "0.5";
    });

    void this.loadRepos(loading);
  }

  private async loadRepos(loadingEl: HTMLElement): Promise<void> {
    try {
      const api = new YuqueApi(this.plugin.settings.yuqueToken);
      this.repos = await api.getRepos();
    } catch (e) {
      console.error("[yuque-style] 获取知识库失败", e);
      loadingEl.setText(`获取知识库失败：${(e as Error).message}`);
      return;
    }
    if (this.repos.length === 0) {
      loadingEl.setText("该 Token 下没有可访问的知识库");
      return;
    }
    loadingEl.remove();
    this.renderForm();
  }

  private renderForm(): void {
    const s = this.plugin.settings;
    this.bodyEl.empty();

    // 1) 知识库
    new Setting(this.bodyEl)
      .setName("知识库")
      .setDesc("选择要同步的语雀知识库")
      .addDropdown((d) => {
        for (const r of this.repos) d.addOption(String(this.repos.indexOf(r)), r.name);
        d.setValue("0").onChange(async (v) => {
          this.repoIdx = Number(v);
          this.docList = [];
          this.checkedDocs.clear();
          this.mode = "all";
          this.targetFolder = this.repos[this.repoIdx]?.name || "";
          this.renderForm();
        });
      });

    // 2) 同步范围
    const rangeSetting = new Setting(this.bodyEl)
      .setName("同步范围")
      .setDesc("整个知识库 或 只同步勾选的文档");
    rangeSetting.addDropdown((d) => {
      d.addOption("all", "整个知识库");
      d.addOption("selected", "选择文档");
      d.setValue(this.mode).onChange(async (v) => {
        this.mode = v as "all" | "selected";
        if (this.mode === "selected" && this.docList.length === 0) {
          try {
            new Notice("正在获取文档列表…");
            const api = new YuqueApi(this.plugin.settings.yuqueToken);
            this.docList = await api.getDocList(this.repos[this.repoIdx].namespace);
          } catch (e) {
            new Notice(`获取文档列表失败：${(e as Error).message}`);
            this.mode = "all";
            this.renderForm();
            return;
          }
        }
        this.renderForm();
      });
    });

    // 3) 文档勾选（仅 selected 模式）
    if (this.docSectionEl) this.docSectionEl.remove();
    this.docSectionEl = null;
    if (this.mode === "selected") {
      const section = this.bodyEl.createDiv();
      this.docSectionEl = section;
      if (this.docList.length === 0) {
        section.createEl("p", { text: "该知识库没有文档" });
      } else {
        section.createEl("p", {
          text: `勾选要同步的文档（已选 ${this.checkedDocs.size}/${this.docList.length} 篇）：`,
          cls: "setting-item-description",
        });
        const listEl = section.createDiv({ cls: "yuque-doc-select-list" });
        for (const doc of this.docList) {
          const row = listEl.createDiv({ cls: "yuque-doc-select-row" });
          const cb = row.createEl("input", { type: "checkbox" });
          cb.checked = this.checkedDocs.has(doc.slug);
          cb.addEventListener("change", () => {
            if (cb.checked) this.checkedDocs.add(doc.slug);
            else this.checkedDocs.delete(doc.slug);
            const p = section.querySelector("p.setting-item-description");
            if (p)
              p.setText(
                `勾选要同步的文档（已选 ${this.checkedDocs.size}/${this.docList.length} 篇）：`,
              );
          });
          row.createSpan({ text: doc.title });
        }
        new Setting(section).addButton((b) =>
          b.setButtonText("全选").onClick(() => {
            listEl
              .querySelectorAll("input[type=checkbox]")
              .forEach((el) => ((el as HTMLInputElement).checked = true));
            this.docList.forEach((d) => this.checkedDocs.add(d.slug));
            const p = section.querySelector("p.setting-item-description");
            if (p)
              p.setText(
                `勾选要同步的文档（已选 ${this.checkedDocs.size}/${this.docList.length} 篇）：`,
              );
          }),
        );
      }
    }

    // 4) 目标文件夹
    if (!this.targetFolder) this.targetFolder = this.repos[this.repoIdx]?.name || "";
    const folderSetting = new Setting(this.bodyEl)
      .setName("目标文件夹")
      .setDesc("同步到仓库中的路径，留空 = 根目录；文档会按语雀目录结构存放");
    const text = new TextComponent(folderSetting.controlEl);
    text.setPlaceholder("留空 = 仓库根目录");
    text.setValue(this.targetFolder);
    text.inputEl.addClass("yuque-folder-input");
    text.onChange((v) => (this.targetFolder = v));

    // 启用确认按钮
    if (this.confirmBtn) {
      this.confirmBtn.disabled = false;
      this.confirmBtn.style.opacity = "1";
    }
  }

  private async buildTask(): Promise<YuqueSyncTask | null> {
    const repo = this.repos[this.repoIdx];
    if (!repo) return null;
    let selectedDocs: { slug: string; title: string }[] = [];
    if (this.mode === "selected") {
      selectedDocs = this.docList.filter((d) => this.checkedDocs.has(d.slug));
      if (selectedDocs.length === 0) {
        new Notice("未勾选任何文档");
        return null;
      }
    }
    return {
      repoId: repo.id,
      namespace: repo.namespace,
      repoName: repo.name,
      targetFolder: this.targetFolder.trim(),
      mode: this.mode,
      selectedDocs,
    };
  }

  onClose(): void {
    this.bodyEl.empty();
  }
}

/** 「添加同步任务」入口：单弹窗表单，确认后保存任务并立即同步 */
export async function addSyncTaskFlow(plugin: YuqueStylePlugin): Promise<void> {
  if (!plugin.settings.yuqueToken) {
    new Notice("请先在插件设置中填写语雀 Token");
    return;
  }
  const task = await new Promise<YuqueSyncTask | null>((resolve) => {
    let settled = false;
    const modal = new AddTaskModal(plugin, (t) => {
      if (!settled) {
        settled = true;
        resolve(t);
      }
    });
    // Modal 自身的取消路径：关闭时若未确认则 resolve null
    const origOnClose = modal.onClose.bind(modal);
    modal.onClose = () => {
      origOnClose();
      if (!settled) {
        settled = true;
        resolve(null);
      }
    };
    modal.open();
  });

  if (!task) return;

  const settings = plugin.settings;
  // 覆盖同知识库的旧任务
  const others = (settings.yuqueTasks || []).filter((t) => t.namespace !== task.namespace);
  settings.yuqueTasks = [...others, task];
  await plugin.saveSettings();

  // 等弹窗完全关闭后再打开同步进度弹窗
  await new Promise((r) => setTimeout(r, 200));
  await runWithSyncModal(plugin, `同步「${task.repoName}」`, async (log) => {
    await syncTask(plugin, new YuqueApi(settings.yuqueToken), task, log);
  });
}

/** 「立即同步全部」入口：没有任务时引导创建 */
export async function syncAllFlow(plugin: YuqueStylePlugin): Promise<void> {
  const tasks = plugin.settings.yuqueTasks || [];
  if (tasks.length === 0) {
    const go = await new Promise<boolean>((resolve) => {
      let settled = false;
      const modal = new Modal(plugin.app);
      modal.titleEl.setText("语雀同步");
      modal.contentEl.createEl("p", {
        text: "还没有同步任务。是否现在创建一个？（选择知识库、范围与目标文件夹）",
      });
      new Setting(modal.contentEl).addButton((b) =>
        b.setButtonText("创建同步任务").setCta().onClick(() => {
          if (!settled) {
            settled = true;
            resolve(true);
          }
          modal.close();
        }),
      );
      modal.onClose = () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      };
      modal.open();
    });
    if (!go) return;
    await new Promise((r) => setTimeout(r, 200));
    await addSyncTaskFlow(plugin);
    return;
  }
  await runWithSyncModal(plugin, "语雀同步", async (log) => {
    await syncAllTasks(plugin, log);
  });
}

/** 「诊断」：直接输出语雀 API 原始响应，定位拉取为空等问题 */
function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function diagnoseFlow(plugin: YuqueStylePlugin): Promise<void> {
  if (!plugin.settings.yuqueToken) {
    new Notice("请先在插件设置中填写语雀 Token");
    return;
  }
  await runWithSyncModal(plugin, "语雀同步诊断", async (log) => {
    const api = new YuqueApi(plugin.settings.yuqueToken);

    const userRes = await api.getRaw("/user");
    const user = safeJson(userRes.text)?.data;
    const login = user?.login;
    log(`GET /user → ${userRes.status}，用户：${user?.name ?? "?"}（login: ${login ?? "?"}）`);
    if (userRes.status !== 200) {
      log(`  响应：${userRes.text.slice(0, 200)}`, "error");
      return;
    }

    const reposRes = await api.getRaw(
      `/users/${encodeURIComponent(String(login))}/repos?offset=0&limit=100`,
    );
    const reposData = safeJson(reposRes.text)?.data;
    const repos: YuqueRepo[] = Array.isArray(reposData) ? reposData : [];
    log(`GET /users/${login}/repos → ${reposRes.status}，${repos.length} 个知识库`);
    for (const r of repos.slice(0, 30)) {
      log(`  · ${r.name}（namespace: ${r.namespace}，id: ${r.id}）`);
    }

    const tasks = plugin.settings.yuqueTasks || [];
    if (tasks.length === 0) {
      log("没有同步任务，仅列出知识库信息。可在上方 namespace 中选一个手动诊断", "info");
    }
    for (const task of tasks) {
      const probes: [string, string][] = [
        ["目录 by namespace", `/repos/${nsPath(task.namespace)}/toc`],
        ["目录 by id", `/repos/${task.repoId}/toc`],
        ["文档列表 by namespace", `/repos/${nsPath(task.namespace)}/docs?offset=0&limit=100`],
        ["文档列表 by id", `/repos/${task.repoId}/docs?offset=0&limit=100`],
      ];
      for (const [label, path] of probes) {
        const r = await api.getRaw(path);
        const data = safeJson(r.text)?.data;
        const count = Array.isArray(data) ? `${data.length} 项` : `非数组（${data === null ? "null" : typeof data}）`;
        log(`「${task.repoName}」${label} → ${r.status}，${count}`);
        console.log(`[yuque-style 诊断] ${label} ${path}\n  status=${r.status}\n  ${r.text.slice(0, 3000)}`);
        if (r.status !== 200) log(`  响应：${r.text.slice(0, 200)}`, "error");
      }
    }
    log("—— 完整原始响应已打印到控制台（Ctrl+Shift+I → Console）——");
  });
}
