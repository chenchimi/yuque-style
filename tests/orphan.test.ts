import { describe, expect, it } from "vitest";
import { pickOrphans } from "../src/yuque/orphan";

/** pickOrphans 的输入是 "namespace → 该库文档的 stateKey 集合"；这里给个方便构造的助手 */
function keysByNs(map: Record<string, string[]>): Map<string, Set<string>> {
  return new Map(Object.entries(map).map(([ns, keys]) => [ns, new Set(keys)]));
}

describe("pickOrphans（孤儿副本判定：同步记录有、语雀端没有）", () => {
  const state = {
    "u/aaa/live-doc": { path: "语雀/live-doc", title: "还在的" },
    "u/aaa/gone-doc": { path: "语雀/gone-doc", title: "被删的" },
    "u/aaa/untitled": { path: "语雀/untitled" },
    "u/bbb/live-2": { path: "bbb/live-2", title: "另一库还在" },
  };

  it("语雀端不存在的 → 孤儿；仍在的与另一库的都不算", () => {
    const out = pickOrphans(
      state,
      keysByNs({
        "u/aaa": ["u/aaa/live-doc", "u/aaa/untitled"],
        "u/bbb": ["u/bbb/live-2"],
      }),
    );
    // untitled 在语雀端列表里（只是本地记录没存 title），不是孤儿
    expect(out.map((o) => o.key)).toEqual(["u/aaa/gone-doc"]);
  });

  it("title 缺失时回退到路径末段", () => {
    const out = pickOrphans(
      state,
      keysByNs({ "u/aaa": ["u/aaa/live-doc"] }),
    );
    const untitled = out.find((o) => o.key === "u/aaa/untitled");
    expect(untitled?.title).toBe("untitled");
  });

  it("列表拉取失败的库（不在索引里）不下孤儿结论——防误删", () => {
    const out = pickOrphans(state, keysByNs({ "u/aaa": ["u/aaa/live-doc"] }));
    // u/bbb 没取到列表：里面的记录即使语雀端没了也不报孤儿
    expect(out.some((o) => o.key === "u/bbb/live-2")).toBe(false);
  });

  it("整个索引为空（全部库拉取失败）→ 一个孤儿都不报", () => {
    expect(pickOrphans(state, new Map())).toEqual([]);
  });

  it("没有 path 的脏记录直接跳过", () => {
    const out = pickOrphans(
      { "u/aaa/broken": { title: "没有 path" }, ...state },
      keysByNs({ "u/aaa": ["u/aaa/live-doc"] }),
    );
    expect(out.some((o) => o.key === "u/aaa/broken")).toBe(false);
  });

  it("空同步记录 → 空结果", () => {
    expect(pickOrphans({}, keysByNs({ "u/aaa": ["u/aaa/x"] }))).toEqual([]);
  });
});
