/**
 * 语雀 Lake 格式 → Obsidian Markdown 转换器。
 *
 * 语雀 API 返回的 body 是 Lake 格式（HTML 变体），存在两代写法：
 *  - 旧版：标准标签 h1/p/ul/blockquote + `<card name="xxx" value="data:...">` 富媒体卡片
 *  - 新版：ne-* 标签（ne-h1/ne-p/ne-callout/ne-codeblock/ne-table ...）
 *
 * 本转换器两者都兼容，并把语雀特有样式映射为 Obsidian 等价物：
 *  - 标注卡片（callout）→ Obsidian Callout（> [!note] 等）
 *  - 代码块卡片 → 带语言标注的 fenced code block
 *  - 数学公式卡片 → $...$ / $$...$$
 *  - 图片/附件卡片 → ![]() / []() 链接
 *  - 任务清单 → - [ ] / - [x]
 *  - 表格（ne-table / 标准 table）→ 管道表格
 */

export interface LakeConvertResult {
  markdown: string;
  /** 转换过程中无法完整还原的元素（用于提示用户） */
  warnings: string[];
}

const CALLOUT_STATUS_MAP: Record<string, string> = {
  default: "note",
  info: "note",
  success: "tip",
  warning: "warning",
  danger: "danger",
  error: "danger",
};

/** 默认按块级处理的卡片名（其余卡片在行内上下文中按行内处理） */
const BLOCK_CARD_NAMES = new Set([
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
  "taskList",
]);

