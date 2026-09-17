/**
 * Lake → Markdown 转换单测（旧版 card 卡片 + 新版 ne-* 标签两代格式）。
 *
 * 注意：这里直接 import 源码 `src/yuque/lake.ts`，不再依赖任何编译产物，
 * 保证改动 lake.ts 后测试能立刻反映真实行为。
 */
import { describe, expect, it } from "vitest";
import {
  cleanMarkdownBody,
  convertYuqueBody,
  isLakeBody,
  lakeToMarkdown,
  stripColorSpans,
  stripDefaultColorSpans,
} from "../src/yuque/lake";

/** 构造 card value（data: + encodeURIComponent(JSON)） */
const cardValue = (obj: Record<string, unknown>) =>
  `data:${encodeURIComponent(JSON.stringify(obj))}`;

const imageCard = `<card name="image" value="${cardValue({
  src: "https://cdn.nlark.com/yuque/0/2025/png/123/abc.png",
  name: "架构图.png",
})}"></card>`;
const codeblockCard = `<card name="codeblock" value="${cardValue({
  language: "python",
})}">def hello():\n    print("hi")</card>`;
const hrCard = `<card name="hr" value="${cardValue({})}"></card>`;
const mathCard = `<card name="math" value="${cardValue({ latex: "E = mc^2" })}"></card>`;
const inlineMathCard = `<card name="inlineMath" type="inline" value="${cardValue({
  latex: "a^2+b^2=c^2",
})}"></card>`;
const calloutCard = `<card name="callout" value="${cardValue({
  status: "warning",
  title: "注意",
  html: "<p>这是卡片内容，含<strong>加粗</strong></p>",
})}"></card>`;
const checkboxCard = (checked: boolean) =>
  `<card name="checkbox" type="inline" value="${cardValue({ checked })}"></card>`;
const docLinkCard = `<card name="yuque" value="${cardValue({
  src: "https://www.yuque.com/myrepo/design-spec",
  title: "设计规范",
})}"></card>`;
const localdocCard = `<card name="localdoc" value="${cardValue({
  src: "https://www.yuque.com/attach/xxx.pdf",
  name: "需求文档.pdf",
})}"></card>`;

const oldStyleLake = `<!doctype lake><meta name="doc-version" content="1"/>
<h1>接口设计文档</h1>
<p>本文档描述 <strong>核心接口</strong>，重点看 <em>鉴权</em>、<u>限流</u>、<code>X-Auth-Token</code> 与 <a href="https://www.yuque.com/myrepo/api-guide">接入指南</a>，内联公式 ${inlineMathCard} 保留。</p>
<blockquote><p>引用块内容：所有接口返回 JSON。</p></blockquote>
${imageCard}
${codeblockCard}
${hrCard}
${mathCard}
${calloutCard}
<ul>
  <li>${checkboxCard(true)}已完成事项</li>
  <li>${checkboxCard(false)}待办事项</li>
  <li>普通列表项，包含 ${docLinkCard}</li>
</ul>
<ol><li>第一步</li><li>第二步</li></ol>
<p>附件：${localdocCard}</p>`;

const newStyleLake = `<ne-h2>新版编辑器格式</ne-h2>
<ne-p>正文段落，带 <ne-strong>加粗</ne-strong>、<ne-em>斜体</ne-em>、<ne-strike>删除线</ne-strike>、<ne-code>行内代码</ne-code> 和 <ne-link href="https://example.com">外链</ne-link>。</ne-p>
<ne-callout status="danger">
  <ne-callout-title>危险操作</ne-callout-title>
  <ne-p>该操作<ne-strong>不可逆</ne-strong>，请谨慎执行。</ne-p>
  <ne-p>第二段说明。</ne-p>
</ne-callout>
<ne-codeblock data-lake-language="typescript"><ne-codeblock-language>typescript</ne-codeblock-language><ne-codeblock-content><ne-p>const x: number = 1;</ne-p><ne-p>console.log(x);</ne-p></ne-codeblock-content></ne-codeblock>
<ne-table><ne-table-row><ne-table-cell>列A</ne-table-cell><ne-table-cell>列B</ne-table-cell></ne-table-row><ne-table-row><ne-table-cell>1</ne-table-cell><ne-table-cell>2 | 带竖线</ne-table-cell></ne-table-row></ne-table>
<ne-uli><ne-li>无序列表</ne-li><ne-li data-lake-checked="true">已勾选任务</ne-li></ne-uli>
<ne-quote><ne-p>新版引用块</ne-p></ne-quote>`;

const r1 = lakeToMarkdown(oldStyleLake).markdown;
const r2 = lakeToMarkdown(newStyleLake).markdown;

