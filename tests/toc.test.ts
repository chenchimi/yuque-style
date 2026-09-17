import { describe, expect, it } from "vitest";
import { buildTocBlock } from "../src/toc";

describe("buildTocBlock", () => {
  it("按层级生成同文件双链列表", () => {
    expect(
      buildTocBlock([
        { level: 1, heading: "第一章" },
        { level: 2, heading: "小节" },
      ]),
    ).toBe("- [[#第一章]]\n  - [[#小节]]");
  });

  it("文档从 h2 起笔时整体不缩进（以最浅标题为顶级）", () => {
    expect(
      buildTocBlock([
        { level: 2, heading: "一" },
        { level: 3, heading: "二" },
      ]),
    ).toBe("- [[#一]]\n  - [[#二]]");
  });

  it("跳级时按实际层级差缩进", () => {
    expect(
      buildTocBlock([
        { level: 1, heading: "一" },
        { level: 3, heading: "三" },
      ]),
    ).toBe("- [[#一]]\n    - [[#三]]");
  });

  it("没有标题 → 空串（调用方据此提示用户）", () => {
    expect(buildTocBlock([])).toBe("");
  });

  it("标题全是空白 → 空串", () => {
    expect(buildTocBlock([{ level: 1, heading: "   " }])).toBe("");
  });

  it("标题首尾空白会被去掉", () => {
    expect(buildTocBlock([{ level: 1, heading: "  带空格  " }])).toBe("- [[#带空格]]");
  });
});
