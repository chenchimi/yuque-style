import { Notice } from "obsidian";
import type { Editor } from "obsidian";
import type { YuqueStylePlugin } from "./main";
import {
  clearFormatting,
  insertBlockAtCursor,
  paragraphStyleOf,
  setParagraphStyle,
  toggleList,
  toggleWrap,
  wrapCodeBlock,
  type EditPlan,
  type Snapshot,
} from "./rich-actions";
import { applyPlan, snapshotOf } from "./topbar";

/**
 * 把顶栏的高频格式动作注册为命令。
 *
 * 为什么：Obsidian 的快捷键体系只认命令，而此前这些动作只有顶栏按钮一个入口——
 * 键盘党想按 Ctrl+Shift+H 加高亮，无处可绑。动作内核本就是共享的纯函数
 * （rich-actions.ts，与顶栏、斜杠菜单同源），这里只是再包一层命令壳，
 * 不会出现第三套实现。
 *
 * 不注册的：撤销/重做（Obsidian 自带）、段落样式与插入块（菜单型，命令没有意义）、
 * 链接与文字颜色（需要弹窗交互，顶栏入口已够用）。
 */
interface CommandDef {
  id: string;
  name: string;
  run: (s: Snapshot) => EditPlan | null;
  /** 计划为空（如没选中文字）时的提示 */
  hint?: string;
}

const DEFS: CommandDef[] = [
  { id: "bold", name: "加粗", run: (s) => toggleWrap(s, "**") },
  { id: "italic", name: "斜体", run: (s) => toggleWrap(s, "*") },
  { id: "strikethrough", name: "删除线", run: (s) => toggleWrap(s, "~~") },
  { id: "underline", name: "下划线", run: (s) => toggleWrap(s, "<u>", "</u>") },
  { id: "highlight", name: "高亮", run: (s) => toggleWrap(s, "==") },
  { id: "inline-code", name: "行内代码", run: (s) => toggleWrap(s, "`") },
  {
    id: "clear-format",
    name: "清除格式",
    run: (s) => clearFormatting(s),
    hint: "请先选中要清除格式的文字",
  },
  { id: "bullet-list", name: "无序列表", run: (s) => toggleList(s, "bullet") },
  { id: "ordered-list", name: "有序列表", run: (s) => toggleList(s, "ordered") },
  { id: "task-list", name: "待办清单", run: (s) => toggleList(s, "task") },
  {
    id: "quote",
    name: "引用块（再按一次取消）",
    run: (s) => {
      // 与顶栏按钮一致：再点一次取消引用
      const style = paragraphStyleOf(s.lines[s.from.line] ?? "");
      return setParagraphStyle(s, style === "quote" ? "body" : "quote");
    },
  },
  { id: "code-block", name: "代码块", run: (s) => wrapCodeBlock(s) },
  { id: "hr", name: "分割线", run: (s) => insertBlockAtCursor(s, "---") },
];

export function registerEditorCommands(plugin: YuqueStylePlugin): void {
  for (const def of DEFS) {
    plugin.addCommand({
      id: `yuque-fmt-${def.id}`,
      name: `语雀编辑：${def.name}`,
      editorCallback: (editor: Editor) => {
        const plan = def.run(snapshotOf(editor));
        if (!plan || plan.edits.length === 0) {
          if (def.hint) new Notice(def.hint);
          return;
        }
        applyPlan(editor, plan);
        editor.focus();
      },
    });
  }
}
