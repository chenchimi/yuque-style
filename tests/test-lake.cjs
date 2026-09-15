"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/yuque/lake.ts
var lake_exports = {};
__export(lake_exports, {
  cleanMarkdownBody: () => cleanMarkdownBody,
  convertYuqueBody: () => convertYuqueBody,
  decodeCardValue: () => decodeCardValue,
  isLakeBody: () => isLakeBody,
  lakeToMarkdown: () => lakeToMarkdown
});
module.exports = __toCommonJS(lake_exports);
var CALLOUT_STATUS_MAP = {
  default: "note",
  info: "note",
  success: "tip",
  warning: "warning",
  danger: "danger",
  error: "danger"
};
var BLOCK_CARD_NAMES = /* @__PURE__ */ new Set([
  "image",
  "codeblock",
  "hr",
  "math",
  "callout",
  "table",
  "lakesheet",
  "laketable",
  "lakeboard",
  "board",
  "video",
  "taskList"
]);
function decodeCardValue(el) {
  const v = el.getAttribute("value");
  if (!v) return null;
  let encoded = v;
  if (encoded.startsWith("data:")) encoded = encoded.slice(5);
  try {
    return JSON.parse(decodeURIComponent(encoded));
  } catch {
    try {
      return JSON.parse(encoded);
    } catch {
      return null;
    }
  }
}
function escapeMdText(text) {
  return text.replace(/\u00a0/g, " ");
}
function escapeTableCell(text) {
  return text.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}
