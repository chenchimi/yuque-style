import {
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  TFile,
} from "obsidian";
import type { YuqueStylePlugin } from "./main";

/**
 * 语雀式斜杠菜单：
 * 在编辑器中输入 "/" 后弹出块插入菜单（可用拼音 / 关键词过滤），
 * 选择后在当前位置插入对应的 Markdown 块。
 */

export interface SlashItem {
  name: string;
  hint: string;
  keywords: string[];
  insert: string;
  /** 插入后光标从插入文本末尾回退的字符数（如代码块要落在两个 ``` 之间） */
  cursorBack: number;
}

const ITEMS: SlashItem[] = [
  { name: "标题 1", hint: "大号章节标题", keywords: ["h1", "bt", "biaoti"], insert: "# ", cursorBack: 0 },
  { name: "标题 2", hint: "中号章节标题", keywords: ["h2"], insert: "## ", cursorBack: 0 },
  { name: "标题 3", hint: "小号章节标题", keywords: ["h3"], insert: "### ", cursorBack: 0 },
  { name: "标题 4", hint: "更小号标题", keywords: ["h4"], insert: "#### ", cursorBack: 0 },
  { name: "待办清单", hint: "可勾选的任务列表", keywords: ["todo", "daiban", "db", "task"], insert: "- [ ] ", cursorBack: 0 },
  { name: "无序列表", hint: "项目符号列表", keywords: ["list", "liebiao", "ul"], insert: "- ", cursorBack: 0 },
  { name: "有序列表", hint: "编号列表", keywords: ["ol", "order"], insert: "1. ", cursorBack: 0 },
  { name: "引用块", hint: "引用一段文字", keywords: ["quote", "yinyong", "yy"], insert: "> ", cursorBack: 0 },
  {
    name: "卡片块",
    hint: "语雀式标注卡片（蓝色便签）",
    keywords: ["card", "kapian", "kp", "callout", "note"],
    insert: "> [!note] 卡片标题\n> 在这里填写卡片内容。",
    cursorBack: 8,
  },
  {
    name: "提示卡片",
    hint: "绿色提示标注",
    keywords: ["tip", "tishi", "ts"],
    insert: "> [!tip] 提示\n> 在这里填写提示内容。",
    cursorBack: 8,
  },
  {
    name: "警告卡片",
    hint: "橙黄色警告标注",
    keywords: ["warning", "warn", "jinggao", "jg"],
    insert: "> [!warning] 警告\n> 在这里填写警告内容。",
    cursorBack: 8,
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
  {
    name: "Python 代码块",
    hint: "带语言标注的代码块",
    keywords: ["py", "python", "语言", "代码"],
    insert: "```python\n\n```",
    cursorBack: 4,
  },
  {
    name: "JavaScript 代码块",
    hint: "带语言标注的代码块",
    keywords: ["js", "javascript", "语言", "代码"],
    insert: "```javascript\n\n```",
    cursorBack: 4,
  },
  {
    name: "TypeScript 代码块",
    hint: "带语言标注的代码块",
    keywords: ["ts", "typescript", "语言", "代码"],
    insert: "```typescript\n\n```",
    cursorBack: 4,
  },
  {
    name: "Java 代码块",
    hint: "带语言标注的代码块",
    keywords: ["java", "语言", "代码"],
    insert: "```java\n\n```",
    cursorBack: 4,
  },
  {
    name: "Bash 代码块",
    hint: "Shell / 命令行",
    keywords: ["bash", "sh", "shell", "linux", "语言", "代码"],
    insert: "```bash\n\n```",
    cursorBack: 4,
  },
  {
    name: "PowerShell 代码块",
    hint: "Windows 命令行 / 脚本",
    keywords: ["powershell", "ps", "ps1", "pwsh", "windows", "语言", "代码"],
    insert: "```powershell\n\n```",
    cursorBack: 4,
  },
  {
    name: "SQL 代码块",
    hint: "数据库查询",
    keywords: ["sql", "mysql", "语言", "代码"],
    insert: "```sql\n\n```",
    cursorBack: 4,
  },
  {
    name: "JSON 代码块",
    hint: "JSON 数据",
    keywords: ["json", "语言", "代码"],
    insert: "```json\n\n```",
    cursorBack: 4,
  },
  {
    name: "YAML 代码块",
    hint: "配置文件",
    keywords: ["yaml", "yml", "语言", "代码"],
    insert: "```yaml\n\n```",
    cursorBack: 4,
  },
  {
    name: "HTML 代码块",
    hint: "网页标记",
    keywords: ["html", "语言", "代码"],
    insert: "```html\n\n```",
    cursorBack: 4,
  },
  {
    name: "CSS 代码块",
    hint: "样式表",
    keywords: ["css", "语言", "代码"],
    insert: "```css\n\n```",
    cursorBack: 4,
  },
  {
    name: "Go 代码块",
    hint: "带语言标注的代码块",
    keywords: ["go", "golang", "语言", "代码"],
    insert: "```go\n\n```",
    cursorBack: 4,
  },
  {
    name: "C++ 代码块",
    hint: "带语言标注的代码块",
    keywords: ["cpp", "c++", "c", "语言", "代码"],
    insert: "```cpp\n\n```",
    cursorBack: 4,
  },
  {
    name: "分割线",
    hint: "水平分隔线",
    keywords: ["hr", "fgx", "line"],
    insert: "\n---\n",
    cursorBack: 0,
  },
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
    insert: window.moment().format("YYYY-MM-DD"),
    cursorBack: 0,
  },
];

