import { describe, expect, it } from "vitest";
import {
  applyRename,
  decideWrite,
  docUrl,
  hashContent,
  migrateSyncState,
  pickRelocateSource,
  stateKey,
} from "../src/yuque/state";
import type { YuqueSyncState } from "../src/yuque/state";

const FULL = {
  updatedAt: "2026-02-02T00:00:00Z",
  path: "yuque/设计文档",
  url: "https://www.yuque.com/a/b",
  title: "设计文档",
  hash: "abc-def",
};

describe("stateKey", () => {
  it("拼接 namespace 与 slug", () => {
    expect(stateKey("myrepo", "abc123")).toBe("myrepo/abc123");
  });
});

describe("docUrl", () => {
  it("生成语雀文档地址", () => {
    expect(docUrl("myrepo", "abc123")).toBe("https://www.yuque.com/myrepo/abc123");
  });
});

describe("migrateSyncState", () => {
  it("空值与非对象返回空表", () => {
    expect(migrateSyncState(undefined)).toEqual({});
    expect(migrateSyncState(null)).toEqual({});
    expect(migrateSyncState("x")).toEqual({});
    expect(migrateSyncState([])).toEqual({});
  });

  it("旧格式（value 为 updated_at 字符串）升级为结构化记录", () => {
    const out = migrateSyncState({ "myrepo/abc": "2026-01-01T00:00:00Z" });
    expect(out).toEqual({
      "myrepo/abc": {
        updatedAt: "2026-01-01T00:00:00Z",
        path: "",
        url: "",
        title: "",
        hash: "",
      },
    });
  });

  it("保留旧记录的 updated_at，不触发全量重拉", () => {
    const out = migrateSyncState({ "a/b": "2026-05-05T10:00:00Z" });
    expect(out["a/b"].updatedAt).toBe("2026-05-05T10:00:00Z");
  });

  it("新格式原样保留（含 hash）", () => {
    expect(migrateSyncState({ "a/b": { ...FULL } })).toEqual({ "a/b": FULL });
  });

  it("新旧格式混合时分别处理", () => {
    const out = migrateSyncState({
      "a/old": "2026-01-01T00:00:00Z",
      "a/new": { ...FULL },
    });
    expect(out["a/old"]).toEqual({
      updatedAt: "2026-01-01T00:00:00Z",
      path: "",
      url: "",
      title: "",
      hash: "",
    });
    expect(out["a/new"].hash).toBe("abc-def");
  });

  it("字段缺失时补空串而非丢弃记录", () => {
    const out = migrateSyncState({ "a/b": { updatedAt: "2026-01-01T00:00:00Z" } });
    expect(out["a/b"]).toEqual({
      updatedAt: "2026-01-01T00:00:00Z",
      path: "",
      url: "",
      title: "",
      hash: "",
    });
  });

  it("字段类型异常时降级为空串", () => {
    const out = migrateSyncState({
      "a/b": { updatedAt: "t", path: 123, url: null, title: {}, hash: 7 },
    });
    expect(out["a/b"]).toEqual({
      updatedAt: "t",
      path: "",
      url: "",
      title: "",
      hash: "",
    });
  });

  it("丢弃无法识别的 value", () => {
    expect(migrateSyncState({ "a/b": 42 })).toEqual({});
    expect(migrateSyncState({ "a/b": null })).toEqual({});
  });

  it("丢弃不含 / 的非法 key", () => {
    expect(migrateSyncState({ noslash: "2026-01-01T00:00:00Z" })).toEqual({});
    expect(migrateSyncState({ "": "2026-01-01T00:00:00Z" })).toEqual({});
  });

  it("幂等：重复迁移结果不变", () => {
    const raw = { "a/old": "2026-01-01T00:00:00Z", "a/new": { ...FULL } };
    const once = migrateSyncState(raw);
    expect(migrateSyncState(once)).toEqual(once);
  });

  it("不改动传入对象", () => {
    const raw: Record<string, unknown> = { "a/b": "2026-01-01T00:00:00Z" };
    migrateSyncState(raw);
    expect(raw["a/b"]).toBe("2026-01-01T00:00:00Z");
  });
});

