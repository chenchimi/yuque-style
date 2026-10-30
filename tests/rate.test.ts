import { describe, expect, it } from "vitest";
import type { YuqueRateInfo } from "../src/yuque/api";
import {
  budgetSourceLabel,
  decideBudget,
  describeRateLog,
  emptyRateLog,
  headerDump,
  hourKeyOf,
  migrateRateLog,
  parseRateNumber,
  RATE_LOG_CAPACITY,
  recordResponse,
  suggestBudget,
} from "../src/yuque/rate";

/** 本地时间构造：观测门槛按用户作息对齐，测试也必须用本地时间而不是 UTC */
const at = (hour: number, minute = 0, day = 23): number =>
  new Date(2026, 8, day, hour, minute).getTime();

const info = (over: Partial<YuqueRateInfo> = {}): YuqueRateInfo => ({
  path: "/user",
  status: 200,
  at: at(10),
  ...over,
});

describe("rate · 小时键与取数", () => {
  it("小时键按本地时间，形如 YYYY-MM-DDTHH", () => {
    expect(hourKeyOf(at(10, 5))).toBe("2026-09-23T10");
    expect(hourKeyOf(at(0, 0))).toBe("2026-09-23T00");
    expect(hourKeyOf(at(23, 59))).toBe("2026-09-23T23");
  });

  it("从响应头取值里抠数字：容忍引号与附加参数", () => {
    expect(parseRateNumber("5000")).toBe(5000);
    expect(parseRateNumber('"5000"')).toBe(5000);
    expect(parseRateNumber("5000;w=3600")).toBe(5000);
    expect(parseRateNumber("0")).toBe(0);
  });

  it("取不到数字一律返回 null——不许猜", () => {
    expect(parseRateNumber(undefined)).toBe(null);
    expect(parseRateNumber("")).toBe(null);
    expect(parseRateNumber("unknown")).toBe(null);
  });
});

describe("rate · 记账", () => {
  it("每次响应都计入本小时请求数", () => {
    const log = emptyRateLog();
    recordResponse(log, info());
    recordResponse(log, info({ status: 404 }));
    expect(log.used).toBe(2);
    expect(log.hourKey).toBe("2026-09-23T10");
  });

  it("跨过小时边界：请求计数归零，观测门槛保留", () => {
    const log = emptyRateLog();
    for (let i = 0; i < 3; i++) recordResponse(log, info());
    recordResponse(log, info({ status: 429, at: at(10, 30) }));
    expect(log.minCeiling).toBe(4);

    recordResponse(log, info({ at: at(11, 1) }));
    expect(log.hourKey).toBe("2026-09-23T11");
    expect(log.used).toBe(1);
    // 观测门槛是跨小时的历史事实，不能跟着归零
    expect(log.minCeiling).toBe(4);
  });

  it("429 写明细并刷新观测门槛；门槛取历次最小值", () => {
    const log = emptyRateLog();
    recordResponse(log, info({ status: 429, via: "hz-x[429]" }));
    expect(log.events).toHaveLength(1);
    expect(log.events[0].used).toBe(1);
    expect(log.events[0].via).toBe("hz-x[429]");
    expect(log.events[0].hadRateHeaders).toBe(false);
    expect(log.minCeiling).toBe(1);

    // 第二次撞墙来得更晚，门槛不应被抬高（下限才有意义）
    for (let i = 0; i < 50; i++) recordResponse(log, info());
    recordResponse(log, info({ status: 429 }));
    expect(log.minCeiling).toBe(1);
    expect(log.events).toHaveLength(2);
  });

  it("带 X-RateLimit-* 的 429 会被标记（那是应用层限流器）", () => {
    const log = emptyRateLog();
    recordResponse(log, info({ status: 429, limit: "5000", remaining: "0" }));
    expect(log.events[0].hadRateHeaders).toBe(true);
  });

  it("非 429 才记录「最近读到的剩余额度」", () => {
    const log = emptyRateLog();
    recordResponse(log, info({ status: 429, remaining: "0" }));
    expect(log.headerRemaining).toBe(null);

    recordResponse(log, info({ remaining: "4321" }));
    expect(log.headerRemaining).toBe(4321);
    expect(log.headerObservedAt).not.toBe("");
  });

  it("记录「最后一次未被网关拦截的请求」，网络层失败（status 0）不算", () => {
    const log = emptyRateLog();
    recordResponse(log, info({ status: 200, at: at(10, 5) }));
    expect(log.lastAcceptedAt).not.toBe("");
    const accepted = log.lastAcceptedAt;

    // 网络层失败说明不了「网关放行了」，不能刷新这个时刻
    recordResponse(log, info({ status: 0, at: at(10, 6) }));
    expect(log.lastAcceptedAt).toBe(accepted);

    // 404 / 401 都证明请求被网关放行了，同样应刷新
    recordResponse(log, info({ status: 404, at: at(10, 7) }));
    expect(log.lastAcceptedAt).not.toBe(accepted);

    // 429 是惩罚态本身，不能拿它当「放行」
    const before429 = log.lastAcceptedAt;
    recordResponse(log, info({ status: 429, at: at(10, 8) }));
    expect(log.lastAcceptedAt).toBe(before429);
  });

  it("明细有上限：只留最近 RATE_LOG_CAPACITY 条", () => {
    const log = emptyRateLog();
    for (let i = 0; i < RATE_LOG_CAPACITY + 10; i++) {
      recordResponse(log, info({ status: 429, path: `/p${i}` }));
    }
    expect(log.events).toHaveLength(RATE_LOG_CAPACITY);
    expect(log.events[log.events.length - 1].path).toBe(`/p${RATE_LOG_CAPACITY + 9}`);
  });
});

