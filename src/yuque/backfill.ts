import { Notice, TFile } from "obsidian";
import type { YuqueStylePlugin } from "../main";
import { YuqueApi, type YuqueDocSummary } from "./api";
import { ensureFrontmatterFields, FM, yuqueTagNames } from "./frontmatter";
import { stripMd } from "./link";
import { hashContent, stateKey } from "./state";
import type { SyncLogFn } from "./sync";
import { runWithSyncModal } from "./ui";

/**
 * 补齐已同步文档的属性，并把旧版英文键就地改名为中文键。
 *
 * 为什么需要它：增量同步会跳过「远端 updated_at 没变且本地文件在」的文档，
 * 所以新字段永远写不进存量文件；键名从英文改成中文（标题 / 来源 / 语雀ID /
 * 语雀创建时间 / 语雀更新时间 / 语雀标签）同理，改不到已跳过的文档。
 * 走全量重拉要 2100+ 次详情请求（十几分钟且吃配额），这里只用**文档列表**接口：
 * 每 100 篇 1 次请求，两千多篇大约二十几次，便宜约 35 倍。
 *
 * 只改前言区，正文一个字节都不动；只补缺失字段，不覆盖已有值。
 * 属性始终写入文件（用户只能控制它在属性面板显不显示），所以这里不受任何开关影响。
 * 顺带（同一趟数据）产出孤儿清单：同步记录里有、语雀端已不存在的文档——只报告，不删除。
 */

export interface OrphanDoc {
  path: string;
  title: string;
}

export interface BackfillStats {
  /** 成功取到列表的知识库数 */
  libraries: number;
  /** 列表拉取失败、被跳过的知识库 */
  failed: string[];
  /** 语雀端仍在、本地也有文件的文档数 */
  scanned: number;
  /** 实际写入（补字段或改名）的文档数 */
  patched: number;
  /** 其中发生了键名迁移（英文键 → 中文键）的文档数 */
  migrated: number;
  /** 无需改动（字段已齐）或本地文件缺失的文档数 */
  skipped: number;
  orphans: OrphanDoc[];
}

const ORPHAN_LOG_LIMIT = 50;

export async function backfillMetadata(
  plugin: YuqueStylePlugin,
  log: SyncLogFn,
  signal?: AbortSignal,
): Promise<BackfillStats> {
  const settings = plugin.settings;
  const state = settings.yuqueSyncState;
  const stats: BackfillStats = {
    libraries: 0,
    failed: [],
    scanned: 0,
    patched: 0,
    migrated: 0,
    skipped: 0,
    orphans: [],
  };

  const namespaces = [...new Set((settings.yuqueTasks || []).map((t) => t.namespace))];
  if (namespaces.length === 0) {
    log("还没有同步任务，无需补齐", "error");
    return stats;
  }

  const api = new YuqueApi(settings.yuqueToken);
  log("只调文档列表接口（每 100 篇 1 次请求），不拉正文、不动图片。");

  // 1) 取各知识库的文档列表
  const summaryByNs = new Map<string, Map<string, YuqueDocSummary>>();
  for (const ns of namespaces) {
    if (signal?.aborted) break;
    try {
      const docs = await api.getDocList(ns);
      const byKey = new Map<string, YuqueDocSummary>();
      for (const d of docs) byKey.set(stateKey(ns, d.slug), d);
      summaryByNs.set(ns, byKey);
      stats.libraries++;
      log(`「${ns}」：${docs.length} 篇`);
    } catch (e) {
      stats.failed.push(ns);
      log(`拉取「${ns}」文档列表失败，跳过该库：${(e as Error).message}`, "error");
    }
  }

  // 2) 就地补前言区，并顺带识别孤儿
  const entries = Object.entries(state).filter(([, rec]) => !!rec?.path);
  let processed = 0;
  let hashDirty = false;

  for (const [key, rec] of entries) {
    if (signal?.aborted) {
      log("已停止");
      break;
    }
    processed++;
    if (processed % 200 === 0) log(`已处理 ${processed}/${entries.length} 篇…`);

    const ns = key.slice(0, key.lastIndexOf("/"));
    const byKey = summaryByNs.get(ns);
    // 该库列表没取到（拉取失败或不在任务里）→ 既不下孤儿结论，也不补元数据
    if (!byKey) continue;

    const summary = byKey.get(key);
    if (!summary) {
      stats.orphans.push({ path: rec.path, title: rec.title || stripMd(rec.path) });
      continue;
    }
    stats.scanned++;

    const file = plugin.app.vault.getAbstractFileByPath(`${rec.path}.md`);
    if (!(file instanceof TFile)) {
      stats.skipped++;
      continue;
    }

    const content = await plugin.app.vault.cachedRead(file);
    // 只有 updated_at 是时间敏感的：本地还是旧版本时绝不能写远端的新时间，
    // 否则文档头会显示一个比正文更新的「更新于」。ID 与创建时间与时点无关，随时可补。
    const upToDate = rec.updatedAt && rec.updatedAt === summary.updated_at;
    // 来源用同步记录的 key 还原：它就是「namespace/slug」，与同步写入时的拼法一致
    const patch = ensureFrontmatterFields(content, {
      [FM.title]: summary.title || rec.title || stripMd(rec.path),
      [FM.source]: `https://www.yuque.com/${key}`,
      [FM.id]: String(summary.id ?? ""),
      [FM.createdAt]: summary.created_at || "",
      [FM.tags]: yuqueTagNames((summary as { tags?: unknown }).tags),
      [FM.updatedAt]: upToDate ? summary.updated_at : "",
    });
    if (!patch) {
      stats.skipped++;
      continue;
    }
    if (patch.renamed.length > 0) stats.migrated++;
    await plugin.app.vault.modify(file, patch.content);
    rec.hash = hashContent(patch.content);
    hashDirty = true;
    stats.patched++;
  }

  if (hashDirty) await plugin.saveSettings();

  // 3) 孤儿清单：只报告，绝不删除文件
  if (stats.orphans.length > 0) {
    log(`语雀端已不存在的文档 ${stats.orphans.length} 篇（仅报告，未删除任何文件）：`);
    for (const o of stats.orphans.slice(0, ORPHAN_LOG_LIMIT)) log(`  · ${o.path}`);
    if (stats.orphans.length > ORPHAN_LOG_LIMIT) {
      log(`  …等共 ${stats.orphans.length} 篇`);
    }
  }

  return stats;
}

export async function backfillFlow(plugin: YuqueStylePlugin): Promise<void> {
  if (!plugin.settings.yuqueToken) {
    new Notice("请先在插件设置中填写语雀 Token");
    return;
  }
  await runWithSyncModal(
    plugin,
    "补齐文档属性",
    async (log, _modal, signal) => {
      const stats = await backfillMetadata(plugin, log, signal);
      log(
        `完成：${stats.libraries} 个知识库，检查 ${stats.scanned} 篇，写入 ${stats.patched} 篇` +
          `（其中键名迁移为中文 ${stats.migrated} 篇），无需改动 ${stats.skipped} 篇` +
          (stats.orphans.length > 0 ? `，疑似孤儿 ${stats.orphans.length} 篇（未删除）` : ""),
        "success",
      );
      if (stats.failed.length > 0) {
        log(`以下知识库拉取失败已跳过：${stats.failed.join("、")}`, "error");
      }
    },
    { stoppable: true },
  );
}
