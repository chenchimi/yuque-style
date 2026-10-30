/**
 * 语雀 API 配额——全仓库的唯一来源，**区分「官方记载」与「本机实测」两件事**。
 *
 * 为什么必须区分：
 * - 官方文档《如何使用接口》记载得很明确：**每小时最多 5000 次、每秒最多 100 次**，
 *   且「个人或团队下的所有 Token 共享同一个使用次数限制」，并称响应头会返回
 *   `X-RateLimit-Limit` / `X-RateLimit-Remaining`。
 * - 但本仓库实测（见 `docs/free-account-alternatives.md`）：429 由网关直接吐出
 *   （`via: ...-p42hn[429]`），响应头里**没有** `X-RateLimit-*`，且同一枚 Token 的 429
 *   曾持续 ≥8 小时未恢复。这说明**大概率存在第二个、文档未记载的网关层限流器**，
 *   它的额度与窗口都不受官方那 5000/小时约束。
 *
 * 结论：官方数字可以写在文档与 UI 里（它确实是权威口径），但**不能拿它当预算分母**——
 * 用一把没量过你的尺子去限速，只会把「撞墙」换成「被自己卡住」。真正的门槛靠
 * `src/yuque/rate.ts` 的 429 时间线**自己量**。
 *
 * 实测方法：`node tools/quota-ceiling.mjs --recover`（会吃光当前小时配额，慎跑）
 */

/**
 * 网关层限流器的**实测证据**（2026-09-23 10:37，单次 `GET /api/v2/user` 即为 429）。
 *
 * 这条记录把本仓库此前所有互相矛盾的观察一次性解释清楚了：
 * - `Via: hz-crspanner-internet-prod-…[429]`：429 由**边缘网关**吐出，不是应用层；
 * - `Set-Cookie: acw_tc=…`：该边缘是**阿里云 WAF/CDN** 链路（`acw_tc` 是防 CC 令牌）；
 * - `X-OAuth-Scopes: …` 权限齐全：鉴权已通过，彻底排除「权限不足」；
 * - **没有** `X-RateLimit-Limit/Remaining/Reset`：不是「语雀不提供配额头」（旧版 UI 的断言），
 *   而是**网关先拦了，应用层还没来得及加这个头**；
 * - **单次请求**即 429（插件 400ms 节流远低于 100 次/秒）：不是突发限流，是**账号被置于惩罚态**；
 * - 09:44 与 10:37 两次都是 429：**跨过整点没有恢复**，推翻「按整点小时窗口重置」。
 *
 * 因此：官方那 5000 次/小时是**更内层的另一个限流器**，网关惩罚态生效期间根本用不上——
 * 也就意味着「省着用」救不了它，唯一能做的是**把触发时的累计请求数记下来**，
 * 让这个未知门槛逐渐可测（见 `rate.ts` 的观测门槛）。
 */
export const YUQUE_GATEWAY_LIMITER_EVIDENCE = {
  observedAt: "2026-09-23T10:37+08:00",
  /** 单次请求即 429，故不可能是突发限流 */
  singleRequest: true,
  via: "hz-crspanner-internet-prod-ea133-9gffh-8ksvm[429]",
  edge: "aliyun-waf",
  hasRateHeaders: false,
  scopes: "artboard,private_search,doc:read:detail,doc,repo,group",
  resetAtTopOfHour: false,
} as const;

/** 语雀官方文档记载的限额（权威口径，但不是本机的真实边界） */
export const YUQUE_QUOTA_DOCUMENTED = {
  limitPerHour: 5000,
  limitPerSecond: 100,
  /** 官方称响应头会返回 X-RateLimit-Limit / X-RateLimit-Remaining */
  returnsRateHeaders: true,
  /** 共享口径：个人或团队下的所有 Token 共用同一限额（故「多 Token 轮换」必然无效） */
  sharedAcrossTokens: true,
  source: "https://www.yuque.com/yuque/developer/openapi",
} as const;

/** 本机实测的每小时上限；null = 尚未测出（不许凭传闻写死数字） */
export const YUQUE_QUOTA_PER_HOUR: number | null = null;
export const YUQUE_QUOTA_MEASURED_AT = "";

/** 供 UI 与离线工具展示的一句话说明 */
export function describeQuota(): string {
  const doc =
    `语雀官方记载 ${YUQUE_QUOTA_DOCUMENTED.limitPerHour} 次/小时、` +
    `${YUQUE_QUOTA_DOCUMENTED.limitPerSecond} 次/秒（个人与团队下所有 Token 共享）；` +
    `但实测存在第二个、官方未记载的「网关层」限流器（由阿里云边缘吐出、不带 X-RateLimit-*、` +
    `且不在整点恢复），它生效期间官方那个额度用不上`;
  if (YUQUE_QUOTA_PER_HOUR === null) {
    return `${doc}。本机尚未实测出上限`;
  }
  return `${doc}。本机实测约 ${YUQUE_QUOTA_PER_HOUR} 次/小时（实测于 ${YUQUE_QUOTA_MEASURED_AT}）`;
}
