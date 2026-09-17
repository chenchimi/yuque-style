import { App, Modal, Notice, Setting } from "obsidian";
import { EditorSelection } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { applyTableOp, locateTable, type LineSource, type TableOp } from "./table";

/**
 * 语雀风格悬浮工具栏，两种形态：
 * - 选中文本时：「文本排版条」加粗 / 斜体 / 删除线 / 高亮 / 行内代码 / 标题 / 引用 / 待办 / 链接 / 颜色
 * - 光标在表格内且没有选区时：「表格工具条」插行 / 删行 / 插列 / 删列
 * 只在编辑模式（实时预览 / 源码模式）生效，阅读模式下不出现。
 */

interface ToolbarAction {
  label: string;
  title: string;
  apply: (view: EditorView, app: App) => void;
}

/** 用成对标记包裹选中文本 */
function wrap(view: EditorView, mark: string): void {
  const sel = view.state.selection.main;
  if (sel.empty) return;
  const text = view.state.sliceDoc(sel.from, sel.to);
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: `${mark}${text}${mark}` },
    selection: EditorSelection.range(sel.from + mark.length, sel.to + mark.length),
  });
}

/** 切换行首前缀（标题 / 引用 / 待办等），作用于选区覆盖的所有行 */
function toggleLinePrefix(view: EditorView, prefix: string): void {
  const { state } = view;
  const sel = state.selection.main;
  const firstLine = state.doc.lineAt(sel.from);
  const lastLine = state.doc.lineAt(sel.to);
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  for (let n = firstLine.number; n <= lastLine.number; n++) {
    const line = state.doc.line(n);
    if (line.text.startsWith(prefix)) {
      changes.push({ from: line.from, to: line.from + prefix.length, insert: "" });
    } else {
      changes.push({ from: line.from, to: line.from, insert: prefix });
    }
  }
  view.dispatch({ changes });
}

/**
 * 文字颜色色板。
 * 用 <span style="color:…">，与同步侧「语雀彩色文字 → span」保持同一语法，
 * 免得同步下来的颜色和手写的颜色是两套写法。
 * 刻意不含纯黑：深色主题下黑字等于隐形。
 */
const TEXT_COLORS: { name: string; value: string }[] = [
  { name: "红", value: "#e53935" },
  { name: "橙", value: "#fb8c00" },
  { name: "黄", value: "#f9a825" },
  { name: "绿", value: "#43a047" },
  { name: "青", value: "#00acc1" },
  { name: "蓝", value: "#1e88e5" },
  { name: "紫", value: "#8e24aa" },
  { name: "灰", value: "#757575" },
];

class LinkModal extends Modal {
  constructor(
    app: App,
    private hasText: boolean,
    private onSubmit: (url: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.hasText ? "插入链接" : "插入空链接");
    let value = "";
    const submit = (): void => {
      this.onSubmit(value);
      this.close();
    };
    new Setting(this.contentEl)
      .setName("链接地址")
      .setDesc(this.hasText ? "" : "插入后光标停在方括号内，可以填链接文字")
      .addText((t) => {
        t.setPlaceholder("https://…").onChange((v) => {
          value = v.trim();
        });
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        });
        window.setTimeout(() => t.inputEl.focus(), 0);
      });
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText("插入").setCta().onClick(submit),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ColorModal extends Modal {
  constructor(
    app: App,
    private onSubmit: (color: string | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("文字颜色");
    this.contentEl.createEl("p", {
      text: '将插入 <span style="color:…">，与语雀同步下来的彩色文字写法一致。',
      cls: "setting-item-description",
    });
    const grid = this.contentEl.createDiv({ cls: "yuque-color-grid" });
    for (const color of TEXT_COLORS) {
      const btn = grid.createEl("button", {
        cls: "yuque-color-swatch",
        attr: { "aria-label": color.name, title: color.name },
      });
      btn.style.backgroundColor = color.value;
      btn.addEventListener("click", () => {
        this.onSubmit(color.value);
        this.close();
      });
    }
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText("清除颜色").onClick(() => {
        this.onSubmit(null);
        this.close();
      }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function applyLink(view: EditorView, app: App): void {
  const sel = view.state.selection.main;
  const hasText = !sel.empty;
  const label = hasText ? view.state.sliceDoc(sel.from, sel.to) : "";
  new LinkModal(app, hasText, (url) => {
    if (!url) return;
    if (hasText) {
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert: `[${label}](${url})` } });
    } else {
      // 光标停在 [] 里，方便接着填链接文字
      view.dispatch({
        changes: { from: sel.from, insert: `[](${url})` },
        selection: EditorSelection.cursor(sel.from + 1),
      });
    }
    view.focus();
  }).open();
}

function applyColor(view: EditorView, app: App): void {
  const sel = view.state.selection.main;
  if (sel.empty) {
    new Notice("请先选中要上色的文字");
    return;
  }
  const text = view.state.sliceDoc(sel.from, sel.to);
  new ColorModal(app, (color) => {
    const next =
      color === null
        ? // 清除：把选区内的颜色标签摘掉
          text.replace(/<\/?span[^>]*style="color:[^"]*"[^>]*>/g, "")
        : `<span style="color:${color}">${text}</span>`;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: next },
      selection: EditorSelection.range(sel.from, sel.from + next.length),
    });
    view.focus();
  }).open();
}

