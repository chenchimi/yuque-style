import { requestUrl } from "obsidian";
import { parseRateNumber } from "./rate";

const BASE = "https://www.yuque.com/api/v2";

/** /user 端点返回的用户信息（诊断与「测试连接」只用到这几个字段） */
export interface YuqueUser {
  id: number;
  login?: string;
  name?: string;
}

export interface YuqueRepo {
  id: number;
  namespace: string;
  name: string;
  description?: string;
  items_count?: number;
  updated_at?: string;
}

export interface YuqueDocSummary {
  id: number;
  slug: string;
  title: string;
  word_count?: number;
  updated_at: string;
  created_at?: string;
  status?: string;
}

export interface YuqueDocDetail extends YuqueDocSummary {
  body: string;
  description?: string;
  /**
   * 语雀标签。实测（全库 1964 篇补齐元数据、无一篇拿到标签）该接口不返回此字段，
   * 保留声明只为「哪天语雀提供了能自动生效」，读取端一律按「可能为空」处理。
   */
  tags?: { name?: string; title?: string }[];
}

export interface YuqueTocNode {
  uuid: string;
  parent_uuid: string;
  title: string;
  type: string; // "TITLE" | "DOC" | ...
  slug?: string;
  level?: number;
  url?: string;
}

/**
 * namespace 形如 "login/book_slug"，含 "/"。
 * 不能整体 encodeURIComponent（会把 / 编成 %2F，可能被服务端网关误路由），
 * 须按段编码后用原始 "/" 连接。
 */
export function nsPath(namespace: string): string {
  return String(namespace).split("/").map(encodeURIComponent).join("/");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class YuqueApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "YuqueApiError";
  }
}

/**
 * 最近一次请求的限流/权限线索。
 *
 * 关于 `X-RateLimit-*`：官方文档《如何使用接口》明确说响应头会返回
 * `X-RateLimit-Limit`（总次数限制）与 `X-RateLimit-Remaining`（剩余次数），
 * 但本仓库**实测在 429 响应上未见该头**。两者并不矛盾——网关层限流先于应用层拦截时，
 * 配额头不会出现。所以这里一律如实捕获，**读不到就是读不到**，调用方不得据此下结论说
 * 「语雀不提供配额头」（旧版 UI 就写死过这句话，没有任何代码验证过它）。
 */
export interface YuqueRateInfo {
  path: string;
  status: number;
  at: number;
  /** 形如 hz-crspanner-internet-prod-xxx[429]；带 [429] 说明限流发生在语雀网关层 */
  via?: string;
  /** Token 实际权限（x-oauth-scopes）。被 429 拦下时仍会返回，可据此排除权限问题 */
  scopes?: string;
  retryAfter?: string;
  /** X-RateLimit-Limit（官方称会返回；实测可能缺失） */
  limit?: string;
  /** X-RateLimit-Remaining（读到时用它做预算，比任何固定数字都准） */
  remaining?: string;
  /** X-RateLimit-Reset */
  reset?: string;
}

/**
 * 每次请求后的观测回调。
 * 记账（本小时请求数、429 时间线）落盘在插件设置里，`YuqueApi` 本身不碰 Obsidian 存储，
 * 离线工具（tools/）因此可以继续用 `new YuqueApi(token)` 不传回调。
 */
export type RateObserver = (info: YuqueRateInfo) => void;

/**
 * 配额已用尽。与普通请求失败的关键区别：这不是 Token 失效、不是权限不足，也不是某篇文档的问题——
 * 因此**逐篇重试毫无意义**，调用方必须立即熔断并落盘已完成的进度（见 sync.ts）。
 *
 * 措辞刻意不承诺「一小时后恢复」：官方记载是 5000 次/小时，但实测 429 由网关吐出、
 * 不带配额头，且曾持续 ≥8 小时未恢复——恢复周期是**未知**的，说成按小时重置会误导用户。
 */
export class YuqueQuotaError extends YuqueApiError {
  constructor(public path: string, public rate?: YuqueRateInfo) {
    super(
      `语雀 API 配额已用尽（429，${path}）：该限制按账号/团队维度生效（同一账号下所有 Token 共享），` +
        `不是 Token 失效或权限不足（Token 范围：${rate?.scopes ?? "未知"}）。` +
        `官方记载 5000 次/小时，但实测该 429 由网关吐出且不带 X-RateLimit-*，恢复周期未确定。` +
        `已完成的文档已保存，稍后再执行同步会自动从未完成处继续。`,
      429,
    );
    this.name = "YuqueQuotaError";
  }
}

/** 是否为「配额用尽」——调用方据此熔断，而不是把它当成单篇失败继续往下试 */
export function isQuotaExhausted(e: unknown): e is YuqueQuotaError {
  return e instanceof YuqueQuotaError;
}

/** 响应头大小写不敏感取值（Obsidian requestUrl 的 headers 大小写不保证） */
export function pickHeader(
  headers: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const want = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === want) {
      const v = headers[k];
      return v === undefined || v === null ? undefined : String(v);
    }
  }
  return undefined;
}

