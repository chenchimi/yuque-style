import { describe, expect, it } from "vitest";
import {
  basenameOf,
  buildInternalLink,
  buildLinkIndex,
  convertLinksInContent,
  countBasenames,
  mergeStateIntoIndex,
  resolveYuqueUrl,
  type LinkTarget,
  type VaultSourceDoc,
} from "../src/yuque/link";

const doc = (path: string, source: string): VaultSourceDoc => ({ path, source });

describe("resolveYuqueUrl", () => {
  it("解析标准三段式文档地址", () => {
    expect(resolveYuqueUrl("https://www.yuque.com/chenxixi-owqym/grynq1/nymgi9gfvwd85gez")).toEqual({
      key: "chenxixi-owqym/grynq1/nymgi9gfvwd85gez",
      ns: "chenxixi-owqym/grynq1",
      slug: "nymgi9gfvwd85gez",
    });
  });

  it("无 www 与 http 也认", () => {
    expect(resolveYuqueUrl("http://yuque.com/a/b/c")?.slug).toBe("c");
  });

  it("锚点会被剥掉（语雀锚点是 slug 化的，对不上 Obsidian 的标题锚点）", () => {
    expect(resolveYuqueUrl("https://www.yuque.com/a/b/c#xyz123")?.key).toBe("a/b/c");
  });

  it("查询串会被剥掉", () => {
    expect(resolveYuqueUrl("https://www.yuque.com/a/b/c?foo=1")?.key).toBe("a/b/c");
  });

  it("附件地址返回 null（vault 里有 62 条这种）", () => {
    expect(
      resolveYuqueUrl(
        "https://www.yuque.com/attachments/yuque/0/2026/xmind/29434612/1784165703170-c29ec3ee.xmind",
      ),
    ).toBeNull();
  });

  it("仓库主页（两段）返回 null", () => {
    expect(resolveYuqueUrl("https://www.yuque.com/chenxixi-owqym/plzh08")).toBeNull();
  });

  it("非语雀域名返回 null", () => {
    expect(resolveYuqueUrl("https://example.com/a/b/c")).toBeNull();
    expect(resolveYuqueUrl("https://cdn.nlark.com/yuque/x.png")).toBeNull();
  });

  it("段数超过 3 的其它地址返回 null", () => {
    expect(resolveYuqueUrl("https://www.yuque.com/a/b/c/d")).toBeNull();
  });

  it("结尾多余斜杠不影响", () => {
    expect(resolveYuqueUrl("https://www.yuque.com/a/b/c/")?.key).toBe("a/b/c");
  });

  it("不是 URL 的字符串返回 null", () => {
    expect(resolveYuqueUrl("")).toBeNull();
    expect(resolveYuqueUrl("yuque.com/a/b/c")).toBeNull();
  });
});

describe("buildLinkIndex", () => {
  it("用 frontmatter 的 source 建索引", () => {
    const index = buildLinkIndex([
      doc("计算机网络/内网穿透介绍.md", "https://www.yuque.com/chenxixi-owqym/grynq1/nymgi9gfvwd85gez"),
    ]);
    expect(index.get("chenxixi-owqym/grynq1/nymgi9gfvwd85gez")).toEqual({
      path: "计算机网络/内网穿透介绍",
      basename: "内网穿透介绍",
    });
  });

  it("没有 source 的文件不进索引", () => {
    expect(buildLinkIndex([doc("自己写的笔记.md", "")]).size).toBe(0);
  });

  it("source 不是语雀文档地址（附件）也不进索引", () => {
    const index = buildLinkIndex([
      doc("附件.md", "https://www.yuque.com/attachments/yuque/0/2026/x.xmind"),
    ]);
    expect(index.size).toBe(0);
  });

  it("同一地址被两个文件引用时保留第一个", () => {
    const index = buildLinkIndex([
      doc("A/重复.md", "https://www.yuque.com/a/b/c"),
      doc("B/重复.md", "https://www.yuque.com/a/b/c"),
    ]);
    expect(index.get("a/b/c")!.path).toBe("A/重复");
  });
});

describe("mergeStateIntoIndex", () => {
  it("同步记录作为兜底补齐索引", () => {
    const index = buildLinkIndex([]);
    mergeStateIntoIndex(index, { "a/b/c": { path: "语雀/某文档" } });
    expect(index.get("a/b/c")).toEqual({ path: "语雀/某文档", basename: "某文档" });
  });

  it("不覆盖 frontmatter 索引已有的条目", () => {
    const index = buildLinkIndex([doc("新路径.md", "https://www.yuque.com/a/b/c")]);
    mergeStateIntoIndex(index, { "a/b/c": { path: "旧路径" } });
    expect(index.get("a/b/c")!.path).toBe("新路径");
  });

  it("记录里 path 为空（老记录未自愈）时跳过", () => {
    const index = buildLinkIndex([]);
    mergeStateIntoIndex(index, { "a/b/c": { path: "" }, "a/b/d": {} });
    expect(index.size).toBe(0);
  });
});