describe("hashContent", () => {
  it("相同内容指纹稳定", () => {
    expect(hashContent("同一份文档内容")).toBe(hashContent("同一份文档内容"));
  });

  it("不同内容指纹不同", () => {
    expect(hashContent("abc")).not.toBe(hashContent("abd"));
  });

  it("换序内容指纹不同", () => {
    expect(hashContent("ab")).not.toBe(hashContent("ba"));
  });

  it("空内容也产生非空指纹", () => {
    // 否则会被 decideWrite 当作「未知」而每轮都备份
    expect(hashContent("")).not.toBe("");
  });

  it("长文本可用", () => {
    expect(hashContent("x".repeat(50_000))).not.toBe(hashContent("x".repeat(50_001)));
  });
});

describe("decideWrite", () => {
  const next = "服务端新内容";
  const current = "本地现有内容";

  it("本地不存在 → create", () => {
    expect(decideWrite({ exists: false, currentContent: null, nextContent: next })).toBe("create");
  });

  it("内容完全一致 → skip-identical（优先于指纹判定）", () => {
    expect(
      decideWrite({
        exists: true,
        currentContent: next,
        nextContent: next,
        knownHash: hashContent("完全无关的内容"),
      }),
    ).toBe("skip-identical");
  });

  it("本地未被改动 → overwrite", () => {
    expect(
      decideWrite({
        exists: true,
        currentContent: current,
        nextContent: next,
        knownHash: hashContent(current),
      }),
    ).toBe("overwrite");
  });

  it("本地已被改动 → backup-overwrite", () => {
    expect(
      decideWrite({
        exists: true,
        currentContent: current,
        nextContent: next,
        knownHash: hashContent("更早期的内容"),
      }),
    ).toBe("backup-overwrite");
  });

  it("指纹未知（旧记录或未同步过）→ 保守备份", () => {
    const base = { exists: true, currentContent: current, nextContent: next };
    expect(decideWrite({ ...base, knownHash: "" })).toBe("backup-overwrite");
    expect(decideWrite(base)).toBe("backup-overwrite");
  });
});

