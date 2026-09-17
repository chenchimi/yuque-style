import { describe, expect, it } from "vitest";
import { resolveTargetFolders } from "../src/yuque/sync";

describe("resolveTargetFolders", () => {
  it("根文件夹留空 → 直接用库名（与旧行为一致，不产生迁移）", () => {
    const out = resolveTargetFolders([{ namespace: "u/aaa", name: "AI" }], "");
    expect(out[0].folder).toBe("AI");
  });

  it("给定根文件夹 → 根 / 库名", () => {
    expect(resolveTargetFolders([{ namespace: "u/aaa", name: "AI" }], "语雀")[0].folder).toBe(
      "语雀/AI",
    );
  });

  it("根目录首尾多余的斜杠会被清掉", () => {
    expect(resolveTargetFolders([{ namespace: "u/aaa", name: "AI" }], "/语雀/")[0].folder).toBe(
      "语雀/AI",
    );
  });

  it("同名库撞车 → 后者补 namespace 短后缀，两个任务不会落到同一目录", () => {
    const out = resolveTargetFolders(
      [
        { namespace: "u/aaa", name: "未命名" },
        { namespace: "u/bbb", name: "未命名" },
      ],
      "",
    );
    expect(out[0].folder).toBe("未命名");
    expect(out[1].folder).toBe("未命名 (bbb)");
  });

  it("sanitize 后撞车也算撞车（A/B 与 A B 同名）", () => {
    const out = resolveTargetFolders(
      [
        { namespace: "u/aaa", name: "A/B" },
        { namespace: "u/ccc", name: "A B" },
      ],
      "",
    );
    expect(out[0].folder).toBe("A B");
    expect(out[1].folder).toBe("A B (ccc)");
  });

  it("库名含非法字符 → 清洗后再用", () => {
    expect(resolveTargetFolders([{ namespace: "u/aaa", name: "A/B:测试" }], "")[0].folder).toBe(
      "A B 测试",
    );
  });

  it("输出顺序与入参一致（勾选顺序即同步顺序）", () => {
    const out = resolveTargetFolders(
      [
        { namespace: "u/b", name: "B" },
        { namespace: "u/a", name: "A" },
      ],
      "",
    );
    expect(out.map((o) => o.folder)).toEqual(["B", "A"]);
  });

  it("空列表返回空", () => {
    expect(resolveTargetFolders([], "语雀")).toEqual([]);
  });
});
