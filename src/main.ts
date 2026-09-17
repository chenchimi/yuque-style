import { Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFolder } from "obsidian";
import { ReaderEnhancer } from "./reader";
import { YuqueSlashSuggest } from "./slash";
import { buildYuqueToolbar } from "./toolbar";
import { YuqueApi } from "./yuque/api";
import type { ColorMode } from "./yuque/lake";
import { syncTask } from "./yuque/sync";
import { addSyncTaskFlow, diagnoseFlow, runWithSyncModal, syncAllFlow } from "./yuque/ui";
import { relinkFlow } from "./yuque/relink";
import { cleanColorsFlow } from "./yuque/clean";
import {
  buildPropertyVisibilityCss,
  hiddenSlugsFor,
  hidesWholePanel,
  PROPERTY_TOGGLES,
} from "./yuque/frontmatter";
import { backfillFlow } from "./yuque/backfill";
import { applyRename, migrateSyncState } from "./yuque/state";
import type { YuqueSyncState } from "./yuque/state";

export interface YuqueSyncTask {
  repoId: number;
  namespace: string;
  repoName: string;
  /** 仓库内目标文件夹（vault 相对路径，空 = 根目录） */
  targetFolder: string;
  mode: "all" | "selected";
  selectedDocs: { slug: string; title: string }[];
}

export interface YuqueSettings {
  toolbar: boolean;
  slashMenu: boolean;
  reader: boolean;
  showDocHeader: boolean;
  showReadingTime: boolean;
  contentWidth: number;
  /** 正文宽度跟随窗口（忽略 contentWidth，正文铺满可用宽度） */
  contentWidthAuto: boolean;
  /** 阅读模式下标题自动数字编号（1 / 1.1 / 1.1.1） */
  headingNumbers: boolean;
  // ---- 语雀同步 ----
  yuqueToken: string;
  yuqueTasks: YuqueSyncTask[];
  yuqueDownloadImages: boolean;
  yuqueAssetsFolder: string;
  /**
   * 属性面板里要隐藏的语雀属性（slug 见 PROPERTY_TOGGLES）。
   * 注意：属性始终写在文件里，这里只控制它在文档顶部显不显示。
   */
  yuqueHiddenProps: string[];
  /** 语雀彩色文字怎么落到 Markdown：drop 纯文本 / highlight 转 ==高亮== / keep 保留 span */
  yuqueTextColor: ColorMode;
  /** 覆盖写入前，若检测到本地文件已被用户修改，先备份一份 */
  yuqueBackupOnConflict: boolean;
  /** 文档同步状态：`${namespace}/${slug}` → 结构化同步记录（含本地路径） */
  yuqueSyncState: YuqueSyncState;
}

export const DEFAULT_SETTINGS: YuqueSettings = {
  toolbar: true,
  slashMenu: true,
  reader: true,
  showDocHeader: true,
  showReadingTime: true,
  contentWidth: 820,
  contentWidthAuto: false,
  headingNumbers: true,
  yuqueToken: "",
  yuqueTasks: [],
  yuqueDownloadImages: true,
  yuqueAssetsFolder: "assets",
  yuqueHiddenProps: [],
  // 默认不输出颜色：Obsidian 实时预览不渲染内联 HTML，输出 span 只会在编辑模式下露出源码
  yuqueTextColor: "drop",
  yuqueBackupOnConflict: true,
  yuqueSyncState: {},
};

/** 承载「隐藏笔记属性」规则的 <style> 元素 id */
const HIDDEN_PROPS_STYLE_ID = "yuque-hidden-properties";

export default class YuqueStylePlugin extends Plugin {
  settings: YuqueSettings = { ...DEFAULT_SETTINGS };
  reader!: ReaderEnhancer;