describe("applyRename", () => {
  /** 用 path 构造状态表，其余字段沿用 FULL */
  const st = (...entries: [string, string][]): YuqueSyncState =>
    Object.fromEntries(entries.map(([k, p]) => [k, { ...FULL, path: p }]));

  it("文件重命名 → path 跟随", () => {
    const s = st(["ns/a", "yuque/旧标题"]);
    expect(applyRename(s, "yuque/旧标题.md", "yuque/新标题.md", false)).toEqual(["ns/a"]);
    expect(s["ns/a"].path).toBe("yuque/新标题");
  });

  it("文件移动到其他文件夹 → path 跟随", () => {
    const s = st(["ns/a", "yuque/doc"]);
    expect(applyRename(s, "yuque/doc.md", "笔记/doc.md", false)).toEqual(["ns/a"]);
    expect(s["ns/a"].path).toBe("笔记/doc");
  });

  it("非 .md 文件（附件）不触发更新", () => {
    const s = st(["ns/a", "assets/pic"]);
    expect(applyRename(s, "assets/pic.png", "assets/pic2.png", false)).toEqual([]);
    expect(s["ns/a"].path).toBe("assets/pic");
  });

  it("未跟踪的文件 → 无变化", () => {
    const s = st(["ns/a", "yuque/doc"]);
    expect(applyRename(s, "yuque/别人的笔记.md", "yuque/x.md", false)).toEqual([]);
    expect(s["ns/a"].path).toBe("yuque/doc");
  });

  it("path 为空（旧记录，位置未知）→ 不误改", () => {
    const s: YuqueSyncState = { "ns/old": { ...FULL, path: "" } };
    expect(applyRename(s, "yuque/x.md", "yuque/y.md", false)).toEqual([]);
    expect(s["ns/old"].path).toBe("");
  });

  it("文件夹重命名 → 其下记录全部跟随，无关记录不动", () => {
    const s = st(["ns/a", "yuque/sub/one"], ["ns/b", "yuque/sub/two"], ["ns/c", "yuque/other"]);
    const changed = applyRename(s, "yuque/sub", "yuque/sub2", true);
    expect(changed.sort()).toEqual(["ns/a", "ns/b"]);
    expect(s["ns/a"].path).toBe("yuque/sub2/one");
    expect(s["ns/b"].path).toBe("yuque/sub2/two");
    expect(s["ns/c"].path).toBe("yuque/other");
  });

  it("文件夹整体移动（含跨根目录）→ 跟随", () => {
    const s = st(["ns/a", "yuque/sub/one"], ["ns/b", "yuque/sub/deep/two"]);
    applyRename(s, "yuque/sub", "归档/语雀", true);
    expect(s["ns/a"].path).toBe("归档/语雀/one");
    expect(s["ns/b"].path).toBe("归档/语雀/deep/two");
  });

  it("前缀按完整路径段匹配，不误伤同级相似名", () => {
    const s = st(["ns/a", "yuque/abc"]);
    expect(applyRename(s, "yuque/ab", "yuque/zz", true)).toEqual([]);
    expect(s["ns/a"].path).toBe("yuque/abc");
  });

  it("重复事件不会产生二次改写", () => {
    const s = st(["ns/a", "yuque/sub/one"]);
    applyRename(s, "yuque/sub", "笔记/sub", true);
    expect(s["ns/a"].path).toBe("笔记/sub/one");
    // 若 Obsidian 又为子文件补发一次 rename，不应再把路径改坏
    expect(applyRename(s, "yuque/sub/one.md", "笔记/sub/one.md", false)).toEqual([]);
    expect(s["ns/a"].path).toBe("笔记/sub/one");
  });

  it("旧路径为空 → 直接返回空", () => {
    const s = st(["ns/a", "yuque/doc"]);
    expect(applyRename(s, "", "yuque/doc2.md", false)).toEqual([]);
    expect(s["ns/a"].path).toBe("yuque/doc");
  });

  it("异常数据：多条记录指向同一路径时一并更新", () => {
    const s = st(["ns/a", "yuque/x"], ["ns/b", "yuque/x"]);
    expect(applyRename(s, "yuque/x.md", "yuque/y.md", false).sort()).toEqual(["ns/a", "ns/b"]);
    expect(s["ns/a"].path).toBe("yuque/y");
    expect(s["ns/b"].path).toBe("yuque/y");
  });
});

describe("pickRelocateSource", () => {
  it("state 记录的旧路径优先（本地真实位置）", () => {
    expect(pickRelocateSource("a/旧", "a/新", ["a/标题匹配"])).toBe("a/旧");
  });

  it("记录路径与新路径一致 → 不算候选，退回标题匹配", () => {
    expect(pickRelocateSource("a/x", "a/x", ["a/y"])).toBe("a/y");
  });

  it("旧记录无 path（未自愈）→ 按标题唯一匹配", () => {
    expect(pickRelocateSource("", "a/新", ["a/旧"])).toBe("a/旧");
  });

  it("标题匹配到多个同名文件 → 不猜，返回 null", () => {
    expect(pickRelocateSource("", "a/新", ["a/1", "b/1"])).toBeNull();
  });

  it("无任何候选 → null（走正常新建）", () => {
    expect(pickRelocateSource("", "a/新", [])).toBeNull();
  });

  it("新路径为空 → 直接 null", () => {
    expect(pickRelocateSource("a/旧", "", [])).toBeNull();
  });
});
