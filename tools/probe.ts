/**
 * 离线试水工具：拉取语雀某知识库 → 用插件同一套转换器算出「将要写入的内容」→
 * 与 vault 现状逐篇比对，产出 A/B/C 分类，并把原文与基准内容存档到 vault 外。
 *
 * 只读 vault 与 data.json（默认 dry-run）。加 --apply 才写 data.json（写前自动备份）。
 *
 * 用法：
 *   node tools/.probe/probe.cjs --repo=AI            # 试水（默认 dry-run）
 *   node tools/.probe/probe.cjs --repo=AI --limit=3  # 只跑前 3 篇，先验证管线
 *   node tools/.probe/probe.cjs --repo=AI --apply    # 写入 path/hash 基准
 */
import fs from "fs";
import path from "path";
import { YuqueApi } from "../src/yuque/api";
import type { YuqueDocSummary, YuqueTocNode } from "../src/yuque/api";
import { buildTocFolders, sanitizeFileName } from "../src/yuque/sync";
import { docUrl, hashContent, migrateSyncState, stateKey } from "../src/yuque/state";
import type { YuqueDocState, YuqueSyncState } from "../src/yuque/state";
import { buildDocContent, buildSlugToTitle } from "./replicate";
import { normalizePath } from "./obsidian-shim";

interface SyncTask {
  repoId?: number;
  namespace: string;
  repoName: string;
  targetFolder: string;
  mode: "all" | "selected";
  selectedDocs?: { slug: string; title?: string }[];
}

interface ProbeArgs {
  repo: string;
  vault: string;
  dataFile: string;
  archiveRoot: string;
  apply: boolean;
  limit: number;
  verbose: boolean;
}

