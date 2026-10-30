import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isQuotaExhausted,
  pickHeader,
  YuqueApi,
  YuqueApiError,
  YuqueQuotaError,
} from "../src/yuque/api";
import {
  resetRequestUrlHandler,
  setRequestUrlHandler,
} from "./mocks/obsidian";

/** requestUrl 假响应的最小形状（api.ts 的 send 只读这几个字段） */
function res(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return {
    status,
    json: body,
    text: JSON.stringify(body),
    headers,
    arrayBuffer: new ArrayBuffer(0),
  };
}

/** 记录每次请求的时间戳与 URL，便于断言节流与路径 */
function spy(handler: (path: string) => { status: number; json?: unknown; headers?: Record<string, string> }) {
  const calls: { path: string; at: number }[] = [];
  setRequestUrlHandler((opts) => {
    const url = String((opts as { url: string }).url);
    const path = url.replace("https://www.yuque.com/api/v2", "");
    calls.push({ path, at: Date.now() });
    const r = handler(path);
    return res(r.status, r.json, r.headers);
  });
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  resetRequestUrlHandler();
  vi.useRealTimers();
});

describe("pickHeader（响应头大小写不敏感）", () => {
  it("命中不同大小写；缺失返回 undefined；null 值当缺失", () => {
    expect(pickHeader({ "X-RateLimit-Remaining": "12" }, "x-ratelimit-remaining")).toBe("12");
    expect(pickHeader({ via: "edge[429]" }, "VIA")).toBe("edge[429]");
    expect(pickHeader({ a: null }, "a")).toBeUndefined();
    expect(pickHeader(undefined, "a")).toBeUndefined();
  });
});

describe("requestJson · 正常路径", () => {
  it("返回响应体的 data 字段", async () => {
    spy(() => ({ status: 200, json: { data: { login: "me", name: "我" } } }));
    const api = new YuqueApi("t");
    await expect(api.getUser()).resolves.toEqual({ login: "me", name: "我" });
  });

  it("getUser 类型化但不做字段校验（接口宽松）", async () => {
    spy(() => ({ status: 200, json: { data: {} } }));
    const api = new YuqueApi("t");
    const user = await api.getUser();
    expect(user).toEqual({});
  });

  it("观测回调拿到路径/状态/响应头线索", async () => {
    spy(() => ({
      status: 200,
      json: { data: null },
      headers: { Via: "edge[200]", "x-oauth-scopes": "doc,repo" },
    }));
    const seen: unknown[] = [];
    const api = new YuqueApi("t", (info) => seen.push(info));
    await api.getUser();
    expect(seen).toHaveLength(1);
    const info = seen[0] as { path: string; status: number; via?: string; scopes?: string };
    expect(info.path).toBe("/user");
    expect(info.status).toBe(200);
    expect(info.via).toBe("edge[200]");
    expect(info.scopes).toBe("doc,repo");
  });

  it("requestCount 只数开放 API 请求", async () => {
    spy(() => ({ status: 200, json: { data: [] } }));
    const api = new YuqueApi("t");
    await api.getTocOnce("u/book");
    expect(api.requestCount).toBe(1);
  });
});

describe("requestJson · 错误路径", () => {
  it("401 → 明确指向重新生成 Token", async () => {
    spy(() => ({ status: 401 }));
    const api = new YuqueApi("t");
    await expect(api.getUser()).rejects.toThrow(/Token 无效/);
  });

  it("404 → 提示接口不存在", async () => {
    spy(() => ({ status: 404 }));
    const api = new YuqueApi("t");
    await expect(api.getUser()).rejects.toThrow(/404/);
  });

  it("500 → 透出语雀返回的 message", async () => {
    spy(() => ({ status: 500, json: { message: "internal" } }));
    const api = new YuqueApi("t");
    await expect(api.getUser()).rejects.toThrow(/internal/);
  });

  it("网络层异常 → status 0 的 YuqueApiError，不是配额", async () => {
    setRequestUrlHandler(() => {
      throw new Error("net down");
    });
    const api = new YuqueApi("t");
    const err = await api.getUser().catch((e) => e);
    expect(err).toBeInstanceOf(YuqueApiError);
    expect(err.status).toBe(0);
    expect(isQuotaExhausted(err)).toBe(false);
  });
});

