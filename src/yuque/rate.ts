/**
 * 配额观测与请求预算——「让同步在配额下可预期地跑完」的全部判据都收在这里。
 *
 * 为什么需要单独一个模块：
 * 1. 语雀的配额**不透明**，而且实测下来是**两个限流器**：官方文档《如何使用接口》记载的
 *    应用层 5000 次/小时（带 `X-RateLimit-*`），以及一个官方未记载的**网关层**限流器
 *    （`via` 带 `[429]`、由阿里云边缘吐出、**不带配额头、也不在整点恢复**，
 *    2026-09-23 实测确认，证据见 `quota.ts` 的 `YUQUE_GATEWAY_LIMITER_EVIDENCE`）。
 *    网关惩罚态生效期间，官方那个额度根本用不上——所以「省着用」救不了它。
 * 2. 因此**任何固定数字都不该被写死**：唯一可靠的来源是自己撞过的墙。本模块把每次 429
 *    发生时的「当小时累计请求数」记下来，形成一条本地可查的时间线，取历次最小值作为
 *    「观测门槛」，让这个未知门槛跨多次事件逐渐变得可测。
 * 2. 观测门槛 × 0.8 只作为**建议预算**展示，**绝不自动启用**：拿一个未证实的数字去限速，
 *    等于把「撞墙」换成「自己把自己卡住」，两者都不好受——要不要用由用户在设置里决定。
 *
 * 纯逻辑、不依赖 Obsidian，便于单测。
 */

import type { YuqueRateInfo } from "./api";

/** 429 明细的保留条数：够看出窗口与门槛，又不至于把 data.json 撑大 */
export const RATE_LOG_CAPACITY = 50;

/** 一次撞墙（429）的记录 */
export interface RateEvent {
  at: number;
  /** 本地时间的小时键（YYYY-MM-DDTHH），用于跨会话把请求数归到同一个小时候 */
  hourKey: string;
  /** 撞墙时本小时**本插件**已发出的 API 请求数（含触发 429 的这一次） */
  used: number;
  path: string;
  /** 响应头 via；带 [429] 表示限流发生在语雀网关层 */
  via?: string;
  /** 该 429 是否带了 X-RateLimit-*（带 = 应用层限流器；没带 = 疑似网关层） */
  hadRateHeaders: boolean;
}

export interface RateLog {
  /** 记账所属的小时（本地时间） */
  hourKey: string;
  /** 本小时本插件已发出的 API 请求数（图片走 CDN，不计入） */
  used: number;
  /**
   * 最近一次**未被网关拦截**的请求时间（非 429、且不是网络层失败）。
   * 它把「惩罚是从什么时候开始的」夹进一个区间：`lastAcceptedAt` 之后、首次 429 之前。
   * 网关惩罚不在整点恢复（实测），所以这个区间是目前唯一能估惩罚起点的东西。
   */
  lastAcceptedAt: string;
  events: RateEvent[];
  /**
   * 历次撞墙时的最小累计请求数 = 本机观测到的额度门槛。
   * 注意它是额度上限的**下界**：别的 Token / 别的工具共用同一额度时，真实上限更高。
   */
  minCeiling: number | null;
  minCeilingAt: string;
  /** 最近一次在响应头里读到的剩余额度（读不到就是 null，此时不得据此下结论） */
  headerRemaining: number | null;
  headerObservedAt: string;
}

export function emptyRateLog(): RateLog {
  return {
    hourKey: "",
    used: 0,
    lastAcceptedAt: "",
    events: [],
    minCeiling: null,
    minCeilingAt: "",
    headerRemaining: null,
    headerObservedAt: "",
  };
}

