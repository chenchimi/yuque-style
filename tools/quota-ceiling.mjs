/**
 * 语雀 API 配额探测：轻探「恢复周期」+ 连打测「窗口内真实配额」。
 *
 * 为什么这样设计（2026-09-23 实测教训）：
 *   最初的假设是「小时级配额，等 10-60 分钟恢复」，据此把 census 里的配额写死成传闻的 5000。
 *   实测推翻：同一枚 Token 的 429 从 00:33 持续到 08:43（≥8 小时）仍未恢复，
 *   同 IP 取页面却仍是 200（排除 IP 封禁），scopes 始终完整（排除权限）。
 *   所以要先测的不是「每小时能打多少」，而是「**多久恢复一次**」——周期可能是按天的。
 *
 * 语雀不给任何配额头（无 X-RateLimit-*、无 Retry-After），因此只能这样测。
 *
 * 用法：
 *   node tools/quota-ceiling.mjs --dry                  # 1 次探测：看当前是 429 还是已恢复
 *   node tools/quota-ceiling.mjs --watch                # 轻探等恢复 → 恢复后连打数配额（推荐）
 *   node tools/quota-ceiling.mjs --watch --cycles=2     # 跑两个完整周期（能算出窗口长度）
 *   node tools/quota-ceiling.mjs --burst                # 已知已恢复，直接连打到 429
 *
 * 产物（均在已 gitignore 的 tools/.probe/ 下）：
 *   quota-watch.log          逐次探测的时间线（UTF-8，随时可看进度）
 *   quota-watch.json         结构化状态
 *   quota-ceiling-summary.md 结论摘要（供人读、供填进 src/yuque/quota.ts）
 *
 * 停止方式：Ctrl+C，或新建 tools/.probe/quota-watch.stop 文件（后台运行时用后者）。
 *
 * ⚠️ --burst 阶段会把当前窗口的配额吃光，期间插件无法同步。要同步请先停止本探针。
 * 安全性：只读 GET /api/v2/user，不触碰任何文档内容，**从不打印 Token**。
 */
import fs from "fs";
import path from "path";

/* ---------- 参数 ---------- */

function arg(name, def) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const flag = (name) => process.argv.slice(2).includes(`--${name}`);

const DATA_FILE = arg("data", "H:/语雀/.obsidian/plugins/yuque-style/data.json");
const PROBE_INTERVAL = Number(arg("probeInterval", String(30 * 60 * 1000))); // 轻探间隔，默认 30 分钟
const BURST_INTERVAL = Number(arg("burstInterval", "450")); // 连打间隔，贴近插件真实节奏
const MAX_BURST = Number(arg("maxBurst", "20000")); // 连打上限，防呆
const CYCLES = Number(arg("cycles", "1"));
const MAX_HOURS = Number(arg("maxHours", "36"));
const UA = "obsidian-yuque-style";
const URL_USER = "https://www.yuque.com/api/v2/user";
/** 首次观测到 429 的时刻（已知事实，用于给第一周期的等待时间一个下界） */
const SINCE = arg("since", "2026-09-23T00:33:00+08:00");

const OUT_DIR = path.join(process.cwd(), "tools", ".probe");
const LOG_FILE = path.join(OUT_DIR, "quota-watch.log");
const STATE_FILE = path.join(OUT_DIR, "quota-watch.json");
const STOP_FILE = path.join(OUT_DIR, "quota-watch.stop");
const SUMMARY_FILE = path.join(OUT_DIR, "quota-ceiling-summary.md");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const local = (d = new Date()) =>
  new Date(d).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
const hhmmss = (d = new Date()) =>
  new Date(d).toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
const hoursSince = (iso) => (Date.now() - new Date(iso).getTime()) / 3600000;

function appendLog(line) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // 行首用本地时间（Asia/Shanghai）：这份日志要被人跨一整天读，
  // 统一时区比统一格式更重要（UTC 会让人每次都要心算 -8h）
  fs.appendFileSync(LOG_FILE, `[${local()}] ${line}\n`, "utf8");
}
function say(line) {
  console.log(line);
  appendLog(line);
}
const stopped = () => fs.existsSync(STOP_FILE);

function loadToken() {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (!data.yuqueToken) throw new Error(`${DATA_FILE} 中没有 yuqueToken`);
  return data.yuqueToken;
}

