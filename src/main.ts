import { Notice, Plugin, TAbstractFile, TFolder } from "obsidian";
import { ReaderEnhancer } from "./reader";
import { YuqueSlashSuggest } from "./slash";
import { buildTableToolbar } from "./toolbar";
import { YuqueApi, type YuqueRateInfo } from "./yuque/api";
import {
  emptyRateLog,
  migrateRateLog,
  recordResponse,
  type RateLog,
} from "./yuque/rate";
import type { ColorMode } from "./yuque/lake";
import { addSyncTaskFlow, diagnoseFlow, manageTasksFlow, syncAllFlow } from "./yuque/ui";
import { relinkFlow } from "./yuque/relink";
import { cleanColorsFlow } from "./yuque/clean";
import {
  buildPropertyVisibilityCss,
  hiddenSlugsFor,
  hidesWholePanel,
} from "./yuque/frontmatter";
import { backfillFlow } from "./yuque/backfill";
import { orphanCleanupFlow } from "./yuque/orphan";
import { TopBarManager } from "./topbar";
import { registerEditorCommands } from "./editor-commands";
import {
  buildHiddenFolderCss,
  clearHiddenFolderNodes,
  markHiddenFolderNodes,
} from "./yuque/explorer";
import {
  clearSyncedDocNodes,
  markSyncedDocNodes,
  syncedDocPaths,
} from "./yuque/explorer-sync";
import { applyRename, migrateSyncState } from "./yuque/state";
import type { YuqueSyncState } from "./yuque/state";
import { loadSettingsWithMigration } from "./settings";
import { YuqueSettingTab } from "./settings-tab";

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
  /** 文档顶部的固定工具栏与元信息行（编辑模式）；元信息随它一起开 */
  topBar: boolean;
  slashMenu: boolean;
  reader: boolean;
  /** 阅读模式文档头（标题 / 字数 / 阅读时长 / 语雀时间 / 标签）总开关 */
  showDocHeader: boolean;
  contentWidth: number;
  /** 正文宽度跟随窗口（忽略 contentWidth，正文铺满可用宽度） */
  contentWidthAuto: boolean;
  /** 阅读模式下标题自动数字编号（1 / 1.1 / 1.1.1） */
  headingNumbers: boolean;
  // ---- 语雀同步 ----
  yuqueToken: string;
  yuqueTasks: YuqueSyncTask[];
  /**
   * 启动后自动执行一次「同步全部任务」（延迟触发，复用手动同步的弹窗与停止按钮）。
   * 默认关闭：自动消耗 API 配额的事不该替用户做主，尤其语雀的网关惩罚态难以预期。
   */
  yuqueAutoSyncOnStart: boolean;
  yuqueDownloadImages: boolean;
  yuqueAssetsFolder: string;
  /**
   * 在文件浏览器中隐藏上面的图片文件夹。
   * 只是视觉隐藏：目录与图片仍在仓库里，正文的图片引用与渲染不受影响。
   */
  yuqueHideAssetsFolder: boolean;
  /**
   * 在文件浏览器里给语雀同步文档的行尾加一个小圆点。
   * 同步状态此前只在 topbar 元信息行里可见，必须打开文档才知道；圆点让目录一眼可辨。
   */
  yuqueMarkSyncedDocs: boolean;
  /**
   * 属性面板里要隐藏的语雀属性（slug 见 PROPERTY_TOGGLES）。
   * 注意：属性始终写在文件里，这里只控制它在文档顶部显不显示。
   */
  yuqueHiddenProps: string[];
  /** 语雀彩色文字怎么落到 Markdown：drop 纯文本 / highlight 转 ==高亮== / keep 保留 span */
  yuqueTextColor: ColorMode;
  /** 覆盖写入前，若检测到本地文件已被用户修改，先备份一份 */
  yuqueBackupOnConflict: boolean;
  /**
   * 每次同步最多发多少次 API 请求。0 = 自动：
   * 能读到 `X-RateLimit-Remaining` 就按剩余额度走，读不到就不限（只保留 429 熔断）。
   * 上限只在**任务边界**生效——额度不够跑完下一个库就不开跑，不会把某个库拉一半。
   */
  yuqueRequestBudget: number;
  /** 配额观测记录：本小时请求数 + 429 时间线 + 观测门槛（见 yuque/rate.ts） */
  yuqueRateLog: RateLog;
  /** 文档同步状态：`${namespace}/${slug}` → 结构化同步记录（含本地路径） */
  yuqueSyncState: YuqueSyncState;
}