/** 读 data.json 里的旧值：字段缺失/类型不对一律回默认，坏了也不能让插件起不来 */
export function migrateRateLog(raw: unknown): RateLog {
  const base = emptyRateLog();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  base.hourKey = typeof r.hourKey === "string" ? r.hourKey : "";
  base.used = typeof r.used === "number" && Number.isFinite(r.used) ? r.used : 0;
  base.minCeilingAt = typeof r.minCeilingAt === "string" ? r.minCeilingAt : "";
  base.headerObservedAt = typeof r.headerObservedAt === "string" ? r.headerObservedAt : "";
  base.lastAcceptedAt = typeof r.lastAcceptedAt === "string" ? r.lastAcceptedAt : "";
  base.minCeiling =
    typeof r.minCeiling === "number" && Number.isFinite(r.minCeiling) ? r.minCeiling : null;
  base.headerRemaining =
    typeof r.headerRemaining === "number" && Number.isFinite(r.headerRemaining)
      ? r.headerRemaining
      : null;
  if (Array.isArray(r.events)) {
    base.events = r.events
      .filter((e): e is RateEvent => !!e && typeof e === "object" && typeof (e as RateEvent).at === "number")
      .slice(-RATE_LOG_CAPACITY);
  }
  return base;
}

/** 本地时间的小时键：观测门槛要跟用户的作息对齐，不用 UTC */
export function hourKeyOf(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
}

/**
 * 从响应头取值里抠出数字。
 * 语雀的头可能形如 `5000`、`"5000"`、`5000;w=3600`（有些网关会带参数），
 * 一律取第一段连续数字；取不到返回 null——**不猜**。
 */
export function parseRateNumber(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const m = String(raw).match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * 记一次响应（成功或失败都要记）：
 * - 每次调用 `used + 1`，跨过小时边界则本小时计数归零（观测门槛是跨小时的历史事实，保留）；
 * - 429：写一条明细，并刷新观测门槛；
 * - 非 429 且头里有剩余额度：记下「最近一次读到的剩余额度」。
 *
 * 就地修改并返回同一个对象（调用方是 settings，与 yuqueSyncState 的处理方式一致）。
 */
export function recordResponse(log: RateLog, info: YuqueRateInfo): RateLog {
  const hourKey = hourKeyOf(info.at);
  if (log.hourKey !== hourKey) {
    log.hourKey = hourKey;
    log.used = 0;
  }
  log.used += 1;

  const limit = parseRateNumber(info.limit);
  const remaining = parseRateNumber(info.remaining);
  const hadRateHeaders = limit !== null || remaining !== null;

  if (info.status === 429) {
    log.events = [
      ...log.events,
      { at: info.at, hourKey, used: log.used, path: info.path, via: info.via, hadRateHeaders },
    ].slice(-RATE_LOG_CAPACITY);
    if (log.minCeiling === null || log.used < log.minCeiling) {
      log.minCeiling = log.used;
      log.minCeilingAt = new Date(info.at).toISOString();
    }
  } else {
    // 非 429 且不是网络层失败（status 0）= 请求**被网关放行**，用来夹住惩罚起点
    if (info.status > 0) log.lastAcceptedAt = new Date(info.at).toISOString();
    if (remaining !== null) {
      log.headerRemaining = remaining;
      log.headerObservedAt = new Date(info.at).toISOString();
    }
  }
  return log;
}

/** 建议预算 = 观测门槛 × 0.8（留 20% 余量吸收别处的并发消耗）；没有门槛就不给数字 */
export function suggestBudget(log: RateLog): number | null {
  if (log.minCeiling === null) return null;
  return Math.floor(log.minCeiling * 0.8);
}

/** 诊断命令里展示的观测摘要（逐行）；`now` 可注入以便单测 */
export function describeRateLog(log: RateLog, now: number = Date.now()): string[] {
  const out: string[] = [];
  out.push(`本小时（${log.hourKey || "—"}）已发出 ${log.used} 次 API 请求（图片走 CDN，不计入）`);
  if (log.minCeiling === null) {
    out.push("尚无观测门槛：本机还没撞到过 429，暂时无从估计额度上限");
  } else {
    out.push(
      `观测门槛：历次撞墙时的最小累计请求数 ${log.minCeiling} 次（${formatAt(log.minCeilingAt)}）` +
        "——这是额度上限的下界（不是上限本身）；若与其它 Token / 工具共用额度，真实上限更高",
    );
    const s = suggestBudget(log);
    if (s !== null) {
      out.push(`建议预算：${s} 次/次同步（观测门槛 × 0.8）；填入「高级 → 每次同步请求上限」后才生效`);
    }
  }
  out.push(
    log.headerRemaining === null
      ? "从未在响应头里读到 X-RateLimit-Remaining（官方文档称会返回，实测未见）"
      : `最近一次读到的剩余额度：${log.headerRemaining}（${formatAt(log.headerObservedAt)}）`,
  );
  if (log.lastAcceptedAt) {
    out.push(`最后一次未被网关拦截的请求：${formatAt(log.lastAcceptedAt)}`);
  }
  const lastEvent = log.events[log.events.length - 1];
  if (lastEvent) {
    // 网关惩罚不在整点恢复（实测），所以「起点在最后一次放行之后、首次 429 之前」这个区间
    // 是估算惩罚持续时间的唯一线索
    const bound = log.lastAcceptedAt
      ? `起点在 ${formatAt(log.lastAcceptedAt)} 之后、${new Date(lastEvent.at).toLocaleString()} 之前`
      : "起点未知（本地没有更早的放行记录）";
    out.push(`最近一次 429 距今 ${formatDuration(now - lastEvent.at)}（${bound}）`);
  }
  const recent = log.events.slice(-3);
  if (recent.length > 0) {
    out.push("最近 429：");
    for (const e of recent) {
      out.push(
        `  · ${new Date(e.at).toLocaleString()} ${e.path}` +
          `（当小时第 ${e.used} 次，${e.hadRateHeaders ? "带配额头" : "无配额头"}` +
          `${e.via ? `，via ${e.via}` : ""}）`,
      );
    }
  }
  return out;
}

function formatAt(iso: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
}

/** 时长口径与顶栏的「最近编辑」保持一致：分钟以内给分钟，超过给「N 小时 M 分钟」 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

export interface BudgetDecision {
  /** 本次运行还能发多少次请求；null = 不限 */
  allowance: number | null;
  /** 判据来源：response header / 用户设置 / 都没设 */
  source: "header" | "setting" | "none";
}

