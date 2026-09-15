import { Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { ReaderEnhancer } from "./reader";
import { YuqueSlashSuggest } from "./slash";
import { buildYuqueToolbar } from "./toolbar";
import { YuqueApi } from "./yuque/api";
import { syncTask } from "./yuque/sync";
import { addSyncTaskFlow, diagnoseFlow, runWithSyncModal, syncAllFlow } from "./yuque/ui";

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
  showOutline: boolean;
  showReadingTime: boolean;
  contentWidth: number;
  /** 阅读模式下标题自动数字编号（1 / 1.1 / 1.1.1） */
  headingNumbers: boolean;
  // ---- 语雀同步 ----
  yuqueToken: string;
  yuqueTasks: YuqueSyncTask[];
  yuqueDownloadImages: boolean;
  yuqueAssetsFolder: string;
  /** 文档同步状态：`${namespace}/${slug}` → updated_at，用于增量同步 */
  yuqueSyncState: Record<string, string>;
}

export const DEFAULT_SETTINGS: YuqueSettings = {
  toolbar: true,
  slashMenu: true,
  reader: true,
  showDocHeader: true,
  showOutline: false,
  showReadingTime: true,
  contentWidth: 820,
  headingNumbers: true,
  yuqueToken: "",
  yuqueTasks: [],
  yuqueDownloadImages: true,
  yuqueAssetsFolder: "assets",
  yuqueSyncState: {},
};

export default class YuqueStylePlugin extends Plugin {
  settings: YuqueSettings = { ...DEFAULT_SETTINGS };
  reader!: ReaderEnhancer;

  async onload(): Promise<void> {
    await this.loadSettings();
    // 版本标识：控制台可查（Ctrl+Shift+I），用于确认加载的是最新代码
    console.log(`[yuque-style] loaded v${this.manifest.version}`);

    // ---- 编辑器：悬浮格式工具栏 ----
    this.registerEditorExtension(buildYuqueToolbar(() => this.settings.toolbar));

    // ---- 编辑器：语雀式斜杠菜单（输入 "/" 唤起块插入）----
    this.registerEditorSuggest(new YuqueSlashSuggest(this));

    // ---- 阅读模式：文档头 / 目录 / 排版 ----
    this.reader = new ReaderEnhancer(this);
    this.reader.register();

    this.applyCssVars();
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
      id: "toggle-outline",
      name: "显示 / 隐藏文档目录",
      callback: () => this.reader.toggleOutline(),
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
  }

  onunload(): void {
    // 清理注入到 DOM 的元素，避免插件停用后残留
    document
      .querySelectorAll(".yuque-doc-header, .yuque-outline")
      .forEach((n) => n.remove());
    document
      .querySelectorAll(".yuque-reader")
      .forEach((n) => n.classList.remove("yuque-reader"));
    document.documentElement.style.removeProperty("--yuque-content-width");
  }

  applyCssVars(): void {
    document.documentElement.style.setProperty(
      "--yuque-content-width",
      `${this.settings.contentWidth}px`,
    );
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.applyCssVars();
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
      .setDesc("阅读模式下启用文档头、目录与语雀式排版")
      .addToggle((t) =>
        t.setValue(s.reader).onChange(async (v) => {
          s.reader = v;
          await this.plugin.saveSettings();
          this.plugin.reader.refresh(true);
        }),
      );

    new Setting(containerEl)
      .setName("文档头信息")
      .setDesc("在文档顶部展示标题、字数、阅读时长、创建日期与标签")
      .addToggle((t) =>
        t.setValue(s.showDocHeader).onChange(async (v) => {
          s.showDocHeader = v;
          await this.plugin.saveSettings();
          this.plugin.reader.refresh(true);
        }),
      );

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
      .setName("浮动目录")
      .setDesc("阅读模式下在右侧显示本文目录卡片")
      .addToggle((t) =>
        t.setValue(s.showOutline).onChange(async (v) => {
          s.showOutline = v;
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
      .setName("正文栏宽")
      .setDesc("阅读模式下正文内容宽度（像素）")
      .addSlider((sl) =>
        sl
          .setLimits(600, 1100, 20)
          .setValue(s.contentWidth)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.contentWidth = v;
            await this.plugin.saveSettings();
          }),
      );

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
