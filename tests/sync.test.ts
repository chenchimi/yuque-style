import { describe, expect, it, vi } from "vitest";
import { TFolder } from "obsidian";
import { encodeLinkTarget, syncTask } from "../src/yuque/sync";
import { applyRename, hashContent } from "../src/yuque/state";
import { FakeVault } from "./mocks/vault";
import type { YuqueStylePlugin } from "../src/main";
import type { YuqueApi, YuqueDocDetail, YuqueDocSummary, YuqueTocNode } from "../src/yuque/api";
import type { YuqueSyncTaskType } from "../src/yuque/sync";

/** 正文可以是纯字符串，也可以顺便覆盖 detail 的 updated_at */
type DocBody = string | { body: string; updated_at?: string };

interface SetupOpts {
  docs: YuqueDocSummary[];
  bodies?: Record<string, DocBody>;
  toc?: YuqueTocNode[];
  mode?: "all" | "selected";
  selectedDocs?: { slug: string; title: string }[];
  downloadImages?: boolean;
  backupOnConflict?: boolean;
  state?: Record<string, unknown>;
  /** 默认「语雀」；带空格的目录名用来回归「图片链接退化成普通文本」的 bug */
  targetFolder?: string;
}

function doc(slug: string, title: string, updated_at: string): YuqueDocSummary {
  return { id: 1, slug, title, updated_at };
}

function setup(opts: SetupOpts) {
  const logs: string[] = [];
  const saved = { count: 0 };
  const vault = new FakeVault();
  const docs = opts.docs;
  const bodies: Record<string, DocBody> = opts.bodies ?? {};

  const plugin = {
    settings: {
      yuqueDownloadImages: opts.downloadImages ?? false,
      yuqueAssetsFolder: "assets",
      yuqueBackupOnConflict: opts.backupOnConflict ?? true,
      yuqueSyncState: (opts.state ?? {}) as Record<string, never>,
    },
    app: {
      vault,
      // 双链索引要靠文档属性的「来源」建表，这里把假 vault 里的前言区解析成对象。
      // 键名可能是中文（新写入）或英文（存量文档），解析必须两种都认
      metadataCache: {
        getFileCache: (file: { path: string }) => {
          const content = vault.files.get(file.path) ?? "";
          const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
          const frontmatter: Record<string, string> = {};
          if (fm) {
            for (const line of fm[1].split(/\r?\n/)) {
              const m = line.match(/^([^\s:]+):\s*(.+)$/);
              if (m) frontmatter[m[1]] = m[2].trim();
            }
          }
          return { frontmatter };
        },
      },
    },
    async saveSettings() {
      saved.count++;
    },
  };

  const api = {
    getToc: vi.fn(async () => opts.toc ?? []),
    getDocListOnce: vi.fn(async () => docs),
    getDoc: vi.fn(async (_ns: string, slug: string) => {
      const d = docs.find((x) => x.slug === slug)!;
      const spec = bodies[slug] ?? "";
      const detail: YuqueDocDetail =
        typeof spec === "string"
          ? { ...d, body: spec }
          : { ...d, body: spec.body, updated_at: spec.updated_at ?? d.updated_at };
      return detail;
    }),
    downloadBinary: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
  };

  const task: YuqueSyncTaskType = {
    repoId: 1,
    namespace: "ns",
    repoName: "我的库",
    targetFolder: opts.targetFolder ?? "语雀",
    mode: opts.mode ?? "all",
    selectedDocs: opts.selectedDocs ?? [],
  };

  const run = () =>
    syncTask(
      plugin as unknown as YuqueStylePlugin,
      api as unknown as YuqueApi,
      task,
      (msg) => logs.push(msg),
    );

  return { logs, saved, vault, plugin, api, task, docs, bodies, run };
}

/** vault 内的笔记（排除备份区） */
const notePaths = (v: FakeVault) =>
  [...v.files.keys()].filter((p) => p.endsWith(".md") && !p.startsWith(".yuque-backups")).sort();

const backupPaths = (v: FakeVault, slug = "a") =>
  [...v.files.keys()].filter((p) => p.startsWith(`.yuque-backups/ns/${slug}/`)).sort();

const state = (s: ReturnType<typeof setup>) =>
  s.plugin.settings.yuqueSyncState as unknown as Record<
    string,
    { updatedAt: string; path: string; url: string; title: string; hash: string; folder: string | null }
  >;