describe("buildInternalLink", () => {
  const unique: LinkTarget = { path: "计算机网络/内网穿透介绍", basename: "内网穿透介绍" };

  it("文件名唯一 → 短链接", () => {
    expect(buildInternalLink(unique, "内网穿透介绍", true)).toBe("[[内网穿透介绍]]");
  });

  it("唯一但链接文字不同 → 带别名", () => {
    expect(buildInternalLink(unique, "点这里", true)).toBe("[[内网穿透介绍|点这里]]");
  });

  it("撞车 → 用完整路径，并显式带别名", () => {
    expect(buildInternalLink(unique, "内网穿透介绍", false)).toBe(
      "[[计算机网络/内网穿透介绍|内网穿透介绍]]",
    );
  });

  it("撞车且链接文字不同 → 路径 + 原文字", () => {
    expect(buildInternalLink(unique, "点这里", false)).toBe(
      "[[计算机网络/内网穿透介绍|点这里]]",
    );
  });

  it("别名含 | 会让链接碎掉 → 退回不带别名", () => {
    expect(buildInternalLink(unique, "A|B", true)).toBe("[[内网穿透介绍]]");
    expect(buildInternalLink(unique, "A|B", false)).toBe(
      "[[计算机网络/内网穿透介绍|内网穿透介绍]]",
    );
  });

  it("别名含 ]] 同样退回", () => {
    expect(buildInternalLink(unique, "结束]]", true)).toBe("[[内网穿透介绍]]");
  });

  it("目标还没落盘（无 path）时退回短链接", () => {
    expect(buildInternalLink({ path: "", basename: "新文档" }, "新文档", false)).toBe("[[新文档]]");
  });
});

describe("convertLinksInContent", () => {
  const index = buildLinkIndex([
    doc(
      "计算机网络/网络技术/内网穿透/内网穿透介绍.md",
      "https://www.yuque.com/chenxixi-owqym/grynq1/nymgi9gfvwd85gez",
    ),
  ]);
  const counts = countBasenames(["内网穿透介绍"]);

  it("把跨库的语雀链接换成本地双链", () => {
    const r = convertLinksInContent(
      "[内网穿透介绍](https://www.yuque.com/chenxixi-owqym/grynq1/nymgi9gfvwd85gez)\n",
      index,
      counts,
    );
    expect(r.content).toBe("[[内网穿透介绍]]\n");
    expect(r.converted).toBe(1);
  });

  it("链接文字与标题不同时保留原文字作为别名", () => {
    const r = convertLinksInContent(
      "[点这里](https://www.yuque.com/chenxixi-owqym/grynq1/nymgi9gfvwd85gez)",
      index,
      counts,
    );
    expect(r.content).toBe("[[内网穿透介绍|点这里]]");
  });

  it("目标没同步过 → 保持外部链接", () => {
    const raw = "[别的文档](https://www.yuque.com/chenxixi-owqym/xxxxx/notsynced)";
    expect(convertLinksInContent(raw, index, counts).content).toBe(raw);
  });

  it("附件链接不动", () => {
    const raw = "[附件](https://www.yuque.com/attachments/yuque/0/2026/xmind/1/a.xmind)";
    expect(convertLinksInContent(raw, index, counts).content).toBe(raw);
  });

  it("frontmatter 里的 source 不动（它是建索引的原料）", () => {
    const raw = [
      "---",
      "title: A",
      "source: https://www.yuque.com/chenxixi-owqym/grynq1/nymgi9gfvwd85gez",
      "---",
      "",
    ].join("\n");
    expect(convertLinksInContent(raw, index, counts).content).toBe(raw);
  });

  it("围栏代码块里的链接不动", () => {
    const raw = [
      "```bash",
      "[内网穿透介绍](https://www.yuque.com/chenxixi-owqym/grynq1/nymgi9gfvwd85gez)",
      "```",
      "",
    ].join("\n");
    expect(convertLinksInContent(raw, index, counts).content).toBe(raw);
  });

  it("图片语法不被当成链接（否则会把文档嵌成图片）", () => {
    const raw = "![图](https://www.yuque.com/chenxixi-owqym/grynq1/nymgi9gfvwd85gez)";
    expect(convertLinksInContent(raw, index, counts).content).toBe(raw);
  });

  it("同名撞车时改用完整路径", () => {
    const dup = countBasenames(["内网穿透介绍", "内网穿透介绍"]);
    const r = convertLinksInContent(
      "[内网穿透介绍](https://www.yuque.com/chenxixi-owqym/grynq1/nymgi9gfvwd85gez)",
      index,
      dup,
    );
    expect(r.content).toBe("[[计算机网络/网络技术/内网穿透/内网穿透介绍|内网穿透介绍]]");
  });

  it("一处多行、多个链接都会转换", () => {
    const raw = [
      "[A](https://www.yuque.com/chenxixi-owqym/grynq1/nymgi9gfvwd85gez)",
      "正文",
      "[B](https://www.yuque.com/chenxixi-owqym/grynq1/nymgi9gfvwd85gez)",
    ].join("\n");
    const r = convertLinksInContent(raw, index, counts);
    expect(r.converted).toBe(2);
    // 第二条链接文字是 B，与标题不同，因此带别名——这是预期行为
    expect(r.content.split("\n")[2]).toBe("[[内网穿透介绍|B]]");
  });
});

describe("basenameOf", () => {
  it("去掉目录与 .md", () => {
    expect(basenameOf("a/b/标题.md")).toBe("标题");
    expect(basenameOf("标题")).toBe("标题");
  });
});