describe("旧版 Lake（card 卡片）", () => {
  const checks: Array<[string, boolean]> = [
    ["h1 → #", r1.includes("# 接口设计文档")],
    ["strong → **", r1.includes("**核心接口**")],
    ["u → <u>", r1.includes("<u>限流</u>")],
    ["code → 反引号", r1.includes("`X-Auth-Token`")],
    ["图片卡片", r1.includes("![架构图.png](https://cdn.nlark.com")],
    ["代码块语言", r1.includes("```python")],
    ["代码块内容", r1.includes("def hello():")],
    ["hr", r1.includes("\n---\n")],
    ["块公式", r1.includes("$$\nE = mc^2\n$$")],
    ["行内公式", r1.includes("$a^2+b^2=c^2$")],
    ["callout → [!warning]", r1.includes("> [!warning] 注意")],
    ["callout 内容", r1.includes("> 这是卡片内容，含**加粗**")],
    ["任务清单已勾选", r1.includes("- [x] 已完成事项")],
    ["任务清单未勾选", r1.includes("- [ ] 待办事项")],
    [
      "文档链接卡片",
      r1.includes("[设计规范](https://www.yuque.com/myrepo/design-spec)"),
    ],
    ["有序列表", r1.includes("1. 第一步")],
    ["附件卡片", r1.includes("[需求文档.pdf](https://www.yuque.com/attach/xxx.pdf)")],
    ["引用块", r1.includes("> 引用块内容：所有接口返回 JSON")],
  ];

  for (const [name, ok] of checks) {
    it(name, () => expect(ok).toBe(true));
  }
});

describe("新版 Lake（ne-* 标签）", () => {
  const checks: Array<[string, boolean]> = [
    ["ne-h2 → ##", r2.includes("## 新版编辑器格式")],
    [
      "行内样式",
      r2.includes("**加粗**") && r2.includes("*斜体*") && r2.includes("~~删除线~~"),
    ],
    ["ne-link", r2.includes("[外链](https://example.com)")],
    ["ne-callout → [!danger]", r2.includes("> [!danger] 危险操作")],
    ["callout 内容加粗", r2.includes("> 该操作**不可逆**")],
    ["ne-codeblock 语言", r2.includes("```typescript")],
    ["ne-codeblock 内容", r2.includes("const x: number = 1;")],
    ["表格表头", r2.includes("| 列A | 列B |")],
    ["表格竖线转义", r2.includes("2 \\| 带竖线")],
    ["ne-uli", r2.includes("- 无序列表")],
    ["data-lake-checked", r2.includes("- [x] 已勾选任务")],
    ["ne-quote", r2.includes("> 新版引用块")],
  ];

  for (const [name, ok] of checks) {
    it(name, () => expect(ok).toBe(true));
  }
});

describe("isLakeBody", () => {
  it("旧版 doctype lake 判定为 Lake", () => {
    expect(isLakeBody("<!doctype lake><p>x</p>")).toBe(true);
  });

  it("含 ne-* 标签判定为 Lake", () => {
    expect(isLakeBody("<ne-p>正文</ne-p>")).toBe(true);
  });

  it("纯 Markdown 不判定为 Lake", () => {
    expect(isLakeBody("# 标题\n\n- 列表项\n")).toBe(false);
  });

  it("空值不判定为 Lake", () => {
    expect(isLakeBody("")).toBe(false);
  });
});

describe("cleanMarkdownBody", () => {
  it("清除默认颜色的 font 标签并保留内部文本", () => {
    const { markdown } = cleanMarkdownBody(
      '<font color="rgb(0,0,0)">文本生成</font>',
    );
    expect(markdown).not.toMatch(/<font/i);
    expect(markdown).toContain("文本生成");
  });

  // 注意：此处颜色取自 style 属性（color:xxx）。
  // HTML 属性形式 <font color="red"> 目前匹配不到、会丢失颜色，属已知缺口，留待「最小转义」处理。
  it("非默认颜色的 font 转为 span", () => {
    const { markdown } = cleanMarkdownBody('<font style="color:red">告警</font>');
    expect(markdown).toContain('<span style="color:red">告警</span>');
  });

  it("br 转为换行", () => {
    const { markdown } = cleanMarkdownBody("第一行<br>第二行");
    expect(markdown).toBe("第一行\n第二行\n");
  });

  // 语雀默认正文色 #4D4D4D / 标题色 #4F4F4F 不是纯黑，曾经被判成「用户选过的颜色」，
  // 于是整篇文档被逐段包上 span（实测 390+ 篇中招）
  it("语雀默认正文色 #4D4D4D 也解包", () => {
    const { markdown } = cleanMarkdownBody('<font style="color:rgb(77, 77, 77)">正文</font>');
    expect(markdown).toBe("正文\n");
  });

  it("语雀默认标题色 #4F4F4F 同样解包", () => {
    const { markdown } = cleanMarkdownBody('<font style="color:rgb(79, 79, 79)">标题</font>');
    expect(markdown).toBe("标题\n");
  });

  // 实时预览不渲染内联 HTML，所以「保留颜色」在编辑模式下会露出源码；
  // 默认的口径是 drop，只有用户显式选择才输出 span
  it("真正选过的颜色按 colorMode 落盘：drop / highlight / keep", () => {
    const raw = '<font style="color:rgb(255, 0, 0)">告警</font>';
    expect(cleanMarkdownBody(raw, "drop").markdown).toBe("告警\n");
    expect(cleanMarkdownBody(raw, "highlight").markdown).toBe("==告警==\n");
    expect(cleanMarkdownBody(raw, "keep").markdown).toBe(
      '<span style="color:rgb(255, 0, 0)">告警</span>\n',
    );
  });
});

