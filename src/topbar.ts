/**
 * 文档顶部的语雀式交互区域：**固定工具栏 + 元信息行**。
 *
 * 为什么放在 `.view-content` 的第一个子节点，而不是塞进正文里做 sticky：
 * 编辑区的滚动发生在内部的 `.cm-scroller`（阅读模式是 `.markdown-preview-view`），
 * 只要把这条放在滚动容器**外面**、让内容区变成纵向 flex，它就天然「滚动时始终可见」，
 * 既不依赖 `position: sticky`（在嵌套滚动容器里行为难以预测），也不用改 CodeMirror 的 DOM。
 *
 * 与既有功能的分工（排查后做的整合）：
 * - 「悬浮格式工具栏」：动作集合与顶栏重复，但它是**跟随选区**的另一套交互。顶栏把动作全收齐后，
 *   两者共用同一份动作内核（rich-actions.ts），设置里可按需关掉其中一个；
 * - 「文档头信息」：阅读模式没有编辑器，顶栏只在编辑模式出现，阅读模式的元信息仍由它承担，
 *   这样同一屏不会出现两套标题；
 * - 「预计阅读时长」：顶栏的「阅读时长」位直接跟随该设置，不再新开一个开关；
 * - 斜杠菜单：块插入条目（卡片块 / 折叠块 / 目录块 / 表格…）通过顶栏的「插入」下拉复用同一份定义。
 */

import { Editor, MarkdownView, Menu, Notice, setIcon, TFile } from "obsidian";
import type { YuqueStylePlugin } from "./main";
import {
  clearFormatting,
  insertBlockAtCursor,
  insertLink,
  paragraphStyleLabel,
  paragraphStyleOf,
  PARAGRAPH_STYLES,
  setParagraphStyle,
  setTextColor,
  toggleList,
  toggleWrap,
  wrapCodeBlock,
  type EditPlan,
  type ParagraphStyle,
  type Snapshot,
} from "./rich-actions";
import {
  countWords,
  formatRelativeTime,
  formatWordCount,
  readingMinutes,
  syncBadge,
} from "./doc-meta";
import { applySlashItem, ColorModal, LinkModal } from "./rich-ui";
import { ITEMS } from "./slash-items";
import { readFm } from "./yuque/frontmatter";

const BAR_CLS = "yuque-topbar";
/** 内容区挂上它之后才变成「上工具条 + 下编辑区」的纵向 flex */
const HOST_CLS = "yuque-has-topbar";
const COLLAPSED_CLS = "yuque-topbar-collapsed";
const HIDDEN_CLS = "yuque-topbar-hidden";

/** 两次完整元信息刷新之间的最小间隔；期间只更新相对时间，避免每次轮询都重排 DOM */
const FULL_META_INTERVAL = 15_000;

export function snapshotOf(editor: Editor): Snapshot {
  const lines: string[] = [];
  const count = editor.lineCount();
  for (let i = 0; i < count; i++) lines.push(editor.getLine(i));
  const from = editor.getCursor("from");
  const to = editor.getCursor("to");
  return {
    lines,
    from: { line: from.line, ch: from.ch },
    to: { line: to.line, ch: to.ch },
  };
}

/**
 * 把一份编辑计划落到 Obsidian 的 Editor 上。
 *
 * 编辑**从后往前**应用：计划里的坐标都是相对原始文本算的，倒序应用后，
 * 前面编辑的位置就不会被后面的改动带偏。
 */
export function applyPlan(editor: Editor, plan: EditPlan): void {
  if (plan.edits.length === 0) return;
  const ordered = [...plan.edits].sort(
    (a, b) => b.from.line - a.from.line || b.from.ch - a.from.ch,
  );
  for (const edit of ordered) editor.replaceRange(edit.text, edit.from, edit.to);
  if (plan.selection) editor.setSelection(plan.selection.from, plan.selection.to);
}

interface ToolButton {
  icon?: string;
  label?: string;
  title: string;
  onClick: (evt: MouseEvent) => void;
}

