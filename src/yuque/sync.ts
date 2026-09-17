import { App, normalizePath, TFile, TFolder } from "obsidian";
import { YuqueApi, YuqueDocSummary, YuqueTocNode } from "./api";
import { convertYuqueBody, type ColorMode } from "./lake";
import { propertiesBlock, FM, yuqueTagNames } from "./frontmatter";
import {
  decideWrite,
  docUrl,
  folderOfPath,
  followTocFolderMove,
  hashContent,
  pickRelocateSource,
  stateKey,
} from "./state";
import {
  basenameOf,
  buildInternalLink,
  buildLinkIndex,
  collectVaultDocs,
  convertLinksInContent,
  countBasenames,
  mergeStateIntoIndex,
} from "./link";
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

/**
 * 转义 Markdown 链接目标里的空格与定界符。
 *
 * 链接目标不带尖括号时不允许含空格，`![](../Docker 和 K8S/assets/x.png)` 会被整段
 * 当成普通文本、图片根本不显示——只要目录名里有空格就必然踩到。
 * 只编码真正会破坏解析的字符，中文保持原样以便阅读。
 */
const LINK_UNSAFE: Record<string, string> = {
  " ": "%20",
  "%": "%25",
  "(": "%28",
  ")": "%29",
  "<": "%3C",
  ">": "%3E",
  "#": "%23",
  "?": "%3F",
};

export function encodeLinkTarget(path: string): string {
  return path.replace(/[ %()<>#?]/g, (ch) => LINK_UNSAFE[ch] ?? ch);
}

/** 在目标文件夹内按标题精确匹配文件（旧记录无 path 时的搬移定位），返回不带后缀的路径 */
function findTitleMatches(app: App, folder: string, title: string): string[] {
  const name = `${sanitizeFileName(title)}.md`;
  const prefix = folder ? `${folder}/` : "";
  return app.vault
    .getMarkdownFiles()
    .map((f) => f.path)
    .filter((p) => p.startsWith(prefix) && (p === `${prefix}${name}` || p.endsWith(`/${name}`)))
    .map((p) => p.slice(0, -3));
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
  // 统一在此归一化：所有 vault 读写路径都由 joinPath 产出，
  // 避免各处遗漏 normalizePath 导致双重斜杠或反斜杠写入
  return normalizePath(
    parts.filter((p) => p && p.trim() && p !== "/" && p !== ".").join("/"),
  );
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

// 前言区的生成（buildFrontmatter / docPropertiesBlock）定义在 ./frontmatter：
// 同步写入、补齐命令与离线探针共用同一份实现，避免三处各抄一遍而漂移



interface StagedDoc {
  slug: string;
  title: string;
  /** vault 内完整路径（不含扩展名） */
  basePath: string;
  content: string;
  updated_at: string;
  warnings: string[];
  /** 本次 TOC 推出的语雀分组（"" = 根，null = 无法判断），写回 state 供下轮比对 */
  folder: string | null;
}

/** 冲突备份根目录（点开头，Obsidian 不会将其索引为笔记） */
const BACKUP_ROOT = ".yuque-backups";
/** 每篇文档保留的备份份数上限，避免备份无限堆积 */
const BACKUP_KEEP = 5;

function backupTimestamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `-${p(d.getMilliseconds(), 3)}`
  );
}

/** 备份本地现有内容并清理超限的旧备份，返回备份文件路径 */
async function backupDocFile(
  app: App,
  ns: string,
  doc: StagedDoc,
  content: string,
): Promise<string> {
  const dir = joinPath(BACKUP_ROOT, ns, doc.slug);
  await ensureFolder(app, dir);
  const name = `${backupTimestamp(new Date())}__${sanitizeFileName(doc.title).slice(0, 60)}.md`;
  const path = joinPath(dir, name);
  await app.vault.create(path, content);
  await pruneBackups(app, dir);
  return path;
}

/** 只保留最近 BACKUP_KEEP 份备份 */
async function pruneBackups(app: App, dir: string): Promise<void> {
  const folder = app.vault.getAbstractFileByPath(dir);
  if (!(folder instanceof TFolder)) return;
  const files = folder.children.filter((f): f is TFile => f instanceof TFile);
  if (files.length <= BACKUP_KEEP) return;
  // 文件名以时间戳开头，字典序即时间序
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const f of files.slice(0, files.length - BACKUP_KEEP)) {
    try {
      await app.vault.delete(f);
    } catch {
      // 删除失败不影响主流程
    }
  }
}

