import type { App } from "obsidian";
import { readFm } from "./frontmatter";

/**
 * 语雀文档链接 → Obsidian 双链。
 *
 * 关键点：解析范围是**整个 vault**，不限知识库。语雀里跨库互相引用非常常见
 * （实测 vault 里 176 条文档链接横跨 10+ 个知识库），只认「同库」等于绝大多数都转不了。
 *
 * 映射表（语雀地址 → 本地文件）优先用每篇文档属性的「来源」字段建索引
 * （旧文档是英文键 `source`，readFm 会回退读取），再并上同步记录。
 * **故意不依赖同步状态**：状态一旦被「清除增量同步记录」清空，
 * 只靠状态的方案就会整表变空、一条都转不了。
 *
 * 本模块是纯字符串逻辑，不碰 Obsidian 运行时（App 只作类型引用），便于单测。
 */

/** 语雀文档地址：登录名/仓库/文档，正好是三段 */
export interface YuqueRef {
  /** 登录名/仓库/文档 —— 与同步记录的 key 完全一致 */
  key: string;
  ns: string;
  slug: string;
}

export interface LinkTarget {
  /** vault 相对路径（不含 .md）；为空表示这篇还没落盘 */
  path: string;
  /** 文件名（不含 .md） */
  basename: string;
}

export type LinkIndex = Map<string, LinkTarget>;

export interface ConvertResult {
  content: string;
  /** 本次实际转换的链接条数 */
  converted: number;
}

const YUQUE_HOST = /^https?:\/\/(?:www\.)?yuque\.com\//i;

/**
 * 语雀链接 → { ns, slug }。不是文档链接就返回 null。
 *
 * 三种必须拒绝的情况：
 * - 附件：`yuque.com/attachments/yuque/0/2026/xmind/….xmind`（实测 vault 里有 62 条）。
 *   它也是「三段以上」的语雀地址，不显式排除就会靠巧合才不误伤。
 * - 段数不是 3（仓库主页、各类设置页等）
 * - 非语雀域名
 */
export function resolveYuqueUrl(url: string): YuqueRef | null {
  if (!YUQUE_HOST.test(url)) return null;
  // 丢掉查询串与锚点：语雀的锚点是 slug 化的（#a1b2c3），
  // 而 Obsidian 的 [[文件#标题]] 需要标题原文，对不上，索性不带
  const path = url
    .replace(YUQUE_HOST, "")
    .split(/[?#]/)[0]
    .replace(/\/+$/, "");
  const seg = path.split("/").filter((s) => s !== "");
  if (seg.length !== 3) return null;
  if (seg[0].toLowerCase() === "attachments") return null;
  return { key: seg.join("/"), ns: `${seg[0]}/${seg[1]}`, slug: seg[2] };
}

export function basenameOf(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return file.endsWith(".md") ? file.slice(0, -3) : file;
}

/** 双链目标不带后缀；Obsidian 的 file.path 带 .md，同步记录的 path 不带，统一掉 */
export function stripMd(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -3) : path;
}

export function countBasenames(names: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

export interface VaultSourceDoc {
  path: string;
  /** frontmatter 里的 source（语雀原文地址） */
  source: string;
}

/** 从 vault 取「路径 + frontmatter 来源」，作为建索引的原始数据 */
export function collectVaultDocs(app: App): VaultSourceDoc[] {
  return app.vault.getMarkdownFiles().map((file) => {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter as
      | Record<string, unknown>
      | undefined;
    // 属性键名已统一为中文「来源」；readFm 会回退旧英文键，存量文档也能建上索引
    const source = readFm<string>(fm, "source") ?? "";
    return { path: file.path, source: typeof source === "string" ? source : "" };
  });
}

/** 用 frontmatter 的 source 建「语雀地址 → 本地文件」索引 */
export function buildLinkIndex(docs: VaultSourceDoc[]): LinkIndex {
  const index: LinkIndex = new Map();
  for (const doc of docs) {
    if (!doc.source) continue;
    const ref = resolveYuqueUrl(doc.source);
    if (!ref) continue;
    // 同一个地址出现多次（文件被复制）时保留第一个，避免索引结果随机
    if (!index.has(ref.key)) {
      index.set(ref.key, { path: stripMd(doc.path), basename: basenameOf(doc.path) });
    }
  }
  return index;
}

/** 并上同步记录：老文件可能没有 source（或已被改动），记录里的 path 是兜底 */
export function mergeStateIntoIndex(
  index: LinkIndex,
  state: Record<string, { path?: string } | undefined>,
): void {
  for (const [key, rec] of Object.entries(state)) {
    if (!rec?.path) continue;
    if (index.has(key)) continue;
    index.set(key, { path: stripMd(rec.path), basename: basenameOf(rec.path) });
  }
}

/** 别名里出现 | 或 ]] 会让整条链接碎掉；此时退回不带别名的最简形式 */
function safeAlias(text: string, targetName: string): string {
  const alias = text.replace(/\s+/g, " ").trim();
  if (!alias || alias === targetName) return "";
  if (alias.includes("|") || alias.includes("]]") || alias.includes("[[")) return "";
  return alias;
}

/**
 * 生成双链，写法对齐 Obsidian 自己的「最短路径」策略：
 * 文件名在 vault 内唯一就用 `[[标题]]`，撞车才加长成 `[[路径|别名]]`。
 * 撞车时**一定带别名**，否则 Obsidian 会把整条路径当成显示文字。
 */
export function buildInternalLink(target: LinkTarget, text: string, unique: boolean): string {
  // 目标还没落盘（没有路径）时只能退回短链接
  if (unique || !target.path) {
    const alias = safeAlias(text, target.basename);
    return alias ? `[[${target.basename}|${alias}]]` : `[[${target.basename}]]`;
  }
  const alias = safeAlias(text, target.basename) || target.basename;
  return `[[${target.path}|${alias}]]`;
}

/** 匹配 markdown 链接；`(?<!!)` 排除图片 `![](…)`，免得把文档嵌成图片 */
const MD_LINK = /(?<!!)\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;

function replaceLinksInLine(
  line: string,
  index: LinkIndex,
  counts: Map<string, number>,
): { line: string; converted: number } {
  let converted = 0;
  const next = line.replace(MD_LINK, (full, text: string, url: string) => {
    const ref = resolveYuqueUrl(url);
    if (!ref) return full;
    const target = index.get(ref.key);
    if (!target) return full; // 目标没同步过 → 保持外部链接，指向不存在的本地文件没意义
    converted++;
    return buildInternalLink(target, text, (counts.get(target.basename) ?? 0) <= 1);
  });
  return { line: next, converted };
}

/**
 * 把正文里的语雀文档链接换成本地双链。
 * 跳过 frontmatter（source 是建索引的原料，不能动）与围栏代码块（里面的 URL 是示例文本）。
 */
export function convertLinksInContent(
  content: string,
  index: LinkIndex,
  counts: Map<string, number>,
): ConvertResult {
  const lines = content.split("\n");
  const out: string[] = [];
  let inFrontmatter = lines.length > 0 && lines[0].trim() === "---";
  let fence: string | null = null;
  let converted = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inFrontmatter) {
      out.push(line);
      if (i > 0 && line.trim() === "---") inFrontmatter = false;
      continue;
    }
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      out.push(line);
      continue;
    }
    if (fence !== null) {
      out.push(line);
      continue;
    }
    const r = replaceLinksInLine(line, index, counts);
    converted += r.converted;
    out.push(r.line);
  }
  return { content: out.join("\n"), converted };
}