describe("rate · 建议预算", () => {
  it("没有观测门槛就不给数字（不许拿官方 5000 当尺子）", () => {
    expect(suggestBudget(emptyRateLog())).toBe(null);
  });

  it("有门槛则取 80%，向下取整", () => {
    const log = emptyRateLog();
    for (let i = 0; i < 999; i++) recordResponse(log, info());
    recordResponse(log, info({ status: 429 }));
    expect(log.minCeiling).toBe(1000);
    expect(suggestBudget(log)).toBe(800);
  });
});

describe("rate · 预算判定", () => {
  it("什么都没设 → 不限", () => {
    const d = decideBudget({ setting: 0, usedThisRun: 0, headerRemaining: null });
    expect(d).toEqual({ allowance: null, source: "none" });
    expect(budgetSourceLabel(d.source)).toContain("未设上限");
  });

  it("只设了设置项 → 上限减去本次已用", () => {
    const d = decideBudget({ setting: 100, usedThisRun: 30, headerRemaining: null });
    expect(d.allowance).toBe(70);
    expect(d.source).toBe("setting");
  });

  it("只读到头 → 用剩余额度", () => {
    const d = decideBudget({ setting: 0, usedThisRun: 5, headerRemaining: 42 });
    expect(d.allowance).toBe(42);
    expect(d.source).toBe("header");
  });

  it("两者都有 → 取更严的那个", () => {
    // 头说还剩 5000，但用户自己限了 100 且已用 30 → 以用户设置（70）为准
    expect(decideBudget({ setting: 100, usedThisRun: 30, headerRemaining: 5000 })).toEqual({
      allowance: 70,
      source: "setting",
    });
    // 头说只剩 10，用户限了 100 → 以头为准，绝不越过服务端边界
    expect(decideBudget({ setting: 100, usedThisRun: 0, headerRemaining: 10 })).toEqual({
      allowance: 10,
      source: "header",
    });
  });

  it("已超出预算时归零而不是负数", () => {
    const d = decideBudget({ setting: 10, usedThisRun: 25, headerRemaining: null });
    expect(d.allowance).toBe(0);
  });
});

describe("rate · 迁移与展示", () => {
  it("脏数据一律回默认，不让插件起不来", () => {
    expect(migrateRateLog(null).used).toBe(0);
    expect(migrateRateLog("x").events).toEqual([]);
    const log = migrateRateLog({
      hourKey: 7,
      used: "many",
      minCeiling: "10",
      events: [{ at: 1 }, "junk", { at: "bad" }],
    });
    expect(log.hourKey).toBe("");
    expect(log.used).toBe(0);
    expect(log.minCeiling).toBe(null);
    // 只有形如 { at: number } 的项才留下
    expect(log.events).toHaveLength(1);
  });

  it("保留合法字段", () => {
    const log = migrateRateLog({
      hourKey: "2026-09-23T10",
      used: 12,
      minCeiling: 300,
      minCeilingAt: "2026-09-23T10:00:00.000Z",
      headerRemaining: 0,
      events: [{ at: 5, hourKey: "k", used: 3, path: "/p", hadRateHeaders: false }],
    });
    expect(log.used).toBe(12);
    expect(log.minCeiling).toBe(300);
    expect(log.headerRemaining).toBe(0);
    expect(log.events).toHaveLength(1);
  });

  it("完整响应头排序后可打印", () => {
    expect(headerDump({ Via: "x", "content-type": "json" })).toEqual([
      "content-type: json",
      "Via: x",
    ]);
    expect(headerDump(undefined)).toEqual([]);
  });

  it("观测摘要说清「没有门槛」与「有门槛」两种状态", () => {
    const none = describeRateLog(emptyRateLog(), at(10)).join("\n");
    expect(none).toContain("尚无观测门槛");
    expect(none).toContain("从未在响应头里读到 X-RateLimit-Remaining");

    const log = emptyRateLog();
    recordResponse(log, info({ status: 429, via: "hz-x[429]" }));
    const text = describeRateLog(log, at(10)).join("\n");
    expect(text).toContain("观测门槛");
    expect(text).toContain("hz-x[429]");
    expect(text).toContain("无配额头");
  });

  it("摘要给出惩罚持续时长，并把起点夹在「最后一次放行」与「首次 429」之间", () => {
    const log = emptyRateLog();
    recordResponse(log, info({ status: 200, at: at(10, 0) }));
    recordResponse(log, info({ status: 429, via: "hz-x[429]", at: at(10, 30) }));

    const text = describeRateLog(log, at(13, 30)).join("\n");
    expect(text).toContain("最后一次未被网关拦截的请求");
    expect(text).toContain("最近一次 429 距今 3 小时");
    expect(text).toContain("起点在");
  });
});