const TABLE_ACTIONS: { label: string; title: string; op: TableOp }[] = [
  { label: "↑行", title: "在光标行上方插入一行", op: "insert-row-above" },
  { label: "↓行", title: "在光标行下方插入一行", op: "insert-row-below" },
  { label: "删行", title: "删除光标所在行（表头与分隔行不可删）", op: "delete-row" },
  { label: "←列", title: "在光标列左侧插入一列", op: "insert-col-left" },
  { label: "→列", title: "在光标列右侧插入一列", op: "insert-col-right" },
  { label: "删列", title: "删除光标所在列", op: "delete-col" },
];

function applyTable(view: EditorView, op: TableOp): void {
  const { state } = view;
  const sel = state.selection.main;
  const info = state.doc.lineAt(sel.head);
  const src: LineSource = { count: state.doc.lines, at: (n) => state.doc.line(n).text };
  const block = locateTable(src, info.number, sel.head - info.from);
  if (!block) {
    new Notice("光标不在表格里");
    return;
  }
  const next = applyTableOp(block, op);
  if (next === null) {
    new Notice(op === "delete-col" ? "不能删除表格的最后一列" : "表头与分隔行不能删除");
    return;
  }
  view.dispatch({
    changes: {
      from: state.doc.line(block.start).from,
      to: state.doc.line(block.end).to,
      insert: next.join("\n"),
    },
  });
  view.focus();
}

const TEXT_ACTIONS: ToolbarAction[] = [
  { label: "B", title: "加粗", apply: (v) => wrap(v, "**") },
  { label: "I", title: "斜体", apply: (v) => wrap(v, "*") },
  { label: "S", title: "删除线", apply: (v) => wrap(v, "~~") },
  { label: "高", title: "高亮", apply: (v) => wrap(v, "==") },
  { label: "</>", title: "行内代码", apply: (v) => wrap(v, "`") },
  { label: "H1", title: "标题 1", apply: (v) => toggleLinePrefix(v, "# ") },
  { label: "H2", title: "标题 2", apply: (v) => toggleLinePrefix(v, "## ") },
  { label: "H3", title: "标题 3", apply: (v) => toggleLinePrefix(v, "### ") },
  { label: "H4", title: "标题 4", apply: (v) => toggleLinePrefix(v, "#### ") },
  { label: "引", title: "引用", apply: (v) => toggleLinePrefix(v, "> ") },
  { label: "办", title: "待办", apply: (v) => toggleLinePrefix(v, "- [ ] ") },
  { label: "链", title: "插入链接", apply: (v, app) => applyLink(v, app) },
  { label: "色", title: "文字颜色", apply: (v, app) => applyColor(v, app) },
];

const TOOLBAR_HEIGHT = 40;
const TOOLBAR_GAP = 8;

type ToolbarContext = "text" | "table";

class YuqueToolbar {
  private dom: HTMLElement;
  private host: HTMLElement;
  private context: ToolbarContext | null = null;
  private onScroll = (): void => this.reposition();