describe("429 · 短探测与熔断（v0.9.1 行为）", () => {
  it("持续 429：探测一次后即抛 YuqueQuotaError（只发 2 次请求，不再 50s 长退避）", async () => {
    const calls = spy(() => ({ status: 429 }));
    const api = new YuqueApi("t");
    // 先挂上 catch 再推进时钟：rejection 发生在 advanceTimersByTimeAsync 期间，
    // 后挂 catch 会被 Vitest 记成 unhandled rejection
    const p = api.getUser().catch((e) => e);
    // 探测等待是 2 秒的 sleep，快进它
    await vi.advanceTimersByTimeAsync(2100);
    const err = await p;
    expect(isQuotaExhausted(err)).toBe(true);
    expect(err).toBeInstanceOf(YuqueQuotaError);
    expect(calls).toHaveLength(2);
  });

  it("突发限流：2 秒探测后自愈，第二次成功", async () => {
    let n = 0;
    spy(() => {
      n++;
      return n === 1 ? { status: 429 } : { status: 200, json: { data: { ok: 1 } } };
    });
    const api = new YuqueApi("t");
    const p = api.getUser();
    await vi.advanceTimersByTimeAsync(2100);
    await expect(p).resolves.toEqual({ ok: 1 });
    expect(n).toBe(2);
  });

  it("熔断错误携带 429 与最近一次观测信息", async () => {
    spy(() => ({
      status: 429,
      headers: { "x-oauth-scopes": "doc", via: "edge[429]" },
    }));
    const api = new YuqueApi("t");
    const p = api.getUser().catch((e) => e) as Promise<YuqueQuotaError>;
    await vi.advanceTimersByTimeAsync(2100);
    const err = await p;
    expect(err.status).toBe(429);
    expect(err.rate?.scopes).toBe("doc");
    expect(err.rate?.via).toBe("edge[429]");
  });
});

describe("节流（请求间隔 ≥ 400ms）", () => {
  it("连续两次请求被拉开到 ≥400ms", async () => {
    const calls = spy(() => ({ status: 200, json: { data: [] } }));
    const api = new YuqueApi("t");
    const p1 = api.getTocOnce("u/book");
    const p2 = api.getTocOnce("u/book");
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([p1, p2]);
    expect(calls).toHaveLength(2);
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(395);
  });
});

describe("remainingFromHeader（预算依据）", () => {
  it("读到数字头 → 返回数值；读不到 → null", async () => {
    let headers: Record<string, string> = { "x-ratelimit-remaining": "123" };
    spy(() => ({ status: 200, json: { data: null }, headers }));
    const api = new YuqueApi("t");
    await api.getUser();
    expect(api.remainingFromHeader).toBe(123);
    headers = {};
    // 第二次请求会被 400ms 节流拦住，假定时器下必须推进
    const p = api.getUser();
    await vi.advanceTimersByTimeAsync(500);
    await p;
    expect(api.remainingFromHeader).toBeNull();
  });
});

describe("getRaw（诊断用原始响应）", () => {
  it("返回状态码、响应体文本与响应头", async () => {
    spy(() => ({ status: 200, json: { data: { a: 1 } }, headers: { via: "edge" } }));
    const api = new YuqueApi("t");
    const r = await api.getRaw("/user");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ data: { a: 1 } });
    expect(r.headers.via).toBe("edge");
  });

  it("网络异常 → status 0 与可读文案，不抛出", async () => {
    setRequestUrlHandler(() => {
      throw new Error("offline");
    });
    const api = new YuqueApi("t");
    const r = await api.getRaw("/user");
    expect(r.status).toBe(0);
    expect(r.text).toContain("offline");
  });
});

describe("翻页（getRepos / getDocListOnce）", () => {
  it("满页 100 条继续翻，不足 100 条停止", async () => {
    const paths: string[] = [];
    setRequestUrlHandler((opts) => {
      const url = String((opts as { url: string }).url);
      paths.push(url);
      // 注意先判 /users/：/users/me/repos 也包含 /user 子串
      if (url.includes("/users/")) {
        return url.includes("offset=0")
          ? res(200, { data: Array(100).fill({ id: 1 }) }) // 满页 → 继续翻
          : res(200, { data: [{ id: 2 }] }); // 不足 100 → 停止
      }
      if (url.includes("/user")) return res(200, { data: { login: "me" } });
      if (url.includes("offset=0")) return res(200, { data: Array(100).fill({ id: 1 }) });
      return res(200, { data: [{ id: 2 }] });
    });
    const api = new YuqueApi("t");
    // 翻页请求被 400ms 节流隔开，假定时器下边推进边等
    const p = api.getRepos();
    await vi.advanceTimersByTimeAsync(2000);
    const repos = await p;
    expect(repos).toHaveLength(101);
    expect(paths.filter((p) => p.includes("offset=0")).length).toBe(1);
    expect(paths.filter((p) => p.includes("offset=100")).length).toBe(1);
  });
});
