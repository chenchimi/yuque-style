import {
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  Notice,
  TFile,
} from "obsidian";
import type { YuqueStylePlugin } from "./main";
import { filterSlashItems, ITEMS, type SlashItem } from "./slash-items";

/**
 * 语雀式斜杠菜单：
 * 在编辑器中输入 "/" 后弹出块插入菜单（可用拼音 / 关键词过滤），
 * 选择后在当前位置插入对应的 Markdown 块。
 * 条目表与过滤逻辑在 slash-items.ts（那边不依赖 obsidian，便于单测）。
 */
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
    return filterSlashItems(ITEMS, context.query);
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
    const text = item.resolve
      ? item.resolve({ file: ctx.file, app: this.plugin.app })
      : item.insert;
    if (text === null) {
      new Notice(item.emptyHint ?? "无法插入该内容");
      return;
    }

    const editor = ctx.editor;
    const startOffset = editor.posToOffset(ctx.start);
    editor.replaceRange(text, ctx.start, ctx.end);

    // 有占位文本时选中它，用户直接打字即可替换
    if (item.selectText) {
      const at = text.indexOf(item.selectText);
      if (at >= 0) {
        editor.setSelection(
          editor.offsetToPos(startOffset + at),
          editor.offsetToPos(startOffset + at + item.selectText.length),
        );
        return;
      }
    }
    editor.setCursor(editor.offsetToPos(startOffset + text.length - item.cursorBack));
  }
}