  async onload(): Promise<void> {
    await this.loadSettings();
    // 版本标识：控制台可查（Ctrl+Shift+I），用于确认加载的是最新代码
    console.log(`[yuque-style] loaded v${this.manifest.version}`);

    // ---- 编辑器：悬浮格式工具栏 ----
    this.registerEditorExtension(buildYuqueToolbar(() => this.settings.toolbar, this.app));

    // ---- 编辑器：语雀式斜杠菜单（输入 "/" 唤起块插入）----
    this.registerEditorSuggest(new YuqueSlashSuggest(this));

    // ---- 阅读模式：文档头 / 排版 ----
    this.reader = new ReaderEnhancer(this);
    this.reader.register();

    this.applyCssVars();
    this.applyPropertyVisibility();
    this.addSettingTab(new YuqueSettingTab(this));

    // ---- 语雀风格内容块快捷插入 ----
    this.addCommand({
      id: "insert-callout",
      name: "插入卡片块（语雀标注）",
      editorCallback: (editor) => {
        editor.replaceSelection("> [!note] 卡片标题\n> 在这里填写卡片内容。\n\n");
      },
    });

    this.addCommand({
      id: "insert-todo",
      name: "插入待办清单",
      editorCallback: (editor) => {
        editor.replaceSelection(
          "- [ ] 待办事项一\n- [ ] 待办事项二\n- [ ] 待办事项三\n",
        );
      },
    });

    this.addCommand({
      id: "insert-table",
      name: "插入表格",
      editorCallback: (editor) => {
        editor.replaceSelection(
          "| 列名 | 列名 | 列名 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n| 内容 | 内容 | 内容 |\n",
        );
      },
    });

    this.addCommand({
      id: "toggle-reader-enhance",
      name: "开启 / 关闭阅读增强",
      callback: async () => {
        this.settings.reader = !this.settings.reader;
        await this.saveSettings();
        this.reader.refresh(true);
        new Notice(this.settings.reader ? "阅读增强已开启" : "阅读增强已关闭");
      },
    });

    // ---- 语雀 → Obsidian 同步 ----
    this.addRibbonIcon("refresh-cw", "同步语雀文档", () => syncAllFlow(this));

    this.addCommand({
      id: "yuque-sync-all",
      name: "语雀同步：立即同步全部任务",
      callback: () => syncAllFlow(this),
    });

    this.addCommand({
      id: "yuque-sync-add",
      name: "语雀同步：添加/更新同步任务（选知识库、文档与目标路径）",
      callback: () => addSyncTaskFlow(this),
    });

    this.addCommand({
      id: "yuque-diagnose",
      name: "语雀同步：诊断（排查拉取为空等问题）",
      callback: () => diagnoseFlow(this),
    });

    this.addCommand({
      id: "yuque-clean-colors",
      name: "语雀同步：清理文字颜色标记（本地，不重新下载）",
      callback: () => cleanColorsFlow(this),
    });

    this.addCommand({
      id: "yuque-relink",
      name: "语雀同步：重建内部链接（本地，不重新下载）",
      callback: () => relinkFlow(this),
    });

    this.addCommand({
      id: "yuque-backfill-metadata",
      name: "语雀同步：补齐文档属性（并把旧键名迁移为中文）",
      callback: () => backfillFlow(this),
    });

    // 本地重命名 / 移动后让同步记录跟随，否则下一轮会找不到原文件而重复创建
    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        this.handleRename(file, oldPath);
      }),
    );
  }

  /** 文件被重命名或移动时，同步更新同步记录里的本地路径 */
  handleRename(file: TAbstractFile, oldPath: string): void {
    if (!file || !oldPath) return;
    const state = this.settings.yuqueSyncState;
    if (!state) return;
    // applyRename 原地修改；返回空表示未命中任何已跟踪文件
    if (applyRename(state, oldPath, file.path, file instanceof TFolder).length === 0) return;
    void this.saveSettings();
  }

  onunload(): void {
    // 清理注入到 DOM 的元素，避免插件停用后残留
    document.querySelectorAll(".yuque-doc-header").forEach((n) => n.remove());
    document
      .querySelectorAll(".yuque-reader")
      .forEach((n) => n.classList.remove("yuque-reader"));
    document.documentElement.style.removeProperty("--yuque-content-width");
    document.body.classList.remove("yuque-width-auto");
    document.body.classList.remove("yuque-hide-all-props");
    document.getElementById(HIDDEN_PROPS_STYLE_ID)?.remove();
  }

  /**
   * 把「笔记属性」的隐藏规则写进一个 <style>。
   * 用 CSS 而不是"不写入文件"：属性要一直存在（文档头、双链索引、Dataview 都依赖它），
   * 只是不占版面。源码模式下的 YAML 原文属于文本内容，隐藏不了。
   */
  applyPropertyVisibility(): void {
    // 「文档头信息」是总开关：关掉它，笔记属性也一并隐藏（下面的逐个开关此时不起作用）
    const configured = this.settings.yuqueHiddenProps || [];
    const hidden = hiddenSlugsFor(this.settings.showDocHeader, configured);
    // 全隐藏时连属性面板的容器一起收起，否则只剩一个「笔记属性」标题与「+ 添加」按钮
    const hidePanel = hidesWholePanel(this.settings.showDocHeader, configured);
    document.body.classList.toggle("yuque-hide-all-props", hidePanel);
    const css = buildPropertyVisibilityCss(hidden, hidePanel);
    let el = document.getElementById(HIDDEN_PROPS_STYLE_ID) as HTMLStyleElement | null;
    if (!css) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement("style");
      el.id = HIDDEN_PROPS_STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = css;
  }

  applyCssVars(): void {
    document.documentElement.style.setProperty(
      "--yuque-content-width",
      `${this.settings.contentWidth}px`,
    );
    // 跟随窗口宽度只靠变量做不到：Obsidian 自带「可读行宽」会在内容层再夹一层，
    // 所以挂个类，在 CSS 里把内外两层上限一起放开
    document.body.classList.toggle("yuque-width-auto", this.settings.contentWidthAuto);
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<YuqueSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    // 旧版本只存 updated_at 字符串，此处统一升级为结构化记录（幂等，可重复执行）
    this.settings.yuqueSyncState = migrateSyncState(this.settings.yuqueSyncState);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.applyCssVars();
    this.applyPropertyVisibility();
  }
}

