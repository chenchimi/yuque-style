/**
 * 文档属性（frontmatter）的键名、读取与就地修改。
 *
 * - 键名统一用中文：Obsidian 的「属性」面板直接显示键名，中文才与插件其余界面一致
 * - 读取一律走 readFm（优先中文键、回退旧英文键），改名不会让旧文档失效
 * - 只改前言的相应行，正文一个字节都不动
 *
 * 用途是「补齐文档属性」：已同步的文档会被增量同步跳过（远端 updated_at 没变
 * 且本地文件在），所以新字段永远写不进去，只能就地补；旧英文键也要就地改名。
 *
 * 本模块是纯字符串逻辑，不依赖 Obsidian，便于单测。
 */

export interface FrontmatterPatchResult {
  content: string;
  /** 实际补上的字段名 */
  added: string[];
}

/** 取前言区一行的键名（属性键含中文，不能用 [A-Za-z0-9_] 限定） */
function keyOf(line: string): string | null {
  const m = line.match(/^([^\s:]+)\s*:/);
  return m ? m[1] : null;
}

/** 拆出前言区的行；没有合格前言区（缺首行或收尾分隔线）返回 null */
function splitFrontmatter(content: string): { head: string[]; rest: string } | null {
  const lines = content.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      // rest 从收尾分隔线开始，重建时原样拼回
      return { head: lines.slice(1, i), rest: lines.slice(i).join("\n") };
    }
  }
  return null;
}

function renderField(key: string, value: string | string[]): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    return [`${key}:`, ...value.map((v) => `  - ${String(v).replace(/"/g, '\\"')}`)];
  }
  if (!value) return [];
  return [`${key}: ${value.replace(/"/g, '\\"')}`];
}

/**
 * 补上尚不存在的字段；**已存在的同名字段一律不覆盖**——
 * 那可能是用户在本地改过的值，同步覆盖已经够麻烦了，补元数据不该再抹一次。
 *
 * 返回 null 表示：没有合格前言区，或没有需要补的字段（幂等，重复跑无副作用）。
 */
export function addMissingFrontmatterFields(
  content: string,
  fields: Record<string, string | string[]>,
): FrontmatterPatchResult | null {
  const parts = splitFrontmatter(content);
  if (!parts) return null;

  // 注意：键名可能含中文（见 FM），这里不能用 ASCII 限定，否则中文键会被当成不存在而重复写入
  const existing = new Set(parts.head.map(keyOf).filter((key): key is string => !!key));

  const added: string[] = [];
  const extra: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (existing.has(key)) continue;
    const rendered = renderField(key, value);
    if (rendered.length === 0) continue;
    extra.push(...rendered);
    added.push(key);
  }
  if (added.length === 0) return null;

  const head = [...parts.head, ...extra].join("\n");
  return { content: `---\n${head}\n${parts.rest}`, added };
}

/**
 * 语雀标签名。
 * 官方文档站没给出文档接口的字段清单（响应示例是空的），所以这里防御性读取：
 * 拿不到就返回空数组，调用方据此跳过这个字段——宁可没有，也不写一个空字段。
 */
export function yuqueTagNames(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => {
      if (typeof t === "string") return t;
      const o = t as { name?: unknown; title?: unknown } | null;
      const v = o?.name ?? o?.title;
      return typeof v === "string" ? v : "";
    })
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 文档属性键名。统一用中文——Obsidian 的「属性」面板直接把键名显示给用户，
 * 英文键（yuque_created_at 之类）既与插件其余中文界面对不上，还会被面板截断成
 * 「yuque_create…」，看不出是什么。
 */
export const FM = {
  title: "标题",
  source: "来源",
  id: "语雀ID",
  createdAt: "语雀创建时间",
  updatedAt: "语雀更新时间",
  tags: "语雀标签",
} as const;

export type FmKey = keyof typeof FM;

/** 旧版英文键（v0.6.1 及以前写入）：读取时回退，迁移时就地改名 */
export const LEGACY_FM: Record<FmKey, string> = {
  title: "title",
  source: "source",
  id: "yuque_id",
  createdAt: "yuque_created_at",
  updatedAt: "yuque_updated_at",
  tags: "yuque_tags",
};

/**
 * 读文档属性：优先中文键，回退旧英文键。
 * 存量文档在跑过「补齐文档属性」之前仍是英文键，有回退才不会因改名而丢信息。
 */
