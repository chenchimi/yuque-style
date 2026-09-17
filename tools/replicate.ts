/**
 * 离线复刻：与 src/yuque/sync.ts 的写入内容生成流程保持一致。
 *
 * 目的：算出的内容与插件真正写入的内容逐字节相同，hash 基准才可信。
 * 因此这里的每一步都对应 sync.ts 中的同名逻辑。
 * 前言区改为直接导入 src/yuque/frontmatter.ts 的实现（键名、空值跳过、后面那个空行
 * 都必须逐字节一致，各抄一份迟早漂移）；其余私有函数（joinPath / hashUrl /
 * imageExtFromUrl）仍无法从 sync.ts 导入，只能照抄——改动 src 时记得同步这里。
 */
import { convertYuqueBody } from "../src/yuque/lake";
import { propertiesBlock, FM, yuqueTagNames } from "../src/yuque/frontmatter";
import { sanitizeFileName } from "../src/yuque/sync";
import type { YuqueDocSummary } from "../src/yuque/api";
import { normalizePath } from "./obsidian-shim";

function joinPath(...parts: string[]): string {
  return normalizePath(
    parts.filter((p) => p && p.trim() && p !== "/" && p !== ".").join("/"),
  );
}

function hashUrl(url: string): string {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function imageExtFromUrl(url: string): string {
  try {
    const m = decodeURIComponent(url).match(/\.(png|jpe?g|gif|webp|svg|bmp|ico)(?:[?#]|$)/i);
    if (m) {
      const ext = m[1].toLowerCase();
      return ext === "jpeg" ? "jpg" : ext;
    }
  } catch {
    /* ignore */
  }
  return "png";
}

export function buildSlugToTitle(targets: YuqueDocSummary[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of targets) m.set(t.slug, sanitizeFileName(t.title));
  return m;
}

export interface BuildContentArgs {
  ns: string;
  slug: string;
  title: string;
  updatedAt: string;
  /** 语雀文档 ID（详情或列表接口给出），与 createdAt 一样属于「非时间敏感」字段 */
  id?: string;
  createdAt?: string;
  /** 语雀标签原始值；接口不返回时留空，与同步一样不写这个键 */
  tags?: unknown;
  body: string;
  /** 本地路径（不含 .md），决定图片相对路径的上跳层数 */
  basePath: string;
  targetFolder: string;
  assetsFolder: string;
  downloadImages: boolean;
  targets: YuqueDocSummary[];
  slugToTitle: Map<string, string>;
}

export interface BuildContentResult {
  content: string;
  warnings: string[];
  /** 命中的语雀图片 URL → 期望的本地资源路径 */
  images: { url: string; assetPath: string; rel: string }[];
}

export function buildDocContent(args: BuildContentArgs): BuildContentResult {
  const {
    ns,
    slug,
    title,
    updatedAt,
    id,
    createdAt,
    tags,
    body,
    basePath,
    targetFolder,
    assetsFolder,
    downloadImages,
    targets,
    slugToTitle,
  } = args;

  // 探针没有插件设置上下文，按默认设置「文字颜色 = 不输出」估算
  const r = convertYuqueBody(body || "", "drop");

  // 文档属性始终写入（用户只能控制显不显示），此处与同步写入保持一致
  let content =
    propertiesBlock({
      [FM.title]: title,
      [FM.source]: `https://www.yuque.com/${ns}/${slug}`,
      [FM.id]: id ?? "",
      [FM.createdAt]: createdAt ?? "",
      [FM.updatedAt]: updatedAt,
      [FM.tags]: yuqueTagNames(tags),
    }) + r.markdown;

  // 内部链接 → Obsidian 双链（同知识库内指向已同步文档）
  content = content.replace(
    /\[([^\]]*)\]\(https?:\/\/(?:www\.)?yuque\.com\/([^)\s/]+)\/([^)\s/?"#]+)[^)]*\)/g,
    (full, text, linkNs, linkSlug) => {
      if (linkNs === ns && slugToTitle.has(linkSlug) && targets.some((t) => t.slug === linkSlug)) {
        const target = slugToTitle.get(linkSlug)!;
        return text && text !== target ? `[[${target}|${text}]]` : `[[${target}]]`;
      }
      return full;
    },
  );

  // 图片本地化（只算路径，不下载：下载与否已由 vault 现状决定）
  const images: BuildContentResult["images"] = [];
  if (downloadImages) {
    const assetsRoot = joinPath(targetFolder, assetsFolder || "assets");
    content = content.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (full, alt, url) => {
      if (!/yuque|nlark|alicdn/.test(url)) return full;
      const ext = imageExtFromUrl(url);
      const fileName = `yuque-${hashUrl(url)}.${ext}`;
      const assetPath = `${assetsRoot}/${fileName}`;
      const docFolder = basePath.includes("/")
        ? basePath.slice(0, basePath.lastIndexOf("/"))
        : "";
      let rel = normalizePath(assetsRoot);
      if (docFolder) {
        const up = docFolder.split("/").length;
        rel = "../".repeat(up) + assetsRoot;
      }
      rel = normalizePath(rel) + "/" + fileName;
      images.push({ url, assetPath, rel });
      return `![${alt}](${rel})`;
    });
  }

  return { content, warnings: r.warnings, images };
}