describe("syncTask · 增量与状态记录", () => {
  it("首次同步：创建文件，并写入完整状态记录", async () => {
    const s = setup({ docs: [doc("a", "标题A", "t1")], bodies: { a: "正文A" } });
    await s.run();

    const content = s.vault.files.get("语雀/标题A.md");
    expect(content).toContain("正文A");
    expect(content).toContain("https://www.yuque.com/ns/a");

    const rec = state(s)["ns/a"];
    expect(rec.path).toBe("语雀/标题A");
    expect(rec.updatedAt).toBe("t1");
    expect(rec.title).toBe("标题A");
    expect(rec.url).toBe("https://www.yuque.com/ns/a");
    expect(rec.hash).toBe(hashContent(content!));
    expect(s.saved.count).toBe(1);
  });

  it("远端未变：跳过写入，且必须保留原 hash（否则下次会误判为本地改过）", async () => {
    const s = setup({ docs: [doc("a", "标题A", "t1")], bodies: { a: "正文A" } });
    await s.run();
    const hashBefore = state(s)["ns/a"].hash;
    const writesBefore = s.vault.writes.length;

    await s.run();

    // 未变化就不该再写一次文件
    expect(s.vault.writes.length).toBe(writesBefore);
    expect(state(s)["ns/a"].hash).toBe(hashBefore);
    expect(s.logs.some((l) => l.includes("跳过未变化 1 篇"))).toBe(true);
  });

  it("列表 updated_at 变了但正文未变：不重写文件，状态仍更新", async () => {
    const s = setup({ docs: [doc("a", "标题A", "t1")], bodies: { a: "正文A" } });
    await s.run();
    const writesBefore = s.vault.writes.length;

    // detail 的 updated_at 保持 t1 → 生成的正文（含 frontmatter）与本地完全一致
    s.docs[0].updated_at = "t2";
    s.bodies.a = { body: "正文A", updated_at: "t1" };
    await s.run();

    expect(s.vault.writes.length).toBe(writesBefore);
    expect(s.logs.some((l) => l.includes("内容未变 1 篇"))).toBe(true);
    expect(state(s)["ns/a"].updatedAt).toBe("t2");
  });

  it("旧记录（path 为空）自愈后，即使本次没有文件写入也要落盘", async () => {
    const s = setup({
      docs: [doc("a", "标题A", "t1")],
      bodies: { a: "正文A" },
      state: { "ns/a": { updatedAt: "t1", path: "", url: "", title: "", hash: "" } },
    });
    await s.vault.create("语雀/标题A.md", "已有内容");

    await s.run();

    // 走了 skip 分支 → staged 为空，但补全的 path 不能丢
    expect(state(s)["ns/a"].path).toBe("语雀/标题A");
    expect(s.saved.count).toBe(1);
    // 自愈不应改动文件内容
    expect(s.vault.files.get("语雀/标题A.md")).toBe("已有内容");
  });
});

describe("syncTask · 本地重命名跟随", () => {
  it("用户改名后再次同步：写入改名后的文件，不产生重复", async () => {
    const s = setup({ docs: [doc("a", "标题A", "t1")], bodies: { a: "正文A" } });
    await s.run();
    expect(notePaths(s.vault)).toEqual(["语雀/标题A.md"]);

    // 与 main.ts 的 handleRename 保持一致：vault 事件 → applyRename
    s.vault.on("rename", (file, oldPath) => {
      applyRename(
        s.plugin.settings.yuqueSyncState as never,
        oldPath,
        file.path,
        file instanceof TFolder,
      );
    });
    await s.vault.rename(s.vault.getAbstractFileByPath("语雀/标题A.md")!, "语雀/我的笔记.md");
    expect(state(s)["ns/a"].path).toBe("语雀/我的笔记");

    s.docs[0].updated_at = "t2";
    s.bodies.a = "正文B";
    await s.run();

    expect(s.vault.files.get("语雀/我的笔记.md")).toContain("正文B");
    // 旧的「标题A」是同一次改名的产物，不应再被重建
    expect(notePaths(s.vault)).toEqual(["语雀/我的笔记.md"]);
  });

  it("整个文件夹被移动后再次同步：跟随到新位置", async () => {
    const s = setup({
      docs: [doc("a", "标题A", "t1")],
      bodies: { a: "正文A" },
      toc: [{ uuid: "d1", parent_uuid: "", title: "标题A", type: "DOC", slug: "a", url: "/ns/a" }],
    });
    await s.run();
    expect(notePaths(s.vault)).toContain("语雀/标题A.md");

    s.vault.on("rename", (file, oldPath) => {
      applyRename(
        s.plugin.settings.yuqueSyncState as never,
        oldPath,
        file.path,
        file instanceof TFolder,
      );
    });
    await s.vault.rename(s.vault.getAbstractFileByPath("语雀")!, "归档/语雀");
    expect(state(s)["ns/a"].path).toBe("归档/语雀/标题A");

    s.docs[0].updated_at = "t2";
    s.bodies.a = "正文B";
    await s.run();

    expect(s.vault.files.get("归档/语雀/标题A.md")).toContain("正文B");
    expect(s.vault.files.has("语雀/标题A.md")).toBe(false);
  });
});