/** Obsidian requestUrl 的响应形状（只声明用到的字段；headers 大小写不保证） */
interface UrlResponse {
  status: number;
  json?: { message?: string; data?: unknown };
  text?: string;
  headers?: Record<string, unknown>;
}

/**
 * 语雀开放 API v2 客户端。
 * - 认证：X-Auth-Token（唯一通道；语雀不给个人开放的 OAuth 申请，Cookie 通道不进插件）
 * - 节流：请求间隔 >= 400ms
 * - 429：先做 2 秒短探测（区分突发限流与配额耗尽），仍 429 则抛 YuqueQuotaError 熔断。
 * - 观测：每次请求都会把响应头线索交给 `onRate` 回调，由插件侧记进 429 时间线（见 rate.ts）。
 *
 * 关于配额数字：官方文档《如何使用接口》记载 5000 次/小时、100 次/秒，并称返回
 * `X-RateLimit-*`；实测 429 上却看不到该头、且曾持续 ≥8 小时不恢复。所以**不要**把官方
 * 那个数字当预算分母，也不要凭传闻写死——真实的边界靠 rate.ts 的观测门槛自己量。
 */
export class YuqueApi {
  private lastReqAt = 0;
  /** 最近一次请求的限流/权限线索，供诊断命令读取 */
  lastRateInfo: YuqueRateInfo | null = null;
  /**
   * 本次运行已发出的开放 API 请求数（图片下载走 CDN、不带 Token，故不计入）。
   * 供预算判定使用：用户设了「每次同步请求上限」时，用它算已用掉多少。
   */
  requestCount = 0;

  constructor(private token: string, private onRate?: RateObserver) {}

  /** 最近一次响应头里读到的剩余额度；读不到（或不是数字）返回 null */
  get remainingFromHeader(): number | null {
    return parseRateNumber(this.lastRateInfo?.remaining);
  }

  setToken(token: string): void {
    this.token = token;
  }

  private async throttle(): Promise<void> {
    const minGap = 400;
    const wait = this.lastReqAt + minGap - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastReqAt = Date.now();
  }

  /**
   * Obsidian requestUrl 的响应形状（只声明用到的字段；headers 大小写不保证）。
   * json 只在诊断文案（message）与取 data 两处被读，其余一律当 unknown 处理。
   */
  private async send(path: string): Promise<UrlResponse> {
    const res = (await requestUrl({
      url: BASE + path,
      method: "GET",
      headers: {
        "X-Auth-Token": this.token,
        "User-Agent": "obsidian-yuque-style",
      },
      throw: false,
    })) as UrlResponse;
    this.captureRate(path, res);
    return res;
  }

  /** 把响应头里的限流/权限线索记下来（语雀只在头里给这些信息） */
  private captureRate(
    path: string,
    res: { status: number; headers?: Record<string, unknown> },
  ): void {
    this.requestCount++;
    this.lastRateInfo = {
      path,
      status: res.status,
      at: Date.now(),
      via: pickHeader(res.headers, "via"),
      scopes: pickHeader(res.headers, "x-oauth-scopes"),
      retryAfter: pickHeader(res.headers, "retry-after"),
      limit: pickHeader(res.headers, "x-ratelimit-limit"),
      remaining: pickHeader(res.headers, "x-ratelimit-remaining"),
      reset: pickHeader(res.headers, "x-ratelimit-reset"),
    };
    // 观测回调：进程外的记账（429 时间线、本小时请求数）交给调用方，api 本身不落盘
    this.onRate?.(this.lastRateInfo);
  }

  private async requestJson<T = unknown>(
    path: string,
    onRetry?: (waitSec: number, attempt: number) => void,
  ): Promise<T> {
    // 429 只做一次短探测：突发限流 2 秒后已自愈；小时级配额不会。
    // 旧实现是 5s/15s/30s 长退避（共 50s）× 每篇重试，配额耗尽时会把全量同步拖成数小时空转。
    const maxAttempts = 2;
    const quotaProbeMs = 2000;
    for (let attempt = 1; ; attempt++) {
      await this.throttle();
      let res: UrlResponse;
      try {
        res = await this.send(path);
      } catch (e) {
        // 网络层异常（DNS、断网等）
        throw new YuqueApiError(`请求异常（${path}）：${(e as Error).message}`, 0);
      }
      if (res.status === 429) {
        if (attempt >= maxAttempts) {
          throw new YuqueQuotaError(path, this.lastRateInfo ?? undefined);
        }
        onRetry?.(Math.round(quotaProbeMs / 1000), attempt);
        await sleep(quotaProbeMs);
        this.lastReqAt = 0;
        continue;
      }
      if (res.status === 401) {
        throw new YuqueApiError("Token 无效或已过期，请到语雀「设置 → Token」重新生成", 401);
      }
      if (res.status === 404) {
        throw new YuqueApiError(
          `接口不存在或无权访问（404）：${path}。若为知识库列表请求，请确认插件已更新到最新版本`,
          404,
        );
      }
      if (res.status >= 400) {
        // json 已按形状声明，这里读 message 不会抛
        const msg = res.json?.message ?? `HTTP ${res.status}`;
        throw new YuqueApiError(`语雀 API 请求失败（${path}）：${msg}`, res.status);
      }
      return res.json?.data as T;
    }
  }

