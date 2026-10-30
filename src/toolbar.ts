import { Notice } from "obsidian";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { applyTableOp, locateTable, type LineSource, type TableOp } from "./table";

/**
 * 语雀风格**表格工具条**：光标停在表格内且没有选区时，在表格上方浮出一条
 * 插行 / 删行 / 插列 / 删列 的小工具条。
 *
 * 这里原本还有一条「选中文本就弹出格式工具条」（加粗 / 标题 / 引用 / 待办 / 链接 / 颜色…）。
 * v0.8.0 起删掉了：那些动作已全部并入文档顶部的固定工具栏，两处都弹等于同一屏出现
 * 两条功能重复的工具栏（还各占一层遮挡）。表格工具条保留，因为它提供的是
 * **顶部工具栏没有的、上下文独有的操作**，且只在光标进入表格时才出现。
 */

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

const TOOLBAR_HEIGHT = 40;
const TOOLBAR_GAP = 8;

class YuqueTableToolbar {
  private dom: HTMLElement;
  private host: HTMLElement;
  private onScroll = (): void => this.reposition();

  constructor(protected view: EditorView) {
    // cm-scroller 是编辑器的滚动容器，作为工具条的定位参照
    this.host = view.scrollDOM;
    this.host.style.position = "relative";
    this.dom = createEl("div", { cls: "yuque-toolbar" });
    // mousedown + preventDefault：避免点击按钮时编辑器失焦、选区丢失
    this.dom.addEventListener("mousedown", (e) => e.preventDefault());
    this.dom.style.display = "none";
    this.host.appendChild(this.dom);
    this.buildButtons();
    // 编辑区滚动时让工具条跟随表格（而不是钉死在原地）
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

  /** 按钮集合固定，构造时建一次，滚动与选区变化只挪位置、不重排 DOM */
  private buildButtons(): void {
    for (const item of TABLE_ACTIONS) {
      const btn = this.dom.createEl("button", {
        cls: "yuque-toolbar-btn",
        text: item.label,
        attr: { "aria-label": item.title, title: item.title },
      });
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        applyTable(this.view, item.op);
      });
    }
  }

  /** 光标在表格内、且没有选区时才显示（有选区说明用户在选文字，不该挡着） */
  private isInTable(): boolean {
    const { state } = this.view;
    const sel = state.selection.main;
    if (!sel.empty) return false;
    const info = state.doc.lineAt(sel.head);
    if (!info.text.includes("|")) return false;
    const src: LineSource = { count: state.doc.lines, at: (n) => state.doc.line(n).text };
    return locateTable(src, info.number, sel.head - info.from) !== null;
  }

  private reposition(): void {
    try {
      if (!this.view.hasFocus || !this.isInTable()) {
        this.hide();
        return;
      }
      const sel = this.view.state.selection.main;
      const at = this.view.coordsAtPos(sel.head);
      if (!at) {
        this.hide();
        return;
      }
      const hostRect = this.host.getBoundingClientRect();
      this.dom.style.display = "flex";
      const top = at.top - hostRect.top + this.host.scrollTop - TOOLBAR_HEIGHT - TOOLBAR_GAP;
      const rawLeft =
        at.left - hostRect.left + this.host.scrollLeft - this.dom.offsetWidth / 2;
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

export function buildTableToolbar(): ViewPlugin<YuqueTableToolbar> {
  return ViewPlugin.fromClass(
    class extends YuqueTableToolbar {
      constructor(view: EditorView) {
        super(view);
      }
    },
  );
}