export function decodeCardValue(el: Element): Record<string, any> | null {
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

/** 把文本中会被 Markdown 语法干扰的字符处理掉 */
function escapeMdText(text: string): string {
  return text.replace(/\u00a0/g, " ");
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

/**
 * 语雀「文字颜色」落成什么：
 * - `drop`（默认）：纯文本。实时预览不渲染内联 HTML，只有不输出 HTML 才能做到两种模式都不见源码
 * - `highlight`：转成 `==文字==`，两种模式都能渲染，代价是颜色信息变成「高亮」
 * - `keep`：保留 `<span style="color:...">`，阅读模式能渲染成颜色，但实时预览会看到源码
 */
export type ColorMode = "drop" | "highlight" | "keep";

class LakeConverter {
  warnings = new Set<string>();

  constructor(private colorMode: ColorMode = "keep") {}

  private parser = new DOMParser();

  convert(lake: string): LakeConvertResult {
    let src = lake.replace(/\x00/g, "");
    src = src.replace(/<!doctype[^>]*>/gi, "");
    src = src.replace(/<meta[^>]*>/gi, "");
    const doc = this.parser.parseFromString(`<body>${src}</body>`, "text/html");
    const blocks = this.convertBlocks(Array.from(doc.body.childNodes), 0);
    let md = blocks.join("\n\n");
    // 多余空行收敛
    md = md.replace(/\n{3,}/g, "\n\n").trim() + "\n";
    return { markdown: md, warnings: Array.from(this.warnings) };
  }

  // ---------- 块级 ----------

  convertBlocks(nodes: ArrayLike<ChildNode> | ChildNode[], baseIndent: number): string[] {
    const out: string[] = [];
    for (const node of Array.from(nodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = escapeMdText(node.textContent || "").trim();
        if (t) out.push(t);
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const block = this.convertElement(node as Element, baseIndent);
      if (block && block.trim()) out.push(block);
    }
    return out;
  }

  private convertElement(el: Element, baseIndent: number): string | null {
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
        // 直接出现的 li（异常结构），按无序列表处理
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
        // 容器类标签：递归展开
        return this.convertBlocks(el.childNodes, baseIndent).join("\n\n") || null;
      case "img": {
        const src = el.getAttribute("src") || "";
        if (src) return `![${el.getAttribute("alt") || ""}](${src})`;
        return null;
      }
      default: {
        // 未知 ne-* 块级标签：尝试当容器展开，取不到内容则告警
        const inner = this.convertBlocks(el.childNodes, baseIndent).join("\n\n");
        if (inner.trim()) return inner;
        if (tag.startsWith("ne-")) {
          this.warnings.add(`未支持的语雀块：${tag}`);
          return null;
        }
        return null;
      }
    }
  }

  private convertList(listEl: Element, ordered: boolean, level: number): string {
    const items = Array.from(listEl.children).filter(
      (c) => c.tagName.toLowerCase() === "li" || c.tagName.toLowerCase() === "ne-li",
    );
    if (items.length === 0) {
      // 有些 lake 输出把 li 直接挂在列表下之外的节点，兜底取全部子节点
      const blocks = this.convertBlocks(listEl.childNodes, 0);
      return blocks.join("\n");
    }
    return this.convertListItems(items, ordered, level).join("\n");
  }

  private convertListItems(items: Element[], ordered: boolean, level: number): string[] {
    const lines: string[] = [];
    let index = 1;
    for (const li of items) {
      const indent = "  ".repeat(Math.max(0, level - 1));
      // 任务清单：li 内含 checkbox 卡片，或 data-lake-checked 属性
      const checkCard = li.querySelector('card[name="checkbox"]');
      const checkedAttr = li.getAttribute("data-lake-checked");
      let marker: string;
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
      // 判断 li 是否含块级子元素（嵌套列表、段落、引用等）
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
        // 纯行内内容：文本 + 行内卡片直接拼在 marker 后
        const text = this.convertInline(li).replace(/\s+/g, " ").trim();
        if (text) lines.push(`${indent}${marker}${text}`);
        continue;
      }
      // li 内容分块：第一块接在 marker 后，后续块整体缩进
      const blocks = this.convertBlocks(li.childNodes, 0);
      if (blocks.length === 0) continue;
      const first = blocks.shift()!;
      lines.push(`${indent}${marker}${first.replace(/\n+/g, " ")}`);
      for (const rest of blocks) {
        lines.push(
          rest
            .split("\n")
            .map((l) => `${indent}  ${l}`.trimEnd())
            .join("\n"),
        );
      }
    }
    return lines;
  }

  private detectCodeLanguage(el: Element): string {
    const cls = el.getAttribute("class") || "";
    const m = cls.match(/language-([\w+#-]+)/);
    if (m) return m[1];
    return "";
  }

  private fenceCode(code: string, lang: string): string {
    const backticks = "```";
    const clean = code.replace(/\n+$/, "");
    if (clean.includes(backticks)) return `${backticks}${lang}\n${clean}\n${backticks}`;
    return `${backticks}${lang}\n${clean}\n${backticks}`;
  }

  /** 新版 ne-codeblock：<ne-codeblock><ne-codeblock-language>py</ne-codeblock-language><ne-codeblock-content>...</ne-codeblock-content></ne-codeblock> */
  private convertNeCodeblock(el: Element): string {
    let lang = el.getAttribute("data-lake-language") || "";
    const langEl = el.querySelector("ne-codeblock-language");
    if (!lang && langEl) lang = (langEl.textContent || "").trim();
    let code = "";
    const contentEl = el.querySelector("ne-codeblock-content");
    if (contentEl) {
      code = Array.from(contentEl.querySelectorAll("p, ne-p, div"))
        .map((p) => p.textContent ?? "")
        .join("\n");
      if (!code) code = contentEl.textContent ?? "";
    } else {
      // 兜底：去掉语言标签后取全文
      const clone = el.cloneNode(true) as Element;
      clone.querySelectorAll("ne-codeblock-language").forEach((n) => n.remove());
      code = clone.textContent ?? "";
    }
    if (lang) lang = lang.replace(/^lang-/, "");
    return this.fenceCode(code, lang);
  }

  private convertNeCallout(el: Element): string {
    const status = (el.getAttribute("status") || "info").toLowerCase();
    const type = CALLOUT_STATUS_MAP[status] || "note";
    const titleEl = el.querySelector("ne-callout-title, ne-callout-head");
    let title = "";
    let contentEl: Element = el;
    if (titleEl) {
      title = this.convertInline(titleEl).trim();
      const contentWrap = el.querySelector("ne-callout-content");
      contentEl = contentWrap || el;
    }
    const blocks: string[] = [];
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
    return `${head}\n${body}`;
  }

  private convertTable(el: Element): string | null {
    const rows: { cells: string[]; header: boolean }[] = [];
    const rowEls = Array.from(el.querySelectorAll("tr, ne-table-row"));
    const seen = new Set<Element>();
    for (const row of rowEls) {
      if (seen.has(row)) continue;
      seen.add(row);
      const cellEls = Array.from(
        row.querySelectorAll(":scope > td, :scope > th, :scope > ne-table-cell"),
      );
      const header = rowEls.indexOf(row) === 0;
      rows.push({
        cells: cellEls.map((c) => escapeTableCell(this.convertInline(c).trim())),
        header,
      });
    }
    if (rows.length === 0) {
      this.warnings.add("表格转换失败（未找到行）");
      return null;
    }
    const width = Math.max(...rows.map((r) => r.cells.length));
    const norm = rows.map((r) => {
      const cells = [...r.cells];
      while (cells.length < width) cells.push("");
      return cells;
    });
    const lines: string[] = [];
    lines.push(`| ${norm[0].join(" | ")} |`);
    lines.push(`| ${Array(width).fill("---").join(" | ")} |`);
    for (const r of norm.slice(1)) lines.push(`| ${r.join(" | ")} |`);
    return lines.join("\n");
  }

  // ---------- 卡片（<card name="..." value="data:...">） ----------

  private convertCard(el: Element, baseIndent: number): string | null {
    const name = el.getAttribute("name") || "";
    const isInline = el.getAttribute("type") === "inline";
    const value = decodeCardValue(el) || {};
    switch (name) {
      case "image": {
        const src = value.src || value.url || "";
        if (!src) {
          this.warnings.add("图片卡片缺少 src");
          return null;
        }
        const alt = (value.name || value.alt || "").replace(/[\r\n]/g, " ");
        return `![${alt}](${src})`;
      }
      case "localdoc":
      case "file": {
        const src = value.src || value.url || "";
        const fname = value.name || "附件";
        return src ? `[${fname}](${src})` : `[${fname}]`;
      }
      case "bookmarklink": {
        const url = value.url || value.href || "";
        const title = value.title || value.url || "链接";
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
          code = Array.from(el.querySelectorAll("p, ne-p, div"))
            .map((p) => p.textContent ?? "")
            .join("\n");
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
        return isInline || name === "inlineMath" ? `$${clean}$` : `$$\n${clean}\n$$`;
      }
      case "callout": {
        const status = String(value.status || "info").toLowerCase();
        const type = CALLOUT_STATUS_MAP[status] || "note";
        const title = String(value.title || "").trim();
        const blocks: string[] = [];
        const html = value.html || value.content || value.contents;
        if (typeof html === "string" && html) {
          const sub = new LakeConverter().convert(html);
          for (const w of sub.warnings) this.warnings.add(w);
          blocks.push(sub.markdown.trim());
        } else if (Array.isArray(html)) {
          for (const part of html) {
            const sub = new LakeConverter().convert(String(part));
            blocks.push(sub.markdown.trim());
          }
        } else {
          const inner = this.convertBlocks(el.childNodes, 0).join("\n\n");
          if (inner.trim()) blocks.push(inner);
        }
        const head = `> [!${type}]${title ? ` ${title}` : ""}`;
        const body = blocks
          .join("\n\n")
          .split("\n")
          .map((l) => `> ${l}`.trimEnd())
          .join("\n");
        return `${head}\n${body}`;
      }
      case "checkbox": {
        // 行内复选框（正常应出现在 li 内，被 convertListItems 提前处理；这里是兜底）
        const checked = value.checked === true || value.checked === "true";
        return `- [${checked ? "x" : " "}] `;
      }
      case "taskList": {
        // 任务清单卡片：value 内通常带 items/html
        const html = value.html || value.content;
        if (typeof html === "string" && html) {
          return new LakeConverter().convert(html).markdown.trim();
        }
        if (Array.isArray(value.items)) {
          return value.items
            .map((it: any) => `- [${it.checked ? "x" : " "}] ${it.title || ""}`)
            .join("\n");
        }
        return null;
      }
      case "table":
      case "lakesheet": {
        // 语雀表格卡片：新版是压缩数据，旧版可能带 html
        const html = value.html || value.content;
        if (typeof html === "string" && /<t[dhr]|<table/i.test(html)) {
          const sub = new LakeConverter().convert(html).markdown.trim();
          if (sub) return sub;
        }
        this.warnings.add("表格（lakesheet）暂无法完整还原，已保留语雀链接占位");
        return `> [!warning] 表格\n> 此处为语雀高级表格，请在语雀中查看。`;
      }
      case "laketable": {
        this.warnings.add("数据表（laketable）仅记录占位");
        return `> [!warning] 数据表\n> 此处为语雀数据表，请在语雀中查看。`;
      }
      case "lakeboard":
      case "board": {
        this.warnings.add("画板（lakeboard）仅记录占位");
        return `> [!warning] 画板\n> 此处为语雀画板/思维导图，请在语雀中查看。`;
      }
      case "video": {
        const url = value.src || value.url || "";
        return url ? `[📹 视频](${url})` : `> [!warning] 视频\n> 语雀视频，请在语雀中查看。`;
      }
      case "mention": {
        const who = value.name || value.login || "";
        return who ? `@${who}` : null;
      }
      case "br":
        return "\n";
      default: {
        // 未知卡片：优先取卡内文本，其次保留占位提示
        const text = escapeMdText(el.textContent || "").trim();
        if (text) return text;
        this.warnings.add(`未支持的语雀卡片：${name}`);
        return `> [!warning] 未支持内容\n> 语雀卡片「${name}」暂不支持在此展示，请在语雀中查看。`;
      }
    }
  }

  // ---------- 行内 ----------

  convertInline(el: Element): string {
    let out = "";
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        out += escapeMdText(node.textContent || "");
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const child = node as Element;
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
          const style = child.getAttribute("style") || "";
          const inner = this.convertInline(child);
          const lower = style.toLowerCase();
          // 背景色 → 高亮（Obsidian 原生语法，两种模式都渲染）
          if (lower.includes("background-color") || lower.includes("background:")) {
            out += `==${inner}==`;
          } else if (isDefaultColor(style)) {
            out += inner;
          } else if (this.colorMode === "keep" && colorValueOf(style)) {
            out += `<span style="color:${colorValueOf(style)}">${inner}</span>`;
          } else if (this.colorMode === "highlight") {
            out += `==${inner}==`;
          } else {
            out += inner;
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
}

/** Lake → Markdown 主入口 */
export function lakeToMarkdown(lake: string, colorMode: ColorMode = "keep"): LakeConvertResult {
  if (!lake || !lake.trim()) return { markdown: "", warnings: [] };
  return new LakeConverter(colorMode).convert(lake);
}

/**
 * 判断 body 是否为 Lake 格式（HTML 标签树 + card/ne-* 元素）。
 * 语雀中「粘贴/导入 Markdown 创建」的文档，API 返回的是 Markdown 原文
 * （夹杂行内 <font> 颜色标签），format 字段不可靠，须按内容特征判断。
 */
export function isLakeBody(body: string): boolean {
  if (!body) return false;
  if (/^\s*<!doctype\s+lake/i.test(body)) return true;
  if (/<card[\s>]/i.test(body)) return true;
  if (/<ne-[a-z]/i.test(body)) return true;
  // 有块级 HTML 标签但完全无 markdown 语法痕迹时按 lake 处理
  if (/<(p|div|h[1-6]|table|ul|ol|blockquote)[\s>]/i.test(body)) {
    const mdChars = "#>*-.|`";
    return !body
      .split("\n")
      .some((line) => {
        const t = line.trimStart();
        return t === "" || mdChars.includes(t[0]) || /^\d+\.\s/.test(t);
      });
  }
  return false;
}

/**
 * 取 style 里的前景色值（`color:` 而不是 `background-color:`）。
 * 正则要求 color 紧跟行首或分号，所以 background-color 不会误命中。
 */
function colorValueOf(style: string): string {
  const m = style.match(/(?:^|;)\s*color\s*:\s*([^;"']+)/i);
  return m ? m[1].trim() : "";
}

/** 取出 style 里的 rgb 三元组（没有则 null） */
function rgbOf(style: string): [number, number, number] | null {
  const m = style.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * 语雀自己的默认文字颜色：正文 #4D4D4D（77,77,77）、标题 #4F4F4F（79,79,79），
 * 外加粘贴产物里的纯黑。这些颜色等于主题的默认文字色，包成 span 没有任何视觉信息，
 * 只会让正文到处是 `<span style="color:...">` 噪声（实时预览下还直接显示成源码）。
 *
 * 当初只判了纯黑，于是语雀默认灰被判成「用户选过的颜色」，整篇文档被逐段包上 span。
 */
const DEFAULT_TEXT_RGB: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [77, 77, 77],
  [79, 79, 79],
];

/** 判断是否是「默认前景色 / 没写颜色」（是则不值得输出成 span） */
function isDefaultColor(style: string): boolean {
  if (!/color/i.test(style)) return true;
  const rgb = rgbOf(style);
  if (!rgb) return false;
  return DEFAULT_TEXT_RGB.some(([r, g, b]) => r === rgb[0] && g === rgb[1] && b === rgb[2]);
}

/**
 * 去掉 `style="color:..."` span 的包裹（本地清理存量文档用）。
 *
 * `defaultOnly`（默认 true）只解包「等于主题默认色」那些——它们本来就看不出差别；
 * 设为 false 时连真正有颜色的 span 一起解掉（配合设置里「文字颜色 = 不输出」）。
 * 背景色 span（`==高亮==` 靠它）一律不动；非本插件格式的 span（无 style）也不碰。
 *
 * 用平衡扫描找配对的 `</span>` 而不是正则到第一个 `</span>`——否则遇到嵌套时
 * 会把后半段文字并进那个彩色 span 里，把颜色改错。
 */
export function stripColorSpans(
  md: string,
  opts: { defaultOnly?: boolean } = {},
): { markdown: string; removed: number } {
  const defaultOnly = opts.defaultOnly !== false;
  let out = md;
  let removed = 0;
  // 每轮解掉当前最外层的目标 span；解完外层后内层可能才暴露出来，所以跑多轮
  for (let pass = 0; pass < 10; pass++) {
    const { text, count } = stripOnePass(out, defaultOnly);
    out = text;
    removed += count;
    if (count === 0) break;
  }
  return { markdown: out, removed };
}

/** 只解默认色包裹（`文字颜色` 设为「保留颜色」时的清理口径） */
export function stripDefaultColorSpans(md: string): { markdown: string; removed: number } {
  return stripColorSpans(md, { defaultOnly: true });
}

/** 找与 s[open] 处 `<span` 配对的 `</span>` 起始下标（平衡嵌套；找不到返回 -1） */
function findMatchingClose(s: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < s.length) {
    const nextOpen = s.indexOf("<span", i);
    const nextClose = s.indexOf("</span>", i);
    if (nextClose < 0) return -1;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + 5;
      continue;
    }
    // 先遇到闭标签：层级减一，减到 0 就是与 open 配对的那一个
    depth--;
    if (depth === 0) return nextClose;
    i = nextClose + 7;
  }
  return -1;
}

function stripOnePass(md: string, defaultOnly: boolean): { text: string; count: number } {
  let out = "";
  let i = 0;
  let count = 0;

  while (i < md.length) {
    const open = md.indexOf("<span", i);
    if (open < 0) {
      out += md.slice(i);
      break;
    }
    const tagEnd = md.indexOf(">", open);
    if (tagEnd < 0) {
      out += md.slice(i);
      break;
    }
    const tag = md.slice(open, tagEnd + 1);
    // 只处理本插件生成的 `<span style="...">`，别人的 span 一律不碰
    const styleMatch = tag.match(/^<span\s+style="([^"]*)"\s*>$/i);
    const style = styleMatch ? styleMatch[1] : "";
    const close = styleMatch ? findMatchingClose(md, open) : -1;
    const keep =
      !styleMatch ||
      close < 0 ||
      style.toLowerCase().includes("background") ||
      (defaultOnly ? !isDefaultColor(style) : !colorValueOf(style));

    if (keep) {
      out += md.slice(i, tagEnd + 1);
      i = tagEnd + 1;
      continue;
    }
    // 默认色：丢掉这一层标签，内部内容原样留下（内层会在下一轮被处理）
    out += md.slice(i, open) + md.slice(tagEnd + 1, close);
    count++;
    i = close + "</span>".length;
  }

  return { text: out, count };
}

/**
 * 清理语雀返回的 Markdown 正文：
 * - 解包默认色 <font>（纯黑，以及语雀自己的正文 #4D4D4D / 标题 #4F4F4F——它们等于主题默认色）
 * - 非默认色按 colorMode 处理：drop 丢弃 / highlight 转 `==` / keep 保留为 `<span style="color:...">`
 * - 收敛多余空行
 */
export function cleanMarkdownBody(md: string, colorMode: ColorMode = "keep"): LakeConvertResult {
  const warnings: string[] = [];
  let out = md;
  // 迭代解包，防嵌套 font
  for (let i = 0; i < 5; i++) {
    const next = out.replace(
      /<font([^>]*)>([\s\S]*?)<\/font>/gi,
      (_m, attrs: string, inner: string) => {
        if (isDefaultColor(attrs)) return inner;
        if (colorMode === "drop") return inner;
        if (colorMode === "highlight") return `==${inner}==`;
        const colorMatch = attrs.match(/color:\s*([^;"']+)/i);
        const color = colorMatch ? colorMatch[1].trim() : "";
        return color ? `<span style="color:${color}">${inner}</span>` : inner;
      },
    );
    if (next === out) break;
    out = next;
  }
  // 孤立未闭合的 font 标签清理
  out = out.replace(/<font[^>]*>/gi, "").replace(/<\/font>/gi, "");
  // <br> 转换行
  out = out.replace(/<br\s*\/?>/gi, "\n");
  // 收敛 3+ 连续空行
  out = out.replace(/\n{3,}/g, "\n\n").trim() + "\n";
  return { markdown: out, warnings };
}

/** 统一入口：按内容特征分流 Lake / Markdown */
export function convertYuqueBody(body: string, colorMode: ColorMode = "keep"): LakeConvertResult {
  if (!body || !body.trim()) return { markdown: "", warnings: [] };
  return isLakeBody(body) ? lakeToMarkdown(body, colorMode) : cleanMarkdownBody(body, colorMode);
}
