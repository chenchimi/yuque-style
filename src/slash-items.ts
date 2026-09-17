import type { App, TFile } from "obsidian";
import { buildTocBlock } from "./toc";

/**
 * 斜杠菜单的条目表与过滤逻辑。
 *
 * 单独成模块、且只以 type 方式引用 obsidian，是为了让过滤逻辑能被单测覆盖；
 * 放回 slash.ts 会让测试被迫去 mock 整个 EditorSuggest。
 */

export interface SlashContext {
  file: TFile | null;
  app: App;
}

export interface SlashItem {
  name: string;
  hint: string;
  keywords: string[];
  insert: string;
  /** 插入后光标从末尾回退的字符数（如代码块要落在两个 ``` 之间） */
  cursorBack: number;
  /** 插入后要选中哪段占位文本（选中后直接打字即可替换）；优先于 cursorBack */
  selectText?: string;
  /** 只有显式输入关键词后才出现：19 个语言代码块不该挤满首屏 */
  keywordOnly?: boolean;
  /** 插入内容依赖当前文件或运行时（目录块、今日日期） */
  resolve?: (ctx: SlashContext) => string | null;
  /** resolve 返回 null 时的提示语 */
  emptyHint?: string;
}

/** 卡片块：补全 Obsidian 原生 callout 类型，不发明新语法 */
const CARD_TYPES: { type: string; name: string; hint: string; keywords: string[] }[] = [
  { type: "note", name: "卡片块", hint: "语雀式标注卡片（蓝色便签）", keywords: ["card", "kapian", "kp", "callout", "note"] },
  { type: "tip", name: "提示卡片", hint: "绿色提示标注", keywords: ["tip", "tishi", "ts"] },
  { type: "warning", name: "警告卡片", hint: "橙黄色警告标注", keywords: ["warning", "warn", "jinggao", "jg"] },
  { type: "info", name: "信息卡片", hint: "蓝色信息标注", keywords: ["info", "xinxi", "xx"] },
  { type: "success", name: "成功卡片", hint: "绿色成功标注", keywords: ["success", "chenggong", "cg", "check", "done"] },
  { type: "question", name: "疑问卡片", hint: "黄色疑问标注", keywords: ["question", "yiwen", "yw", "help", "faq"] },
  { type: "failure", name: "失败卡片", hint: "红色失败标注", keywords: ["failure", "shibai", "sb", "fail"] },
  { type: "danger", name: "危险卡片", hint: "红色危险标注", keywords: ["danger", "weixian", "wx", "error"] },
  { type: "example", name: "示例卡片", hint: "紫色示例标注", keywords: ["example", "shili", "sl"] },
  { type: "quote", name: "引用卡片", hint: "灰色引用标注", keywords: ["quote", "yinyong", "yy", "cite"] },
];

const CARD_ITEMS: SlashItem[] = CARD_TYPES.map((c) => ({
  name: c.name,
  hint: c.hint,
  keywords: c.keywords,
  insert: `> [!${c.type}] ${c.name.replace("卡片", "")}\n> 在这里填写内容。`,
  cursorBack: 0,
  selectText: "在这里填写内容。",
}));

/** 语言代码块：一律 keywordOnly，靠 /py、/js 这类关键词唤起 */
const CODE_LANGS: { lang: string; label: string; keywords: string[] }[] = [
  { lang: "python", label: "Python", keywords: ["py", "python"] },
  { lang: "javascript", label: "JavaScript", keywords: ["js", "javascript"] },
  { lang: "typescript", label: "TypeScript", keywords: ["ts", "typescript"] },
  { lang: "java", label: "Java", keywords: ["java"] },
  { lang: "bash", label: "Bash", keywords: ["bash", "sh", "shell", "linux"] },
  { lang: "powershell", label: "PowerShell", keywords: ["powershell", "ps", "ps1", "pwsh", "windows"] },
  { lang: "sql", label: "SQL", keywords: ["sql", "mysql"] },
  { lang: "json", label: "JSON", keywords: ["json"] },
  { lang: "yaml", label: "YAML", keywords: ["yaml", "yml"] },
  { lang: "html", label: "HTML", keywords: ["html"] },
  { lang: "css", label: "CSS", keywords: ["css"] },
  { lang: "go", label: "Go", keywords: ["go", "golang"] },
  { lang: "cpp", label: "C++", keywords: ["cpp", "c++", "c"] },
];

const CODE_ITEMS: SlashItem[] = CODE_LANGS.map((c) => ({
  name: `${c.label} 代码块`,
  hint: "带语言标注的代码块",
  keywords: [...c.keywords, "语言", "代码"],
  insert: `\`\`\`${c.lang}\n\n\`\`\``,
  cursorBack: 4,
  keywordOnly: true,
}));