describe("Lake 文字颜色（colorMode）", () => {
  const lake = '<ne-p><span style="color:rgb(255, 0, 0)">红</span></ne-p>';

  it("drop：不输出 span，文字留下", () => {
    const { markdown } = lakeToMarkdown(lake, "drop");
    expect(markdown).not.toContain("<span");
    expect(markdown).toContain("红");
  });

  it("keep：输出 span（阅读模式可渲染）", () => {
    expect(lakeToMarkdown(lake, "keep").markdown).toContain(
      '<span style="color:rgb(255, 0, 0)">红</span>',
    );
  });

  it("highlight：转成 ==高亮==，两种模式都渲染", () => {
    expect(lakeToMarkdown(lake, "highlight").markdown).toContain("==红==");
  });

  it("背景色一律转高亮（与 colorMode 无关）", () => {
    const hl = '<ne-p><span style="background-color:rgb(255, 245, 204)">重点</span></ne-p>';
    expect(lakeToMarkdown(hl, "drop").markdown).toContain("==重点==");
    expect(lakeToMarkdown(hl, "keep").markdown).toContain("==重点==");
  });
});

describe("stripDefaultColorSpans（本地清理已同步文档里的默认色包裹）", () => {
  const gray = (t: string) => `<span style="color:rgb(77, 77, 77)">${t}</span>`;

  it("解掉默认色 span，保留文本", () => {
    const r = stripDefaultColorSpans(`${gray("在")}别的`);
    expect(r.markdown).toBe("在别的");
    expect(r.removed).toBe(1);
  });

  it("真正选过的颜色不动", () => {
    const blue = '<span style="color:rgb(78, 161, 219)">Linux</span>';
    const r = stripDefaultColorSpans(`前缀${blue}`);
    expect(r.markdown).toBe(`前缀${blue}`);
    expect(r.removed).toBe(0);
  });

  it("背景色 span 不动（==高亮== 靠它）", () => {
    const hl = '<span style="background-color:rgb(255, 245, 204)">重点</span>';
    expect(stripDefaultColorSpans(hl).markdown).toBe(hl);
  });

  it("嵌套：解掉外层默认色，不把后段文字并进彩色 span（那会把颜色改错）", () => {
    const r = stripDefaultColorSpans(
      `${gray(`前<span style="color:rgb(78, 161, 219)">蓝</span>后`)}`,
    );
    expect(r.markdown).toBe('前<span style="color:rgb(78, 161, 219)">蓝</span>后');
    expect(r.removed).toBe(1);
  });

  it("逐层解包：默认色套默认色", () => {
    const r = stripDefaultColorSpans(gray(`A${gray("B")}`));
    expect(r.markdown).toBe("AB");
    expect(r.removed).toBe(2);
  });

  it("跨行 span 也能解（整段被包起来是常态）", () => {
    const r = stripDefaultColorSpans(`${gray("第一行\n第二行\n")}第三行`);
    expect(r.markdown).toBe("第一行\n第二行\n第三行");
  });

  it("没有可解的 → 原样返回（幂等，调用方据此跳过写入）", () => {
    const r = stripDefaultColorSpans("普通正文\n");
    expect(r.markdown).toBe("普通正文\n");
    expect(r.removed).toBe(0);
  });

  it("别人的 span（无 style / 非本插件格式）一律不碰", () => {
    const raw = '<span class="x">A</span><span style="color:var(--text-muted)">B</span>';
    expect(stripDefaultColorSpans(raw).markdown).toBe(raw);
  });

  it("defaultOnly=false：连真正选过的颜色一起解掉（配合「文字颜色=不输出」）", () => {
    const blue = '<span style="color:rgb(78, 161, 219)">Linux</span>';
    expect(stripColorSpans(blue, { defaultOnly: false }).markdown).toBe("Linux");
  });

  it("defaultOnly=false 也不动背景色（高亮靠它）", () => {
    const hl = '<span style="background-color:rgb(255, 245, 204)">重点</span>';
    expect(stripColorSpans(hl, { defaultOnly: false }).markdown).toBe(hl);
  });
});

describe("convertYuqueBody 双通道", () => {
  it("Lake 内容走 Lake 通道", () => {
    const { markdown } = convertYuqueBody("<ne-h1>标题</ne-h1>");
    expect(markdown).toContain("# 标题");
  });

  it("非 Lake 内容走 Markdown 清洗通道", () => {
    const { markdown } = convertYuqueBody("# 标题\n\n<font>x</font>\n");
    expect(markdown).toContain("# 标题");
    expect(markdown).not.toMatch(/<font/i);
  });

  it("空内容返回空串且无告警", () => {
    const r = convertYuqueBody("   ");
    expect(r.markdown).toBe("");
    expect(r.warnings).toEqual([]);
  });
});