export class YuqueSlashSuggest extends EditorSuggest<SlashItem> {
  constructor(private plugin: YuqueStylePlugin) {
    super(plugin.app);
  }

  /** 输入 "/"（行首或空格后）时触发菜单 */
  onTrigger(
    cursor: EditorPosition,
    editor: Editor,
    _file: TFile | null,
  ): EditorSuggestTriggerInfo | null {
    if (!this.plugin.settings.slashMenu) return null;
    const line = editor.getLine(cursor.line);
    const before = line.slice(0, cursor.ch);
    // "/" 需出现在行首或空白符之后，且后面只能跟连续的过滤字符
    const m = before.match(/(?:^|\s)\/([^/\s]*)$/);
    if (!m) return null;
    return {
      start: { line: cursor.line, ch: cursor.ch - m[1].length - 1 },
      end: { line: cursor.line, ch: cursor.ch },
      query: m[1],
    };
  }

  getSuggestions(context: EditorSuggestContext): SlashItem[] {
    const q = context.query.toLowerCase();
    if (!q) return ITEMS;
    return ITEMS.filter((it) => {
      // 名称 / 提示 / 关键词，任意一处包含查询串即命中（宽松匹配，中英文都行）
      if (it.name.toLowerCase().includes(q)) return true;
      if (it.hint.toLowerCase().includes(q)) return true;
      return it.keywords.some((k) => k.toLowerCase().includes(q) || k.toLowerCase().startsWith(q));
    });
  }

  renderSuggestion(item: SlashItem, el: HTMLElement): void {
    const row = el.createEl("div", { cls: "yuque-slash-row" });
    row.createEl("span", { cls: "yuque-slash-name", text: item.name });
    row.createEl("span", { cls: "yuque-slash-hint", text: item.hint });
  }

  selectSuggestion(item: SlashItem, evt: MouseEvent | KeyboardEvent): void {
    this.onChooseSuggestion(item, evt);
    this.close();
  }

  onChooseSuggestion(item: SlashItem, _evt: MouseEvent | KeyboardEvent): void {
    const ctx = this.context;
    if (!ctx) return;
    const editor = ctx.editor;
    const startOffset = editor.posToOffset(ctx.start);
    editor.replaceRange(item.insert, ctx.start, ctx.end);
    const cursorOffset = startOffset + item.insert.length - item.cursorBack;
    editor.setCursor(editor.offsetToPos(cursorOffset));
  }
}