var LakeConverter = class _LakeConverter {
  constructor() {
    this.warnings = /* @__PURE__ */ new Set();
    this.parser = new DOMParser();
  }
  convert(lake) {
    let src = lake.replace(/\x00/g, "");
    src = src.replace(/<!doctype[^>]*>/gi, "");
    src = src.replace(/<meta[^>]*>/gi, "");
    const doc = this.parser.parseFromString(`<body>${src}</body>`, "text/html");
    const blocks = this.convertBlocks(Array.from(doc.body.childNodes), 0);
    let md = blocks.join("\n\n");
    md = md.replace(/\n{3,}/g, "\n\n").trim() + "\n";
    return { markdown: md, warnings: Array.from(this.warnings) };
  }
  // ---------- 块级 ----------
  convertBlocks(nodes, baseIndent) {
    const out = [];
    for (const node of Array.from(nodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = escapeMdText(node.textContent || "").trim();
        if (t) out.push(t);
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const block = this.convertElement(node, baseIndent);
      if (block && block.trim()) out.push(block);
    }
    return out;
  }
  convertElement(el, baseIndent) {
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
      case "ne-h1":
      case "ne-h2":
      case "ne-h3":
      case "ne-h4":
      case "ne-h5":
      case "ne-h6": {
        const level = Number(tag.replace(/\D/g, ""));
        return `${"#".repeat(level)} ${this.convertInline(el)}`;
      }
      case "p":
      case "ne-p": {
        const text = this.convertInline(el);
        if (!text.trim()) return null;
        return text;
      }
      case "blockquote":
      case "ne-quote": {
        const blocks = this.convertBlocks(el.childNodes, 0);
        if (blocks.length === 0) return null;
        return blocks.join("\n\n").split("\n").map((l) => `> ${l}`.trimEnd()).join("\n");
      }
      case "ul":
      case "ol":
      case "ne-uli":
      case "ne-oli":
        return this.convertList(el, tag === "ol" || tag === "ne-oli", 1);
      case "li":
      case "ne-li":
        return this.convertListItems([el], false, 1).join("\n");
      case "pre": {
        const code = el.textContent ?? "";
        const lang = this.detectCodeLanguage(el);
        return this.fenceCode(code, lang);
      }
      case "ne-codeblock":
        return this.convertNeCodeblock(el);
      case "table":
      case "ne-table":
        return this.convertTable(el);
      case "hr":
      case "ne-hr":
        return "---";
      case "ne-callout":
        return this.convertNeCallout(el);
      case "card":
        return this.convertCard(el, baseIndent);
      case "div":
      case "section":
      case "span":
      case "ne-span":
      case "ne-paragraph":
        return this.convertBlocks(el.childNodes, baseIndent).join("\n\n") || null;
      case "img": {
        const src = el.getAttribute("src") || "";
        if (src) return `![${el.getAttribute("alt") || ""}](${src})`;
        return null;
      }
      default: {
        const inner = this.convertBlocks(el.childNodes, baseIndent).join("\n\n");
        if (inner.trim()) return inner;
        if (tag.startsWith("ne-")) {
          this.warnings.add(`\u672A\u652F\u6301\u7684\u8BED\u96C0\u5757\uFF1A${tag}`);
          return null;
        }
        return null;
      }
    }
  }
  convertList(listEl, ordered, level) {
    const items = Array.from(listEl.children).filter(
      (c) => c.tagName.toLowerCase() === "li" || c.tagName.toLowerCase() === "ne-li"
    );
    if (items.length === 0) {
      const blocks = this.convertBlocks(listEl.childNodes, 0);
      return blocks.join("\n");
    }
    return this.convertListItems(items, ordered, level).join("\n");
  }
  convertListItems(items, ordered, level) {
    const lines = [];
    let index = 1;
    for (const li of items) {
      const indent = "  ".repeat(Math.max(0, level - 1));
      const checkCard = li.querySelector('card[name="checkbox"]');
      const checkedAttr = li.getAttribute("data-lake-checked");
      let marker;
      if (checkCard) {
        const v = decodeCardValue(checkCard) || {};
        const checked = v.checked === true || v.checked === "true";
        marker = `- [${checked ? "x" : " "}] `;
        if (checkCard.parentNode) checkCard.parentNode.removeChild(checkCard);
      } else if (checkedAttr !== null) {
        marker = `- [${checkedAttr === "true" ? "x" : " "}] `;
      } else {
        marker = ordered ? `${index++}. ` : "- ";
      }
      const hasBlockChild = Array.from(li.children).some((c) => {
        const t = c.tagName.toLowerCase();
        if (t === "card") {
          if (c.getAttribute("type") === "inline") return false;
          const name = c.getAttribute("name") || "";
          return BLOCK_CARD_NAMES.has(name);
        }
        return /^(p|ne-p|ul|ol|ne-uli|ne-oli|blockquote|ne-quote|table|ne-table|h[1-6]|ne-h[1-6]|pre|ne-codeblock)$/.test(t);
      });
      if (!hasBlockChild) {
        const text = this.convertInline(li).replace(/\s+/g, " ").trim();
        if (text) lines.push(`${indent}${marker}${text}`);
        continue;
      }
      const blocks = this.convertBlocks(li.childNodes, 0);
      if (blocks.length === 0) continue;
      const first = blocks.shift();
      lines.push(`${indent}${marker}${first.replace(/\n+/g, " ")}`);
      for (const rest of blocks) {
        lines.push(
          rest.split("\n").map((l) => `${indent}  ${l}`.trimEnd()).join("\n")
        );
      }
    }
    return lines;
  }
  detectCodeLanguage(el) {
    const cls = el.getAttribute("class") || "";
    const m = cls.match(/language-([\w+#-]+)/);
    if (m) return m[1];
    return "";
  }
  fenceCode(code, lang) {
    const backticks = "```";
    const clean = code.replace(/\n+$/, "");
    if (clean.includes(backticks)) return `${backticks}${lang}
${clean}
${backticks}`;
    return `${backticks}${lang}
${clean}
${backticks}`;
  }
  /** 新版 ne-codeblock：<ne-codeblock><ne-codeblock-language>py</ne-codeblock-language><ne-codeblock-content>...</ne-codeblock-content></ne-codeblock> */
  convertNeCodeblock(el) {
    let lang = el.getAttribute("data-lake-language") || "";
    const langEl = el.querySelector("ne-codeblock-language");
    if (!lang && langEl) lang = (langEl.textContent || "").trim();
    let code = "";
    const contentEl = el.querySelector("ne-codeblock-content");
    if (contentEl) {
      code = Array.from(contentEl.querySelectorAll("p, ne-p, div")).map((p) => p.textContent ?? "").join("\n");
      if (!code) code = contentEl.textContent ?? "";
    } else {
      const clone = el.cloneNode(true);
      clone.querySelectorAll("ne-codeblock-language").forEach((n) => n.remove());
      code = clone.textContent ?? "";
    }
    if (lang) lang = lang.replace(/^lang-/, "");
    return this.fenceCode(code, lang);
  }
  convertNeCallout(el) {
    const status = (el.getAttribute("status") || "info").toLowerCase();
    const type = CALLOUT_STATUS_MAP[status] || "note";
    const titleEl = el.querySelector("ne-callout-title, ne-callout-head");
    let title = "";
    let contentEl = el;
    if (titleEl) {
      title = this.convertInline(titleEl).trim();
      const contentWrap = el.querySelector("ne-callout-content");
      contentEl = contentWrap || el;
    }
    const blocks = [];
    for (const child of Array.from(contentEl.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === "ne-callout-title" || tag === "ne-callout-head") continue;
      const b = this.convertElement(child, 0);
      if (b && b.trim()) blocks.push(b);
    }
    if (blocks.length === 0) {
      const text = escapeMdText(contentEl.textContent || "").trim();
      if (text) blocks.push(text);
    }
    const head = `> [!${type}]${title ? ` ${title}` : ""}`;
    const body = blocks.join("\n\n").split("\n").map((l) => `> ${l}`.trimEnd()).join("\n");
    return `${head}
${body}`;
  }
  convertTable(el) {
    const rows = [];
    const rowEls = Array.from(el.querySelectorAll("tr, ne-table-row"));
    const seen = /* @__PURE__ */ new Set();
    for (const row of rowEls) {
      if (seen.has(row)) continue;
      seen.add(row);
      const cellEls = Array.from(
        row.querySelectorAll(":scope > td, :scope > th, :scope > ne-table-cell")
      );
      const header = rowEls.indexOf(row) === 0;
      rows.push({
        cells: cellEls.map((c) => escapeTableCell(this.convertInline(c).trim())),
        header
      });
    }
    if (rows.length === 0) {
      this.warnings.add("\u8868\u683C\u8F6C\u6362\u5931\u8D25\uFF08\u672A\u627E\u5230\u884C\uFF09");
      return null;
    }
    const width = Math.max(...rows.map((r) => r.cells.length));
    const norm = rows.map((r) => {
      const cells = [...r.cells];
      while (cells.length < width) cells.push("");
      return cells;
    });
    const lines = [];
    lines.push(`| ${norm[0].join(" | ")} |`);
    lines.push(`| ${Array(width).fill("---").join(" | ")} |`);
    for (const r of norm.slice(1)) lines.push(`| ${r.join(" | ")} |`);
    return lines.join("\n");
  }
  // ---------- 卡片（<card name="..." value="data:...">） ----------
  convertCard(el, baseIndent) {
    const name = el.getAttribute("name") || "";
    const isInline = el.getAttribute("type") === "inline";
    const value = decodeCardValue(el) || {};
    switch (name) {
      case "image": {
        const src = value.src || value.url || "";
        if (!src) {
          this.warnings.add("\u56FE\u7247\u5361\u7247\u7F3A\u5C11 src");
          return null;
        }
        const alt = (value.name || value.alt || "").replace(/[\r\n]/g, " ");
        return `![${alt}](${src})`;
      }
      case "localdoc":
      case "file": {
        const src = value.src || value.url || "";
        const fname = value.name || "\u9644\u4EF6";
        return src ? `[${fname}](${src})` : `[${fname}]`;
      }
      case "bookmarklink": {
        const url = value.url || value.href || "";
        const title = value.title || value.url || "\u94FE\u63A5";
        return `[${title}](${url})`;
      }
      case "yuque":
      case "yuqueinline": {
        const url = value.src || value.url || "";
        const title = value.title || value.name || url;
        return url ? `[${title}](${url})` : null;
      }
      case "hr":
        return "---";
      case "codeblock": {
        let code = value.code ?? "";
        if (!code) {
          code = Array.from(el.querySelectorAll("p, ne-p, div")).map((p) => p.textContent ?? "").join("\n");
          if (!code) code = el.textContent ?? "";
        }
        const lang = (value.language || value.code_lang || "").replace(/^lang-/, "");
        return this.fenceCode(code, lang);
      }
      case "math":
      case "inlineMath": {
        const latex = value.latex ?? value.code ?? value.tex ?? el.textContent ?? "";
        const clean = String(latex).trim();
        if (!clean) return null;
        return isInline || name === "inlineMath" ? `$${clean}$` : `$$
${clean}
$$`;
      }
      case "callout": {
        const status = String(value.status || "info").toLowerCase();
        const type = CALLOUT_STATUS_MAP[status] || "note";
        const title = String(value.title || "").trim();
        const blocks = [];
        const html = value.html || value.content || value.contents;
        if (typeof html === "string" && html) {
          const sub = new _LakeConverter().convert(html);
          for (const w of sub.warnings) this.warnings.add(w);
          blocks.push(sub.markdown.trim());
        } else if (Array.isArray(html)) {
          for (const part of html) {
            const sub = new _LakeConverter().convert(String(part));
            blocks.push(sub.markdown.trim());
          }
        } else {
          const inner = this.convertBlocks(el.childNodes, 0).join("\n\n");
          if (inner.trim()) blocks.push(inner);
        }
        const head = `> [!${type}]${title ? ` ${title}` : ""}`;
        const body = blocks.join("\n\n").split("\n").map((l) => `> ${l}`.trimEnd()).join("\n");
        return `${head}
${body}`;
      }
      case "checkbox": {
        const checked = value.checked === true || value.checked === "true";
        return `- [${checked ? "x" : " "}] `;
      }
      case "taskList": {
        const html = value.html || value.content;
        if (typeof html === "string" && html) {
          return new _LakeConverter().convert(html).markdown.trim();
        }
        if (Array.isArray(value.items)) {
          return value.items.map((it) => `- [${it.checked ? "x" : " "}] ${it.title || ""}`).join("\n");
        }
        return null;
      }
      case "table":
      case "lakesheet": {
        const html = value.html || value.content;
        if (typeof html === "string" && /<t[dhr]|<table/i.test(html)) {
          const sub = new _LakeConverter().convert(html).markdown.trim();
          if (sub) return sub;
        }
        this.warnings.add("\u8868\u683C\uFF08lakesheet\uFF09\u6682\u65E0\u6CD5\u5B8C\u6574\u8FD8\u539F\uFF0C\u5DF2\u4FDD\u7559\u8BED\u96C0\u94FE\u63A5\u5360\u4F4D");
        return `> [!warning] \u8868\u683C
> \u6B64\u5904\u4E3A\u8BED\u96C0\u9AD8\u7EA7\u8868\u683C\uFF0C\u8BF7\u5728\u8BED\u96C0\u4E2D\u67E5\u770B\u3002`;
      }
      case "laketable": {
        this.warnings.add("\u6570\u636E\u8868\uFF08laketable\uFF09\u4EC5\u8BB0\u5F55\u5360\u4F4D");
        return `> [!warning] \u6570\u636E\u8868
> \u6B64\u5904\u4E3A\u8BED\u96C0\u6570\u636E\u8868\uFF0C\u8BF7\u5728\u8BED\u96C0\u4E2D\u67E5\u770B\u3002`;
      }
      case "lakeboard":
      case "board": {
        this.warnings.add("\u753B\u677F\uFF08lakeboard\uFF09\u4EC5\u8BB0\u5F55\u5360\u4F4D");
        return `> [!warning] \u753B\u677F
> \u6B64\u5904\u4E3A\u8BED\u96C0\u753B\u677F/\u601D\u7EF4\u5BFC\u56FE\uFF0C\u8BF7\u5728\u8BED\u96C0\u4E2D\u67E5\u770B\u3002`;
      }
      case "video": {
        const url = value.src || value.url || "";
        return url ? `[\u{1F4F9} \u89C6\u9891](${url})` : `> [!warning] \u89C6\u9891
> \u8BED\u96C0\u89C6\u9891\uFF0C\u8BF7\u5728\u8BED\u96C0\u4E2D\u67E5\u770B\u3002`;
      }
      case "mention": {
        const who = value.name || value.login || "";
        return who ? `@${who}` : null;
      }
      case "br":
        return "\n";
      default: {
        const text = escapeMdText(el.textContent || "").trim();
        if (text) return text;
        this.warnings.add(`\u672A\u652F\u6301\u7684\u8BED\u96C0\u5361\u7247\uFF1A${name}`);
        return `> [!warning] \u672A\u652F\u6301\u5185\u5BB9
> \u8BED\u96C0\u5361\u7247\u300C${name}\u300D\u6682\u4E0D\u652F\u6301\u5728\u6B64\u5C55\u793A\uFF0C\u8BF7\u5728\u8BED\u96C0\u4E2D\u67E5\u770B\u3002`;
      }
    }
  }
  // ---------- 行内 ----------
  convertInline(el) {
    let out = "";
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        out += escapeMdText(node.textContent || "");
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const child = node;
      const tag = child.tagName.toLowerCase();
      switch (tag) {
        case "strong":
        case "b":
        case "ne-strong":
          out += `**${this.convertInline(child).trim() || ""}**`;
          break;
        case "em":
        case "i":
        case "ne-em":
          out += `*${this.convertInline(child).trim() || ""}*`;
          break;
        case "u":
        case "ne-u":
          out += `<u>${this.convertInline(child)}</u>`;
          break;
        case "s":
        case "del":
        case "strike":
        case "ne-strike":
          out += `~~${this.convertInline(child).trim() || ""}~~`;
          break;
        case "code":
        case "ne-code": {
          const text = child.textContent || "";
          out += text.includes("`") ? `\`\`${text}\`\`` : `\`${text}\``;
          break;
        }
        case "a":
        case "ne-link": {
          const href = child.getAttribute("href") || "";
          const text = this.convertInline(child).trim() || href;
          out += href ? `[${text}](${href})` : text;
          break;
        }
        case "br":
          out += "\n";
          break;
        case "mark":
          out += `==${this.convertInline(child)}==`;
          break;
        case "span":
        case "ne-span":
        case "div":
        case "font": {
          const style = (child.getAttribute("style") || "").toLowerCase();
          if (style.includes("background-color") || style.includes("background:")) {
            out += `==${this.convertInline(child)}==`;
          } else {
            out += this.convertInline(child);
          }
          break;
        }
        case "card": {
          const md = this.convertCard(child, 0);
          out += md || "";
          break;
        }
        case "ne-image":
        case "img": {
          const card = child.querySelector("card[name='image']");
          if (card) {
            out += this.convertCard(card, 0) || "";
          } else {
            const src = child.getAttribute("src") || "";
            out += src ? `![](${src})` : this.convertInline(child);
          }
          break;
        }
        default:
          out += this.convertInline(child);
      }
    }
    return out;
  }
};
function lakeToMarkdown(lake) {
  if (!lake || !lake.trim()) return { markdown: "", warnings: [] };
  return new LakeConverter().convert(lake);
}
function isLakeBody(body) {
  if (!body) return false;
  if (/^\s*<!doctype\s+lake/i.test(body)) return true;
  if (/<card[\s>]/i.test(body)) return true;
  if (/<ne-[a-z]/i.test(body)) return true;
  if (/<(p|div|h[1-6]|table|ul|ol|blockquote)[\s>]/i.test(body)) {
    const mdChars = "#>*-.|`";
    return !body.split("\n").some((line) => {
      const t = line.trimStart();
      return t === "" || mdChars.includes(t[0]) || /^\d+\.\s/.test(t);
    });
  }
  return false;
}
function isDefaultColor(style) {
  return /rgb\(\s*0\s*,\s*0\s*,\s*0\s*\)/i.test(style) || !/color/i.test(style);
}
function cleanMarkdownBody(md) {
  const warnings = [];
  let out = md;
  for (let i = 0; i < 5; i++) {
    const next = out.replace(
      /<font([^>]*)>([\s\S]*?)<\/font>/gi,
      (_m, attrs, inner) => {
        if (isDefaultColor(attrs)) return inner;
        const colorMatch = attrs.match(/color:\s*([^;"']+)/i);
        const color = colorMatch ? colorMatch[1].trim() : "";
        return color ? `<span style="color:${color}">${inner}</span>` : inner;
      }
    );
    if (next === out) break;
    out = next;
  }
  out = out.replace(/<font[^>]*>/gi, "").replace(/<\/font>/gi, "");
  out = out.replace(/<br\s*\/?>/gi, "\n");
  out = out.replace(/\n{3,}/g, "\n\n").trim() + "\n";
  return { markdown: out, warnings };
}
function convertYuqueBody(body) {
  if (!body || !body.trim()) return { markdown: "", warnings: [] };
  return isLakeBody(body) ? lakeToMarkdown(body) : cleanMarkdownBody(body);
}