export class YuqueTopBar {
  readonly el: HTMLElement;
  private readonly toolsEl: HTMLElement;
  private readonly toolsScrollEl: HTMLElement;
  private readonly metaEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly chipsEl: HTMLElement;
  private readonly styleBtn: HTMLButtonElement;
  private timeValueEl: HTMLElement | null = null;
  private collapsed = false;
  private words: number | null = null;
  /** 字数缓存键：`路径|mtime`，文件一改就重算 */
  private wordsKey = "";
  private lastFullMeta = 0;
  private mounted = false;

  constructor(
    private plugin: YuqueStylePlugin,
    private view: MarkdownView,
  ) {
    this.el = createEl("div", { cls: BAR_CLS });
    // 工具栏分两层：外层放「收起」按钮（不参与横向滚动），内层才是可滚动的按钮排。
    // 窄屏 / 移动端上按钮排横向滚动，而不是换行把顶栏撑成两行
    this.toolsEl = this.el.createDiv({ cls: "yuque-topbar-tools" });
    this.toolsScrollEl = this.toolsEl.createDiv({ cls: "yuque-topbar-tools-scroll" });
    this.metaEl = this.el.createDiv({ cls: "yuque-topbar-meta" });
    this.titleEl = this.metaEl.createDiv({ cls: "yuque-topbar-title" });
    this.chipsEl = this.metaEl.createDiv({ cls: "yuque-topbar-chips" });

    this.styleBtn = this.buildTools();
    this.buildCollapseButton();
    this.updateStyleButton();
  }

  // ---------------- 挂载 ----------------

  mount(host: HTMLElement): void {
    if (this.mounted && this.el.parentElement === host) {
      this.refresh();
      return;
    }
    host.classList.add(HOST_CLS);
    host.insertBefore(this.el, host.firstChild);
    this.mounted = true;
    this.refresh(true);
  }

  destroy(): void {
    this.el.parentElement?.classList.remove(HOST_CLS);
    this.el.remove();
    this.mounted = false;
  }

  /** 轮询里的轻量刷新：补挂（若被清掉）+ 模式类名 + 相对时间 */
  tick(): void {
    // 编辑/阅读模式互切时 Obsidian 会重建内容区，顶栏可能被一起清掉；这里补挂回去
    if (this.mounted && this.el.parentElement !== this.view.contentEl) {
      this.mount(this.view.contentEl);
    }
    this.refresh(false);
  }

  // ---------------- 工具栏 ----------------

  private buildTools(): HTMLButtonElement {
    const add = (opts: ToolButton): HTMLButtonElement => {
      const btn = this.toolsScrollEl.createEl("button", {
        cls: "yuque-topbar-btn",
        attr: { title: opts.title, "aria-label": opts.title },
      });
      if (opts.icon) setIcon(btn, opts.icon);
      else if (opts.label) btn.setText(opts.label);
      // mousedown + preventDefault：点按钮不能把编辑器的焦点与选区抢走，
      // 否则「选中文字 → 点加粗」会先丢选区再执行，等于没选中（旧悬浮栏踩过同一个坑）
      btn.addEventListener("mousedown", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        opts.onClick(evt);
      });
      return btn;
    };
    const sep = (): void => {
      this.toolsScrollEl.createDiv({ cls: "yuque-topbar-sep" });
    };

    // 撤销 / 重做走 Editor 自己的历史栈：不自己实现，否则撤销粒度与 Obsidian 对不上
    add({ icon: "undo-2", title: "撤销", onClick: () => this.runEditor((e) => e.undo()) });
    add({ icon: "redo-2", title: "重做", onClick: () => this.runEditor((e) => e.redo()) });
    sep();

    // 段落样式（正文 / 标题 1-6 / 引用块）——语雀那一栏「正文 ▾」
    const styleBtn = add({
      label: "正文",
      title: "段落样式",
      onClick: (evt) => this.openStyleMenu(evt),
    });
    styleBtn.addClass("yuque-topbar-style");
    sep();