export function readFm<T = unknown>(
  fm: Record<string, unknown> | null | undefined,
  key: FmKey,
): T | undefined {
  if (!fm) return undefined;
  const fresh = fm[FM[key]];
  if (fresh !== undefined) return fresh as T;
  const legacy = fm[LEGACY_FM[key]];
  return legacy === undefined ? undefined : (legacy as T);
}

/** 旧键 → 中文键 */
function legacyKeyMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const key of Object.keys(FM) as FmKey[]) map[LEGACY_FM[key]] = FM[key];
  return map;
}

/**
 * 把前言的旧英文键改名为中文键，**就地改**以保持字段顺序（属性面板的显示顺序不变）。
 * 目标中文键已存在时删掉旧行——同一个属性不能留两份。
 * 返回 null 表示没有可改的行（幂等，重复跑无副作用）。
 */
export function renameLegacyFrontmatterKeys(content: string): FrontmatterPatchResult | null {
  const parts = splitFrontmatter(content);
  if (!parts) return null;

  const map = legacyKeyMap();
  const present = new Set(parts.head.map(keyOf).filter((k): k is string => !!k));
  const kept: string[] = [];
  const renamed: string[] = [];

  for (const line of parts.head) {
    const key = keyOf(line);
    const to = key ? map[key] : undefined;
    if (!key || !to) {
      kept.push(line);
      continue;
    }
    renamed.push(key);
    if (present.has(to)) continue;
    kept.push(line.replace(/^([^\s:]+)(\s*:)/, `${to}$2`));
  }

  if (renamed.length === 0) return null;
  return { content: `---\n${kept.join("\n")}\n${parts.rest}`, added: renamed };
}

/**
 * 属性面板里可单独控制显示的语雀属性。
 *
 * 属性**始终写在文件里**，这里只决定它在 Obsidian 顶部的属性面板中显不显示。
 * 不含「语雀标签」：语雀文档接口实测不返回标签，这个属性永远不会出现。
 *
 * `slug` 是存进 data.json 的稳定标识（改名会让用户已有的开关失效）；
 * `label` 必须与 FM 的中文键一致——隐藏用的 CSS 按它匹配，不一致就会「隐藏了却还在」。
 */
export const PROPERTY_TOGGLES: ReadonlyArray<{ slug: string; label: string }> = [
  { slug: "title", label: FM.title },
  { slug: "source", label: FM.source },
  { slug: "id", label: FM.id },
  { slug: "created", label: FM.createdAt },
  { slug: "updated", label: FM.updatedAt },
];

/**
 * 真正要隐藏的属性清单。「文档头信息」是总开关：关掉它时全部隐藏，
 * 逐个开关此时不起作用（设置界面里也会把它们置灰）。
 *
 * 抽成纯函数是为了能单测——总开关与逐个开关的组合最容易写反。
 */
export function hiddenSlugsFor(showDocHeader: boolean, hidden: string[]): string[] {
  return showDocHeader ? hidden : PROPERTY_TOGGLES.map((t) => t.slug);
}

/**
 * 是否该把整块属性面板都收起来。
 *
 * 全部属性都隐藏时，Obsidian 仍会画出容器本身——只剩一个「笔记属性」标题和
 * 「+ 添加笔记属性」按钮，看起来像没生效。此时连容器一起隐藏。
 */
export function hidesWholePanel(showDocHeader: boolean, hidden: string[]): boolean {
  return hiddenSlugsFor(showDocHeader, hidden).length >= PROPERTY_TOGGLES.length;
}

/** slug → 要隐藏的键名（中文键 + 旧英文键，未迁移的存量文档才能立即生效） */
export function propertyHideKeys(slug: string): string[] {
  const hit = PROPERTY_TOGGLES.find((t) => t.slug === slug);
  if (!hit) return [];
  const fmKey = (Object.keys(FM) as FmKey[]).find((k) => FM[k] === hit.label);
  if (!fmKey) return [hit.label];
  return [FM[fmKey], LEGACY_FM[fmKey]];
}

/**
 * 生成「隐藏指定属性」的 CSS。
 *
 * 用 CSS 而不是不写入文件：属性要一直存在（文档头、双链索引、Dataview 都依赖它），
 * 只是不占版面。两个已知边界（都是文本层的东西，插件无权隐藏）：
 * 源码模式下仍会看到 YAML 原文；属性对其它插件依然可读。
 *
 * **关键细节**：Obsidian 建属性行时写的是
 * `containerEl.setAttr("data-property-key", key.toLowerCase())`（见官方 obsidian.asar），
 * 键名被强制转成小写。所以 `语雀ID` 在 DOM 里是 `语雀id`，
 * 拿原始键名去匹配会「关了没反应」——这里必须 lowerCase。纯中文键不受影响，
 * 含 ASCII 的键（语雀ID）才会踩到。
 *
 * 顺带说明为什么在这里生成而不写死在 styles.css：属性和旧英文键的对应关系
 * 定义在 FM / LEGACY_FM，写死一份迟早漂移；这里生成就能被单测守住。
 */