  constructor(
    protected view: EditorView,
    private isEnabled: () => boolean,
    private app: App,
  ) {
    // cm-scroller 是编辑器的滚动容器，作为工具栏的定位参照
    this.host = view.scrollDOM;
    this.host.style.position = "relative";
    this.dom = createEl("div", { cls: "yuque-toolbar" });
    // mousedown + preventDefault：避免点击按钮时编辑器失焦、选区丢失
    this.dom.addEventListener("mousedown", (e) => e.preventDefault());
    this.dom.style.display = "none";
    this.host.appendChild(this.dom);
    // 编辑区滚动时让工具栏跟随选区（而不是钉死在原地）
    this.host.addEventListener("scroll", this.onScroll, { passive: true });
  }

  update(update: ViewUpdate): void {
    if (update.selectionSet || update.docChanged || update.focusChanged || update.viewportChanged) {
      this.reposition();
    }
  }

  private hide(): void {
    this.dom.style.display = "none";
  }

  /** 该显示哪种形态；null = 不显示 */
  private detectContext(): ToolbarContext | null {
    const { state } = this.view;
    const sel = state.selection.main;
    if (!sel.empty) return "text";
    // 无选区时只有「光标在表格内」才出工具栏，避免光标一动就弹一条挡住内容
    const info = state.doc.lineAt(sel.head);
    if (!info.text.includes("|")) return null;
    const src: LineSource = { count: state.doc.lines, at: (n) => state.doc.line(n).text };
    return locateTable(src, info.number, sel.head - info.from) ? "table" : null;
  }

  private buildButtons(context: ToolbarContext): void {
    this.dom.empty();
    const buttons: { label: string; title: string; run: () => void }[] =
      context === "text"
        ? TEXT_ACTIONS.map((a) => ({
            label: a.label,
            title: a.title,
            run: () => a.apply(this.view, this.app),
          }))
        : TABLE_ACTIONS.map((a) => ({
            label: a.label,
            title: a.title,
            run: () => applyTable(this.view, a.op),
          }));
    for (const item of buttons) {
      const btn = this.dom.createEl("button", {
        cls: "yuque-toolbar-btn",
        text: item.label,
        attr: { "aria-label": item.title, title: item.title },
      });
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        item.run();
      });
    }
  }

  private reposition(): void {
    try {
      const context = this.isEnabled() && this.view.hasFocus ? this.detectContext() : null;
      if (!context) {
        this.context = null;
        this.hide();
        return;
      }
      // 形态切换时才重建按钮，避免每次滚动都重排 DOM
      if (context !== this.context) {
        this.buildButtons(context);
        this.context = context;
      }

      const sel = this.view.state.selection.main;
      const start = this.view.coordsAtPos(sel.from);
      const end = this.view.coordsAtPos(sel.to);
      if (!start || !end) {
        this.hide();
        return;
      }
      const hostRect = this.host.getBoundingClientRect();
      const selectionTop = Math.min(start.top, end.top);
      const selectionCenterX =
        (Math.min(start.left, end.left) + Math.max(start.right, end.right)) / 2;

      this.dom.style.display = "flex";
      const top =
        selectionTop - hostRect.top + this.host.scrollTop - TOOLBAR_HEIGHT - TOOLBAR_GAP;
      const rawLeft =
        selectionCenterX - hostRect.left + this.host.scrollLeft - this.dom.offsetWidth / 2;
      const left = Math.min(
        Math.max(rawLeft, 4),
        Math.max(this.host.clientWidth - this.dom.offsetWidth - 4, 4),
      );
      this.dom.style.top = `${Math.max(top, 4)}px`;
      this.dom.style.left = `${left}px`;
    } catch {
      this.hide();
    }
  }

  destroy(): void {
    this.host.removeEventListener("scroll", this.onScroll);
    this.dom.remove();
  }
}

export function buildYuqueToolbar(isEnabled: () => boolean, app: App): ViewPlugin<YuqueToolbar> {
  return ViewPlugin.fromClass(
    class extends YuqueToolbar {
      constructor(view: EditorView) {
        super(view, isEnabled, app);
      }
    },
  );
}