    add({ icon: "bold", title: "加粗", onClick: () => this.runPlan((s2) => toggleWrap(s2, "**")) });
    add({ icon: "italic", title: "斜体", onClick: () => this.runPlan((s2) => toggleWrap(s2, "*")) });
    add({
      icon: "strikethrough",
      title: "删除线",
      onClick: () => this.runPlan((s2) => toggleWrap(s2, "~~")),
    });
    add({
      icon: "underline",
      title: "下划线",
      onClick: () => this.runPlan((s2) => toggleWrap(s2, "<u>", "</u>")),
    });
    add({
      icon: "highlighter",
      title: "高亮",
      onClick: () => this.runPlan((s2) => toggleWrap(s2, "==")),
    });
    add({ icon: "code", title: "行内代码", onClick: () => this.runPlan((s2) => toggleWrap(s2, "`")) });
    add({ icon: "palette", title: "文字颜色", onClick: () => this.openColorModal() });
    add({
      icon: "eraser",
      title: "清除格式",
      onClick: () => this.runPlan((s2) => clearFormatting(s2), "请先选中要清除格式的文字"),
    });
    sep();

    add({
      icon: "list",
      title: "无序列表",
      onClick: () => this.runPlan((s2) => toggleList(s2, "bullet")),
    });
    add({
      icon: "list-ordered",
      title: "有序列表",
      onClick: () => this.runPlan((s2) => toggleList(s2, "ordered")),
    });
    add({
      icon: "list-checks",
      title: "待办清单",
      onClick: () => this.runPlan((s2) => toggleList(s2, "task")),
    });
    add({
      icon: "quote",
      title: "引用块",
      onClick: () =>
        this.runPlan((s2) => {
          // 再点一次取消引用：与其它开关型按钮的行为保持一致
          const style = paragraphStyleOf(s2.lines[s2.from.line] ?? "");
          return setParagraphStyle(s2, style === "quote" ? "body" : "quote");
        }),
    });
    add({ icon: "braces", title: "代码块", onClick: () => this.runPlan((s2) => wrapCodeBlock(s2)) });
    add({
      icon: "minus",
      title: "分割线",
      onClick: () => this.runPlan((s2) => insertBlockAtCursor(s2, "---")),
    });
    sep();

    add({ icon: "link", title: "插入链接", onClick: () => this.openLinkModal() });
    add({
      icon: "plus",
      title: "插入内容块（卡片 / 折叠 / 目录 / 表格…）",
      onClick: (evt) => this.openInsertMenu(evt),
    });