export { YuqueStylePlugin };

class YuqueSettingTab extends PluginSettingTab {
  private plugin: YuqueStylePlugin;

  constructor(plugin: YuqueStylePlugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    containerEl.createEl("h2", { text: "语雀风格编辑与阅读" });

    new Setting(containerEl)
      .setName("悬浮格式工具栏")
      .setDesc("编辑器中选中文本时，在选区上方弹出语雀式格式工具栏")
      .addToggle((t) =>
        t.setValue(s.toolbar).onChange(async (v) => {
          s.toolbar = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("斜杠快捷菜单")
      .setDesc("编辑时输入 \"/\" 弹出语雀式块插入菜单（标题 / 卡片 / 待办 / 表格等）")
      .addToggle((t) =>
        t.setValue(s.slashMenu).onChange(async (v) => {
          s.slashMenu = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("阅读增强")
      .setDesc("阅读模式下启用文档头与语雀式排版")
      .addToggle((t) =>
        t.setValue(s.reader).onChange(async (v) => {
          s.reader = v;
          await this.plugin.saveSettings();
          this.plugin.reader.refresh(true);
        }),
      );

    new Setting(containerEl)
      .setName("文档头信息")
      .setDesc(
        "在文档顶部展示标题、字数、阅读时长、创建日期与标签；" +
          "关闭后连下面的笔记属性也一起隐藏（总开关）",
      )
      .addToggle((t) =>
        t.setValue(s.showDocHeader).onChange(async (v) => {
          s.showDocHeader = v;
          await this.plugin.saveSettings();
          this.plugin.reader.refresh(true);
          // 重绘：让下面的笔记属性开关跟着禁用/启用
          this.display();
        }),
      );

    // 笔记属性：属性始终写在文件里，这里只控制它在文档顶部的属性面板显不显示。
    // 用「一个下拉 + 逐项切换」而不是铺五行 toggles，设置页太长了
    const effective = new Set(hiddenSlugsFor(s.showDocHeader, s.yuqueHiddenProps || []));
    new Setting(containerEl)
      .setName("笔记属性")
      .setDesc(
        s.showDocHeader
          ? "点开选择要隐藏（或恢复）的属性：属性仍写在文件里，不影响读取、双链与其它插件；" +
              "全部隐藏时文档顶部的属性面板会整块收起"
          : "「文档头信息」已关闭，笔记属性当前全部隐藏；打开上面的总开关后再单独调整",
      )
      .addDropdown((d) => {
        d.addOption("__summary__", `当前：隐藏 ${effective.size} / ${PROPERTY_TOGGLES.length} 个`);
        d.addOption("__show_all__", "全部显示");
        d.addOption("__hide_all__", "全部隐藏");
        for (const prop of PROPERTY_TOGGLES) {
          const state = effective.has(prop.slug) ? "已隐藏" : "已显示";
          d.addOption(prop.slug, `${state}：${prop.label}`);
        }
        d.setValue("__summary__").setDisabled(!s.showDocHeader);
        d.onChange(async (v) => {
          if (v === "__summary__") return; // 只是当前状态的显示，不改变任何设置
          const next = new Set(s.yuqueHiddenProps || []);
          if (v === "__show_all__") next.clear();
          else if (v === "__hide_all__") PROPERTY_TOGGLES.forEach((p) => next.add(p.slug));
          else if (next.has(v)) next.delete(v);
          else next.add(v);
          s.yuqueHiddenProps = [...next];
          await this.plugin.saveSettings();
          this.display(); // 重绘：下拉里每项的「已显示/已隐藏」与统计都要跟着更新
        });
      });

    new Setting(containerEl)
      .setName("预计阅读时长")
      .setDesc("按每分钟 400 字估算")
      .addToggle((t) =>
        t.setValue(s.showReadingTime).onChange(async (v) => {
          s.showReadingTime = v;
          await this.plugin.saveSettings();
          this.plugin.reader.refresh(true);
        }),
      );

    new Setting(containerEl)
      .setName("标题自动编号")
      .setDesc("阅读模式下为标题显示层级数字编号（1 / 1.1 / 1.1.1）；文档自带的编号不受影响")
      .addToggle((t) =>
        t.setValue(s.headingNumbers).onChange(async (v) => {
          s.headingNumbers = v;
          await this.plugin.saveSettings();
          this.plugin.reader.refresh(true);
        }),
      );

    new Setting(containerEl)
      .setName("跟随窗口宽度")
      .setDesc("正文铺满可用宽度、忽略下面的栏宽值；会一并放开 Obsidian 自带「可读行宽」的限制")
      .addToggle((t) =>
        t.setValue(s.contentWidthAuto).onChange(async (v) => {
          s.contentWidthAuto = v;
          await this.plugin.saveSettings();
          this.display(); // 重绘，让下面的栏宽滑块跟着禁用/启用
        }),
      );

    new Setting(containerEl)
      .setName("正文栏宽")
      .setDesc(
        "阅读模式与实时预览下的正文宽度（像素）。600-900 最利于阅读，调宽适合表格、代码较多的文档",
      )
      .addSlider((sl) => {
        sl.setLimits(600, 1600, 20)
          .setValue(s.contentWidth)
          .setDynamicTooltip()
          .setDisabled(s.contentWidthAuto)
          .onChange(async (v) => {
            s.contentWidth = v;
            await this.plugin.saveSettings();
          });
      });

    // ================ 语雀同步 ================
    containerEl.createEl("h2", { text: "语雀文档同步" });

    new Setting(containerEl)
      .setName("语雀 Token")
      .setDesc("在语雀网页「账号设置 → 开发者 → Token」创建，需要「读取知识库、文档」权限")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("填入语雀 Token")
          .setValue(s.yuqueToken)
          .onChange(async (v) => {
            s.yuqueToken = v.trim();
            await this.plugin.saveSettings();
          });
      })
      .addButton((b) =>
        b.setButtonText("测试连接").onClick(async () => {
          if (!s.yuqueToken) {
            new Notice("请先填写 Token");
            return;
          }
          b.setDisabled(true);
          try {
            const user = await new YuqueApi(s.yuqueToken).getUser();
            new Notice(`连接成功：${user?.name ?? user?.login ?? "已认证"}`);
          } catch (e) {
            new Notice(`连接失败：${(e as Error).message}`);
          } finally {
            b.setDisabled(false);
          }
        }),
      );

    new Setting(containerEl)
      .setName("同步任务")
      .setDesc("每个任务可选择目标文件夹；同步时按语雀更新时间增量拉取")
      .addButton((b) =>
        b.setButtonText("添加任务").setCta().onClick(() => {
          addSyncTaskFlow(this.plugin);
        }),
      );

    if (!s.yuqueTasks || s.yuqueTasks.length === 0) {
      containerEl.createEl("p", {
        text: "还没有同步任务。点击「添加任务」，或使用命令「语雀同步：添加/更新同步任务」。",
        cls: "setting-item-description",
      });
    } else {
      for (const task of s.yuqueTasks) {
        const desc =
          task.mode === "all"
            ? "整个知识库"
            : `指定文档 ${task.selectedDocs.length} 篇`;
        const taskSetting = new Setting(containerEl)
          .setName(task.repoName)
          .setDesc(
            `${task.namespace} · ${desc} · 目标：${task.targetFolder || "仓库根目录"}`,
          );
        taskSetting.addButton((b) =>
          b.setButtonText("立即同步").onClick(() => {
            runWithSyncModal(this.plugin, `同步「${task.repoName}」`, async (log) => {
              await syncTask(this.plugin, new YuqueApi(s.yuqueToken), task, log);
            });
          }),
        );
        taskSetting.addButton((b) =>
          b.setButtonText("删除").onClick(async () => {
            s.yuqueTasks = s.yuqueTasks.filter((t) => t !== task);
            await this.plugin.saveSettings();
            this.display();
          }),
        );
      }
    }

    new Setting(containerEl)
      .setName("图片本地化")
      .setDesc("同步时把语雀 CDN 图片下载到仓库内，避免外链失效")
      .addToggle((t) =>
        t.setValue(s.yuqueDownloadImages).onChange(async (v) => {
          s.yuqueDownloadImages = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("图片存放文件夹")
      .setDesc("位于每个同步任务的目标文件夹之下")
      .addText((t) =>
        t.setPlaceholder("assets")
          .setValue(s.yuqueAssetsFolder)
          .onChange(async (v) => {
            s.yuqueAssetsFolder = v.trim() || "assets";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("文字颜色")
      .setDesc(
        "语雀彩色文字怎么落到 Markdown。Obsidian 的实时预览不渲染内联 HTML：" +
          "选「保留颜色」时编辑模式下会看到 span 源码；想让编辑与阅读都不见源码，" +
          "就选「不输出」或「转高亮」。已同步文档里的旧标记用命令「清理文字颜色标记」处理",
      )
      .addDropdown((d) => {
        d.addOption("drop", "不输出颜色（纯文本）");
        d.addOption("highlight", "转为高亮 ==文字==");
        d.addOption("keep", "保留颜色（仅阅读模式渲染）");
        d.setValue(s.yuqueTextColor || "drop").onChange(async (v) => {
          s.yuqueTextColor = v as ColorMode;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("本地改动冲突时备份")
      .setDesc("覆盖前若检测到本地文件已被修改，先备份到 .yuque-backups/（每篇保留最近 5 份）")
      .addToggle((t) =>
        t.setValue(s.yuqueBackupOnConflict).onChange(async (v) => {
          s.yuqueBackupOnConflict = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("清除增量同步记录")
      .setDesc("下次同步将强制重新拉取全部文档（本地文件不会被删除）")
      .addButton((b) =>
        b.setButtonText("清除").onClick(async () => {
          s.yuqueSyncState = {};
          await this.plugin.saveSettings();
          new Notice("已清除同步记录，下次将全量拉取");
        }),
      );
  }
}
