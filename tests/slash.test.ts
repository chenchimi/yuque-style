import { describe, expect, it } from "vitest";
import { filterSlashItems, ITEMS } from "../src/slash-items";

const names = (query: string): string[] => filterSlashItems(ITEMS, query).map((i) => i.name);

describe("filterSlashItems", () => {
  it("无输入时不展示代码块（19 个语言项不该挤满首屏）", () => {
    expect(names("")).not.toContain("Python 代码块");
    expect(names("")).not.toContain("JavaScript 代码块");
  });

  it("无输入时通用「代码块」仍在（它是入口）", () => {
    expect(names("")).toContain("代码块");
  });

  it("无输入时展示新增的语雀特色块", () => {
    expect(names("")).toEqual(
      expect.arrayContaining(["折叠块", "目录块", "两栏对比", "信息卡片", "成功卡片", "引用卡片"]),
    );
  });

  it("输入语言关键词后对应代码块出现", () => {
    expect(names("py")).toContain("Python 代码块");
    expect(names("js")).toContain("JavaScript 代码块");
    expect(names("powershell")).toContain("PowerShell 代码块");
  });

  it("输入关键词时也会带上不匹配的项过滤掉", () => {
    expect(names("python")).not.toContain("CSS 代码块");
  });

  it("按中文关键词命中", () => {
    expect(names("kapian")).toContain("卡片块");
    expect(names("分栏")).toContain("两栏对比");
  });

  it("按名称命中", () => {
    expect(names("折叠")).toContain("折叠块");
  });

  it("按提示文字命中", () => {
    expect(names("可展开")).toContain("折叠块");
  });

  it("无匹配时返回空", () => {
    expect(names("zzzz")).toEqual([]);
  });

  it("大小写不敏感", () => {
    expect(names("PY")).toContain("Python 代码块");
  });
});

describe("折叠块的表达方式（探针结论锁定）", () => {
  const fold = ITEMS.find((i) => i.name === "折叠块");

  it("用折叠 callout，不用 <details>", () => {
    expect(fold).toBeDefined();
    expect(fold!.insert.startsWith("> [!")).toBe(true);
    expect(fold!.insert).not.toContain("<details>");
  });

  it("默认展开（+），避免刚插入就对着看不见的内容打字", () => {
    expect(fold!.insert).toContain("]+");
    expect(fold!.insert).not.toContain("]-");
  });

  it("带占位文字，插入后可直接覆盖", () => {
    expect(fold!.selectText).toBeTruthy();
    expect(fold!.insert).toContain(fold!.selectText!);
  });
});

describe("ITEMS 自身的完整性", () => {
  it("每个条目都有名称、关键词与插入内容（或用 resolve 生成）", () => {
    for (const item of ITEMS) {
      expect(item.name.trim()).not.toBe("");
      expect(item.keywords.length).toBeGreaterThan(0);
      expect(item.insert !== "" || typeof item.resolve === "function").toBe(true);
    }
  });

  it("只有代码块被标成 keywordOnly", () => {
    for (const item of ITEMS.filter((i) => i.keywordOnly)) {
      expect(item.name).toContain("代码块");
    }
  });

  it("关键词不重复（否则菜单会出现同名歧义项）", () => {
    const seen = new Set<string>();
    for (const item of ITEMS) {
      expect(seen.has(item.name)).toBe(false);
      seen.add(item.name);
    }
  });
});