/**
 * 同步单个任务：拉取文档 → Lake 转 Markdown → 内链改写 → 图片本地化 → 写入 vault。
 * 增量策略：settings.yuqueSyncState 中记录的 updatedAt 与列表一致、且记录的本地文件仍存在则跳过。
 */
export async function syncTask(
  plugin: YuqueStylePlugin,
  api: YuqueApi,
  task: YuqueSyncTaskType,
  log: SyncLogFn,
  signal?: AbortSignal,
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
  // 落盘必须随时可做：中断或异常时若丢掉已写入文件的 hash，
  // 下次它们会被判成「本地被改过」而白白触发一次保守备份
  const persistState = async (): Promise<void> => {
    settings.yuqueSyncState = state;
    await plugin.saveSettings();
  };
  // 语雀彩色文字落到 Markdown 的方式；默认 drop（不输出 HTML，编辑/阅读两种模式都不见源码）
  const colorMode: ColorMode = settings.yuqueTextColor || "drop";
  // 连解析出的本地路径一起带下去：写入阶段必须复用它。
  // 否则用户重命名后会被按「目标文件夹 + 标题」重新算回旧路径，又建出一份重复文件。
  const pending: { doc: YuqueDocSummary; basePath: string; folder: string | null }[] = [];
  let skipped = 0;
  let relocated = 0;
  for (const d of targets) {
    const key = stateKey(ns, d.slug);
    const rec = state[key];
    // 优先沿用 state 记录的真实路径；旧记录迁移后 path 为空、或文件已不在原处时，
    // 回退到按 TOC + 标题现算的路径（旧行为）
    let resolvedPath = rec?.path || "";
    let file = resolvedPath
      ? plugin.app.vault.getAbstractFileByPath(`${resolvedPath}.md`)
      : null;
    if (!(file instanceof TFile)) {
      resolvedPath = joinPath(
        task.targetFolder,
        tocFolders.get(d.slug) || "",
        sanitizeFileName(d.title),
      );
      file = plugin.app.vault.getAbstractFileByPath(`${resolvedPath}.md`);
    }

    // 语雀端给分组改名 / 挪动时，组内文档的 updated_at 并不会变，只看它就会整组跳过、
    // 本地目录名永远停在旧的那个。这里改为比对「上次记录的语雀分组」与本次 TOC 的分组：
    // 不一致就把文件搬到新分组下（正文没变，无需重新拉取）。
    // 本地自己改的分组名不会写进 state.folder，所以不会被误判成语雀改动而搬回去。
    const tocFolder = tocFolders.has(d.slug) ? tocFolders.get(d.slug) ?? "" : null;
    let prevFolder = rec?.folder ?? null;
    if (prevFolder === null && tocFolder !== null) {
      // 升级前的旧记录没有分组历史：按当前本地结构认账，
      // 这样「升级后第一次同步就撞上语雀改名」也能正确跟随，而不是白等一轮
      prevFolder = folderOfPath(resolvedPath, task.targetFolder);
    }
    let folder = tocFolder ?? rec?.folder ?? null;
    if (file instanceof TFile && tocFolder !== null && prevFolder !== null) {
      const movedTo = followTocFolderMove(resolvedPath, prevFolder, tocFolder);
      if (movedTo) {
        try {
          // 新分组目录多数还没建出来（整组一起改名时它就是个新名字），
          // 而 vault.rename 不会替我们创建父目录，缺了这一步会直接 ENOENT
          if (movedTo.includes("/")) {
            await ensureFolder(plugin.app, movedTo.slice(0, movedTo.lastIndexOf("/")));
          }
          await plugin.app.vault.rename(file, `${movedTo}.md`);
          log(`「${d.title}」分组跟随语雀：${resolvedPath} → ${movedTo}`);
          resolvedPath = movedTo;
          relocated++;
          const after = plugin.app.vault.getAbstractFileByPath(`${movedTo}.md`);
          if (after instanceof TFile) file = after;
        } catch (e) {
          log(`  ⚠ 分组跟随失败「${d.title}」：${(e as Error).message}`, "error");
          // 保留旧分组，下一轮同步再试，而不是就此认定已经跟随成功
          folder = rec?.folder ?? null;
        }
      }
    }

    if (rec && rec.updatedAt === d.updated_at && file instanceof TFile) {
      // 顺带把补全/校正后的路径与地址写回，旧记录首次同步即自愈
      state[key] = {
        updatedAt: rec.updatedAt,
        path: resolvedPath,
        url: rec.url || docUrl(ns, d.slug),
        title: d.title,
        // 本次未写入，指纹必须沿用原值，否则会误判为「本地被改过」
        hash: rec.hash,
        folder,
      };
      skipped++;
      continue;
    }
    pending.push({ doc: d, basePath: resolvedPath, folder });
  }
  log(`共 ${targets.length} 篇，需更新 ${pending.length} 篇，跳过未变化 ${skipped} 篇`);

  // 拉取并转换
  const staged: StagedDoc[] = [];
  for (const { doc: d, basePath, folder } of pending) {
    if (signal?.aborted) {
      log("已停止；正在保存已同步记录…");
      await persistState();
      return;
    }
    try {
      const detail = await api.getDoc(ns, d.slug);
      const result = convertYuqueBody(detail.body || "", colorMode);
      // 键名统一中文（见 frontmatter.ts 的 FM）：Obsidian 属性面板直接显示键名
      const head = propertiesBlock({
        [FM.title]: detail.title,
        [FM.source]: `https://www.yuque.com/${ns}/${d.slug}`,
        // 文档 ID 与创建时间：详情接口与列表接口都带，列表项作回退
        [FM.id]: String(detail.id ?? d.id ?? ""),
        [FM.createdAt]: detail.created_at || d.created_at || "",
        [FM.updatedAt]: detail.updated_at,
        [FM.tags]: yuqueTagNames(detail.tags),
      });
      staged.push({
        slug: d.slug,
        title: detail.title || d.title,
        basePath,
        content: head + result.markdown,
        updated_at: d.updated_at,
        warnings: result.warnings,
        folder,
      });
      for (const w of result.warnings) log(`  ⚠ ${d.title}：${w}`);
    } catch (e) {
      log(`拉取失败「${d.title}」：${(e as Error).message}`, "error");
    }
  }
  if (staged.length === 0) {
    // 不在这里提前返回：即使一篇正文都不用写，本次也可能刚为旧记录补全了 path、
    // 或跟随了语雀端的分组改名，目录索引页同样要按新分组重画。
    // 记录落盘与索引页生成都在函数末尾统一处理。
    log("没有需要写入的文档", "info");
  }

  // 内部链接 → Obsidian 双链。
  // 解析范围是整个 vault（语雀里跨知识库引用很常见），映射表来自每篇文档 frontmatter 的
  // source 字段并上同步记录——故意不依赖同步状态，否则「清除增量同步记录」后表会全空。
  const slugToTitle = new Map<string, string>();
  for (const t of targets) slugToTitle.set(t.slug, sanitizeFileName(t.title));
  const vaultDocs = collectVaultDocs(plugin.app);
  const linkIndex = buildLinkIndex(vaultDocs);
  mergeStateIntoIndex(linkIndex, settings.yuqueSyncState);
  const extraNames: string[] = [];
  // 本次要写入的文档也进索引：首次同步时 A→B 的引用同样能转（B 此刻还没落盘）
  for (const { doc: pendingDoc, basePath } of pending) {
    const key = stateKey(ns, pendingDoc.slug);
    if (linkIndex.has(key)) continue;
    const base = basenameOf(basePath);
    linkIndex.set(key, { path: basePath, basename: base });
    extraNames.push(base);
  }
  const linkCounts = countBasenames([
    ...vaultDocs.map((d) => basenameOf(d.path)),
    ...extraNames,
  ]);
  let linksConverted = 0;
  for (const doc of staged) {
    const converted = convertLinksInContent(doc.content, linkIndex, linkCounts);
    doc.content = converted.content;
    linksConverted += converted.converted;
  }
  if (linksConverted > 0) {
    log(`已把 ${linksConverted} 条语雀文档链接转为本地双链`);
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
          doc.content = doc.content
            .split(full)
            .join(`![${alt}](${encodeLinkTarget(rel)})`);
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
  let unchanged = 0;
  let backedUp = 0;
  let moved = 0;
  for (const doc of staged) {
    if (signal?.aborted) {
      log(`已停止；已写入 ${written} 篇，正在保存记录…`);
      await persistState();
      return;
    }
    const filePath = `${doc.basePath}.md`;
    try {
      if (doc.basePath.includes("/")) {
        await ensureFolder(plugin.app, doc.basePath.slice(0, doc.basePath.lastIndexOf("/")));
      }
      const key = stateKey(ns, doc.slug);
      const rec = state[key];
      if (!plugin.app.vault.getAbstractFileByPath(filePath)) {
        // 目标位置没有文件：若旧位置（state 记录，或旧记录无 path 时按标题唯一匹配）
        // 找得到文件，整体搬移过去——语雀端的目录调整不应该产生两份拷贝
        const titleMatches = rec?.path
          ? []
          : findTitleMatches(plugin.app, task.targetFolder, doc.title);
        const from = pickRelocateSource(rec?.path || "", doc.basePath, titleMatches);
        if (from && from !== doc.basePath) {
          const stale = plugin.app.vault.getAbstractFileByPath(`${from}.md`);
          if (stale instanceof TFile) {
            await plugin.app.vault.rename(stale, filePath);
            log(`「${doc.title}」位置跟随语雀目录：${from} → ${doc.basePath}`);
            moved++;
          }
        }
      } else {
        // 目标位置已有文件：检查别处是否还留着同名旧拷贝（记录指向的、或按标题匹配到的），
        // 有则提示人工处理，绝不自动删除用户文件
        const others =
          rec?.path && rec.path !== doc.basePath
            ? [rec.path]
            : findTitleMatches(plugin.app, task.targetFolder, doc.title).filter(
                (p) => p !== doc.basePath,
              );
        const leftover = others.find(
          (p) => plugin.app.vault.getAbstractFileByPath(`${p}.md`) instanceof TFile,
        );
        if (leftover) {
          log(
            `  ⚠ 疑似重复：「${doc.title}」已在 ${doc.basePath} 更新，旧文件仍在 ${leftover}.md，请确认后手动删除`,
            "error",
          );
        }
      }
      const existing = plugin.app.vault.getAbstractFileByPath(filePath);
      const existingFile = existing instanceof TFile ? existing : null;
      const current = existingFile ? await plugin.app.vault.read(existingFile) : null;
      const decision = decideWrite({
        exists: existingFile !== null,
        currentContent: current,
        nextContent: doc.content,
        knownHash: state[key]?.hash,
      });
      if (decision === "backup-overwrite" && settings.yuqueBackupOnConflict) {
        const backupPath = await backupDocFile(plugin.app, ns, doc, current ?? "");
        log(`「${doc.title}」本地已改动，备份原内容 → ${backupPath}`);
        backedUp++;
      }
      if (decision === "skip-identical") {
        // 内容一致，不写入也能把记录补齐，顺带省掉一次无意义的 modify
        unchanged++;
      } else if (existingFile) {
        await plugin.app.vault.modify(existingFile, doc.content);
        written++;
      } else {
        await plugin.app.vault.create(filePath, doc.content);
        written++;
      }
      state[key] = {
        updatedAt: doc.updated_at,
        path: doc.basePath,
        url: docUrl(ns, doc.slug),
        title: doc.title,
        hash: hashContent(doc.content),
        folder: doc.folder,
      };
    } catch (e) {
      log(`写入失败「${doc.title}」：${(e as Error).message}`, "error");
    }
  }
  await persistState();
  log(
    `「${task.repoName}」完成：写入/更新 ${written} 篇` +
      (unchanged > 0 ? `，内容未变 ${unchanged} 篇` : "") +
      (relocated > 0 ? `，分组跟随语雀 ${relocated} 篇` : "") +
      (moved > 0 ? `，位置跟随 ${moved} 篇` : "") +
      (backedUp > 0 ? `，冲突备份 ${backedUp} 篇` : ""),
    "success",
  );

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
          // 索引页点击最频繁，重名坑同样要按「唯一用短、撞车用路径」处理
          const base = slugToTitle.get(n.slug)!;
          const target = linkIndex.get(stateKey(ns, n.slug)) ?? { path: "", basename: base };
          const unique = (linkCounts.get(target.basename) ?? 0) <= 1;
          lines.push(`${indent}- ${buildInternalLink(target, n.title, unique)}`);
        } else if (n.title) {
          lines.push(`${indent}- **${n.title}**`);
        }
      }
      const indexContent =
        propertiesBlock({
          [FM.title]: `${task.repoName} 知识库目录`,
          [FM.source]: `https://www.yuque.com/${ns}`,
        }) + `${lines.join("\n")}\n`;
      const indexPath = joinPath(task.targetFolder, `${sanitizeFileName(task.repoName)} 目录.md`);
      if (indexPath.includes("/")) {
        await ensureFolder(plugin.app, indexPath.slice(0, indexPath.lastIndexOf("/")));
      }
      const existingIndex = plugin.app.vault.getAbstractFileByPath(indexPath);
      let indexChanged = true;
      if (existingIndex instanceof TFile) {
        // 内容一致就不写：这篇索引现在每轮同步都会走到（哪怕一篇正文都没改），
        // 无脑 modify 只会把它的修改时间无谓地刷新一遍
        const previous = await plugin.app.vault.read(existingIndex);
        indexChanged = previous !== indexContent;
        if (indexChanged) await plugin.app.vault.modify(existingIndex, indexContent);
      } else {
        await plugin.app.vault.create(indexPath, indexContent);
      }
      if (indexChanged) log(`已更新知识库目录索引：${indexPath}`, "success");
    } catch (e) {
      log(`目录索引生成失败：${(e as Error).message}`, "error");
    }
  }
}