export const ITEMS: SlashItem[] = [
  { name: "标题 1", hint: "大号章节标题", keywords: ["h1", "bt", "biaoti"], insert: "# ", cursorBack: 0 },
  { name: "标题 2", hint: "中号章节标题", keywords: ["h2"], insert: "## ", cursorBack: 0 },
  { name: "标题 3", hint: "小号章节标题", keywords: ["h3"], insert: "### ", cursorBack: 0 },
  { name: "标题 4", hint: "更小号标题", keywords: ["h4"], insert: "#### ", cursorBack: 0 },
  { name: "待办清单", hint: "可勾选的任务列表", keywords: ["todo", "daiban", "db", "task"], insert: "- [ ] ", cursorBack: 0 },
  { name: "无序列表", hint: "项目符号列表", keywords: ["list", "liebiao", "ul"], insert: "- ", cursorBack: 0 },
  { name: "有序列表", hint: "编号列表", keywords: ["ol", "order"], insert: "1. ", cursorBack: 0 },
  { name: "引用块", hint: "引用一段文字", keywords: ["quote", "yinyong", "yy"], insert: "> ", cursorBack: 0 },
  ...CARD_ITEMS,
  {
    name: "折叠块",
    hint: "可展开收起的内容块（折叠 callout）",
    keywords: ["fold", "zhedie", "zd", "details", "collapse"],
    // 用折叠 callout 而不是 <details>：实测 <details> 内部不解析 Markdown，
    // 加粗会显示成 **加粗**、列表会挤成一行。折叠 callout 的内容是正常 Markdown，
    // 阅读模式与实时预览都能折叠。
    // 用 "+"（默认展开）而不是语雀那种默认收起：插入后占位文字是选中的，
    // 默认收起会让用户对着看不见的内容打字。
    insert: "> [!note]+ 折叠标题\n> 在这里填写折叠内容。",
    cursorBack: 0,
    selectText: "折叠标题",
  },
  {
    name: "目录块",
    hint: "按当前文档标题生成目录（静态快照）",
    keywords: ["toc", "mulu", "ml", "目录", "outline"],
    insert: "",
    cursorBack: 0,
    emptyHint: "当前文档还没有标题，无法生成目录",
    resolve: ({ file, app }) => {
      if (!file) return null;
      const headings = app.metadataCache.getFileCache(file)?.headings ?? [];
      const block = buildTocBlock(headings);
      return block === "" ? null : block;
    },
  },
  {
    name: "两栏对比",
    hint: "Markdown 无原生分栏，此处用标准表格模拟",
    keywords: ["column", "lianglan", "ll", "分栏", "split"],
    insert: "| 左栏 | 右栏 |\n| --- | --- |\n| 左侧内容 | 右侧内容 |",
    cursorBack: 0,
    selectText: "左侧内容",
  },
  {
    name: "表格",
    hint: "插入 3x3 表格",
    keywords: ["table", "biaoge", "bg"],
    insert: "| 列名 | 列名 | 列名 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n| 内容 | 内容 | 内容 |\n",
    cursorBack: 0,
  },
  {
    name: "代码块",
    hint: "多行代码（不带语言标注）",
    keywords: ["code", "daima", "dm", "codeblock"],
    insert: "```\n\n```",
    cursorBack: 4,
  },
  ...CODE_ITEMS,
  { name: "分割线", hint: "水平分隔线", keywords: ["hr", "fgx", "line"], insert: "\n---\n", cursorBack: 0 },
  {
    name: "数学公式",
    hint: "块级 LaTeX 公式",
    keywords: ["math", "formula", "gongshi", "gs", "latex"],
    insert: "$$\n\n$$",
    cursorBack: 3,
  },
  {
    name: "今日日期",
    hint: "插入今天的日期",
    keywords: ["date", "riqi", "rq", "today"],
    insert: "",
    cursorBack: 0,
    // 放到 resolve 里算：模块加载时求值会让单测环境没有 window 而直接炸掉
    resolve: () => window.moment().format("YYYY-MM-DD"),
  },
];

/**
 * 菜单过滤。
 * 无输入时只给通用块；一旦有输入，keywordOnly 的代码块也参与匹配。
 */
export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.filter((it) => !it.keywordOnly);
  return items.filter((it) => {
    // 名称 / 提示 / 关键词，任意一处包含查询串即命中（宽松匹配，中英文都行）
    if (it.name.toLowerCase().includes(q)) return true;
    if (it.hint.toLowerCase().includes(q)) return true;
    return it.keywords.some((k) => k.toLowerCase().includes(q) || k.toLowerCase().startsWith(q));
  });
}