    return styleBtn;
  }

  private buildCollapseButton(): void {
    const btn = this.toolsEl.createEl("button", {
      cls: "yuque-topbar-collapse",
      attr: { title: "收起 / 展开工具栏", "aria-label": "收起 / 展开工具栏" },
    });
    setIcon(btn, "chevron-up");
    btn.addEventListener("mousedown", (evt) => evt.preventDefault());
    btn.addEventListener("click", () => {
      this.collapsed = !this.collapsed;
      this.el.classList.toggle(COLLAPSED_CLS, this.collapsed);
      setIcon(btn, this.collapsed ? "chevron-down" : "chevron-up");
    });
  }

  /** 直接在编辑器上执行的动作（撤销 / 重做） */
  private runEditor(run: (editor: Editor) => void): void {
    const editor = this.view.editor;
    if (!editor) return;
    run(editor);
    editor.focus();
  }

  private runPlan(compute: (s: Snapshot) => EditPlan | null, emptyHint?: string): void {
    const editor = this.view.editor;
    if (!editor) return;
    const plan = compute(snapshotOf(editor));
    if (!plan || plan.edits.length === 0) {
      if (emptyHint) new Notice(emptyHint);
      return;
    }
    applyPlan(editor, plan);
    this.updateStyleButton();
    editor.focus();
  }

  private openStyleMenu(evt: MouseEvent): void {
    const editor = this.view.editor;
    const current = editor
      ? paragraphStyleOf(editor.getLine(editor.getCursor().line))
      : ("body" as ParagraphStyle);
    const menu = new Menu();
    for (const style of PARAGRAPH_STYLES) {
      menu.addItem((item) =>
        item
          .setTitle(style.label)
          .setChecked(style.id === current)
          .onClick(() => this.runPlan((s) => setParagraphStyle(s, style.id))),
      );
    }
    menu.showAtMouseEvent(evt);
  }

  private openColorModal(): void {
    const editor = this.view.editor;
    if (!editor) return;
    new ColorModal(this.plugin.app, (color) => {
      const plan = setTextColor(snapshotOf(editor), color);
      if (!plan) {
        new Notice("请先选中要上色的文字");
        return;
      }
      applyPlan(editor, plan);
      editor.focus();
    }).open();
  }

  private openLinkModal(): void {
    const editor = this.view.editor;
    if (!editor) return;
    const hasText = editor.getSelection().length > 0;
    new LinkModal(this.plugin.app, hasText, (url) => {
      if (!url) return;
      applyPlan(editor, insertLink(snapshotOf(editor), url));
      editor.focus();
    }).open();
  }

  /** 「插入」下拉：直接复用斜杠菜单的条目定义，两个入口不会各写一份块语法 */
  private openInsertMenu(evt: MouseEvent): void {
    const menu = new Menu();
    for (const item of ITEMS.filter((it) => !it.keywordOnly)) {
      menu.addItem((mi) =>
        mi.setTitle(item.name).onClick(() => {
          const editor = this.view.editor;
          if (!editor) return;
          applySlashItem({
            app: this.plugin.app,
            editor,
            item,
            file: this.view.file,
          });
          this.updateStyleButton();
          editor.focus();
        }),
      );
    }
    menu.showAtMouseEvent(evt);
  }

  /** 光标所在行的段落样式回显到下拉按钮上（语雀那栏也是这么显示的） */
  private updateStyleButton(): void {
    const editor = this.view.editor;
    if (!editor) return;
    const style = paragraphStyleOf(editor.getLine(editor.getCursor().line));
    this.styleBtn.setText(paragraphStyleLabel(style));
  }

  // ---------------- 元信息行 ----------------

  private updateMode(): void {
    const mode = this.view.getMode();
    const editing = mode === "source" && !!this.view.file;
    // 阅读模式不显示：那边有「文档头信息」，同一屏不该出现两套标题与元信息
    this.el.classList.toggle(HIDDEN_CLS, !this.plugin.settings.topBar || !editing);
  }

  refresh(force = false): void {
    this.updateMode();
    const now = Date.now();
    if (!force && now - this.lastFullMeta < FULL_META_INTERVAL) {
      this.updateRelativeTime(now);
      return;
    }
    this.lastFullMeta = now;
    void this.refreshMeta(now);
  }

  /** 只改「最近编辑」那一格的文字，轮询时用它，避免每次重建整行 DOM */
  private updateRelativeTime(now: number): void {
    const file = this.view.file;
    if (!file || !this.timeValueEl) return;
    this.timeValueEl.setText(formatRelativeTime(file.stat.mtime, now));
  }

  private async refreshMeta(now: number): Promise<void> {
    const file: TFile | null = this.view.file;
    if (!file) {
      this.titleEl.setText("");
      this.chipsEl.empty();
      this.timeValueEl = null;
      return;
    }
    const fm = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter as
      | Record<string, unknown>
      | undefined;

    this.titleEl.setText(String(readFm<string>(fm, "title") ?? file.basename));

    const chips = this.chipsEl;
    chips.empty();
    this.timeValueEl = null;

    const chip = (label: string, value: string, cls = ""): HTMLElement => {
      const el = chips.createDiv({ cls: `yuque-topbar-chip ${cls}`.trim() });
      if (label) el.createSpan({ cls: "yuque-topbar-chip-label", text: label });
      return el.createSpan({ cls: "yuque-topbar-chip-value", text: value });
    };

    chip("最近编辑", formatRelativeTime(file.stat.mtime, now));

    // 字数与阅读时长：缓存在 wordsKey 上，文件没改就不重读
    const key = `${file.path}|${file.stat.mtime}`;
    if (this.words === null || this.wordsKey !== key) {
      const content = await this.plugin.app.vault.cachedRead(file);
      // 异步返回时用户可能已经切走了，别把旧文档的数字写进新文档的行里
      if (this.view.file !== file) return;
      this.words = countWords(content);
      this.wordsKey = key;
    }
    const words = this.words ?? 0;
    chip("", formatWordCount(words), "yuque-topbar-chip-plain");
    chip("", `约 ${readingMinutes(words)} 分钟读完`, "yuque-topbar-chip-plain");

    // 「协作状态」：这套工作流里它就是语雀同步状态（见 doc-meta.syncBadge）
    const badge = syncBadge(readFm(fm, "source"), readFm(fm, "updatedAt"));
    const syncEl = chips.createDiv({
      cls: `yuque-topbar-chip yuque-topbar-sync is-${badge.kind}`,
      attr: badge.url ? { title: "打开语雀原文" } : {},
    });
    syncEl.createSpan({ cls: "yuque-topbar-dot" });
    const textEl = syncEl.createSpan({ cls: "yuque-topbar-chip-value", text: badge.text });
    if (badge.url) {
      syncEl.addClass("is-clickable");
      const url = badge.url;
      syncEl.addEventListener("click", () => window.open(url, "_blank"));
      textEl.addClass("yuque-topbar-link");
    }
  }
}