/* ---------- 请求 ---------- */

async function hit(token) {
  const t0 = Date.now();
  try {
    const res = await fetch(URL_USER, {
      headers: { "X-Auth-Token": token, "User-Agent": UA },
    });
    const body = await res.text();
    return {
      status: res.status,
      ms: Date.now() - t0,
      scopes: res.headers.get("x-oauth-scopes") || undefined,
      via: res.headers.get("via") || undefined,
      retryAfter: res.headers.get("retry-after") || undefined,
      body: body.slice(0, 200),
    };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, err: e.message };
  }
}

/* ---------- 阶段一：轻探等恢复 ---------- */

/**
 * 每 PROBE_INTERVAL 探一次，直到 200。
 * 返回 { recoveredAt, probes }；超时或被打断则 recoveredAt 为 null。
 */
async function waitForRecovery(token, label) {
  const startedAt = Date.now();
  let probes = 0;
  say(`开始轻探（${label}）：每 ${PROBE_INTERVAL / 60000} 分钟 1 次 /user，最多 ${MAX_HOURS} 小时`);
  for (;;) {
    const r = await hit(token);
    probes++;
    const waited = ((Date.now() - startedAt) / 3600000).toFixed(2);
    say(
      `  轻探 #${probes} → ${r.status}` +
        (r.status === 429 ? `（仍限流，已等待 ${waited}h，距首次观测 429 ${hoursSince(SINCE).toFixed(1)}h）` : ""),
    );
    if (r.status === 200) {
      return { recoveredAt: new Date(), probes, scopes: r.scopes, via: r.via };
    }
    if (r.status === 401) {
      say(`  401：Token 无效（与限流无关），探针终止`);
      return { recoveredAt: null, probes, fatal: "401 Token 无效" };
    }
    if (stopped()) {
      say(`  检测到 ${path.basename(STOP_FILE)}，探针终止`);
      return { recoveredAt: null, probes, fatal: "stop file" };
    }
    if ((Date.now() - startedAt) / 3600000 > MAX_HOURS) {
      say(`  已超过 --maxHours=${MAX_HOURS}，放弃等待`);
      return { recoveredAt: null, probes, fatal: "maxHours" };
    }
    await sleep(PROBE_INTERVAL);
  }
}

/* ---------- 阶段二：连打数配额 ---------- */

