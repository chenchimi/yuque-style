import type { YuqueStylePlugin } from "../main";
import {
  basenameOf,
  buildLinkIndex,
  collectVaultDocs,
  convertLinksInContent,
  countBasenames,
  mergeStateIntoIndex,
  stripMd,
} from "./link";
import { hashContent } from "./state";
import { runWithSyncModal } from "./ui";
import type { SyncLogFn } from "./sync";

/**
 * 本地重建内部链接：把 vault 里正文的语雀文档链接换成本地双链。
 *
 * 为什么不靠「清除增量同步记录 + 全量重拉」：那要把两千多篇文档连同图片重下一遍，
 * 十几分钟且吃 API 配额。这里**完全不调语雀 API**，只读本地文件。
 *
 * 安全边界：只替换正则命中的那一段链接，不重写整篇；跳过 frontmatter（source 是
 * 建索引的原料）与围栏代码块；没有命中的文件一个字节都不写。
 */

export interface RelinkStats {
  scanned: number;
  changedFiles: number;
  convertedLinks: number;
  /** 没命中的文件数（含本就是双链的） */
  untouched: number;
}

export async function relinkVault(
  plugin: YuqueStylePlugin,
  log: SyncLogFn,
  signal?: AbortSignal,
): Promise<RelinkStats> {
  const vaultDocs = collectVaultDocs(plugin.app);
  const index = buildLinkIndex(vaultDocs);
  mergeStateIntoIndex(index, plugin.settings.yuqueSyncState);
  const counts = countBasenames(vaultDocs.map((d) => basenameOf(d.path)));

  // 路径（不带 .md）→ 同步记录 key：改写后要回写指纹
  const keyByPath = new Map<string, string>();
  for (const [key, rec] of Object.entries(plugin.settings.yuqueSyncState)) {
    if (rec?.path) keyByPath.set(rec.path, key);
  }

  const stats: RelinkStats = { scanned: 0, changedFiles: 0, convertedLinks: 0, untouched: 0 };
  let hashDirty = false;

  for (const file of plugin.app.vault.getMarkdownFiles()) {
    if (signal?.aborted) {
      log("已停止");
      break;
    }
    stats.scanned++;
    let content: string;
    try {
      content = await plugin.app.vault.cachedRead(file);
    } catch (e) {
      log(`读取失败「${file.path}」：${(e as Error).message}`, "error");
      continue;
    }
    const result = convertLinksInContent(content, index, counts);
    if (result.converted === 0 || result.content === content) {
      stats.untouched++;
      continue;
    }
    try {
      await plugin.app.vault.modify(file, result.content);
      stats.changedFiles++;
      stats.convertedLinks += result.converted;
      log(`已重建「${file.path}」：${result.converted} 条链接`);
      // 回写指纹：否则下次同步会把这些文件误判成「本地被改过」而触发一堆无谓备份
      const key = keyByPath.get(stripMd(file.path));
      const rec = key ? plugin.settings.yuqueSyncState[key] : undefined;
      if (rec) {
        rec.hash = hashContent(result.content);
        hashDirty = true;
      }
    } catch (e) {
      log(`写入失败「${file.path}」：${(e as Error).message}`, "error");
    }
  }

  if (hashDirty) await plugin.saveSettings();
  return stats;
}

export async function relinkFlow(plugin: YuqueStylePlugin): Promise<void> {
  await runWithSyncModal(
    plugin,
    "重建内部链接",
    async (log, _modal, signal) => {
      log("只读本地文件，不调用语雀 API。");
      const stats = await relinkVault(plugin, log, signal);
      log(
        `完成：扫描 ${stats.scanned} 篇，改写 ${stats.changedFiles} 篇，` +
          `共转换 ${stats.convertedLinks} 条链接`,
        "success",
      );
    },
    { stoppable: true },
  );
}
