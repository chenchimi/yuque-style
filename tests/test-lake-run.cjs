/* Lake → Markdown 离线单测：模拟典型语雀 Lake 内容（旧版 card + 新版 ne-* 两代格式） */
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!DOCTYPE html><body></body>");
global.DOMParser = dom.window.DOMParser;
global.Node = dom.window.Node;
global.Element = dom.window.Element;

const { lakeToMarkdown } = require("./test-lake.cjs");

// 工具：构造 card value（data: + encodeURIComponent(JSON)）
const cardValue = (obj) => `data:${encodeURIComponent(JSON.stringify(obj))}`;

const imageCard = `<card name="image" value="${cardValue({ src: "https://cdn.nlark.com/yuque/0/2025/png/123/abc.png", name: "架构图.png" })}"></card>`;
const codeblockCard = `<card name="codeblock" value="${cardValue({ language: "python" })}">def hello():\n    print("hi")</card>`;
const hrCard = `<card name="hr" value="${cardValue({})}"></card>`;
const mathCard = `<card name="math" value="${cardValue({ latex: "E = mc^2" })}"></card>`;
const inlineMathCard = `<card name="inlineMath" type="inline" value="${cardValue({ latex: "a^2+b^2=c^2" })}"></card>`;
const calloutCard = `<card name="callout" value="${cardValue({ status: "warning", title: "注意", html: "<p>这是卡片内容，含<strong>加粗</strong></p>" })}"></card>`;
const checkboxCard = (checked) =>
  `<card name="checkbox" type="inline" value="${cardValue({ checked })}"></card>`;
const docLinkCard = `<card name="yuque" value="${cardValue({ src: "https://www.yuque.com/myrepo/design-spec", title: "设计规范" })}"></card>`;
const localdocCard = `<card name="localdoc" value="${cardValue({ src: "https://www.yuque.com/attach/xxx.pdf", name: "需求文档.pdf" })}"></card>`;

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

function show(title, lake) {
  const r = lakeToMarkdown(lake);
  console.log(`\n===== ${title} =====`);
  console.log(r.markdown);
  if (r.warnings.length) console.log("⚠ warnings:", r.warnings);
}

show("旧版 Lake（card 卡片）", oldStyleLake);
show("新版 Lake（ne-* 标签）", newStyleLake);

// 断言检查
const r1 = lakeToMarkdown(oldStyleLake).markdown;
const r2 = lakeToMarkdown(newStyleLake).markdown;
const checks = [
  [r1.includes("# 接口设计文档"), "旧版: h1 → #"],
  [r1.includes("**核心接口**"), "旧版: strong → **"],
  [r1.includes("<u>限流</u>"), "旧版: u → <u>"],
  [r1.includes("`X-Auth-Token`"), "旧版: code → 反引号"],
  [r1.includes("![架构图.png](https://cdn.nlark.com"), "旧版: 图片卡片"],
  [r1.includes("```python"), "旧版: 代码块语言"],
  [r1.includes("def hello():"), "旧版: 代码块内容"],
  [r1.includes("\n---\n"), "旧版: hr"],
  [r1.includes("$$\nE = mc^2\n$$"), "旧版: 块公式"],
  [r1.includes("$a^2+b^2=c^2$"), "旧版: 行内公式"],
  [r1.includes("> [!warning] 注意"), "旧版: callout → [!warning]"],
  [r1.includes("> 这是卡片内容，含**加粗**"), "旧版: callout 内容"],
  [r1.includes("- [x] 已完成事项"), "旧版: 任务清单已勾选"],
  [r1.includes("- [ ] 待办事项"), "旧版: 任务清单未勾选"],
  [r1.includes("[设计规范](https://www.yuque.com/myrepo/design-spec)"), "旧版: 文档链接卡片"],
  [r1.includes("1. 第一步"), "旧版: 有序列表"],
  [r1.includes("[需求文档.pdf](https://www.yuque.com/attach/xxx.pdf)"), "旧版: 附件卡片"],
  [r1.includes("> 引用块内容：所有接口返回 JSON"), "旧版: 引用块"],

  [r2.includes("## 新版编辑器格式"), "新版: ne-h2 → ##"],
  [r2.includes("**加粗**") && r2.includes("*斜体*") && r2.includes("~~删除线~~"), "新版: 行内样式"],
  [r2.includes("[外链](https://example.com)"), "新版: ne-link"],
  [r2.includes("> [!danger] 危险操作"), "新版: ne-callout → [!danger]"],
  [r2.includes("> 该操作**不可逆**"), "新版: callout 内容加粗"],
  [r2.includes("```typescript"), "新版: ne-codeblock 语言"],
  [r2.includes("const x: number = 1;"), "新版: ne-codeblock 内容"],
  [r2.includes("| 列A | 列B |"), "新版: 表格表头"],
  [r2.includes("2 \\| 带竖线"), "新版: 表格竖线转义"],
  [r2.includes("- 无序列表"), "新版: ne-uli"],
  [r2.includes("- [x] 已勾选任务"), "新版: data-lake-checked"],
  [r2.includes("> 新版引用块"), "新版: ne-quote"],
];

let fail = 0;
for (const [ok, name] of checks) {
  if (!ok) {
    console.error(`✗ FAIL: ${name}`);
    fail++;
  }
}
console.log(`\n${checks.length - fail}/${checks.length} 项通过${fail ? "，" + fail + " 项失败" : ""}`);
process.exit(fail ? 1 : 0);
