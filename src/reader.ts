import { MarkdownView, TFile, debounce } from "obsidian";
import type { YuqueStylePlugin } from "./main";
import { readFm } from "./yuque/frontmatter";

/**
 * 阅读模式增强（语雀风格）：
 * - 文档头：标题 + 字数 / 预计阅读时长 / 创建日期 / 标签（读取 frontmatter）
 * - 排版：配合 styles.css 呈现语雀式版式（居中栏宽、卡片化引用等）
 * 注：文档目录不再自研，交给 Obsidian 原生「大纲」核心插件（自带滚动联动高亮）
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
    // 注意：Obsidian 的 getMode() 对「实时预览」和「源码模式」都返回 "source"，
    // 得靠 getState().source 区分（true = 源码模式，false = 实时预览）
    const viewState = view.getState() as { source?: boolean } | null;
    const isLivePreview = mode === "source" && viewState?.source !== true;
    const key = `${view.file?.path ?? ""}|${mode}`;

    // 标题编号：阅读 + 实时预览都生效
    const applyHeadingNum = (el: HTMLElement, isPreview: boolean) => {
      el.classList.toggle("yuque-heading-num", s.reader && s.headingNumbers);
      let hasH1: boolean;
      if (isPreview) {
        hasH1 = Array.from(el.querySelectorAll<HTMLElement>("h1")).some(
          (h) => !h.closest(".yuque-doc-header"),
        );
      } else {
        // 实时预览：CM6 标题行为 .HyperMD-header-1
        hasH1 = el.querySelector(".HyperMD-header-1") !== null;
      }
      el.classList.toggle("yuque-heading-num-no-h1", s.reader && s.headingNumbers && !hasH1);
    };
    if (previewEl) applyHeadingNum(previewEl, true);
    if (sourceEl) applyHeadingNum(sourceEl, false);

    // 排版收口在实时预览同样生效；源码模式不套版式，避免干扰纯文本编辑。
    // 这里只加一个类，具体样式全部在 styles.css 里，不碰 CodeMirror 的 DOM。
    if (sourceEl) sourceEl.classList.toggle("yuque-reader", s.reader && isLivePreview);

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
        (h) => !h.closest(".yuque-doc-header"),
      );
      if (!hasH1) previewEl.classList.add("yuque-heading-num-no-h1");
    }
    if (s.showDocHeader) this.injectHeader(view, previewEl);
  }

  private cleanup(container: HTMLElement): void {
    container.classList.remove("yuque-reader");
    container.classList.remove("yuque-heading-num");
    container.classList.remove("yuque-heading-num-no-h1");
    container.querySelectorAll(".yuque-doc-header").forEach((n) => n.remove());
  }

  private injectHeader(view: MarkdownView, container: HTMLElement): void {
    const file: TFile | null = view.file;
    if (!file) return;
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    // 属性键名统一中文，用 readFm 读以兼容尚未迁移的存量文档
    const fm = cache?.frontmatter as Record<string, unknown> | undefined;

    const header = createEl("div", { cls: "yuque-doc-header" });
    // 正文自带 h1 时不再注入标题，否则页面上会出现两个一模一样的标题
    const bodyHasH1 = Array.from(container.querySelectorAll<HTMLElement>("h1")).some(
      (h) => !h.closest(".yuque-doc-header"),
    );
    if (bodyHasH1) {
      header.classList.add("yuque-doc-header-no-title");
    } else {
      header.createEl("h1", {
        cls: "yuque-doc-title",
        text: String(readFm<string>(fm, "title") ?? file.basename),
      });
    }

    const meta = createEl("div", { cls: "yuque-doc-meta" });
    // 元信息全放在同一个 then 里，保证显示顺序稳定（字数与时长需要正文）
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
      this.appendYuqueDate(meta, "创建于", readFm(fm, "createdAt"));
      this.appendYuqueDate(meta, "更新于", readFm(fm, "updatedAt"));
      // 读的是同步写下的「语雀标签」；旧实现读 frontmatter.tags，
      // 而同步从来不写这个键，所以标签区一直没渲染过任何东西
      for (const tag of listFrontmatterTags(readFm(fm, "tags")).slice(0, 8)) {
        meta.createSpan({ cls: "yuque-tag", text: tag });
      }
    });

    header.appendChild(meta);
    container.insertBefore(header, container.firstChild);
  }

  /**
   * 追加「创建于 / 更新于」。
   * 只认 frontmatter 里的语雀时间：缺失或无法解析就整项不显示。
   * （旧实现拿 file.stat.ctime 显示成「创建于」——那其实是本地文件的创建时间，
   * 也就是「第一次同步下来的日子」，属于错误信息；宁可不显示也不显示错的。）
   */
  private appendYuqueDate(el: HTMLElement, label: string, raw: unknown): void {
    if (typeof raw !== "string" || !raw.trim()) return;
    const at = window.moment(raw.trim());
    if (!at.isValid()) return;
    el.createSpan({ text: `${label} ${at.format("YYYY-MM-DD")}` });
  }
}

/** 语雀标签既可能是 YAML 列表，也可能是单个字符串，统一成数组 */
function listFrontmatterTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean);
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  return [];
}