describe("syncTask · 语雀端目录调整", () => {
  it("旧记录未自愈时文档被挪进新 TOC 分组：搬移旧文件，不产生重复（真实事故回归）", async () => {
    const s = setup({
      docs: [doc("a", "标题A", "t2")],
      bodies: { a: "正文B" },
      toc: [
        { uuid: "g1", parent_uuid: "", title: "新分组", type: "TITLE" },
        { uuid: "d1", parent_uuid: "g1", title: "标题A", type: "DOC", slug: "a", url: "/ns/a" },
      ],
      // 旧格式记录：path 为空，本地文件在根下（用户在自愈前挪动过）
      state: { "ns/a": { updatedAt: "t1", path: "", url: "", title: "", hash: "" } },
    });
    await s.vault.create("语雀/标题A.md", "旧拷贝");

    await s.run();

    // 旧文件被整体搬到新位置并写入新内容，而不是另建一份
    expect(s.vault.files.get("语雀/新分组/标题A.md")).toContain("正文B");
    expect(s.vault.files.has("语雀/标题A.md")).toBe(false);
    expect(s.logs.some((l) => l.includes("位置跟随语雀目录"))).toBe(true);
    expect(state(s)["ns/a"].path).toBe("语雀/新分组/标题A");
  });

  it("新旧位置都有文件时不自动删除用户文件，只提示人工处理", async () => {
    const s = setup({
      docs: [doc("a", "标题A", "t2")],
      bodies: { a: "正文B" },
      toc: [
        { uuid: "g1", parent_uuid: "", title: "新分组", type: "TITLE" },
        { uuid: "d1", parent_uuid: "g1", title: "标题A", type: "DOC", slug: "a", url: "/ns/a" },
      ],
      state: { "ns/a": { updatedAt: "t1", path: "", url: "", title: "", hash: "" } },
    });
    await s.vault.create("语雀/标题A.md", "旧拷贝");
    await s.vault.create("语雀/新分组/标题A.md", "已有拷贝");

    await s.run();

    expect(s.vault.files.get("语雀/标题A.md")).toBe("旧拷贝");
    expect(s.vault.files.get("语雀/新分组/标题A.md")).toContain("正文B");
    expect(s.logs.some((l) => l.includes("疑似重复"))).toBe(true);
  });
});