function arg(name: string, def: string): string {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
function flag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function parseArgs(): ProbeArgs {
  return {
    repo: arg("repo", "AI"),
    vault: arg("vault", "H:/语雀"),
    dataFile: arg("data", "H:/语雀/.obsidian/plugins/yuque-style/data.json"),
    archiveRoot: arg("archive", "H:/语雀备份/yuque-archive"),
    apply: flag("apply"),
    limit: Number(arg("limit", "0")) || 0,
    verbose: flag("verbose"),
  };
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function firstDiffLine(a: string, b: string): { i: number; a: string; b: string } | null {
  const al = a.split("\n");
  const bl = b.split("\n");
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) {
      return { i, a: al[i] ?? "<无此行>", b: bl[i] ?? "<无此行>" };
    }
  }
  return null;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const t0 = Date.now();

  const raw = fs.readFileSync(args.dataFile, "utf8");
  const data = JSON.parse(raw);
  const token: string = data.yuqueToken || "";
  if (!token) throw new Error("data.json 中没有 yuqueToken");

  const tasks: SyncTask[] = data.yuqueTasks || [];
  const task = tasks.find((t) => t.repoName === args.repo || t.namespace === args.repo);
  if (!task) {
    throw new Error(
      `找不到任务「${args.repo}」。可选：${tasks.map((t) => t.repoName).join(" / ")}`,
    );
  }
  const ns = task.namespace;
  const state: YuqueSyncState = migrateSyncState(data.yuqueSyncState);

  console.log(`=== 试水报告 · ${task.repoName} ===`);
  console.log(`namespace    : ${ns}`);
  console.log(`目标文件夹   : ${task.targetFolder}/`);
  console.log(`资源目录     : ${data.yuqueAssetsFolder || "assets"}（本地化 ${data.yuqueDownloadImages ? "开" : "关"}）`);

  const api = new YuqueApi(token);
  const retryLog = (sec: number, attempt: number) =>
    console.log(`  （限流退避：${sec}s 后重试，第 ${attempt} 次）`);

  let toc: YuqueTocNode[] = await api.getToc(ns, retryLog);
  let docList: YuqueDocSummary[] = await api.getDocListOnce(ns);

  if (docList.length === 0 && toc.length > 0) {
    for (const node of toc) {
      const m = node.url?.match(/^\/([^/]+)\/([^/]+)/);
      if (m && m[1] && m[1] !== ns) {
        const retry = await api.getDocListOnce(m[1]);
        if (retry.length > 0) {
          docList = retry;
          console.log(`  按 TOC 中的 namespace（${m[1]}）重试成功：${retry.length} 篇`);
        }
        break;
      }
    }
  }
  if (toc.length === 0 && docList.length === 0 && task.repoId) {
    try {
      const tocById = await api.getToc(String(task.repoId), retryLog);
      const docsById = await api.getDocListOnce(String(task.repoId));
      if (tocById.length > 0 || docsById.length > 0) {
        toc = tocById;
        docList = docsById;
      }
    } catch (e) {
      console.log(`  ID 访问失败：${(e as Error).message}`);
    }
  }

  const tocFolders = buildTocFolders(toc);
  const docBySlug = new Map<string, YuqueDocSummary>();
  for (const d of docList) docBySlug.set(d.slug, d);

  // 与 sync 一致：mode=all 时按 TOC 顺序，不在目录中的排最后
  const tocOrder = new Map<string, number>();
  toc.forEach((n, i) => {
    if (n.slug && !tocOrder.has(n.slug)) tocOrder.set(n.slug, i);
  });
  const inToc: YuqueDocSummary[] = [];
  const notInToc: YuqueDocSummary[] = [];
  for (const d of docList) (tocOrder.has(d.slug) ? inToc : notInToc).push(d);
  inToc.sort((a, b) => (tocOrder.get(a.slug) ?? 0) - (tocOrder.get(b.slug) ?? 0));
  let targets: YuqueDocSummary[] =
    task.mode === "selected"
      ? (task.selectedDocs || [])
          .map((sd) => docBySlug.get(sd.slug))
          .filter((d): d is YuqueDocSummary => !!d)
      : [...inToc, ...notInToc];

  if (args.limit > 0) targets = targets.slice(0, args.limit);

  const slugToTitle = buildSlugToTitle(targets);
  const assetsFolder: string = data.yuqueAssetsFolder || "assets";
  const downloadImages: boolean = data.yuqueDownloadImages !== false;

  const archiveDir = path.join(args.archiveRoot, stamp(), task.repoName);
  fs.mkdirSync(path.join(archiveDir, "raw"), { recursive: true });
  fs.mkdirSync(path.join(archiveDir, "base"), { recursive: true });

  type Row = {
    slug: string;
    title: string;
    relPath: string;
    kind: "A" | "B" | "C";
    wouldSkip: boolean;
    images: number;
    assetMissing: number;
    warnings: string[];
    local: string;
    next: string;
  };
  const rows: Row[] = [];
  let failed = 0;

  const t1 = Date.now();
  for (let i = 0; i < targets.length; i++) {
    const d = targets[i];
    const key = stateKey(ns, d.slug);
    const rec: YuqueDocState | undefined = state[key];

    // 路径解析：与 sync 一致（优先 state.path，否则按 TOC + 标题）
    let resolvedPath = rec?.path || "";
    let localFile = resolvedPath ? path.join(args.vault, `${resolvedPath}.md`) : "";
    if (!resolvedPath || !fs.existsSync(localFile)) {
      resolvedPath = normalizePath(
        [task.targetFolder, tocFolders.get(d.slug) || "", sanitizeFileName(d.title)]
          .filter((s) => s && s.trim())
          .join("/"),
      );
      localFile = path.join(args.vault, `${resolvedPath}.md`);
    }

    try {
      const detail = await api.getDoc(ns, d.slug);
      const built = buildDocContent({
        ns,
        slug: d.slug,
        title: detail.title || d.title,
        updatedAt: detail.updated_at || d.updated_at,
        // 与 sync.ts 写入的属性字段保持一致，否则基准内容会凭空多出差异
        id: String(detail.id ?? d.id ?? ""),
        createdAt: detail.created_at || d.created_at || "",
        tags: detail.tags,
        body: detail.body || "",
        basePath: resolvedPath,
        targetFolder: task.targetFolder,
        assetsFolder,
        downloadImages,
        targets,
        slugToTitle,
      });

      const localExists = fs.existsSync(localFile);
      const local = localExists ? fs.readFileSync(localFile, "utf8") : "";
      const kind: Row["kind"] = !localExists ? "C" : local === built.content ? "A" : "B";

      const assetMissing = built.images.filter(
        (im) => !fs.existsSync(path.join(args.vault, im.assetPath)),
      ).length;

      rows.push({
        slug: d.slug,
        title: detail.title || d.title,
        relPath: resolvedPath,
        kind,
        wouldSkip: !!rec && rec.updatedAt === d.updated_at,
        images: built.images.length,
        assetMissing,
        warnings: built.warnings,
        local,
        next: built.content,
      });

      // 存档（vault 外，随时可删）
      const isLake = (detail.body || "").trimStart().startsWith("{");
      fs.writeFileSync(
        path.join(archiveDir, "raw", `${d.slug}.${isLake ? "lake" : "md"}`),
        detail.body || "",
        "utf8",
      );
      fs.writeFileSync(path.join(archiveDir, "base", `${d.slug}.md`), built.content, "utf8");

      if (args.verbose) {
        console.log(`  [${i + 1}/${targets.length}] ${kind} ${resolvedPath}`);
      }
    } catch (e) {
      failed++;
      console.log(`  拉取失败「${d.title}」：${(e as Error).message}`);
    }
  }

  // 本地孤儿扫描：本地有文件、语雀端已无对应文档（排除目录索引页）
  let orphans: string[] = [];
  if (args.limit === 0) {
    const remotePaths = new Set(rows.map((r) => r.relPath));
    const remoteTitles = new Set(rows.map((r) => sanitizeFileName(r.title)));
    const walkMd = (dir: string, out: string[] = []): string[] => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return out;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name.startsWith(".")) continue;
          walkMd(full, out);
        } else if (e.name.endsWith(".md")) {
          out.push(full);
        }
      }
      return out;
    };
    for (const f of walkMd(path.join(args.vault, task.targetFolder))) {
      const rel = path.relative(args.vault, f).replace(/\\/g, "/").replace(/\.md$/, "");
      const base = path.basename(f, ".md");
      if (/目录$/.test(base)) continue; // 插件生成的目录索引页
      if (remotePaths.has(rel) || remoteTitles.has(base)) continue;
      orphans.push(rel);
    }
  }

  const elapsed = ((Date.now() - t1) / 1000).toFixed(1);

  fs.writeFileSync(path.join(archiveDir, "toc.json"), JSON.stringify(toc, null, 2), "utf8");
  fs.writeFileSync(path.join(archiveDir, "docs.json"), JSON.stringify(docList, null, 2), "utf8");
  fs.writeFileSync(
    path.join(archiveDir, "manifest.json"),
    JSON.stringify(
      {
        repoName: task.repoName,
        namespace: ns,
        repoId: task.repoId ?? null,
        targetFolder: task.targetFolder,
        assetsFolder,
        downloadImages,
        docs: targets.length,
        fetchedAt: new Date().toISOString(),
        note: "raw/ 为语雀原文；base/ 为按当前转换器算出的写入内容（diff 基准）",
      },
      null,
      2,
    ),
    "utf8",
  );

  const a = rows.filter((r) => r.kind === "A").length;
  const b = rows.filter((r) => r.kind === "B").length;
  const c = rows.filter((r) => r.kind === "C").length;
  const skipped = rows.filter((r) => r.wouldSkip).length;

  console.log("");
  console.log(`文档数       : ${targets.length}（拉取失败 ${failed}）`);
  console.log(`耗时         : ${elapsed}s（平均 ${(Number(elapsed) / Math.max(rows.length, 1)).toFixed(2)}s/篇）`);
  console.log(`A 内容一致   : ${a}  ← 基准可信，可安全写入 hash`);
  console.log(`B 内容差异   : ${b}  ← 需确认原因（转换器升级 / 本地改动）`);
  console.log(`C 本地缺失   : ${c}  ← 本地无此文件，真同步会新建`);
  console.log(`其中「语雀未更新、真同步会跳过」: ${skipped} 篇`);
  if (args.limit === 0) {
    console.log(`本地孤儿文件 : ${orphans.length} 篇（本地有、语雀端已无对应；已排除目录索引页）`);
    for (const o of orphans.slice(0, 10)) console.log(`    - ${o}`);
    if (orphans.length > 10) console.log(`    … 其余 ${orphans.length - 10} 篇`);
  }

  const bRows = rows.filter((r) => r.kind === "B");
  if (bRows.length > 0) {
    console.log("");
    console.log("--- B 类首处差异（最多 3 篇）---");
    for (const r of bRows.slice(0, 3)) {
      const d = firstDiffLine(r.local, r.next);
      console.log(`* ${r.relPath}.md`);
      console.log(`    第 ${(d?.i ?? 0) + 1} 行`);
      console.log(`    本地: ${(d?.a ?? "").slice(0, 120)}`);
      console.log(`    语雀: ${(d?.b ?? "").slice(0, 120)}`);
      if (r.images > 0) console.log(`    （含图片 ${r.images} 张，缺失资源 ${r.assetMissing} 个）`);
    }
  }

  const warnRows = rows.filter((r) => r.warnings.length > 0);
  if (warnRows.length > 0) {
    console.log("");
    console.log(`转换告警 ${warnRows.length} 篇（预览）：`);
    for (const r of warnRows.slice(0, 5)) console.log(`  ${r.relPath}：${r.warnings[0]}`);
  }

  console.log("");
  console.log(`存档已写入   : ${archiveDir}`);

  if (!args.apply) {
    console.log("");
    console.log(
      `dry-run：未修改 data.json。若应用 --apply，将写入 path ${rows.length} 条、hash ${a} 条（仅 A 类）；B 类留空以保持「未知→保守备份」语义。`,
    );
    console.log(`总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }

  // ---- 写入基准 ----
  const bak = `${args.dataFile}.bak-${stamp()}-${String(Date.now()).slice(-6)}`;
  fs.copyFileSync(args.dataFile, bak);

  let pathWritten = 0;
  let hashWritten = 0;
  for (const r of rows) {
    const key = stateKey(ns, r.slug);
    const rec = state[key];
    state[key] = {
      updatedAt: rec?.updatedAt || "",
      path: r.relPath,
      url: rec?.url || docUrl(ns, r.slug),
      title: r.title,
      hash: r.kind === "A" ? hashContent(r.next) : rec?.hash || "",
    };
    pathWritten++;
    if (r.kind === "A") hashWritten++;
  }
  // updatedAt 需要对齐当前语雀值，否则下轮会被判为「需更新」
  for (const r of rows) {
    const src = targets.find((t) => t.slug === r.slug);
    if (src) state[stateKey(ns, r.slug)].updatedAt = src.updated_at;
  }

  data.yuqueSyncState = state;
  fs.writeFileSync(args.dataFile, JSON.stringify(data, null, 1), "utf8");
  console.log("");
  console.log(`已写入 data.json：path ${pathWritten} 条、hash ${hashWritten} 条`);
  console.log(`原文件备份      : ${bak}`);
  console.log(`总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error("失败：", (e as Error).message);
  process.exit(1);
});