export const DEFAULT_SETTINGS: YuqueSettings = {
  topBar: true,
  slashMenu: true,
  reader: true,
  showDocHeader: true,
  contentWidth: 820,
  contentWidthAuto: false,
  headingNumbers: true,
  yuqueToken: "",
  yuqueTasks: [],
  yuqueAutoSyncOnStart: false,
  yuqueDownloadImages: true,
  yuqueAssetsFolder: "assets",
  yuqueHideAssetsFolder: true,
  yuqueMarkSyncedDocs: true,
  yuqueHiddenProps: [],
  // 默认不输出颜色：Obsidian 实时预览不渲染内联 HTML，输出 span 只会在编辑模式下露出源码
  yuqueTextColor: "drop",
  yuqueBackupOnConflict: true,
  // 默认「自动」而不是某个数字：语雀的额度不透明（官方称 5000/小时且返回 X-RateLimit-*，
  // 但实测 429 上见不到该头），拿官方数字当预算等于用一把没量过自己的尺子限速
  yuqueRequestBudget: 0,
  yuqueRateLog: emptyRateLog(),
  yuqueSyncState: {},
};

/** 承载「隐藏笔记属性」规则的 <style> 元素 id */
const HIDDEN_PROPS_STYLE_ID = "yuque-hidden-properties";
/** 承载「文件浏览器中隐藏图片文件夹」规则的 <style> 元素 id */
const HIDDEN_FOLDERS_STYLE_ID = "yuque-hidden-folders";

/**
 * 启动自动同步的延迟。
 * Obsidian 启动本身就在忙索引与首屏渲染，同步的第一批请求不该跟它抢启动窗口；
 * 15 秒后用户多半已经落座，此时弹出的同步进度也看得见、随时可停。
 */
const AUTO_SYNC_DELAY_MS = 15_000;

/**
 * 配额观测量最多每 2 秒落盘一次。
 * 一次全量同步会发两千多次请求，逐次 saveData 是在折磨磁盘；而观测量的价值只在
 * 「跨会话仍在」这一点上，晚两秒写没有任何损失。撞上 429 是例外——立即落盘。
 */
const RATE_SAVE_INTERVAL_MS = 2000;

export default class YuqueStylePlugin extends Plugin {
  settings: YuqueSettings = { ...DEFAULT_SETTINGS };
  reader!: ReaderEnhancer;
  topBars!: TopBarManager;
  /** 文件浏览器里的 DOM 变更观察器（见 registerExplorerObserver） */
  private explorerObserver?: MutationObserver;
  /** 已挂上观察器的文件浏览器视图根节点（避免重复 observe） */
  private readonly observedExplorers = new WeakSet<HTMLElement>();
  private explorerScanTimer: number | null = null;
  /** 上次报告的命中条目数，用于「只在变化时打一行日志」 */
  private hiddenFolderHits = -1;
  /** 上次报告的同步文档标记数（同上，只在变化时打日志） */
  private syncedDocHits = -1;
  /** 配额观测量落盘的节流计时器 */
  private rateSaveTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    // 版本标识：控制台可查（Ctrl+Shift+I），用于确认加载的是最新代码
    console.log(`[yuque-style] loaded v${this.manifest.version}`);

    // 配额观测的收尾：卸载前把还没落盘的那批观测量补写一次（最多 2 秒的量）
    this.register(() => {
      if (this.rateSaveTimer !== null) {
        window.clearTimeout(this.rateSaveTimer);
        this.rateSaveTimer = null;
        void this.persistRateLog();
      }
    });

    // ---- 编辑器：表格工具条（光标进表格才浮出；文本格式动作已并入顶部工具栏）----
    this.registerEditorExtension(buildTableToolbar());

    // ---- 编辑器：语雀式斜杠菜单（输入 "/" 唤起块插入）----
    this.registerEditorSuggest(new YuqueSlashSuggest(this));

    // ---- 高频格式动作注册为命令（可在「设置 → 快捷键」里绑定，与顶栏同一份动作内核）----
    registerEditorCommands(this);

    // ---- 阅读模式：文档头 / 排版 ----
    this.reader = new ReaderEnhancer(this);
    this.reader.register();

    // ---- 文档顶部：固定工具栏 + 元信息行（编辑模式）----
    this.topBars = new TopBarManager(this);
    this.topBars.register();

    this.applyCssVars();
    this.applyPropertyVisibility();
    this.applyHiddenFolder();
    this.registerExplorerObserver();
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
      id: "yuque-sync-manage",
      name: "语雀同步：管理同步任务（单独同步 / 删除）",
      callback: () => manageTasksFlow(this),
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

