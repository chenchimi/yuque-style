import { describe, expect, it } from "vitest";
import {
  loadSettingsWithMigration,
  OBSOLETE_SETTING_KEYS,
  summarizeTaskNames,
} from "../src/settings";

const DEFAULTS = {
  topBar: true,
  slashMenu: true,
  reader: true,
  contentWidth: 820,
  yuqueToken: "",
  yuqueTasks: [],
  yuqueSyncState: {},
};

describe("loadSettingsWithMigration", () => {
  it("空配置 → 全默认，并把补上的键报出来", () => {
    const r = loadSettingsWithMigration(null, DEFAULTS);
    expect(r.settings).toEqual(DEFAULTS);
    expect(r.added.sort()).toEqual(Object.keys(DEFAULTS).sort());
    expect(r.removed).toEqual([]);
  });

  it("用户改过的值一律保留", () => {
    const r = loadSettingsWithMigration({ contentWidth: 1200, yuqueToken: "abc" }, DEFAULTS);
    expect(r.settings.contentWidth).toBe(1200);
    expect(r.settings.yuqueToken).toBe("abc");
  });

  it("缺失的新开关补默认值（老用户升级后行为确定）", () => {
    const r = loadSettingsWithMigration({ contentWidth: 900 }, DEFAULTS);
    expect(r.settings.topBar).toBe(true);
    expect(r.added).toContain("topBar");
  });

  it("废除的开关被真正删掉，不会被写回 data.json", () => {
    const r = loadSettingsWithMigration(
      { contentWidth: 900, toolbar: false, showReadingTime: false, topBarMeta: true },
      DEFAULTS,
    );
    expect(r.removed.sort()).toEqual(["showReadingTime", "toolbar", "topBarMeta"].sort());
    expect("toolbar" in r.settings).toBe(false);
    expect("showReadingTime" in r.settings).toBe(false);
  });

  it("更早版本遗留的键一并清掉（它们已躺在用户配置里很久）", () => {
    const r = loadSettingsWithMigration(
      { yuqueDocProperties: true, showOutline: false, 随手写的键: 1 },
      DEFAULTS,
    );
    expect(r.removed).toContain("yuqueDocProperties");
    expect(r.removed).toContain("showOutline");
    expect(r.removed).toContain("随手写的键");
    expect(r.settings).toEqual(DEFAULTS);
  });

  it("废弃键清单里的每一项都不在默认配置中（否则会把自己的开关删掉）", () => {
    for (const key of OBSOLETE_SETTING_KEYS) {
      expect(key in DEFAULTS).toBe(false);
    }
  });

  it("null / undefined 的字段回退默认值，而不是把默认值抹成 null", () => {
    const r = loadSettingsWithMigration({ contentWidth: null, yuqueToken: undefined }, DEFAULTS);
    expect(r.settings.contentWidth).toBe(820);
    expect(r.settings.yuqueToken).toBe("");
  });

  it("不修改传入的对象（纯函数，便于重复调用）", () => {
    const loaded = { contentWidth: 900, toolbar: true };
    loadSettingsWithMigration(loaded, DEFAULTS);
    expect(loaded).toEqual({ contentWidth: 900, toolbar: true });
  });

  it("数组等非法配置整体当空配置处理，不会炸", () => {
    expect(loadSettingsWithMigration([1, 2], DEFAULTS).settings).toEqual(DEFAULTS);
    expect(loadSettingsWithMigration("x", DEFAULTS).settings).toEqual(DEFAULTS);
  });
});

describe("summarizeTaskNames", () => {
  it("任务少时原样列出", () => {
    expect(summarizeTaskNames(["公务员", "AI"])).toBe("公务员、AI");
  });

  it("任务多时只列前几个，免得设置页被撑长", () => {
    const names = ["A", "B", "C", "D", "E"];
    expect(summarizeTaskNames(names)).toBe("A、B、C 等 5 个知识库");
  });

  it("空名与空列表都有兜底文案", () => {
    expect(summarizeTaskNames([])).toBe("还没有任务");
    expect(summarizeTaskNames(["", ""])).toBe("还没有任务");
  });
});
