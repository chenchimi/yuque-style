/**
 * 文件浏览器里的「语雀同步文档」标记。
 *
 * 动机：一篇文档是不是语雀同步来的、能不能点开原文，此前只在 topbar 元信息行里可见
 * （v0.8.0）——必须先打开文档才知道。这里把同步状态带进文件浏览器：
 * 每篇同步文档的行尾显示一个小圆点，扫一眼目录就知道哪些是语雀内容。
 *
 * 判据只有一条：`settings.yuqueSyncState` 里记录的本地路径（`path` + ".md"）。
 * 不读文件内容、不比对 hash——「本地是否有改动」需要逐篇读文件，
 * 挂在 MutationObserver 上代价不成比例，冲突提示仍由同步过程负责（备份 + 日志）。
 *
 * 与 explorer.ts（隐藏图片文件夹）同一套机制：CSS 类 + data-path 属性，
 * 挂在文件浏览器视图根的 MutationObserver 里防抖扫描。
 */

export const SYNCED_DOC_CLASS = "yuque-synced-doc";

/** 同步记录 → 需要标记的 vault 路径集合（record.path 不含扩展名，文件条目的 data-path 含） */
export function syncedDocPaths(
  state: Record<string, { path?: string } | undefined>,
): Set<string> {
  const out = new Set<string>();
  for (const rec of Object.values(state)) {
    if (rec?.path) out.add(`${rec.path}.md`);
  }
  return out;
}

/**
 * 在给定的文件浏览器视图内标记/取消标记文件条目，返回命中数。
 *
 * 只认 `data-path` 且以 `.md` 结尾（文件条目；文件夹与资源目录不以此结尾）。
 * **幂等且自愈**：已不再命中同步记录的条目会被摘掉旧标记——
 * 文档被移出同步或记录被清除后，圆点不会残留。
 */
export function markSyncedDocNodes(root: ParentNode, synced: Set<string>): number {
  let matched = 0;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-path]"))) {
    const p = el.getAttribute("data-path") ?? "";
    if (!p.endsWith(".md")) continue;
    if (synced.has(p)) {
      el.classList.add(SYNCED_DOC_CLASS);
      matched++;
    } else {
      el.classList.remove(SYNCED_DOC_CLASS);
    }
  }
  return matched;
}

/** 撤销本插件打过的全部同步标记（关闭开关或插件卸载时调用） */
export function clearSyncedDocNodes(root: ParentNode = document): number {
  const marked = Array.from(root.querySelectorAll<HTMLElement>(`.${SYNCED_DOC_CLASS}`));
  for (const el of marked) el.classList.remove(SYNCED_DOC_CLASS);
  return marked.length;
}