/**
 * 本次运行还剩多少请求可发。多个判据同时存在时取**最严**的那个：
 * 用户显式设了上限就绝不超过它，同时也不会超过响应头给出的剩余额度。
 *
 * `usedThisRun` 由 `YuqueApi.requestCount` 提供（只统计开放 API 请求，图片不计）。
 */
export function decideBudget(opts: {
  setting: number;
  usedThisRun: number;
  headerRemaining: number | null;
}): BudgetDecision {
  const candidates: { v: number; src: "header" | "setting" }[] = [];
  if (opts.headerRemaining !== null) candidates.push({ v: opts.headerRemaining, src: "header" });
  if (opts.setting > 0) candidates.push({ v: opts.setting - opts.usedThisRun, src: "setting" });
  if (candidates.length === 0) return { allowance: null, source: "none" };
  candidates.sort((a, b) => a.v - b.v);
  return { allowance: Math.max(0, candidates[0].v), source: candidates[0].src };
}

/** 预算判据的中文说明，直接进日志 */
export function budgetSourceLabel(source: BudgetDecision["source"]): string {
  if (source === "header") return "来自响应头的剩余额度";
  if (source === "setting") return "来自设置项「每次同步请求上限」";
  return "未设上限";
}

/**
 * 完整响应头转成可打印的行。
 * 这一步是本次排查最缺的能力：此前诊断只挑 `via` / `x-oauth-scopes` / `retry-after` 三个名字看，
 * 于是「语雀不返回 X-RateLimit-*」这个结论其实从未被完整验证过。
 */
export function headerDump(headers: Record<string, string> | undefined): string[] {
  if (!headers) return [];
  return Object.keys(headers)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((k) => `${k}: ${headers[k]}`);
}
