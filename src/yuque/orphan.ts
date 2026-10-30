import { Modal, Notice, TFile } from "obsidian";
import type { YuqueStylePlugin } from "../main";
import type { YuqueDocSummary } from "./api";
import type { SyncLogFn } from "./sync";
import { stateKey } from "./state";
import { runWithSyncModal } from "./ui";

/**
 * 清理「孤儿文档副本」：同步记录里有、语雀端已经不存在的本地文件。
 *
 * 「补齐文档属性」（backfill.ts）每趟都会顺带产出孤儿清单，但只报告不处理——
 * 用户每次要手动逐篇删。本命令把「找」与「删」拆成两步：
 * 先用**文档列表**接口（每 100 篇 1 次请求，不拉正文）比对出孤儿，
 * 再弹确认窗逐条列出来，用户点头才动文件。
 *
 * 删除方式是**移入系统回收站**（`vault.trash(file, true)`），不是直接删除——
 * 回收站本身就是最可靠的备份，比另建备份目录少一套生命周期要管理的东西。
 * 同步记录里的对应条目一并清掉，否则下一轮同步会因「本地文件缺失」重新创建它们。
 */

export interface OrphanCopy {
  /** 同步记录的 key，形如 "namespace/slug" */
  key: string;
  /** 同步记录里的本地路径（不含 .md 后缀，与 state.ts 的口径一致） */
  path: string;
  title: string;
}

export interface OrphanSweepStats {
  libraries: number;
  /** 列表拉取失败、被跳过的知识库——这些库**不下孤儿结论**，防误删 */
  failed: string[];
  orphans: OrphanCopy[];
  trashed: number;
  failedTrash: string[];
}

/**
 * 纯判定：同步记录 vs 各库文档列表的 slug 集合。
 * 只有当该库的列表**成功取到**（出现在 summaryKeysByNs 里）才允许下孤儿结论；
 * 列表拉取失败的库不参与比对——漏判只是少删一篇，误删可就找不回来了。
 */
export function pickOrphans(
  state: Record<string, { path?: string; title?: string } | undefined>,
  summaryKeysByNs: Map<string, Set<string>>,
): OrphanCopy[] {
  const out: OrphanCopy[] = [];
  for (const [key, rec] of Object.entries(state)) {
    if (!rec?.path) continue;
    const ns = key.slice(0, key.lastIndexOf("/"));
    const keys = summaryKeysByNs.get(ns);
    if (!keys || keys.has(key)) continue;
    out.push({ key, path: rec.path, title: rec.title || rec.path.split("/").pop() || rec.path });
  }
  return out;
}

/** 拉各任务知识库的文档列表，建 "namespace → slug key 集合" 索引（便宜：不拉正文） */
export async function fetchDocKeys(
  plugin: YuqueStylePlugin,
  log: SyncLogFn,
  signal?: AbortSignal,
): Promise<{ keysByNs: Map<string, Set<string>>; failed: string[] }> {
  const namespaces = [...new Set((plugin.settings.yuqueTasks || []).map((t) => t.namespace))];
  const keysByNs = new Map<string, Set<string>>();
  const failed: string[] = [];
  if (namespaces.length === 0) return { keysByNs, failed };

  const api = plugin.createApi();
  for (const ns of namespaces) {
    if (signal?.aborted) break;
    try {
      const docs: YuqueDocSummary[] = await api.getDocList(ns);
      const keys = new Set<string>();
      for (const d of docs) keys.add(stateKey(ns, d.slug));
      keysByNs.set(ns, keys);
      log(`「${ns}」：语雀端 ${docs.length} 篇`);
    } catch (e) {
      failed.push(ns);
      log(`拉取「${ns}」文档列表失败，该库跳过比对：${(e as Error).message}`, "error");
    }
  }
  return { keysByNs, failed };
}

