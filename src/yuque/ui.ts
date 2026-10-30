import { Modal, Setting } from "obsidian";
import type { YuqueStylePlugin } from "../main";
import { syncAllTasks, syncTask } from "./sync";
import { runWithSyncModal } from "./sync-modal";
import { addSyncTaskFlow } from "./task-modal";

// 弹窗与向导拆分到独立模块（此处保持原导出路径，老引用不必跟着改）：
// - SyncModal / runWithSyncModal → ./sync-modal（进度弹窗，被各流程共用）
// - addSyncTaskFlow → ./task-modal（添加任务向导，约 500 行）
// - diagnoseFlow → ./diagnose（诊断命令，约 170 行）
export { SyncModal, runWithSyncModal } from "./sync-modal";
export { addSyncTaskFlow } from "./task-modal";
export { diagnoseFlow } from "./diagnose";

/**
 * 「管理同步任务」弹窗。
 *
 * 为什么把任务列表从设置页搬到这里：任务会随使用无限增长（截图里 20 个任务占了设置页
 * 四分之三的高度，把下面真正要调的选项全挤到看不见的地方），而它本身是**低频操作**——
 * 大多数人一个知识库一个任务，配好之后再也不会进这个页面。设置页只留一行摘要 + 入口。
 */
class ManageTasksModal extends Modal {
  constructor(private plugin: YuqueStylePlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    this.titleEl.setText("语雀同步任务");
    this.modalEl.addClass("yuque-sync-modal");
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const tasks = this.plugin.settings.yuqueTasks || [];

    const total = tasks.reduce(
      (sum, t) => sum + (t.mode === "all" ? 0 : t.selectedDocs.length),
      0,
    );
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text:
        total > 0
          ? `共 ${tasks.length} 个任务（其中按篇勾选共 ${total} 篇）；同步按语雀更新时间增量拉取`
          : `共 ${tasks.length} 个任务；同步按语雀更新时间增量拉取`,
    });

    if (tasks.length === 0) {
      contentEl.createEl("p", { text: "还没有同步任务，先添加一个。" });
    } else {
      const list = contentEl.createDiv({ cls: "yuque-task-list" });
      for (const task of tasks) {
        const row = list.createDiv({ cls: "yuque-task-row" });
        const info = row.createDiv({ cls: "yuque-task-info" });
        info.createDiv({ cls: "yuque-task-name", text: task.repoName });
        info.createDiv({
          cls: "yuque-task-desc",
          text: `${task.namespace} · ${
            task.mode === "all" ? "整个知识库" : `指定文档 ${task.selectedDocs.length} 篇`
          } · 目标：${task.targetFolder || "仓库根目录"}`,
        });
        const actions = row.createDiv({ cls: "yuque-task-actions" });
        const sync = actions.createEl("button", { text: "立即同步" });
        sync.addEventListener("click", () => {
          this.close();
          void runWithSyncModal(this.plugin, `同步「${task.repoName}」`, async (log) => {
            await syncTask(this.plugin, this.plugin.createApi(), task, log);
          });
        });
        const del = actions.createEl("button", { text: "删除", cls: "mod-warning" });
        del.addEventListener("click", async () => {
          this.plugin.settings.yuqueTasks = (this.plugin.settings.yuqueTasks || []).filter(
            (t) => t !== task,
          );
          await this.plugin.saveSettings();
          this.render();
        });
      }
    }

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("添加 / 更新任务").onClick(() => {
          this.close();
          void addSyncTaskFlow(this.plugin);
        }),
      )
      .addButton((b) =>
        b.setButtonText("立即同步全部").onClick(() => {
          this.close();
          void syncAllFlow(this.plugin);
        }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 「管理同步任务」入口：设置页与命令面板共用 */
export function manageTasksFlow(plugin: YuqueStylePlugin): void {
  new ManageTasksModal(plugin).open();
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
