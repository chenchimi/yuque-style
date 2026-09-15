import { EditorSelection } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

/**
 * 语雀风格悬浮格式工具栏：
 * 选中文本时在选区上方弹出，提供加粗 / 斜体 / 删除线 / 高亮 /
 * 行内代码 / 标题 / 引用 / 待办 等一键排版操作。
 * 注意：仅在编辑模式（实时预览 / 源码模式）生效，阅读模式下不出现。
 */

interface ToolbarAction {
  label: string;
  title: string;
  apply: (view: EditorView) => void;
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

const ACTIONS: ToolbarAction[] = [
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
];

const TOOLBAR_HEIGHT = 40;
const TOOLBAR_GAP = 8;

class YuqueToolbar {
  private dom: HTMLElement;
  private host: HTMLElement;
  private onScroll = (): void => this.reposition();

  constructor(protected view: EditorView, private isEnabled: () => boolean) {
    // cm-scroller 是编辑器的滚动容器，作为工具栏的定位参照
    this.host = view.scrollDOM;
    this.host.style.position = "relative";
    this.dom = createEl("div", { cls: "yuque-toolbar" });
    // mousedown + preventDefault：避免点击按钮时编辑器失焦、选区丢失
    this.dom.addEventListener("mousedown", (e) => e.preventDefault());
    for (const action of ACTIONS) {
      const btn = this.dom.createEl("button", {
        cls: "yuque-toolbar-btn",
        text: action.label,
        attr: { "aria-label": action.title, title: action.title },
      });
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        action.apply(this.view);
        this.view.focus();
        this.reposition();
      });
    }
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

  private reposition(): void {
    try {
      const sel = this.view.state.selection.main;
      if (!this.isEnabled() || sel.empty || !this.view.hasFocus) {
        this.hide();
        return;
      }
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

export function buildYuqueToolbar(isEnabled: () => boolean): ViewPlugin<YuqueToolbar> {
  return ViewPlugin.fromClass(
    class extends YuqueToolbar {
      constructor(view: EditorView) {
        super(view, isEnabled);
      }
    },
  );
}