/**
 * 同步任务。给定 tasks 时只跑这批（按给定顺序），否则跑设置里的全部任务。
 * signal 供「停止」按钮使用：中断时 syncTask 会先把已写入文档的 state 落盘再退出，
 * 已完成的文档不会丢 hash 基准；未开始的任务直接跳过。
 */
export async function syncAllTasks(
  plugin: YuqueStylePlugin,
  log: SyncLogFn,
  tasks?: YuqueSyncTaskType[],
  signal?: AbortSignal,
): Promise<void> {
  const settings = plugin.settings;
  if (!settings.yuqueToken) {
    log("请先在插件设置中填写语雀 Token", "error");
    return;
  }
  const list = tasks && tasks.length > 0 ? tasks : settings.yuqueTasks || [];
  if (list.length === 0) {
    log("还没有同步任务，请先在设置或用「添加语雀同步任务」命令创建", "error");
    return;
  }
  const api = new YuqueApi(settings.yuqueToken);
  for (let i = 0; i < list.length; i++) {
    const task = list[i];
    if (signal?.aborted) {
      log("已停止，余下任务不再执行", "info");
      return;
    }
    if (list.length > 1) log(`—— [${i + 1}/${list.length}] 「${task.repoName}」——`);
    try {
      await syncTask(plugin, api, task, log, signal);
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

/**
 * 计算一批知识库各自的目标文件夹：根文件夹 / 库名。
 * 库名 sanitize 后若与前面的库撞车（语雀允许同名库），给后者补 namespace 短后缀，
 * 避免两个任务落到同一目录——同目录会让跨库同名文档互相误判成「自己的旧位置」。
 */
export function resolveTargetFolders(
  repos: { namespace: string; name: string }[],
  root: string,
): { namespace: string; folder: string }[] {
  const rootTrim = (root || "").trim().replace(/^\/+|\/+$/g, "");
  const used = new Set<string>();
  return repos.map((r) => {
    let name = sanitizeFileName(r.name) || "未命名";
    if (used.has(name)) {
      const suffix = r.namespace.split("/")[1] || r.namespace;
      name = `${name} (${suffix})`;
    }
    used.add(name);
    return { namespace: r.namespace, folder: rootTrim ? `${rootTrim}/${name}` : name };
  });
}
