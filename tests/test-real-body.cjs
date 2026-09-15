/* 用真实语雀原始 body 验证双通道转换 */
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!DOCTYPE html><body></body>");
global.DOMParser = dom.window.DOMParser;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
const { convertYuqueBody, isLakeBody } = require("./test-lake.cjs");
const fs = require("fs");

const body = fs.readFileSync(
  "C:/Users/86150/.qwenworkcn/workspace/mtrejfx8f8f3hm5g/yuque-body-raw.html",
  "utf8",
);
console.log("isLakeBody:", isLakeBody(body));
const r = convertYuqueBody(body);
console.log("--- 输出前 1200 字 ---");
console.log(r.markdown.slice(0, 1200));

const checks = [
  ["无残留 font 标签", (r.markdown.match(/<font/g) || []).length === 0],
  ["## 导语 标题完整", r.markdown.includes("## 导语")],
  ["表格表头完整", /\| 组件 \| 角色定位 \| 关键职责 \|/.test(r.markdown)],
  ["表格分隔行完整", /\| --- \| --- \| --- \|/.test(r.markdown)],
  ["加粗完整", r.markdown.includes("**文本生成**")],
  ["有序列表完整", /^1\. \*\*文本生成\*\*/m.test(r.markdown)],
];
let fail = 0;
for (const [name, ok] of checks) {
  console.log((ok ? "✓" : "✗ FAIL") + " " + name);
  if (!ok) fail++;
}
fs.writeFileSync(
  "C:/Users/86150/.qwenworkcn/workspace/mtrejfx8f8f3hm5g/converted-sample.md",
  r.markdown,
);
console.log(fail ? `${fail} 项失败` : "全部通过");
process.exit(fail ? 1 : 0);
