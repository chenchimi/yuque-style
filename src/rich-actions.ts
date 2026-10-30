/**
 * 富文本动作的**纯逻辑内核**：把「加粗 / 标题 / 列表 / 引用 / 代码块…」算成一组
 * 文本编辑操作，由调用方用各自的 API 落地。
 *
 * 抽成纯函数有两条实际理由：
 * 1. 顶部工具栏（Obsidian Editor API）与悬浮工具栏（CodeMirror EditorView）**共用同一套
 *    动作语义**——两处各写一遍，早晚会出现「同一个按钮，两处行为不一样」；
 * 2. 行前缀类操作最容易写错（多行选区、行尾边界、切换开关、光标漂移），
 *    纯函数才好用单测把边界钉死。
 *
 * 坐标一律用「行号 + 行内字符偏移」，两边的 API 都能直接消费：
 * Obsidian 是 `editor.replaceRange(text, from, to)`，CodeMirror 是
 * `state.doc.line(n).from + ch` 换算成绝对偏移。
 */

export interface Pos {
  line: number;
  ch: number;
}

/** 一次替换：把 [from, to) 换成 text */
export interface TextEdit {
  from: Pos;
  to: Pos;
  text: string;
}

export interface EditPlan {
  edits: TextEdit[];
  /**
   * 操作后要恢复的选区。
   *
   * 必须有：整行替换（加前缀）与包裹标记都会让编辑器把光标甩到替换区末尾，
   * 用户连点两个按钮时就会「越点越偏」。这里显式给出应有的位置。
   */
  selection?: { from: Pos; to: Pos };
}

/** 调用方在动手之前拍下的快照：整篇文本 + 当前选区 */
export interface Snapshot {
  lines: string[];
  from: Pos;
  to: Pos;
}