describe("syncTask · 语雀端分组改名", () => {
  /** 一个分组 + 组内一篇文档的 TOC */
  const tocWithGroup = (title: string): YuqueTocNode[] => [
    { uuid: "g1", parent_uuid: "", title, type: "TITLE" },
    { uuid: "d1", parent_uuid: "g1", title: "标题A", type: "DOC", slug: "a", url: "/ns/a" },
  ];

  it("分组改名：增量同步后本地文件夹跟着改名，正文没变就不重新拉取", async () => {
    const s = setup({
      docs: [doc("a", "标题A", "t1")],
      bodies: { a: "正文A" },
      toc: tocWithGroup("旧分组"),
    });
    await s.run();
    expect(s.vault.files.has("语雀/旧分组/标题A.md")).toBe(true);
    expect(state(s)["ns/a"].folder).toBe("旧分组");
    const detailCalls = s.api.getDoc.mock.calls.length;

    // 语雀端把分组改名：组内文档自身的 updated_at 不会有任何变化
    s.api.getToc = vi.fn(async () => tocWithGroup("新分组"));
    await s.run();

    expect(s.vault.files.has("语雀/新分组/标题A.md")).toBe(true);
    expect(s.vault.files.has("语雀/旧分组/标题A.md")).toBe(false);
    expect(s.logs.some((l) => l.includes("分组跟随语雀"))).toBe(true);
    expect(state(s)["ns/a"].path).toBe("语雀/新分组/标题A");
    expect(state(s)["ns/a"].folder).toBe("新分组");
    // vault.rename 不会创建目标文件夹，新分组目录必须先由插件建出来（否则 ENOENT）
    expect(s.vault.dirs.has("语雀/新分组")).toBe(true);
    // 只是改了个文件夹名，不该为此重新下载正文
    expect(s.api.getDoc.mock.calls.length).toBe(detailCalls);
  });

  it("升级前的旧记录（无分组历史）：语雀改名后第一次同步就能跟随", async () => {
    const oldContent = "旧正文";
    const s = setup({
      docs: [doc("a", "标题A", "t1")],
      bodies: { a: "正文A" },
      toc: tocWithGroup("新分组"),
      // 旧版格式记录：没有 folder 字段，path 指向改名前的分组
      state: {
        "ns/a": {
          updatedAt: "t1",
          path: "语雀/旧分组/标题A",
          url: "",
          title: "标题A",
          hash: hashContent(oldContent),
        },
      },
    });
    await s.vault.create("语雀/旧分组/标题A.md", oldContent);

    await s.run();

    expect(s.vault.files.has("语雀/新分组/标题A.md")).toBe(true);
    expect(s.vault.files.has("语雀/旧分组/标题A.md")).toBe(false);
    expect(state(s)["ns/a"].path).toBe("语雀/新分组/标题A");
    // 正文未变 → 直接跳过写入，磁盘上的内容一动不动
    expect(s.vault.files.get("语雀/新分组/标题A.md")).toBe(oldContent);
  });

  it("本地自己改的分组名不会被语雀端结构搬回去", async () => {
    const s = setup({
      docs: [doc("a", "标题A", "t1")],
      bodies: { a: "正文A" },
      toc: tocWithGroup("分组"),
    });
    await s.run();
    expect(state(s)["ns/a"].folder).toBe("分组");

    // 与 main.ts 的 handleRename 一致：本地改名只更新 path，不动 folder
    s.vault.on("rename", (file, oldPath) => {
      applyRename(
        s.plugin.settings.yuqueSyncState as never,
        oldPath,
        file.path,
        file instanceof TFolder,
      );
    });
    await s.vault.rename(s.vault.getAbstractFileByPath("语雀/分组")!, "语雀/我的分组");
    expect(state(s)["ns/a"].path).toBe("语雀/我的分组/标题A");

    await s.run();

    expect(s.vault.files.has("语雀/我的分组/标题A.md")).toBe(true);
    expect(s.vault.files.has("语雀/分组/标题A.md")).toBe(false);
  });

  it("只有分组改名、正文全都不用写时，目录索引页也要跟着刷新", async () => {
    const s = setup({
      docs: [doc("a", "标题A", "t1")],
      bodies: { a: "正文A" },
      toc: tocWithGroup("旧分组"),
    });
    await s.run();
    expect(s.vault.files.get("语雀/我的库 目录.md")).toContain("**旧分组**");

    s.api.getToc = vi.fn(async () => tocWithGroup("新分组"));
    await s.run();

    expect(s.logs.some((l) => l.includes("没有需要写入的文档"))).toBe(true);
    expect(s.vault.files.get("语雀/我的库 目录.md")).toContain("**新分组**");
  });

  it("一篇都没变时不会无谓重写目录索引页", async () => {
    const s = setup({
      docs: [doc("a", "标题A", "t1")],
      bodies: { a: "正文A" },
      toc: tocWithGroup("分组"),
    });
    await s.run();
    const writes = s.vault.writes.length;

    await s.run();

    expect(s.vault.writes.length).toBe(writes);
  });

  it("分组被挪到别的父分组下：整组跟随，不产生重复", async () => {
    const s = setup({
      docs: [doc("a", "标题A", "t1")],
      bodies: { a: "正文A" },
      toc: [
        { uuid: "p1", parent_uuid: "", title: "父分组", type: "TITLE" },
        { uuid: "g1", parent_uuid: "p1", title: "子分组", type: "TITLE" },
        { uuid: "d1", parent_uuid: "g1", title: "标题A", type: "DOC", slug: "a", url: "/ns/a" },
      ],
    });
    await s.run();
    expect(s.vault.files.has("语雀/父分组/子分组/标题A.md")).toBe(true);

    // 语雀端把「子分组」改名（父级结构不变）
    s.api.getToc = vi.fn(async () => [
      { uuid: "p1", parent_uuid: "", title: "父分组", type: "TITLE" },
      { uuid: "g1", parent_uuid: "p1", title: "新子分组", type: "TITLE" },
      { uuid: "d1", parent_uuid: "g1", title: "标题A", type: "DOC", slug: "a", url: "/ns/a" },
    ]);
    await s.run();

    expect(s.vault.files.has("语雀/父分组/新子分组/标题A.md")).toBe(true);
    expect(s.vault.dirs.has("语雀/父分组/新子分组")).toBe(true);
    expect(notePaths(s.vault).filter((p) => p.endsWith("标题A.md"))).toHaveLength(1);
    expect(state(s)["ns/a"].folder).toBe("父分组/新子分组");
  });
});

