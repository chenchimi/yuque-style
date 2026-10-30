/**
 * 共用的插入与弹窗件：斜杠菜单、顶部工具栏、悬浮工具栏都从这里取。
 *
 * 之前链接弹窗与颜色色板只写在悬浮工具栏里，顶部工具栏要同样的能力就得抄一份——
 * 抄出来的两套 UI 会各自演化（颜色板加一个色、两边不同步）。这里收成一份。
 */

import { App, Editor, EditorPosition, Modal, Notice, Setting, TFile } from "obsidian";
import type { SlashItem } from "./slash-items";

/**
 * 文字颜色色板。
 * 用 `<span style="color:…">`，与同步侧「语雀彩色文字 → span」保持同一语法，
 * 免得同步下来的颜色和手写的颜色是两套写法。
 * 刻意不含纯黑：深色主题下黑字等于隐形。
 */
export const TEXT_COLORS: ReadonlyArray<{ name: string; value: string }> = [
  { name: "红", value: "#e53935" },
  { name: "橙", value: "#fb8c00" },
  { name: "黄", value: "#f9a825" },
  { name: "绿", value: "#43a047" },
  { name: "青", value: "#00acc1" },
  { name: "蓝", value: "#1e88e5" },
  { name: "紫", value: "#8e24aa" },
  { name: "灰", value: "#757575" },
];

export class LinkModal extends Modal {
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
    new Setting(this.contentEl).addButton((b) => b.setButtonText("插入").setCta().onClick(submit));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class ColorModal extends Modal {
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

/**
 * 执行一个块插入条目（斜杠菜单与顶部工具栏的「插入」下拉共用同一套落地逻辑）。
 *
 * start / end 只有斜杠菜单需要（要吃掉触发的 "/xxx"）；顶部工具栏不传，
 * 此时把选区收成光标、**在光标处插入而不覆盖已选文本**——按钮点错一下不至于吃掉整段话。
 *
 * @returns false 表示该条目当前不可用（例如文档还没有标题，生成不了目录）
 */
export function applySlashItem(args: {
  app: App;
  editor: Editor;
  item: SlashItem;
  file: TFile | null;
  start?: EditorPosition;
  end?: EditorPosition;
}): boolean {
  const { app, editor, item, file } = args;
  const text = item.resolve ? item.resolve({ file, app }) : item.insert;
  if (text === null) {
    new Notice(item.emptyHint ?? "无法插入该内容");
    return false;
  }

  const start = args.start ?? args.end ?? editor.getCursor();
  const end = args.end ?? start;
  const startOffset = editor.posToOffset(start);
  editor.replaceRange(text, start, end);

  // 有占位文本时选中它，用户直接打字即可替换
  if (item.selectText) {
    const at = text.indexOf(item.selectText);
    if (at >= 0) {
      editor.setSelection(
        editor.offsetToPos(startOffset + at),
        editor.offsetToPos(startOffset + at + item.selectText.length),
      );
      return true;
    }
  }
  editor.setCursor(editor.offsetToPos(startOffset + text.length - item.cursorBack));
  return true;
}
