import { App, normalizePath, TFile } from "obsidian";
import { YuqueApi, YuqueDocSummary, YuqueTocNode } from "./api";
import { convertYuqueBody } from "./lake";
import type { YuqueStylePlugin } from "../main";

export type SyncLogFn = (msg: string, type?: "info" | "success" | "error") => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 文件名非法字符清洗 */
export function sanitizeFileName(name: string): string {
  let n = (name || "")
    .replace(/[\\/:*?"<>|#^\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!n) n = "未命名文档";
  return n;
}

/** 递归创建文件夹（已存在则忽略） */
export async function ensureFolder(app: App, folder: string): Promise<void> {
  const path = normalizePath(folder);
  if (!path || path === "/" || path === ".") return;
  const parts = path.split("/");
  let cur = "";
  for (const part of parts) {
    if (!part) continue;
    cur = cur ? `${cur}/${part}` : part;
    try {
      if (!(await app.vault.adapter.exists(cur))) {
        await app.vault.adapter.mkdir(cur);
      }
    } catch {
      // 已存在等情况忽略
    }
  }
}

function joinPath(...parts: string[]): string {
  return parts.filter((p) => p && p.trim() && p !== "/" && p !== ".").join("/");
}

/** 由 TOC 构建 slug → 所在文件夹路径（含父级 TITLE 节点形成的层级） */
export function buildTocFolders(
  toc: YuqueTocNode[],
): Map<string, string> {
  const byUuid = new Map<string, YuqueTocNode>();
  for (const n of toc) byUuid.set(n.uuid, n);
  const slugToFolder = new Map<string, string>();
  for (const n of toc) {
    if (n.type !== "DOC" || !n.slug) continue;
    const segs: string[] = [];
    let cur: YuqueTocNode | undefined = n;
    const guard = new Set<string>();
    while (cur && cur.parent_uuid && !guard.has(cur.parent_uuid)) {
      guard.add(cur.parent_uuid);
      const parent = byUuid.get(cur.parent_uuid);
      if (!parent) break;
      if (parent.type !== "DOC" && parent.title) segs.unshift(sanitizeFileName(parent.title));
      cur = parent;
    }
    slugToFolder.set(n.slug, segs.join("/"));
  }
  return slugToFolder;
}

/** 简单字符串 hash，用于图片文件命名 */
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

/** 生成 YAML frontmatter */
function buildFrontmatter(fields: Record<string, string>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v.replace(/"/g, '\\"')}`);
  if (lines.length === 0) return "";
  return `---\n${lines.join("\n")}\n---\n`;
}

interface StagedDoc {
  slug: string;
  title: string;
  /** vault 内完整路径（不含扩展名） */
  basePath: string;
  content: string;
  updated_at: string;
  warnings: string[];
}

/**
 * 同步单个任务：拉取文档 → Lake 转 Markdown → 内链改写 → 图片本地化 → 写入 vault。
 * 增量策略：settings.yuqueSyncState 中记录的 updated_at 与列表一致且本地文件存在则跳过。
 */
export async function syncTask(
  plugin: YuqueStylePlugin,
  api: YuqueApi,
  task: YuqueSyncTaskType,
  log: SyncLogFn,
): Promise<void> {
  const settings = plugin.settings;
  const ns = task.namespace;
  const retryLog: (waitSec: number, attempt: number) => void = (waitSec, attempt) =>
    log(`语雀 API 限流，${waitSec} 秒后自动重试（第 ${attempt} 次）…`);

  log(`正在获取知识库目录「${task.repoName}」…`);
  let toc = await api.getToc(ns, retryLog);
  let docList = await api.getDocListOnce(ns);

  // docs 空但 toc 有内容：按 TOC url 里的 namespace 重试一次（复用已取的 toc，不重复请求）
  if (docList.length === 0 && toc.length > 0) {
    for (const node of toc) {
      const m = node.url?.match(/^\/([^/]+)\/([^/]+)/);
      if (m && m[1] && m[1] !== ns) {
        const retry = await api.getDocListOnce(m[1]);
        if (retry.length > 0) {
          log(`按 TOC 中的 namespace（${m[1]}）重新获取文档列表成功：${retry.length} 篇`, "success");
          docList = retry;
        }
        break;
      }
    }
  }

  // 仍为空且知道数字 ID：按 ID 重试（绕过 namespace 路由问题）
  if (toc.length === 0 && docList.length === 0 && task.repoId) {
    log(`以 namespace 获取为空，尝试知识库 ID（${task.repoId}）…`);
    try {
      const tocById = await api.getToc(String(task.repoId), retryLog);
      const docsById = await api.getDocListOnce(String(task.repoId));
      if (tocById.length > 0 || docsById.length > 0) {
        toc = tocById;
        docList = docsById;
        log(`✓ ID 访问成功：目录 ${toc.length} 节点，文档列表 ${docList.length} 篇`, "success");
      }
    } catch (e) {
      log(`ID 访问失败：${(e as Error).message}`, "error");
    }
  }

  const tocFolders = buildTocFolders(toc);
  log(`目录（TOC）节点数：${toc.length}`);

  const docBySlug = new Map<string, YuqueDocSummary>();
  for (const d of docList) docBySlug.set(d.slug, d);

  if (docList.length === 0 && toc.length > 0) {
    // 兜底：直接用 TOC 中的 DOC 节点构造文档清单（无 updated_at，全部视为待更新）
    const tocDocs: YuqueDocSummary[] = toc
      .filter((n) => n.type === "DOC" && n.slug)
      .map((n) => ({
        id: 0,
        slug: n.slug!,
        title: n.title,
        updated_at: "",
      }));
    if (tocDocs.length > 0) {
      log(`文档列表为空，改按目录节点同步 ${tocDocs.length} 篇文档…`);
      for (const d of tocDocs) {
        if (!docBySlug.has(d.slug)) {
          docBySlug.set(d.slug, d);
          docList.push(d); // 必须进 docList，否则 targets 不会包含它们
        }
      }
    }
  }

  if (docList.length === 0) {
    log(
      `⚠ 目录与文档列表均为空：「${task.repoName}」可能是空知识库，或 Token 无权读取它。` +
        `请确认该知识库在语雀网页中确实有文档，且 Token 勾选了读取权限`,
      "error",
    );
  }

  // 确定同步目标
  let targets: YuqueDocSummary[];
  if (task.mode === "selected") {
    targets = task.selectedDocs
      .map((sd) => docBySlug.get(sd.slug))
      .filter((d): d is YuqueDocSummary => !!d);
    const missing = task.selectedDocs.filter((sd) => !docBySlug.has(sd.slug));
    if (missing.length > 0) log(`警告：${missing.length} 篇所选文档已不存在`, "error");
  } else {
    // 按语雀目录树（TOC）顺序排列，与语雀左侧目录一致；
    // 不在目录中的文档（草稿/未加入目录）排在最后
    const tocOrder = new Map<string, number>();
    toc.forEach((n, i) => {
      if (n.slug && !tocOrder.has(n.slug)) tocOrder.set(n.slug, i);
    });
    const inToc: YuqueDocSummary[] = [];
    const notInToc: YuqueDocSummary[] = [];
    for (const d of docList) (tocOrder.has(d.slug) ? inToc : notInToc).push(d);
    inToc.sort((a, b) => (tocOrder.get(a.slug) ?? 0) - (tocOrder.get(b.slug) ?? 0));
    targets = [...inToc, ...notInToc];
    if (notInToc.length > 0) log(`${notInToc.length} 篇文档未加入语雀目录，排在最后`);
  }

  // 增量过滤
  const state = settings.yuqueSyncState || {};
  const pending: YuqueDocSummary[] = [];
  let skipped = 0;
  for (const d of targets) {
    const key = `${ns}/${d.slug}`;
    const basePath = joinPath(
      task.targetFolder,
      tocFolders.get(d.slug) || "",
      sanitizeFileName(d.title),
    );
    const file = plugin.app.vault.getAbstractFileByPath(`${basePath}.md`);
    if (state[key] === d.updated_at && file instanceof TFile) {
      skipped++;
      continue;
    }
    pending.push(d);
  }
  log(`共 ${targets.length} 篇，需更新 ${pending.length} 篇，跳过未变化 ${skipped} 篇`);

  // 拉取并转换
  const staged: StagedDoc[] = [];
  for (const d of pending) {
    try {
      const detail = await api.getDoc(ns, d.slug);
      const result = convertYuqueBody(detail.body || "");
      const folder = joinPath(task.targetFolder, tocFolders.get(d.slug) || "");
      const frontmatter = buildFrontmatter({
        title: detail.title,
        source: `https://www.yuque.com/${ns}/${d.slug}`,
        yuque_updated_at: detail.updated_at,
      });
      staged.push({
        slug: d.slug,
        title: detail.title || d.title,
        basePath: joinPath(folder, sanitizeFileName(detail.title || d.title)),
        content: frontmatter + "\n" + result.markdown,
        updated_at: d.updated_at,
        warnings: result.warnings,
      });
      for (const w of result.warnings) log(`  ⚠ ${d.title}：${w}`);
    } catch (e) {
      log(`拉取失败「${d.title}」：${(e as Error).message}`, "error");
    }
  }
  if (staged.length === 0) {
    log("没有需要写入的文档", "info");
    return;
  }

  // 内部链接 → Obsidian 双链（同知识库内指向已同步文档）
  const slugToTitle = new Map<string, string>();
  for (const t of targets) slugToTitle.set(t.slug, sanitizeFileName(t.title));
  for (const doc of staged) {
    doc.content = doc.content.replace(
      /\[([^\]]*)\]\(https?:\/\/(?:www\.)?yuque\.com\/([^)\s/]+)\/([^)\s/?"#]+)[^)]*\)/g,
      (full, text, linkNs, linkSlug) => {
        if (linkNs === ns && slugToTitle.has(linkSlug) && targets.some((t) => t.slug === linkSlug)) {
          const target = slugToTitle.get(linkSlug)!;
          return text && text !== target ? `[[${target}|${text}]]` : `[[${target}]]`;
        }
        return full;
      },
    );
  }

  // 图片本地化
  if (settings.yuqueDownloadImages) {
    const assetsRoot = joinPath(task.targetFolder, settings.yuqueAssetsFolder || "assets");
    await ensureFolder(plugin.app, assetsRoot);
    let done = 0;
    for (const doc of staged) {
      const matches = Array.from(doc.content.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g));
      for (const m of matches) {
        const [full, alt, url] = m;
        if (!/yuque|nlark|alicdn/.test(url)) continue; // 仅下载语雀系 CDN
        const ext = imageExtFromUrl(url);
        const fileName = `yuque-${hashUrl(url)}.${ext}`;
        const assetPath = `${assetsRoot}/${fileName}`;
        try {
          if (!(await plugin.app.vault.adapter.exists(assetPath))) {
            const buf = await api.downloadBinary(url);
            await plugin.app.vault.adapter.writeBinary(assetPath, buf);
          }
          // 相对路径（相对 md 文件所在目录）
          const docFolder = doc.basePath.includes("/")
            ? doc.basePath.slice(0, doc.basePath.lastIndexOf("/"))
            : "";
          let rel = normalizePath(assetsRoot);
          if (docFolder) {
            const up = docFolder.split("/").length;
            rel = "../".repeat(up) + assetsRoot;
          }
          rel = normalizePath(rel) + "/" + fileName;
          doc.content = doc.content.split(full).join(`![${alt}](${rel})`);
          done++;
        } catch (e) {
          log(`  ⚠ 图片下载失败（保留远程链接）：${(e as Error).message}`, "error");
        }
      }
    }
    if (done > 0) log(`已本地化 ${done} 张图片 → ${assetsRoot}/`);
  }

  // 写入文件
  let written = 0;
  for (const doc of staged) {
    const filePath = `${doc.basePath}.md`;
    try {
      if (doc.basePath.includes("/")) {
        await ensureFolder(plugin.app, doc.basePath.slice(0, doc.basePath.lastIndexOf("/")));
      }
      const existing = plugin.app.vault.getAbstractFileByPath(filePath);
      if (existing instanceof TFile) {
        await plugin.app.vault.modify(existing, doc.content);
      } else {
        await plugin.app.vault.create(filePath, doc.content);
      }
      state[`${ns}/${doc.slug}`] = doc.updated_at;
      written++;
    } catch (e) {
      log(`写入失败「${doc.title}」：${(e as Error).message}`, "error");
    }
  }
  settings.yuqueSyncState = state;
  await plugin.saveSettings();
  log(`「${task.repoName}」完成：写入/更新 ${written} 篇`, "success");

  // 生成/更新「知识库目录」索引页：按语雀目录树的原始顺序，带层级缩进与双链
  if (toc.length > 0 && task.mode === "all") {
    try {
      const slugToTitle = new Map<string, string>();
      for (const t of targets) slugToTitle.set(t.slug, sanitizeFileName(t.title));
      const byUuid = new Map<string, YuqueTocNode>();
      for (const n of toc) byUuid.set(n.uuid, n);
      const lines: string[] = [`# ${task.repoName} · 知识库目录`, ""];
      for (const n of toc) {
        // 层级：沿 parent_uuid 数深度（TITLE 分组节点与 DOC 节点都算一层）
        let depth = 0;
        let cur: YuqueTocNode | undefined = n;
        const guard = new Set<string>();
        while (cur?.parent_uuid && !guard.has(cur.parent_uuid)) {
          guard.add(cur.parent_uuid);
          cur = byUuid.get(cur.parent_uuid);
          depth++;
        }
        const indent = "  ".repeat(depth);
        if (n.type === "DOC" && n.slug && slugToTitle.has(n.slug)) {
          lines.push(`${indent}- [[${slugToTitle.get(n.slug)}|${n.title}]]`);
        } else if (n.title) {
          lines.push(`${indent}- **${n.title}**`);
        }
      }
      const indexContent = buildFrontmatter({
        title: `${task.repoName} 知识库目录`,
        source: `https://www.yuque.com/${ns}`,
      }) + `\n${lines.join("\n")}\n`;
      const indexPath = joinPath(task.targetFolder, `${sanitizeFileName(task.repoName)} 目录.md`);
      if (indexPath.includes("/")) {
        await ensureFolder(plugin.app, indexPath.slice(0, indexPath.lastIndexOf("/")));
      }
      const existingIndex = plugin.app.vault.getAbstractFileByPath(indexPath);
      if (existingIndex instanceof TFile) {
        await plugin.app.vault.modify(existingIndex, indexContent);
      } else {
        await plugin.app.vault.create(indexPath, indexContent);
      }
      log(`已更新知识库目录索引：${indexPath}`, "success");
    } catch (e) {
      log(`目录索引生成失败：${(e as Error).message}`, "error");
    }
  }
}

/** 同步全部任务 */
export async function syncAllTasks(
  plugin: YuqueStylePlugin,
  log: SyncLogFn,
): Promise<void> {
  const settings = plugin.settings;
  if (!settings.yuqueToken) {
    log("请先在插件设置中填写语雀 Token", "error");
    return;
  }
  if (!settings.yuqueTasks || settings.yuqueTasks.length === 0) {
    log("还没有同步任务，请先在设置或用「添加语雀同步任务」命令创建", "error");
    return;
  }
  const api = new YuqueApi(settings.yuqueToken);
  for (const task of settings.yuqueTasks) {
    try {
      await syncTask(plugin, api, task, log);
    } catch (e) {
      log(`任务「${task.repoName}」失败：${(e as Error).message}`, "error");
    }
  }
}

// 任务配置类型（与 main.ts 中的 YuqueSyncTask 保持一致）
export type YuqueSyncTaskType = {
  repoId: number;
  namespace: string;
  repoName: string;
  targetFolder: string;
  mode: "all" | "selected";
  selectedDocs: { slug: string; title: string }[];
};
