/**
 * 全量同步耗时盘点：列出账号下所有知识库与文档数，估算同步时间与 API 配额占用。
 *
 * 用法：node tools/.probe/census.cjs [--perDoc=0.41] [--perImage=0.5]
 *
 * 时间模型（均来自实测，可命令行覆盖）：
 *   文档详情 1 次请求/篇  → perDoc 秒（400ms 节流 + 网络，AI 库实测 0.41s）
 *   图片下载 1 次请求/张  → perImage 秒；但**已存在的图片不请求**（sync.ts 的 exists 跳过）
 *   每库固定开销         → TOC 1 次 + 文档列表 ceil(篇数/100) 次
 */
import fs from "fs";
import { YuqueApi } from "../src/yuque/api";
import type { YuqueRepo } from "../src/yuque/api";

function arg(name: string, def: string): string {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const PER_DOC = Number(arg("perDoc", "0.41"));
const PER_IMAGE = Number(arg("perImage", "0.5"));
const QUOTA = Number(arg("quota", "5000")); // 语雀免费账户 API 配额（次/小时）

function fmt(sec: number): string {
  if (sec < 60) return `${sec.toFixed(0)} 秒`;
  const m = sec / 60;
  if (m < 60) return `${m.toFixed(1)} 分钟`;
  return `${(m / 60).toFixed(1)} 小时`;
}

interface Est {
  docs: number;
  images: number;
  requests: number;
  secNoImage: number;
  secWithImage: number;
}

function estimate(repos: YuqueRepo[], imgPerDoc: number): Est {
  let docs = 0;
  let requests = 0;
  for (const r of repos) {
    const n = r.items_count ?? 0;
    docs += n;
    requests += 1 + Math.max(1, Math.ceil(n / 100)) + n; // TOC + 列表 + 每篇详情
  }
  const images = Math.round(docs * imgPerDoc);
  return {
    docs,
    images,
    requests,
    secNoImage: requests * PER_DOC,
    secWithImage: requests * PER_DOC + images * PER_IMAGE,
  };
}

async function main(): Promise<void> {
  const dataFile = arg("data", "H:/语雀/.obsidian/plugins/yuque-style/data.json");
  const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  const token: string = data.yuqueToken || "";
  if (!token) throw new Error("data.json 中没有 yuqueToken");

  const api = new YuqueApi(token);
  const user = await api.getUser();
  console.log(`账号: ${user?.login ?? "(未知)"}  名称: ${user?.name ?? "-"}`);
  const repos: YuqueRepo[] = await api.getRepos();
  repos.sort((a, b) => (b.items_count ?? 0) - (a.items_count ?? 0));

  const configured: string[] = (data.yuqueTasks || []).map((t: any) => t.namespace);
  const confSet = new Set(configured);

  console.log("");
  console.log("库名".padEnd(24) + "篇数".padStart(6) + "  namespace                    状态");
  for (const r of repos) {
    const mark = confSet.has(r.namespace) ? "已配置" : "";
    console.log(
      (r.name ?? "").slice(0, 22).padEnd(24) +
        String(r.items_count ?? 0).padStart(6) +
        "  " +
        (r.namespace ?? "").padEnd(30) +
        mark,
    );
  }

  // 实测图片密度：已同步的旧库 402 篇 → 4283 张
  const imgPerDoc = Number(arg("imgPerDoc", String(4283 / 402)));

  const all = estimate(repos, imgPerDoc);
  console.log("");
  console.log(`知识库总数: ${repos.length}    文档总数: ${all.docs}`);

  // 已配置库
  const confRepos = repos.filter((r) => confSet.has(r.namespace));
  const c = estimate(confRepos, imgPerDoc);
  console.log(`已配置同步: ${confRepos.length} 库 / ${c.docs} 篇（占 ${((c.docs / (all.docs || 1)) * 100).toFixed(0)}%）`);

  console.log("");
  console.log("=== 耗时估算 ===");
  console.log(
    `仅已配置的 ${confRepos.length} 库：文档请求 ${c.requests} 次 → ${fmt(c.secNoImage)}（图片已存在，不请求）`,
  );
  console.log(`全部 ${repos.length} 库     ：文档请求 ${all.requests} 次 → ${fmt(all.secNoImage)}`);
  console.log(
    `全部 ${repos.length} 库首次同步（空 vault，需下图片约 ${Math.round(all.docs * imgPerDoc)} 张）→ ${fmt(all.secWithImage)}`,
  );

  console.log("");
  console.log("=== API 配额（免费账户约 " + QUOTA + " 次/小时）===");
  const pct = ((all.requests / QUOTA) * 100).toFixed(0);
  console.log(
    `全量一輪请求 ${all.requests} 次 = 配额的 ${pct}%` +
      (all.requests > QUOTA ? " → 会触发 429 退避，实际更久" : " → 配额内可完成"),
  );
}

main().catch((e) => {
  console.error("失败：", (e as Error).message);
  process.exit(1);
});