/**
 * 顶栏的挂载管理：为每个 markdown 视图补一条，并跟随布局变化清理已关闭的视图。
 * 事件面开得比较全（layout-change / active-leaf-change / file-open / 定时轮询）是因为
 * 模式切换、拆分窗格、移动端抽屉都不会统一触发某一个事件，靠单一事件必然漏。
 */
export class TopBarManager {
  private readonly bars = new Map<MarkdownView, YuqueTopBar>();

  constructor(private plugin: YuqueStylePlugin) {}

  register(): void {
    const { workspace, vault, metadataCache } = this.plugin.app;
    this.plugin.registerEvent(workspace.on("layout-change", () => this.sync()));
    this.plugin.registerEvent(workspace.on("active-leaf-change", () => this.sync()));
    this.plugin.registerEvent(workspace.on("file-open", () => this.sync()));
    this.plugin.registerEvent(vault.on("modify", (f) => this.onFileChanged(f.path)));
    this.plugin.registerEvent(metadataCache.on("changed", (f) => this.onFileChanged(f.path)));
    this.plugin.registerInterval(window.setInterval(() => this.tick(), 1500));
    this.sync();
  }

  /** 补挂缺失的顶栏、清掉已关闭视图上的顶栏 */
  sync(): void {
    const live = new Set<MarkdownView>();
    if (this.plugin.settings.topBar) {
      for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
        const view = leaf.view as MarkdownView;
        // 不用 instanceof：视图类型在跨窗口/移动端下并不总是同一个构造器
        if (!view || typeof view.getMode !== "function") continue;
        live.add(view);
        let bar = this.bars.get(view);
        if (!bar) {
          bar = new YuqueTopBar(this.plugin, view);
          this.bars.set(view, bar);
        }
        bar.mount(view.contentEl);
      }
    }
    for (const [view, bar] of [...this.bars]) {
      if (live.has(view)) continue;
      bar.destroy();
      this.bars.delete(view);
    }
  }

  /** 插件卸载：把已插进内容区的顶栏全部摘掉，不留残留 DOM */
  destroyAll(): void {
    for (const bar of this.bars.values()) bar.destroy();
    this.bars.clear();
  }

  /** 设置变化后强制刷新（开关、元信息、阅读时长等都可能变） */
  refresh(force = true): void {
    this.sync();
    for (const bar of this.bars.values()) bar.refresh(force);
  }

  private tick(): void {
    if (!this.plugin.settings.topBar) return;
    for (const bar of this.bars.values()) bar.tick();
  }

  private onFileChanged(path: string): void {
    for (const [view, bar] of this.bars) {
      if (view.file?.path === path) bar.refresh(true);
    }
  }
}
