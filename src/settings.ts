/**
 * 设置的装载与迁移。
 *
 * 抽成纯函数（不依赖 Obsidian）是为了能单测：**删除历史配置项**这件事最容易出错——
 * 删多了会让用户升级后功能静默失效，删少了 data.json 里会一直躺着没人读的键。
 *
 * 这里的职责只有两件：
 * 1. 用默认值补齐缺失字段（老用户升级后新开关要有确定的初始值）；
 * 2. 把已经废弃的键真正**从配置里删掉**（否则它们会被原样写回，越积越多）。
 */

/** 已废弃的配置键：功能已移除或已并入其它开关，留着只会让 data.json 越来越脏 */
export const OBSOLETE_SETTING_KEYS: readonly string[] = [
  /** v0.8.0 移除：文本格式动作已全部并入顶部工具栏（表格工具条改为按上下文自动出现） */
  "toolbar",
  /** v0.8.0 合并：顶部工具栏开着就带元信息，不再单独设开关 */
  "topBarMeta",
  /** v0.8.0 合并：阅读时长跟随「文档头信息」 */
  "showReadingTime",
  /** v0.6.5 移除：属性改为「显不显示」，旧的整体开关 */
  "yuqueDocProperties",
  /** v0.5.0 移除：自绘浮动目录，改用 Obsidian 原生大纲 */
  "showOutline",
];

/**
 * 任务名的摘要写法：设置页只显示一两行，任务多了也不能把页面撑长。
 * 例：`公务员、系统运维-工具、Github项目 等 21 个知识库`。
 */
export function summarizeTaskNames(names: readonly string[], max = 3): string {
  const list = names.filter((n) => !!n);
  if (list.length === 0) return "还没有任务";
  const shown = list.slice(0, max).join("、");
  return list.length > max ? `${shown} 等 ${list.length} 个知识库` : shown;
}

export interface SettingsLoadResult<T> {
  settings: T;
  /** 实际被删除的废弃键（非空才需要回写 data.json） */
  removed: string[];
  /** 本次补上的默认值键（用于排查「升级后行为变了」） */
  added: string[];
}

/**
 * 合并默认值 + 清理废弃键。
 *
 * 注意只做**浅合并**：同步记录 `yuqueSyncState` 是嵌套结构，它的旧格式升级
 * 由 state.ts 的 migrateSyncState 单独负责，两者不能混在一起做。
 */
export function loadSettingsWithMigration<T extends object>(
  loaded: unknown,
  defaults: T,
): SettingsLoadResult<T> {
  const raw = (loaded && typeof loaded === "object" && !Array.isArray(loaded) ? loaded : {}) as
    Record<string, unknown>;

  const added: string[] = [];
  const merged: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  for (const key of Object.keys(defaults as Record<string, unknown>)) {
    if (!(key in raw)) {
      added.push(key);
      continue;
    }
    const value = raw[key];
    // 值为 undefined / null 时保留默认值：settings 里没有「显式 null」的语义
    if (value !== undefined && value !== null) merged[key] = value;
  }

  const removed: string[] = [];
  for (const key of Object.keys(raw)) {
    if (OBSOLETE_SETTING_KEYS.includes(key)) {
      removed.push(key);
      continue;
    }
    // 不在默认值里、也不是废弃键的历史字段同样丢弃：没人读它，留着只会在每次 saveData 里重复写
    if (!(key in (defaults as Record<string, unknown>))) removed.push(key);
  }

  return { settings: merged as T, removed, added };
}