  /** 当前用户信息（用于验证 Token） */
  async getUser(): Promise<YuqueUser> {
    return this.requestJson<YuqueUser>("/user");
  }

  /** 我的知识库列表（自动翻页）。语雀 v2 无 /repos 端点，须用 /users/:login/repos */
  async getRepos(): Promise<YuqueRepo[]> {
    const user = await this.getUser();
    const login = user?.login || user?.id;
    if (!login) throw new YuqueApiError("无法获取当前用户信息（Token 无效？）", 401);
    const out: YuqueRepo[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.requestJson<YuqueRepo[]>(
        `/users/${encodeURIComponent(String(login))}/repos?offset=${offset}&limit=100`,
      );
      if (!Array.isArray(page) || page.length === 0) break;
      out.push(...page);
      if (page.length < 100) break;
      offset += 100;
    }
    return out;
  }

  /**
   * 知识库文档列表（自动翻页）。
   * 兼容两种 namespace：若标准 namespace 取到 0 篇但 TOC 非空，可能是团队库（namespace
   * 以 group login 开头但返回的 namespace 字段缺失/不一致），此时按 TOC 里记录的
   * namespace 重试一次。
   */
  async getDocList(namespace: string): Promise<YuqueDocSummary[]> {
    let list = await this.getDocListOnce(namespace);
    if (list.length > 0) return list;

    // 0 篇：检查 TOC 是否有内容，并探测正确的 namespace
    try {
      const toc = await this.getTocOnce(namespace);
      if (toc.length === 0) return list; // 确实是空库
      // TOC 节点 url 形如 /<namespace>/<slug>，可提取真实 namespace
      for (const node of toc) {
        if (node.url) {
          const m = node.url.match(/^\/([^/]+)\/([^/]+)/);
          if (m && m[1] && m[1] !== namespace) {
            const retry = await this.getDocListOnce(m[1]);
            if (retry.length > 0) return retry;
          }
        }
      }
      // TOC 有内容但 namespace 没变：文档可能未加入目录，返回 0 篇列表
      return list;
    } catch {
      return list;
    }
  }

  /** 单次获取文档列表（无探测重试，节省配额；探测逻辑由调用方决定） */
  async getDocListOnce(namespace: string): Promise<YuqueDocSummary[]> {
    const out: YuqueDocSummary[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.requestJson<YuqueDocSummary[]>(
        `/repos/${nsPath(namespace)}/docs?offset=${offset}&limit=100`,
      );
      if (!Array.isArray(page) || page.length === 0) break;
      out.push(...page);
      if (page.length < 100) break;
      offset += 100;
    }
    return out;
  }

  /** 目录树（TOC 可能有内容但 docs 列表为空——文档未加入目录的情况） */
  async getTocOnce(namespace: string): Promise<YuqueTocNode[]> {
    const data = await this.requestJson<YuqueTocNode[]>(`/repos/${nsPath(namespace)}/toc`);
    return Array.isArray(data) ? data : [];
  }

  /** 文档详情（body 为 Lake 格式） */
  async getDoc(namespace: string, slug: string): Promise<YuqueDocDetail> {
    return this.requestJson<YuqueDocDetail>(
      `/repos/${nsPath(namespace)}/docs/${encodeURIComponent(slug)}`,
    );
  }

  /** 知识库目录树 */
  async getToc(namespace: string, onRetry?: (waitSec: number, attempt: number) => void): Promise<YuqueTocNode[]> {
    const data = await this.requestJson<YuqueTocNode[]>(`/repos/${nsPath(namespace)}/toc`, onRetry);
    return Array.isArray(data) ? data : [];
  }

  /**
   * 诊断用：原始请求，返回状态码、响应体文本与**响应头**（不做任何解析兜底）。
   * 响应头是诊断的关键：x-oauth-scopes 能证明 Token 权限是否齐全，
   * via 能说明 429 是网关层还是应用层吐的——这两点是本插件踩过的最大的坑。
   */
  async getRaw(
    path: string,
  ): Promise<{ status: number; text: string; headers: Record<string, string> }> {
    await this.throttle();
    let res: UrlResponse;
    try {
      res = await this.send(path);
    } catch (e) {
      return { status: 0, text: `网络异常：${(e as Error).message}`, headers: {} };
    }
    let text = "";
    try {
      text = typeof res.text === "string" ? res.text : JSON.stringify(res.json ?? null);
    } catch {
      text = "<无法读取响应体>";
    }
    return { status: res.status, text, headers: (res.headers ?? {}) as Record<string, string> };
  }

  /** 下载二进制资源（图片/附件） */
  async downloadBinary(url: string): Promise<ArrayBuffer> {
    await this.throttle();
    const res = await requestUrl({ url, method: "GET", throw: false });
    if (res.status >= 400) throw new YuqueApiError(`资源下载失败（${res.status}）：${url}`, res.status);
    return res.arrayBuffer;
  }
}