describe("syncTask · 冲突备份", () => {
  it("本地被改动 → 先备份再覆盖", async () => {
    const s = setup({ docs: [doc("a", "标题A", "t1")], bodies: { a: "正文A" } });
    await s.run();

    const userEdit = "用户改过的内容";
    await s.vault.modify(s.vault.getFileByPath("语雀/标题A.md")!, userEdit);
    s.docs[0].updated_at = "t2";
    s.bodies.a = "远端新内容";
    await s.run();

    const backups = backupPaths(s.vault);
    expect(backups.length).toBe(1);
    expect(s.vault.files.get(backups[0])).toBe(userEdit);

    const written = s.vault.files.get("语雀/标题A.md")!;
    expect(written).toContain("远端新内容");
    expect(state(s)["ns/a"].hash).toBe(hashContent(written));
  });

  it("本地未被改动 → 直接覆盖，不备份", async () => {
    const s = setup({ docs: [doc("a", "标题A", "t1")], bodies: { a: "正文A" } });
    await s.run();

    s.docs[0].updated_at = "t2";
    s.bodies.a = "远端新内容";
    await s.run();

    expect(backupPaths(s.vault).length).toBe(0);
    expect(s.vault.files.get("语雀/标题A.md")).toContain("远端新内容");
  });

  it("关闭备份开关后不再产生备份", async () => {
    const s = setup({
      docs: [doc("a", "标题A", "t1")],
      bodies: { a: "正文A" },
      backupOnConflict: false,
    });
    await s.run();
    await s.vault.modify(s.vault.getFileByPath("语雀/标题A.md")!, "用户改动");
    s.docs[0].updated_at = "t2";
    s.bodies.a = "远端新内容";
    await s.run();

    expect(backupPaths(s.vault).length).toBe(0);
    expect(s.vault.files.get("语雀/标题A.md")).toContain("远端新内容");
  });

  it("备份超过 5 份时只保留最近 5 份", async () => {
    const s = setup({ docs: [doc("a", "标题A", "t1")], bodies: { a: "正文A" } });
    await s.run();
    await s.vault.modify(s.vault.getFileByPath("语雀/标题A.md")!, "用户改动");

    // 预置 5 份旧备份，本次再产生 1 份 → 共 6 份
    for (let i = 1; i <= 5; i++) {
      await s.vault.create(`.yuque-backups/ns/a/20200101-000000-00${i}__标题A.md`, `旧备份${i}`);
    }
    s.docs[0].updated_at = "t2";
    s.bodies.a = "远端新内容";
    await s.run();

    const backups = backupPaths(s.vault);
    expect(backups.length).toBe(5);
    // 文件名以时间戳开头，字典序即时间序 → 最旧的 001 被清理
    expect(backups[0]).toContain("20200101-000000-002");
    expect(s.vault.files.get(backups[4])).toBe("用户改动");
  });
});

