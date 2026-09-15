import { MarkdownView, Notice, Plugin, TFile, debounce } from "obsidian";
import type { YuqueStylePlugin } from "./main";

/**
 * 阅读模式增强（语雀风格）：
 * - 文档头：标题 + 字数 / 预计阅读时长 / 创建日期 / 标签（读取 frontmatter）
 * - 浮动目录：提取 h1-h3 生成右侧目录卡片，点击平滑滚动定位
 * - 排版：配合 styles.css 呈现语雀式版式（居中栏宽、卡片化引用等）
 */
export class ReaderEnhancer {
  private lastKey = "";

  constructor(private plugin: YuqueStylePlugin) {}

  register(): void {
    const refresh = debounce(() => this.refresh(), 400);
    const { workspace } = this.plugin.app;

    this.plugin.registerEvent(workspace.on("active-leaf-change", () => { refresh(); }));
    this.plugin.registerEvent(workspace.on("layout-change", () => { refresh(); }));
    // 每次 markdown 渲染回调时也刷新一次，保证切到预览模式能及时装饰
    this.plugin.registerMarkdownPostProcessor(() => { refresh(); });
    // 兜底轮询：视图/文件/模式变化后自动补装饰，无变化时开销极小
    this.plugin.registerInterval(window.setInterval(() => this.refresh(), 1500));
  }

  /** force = true 时无视缓存强制重新装饰 */
  refresh(force = false): void {
    if (force) this.lastKey = "";
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const s = this.plugin.settings;

    // 阅读模式容器 与 实时预览/源码容器 都要处理
    const previewEl = view.contentEl.querySelector(".markdown-preview-view") as HTMLElement | null;
    const sourceEl = view.contentEl.querySelector(".markdown-source-view") as HTMLElement | null;
    const mode = view.getMode();
    const key = `${view.file?.path ?? ""}|${mode}`;

    // 标题编号：阅读 + 实时预览都生效
    const applyHeadingNum = (el: HTMLElement, isPreview: boolean) => {
      el.classList.toggle("yuque-heading-num", s.reader && s.headingNumbers);
      let hasH1: boolean;
      if (isPreview) {
        hasH1 = Array.from(el.querySelectorAll<HTMLElement>("h1")).some(
          (h) => !h.closest(".yuque-doc-header") && !h.closest(".yuque-outline"),
        );
      } else {
        // 实时预览：CM6 标题行为 .HyperMD-header-1
        hasH1 = el.querySelector(".HyperMD-header-1") !== null;
      }
      el.classList.toggle("yuque-heading-num-no-h1", s.reader && s.headingNumbers && !hasH1);
    };
    if (previewEl) applyHeadingNum(previewEl, true);
    if (sourceEl) applyHeadingNum(sourceEl, false);

    if (!s.reader || mode !== "preview" || !previewEl) {
      if (previewEl) this.cleanup(previewEl);
      this.lastKey = "";
      return;
    }
    if (key === this.lastKey) return;
    this.lastKey = key;

    this.cleanup(previewEl);
    previewEl.classList.add("yuque-reader");
    if (s.headingNumbers) {
      previewEl.classList.add("yuque-heading-num");
      const hasH1 = Array.from(previewEl.querySelectorAll<HTMLElement>("h1")).some(
        (h) => !h.closest(".yuque-doc-header") && !h.closest(".yuque-outline"),
      );
      if (!hasH1) previewEl.classList.add("yuque-heading-num-no-h1");
    }
    if (s.showDocHeader) this.injectHeader(view, previewEl);
    if (s.showOutline) this.injectOutline(previewEl);
  }

  private cleanup(container: HTMLElement): void {
    container.classList.remove("yuque-reader");
    container.classList.remove("yuque-heading-num");
    container.classList.remove("yuque-heading-num-no-h1");
    container.querySelectorAll(".yuque-doc-header, .yuque-outline").forEach((n) => n.remove());
  }

  private injectHeader(view: MarkdownView, container: HTMLElement): void {
    const file: TFile | null = view.file;
    if (!file) return;
    const cache = this.plugin.app.metadataCache.getFileCache(file);

    const header = createEl("div", { cls: "yuque-doc-header" });
    header.createEl("h1", {
      cls: "yuque-doc-title",
      text: String(cache?.frontmatter?.title ?? file.basename),
    });

    const meta = createEl("div", { cls: "yuque-doc-meta" });
    void this.plugin.app.vault.cachedRead(file).then((content: string) => {
      const plain = content
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/[#>*_`~|\[\]()!-]/g, " ");
      const words = plain.replace(/\s+/g, "").length;
      meta.createSpan({ text: `${words} 字` });
      if (this.plugin.settings.showReadingTime) {
        const minutes = Math.max(1, Math.round(words / 400));
        meta.createSpan({ text: `约 ${minutes} 分钟读完` });
      }
      meta.createSpan({
        text: `创建于 ${window.moment(file.stat.ctime).format("YYYY-MM-DD")}`,
      });
    });

    const tags = cache?.frontmatter?.tags;
    if (Array.isArray(tags)) {
      for (const t of tags.slice(0, 8)) {
        meta.createSpan({ cls: "yuque-tag", text: String(t) });
      }
    }

    header.appendChild(meta);
    container.insertBefore(header, container.firstChild);
  }

  private injectOutline(container: HTMLElement): void {
    const headings = Array.from(
      container.querySelectorAll<HTMLElement>("h1, h2, h3"),
    ).filter((h) => !h.closest(".yuque-doc-header") && !h.closest(".yuque-outline"));
    if (headings.length === 0) return;

    const outline = createEl("div", { cls: "yuque-outline" });
    outline.createEl("div", { cls: "yuque-outline-title", text: "本文目录" });
    const list = outline.createEl("div", { cls: "yuque-outline-list" });
    for (const h of headings) {
      const item = list.createEl("a", {
        cls: `yuque-outline-item yuque-outline-${h.tagName.toLowerCase()}`,
        text: h.textContent ?? "",
      });
      item.addEventListener("click", (e) => {
        e.preventDefault();
        h.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
    container.appendChild(outline);
  }

  toggleOutline(): void {
    const outline = document.querySelector(
      ".markdown-preview-view .yuque-outline",
    ) as HTMLElement | null;
    if (outline) {
      outline.classList.toggle("yuque-outline-hidden");
    } else {
      new Notice("当前没有可用的文档目录");
    }
  }
}