/** 确认窗：列出孤儿，用户点头才删。取消返回 false */
class OrphanConfirmModal extends Modal {
  constructor(
    private plugin: YuqueStylePlugin,
    private orphans: OrphanCopy[],
    private onDecide: (confirmed: boolean) => void,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.titleEl.setText("清理孤儿文档副本");
    this.modalEl.addClass("yuque-sync-modal");
    const { contentEl } = this;

    contentEl.createEl("p", {
      text: `以下 ${this.orphans.length} 篇文档在语雀端已不存在（或被移出知识库）。` +
        "删除会移入系统回收站（可恢复），同时清除对应的同步记录。",
    });
    const list = contentEl.createEl("ul", { cls: "yuque-orphan-list" });
    const SHOW = 30;
    for (const o of this.orphans.slice(0, SHOW)) {
      list.createEl("li", { text: o.title ? `${o.title}（${o.path}）` : o.path });
    }
    if (this.orphans.length > SHOW) {
      contentEl.createEl("p", {
        cls: "setting-item-description",
        text: `…等共 ${this.orphans.length} 篇`,
      });
    }

    const actions = contentEl.createDiv({ cls: "yuque-orphan-actions" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => {
      this.close();
      this.onDecide(false);
    });
    const confirm = actions.createEl("button", {
      text: `移入回收站（${this.orphans.length} 篇）`,
      cls: "mod-warning",
    });
    confirm.addEventListener("click", () => {
      this.close();
      this.onDecide(true);
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * 删除一篇孤儿副本：文件移入系统回收站 + 清掉同步记录。
 * 文件不存在（已被手动删）只清记录，也算处理成功。
 */
export async function removeOrphanCopy(
  plugin: YuqueStylePlugin,
  orphan: OrphanCopy,
): Promise<"trashed" | "missing"> {
  const file = plugin.app.vault.getAbstractFileByPath(`${orphan.path}.md`);
  if (file instanceof TFile) {
    await plugin.app.vault.trash(file, true);
  }
  delete plugin.settings.yuqueSyncState[orphan.key];
  return file instanceof TFile ? "trashed" : "missing";
}

export async function orphanCleanupFlow(plugin: YuqueStylePlugin): Promise<void> {
  if (!plugin.settings.yuqueToken) {
    new Notice("请先在插件设置中填写语雀 Token");
    return;
  }
  await runWithSyncModal(
    plugin,
    "清理孤儿文档副本",
    async (log, _modal, signal) => {
      log("只调文档列表接口比对，不拉正文；确认后文件移入系统回收站（可恢复）。");
      const { keysByNs, failed } = await fetchDocKeys(plugin, log, signal);
      if (keysByNs.size === 0) {
        log("没有成功取到任何知识库的列表，无法比对（防误删：不对此下结论）。", "error");
        return;
      }
      const orphans = pickOrphans(plugin.settings.yuqueSyncState, keysByNs);
      if (orphans.length === 0) {
        log("未发现孤儿文档：同步记录与语雀端一致。", "success");
        return;
      }
      log(`发现 ${orphans.length} 篇孤儿副本，等待确认。`);

      const confirmed = await new Promise<boolean>((resolve) => {
        new OrphanConfirmModal(plugin, orphans, resolve).open();
      });
      if (!confirmed) {
        log("已取消，未删除任何文件。");
        return;
      }

      let trashed = 0;
      let missing = 0;
      let dirty = false;
      for (const o of orphans) {
        if (signal?.aborted) {
          log("已停止；剩余条目未处理", "error");
          break;
        }
        try {
          const r = await removeOrphanCopy(plugin, o);
          if (r === "trashed") trashed++;
          else missing++;
          dirty = true;
        } catch (e) {
          log(`「${o.path}」删除失败：${(e as Error).message}`, "error");
        }
      }
      if (dirty) await plugin.saveSettings();
      log(
        `完成：移入回收站 ${trashed} 篇` +
          (missing > 0 ? `（另有 ${missing} 篇本地已不存在，只清了记录）` : "") +
          "。同步记录已同步清理。",
        "success",
      );
      if (failed.length > 0) {
        log(`以下知识库列表拉取失败，本次未参与比对：${failed.join("、")}`, "error");
      }
    },
    { stoppable: true },
  );
}
