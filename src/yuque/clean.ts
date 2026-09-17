import { TFile } from "obsidian";
import type { YuqueStylePlugin } from "../main";
import { stripColorSpans } from "./lake";
import { hashContent } from "./state";
import type { SyncLogFn } from "./sync";
import { runWithSyncModal } from "./ui";

/**
 * 本地清理同步下来的文档里的文字颜色标记。
 *
 * 为什么不靠重新同步：增量同步会跳过「远端 updated_at 没变且本地文件在」的文档，
 * 存量文档永远等不到重写；全量重拉则要两千多次请求。这里完全不调 API、只读本地文件。
 *
 * 关键细节：改写后必须回写同步记录的 hash，否则下一次同步会把这次清理
 * 判成「本地被改过」，白触发一次保守备份。
 */
export interface CleanStats {
  /** 存在且已读取的文档数 */
  scanned: number;
  /** 实际改写的文档数 */
  changed: number;
  /** 去掉的标记数（颜色包裹数 / 属性行数） */
  hits: number;
}

/** 返回 null 表示这篇没什么要改的（调用方据此跳过写入） */
type Transform = (content: string) => { content: string; hits: number } | null;

async function walkSyncedDocs(
  plugin: YuqueStylePlugin,
  log: SyncLogFn,
  signal: AbortSignal | undefined,
  transform: Transform,
): Promise<CleanStats> {
  const state = plugin.settings.yuqueSyncState || {};
  const entries = Object.entries(state).filter(([, rec]) => !!rec?.path);
  const stats: CleanStats = { scanned: 0, changed: 0, hits: 0 };
  let hashDirty = false;
  let processed = 0;

  for (const [, rec] of entries) {
    if (signal?.aborted) {
      log("已停止；已改写的文档记录会先保存");
      break;
    }
    processed++;
    if (processed % 200 === 0) log(`已处理 ${processed}/${entries.length} 篇…`);

    const file = plugin.app.vault.getAbstractFileByPath(`${rec.path}.md`);
    if (!(file instanceof TFile)) continue;
    stats.scanned++;

    const content = await plugin.app.vault.cachedRead(file);
    const patch = transform(content);
    if (!patch) continue;

    await plugin.app.vault.modify(file, patch.content);
    // 记录里存的是内容指纹：清理改了内容，指纹不跟着改会被判成「本地被改过」
    rec.hash = hashContent(patch.content);
    hashDirty = true;
    stats.changed++;
    stats.hits += patch.hits;
  }

  if (hashDirty) await plugin.saveSettings();
  return stats;
}

/**
 * 去掉文字颜色的 span 包裹。
 * 口径跟随设置里的「文字颜色」：保留颜色时只解默认色（本来就看不出差别），
 * 其余两种模式连真正选过的颜色一起解掉——否则编辑模式下永远看得见那些源码。
 */
export function cleanDefaultColors(
  plugin: YuqueStylePlugin,
  log: SyncLogFn,
  signal?: AbortSignal,
): Promise<CleanStats> {
  const keepColor = (plugin.settings.yuqueTextColor || "drop") === "keep";
  return walkSyncedDocs(plugin, log, signal, (content) => {
    const { markdown, removed } = stripColorSpans(content, { defaultOnly: keepColor });
    return removed > 0 ? { content: markdown, hits: removed } : null;
  });
}

export async function cleanColorsFlow(plugin: YuqueStylePlugin): Promise<void> {
  await runWithSyncModal(
    plugin,
    "清理默认文字颜色",
    async (log, _modal, signal) => {
      const keepColor = (plugin.settings.yuqueTextColor || "drop") === "keep";
      log(
        keepColor
          ? "只读本地文件，不调语雀接口；只去掉等于主题默认色的包裹，真正选过的颜色保留。"
          : "只读本地文件，不调语雀接口；按「文字颜色」设置的口径去掉颜色包裹。",
      );
      const stats = await cleanDefaultColors(plugin, log, signal);
      log(
        `完成：扫描 ${stats.scanned} 篇，改写 ${stats.changed} 篇，` +
          `去掉 ${stats.hits} 个默认色标记`,
        "success",
      );
    },
    { stoppable: true },
  );
}