    this.addCommand({
      id: "yuque-clean-orphans",
      name: "语雀同步：清理孤儿文档副本（语雀端已删除的文档，移入回收站）",
      callback: () => orphanCleanupFlow(this),
    });

    // 本地重命名 / 移动后让同步记录跟随，否则下一轮会找不到原文件而重复创建
    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        this.handleRename(file, oldPath);
      }),
    );

    this.scheduleAutoSync();
  }

  /**
   * 启动自动同步（yuqueAutoSyncOnStart）：延迟触发一次「立即同步全部任务」。
   * 复用 syncAllFlow 的弹窗、停止按钮与既有的预算/熔断兜底，不另起一套静默通道——
   * 自动触发的同步更需要让用户看得见它正在消耗配额。
   * 无 Token 或无任务时静默跳过：条件不满足不是故障，弹窗提示只会添乱。
   */
  private scheduleAutoSync(): void {
    if (!this.settings.yuqueAutoSyncOnStart) return;
    if (!this.settings.yuqueToken || this.settings.yuqueTasks.length === 0) return;
    const timer = window.setTimeout(() => {
      if (!this.settings.yuqueAutoSyncOnStart) return; // 等待期间被关掉就不跑
      console.log("[yuque-style] 启动自动同步开始");
      void syncAllFlow(this);
    }, AUTO_SYNC_DELAY_MS);
    this.register(() => window.clearTimeout(timer));
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
    document.getElementById(HIDDEN_FOLDERS_STYLE_ID)?.remove();
    // 注入的样式已移除，标记类也一并清掉，不给下次启用留下残留
    this.explorerObserver?.disconnect();
    clearHiddenFolderNodes();
    clearSyncedDocNodes();
    this.topBars?.destroyAll();
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

  /**
   * 把「隐藏图片文件夹」的规则写进一个 <style>。
   *
   * 只隐藏文件浏览器里的条目，**不动仓库结构**：图片引用走 vault 路径解析，
   * 隐藏与否都不影响正文里的 `![[assets/x.png]]` 显示。用 CSS 而不是真的把目录移走，
   * 是因为「移走」会连带改写所有正文里的图片路径，代价与风险都不成比例。
   */
  applyHiddenFolder(): void {
    // 先撤销上一轮的标记：改目录名或关掉开关时不能留下「幽灵隐藏」
    clearHiddenFolderNodes();
    const css = this.settings.yuqueHideAssetsFolder
      ? buildHiddenFolderCss(this.settings.yuqueAssetsFolder)
      : "";
    let el = document.getElementById(HIDDEN_FOLDERS_STYLE_ID) as HTMLStyleElement | null;
    if (!css) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement("style");
      el.id = HIDDEN_FOLDERS_STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = css;
    // 规则变了，重新报一次命中数（也顺带立刻标记，不必等下一次 DOM 变更）
    this.hiddenFolderHits = -1;
    this.markHiddenFolders();
  }

  /** 当前所有文件浏览器视图的根节点（桌面侧栏 / 浮窗 / 移动端抽屉都算） */
  private explorerRoots(): HTMLElement[] {
    return this.app.workspace
      .getLeavesOfType("file-explorer")
      .map((leaf) => (leaf.view as unknown as { containerEl?: HTMLElement } | null)?.containerEl)
      .filter((el): el is HTMLElement => !!el);
  }

  /**
   * 文件浏览器的展开 / 刷新是纯 DOM 变更，没有可挂的事件，只能用 MutationObserver 兜住。
   * 观察器挂在**视图根节点**而不是整个 body：编辑器里每敲一个字都会改 DOM，
   * 挂在 body 上等于让扫描跟着输入跑。
   */
  private registerExplorerObserver(): void {
    this.explorerObserver = new MutationObserver(() => this.scheduleHiddenFolderScan());
    this.register(() => {
      this.explorerObserver?.disconnect();
      if (this.explorerScanTimer !== null) window.clearTimeout(this.explorerScanTimer);
    });
    // 浮窗、移动端抽屉会新建文件浏览器视图，出现时补挂观察器
    this.registerEvent(this.app.workspace.on("layout-change", () => this.attachExplorerObserver()));
    this.attachExplorerObserver();
  }

  private attachExplorerObserver(): void {
    for (const el of this.explorerRoots()) {
      if (this.observedExplorers.has(el)) continue;
      this.observedExplorers.add(el);
      this.explorerObserver?.observe(el, { childList: true, subtree: true });
    }
    this.scheduleHiddenFolderScan();
  }

  /** 防抖：展开一整棵目录树会连打几十次变更，攒一次扫描就够 */
  private scheduleHiddenFolderScan(): void {
    if (this.explorerScanTimer !== null) window.clearTimeout(this.explorerScanTimer);
    this.explorerScanTimer = window.setTimeout(() => {
      this.explorerScanTimer = null;
      this.markHiddenFolders();
      this.markSyncedDocs();
    }, 120);
  }

  /**
   * 给文件浏览器里的图片文件夹条目打标记（CSS 类的规则在注入的 <style> 里）。
   * 命中数变化时打一行日志——远程排查「隐藏没生效」时，先看这行有没有出现：
   * 命中 0 说明 DOM 里没找到 `data-path` 匹配的条目，即选择器/结构对不上。
   */
  private markHiddenFolders(): void {
    if (!this.settings.yuqueHideAssetsFolder) return;
    const name = this.settings.yuqueAssetsFolder;
    let hits = 0;
    for (const el of this.explorerRoots()) hits += markHiddenFolderNodes(el, name);
    if (hits !== this.hiddenFolderHits) {
      this.hiddenFolderHits = hits;
      console.log(`[yuque-style] 文件浏览器中命中 ${hits} 个「${name}」条目（已隐藏）`);
    }
  }

  /**
   * 给文件浏览器里的语雀同步文档打标记（圆点样式在 styles.css）。
   * 关掉开关时传空集合——markSyncedDocNodes 会顺带摘掉旧标记，不留幽灵圆点。
   */
  private markSyncedDocs(): void {
    const synced = this.settings.yuqueMarkSyncedDocs
      ? syncedDocPaths(this.settings.yuqueSyncState || {})
      : new Set<string>();
    let hits = 0;
    for (const el of this.explorerRoots()) hits += markSyncedDocNodes(el, synced);
    if (hits !== this.syncedDocHits) {
      this.syncedDocHits = hits;
      console.log(`[yuque-style] 文件浏览器中标记 ${hits} 篇语雀同步文档`);
    }
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
    const loaded = await this.loadData();
    // 补默认值 + 剔除已废弃的键（详见 src/settings.ts）；返回值里带出实际动了哪些键
    const { settings, removed } = loadSettingsWithMigration(loaded, DEFAULT_SETTINGS);
    this.settings = settings;
    // 旧版本只存 updated_at 字符串，此处统一升级为结构化记录（幂等，可重复执行）
    this.settings.yuqueSyncState = migrateSyncState(this.settings.yuqueSyncState);
    // 配额观测记录同理：字段缺失/类型不对一律回默认，坏了也不能让插件起不来
    this.settings.yuqueRateLog = migrateRateLog(this.settings.yuqueRateLog);
    if (removed.length > 0) {
      // 立即回写：否则废弃键会在每次 saveData 时被原样写回，越积越多
      await this.saveData(this.settings);
      console.log(`[yuque-style] 已清理废弃配置项：${removed.join("、")}`);
    }
  }

  /**
   * 统一的 API 构造入口：把观测回调注进去，于是每次请求都会进「本小时请求数」与
   * 429 时间线。散在各处的 `new YuqueApi(...)` 一律改走这里，别再各自造一个。
   */
  createApi(): YuqueApi {
    return new YuqueApi(this.settings.yuqueToken, (info) => this.recordRate(info));
  }

  /**
   * 配额观测记账（见 yuque/rate.ts）。每次请求都会调用，所以落盘必须节流：
   * 429 立即落盘（这类事件必须活过重启），其余最多每 2 秒写一次。
   */
  private recordRate(info: YuqueRateInfo): void {
    recordResponse(this.settings.yuqueRateLog, info);
    if (info.status === 429) {
      void this.persistRateLog();
      return;
    }
    if (this.rateSaveTimer !== null) return;
    this.rateSaveTimer = window.setTimeout(() => {
      this.rateSaveTimer = null;
      void this.persistRateLog();
    }, RATE_SAVE_INTERVAL_MS);
  }

  /** 只写 data.json：saveSettings 会连带重算 CSS 与顶栏，同步途中每两秒刷一遍既无必要也浪费 */
  private async persistRateLog(): Promise<void> {
    await this.saveData(this.settings);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.applyCssVars();
    this.applyPropertyVisibility();
    this.applyHiddenFolder();
    // 顶栏的开关、元信息、阅读时长都从这个对象取，设置一变就同步过去
    this.topBars?.refresh();
    // 同步记录 / 标记开关变了，防抖刷一遍文件浏览器的圆点标记
    this.scheduleHiddenFolderScan();
  }
}

export { YuqueStylePlugin };
