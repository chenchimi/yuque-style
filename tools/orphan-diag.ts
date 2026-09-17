/**
 * 失联文件诊断：本地已同步的文档，在语雀端现在是「还在 / 被搬走 / 已被删」，
 * 以及「文件是否落在它所属知识库该在的文件夹里」。
 *
 * 只调「知识库列表 + 文档列表」接口（每 100 篇 1 次请求），不拉正文、不写 vault。
 * 判据是每篇同步文档 frontmatter 里的 source（语雀 URL 自带 namespace 与 slug），
 * 而不是本地路径猜测——路径会随语雀目录调整变化，slug 不会。
 *
 * 用法：
 *   node tools/.probe/orphan-diag.cjs
 *   node tools/.probe/orphan-diag.cjs --out=tools/.probe/orphans-report
 */
import fs from "fs";
import path from "path";
import { YuqueApi } from "../src/yuque/api";
import type { YuqueRepo, YuqueDocSummary } from "../src/yuque/api";
import { sanitizeFileName } from "../src/yuque/sync";
import { readFm } from "../src/yuque/frontmatter";
import { migrateSyncState } from "../src/yuque/state";
import type { YuqueSyncState } from "../src/yuque/state";

function arg(name: string, def: string): string {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

interface LocalDoc {
  relPath: string;
  /** 所属任务的目标文件夹 */
  folder: string;
  /** 所属任务的 namespace */
  taskNs: string;
  title: string;
  /** frontmatter source 里的 namespace（文档真正所属的知识库） */
  ns: string;
  slug: string;
  /** frontmatter 里的 yuque_created_at，用于交叉验证「是否同一篇文档」 */
  createdAt: string;
  hasSource: boolean;
}

type Verdict =
  | "ok" // 同库在册，且本地路径与同步记录一致
  | "foreign" // 在册，但它属于另一个知识库——落在了别人的文件夹里
  | "misplaced" // 同库在册，但本地路径与同步记录不一致（同步维护的是另一份）
  | "untracked" // 同库在册，但同步记录里没有它（下次同步会另建一份）
  | "moved-slug" // slug 出现在别的库：被搬走，账号内可继续跟踪
  | "moved-title" // slug 找不到，但别的库有同标题文档：疑似搬走且重建
  | "recreated" // 同库有同标题：疑似删除后重建，本地这份会被新文件取代
  | "deleted" // 全账号都找不到：语雀端确实已不存在
  | "no-source" // 没有 source：本地自有文件，或极早期同步留下的
  | "unknown"; // 所属库列表没取到，无法判定

interface Row {
  doc: LocalDoc;
  verdict: Verdict;
  /** 命中的 namespace（跨库 / 搬走候选） */
  hits: string[];
  /** 命中的远端文档创建时间，用于验证是否同一篇 */
  hitCreatedAt: string[];
  /** 同步记录里该文档的路径（若存在） */
  statePath: string;
}

function walkMd(dir: string, out: string[] = []): string[] {
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
}

/** 只解析前言区的顶层 key: value，不引 yaml 依赖（键名已中文化，不能用 ASCII 限定） */
function readFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text.startsWith("---")) return out;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return out;
  for (const line of text.slice(3, end).split("\n")) {
    const m = line.match(/^([^\s:]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** 从语雀文档链接里取出 namespace 与 slug（/login/book/slug） */
function parseSource(src: string): { ns: string; slug: string } | null {
  const m = String(src || "").match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/([^/?#]+)/);
  if (!m) return null;
  return { ns: `${m[1]}/${m[2]}`, slug: m[3] };
}

const norm = (s: string) => sanitizeFileName(String(s || "")).trim().toLowerCase();

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function pad(s: string, n: number): string {
  const w = [...s].reduce((acc, ch) => acc + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
  return s + " ".repeat(Math.max(0, n - w));
}

// 远端与本地状态索引放模块级：classify() 是模块级函数，取不到 main() 的局部变量
const remoteNsSlug = new Map<string, YuqueDocSummary>();
const slugToNs = new Map<string, string[]>();
/** 标题 → 远端文档（带 ns 与 created_at，用于判断「是否同一篇」） */
const titleIndex = new Map<string, { ns: string; doc: YuqueDocSummary }[]>();
const listedNs = new Set<string>();
/** "ns/slug" → 同步记录里的本地路径 */
const statePath = new Map<string, string>();

const VERDICTS: Verdict[] = [
  "ok",
  "foreign",
  "misplaced",
  "untracked",
  "moved-slug",
  "moved-title",
  "recreated",
  "deleted",
  "no-source",
  "unknown",
];

async function main(): Promise<void> {
  const vault: string = arg("vault", "H:/语雀");
  const dataFile: string = arg("data", "H:/语雀/.obsidian/plugins/yuque-style/data.json");
  const outBase: string = arg("out", "tools/.probe/orphans-report");

  const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  const token: string = data.yuqueToken || "";
  if (!token) throw new Error("data.json 中没有 yuqueToken");
  const tasks: { namespace: string; repoName: string; targetFolder: string }[] =
    data.yuqueTasks || [];
  if (tasks.length === 0) throw new Error("data.json 中没有同步任务");

  const state: YuqueSyncState = migrateSyncState(data.yuqueSyncState);
  for (const [key, rec] of Object.entries(state)) {
    if (rec?.path) statePath.set(key, rec.path);
  }

  const api = new YuqueApi(token);

  // 1) 远端：全部知识库 → 全部文档列表
  console.log("拉取知识库列表…");
  const repos: YuqueRepo[] = await api.getRepos();
  repos.sort((a, b) => String(a.namespace).localeCompare(String(b.namespace)));
  console.log(`知识库 ${repos.length} 个，开始拉文档列表（每 100 篇 1 次请求）…`);

  const unlisted: string[] = [];
  let remoteDocs = 0;
  for (const r of repos) {
    const ns = String(r.namespace);
    let docs: YuqueDocSummary[] = [];
    try {
      docs = await api.getDocList(ns);
    } catch (e) {
      unlisted.push(`${ns}（列表失败：${(e as Error).message}）`);
      continue;
    }
    if (docs.length === 0 && (r.items_count ?? 0) > 0) {
      unlisted.push(`${ns}（items_count=${r.items_count} 却列出 0 篇，可能无权限）`);
      continue;
    }
    listedNs.add(ns);
    remoteDocs += docs.length;
    for (const d of docs) {
      remoteNsSlug.set(`${ns}/${d.slug}`, d);
      push(slugToNs, d.slug, ns);
      push(titleIndex, norm(d.title), { ns, doc: d });
    }
    console.log(`  ${pad(ns, 34)}${String(docs.length).padStart(5)} 篇`);
  }
  console.log(`远端合计 ${remoteDocs} 篇，成功列出 ${listedNs.size}/${repos.length} 个库`);

  // 2) 本地：扫描每个任务目标文件夹
  const rows: Row[] = [];
  for (const t of tasks) {
    if (!t.targetFolder) continue;
    const root = path.join(vault, t.targetFolder);
    for (const f of walkMd(root)) {
      const base = path.basename(f, ".md");
      if (/目录$/.test(base)) continue; // 插件生成的目录索引页，不是文档
      let head = "";
      try {
        // 前言区必在文件头部，读前 4KB 就够，避免整篇读入
        const fd = fs.openSync(f, "r");
        const buf = Buffer.alloc(4096);
        const n = fs.readSync(fd, buf, 0, 4096, 0);
        fs.closeSync(fd);
        head = buf.subarray(0, n).toString("utf8");
      } catch {
        continue;
      }
      const fm = readFrontmatter(head);
      // 属性键名已统一中文，readFm 会回退旧英文键，存量文档照样判定得出来
      const parsed = parseSource(readFm<string>(fm, "source") ?? "");
      const doc: LocalDoc = {
        relPath: path.relative(vault, f).replace(/\\/g, "/").replace(/\.md$/, ""),
        folder: t.targetFolder,
        taskNs: t.namespace,
        title: readFm<string>(fm, "title") || base,
        ns: parsed?.ns ?? "",
        slug: parsed?.slug ?? "",
        createdAt: readFm<string>(fm, "createdAt") || "",
        hasSource: !!parsed,
      };
      rows.push(classify(doc));
    }
  }

  // 3) 覆盖范围：vault 里还有多少 .md 不在任何任务文件夹下（那些才是真正的盲区）
  const covered = tasks.map((t) => t.targetFolder).filter(Boolean);
  const isCovered = (rel: string) => covered.some((c) => rel === c || rel.startsWith(`${c}/`));
  const uncovered = new Map<string, number>();
  let vaultMd = 0;
  let coveredMd = 0;
  for (const f of walkMd(vault)) {
    const rel = path.relative(vault, f).replace(/\\/g, "/");
    if (rel.startsWith(".obsidian/")) continue;
    vaultMd++;
    if (isCovered(rel.replace(/\.md$/, ""))) coveredMd++;
    else {
      const top = rel.split("/")[0];
      uncovered.set(top, (uncovered.get(top) || 0) + 1);
    }
  }

  // 4) 汇总与报告
  const byFolder = new Map<string, Row[]>();
  for (const r of rows) push(byFolder, r.doc.folder, r);
  const count = (list: Row[], v: Verdict) => list.filter((r) => r.verdict === v).length;
  const countAny = (list: Row[], vs: Verdict[]) =>
    list.filter((r) => vs.includes(r.verdict)).length;

  const lines: string[] = [];
  lines.push(`# 失联文件诊断（${new Date().toISOString().slice(0, 10)}）`);
  lines.push("");
  lines.push(`- vault：\`${vault}\``);
  lines.push(`- 扫描：${tasks.length} 个任务文件夹，${rows.length} 个 .md`);
  lines.push(`- 远端：${repos.length} 个知识库 / ${remoteDocs} 篇；成功列出 ${listedNs.size} 个`);
  lines.push("");
  lines.push("判据：frontmatter `source` 的 namespace + slug 是否仍存在于远端任一知识库；");
  lines.push("「跨库」= 文件所在的文件夹属于 A 库，但文档实际属于 B 库。");
  lines.push("");
  lines.push("## 汇总");
  lines.push("");
  lines.push(
    "| 库文件夹 | 本地 | 正常 | 跨库 | 路径不一致 | 无记录 | 搬到别库 | 删除重建 | 已删除 | 无 source | 无法判定 |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const [folder, list] of byFolder) {
    lines.push(
      `| ${folder} | ${list.length} | ${count(list, "ok")} | ${count(list, "foreign")} | ` +
        `${count(list, "misplaced")} | ${count(list, "untracked")} | ` +
        `${countAny(list, ["moved-slug", "moved-title"])} | ${count(list, "recreated")} | ` +
        `${count(list, "deleted")} | ${count(list, "no-source")} | ${count(list, "unknown")} |`,
    );
  }
  lines.push(
    `| **合计** | **${rows.length}** | ${count(rows, "ok")} | ${count(rows, "foreign")} | ` +
      `${count(rows, "misplaced")} | ${count(rows, "untracked")} | ` +
      `${countAny(rows, ["moved-slug", "moved-title"])} | ${count(rows, "recreated")} | ` +
      `${count(rows, "deleted")} | ${count(rows, "no-source")} | ${count(rows, "unknown")} |`,
  );
  lines.push("");

  const section = (title: string, note: string, vs: Verdict[], grouped = false) => {
    const list = rows.filter((r) => vs.includes(r.verdict));
    lines.push(`## ${title}（${list.length} 篇）`);
    lines.push("");
    lines.push(note);
    lines.push("");
    if (grouped) {
      const groups = new Map<string, Row[]>();
      for (const r of list) push(groups, r.doc.ns || "(无 source)", r);
      for (const [ns, items] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
        lines.push(`### ${ns} → 落在 ${[...new Set(items.map((i) => i.doc.folder))].join("、")}（${items.length} 篇）`);
        lines.push("");
        for (const r of items.slice(0, 200)) lines.push(`- \`${r.doc.relPath}\``);
        if (items.length > 200) lines.push(`- …其余 ${items.length - 200} 篇见 JSON`);
        lines.push("");
      }
      return;
    }
    for (const r of list.slice(0, 300)) {
      const detail: string[] = [];
      if (r.hits.length) detail.push(`命中：${[...new Set(r.hits)].join("、")}`);
      if (r.statePath) detail.push(`同步记录路径：\`${r.statePath}\``);
      if (r.hitCreatedAt.length) {
        const same = r.doc.createdAt && r.hitCreatedAt.includes(r.doc.createdAt);
        detail.push(`远端 created_at ${r.hitCreatedAt[0]}${same ? "（与本地一致 ✓ 同一篇）" : ""}`);
      }
      lines.push(`- \`${r.doc.relPath}\`${detail.length ? " — " + detail.join("；") : ""}`);
    }
    if (list.length > 300) lines.push(`- …其余 ${list.length - 300} 篇见 JSON`);
    lines.push("");
  };

  section(
    "跨库：文件落在了别的知识库的文件夹里",
    "这些文档在语雀端**仍在原库**，只是本地文件躺在另一个任务的文件夹下。" +
      "最可能的原因是该库当时还没配置同步任务（09-15 体检时只有 5 个库有任务），" +
      "所以按「路径 / 标题匹配」的口径会被误判成孤儿。",
    ["foreign"],
    true,
  );
  section(
    "路径与同步记录不一致",
    "文档确实属于这个库，但同步记录指向另一个路径——同步正在维护的是那一份，这一份不会被更新，改动也会在下次同步后丢失。",
    ["misplaced"],
  );
  section(
    "在册但没有同步记录",
    "语雀端文档还在，但同步记录里没有它；下次同步会按语雀目录另建一份，与现有这份并存。",
    ["untracked"],
  );
  section(
    "搬到别的知识库",
    "**删了就丢数据**：文档被移到了别的库（slug 未变即同一篇）。",
    ["moved-slug"],
  );
  section(
    "疑似搬走（slug 变了，同标题出现在别的库）",
    "标题匹配会误伤通用标题（如「无标题文档」），务必看命中库与 created_at 再判断。",
    ["moved-title"],
  );
  section(
    "疑似删除后重建（同库有同标题文档）",
    "语雀端删除重建会换 slug，插件视作新文档。下一次同步会在同目录另建一份，本地这份成为旧副本。",
    ["recreated"],
  );
  section("语雀端已删除", "全账号任何库都找不到其 slug 与标题。属可归档对象。", ["deleted"]);
  section("无 source（本地自有文件）", "不是同步产物，插件不会碰它们。", ["no-source"]);
  section("无法判定", "所属知识库列表没取到，或 source 指向的库已不在账号内。", ["unknown"]);

  if (unlisted.length > 0) {
    lines.push("## 未能列出的知识库");
    lines.push("");
    for (const u of unlisted) lines.push(`- ${u}`);
    lines.push("");
  }

  lines.push("## 任务 → 知识库映射");
  lines.push("");
  lines.push("| 目标文件夹 | namespace |");
  lines.push("| --- | --- |");
  for (const t of tasks) lines.push(`| ${t.targetFolder || "(根目录)"} | ${t.namespace} |`);
  lines.push("");

  lines.push("## 覆盖范围");
  lines.push("");
  lines.push(
    `vault 共 ${vaultMd} 个 .md（不含 .obsidian），其中 ${coveredMd} 个在任务文件夹下（本次已诊断），` +
      `${vaultMd - coveredMd} 个不在任何任务文件夹下：`,
  );
  lines.push("");
  lines.push("| 顶层文件夹 | 未覆盖 .md |");
  lines.push("| --- | --- |");
  for (const [top, n] of [...uncovered].sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${top} | ${n} |`);
  }
  lines.push("");

  const outMd = `${outBase}.md`;
  const outJson = `${outBase}.json`;
  fs.mkdirSync(path.dirname(outMd), { recursive: true });
  fs.writeFileSync(outMd, lines.join("\n"), "utf8");
  fs.writeFileSync(outJson, JSON.stringify(rows, null, 2), "utf8");

  console.log("");
  console.log(
    VERDICTS.map((v) => `${v} ${count(rows, v)}`).join("｜"),
  );
  console.log(`报告：${outMd}`);
}

function classify(doc: LocalDoc): Row {
  const empty: Row = { doc, verdict: "ok", hits: [], hitCreatedAt: [], statePath: "" };
  if (!doc.hasSource) return { ...empty, verdict: "no-source" };
  // 所属库没列出来 → 不能下任何结论
  if (!listedNs.has(doc.ns)) return { ...empty, verdict: "unknown", hits: [doc.ns] };

  const key = `${doc.ns}/${doc.slug}`;
  const tracked = statePath.get(key) || "";

  if (remoteNsSlug.has(key)) {
    if (doc.ns !== doc.taskNs) {
      return { ...empty, verdict: "foreign", hits: [doc.ns], statePath: tracked };
    }
    if (!tracked) return { ...empty, verdict: "untracked", statePath: "" };
    if (tracked !== doc.relPath) {
      return { ...empty, verdict: "misplaced", statePath: tracked };
    }
    return { ...empty, statePath: tracked };
  }

  // 同 slug 出现在别的库 → 被搬走（同一篇文档换了家）
  const others = (slugToNs.get(doc.slug) || []).filter((n) => n !== doc.ns);
  if (others.length > 0) {
    const hits = others.map((n) => remoteNsSlug.get(`${n}/${doc.slug}`)).filter(Boolean);
    return {
      ...empty,
      verdict: "moved-slug",
      hits: others,
      hitCreatedAt: hits.map((h) => String(h!.created_at || "")).filter(Boolean),
      statePath: tracked,
    };
  }

  const sameTitle = titleIndex.get(norm(doc.title)) || [];
  const otherLibs = sameTitle.filter((h) => h.ns !== doc.ns);
  if (otherLibs.length > 0) {
    return {
      ...empty,
      verdict: "moved-title",
      hits: [...new Set(otherLibs.map((h) => h.ns))],
      hitCreatedAt: otherLibs.map((h) => String(h.doc.created_at || "")).filter(Boolean),
      statePath: tracked,
    };
  }
  if (sameTitle.length > 0) {
    return {
      ...empty,
      verdict: "recreated",
      hits: [doc.ns],
      hitCreatedAt: sameTitle.map((h) => String(h.doc.created_at || "")).filter(Boolean),
      statePath: tracked,
    };
  }
  return { ...empty, verdict: "deleted", statePath: tracked };
}

main().catch((e) => {
  console.error("失败：", (e as Error).message);
  process.exit(1);
});