describe("syncTask · 目录结构与索引", () => {
  it("按 TOC 层级落到子目录", async () => {
    const s = setup({
      docs: [doc("a", "标题A", "t1")],
      bodies: { a: "正文A" },
      toc: [
        { uuid: "g1", parent_uuid: "", title: "分组", type: "TITLE" },
        { uuid: "d1", parent_uuid: "g1", title: "标题A", type: "DOC", slug: "a", url: "/ns/a" },
      ],
    });
    await s.run();

    expect(s.vault.files.has("语雀/分组/标题A.md")).toBe(true);
    expect(state(s)["ns/a"].path).toBe("语雀/分组/标题A");
  });

  it("全量模式生成知识库目录索引页", async () => {
    const s = setup({
      docs: [doc("a", "标题A", "t1")],
      bodies: { a: "正文A" },
      toc: [{ uuid: "d1", parent_uuid: "", title: "标题A", type: "DOC", slug: "a", url: "/ns/a" }],
    });
    await s.run();

    const index = s.vault.files.get("语雀/我的库 目录.md");
    expect(index).toBeTruthy();
    expect(index).toContain("# 我的库 · 知识库目录");
    // 别名与文件名相同时不写冗余别名（与 Obsidian「最短路径」的写法一致）
    expect(index).toContain("[[标题A]]");
    expect(index).not.toContain("[[标题A|标题A]]");
  });

  it("选定模式只同步选中的文档", async () => {
    const s = setup({
      docs: [doc("a", "标题A", "t1"), doc("b", "标题B", "t1")],
      bodies: { a: "正文A", b: "正文B" },
      mode: "selected",
      selectedDocs: [{ slug: "b", title: "标题B" }],
    });
    await s.run();

    expect(notePaths(s.vault)).toEqual(["语雀/标题B.md"]);
    expect(state(s)["ns/a"]).toBeUndefined();
  });
});

describe("syncTask · 文档属性", () => {
  it("写入语雀的创建时间与文档 ID（以前这两个字段根本没存）", async () => {
    const s = setup({
      docs: [
        { id: 42, slug: "a", title: "标题A", updated_at: "t1", created_at: "2023-05-01T00:00:00.000Z" },
      ],
      bodies: { a: "正文" },
    });
    await s.run();

    const content = s.vault.files.get("语雀/标题A.md")!;
    expect(content).toContain("语雀ID: 42");
    expect(content).toContain("语雀创建时间: 2023-05-01T00:00:00.000Z");
    expect(content).toContain("语雀更新时间: t1");
  });

  it("属性键名一律中文（属性面板直接显示键名）", async () => {
    const s = setup({ docs: [doc("a", "标题A", "t1")], bodies: { a: "正文" } });
    await s.run();

    const content = s.vault.files.get("语雀/标题A.md")!;
    expect(content).toContain("标题: 标题A");
    expect(content).toContain("来源: https://www.yuque.com/ns/a");
    expect(content).not.toMatch(/^(title|source|yuque_)/m);
  });

  it("接口返回标签时写进「语雀标签」", async () => {
    const s = setup({ docs: [doc("a", "标题A", "t1")], bodies: { a: "正文" } });
    s.api.getDoc = vi.fn(async () => ({
      id: 1,
      slug: "a",
      title: "标题A",
      updated_at: "t1",
      body: "正文",
      tags: [{ name: "运维" }, { title: "内网" }],
    }));
    await s.run();

    const content = s.vault.files.get("语雀/标题A.md")!;
    expect(content).toContain("语雀标签:\n  - 运维\n  - 内网");
  });

  it("接口不返回标签时不留空字段", async () => {
    const s = setup({ docs: [doc("a", "标题A", "t1")], bodies: { a: "正文" } });
    await s.run();

    expect(s.vault.files.get("语雀/标题A.md")!).not.toContain("语雀标签");
  });

});