const HEADING_RE = /^(#{1,6})\s+/;
const QUOTE_RE = /^>\s?/;
const LIST_RES: Record<ListKind, RegExp> = {
  // 待办也以 `- ` 开头，所以无序列表要把它排除，否则「点无序列表」会把待办方框吃掉
  bullet: /^[-*+]\s+(?!\[[ xX]\])/,
  ordered: /^\d+[.)]\s+/,
  task: /^[-*+]\s+\[[ xX]\]/,
};
/** 去掉已有列表标记（含待办方框），返回正文部分 */
const ANY_LIST_RE = /^(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/;

export type ParagraphStyle = "body" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "quote";
export type ListKind = "bullet" | "ordered" | "task";

/** 段落样式下拉里的条目（与语雀的「正文 / 标题 / 引用」一致） */
export const PARAGRAPH_STYLES: ReadonlyArray<{ id: ParagraphStyle; label: string }> = [
  { id: "body", label: "正文" },
  { id: "h1", label: "标题 1" },
  { id: "h2", label: "标题 2" },
  { id: "h3", label: "标题 3" },
  { id: "h4", label: "标题 4" },
  { id: "h5", label: "标题 5" },
  { id: "h6", label: "标题 6" },
  { id: "quote", label: "引用块" },
];

export function paragraphStyleLabel(style: ParagraphStyle): string {
  return PARAGRAPH_STYLES.find((s) => s.id === style)?.label ?? "正文";
}

function prefixOf(style: ParagraphStyle): string {
  if (style === "quote") return "> ";
  if (style === "body") return "";
  return `${"#".repeat(Number(style.slice(1)))} `;
}

/** 光标所在行当前的段落样式（用于把下拉的当前值显示出来） */
export function paragraphStyleOf(line: string): ParagraphStyle {
  const heading = line.match(HEADING_RE);
  if (heading) return `h${heading[1].length}` as ParagraphStyle;
  if (QUOTE_RE.test(line)) return "quote";
  return "body";
}

/** 行首已有的段落标记长度（标题 / 引用），用于替换时先剥掉旧的 */
function prefixLength(text: string): number {
  const heading = text.match(HEADING_RE);
  if (heading) return heading[0].length;
  const quote = text.match(QUOTE_RE);
  if (quote) return quote[0].length;
  return 0;
}

/** 选区文本；跨行时按 \n 拼接（与编辑器里的实际文本一致） */
export function selectionText(s: Snapshot): string {
  if (s.from.line === s.to.line) {
    return (s.lines[s.from.line] ?? "").slice(s.from.ch, s.to.ch);
  }
  const parts: string[] = [];
  for (let n = s.from.line; n <= s.to.line; n++) {
    const text = s.lines[n] ?? "";
    if (n === s.from.line) parts.push(text.slice(s.from.ch));
    else if (n === s.to.line) parts.push(text.slice(0, s.to.ch));
    else parts.push(text);
  }
  return parts.join("\n");
}

/** 选区覆盖的行号范围（收尾落在行首时，最后一行不算被选中） */
export function selectedLines(s: Snapshot): { first: number; last: number } {
  const last =
    s.to.ch === 0 && s.to.line > s.from.line ? s.to.line - 1 : s.to.line;
  return { first: s.from.line, last: Math.max(s.from.line, last) };
}

/** 从 pos 起写入 text 之后，光标应落在哪里（text 可能含换行） */
export function advance(pos: Pos, text: string): Pos {
  const parts = text.split("\n");
  if (parts.length === 1) return { line: pos.line, ch: pos.ch + text.length };
  return { line: pos.line + parts.length - 1, ch: parts[parts.length - 1].length };
}

/**
 * 逐行重写选区覆盖的行。
 *
 * rewrite 返回 null 表示该行不动。整行替换会把光标甩走，所以这里顺手算出
 * 首尾两行的长度差，把原选区平移回正确的位置（`selection` 字段）。
 */
function rewriteLines(
  s: Snapshot,
  rewrite: (line: number, text: string) => string | null,
): EditPlan {
  const { first, last } = selectedLines(s);
  const edits: TextEdit[] = [];
  let deltaFirst = 0;
  let deltaLast = 0;

  for (let n = first; n <= last; n++) {
    const text = s.lines[n] ?? "";
    const next = rewrite(n, text);
    if (next === null || next === text) continue;
    edits.push({ from: { line: n, ch: 0 }, to: { line: n, ch: text.length }, text: next });
    const delta = next.length - text.length;
    if (n === first) deltaFirst = delta;
    deltaLast = delta;
  }
  if (edits.length === 0) return { edits: [] };

  return {
    edits,
    selection: {
      from: { line: s.from.line, ch: Math.max(0, s.from.ch + deltaFirst) },
      to: { line: s.to.line, ch: Math.max(0, s.to.ch + deltaLast) },
    },
  };
}

/** 把选区覆盖的行整体设为某段落样式（正文 / 标题 N / 引用块） */
export function setParagraphStyle(s: Snapshot, style: ParagraphStyle): EditPlan {
  const prefix = prefixOf(style);
  return rewriteLines(s, (_n, text) => {
    const body = text.slice(prefixLength(text));
    if (prefix === "" && body === text) return null; // 本来就是正文，不必改写
    return `${prefix}${body}`;
  });
}

/** 列表：已是同类型则取消，否则统一改成该类型（保留原有缩进） */
export function toggleList(s: Snapshot, kind: ListKind): EditPlan {
  const { first, last } = selectedLines(s);
  const lines: number[] = [];
  for (let n = first; n <= last; n++) lines.push(n);
  const marker = kind === "bullet" ? "- " : kind === "ordered" ? "1. " : "- [ ] ";
  const allSame = lines.every((n) => LIST_RES[kind].test((s.lines[n] ?? "").slice(leadingSpace(s.lines[n] ?? "").length)));

  return rewriteLines(s, (_n, text) => {
    const indent = leadingSpace(text);
    const body = text.slice(indent.length).replace(ANY_LIST_RE, "");
    const head = allSame ? "" : marker;
    return `${indent}${head}${body}`;
  });
}

function leadingSpace(text: string): string {
  return text.match(/^[ \t]*/)?.[0] ?? "";
}

/**
 * 行内标记开关：选区已带标记则去掉，否则裹上。
 *
 * 三种命中情形都认，否则用户会遇到「明明加粗了，再点一下没反应、反而套两层」：
 * 1. 标记在选区内（`**粗**` 被整段选中）；
 * 2. 标记紧贴在选区外侧（选中 `粗`，两侧是 `**`）；
 * 3. 空选区：插入成对标记并把光标放进中间，接着打字即可。
 */
export function toggleWrap(s: Snapshot, open: string, close: string = open): EditPlan {
  if (s.from.line === s.to.line && s.from.ch === s.to.ch) {
    const cursor = { line: s.from.line, ch: s.from.ch + open.length };
    return {
      edits: [{ from: s.from, to: s.from, text: `${open}${close}` }],
      selection: { from: cursor, to: { ...cursor } },
    };
  }

  const inner = selectionText(s);
  if (inner.length >= open.length + close.length && inner.startsWith(open) && inner.endsWith(close)) {
    const stripped = inner.slice(open.length, inner.length - close.length);
    return {
      edits: [{ from: s.from, to: s.to, text: stripped }],
      selection: { from: s.from, to: advance(s.from, stripped) },
    };
  }

  if (s.from.line === s.to.line) {
    const line = s.lines[s.from.line] ?? "";
    const before = line.slice(Math.max(0, s.from.ch - open.length), s.from.ch);
    const after = line.slice(s.to.ch, s.to.ch + close.length);
    if (before === open && after === close) {
      const start = { line: s.from.line, ch: s.from.ch - open.length };
      return {
        edits: [
          { from: start, to: s.from, text: "" },
          { from: s.to, to: { line: s.to.line, ch: s.to.ch + close.length }, text: "" },
        ],
        selection: { from: start, to: { line: s.to.line, ch: s.to.ch - open.length } },
      };
    }
  }

  const wrapped = `${open}${inner}${close}`;
  return {
    edits: [{ from: s.from, to: s.to, text: wrapped }],
    selection: {
      from: { line: s.from.line, ch: s.from.ch + open.length },
      to: advance({ line: s.from.line, ch: s.from.ch }, `${open}${inner}`),
    },
  };
}

/** 代码块：有选区则用围栏包住，空选区则插入一对空围栏并把光标放进中间 */
export function wrapCodeBlock(s: Snapshot, lang = ""): EditPlan {
  const fence = `\`\`\`${lang}`;
  const inner = selectionText(s);
  if (inner) {
    return { edits: [{ from: s.from, to: s.to, text: `${fence}\n${inner}\n\`\`\`` }] };
  }
  const cursor = advance(s.from, `${fence}\n`);
  return {
    edits: [{ from: s.from, to: s.from, text: `${fence}\n\n\`\`\`` }],
    selection: { from: cursor, to: { ...cursor } },
  };
}

/**
 * 插入**独占一行**的块（分割线、日期等），返回插入后光标的位置。
 *
 * 刻意不用「在光标处插入」：光标常停在行中间，那样会把一句话劈成两半
 * （`abc` + `---` → `a\n---\nbc`）。这里改为整行插入——当前行有内容就换到它**后面**新起一行，
 * 空行则直接占用当前行。
 */
export function insertBlockAtCursor(s: Snapshot, block: string): EditPlan {
  const line = s.lines[s.from.line] ?? "";
  const emptyLine = line.trim() === "";
  const at = emptyLine ? s.from : { line: s.from.line, ch: line.length };
  const insert = emptyLine ? `${block}\n` : `\n\n${block}\n`;
  const cursor = advance(at, insert);
  return {
    edits: [{ from: at, to: at, text: insert }],
    selection: { from: cursor, to: { ...cursor } },
  };
}

/** 链接：有选区就用选区做锚文本，否则插入空锚文本并把光标停进方括号 */
export function insertLink(s: Snapshot, url: string): EditPlan {
  const label = selectionText(s);
  if (label) {
    const text = `[${label}](${url})`;
    return { edits: [{ from: s.from, to: s.to, text }], selection: { from: s.from, to: advance(s.from, text) } };
  }
  const cursor = { line: s.from.line, ch: s.from.ch + 1 };
  return {
    edits: [{ from: s.from, to: s.from, text: `[](${url})` }],
    selection: { from: cursor, to: { ...cursor } },
  };
}

/**
 * 文字颜色：与同步侧「语雀彩色文字 → span」同一套写法，免得同步下来的颜色与手写的两套语法。
 * color 为 null 时清除颜色标签。
 */
export function setTextColor(s: Snapshot, color: string | null): EditPlan | null {
  const inner = selectionText(s);
  if (!inner) return null;
  if (color === null) {
    const stripped = inner.replace(/<\/?span[^>]*>/gi, "");
    if (stripped === inner) return null;
    return { edits: [{ from: s.from, to: s.to, text: stripped }], selection: { from: s.from, to: advance(s.from, stripped) } };
  }
  const open = `<span style="color:${color}">`;
  const text = `${open}${inner}</span>`;
  return { edits: [{ from: s.from, to: s.to, text }], selection: { from: s.from, to: advance(s.from, text) } };
}

/** 选区里所有行内标记的清扫规则（与同步侧的语法保持一致） */
const INLINE_MARKS: RegExp[] = [
  /<\/?u>/gi,
  /<\/?span[^>]*>/gi,
  /<\/?em>/gi,
  /<\/?strong>/gi,
  /\*\*/g,
  /~~/g,
  /==/g,
  /`{1,3}/g,
  /<br\s*\/?>/gi,
  /\*/g,
  /__/g,
];

/** 清除选区里的行内标记（不动行前缀：标题/列表/引用属于段落样式） */
export function clearFormatting(s: Snapshot): EditPlan | null {
  const inner = selectionText(s);
  if (!inner) return null;
  let next = inner;
  for (const re of INLINE_MARKS) next = next.replace(re, "");
  if (next === inner) return null;
  return { edits: [{ from: s.from, to: s.to, text: next }], selection: { from: s.from, to: advance(s.from, next) } };
}
