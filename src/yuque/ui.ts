import { App, Modal, Notice, Setting, TextComponent } from "obsidian";
import type { YuqueStylePlugin } from "../main";
import { YuqueApi, YuqueRepo, nsPath } from "./api";
import { ensureFolder, resolveTargetFolders, syncAllTasks, type SyncLogFn } from "./sync";
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

/**
 * 打开同步进度弹窗并执行回调。
 * stoppable 为真时提供「停止」按钮：中断信号会传给 syncTask，
 * 它在每篇文档之间检查，停下前先把已写入文档的 state 落盘。
 */
export async function runWithSyncModal(
  plugin: YuqueStylePlugin,
  title: string,
  fn: (log: SyncLogFn, modal: SyncModal, signal?: AbortSignal) => Promise<void>,
  opts?: { stoppable?: boolean },
): Promise<void> {
  const modal = new SyncModal(plugin.app, title);
  const controller = new AbortController();
  modal.open();
  // 用对象包一层：回调里赋值的局部变量会被控制流分析收窄成 never
  const stop: { btn: HTMLButtonElement | null } = { btn: null };
  if (opts?.stoppable) {
    new Setting(modal.contentEl).addButton((b) => {
      stop.btn = b.buttonEl;
      b.setButtonText("停止")
        .setWarning()
        .onClick(() => {
          controller.abort();
          b.setButtonText("正在停止…").setDisabled(true);
        });
    });
  }
  const log: SyncLogFn = (msg, type) => modal.log(msg, type);
  try {
    await fn(log, modal, controller.signal);
  } catch (e) {
    console.error("[yuque-style] 同步出错", e);
    log(`出错：${(e as Error).message}`, "error");
  } finally {
    if (stop.btn) {
      stop.btn.textContent = "已结束";
      stop.btn.disabled = true;
      stop.btn.style.opacity = "0.5";
    }
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
  /** 勾选中的知识库 namespace，按勾选顺序保存（也是批量同步的执行顺序） */
  private picked: string[] = [];
  private mode: "all" | "selected" = "all";
  /** 根文件夹：留空时任务落在「库名」下，与旧行为一致 */
  private rootFolder = "";
  private keyword = "";
  private docList: { slug: string; title: string }[] = [];
  private checkedDocs = new Set<string>();
  private confirmBtn: HTMLButtonElement | null = null;
  private bodyEl!: HTMLElement;
  private docSectionEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;
  private pathEl: HTMLElement | null = null;

  constructor(
    private plugin: YuqueStylePlugin,
    private onConfirm: (tasks: YuqueSyncTask[] | null) => void,
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
          const tasks = await this.buildTasks();
          if (!tasks) return; // 校验失败（未勾选知识库等），弹窗保持打开
          // 先回调再关闭：确保 onConfirm 先于 onClose 的取消逻辑执行
          this.onConfirm(tasks);
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
    const multi = this.picked.length > 1;

    // 1) 根文件夹
    new Setting(this.bodyEl)
      .setName("根文件夹（可选）")
      .setDesc("每个知识库放在「根文件夹 / 库名」下；留空则直接用库名")
      .addText((t) => {
        t.setPlaceholder("留空 = 库名平铺");
        t.setValue(this.rootFolder);
        t.inputEl.addClass("yuque-folder-input");
        t.onChange((v) => {
          this.rootFolder = v.trim();
          this.renderPathPreview();
        });
      });

    // 2) 知识库多选：搜索 + 勾选列表
    const repoSection = this.bodyEl.createDiv();
    repoSection.createEl("p", {
      text: "选择知识库（勾选多个即一次创建多个任务）",
      cls: "setting-item-description",
    });
    const search = new TextComponent(repoSection);
    search.setPlaceholder("搜索知识库名称…");
    search.setValue(this.keyword);
    search.onChange((v) => {
      this.keyword = v.trim().toLowerCase();
      this.renderRepoList();
    });
    this.listEl = repoSection.createDiv({ cls: "yuque-doc-select-list" });
    const bar = new Setting(repoSection);
    bar.addButton((b) =>
      b.setButtonText("全选未配置的").onClick(() => {
        // 已配置过的不随「全选」一起被更新，避免一次批量操作冲掉精细配置
        for (const r of this.visibleRepos()) {
          if (!this.isConfigured(r.namespace) && !this.picked.includes(r.namespace)) {
            this.picked.push(r.namespace);
          }
        }
        this.onPickedChanged();
      }),
    );
    bar.addButton((b) =>
      b.setButtonText("清空").onClick(() => {
        this.picked = [];
        this.onPickedChanged();
      }),
    );
    this.summaryEl = repoSection.createEl("p", { cls: "setting-item-description" });
    this.pathEl = repoSection.createEl("p", { cls: "setting-item-description" });
    this.renderRepoList();

    // 3) 同步范围（多选时锁定整库）
    new Setting(this.bodyEl)
      .setName("同步范围")
      .setDesc(
        multi
          ? "已选多个知识库，固定为「整个知识库」；只勾 1 个时才能挑选文档"
          : "整个知识库 或 只同步勾选的文档",
      )
      .addDropdown((d) => {
        d.addOption("all", "整个知识库");
        d.addOption("selected", "选择文档");
        d.setValue(this.mode);
        d.setDisabled(multi);
        d.onChange(async (v) => {
          this.mode = v as "all" | "selected";
          if (this.mode === "selected" && this.docList.length === 0) {
            const repo = this.repos.find((r) => r.namespace === this.picked[0]);
            if (!repo) return;
            try {
              new Notice("正在获取文档列表…");
              const api = new YuqueApi(s.yuqueToken);
              this.docList = await api.getDocList(repo.namespace);
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

    // 4) 文档勾选（仅单选 + selected 模式）
    this.docSectionEl = null;
    if (!multi && this.mode === "selected") {
      const section = this.bodyEl.createDiv();
      this.docSectionEl = section;
      if (this.docList.length === 0) {
        section.createEl("p", { text: "该知识库没有文档" });
      } else {
        const tip = section.createEl("p", { cls: "setting-item-description" });
        const refresh = () =>
          tip.setText(
            `勾选要同步的文档（已选 ${this.checkedDocs.size}/${this.docList.length} 篇）：`,
          );
        refresh();
        const listEl = section.createDiv({ cls: "yuque-doc-select-list" });
        for (const doc of this.docList) {
          const row = listEl.createDiv({ cls: "yuque-doc-select-row" });
          const cb = row.createEl("input", { type: "checkbox" });
          cb.checked = this.checkedDocs.has(doc.slug);
          cb.addEventListener("change", () => {
            if (cb.checked) this.checkedDocs.add(doc.slug);
            else this.checkedDocs.delete(doc.slug);
            refresh();
          });
          row.createSpan({ text: doc.title });
        }
        new Setting(section).addButton((b) =>
          b.setButtonText("全选").onClick(() => {
            listEl
              .querySelectorAll("input[type=checkbox]")
              .forEach((el) => ((el as HTMLInputElement).checked = true));
            this.docList.forEach((d) => this.checkedDocs.add(d.slug));
            refresh();
          }),
        );
      }
    }

    // 启用确认按钮
    if (this.confirmBtn) {
      this.confirmBtn.disabled = false;
      this.confirmBtn.style.opacity = "1";
    }
  }

  /** 按勾选顺序产出任务；每个知识库一个任务 */
  private async buildTasks(): Promise<YuqueSyncTask[] | null> {
    const pickedRepos = this.pickedRepos();
    if (pickedRepos.length === 0) {
      new Notice("未选择任何知识库");
      return null;
    }
    const existing = new Map(
      (this.plugin.settings.yuqueTasks || []).map((t) => [t.namespace, t] as const),
    );
    const folders = resolveTargetFolders(pickedRepos, this.rootFolder);

    // 单选 + 选择文档：逐篇勾选
    if (pickedRepos.length === 1 && this.mode === "selected") {
      const repo = pickedRepos[0];
      const selectedDocs = this.docList.filter((d) => this.checkedDocs.has(d.slug));
      if (selectedDocs.length === 0) {
        new Notice("未勾选任何文档");
        return null;
      }
      return [
        {
          repoId: repo.id,
          namespace: repo.namespace,
          repoName: repo.name,
          targetFolder: folders[0].folder,
          mode: "selected",
          selectedDocs: selectedDocs.map((d) => ({ slug: d.slug, title: d.title })),
        },
      ];
    }

    return folders.map((f, i) => {
      const repo = pickedRepos[i];
      const old = existing.get(repo.namespace);
      // 已配置过且是「选择文档」模式：保留原勾选清单，不被这次批量操作冲掉
      const keepSelected = old?.mode === "selected";
      return {
        repoId: repo.id,
        namespace: repo.namespace,
        repoName: repo.name,
        targetFolder: f.folder,
        mode: keepSelected ? ("selected" as const) : ("all" as const),
        selectedDocs: keepSelected ? old!.selectedDocs : [],
      };
    });
  }

  private isConfigured(namespace: string): boolean {
    return (this.plugin.settings.yuqueTasks || []).some((t) => t.namespace === namespace);
  }

  private visibleRepos(): YuqueRepo[] {
    return this.repos.filter(
      (r) => !this.keyword || r.name.toLowerCase().includes(this.keyword),
    );
  }

  /** 按勾选顺序返回选中的知识库 */
  private pickedRepos(): YuqueRepo[] {
    return this.picked
      .map((n) => this.repos.find((r) => r.namespace === n))
      .filter((r): r is YuqueRepo => !!r);
  }

  private onPickedChanged(): void {
    if (this.picked.length > 1 && this.mode === "selected") {
      this.mode = "all";
      this.docList = [];
      this.checkedDocs.clear();
      new Notice("已选多个知识库，同步范围固定为「整个知识库」");
    }
    this.renderForm();
  }

  private renderRepoList(): void {
    const listEl = this.listEl;
    if (!listEl) return;
    listEl.empty();
    const shown = this.visibleRepos();
    for (const r of shown) {
      const row = listEl.createDiv({ cls: "yuque-doc-select-row" });
      const cb = row.createEl("input", { type: "checkbox" });
      cb.checked = this.picked.includes(r.namespace);
      cb.addEventListener("change", () => {
        if (cb.checked) {
          if (!this.picked.includes(r.namespace)) this.picked.push(r.namespace);
        } else {
          this.picked = this.picked.filter((n) => n !== r.namespace);
        }
        this.onPickedChanged();
      });
      row.createSpan({ text: r.name });
      row.createSpan({ text: `${r.items_count ?? 0} 篇`, cls: "setting-item-description" });
      if (this.isConfigured(r.namespace)) {
        row.createSpan({ text: "已配置", cls: "yuque-repo-configured" });
      }
    }
    if (shown.length === 0) listEl.createEl("p", { text: "没有匹配的知识库" });
    this.updateSummary();
  }

  private updateSummary(): void {
    const pickedRepos = this.pickedRepos();
    const docs = pickedRepos.reduce((sum, r) => sum + (r.items_count ?? 0), 0);
    // 实测约 0.44s/篇（含限流节流）；标出来是为了让人知道全选的代价再点
    const minutes = Math.max(1, Math.round((docs * 0.44) / 60));
    if (this.summaryEl) {
      this.summaryEl.setText(
        `已选 ${pickedRepos.length} 个知识库 · 约 ${docs} 篇 · 首次同步预计 ${minutes} 分钟量级`,
      );
    }
    if (this.confirmBtn) {
      this.confirmBtn.textContent =
        pickedRepos.length > 1 ? `创建 ${pickedRepos.length} 个任务并同步` : "创建并同步";
    }
    this.renderPathPreview();
  }

  private renderPathPreview(): void {
    if (!this.pathEl) return;
    const folders = resolveTargetFolders(this.pickedRepos(), this.rootFolder);
    if (folders.length === 0) {
      this.pathEl.setText("");
      return;
    }
    const shown = folders
      .slice(0, 3)
      .map((f) => f.folder)
      .join("、");
    this.pathEl.setText(
      `将同步到：${shown}${folders.length > 3 ? ` 等 ${folders.length} 个目录` : ""}`,
    );
  }

  onClose(): void {
    this.bodyEl.empty();
  }
}

/** 「添加同步任务」入口：可一次勾选多个知识库，确认后保存任务并立即同步 */
export async function addSyncTaskFlow(plugin: YuqueStylePlugin): Promise<void> {
  if (!plugin.settings.yuqueToken) {
    new Notice("请先在插件设置中填写语雀 Token");
    return;
  }
  const tasks = await new Promise<YuqueSyncTask[] | null>((resolve) => {
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

  if (!tasks || tasks.length === 0) return;

  const settings = plugin.settings;
  const oldByNs = new Map(
    (settings.yuqueTasks || []).map((t) => [t.namespace, t] as const),
  );
  // 覆盖同知识库的旧任务，未勾选的原样保留；新任务追加在末尾，内部按勾选顺序
  const rest = (settings.yuqueTasks || []).filter(
    (t) => !tasks.some((n) => n.namespace === t.namespace),
  );
  settings.yuqueTasks = [...rest, ...tasks];
  await plugin.saveSettings();

  // 目标文件夹变更：旧目录的文件不会自己跟过去（同步只认 state 记录的路径），需要显式搬
  const moves = tasks
    .map((t) => {
      const old = oldByNs.get(t.namespace);
      if (!old) return null;
      // 涉及仓库根目录的变更一律不动，避免把整个 vault 卷进来
      if (!old.targetFolder || !t.targetFolder) return null;
      if (old.targetFolder === t.targetFolder) return null;
      return { name: t.repoName, from: old.targetFolder, to: t.targetFolder };
    })
    .filter((m): m is { name: string; from: string; to: string } => !!m);

  if (moves.length > 0) {
    const ok = await confirmRelocate(plugin, moves);
    if (ok) {
      const { moved, skipped } = await relocateFolders(plugin, moves);
      new Notice(`已搬运 ${moved} 篇${skipped > 0 ? `，目标已存在而跳过 ${skipped} 篇` : ""}`);
    }
  }

  // 等弹窗完全关闭后再打开同步进度弹窗
  await new Promise((r) => setTimeout(r, 200));
  const title =
    tasks.length > 1 ? `同步 ${tasks.length} 个知识库` : `同步「${tasks[0].repoName}」`;
  await runWithSyncModal(
    plugin,
    title,
    async (log, _modal, signal) => {
      await syncAllTasks(plugin, log, tasks, signal);
    },
    { stoppable: true },
  );
}

/** 目标文件夹变更时，询问是否把旧目录里已同步的文档搬过去 */
function confirmRelocate(
  plugin: YuqueStylePlugin,
  moves: { name: string; from: string; to: string }[],
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const modal = new Modal(plugin.app);
    modal.titleEl.setText("目标文件夹已变更");
    modal.contentEl.createEl("p", {
      text: "这些知识库换了目标文件夹，已同步过的文档还留在旧位置（同步只认 state 记录的路径）。要现在搬过去吗？",
    });
    const ul = modal.contentEl.createEl("ul");
    for (const m of moves) {
      ul.createEl("li", {
        text: `${m.name}：${m.from} → ${m.to}（${countFilesUnder(plugin, m.from)} 篇）`,
      });
    }
    modal.contentEl.createEl("p", {
      text: "目标位置已存在同名文件时跳过，不做覆盖。",
      cls: "setting-item-description",
    });
    new Setting(modal.contentEl)
      .addButton((b) =>
        b
          .setButtonText("搬运")
          .setCta()
          .onClick(() => {
            if (!settled) {
              settled = true;
              resolve(true);
            }
            modal.close();
          }),
      )
      .addButton((b) =>
        b.setButtonText("不搬").onClick(() => {
          if (!settled) {
            settled = true;
            resolve(false);
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
}

function countFilesUnder(plugin: YuqueStylePlugin, folder: string): number {
  return plugin.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(`${folder}/`))
    .length;
}

/**
 * 把旧目录下的文档搬到新目录。用 vault.rename 而不是重写文件：
 * main.ts 的 rename 监听会把 state.path 一并跟过去，不需要再写迁移代码。
 */
async function relocateFolders(
  plugin: YuqueStylePlugin,
  moves: { name: string; from: string; to: string }[],
): Promise<{ moved: number; skipped: number }> {
  const app = plugin.app;
  let moved = 0;
  let skipped = 0;
  for (const m of moves) {
    const files = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(`${m.from}/`));
    for (const f of files) {
      const rel = f.path.slice(m.from.length + 1);
      const target = `${m.to}/${rel}`;
      if (app.vault.getAbstractFileByPath(target)) {
        skipped++;
        continue;
      }
      const dir = target.slice(0, target.lastIndexOf("/"));
      if (dir) await ensureFolder(app, dir);
      await app.vault.rename(f, target);
      moved++;
    }
  }
  return { moved, skipped };
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
  await runWithSyncModal(
    plugin,
    "语雀同步",
    async (log, _modal, signal) => {
      await syncAllTasks(plugin, log, undefined, signal);
    },
    { stoppable: true },
  );
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
