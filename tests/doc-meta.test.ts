import { describe, expect, it } from "vitest";
import {
  countWords,
  formatDate,
  formatRelativeTime,
  formatWordCount,
  parseYuqueDate,
  readingMinutes,
  syncBadge,
} from "../src/doc-meta";

const NOW = new Date(2026, 8, 22, 12, 0, 0).getTime(); // 2026-09-22 12:00（本地时区）
const ago = (ms: number): number => NOW - ms;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("countWords", () => {
  it("中文按非空白字符计数", () => {
    expect(countWords("你好世界")).toBe(4);
  });

  it("空白不计入", () => {
    expect(countWords("你好 世界\n第二行")).toBe(7);
  });

  it("Markdown 记号被当作分隔符，不计入字数", () => {
    expect(countWords("# 标题\n\n**粗体** 与 `代码`")).toBe("标题粗体与代码".length);
  });

  it("围栏代码块整段忽略", () => {
    expect(countWords("正文\n```js\nconst a = 1;\n```\n")).toBe(2);
  });
});

describe("formatWordCount / readingMinutes", () => {
  it("过万换成万字，免得一长串数字挤在元信息行", () => {
    expect(formatWordCount(999)).toBe("999 字");
    expect(formatWordCount(12345)).toBe("1.2 万字");
  });

  it("阅读时长按每分钟 400 字，最少 1 分钟", () => {
    expect(readingMinutes(0)).toBe(1);
    expect(readingMinutes(400)).toBe(1);
    expect(readingMinutes(800)).toBe(2);
  });
});

describe("formatRelativeTime", () => {
  it("一周以内用相对说法", () => {
    expect(formatRelativeTime(ago(30_000), NOW)).toBe("刚刚");
    expect(formatRelativeTime(ago(5 * MINUTE), NOW)).toBe("5 分钟前");
    expect(formatRelativeTime(ago(3 * HOUR), NOW)).toBe("3 小时前");
    expect(formatRelativeTime(ago(3 * DAY), NOW)).toBe("3 天前");
  });

  it("更久直接给日期——「37 天前」既算不出准确日期也没有信息量", () => {
    expect(formatRelativeTime(new Date(2026, 7, 1).getTime(), NOW)).toBe("2026-08-01");
  });

  it("时钟回拨（时间在未来）不显示负数", () => {
    expect(formatRelativeTime(NOW + 5 * MINUTE, NOW)).toBe("刚刚");
  });

  it("非法时间返回空串，不显示「NaN」", () => {
    expect(formatRelativeTime(Number.NaN, NOW)).toBe("");
  });
});

describe("formatDate / parseYuqueDate", () => {
  it("本地日期补零", () => {
    expect(formatDate(new Date(2026, 0, 5).getTime())).toBe("2026-01-05");
  });

  it("语雀 ISO 时间可解析", () => {
    expect(parseYuqueDate("2023-05-01T00:00:00.000Z")?.getTime()).toBe(
      new Date("2023-05-01T00:00:00.000Z").getTime(),
    );
  });

  it("空值 / 乱码一律 null（宁可不显示，也不显示错的）", () => {
    expect(parseYuqueDate("")).toBeNull();
    expect(parseYuqueDate("   ")).toBeNull();
    expect(parseYuqueDate("昨天")).toBeNull();
    expect(parseYuqueDate(123)).toBeNull();
    expect(parseYuqueDate(undefined)).toBeNull();
  });
});

describe("syncBadge", () => {
  it("有语雀来源 → 算已同步，并带上语雀侧更新时间", () => {
    const badge = syncBadge("https://www.yuque.com/ns/doc/slug", "2026-09-20T07:47:45.000Z");
    expect(badge.kind).toBe("yuque");
    expect(badge.text).toContain("语雀");
    expect(badge.text).toContain("2026-09-20");
    expect(badge.url).toBe("https://www.yuque.com/ns/doc/slug");
  });

  it("有来源但时间缺失 → 只说已同步，不编时间", () => {
    const badge = syncBadge("https://www.yuque.com/a/b/c", undefined);
    expect(badge).toEqual({ kind: "yuque", text: "语雀已同步", url: "https://www.yuque.com/a/b/c" });
  });

  it("本地新增的文档没有来源 → 标为未同步", () => {
    expect(syncBadge(undefined, undefined)).toEqual({
      kind: "local",
      text: "本地文档 · 未同步",
      url: null,
    });
    // 来源不是链接（用户自己写的字符串）时同样按本地处理
    expect(syncBadge("手写的来源", undefined).kind).toBe("local");
  });
});