/** 连打直到 429，返回成功次数与首个 429 的信息；期间不再退避（这里就是要打满） */
async function burst(token) {
  const t0 = Date.now();
  let ok = 0;
  for (let i = 1; i <= MAX_BURST; i++) {
    if (stopped()) return { ok, exhaustedAt: null, fatal: "stop file" };
    const r = await hit(token);
    if (r.status === 200) {
      ok = i;
      if (i % 100 === 0) say(`  连打 ${i} 次，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      await sleep(BURST_INTERVAL);
      continue;
    }
    if (r.status === 429) {
      return { ok, exhaustedAt: new Date(), first429: r };
    }
    say(`  连打遇到意外状态 ${r.status}${r.err ? ` (${r.err})` : ""}，中止`);
    return { ok, exhaustedAt: null, fatal: `status ${r.status}` };
  }
  return { ok, exhaustedAt: null, fatal: `达到 --maxBurst=${MAX_BURST} 仍未 429` };
}

/* ---------- 汇总 ---------- */

function writeSummary(cycles) {
  const lines = [
    "# 语雀配额实测结论",
    "",
    `> 探测脚本：\`tools/quota-ceiling.mjs --watch\`（只读 \`GET /api/v2/user\`）`,
    `> 生成时间：${local()}　·　首次观测到 429：${local(new Date(SINCE))}`,
    "",
    "| 周期 | 恢复时刻 | 自首次观测 429 起 | 恢复后成功请求数 | 再次触发 429 | 连打耗时 |",
    "|---|---|---|---|---|---|",
  ];
  cycles.forEach((c, i) => {
    lines.push(
      `| ${i + 1} | ${c.recoveredAt ? local(c.recoveredAt) : "未恢复"} | ` +
        `${c.sinceHours !== undefined ? c.sinceHours.toFixed(1) + " h" : "-"} | ` +
        `${c.ok ?? "-"} | ${c.exhaustedAt ? local(c.exhaustedAt) : "-"} | ` +
        `${c.burstSec !== undefined ? c.burstSec.toFixed(0) + " s" : "-"} |`,
    );
  });
  lines.push(
    "",
    "## 怎么读这两组数字",
    "",
    "- **自首次观测 429 起的时长**：429 持续了多久才恢复，是「窗口下限」。真实窗口只会更长（因为配额可能在 00:33 之前就已耗尽）。",
    "- **恢复后成功请求数**：这才是该 Token 在**一个窗口内**真正能打的次数。此前 `census.ts` 里写死的 5000 是传闻，无任何出处。",
    "- 若跑了多个周期，「恢复时刻 → 上次触发 429 时刻」的间隔就是**窗口长度**。",
    "",
    "## 下一步",
    "",
    "把「恢复后成功请求数」填进 `src/yuque/quota.ts` 的 `YUQUE_QUOTA_PER_HOUR`（连同实测日期），",
    "`tools/census.ts` 与插件诊断命令会自动跟随；同时更正 `docs/free-account-alternatives.md` 第二节中",
    "「按小时窗口重置」的旧表述。",
    "",
  );
  fs.writeFileSync(SUMMARY_FILE, lines.join("\n"), "utf8");
  return SUMMARY_FILE;
}

/* ---------- 主流程 ---------- */

async function main() {
  const token = loadToken();
  say(`=== 语雀配额探测 ===`);
  say(`端点 ${URL_USER}　·　轻探间隔 ${PROBE_INTERVAL / 60000} 分钟　·　周期数 ${CYCLES}`);
  say(`首次观测到 429：${local(new Date(SINCE))}`);

  if (flag("dry")) {
    const r = await hit(token);
    say(
      `dry：status=${r.status}　scopes=${(r.scopes || "(无)").slice(0, 40)}　via=${r.via || "(无)"}`,
    );
    say(r.status === 429 ? "→ 仍在限流中：用 --watch 等待恢复" : "→ 已恢复：用 --burst 直接数配额");
    return;
  }

  if (flag("burst")) {
    const t0 = Date.now();
    const b = await burst(token);
    const burstSec = (Date.now() - t0) / 1000;
    say(`连打结束：成功 ${b.ok} 次${b.first429 ? "，随后 429" : ""}（用时 ${burstSec.toFixed(0)}s）`);
    writeSummary([
      {
        recoveredAt: new Date(),
        sinceHours: hoursSince(SINCE),
        ok: b.ok,
        exhaustedAt: b.exhaustedAt,
        burstSec,
      },
    ]);
    return;
  }

  // --watch（默认行为）
  const cycles = [];
  for (let c = 1; c <= CYCLES; c++) {
    say("");
    say(`—— 周期 ${c}/${CYCLES} ——`);
    const rec = await waitForRecovery(token, `周期 ${c}`);
    if (!rec.recoveredAt) {
      cycles.push({ recoveredAt: null, fatal: rec.fatal });
      break;
    }
    say(
      `✅ 恢复！时刻 ${local(rec.recoveredAt)}（距首次观测 429 ${hoursSince(SINCE).toFixed(1)}h）` +
        `　scopes=${(rec.scopes || "(无)").slice(0, 40)}`,
    );

    const startedBurst = Date.now();
    const b = await burst(token);
    const burstSec = (Date.now() - startedBurst) / 1000;
    say(
      `连打结束：恢复后成功 ${b.ok} 次，用时 ${burstSec.toFixed(0)}s` +
        (b.exhaustedAt ? `，于 ${local(b.exhaustedAt)} 再次触发 429` : `（${b.fatal || "未触发 429"}）`),
    );
    cycles.push({
      recoveredAt: rec.recoveredAt,
      // 固化在恢复那一刻，而不是写摘要时再算——多周期时后者会一路变大
      sinceHours: hoursSince(SINCE),
      ok: b.ok,
      exhaustedAt: b.exhaustedAt,
      burstSec,
      first429: b.first429,
    });

    const state = { updatedAt: nowIso(), since: SINCE, cycles };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
    if (b.fatal) break;
  }

  const summary = writeSummary(cycles);
  say("");
  say(`结论已写入 ${summary}`);
  say(`时间线日志 ${LOG_FILE}`);
  if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE);
}

main().catch((e) => {
  say(`失败：${e.message}`);
  process.exit(1);
});
