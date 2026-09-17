import { requestUrl } from "obsidian";

const BASE = "https://www.yuque.com/api/v2";

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
 * 语雀开放 API v2 客户端。
 * - 认证：X-Auth-Token
 * - 节流：请求间隔 >= 400ms（语雀限流约 5000 次/小时，保守起见）
 * - 429 自动退避重试
 */
export class YuqueApi {
  private lastReqAt = 0;

  constructor(private token: string) {}

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
   * requestUrl 对非 2xx 默认直接抛异常（"Request failed, status xxx"），
   * 必须设置 throw: false 才能拿到响应自行判断状态码。
   */
  private async rawRequest(path: string): Promise<{ status: number; json: any }> {
    return await requestUrl({
      url: BASE + path,
      method: "GET",
      headers: {
        "X-Auth-Token": this.token,
        "User-Agent": "obsidian-yuque-style",
      },
      throw: false,
    });
  }

  private async requestJson(
    path: string,
    onRetry?: (waitSec: number, attempt: number) => void,
  ): Promise<any> {
    const maxAttempts = 4;
    const backoffMs = [5000, 15000, 30000];
    for (let attempt = 1; ; attempt++) {
      await this.throttle();
      let res: { status: number; json: any };
      try {
        res = await this.rawRequest(path);
      } catch (e) {
        // 网络层异常（DNS、断网等）
        throw new YuqueApiError(`请求异常（${path}）：${(e as Error).message}`, 0);
      }
      if (res.status === 429) {
        if (attempt >= maxAttempts) {
          throw new YuqueApiError(
            `语雀 API 限流（429，${path}）：已自动重试 ${maxAttempts - 1} 次仍失败。` +
              `语雀对 API 调用有小时级配额（免费账户较低），请等待 10-60 分钟后再同步`,
            429,
          );
        }
        const wait = backoffMs[attempt - 1] ?? 30000;
        onRetry?.(Math.round(wait / 1000), attempt);
        await sleep(wait);
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
        let msg = `HTTP ${res.status}`;
        try {
          msg = res.json?.message ?? msg;
        } catch {
          /* ignore */
        }
        throw new YuqueApiError(`语雀 API 请求失败（${path}）：${msg}`, res.status);
      }
      return res.json?.data;
    }
  }

  /** 当前用户信息（用于验证 Token） */
  async getUser(): Promise<any> {
    return this.requestJson("/user");
  }

  /** 我的知识库列表（自动翻页）。语雀 v2 无 /repos 端点，须用 /users/:login/repos */
  async getRepos(): Promise<YuqueRepo[]> {
    const user = await this.getUser();
    const login = user?.login || user?.id;
    if (!login) throw new YuqueApiError("无法获取当前用户信息（Token 无效？）", 401);
    const out: YuqueRepo[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.requestJson(
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
      const page = await this.requestJson(
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
    const data = await this.requestJson(`/repos/${nsPath(namespace)}/toc`);
    return Array.isArray(data) ? data : [];
  }

  /** 文档详情（body 为 Lake 格式） */
  async getDoc(namespace: string, slug: string): Promise<YuqueDocDetail> {
    return this.requestJson(
      `/repos/${nsPath(namespace)}/docs/${encodeURIComponent(slug)}`,
    );
  }

  /** 知识库目录树 */
  async getToc(namespace: string, onRetry?: (waitSec: number, attempt: number) => void): Promise<YuqueTocNode[]> {
    const data = await this.requestJson(`/repos/${nsPath(namespace)}/toc`, onRetry);
    return Array.isArray(data) ? data : [];
  }

  /** 诊断用：原始请求，返回状态码与响应体文本（不做任何解析兜底） */
  async getRaw(path: string): Promise<{ status: number; text: string }> {
    await this.throttle();
    let res: any;
    try {
      res = await requestUrl({
        url: BASE + path,
        method: "GET",
        headers: {
          "X-Auth-Token": this.token,
          "User-Agent": "obsidian-yuque-style",
        },
        throw: false,
      });
    } catch (e) {
      return { status: 0, text: `网络异常：${(e as Error).message}` };
    }
    let text = "";
    try {
      text = typeof res.text === "string" ? res.text : JSON.stringify(res.json ?? null);
    } catch {
      text = "<无法读取响应体>";
    }
    return { status: res.status, text };
  }

  /** 下载二进制资源（图片/附件） */
  async downloadBinary(url: string): Promise<ArrayBuffer> {
    await this.throttle();
    const res = await requestUrl({ url, method: "GET", throw: false });
    if (res.status >= 400) throw new YuqueApiError(`资源下载失败（${res.status}）：${url}`, res.status);
    return res.arrayBuffer;
  }
}