describe("syncTask · 语雀文档链接转本地双链", () => {
  const TARGET_URL = "https://www.yuque.com/chenxixi-owqym/grynq1/nymgi9gfvwd85gez";

  it("跨知识库引用也能转（目标属于另一个库、同步在别的目录）", async () => {
    const s = setup({
      docs: [doc("a", "内网穿透技术", "t1")],
      bodies: { a: `正文\n\n[内网穿透介绍](${TARGET_URL})\n` },
      targetFolder: "系统运维/运维部署",
    });
    // 目标文档已由另一个知识库的任务同步到完全不同的目录（属性是中文键名）
    s.vault.files.set(
      "计算机网络/网络技术/内网穿透/内网穿透介绍.md",
      `---\n标题: 内网穿透介绍\n来源: ${TARGET_URL}\n---\n\n正文\n`,
    );
    await s.run();

    const content = s.vault.files.get("系统运维/运维部署/内网穿透技术.md")!;
    expect(content).toContain("[[内网穿透介绍]]");
    expect(content).not.toContain("grynq1");
  });

  it("目标没同步过 → 保持外部链接", async () => {
    const s = setup({
      docs: [doc("a", "标题A", "t1")],
      bodies: { a: `[别的文档](${TARGET_URL})\n` },
    });
    await s.run();

    const content = s.vault.files.get("语雀/标题A.md")!;
    expect(content).toContain(TARGET_URL);
  });

  it("目标文件名在 vault 内撞车 → 改用完整路径，避免指错文档", async () => {
    const s = setup({
      docs: [doc("a", "标题A", "t1")],
      bodies: { a: `[内网穿透介绍](${TARGET_URL})\n` },
    });
    // 存量的旧英文键也要能建上索引（sync 改名前同步下来的文档）
    s.vault.files.set(
      "计算机网络/内网穿透介绍.md",
      `---\ntitle: 内网穿透介绍\nsource: ${TARGET_URL}\n---\n\n正文\n`,
    );
    // 另一篇同名笔记（与语雀无关），足够让短链接产生歧义
    s.vault.files.set("系统运维/内网穿透介绍.md", "---\ntitle: 内网穿透介绍\n---\n\n自己写的\n");
    await s.run();

    const content = s.vault.files.get("语雀/标题A.md")!;
    expect(content).toContain("[[计算机网络/内网穿透介绍|内网穿透介绍]]");
  });

  it("附件链接不会被动", async () => {
    const s = setup({
      docs: [doc("a", "标题A", "t1")],
      bodies: {
        a: "[附件](https://www.yuque.com/attachments/yuque/0/2026/xmind/1/a.xmind)\n",
      },
    });
    await s.run();

    expect(s.vault.files.get("语雀/标题A.md")!).toContain(
      "https://www.yuque.com/attachments/yuque/0/2026/xmind/1/a.xmind",
    );
  });
});

describe("encodeLinkTarget", () => {
  it("空格编码成 %20", () => {
    expect(encodeLinkTarget("../Docker 和 K8S/assets/x.png")).toBe(
      "../Docker%20和%20K8S/assets/x.png",
    );
  });

  it("中文与斜杠保持原样（可读性优先）", () => {
    expect(encodeLinkTarget("语雀/assets/图.png")).toBe("语雀/assets/图.png");
  });

  it("括号、井号、百分号也要编码", () => {
    expect(encodeLinkTarget("a(1)/b#c/100%.png")).toBe("a%281%29/b%23c/100%25.png");
  });

  it("没有特殊字符时原样返回", () => {
    expect(encodeLinkTarget("assets/x.png")).toBe("assets/x.png");
  });
});

describe("syncTask · 图片本地化", () => {
  it("下载语雀 CDN 图片并改写为相对路径", async () => {
    const s = setup({
      docs: [doc("a", "标题A", "t1")],
      bodies: { a: "正文\n\n![img](https://cdn.nlark.com/yuque/x.png)" },
      downloadImages: true,
    });
    await s.run();

    expect(s.vault.binaries.size).toBe(1);
    const assetPath = [...s.vault.binaries.keys()][0];
    expect(assetPath).toMatch(/^语雀\/assets\/yuque-[a-z0-9]+\.png$/);

    const content = s.vault.files.get("语雀/标题A.md")!;
    expect(content).toMatch(/!\[img\]\(\.\.\/语雀\/assets\/yuque-[a-z0-9]+\.png\)/);
    expect(s.api.downloadBinary).toHaveBeenCalled();
  });

  it("目标目录带空格时链接目标会被编码（否则图片整段退化成普通文本）", async () => {
    const s = setup({
      docs: [doc("a", "标题A", "t1")],
      bodies: { a: "正文\n\n![img](https://cdn.nlark.com/yuque/x.png)" },
      downloadImages: true,
      targetFolder: "Docker 和 K8S",
    });
    await s.run();

    const content = s.vault.files.get("Docker 和 K8S/标题A.md")!;
    expect(content).toMatch(
      /!\[img\]\(\.\.\/Docker%20和%20K8S\/assets\/yuque-[a-z0-9]+\.png\)/,
    );
    // 未编码的路径不能出现在正文里
    expect(content).not.toContain("Docker 和 K8S/assets");
  });

  it("关闭图片下载时保留远程链接", async () => {
    const s = setup({
      docs: [doc("a", "标题A", "t1")],
      bodies: { a: "正文\n\n![img](https://cdn.nlark.com/yuque/x.png)" },
    });
    await s.run();

    expect(s.vault.binaries.size).toBe(0);
    expect(s.vault.files.get("语雀/标题A.md")).toContain("https://cdn.nlark.com/yuque/x.png");
  });
});