export function buildPropertyVisibilityCss(
  hiddenSlugs: string[],
  hideWholePanel = false,
): string {
  const rules: string[] = [];
  for (const slug of hiddenSlugs) {
    const keys = propertyHideKeys(slug);
    if (keys.length === 0) continue;
    const selectors = keys
      .map((key) => `.metadata-property[data-property-key="${key.toLowerCase()}"]`)
      .join(",\n");
    rules.push(`${selectors} {\n  display: none;\n}`);
  }

  if (hideWholePanel) {
    // 只隐藏属性行会留下一个空的「笔记属性」标题与「+ 添加笔记属性」按钮，看着像没生效，
    // 所以连容器一起收：容器、行容器、标题、添加按钮四个都点名，
    // 这样即使某个版本的容器类名不同，空壳也留不下来。
    // 这些规则走注入的 <style> 而不是 styles.css：注入那份已实测生效，
    // 且不依赖 Obsidian 是否重新读取了插件的样式文件。
    const shell = [
      ".metadata-container",
      ".metadata-properties",
      ".metadata-properties-heading",
      ".metadata-add-button",
    ]
      .map((sel) => `body.yuque-hide-all-props ${sel}`)
      .join(",\n");
    rules.push(`${shell} {\n  display: none !important;\n}`);
  }

  return rules.length === 0 ? "" : `/* yuque-style：按设置隐藏笔记属性 */\n${rules.join("\n")}\n`;
}

/** 生成 YAML 前言区；数组写成 YAML 列表，空值一律跳过 */
export function buildFrontmatter(fields: Record<string, string | string[]>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${String(item).replace(/"/g, '\\"')}`);
    } else if (value) {
      lines.push(`${key}: ${value.replace(/"/g, '\\"')}`);
    }
  }
  if (lines.length === 0) return "";
  return `---\n${lines.join("\n")}\n---\n`;
}

/**
 * 文档属性块（前言区 + 其后空行）。属性始终写入文件，
 * 用户能控制的只是「在属性面板里显不显示」（见 PROPERTY_TOGGLES）。
 *
 * 放在这里而不是 sync.ts：同步写入、补齐命令、离线探针（tools/replicate.ts）
 * 必须给出**逐字节相同**的内容，否则探针的 A/B 分类会凭空多出一堆「内容差异」。
 */
export function propertiesBlock(fields: Record<string, string | string[]>): string {
  const block = buildFrontmatter(fields);
  return block ? `${block}\n` : "";
}

export interface EnsureFrontmatterResult extends FrontmatterPatchResult {
  /** 就地改名的旧英文键（空数组 = 没有旧键） */
  renamed: string[];
}

/**
 * 补齐命令的核心：让一份文档拥有给定的属性。
 *
 * 三种情况一并处理：
 * 1. 有前言区、缺字段 → 追加（不覆盖已有值，用户改过的不动）
 * 2. 有前言区但是旧英文键 → 就地改名后再补
 * 3. **连前言区都没有**（属性曾被整体清理过）→ 整块新建后接在正文前
 *
 * 第 3 种是必须支持的：清理把 `--- … ---` 整块删掉后，
 * 只认「有前言区」的实现会永远补不回来。返回 null = 无需改动（幂等）。
 */
export function ensureFrontmatterFields(
  content: string,
  fields: Record<string, string | string[]>,
): EnsureFrontmatterResult | null {
  const hasFrontmatter = content.startsWith("---");
  const renamed = hasFrontmatter ? renameLegacyFrontmatterKeys(content) : null;
  const base = renamed?.content ?? content;

  const patch = addMissingFrontmatterFields(base, fields);
  if (patch) return { ...patch, renamed: renamed?.added ?? [] };
  if (renamed) return { ...renamed, renamed: renamed.added };

  if (!hasFrontmatter) {
    const block = propertiesBlock(fields);
    if (!block) return null;
    return { content: `${block}${content}`, added: Object.keys(fields), renamed: [] };
  }
  return null;
}
