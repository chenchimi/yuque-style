import { Notice, PluginSettingTab, Setting } from "obsidian";
import type { YuqueStylePlugin } from "./main";
import { PROPERTY_TOGGLES, hiddenSlugsFor } from "./yuque/frontmatter";
import { suggestBudget } from "./yuque/rate";
import { addSyncTaskFlow, manageTasksFlow } from "./yuque/ui";
import { summarizeTaskNames } from "./settings";
import type { ColorMode } from "./yuque/lake";

/**
 * 「高级设置」的展开状态。
 * 只活在本次会话、不落盘：为一个「显示更多」单独占一个配置项不划算，
 * 而且默认收起正是这个分组的意义。
 */
let advancedShown = false;

export class YuqueSettingTab extends PluginSettingTab {
  private plugin: YuqueStylePlugin;

  constructor(plugin: YuqueStylePlugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("yuque-settings");
    const s = this.plugin.settings;

    this.renderIntro(containerEl);

    // ================ 编辑 ================
    containerEl.createEl("h2", { text: "编辑" });

    this.toggle(
      containerEl,
      "顶部工具栏与元信息",
      "文档顶部的固定工具栏（滚动时保持可见）与它下面的元信息行；仅在编辑模式显示",
      s.topBar,
      (v) => (s.topBar = v),
    );

    this.toggle(
      containerEl,
      "斜杠快捷菜单",
      '输入 "/" 唤起块插入菜单（标题 / 卡片 / 待办 / 表格…），与顶部「插入」下拉同一份条目',
      s.slashMenu,
      (v) => (s.slashMenu = v),
    );

    // ================ 阅读 ================
    containerEl.createEl("h2", { text: "阅读" });

    this.toggle(
      containerEl,
      "阅读增强",
      "阅读模式下启用文档头与语雀式排版（栏宽、行高、图片圆角、宽表格横向滚动）",
      s.reader,
      (v) => {
        s.reader = v;
        this.plugin.reader.refresh(true);
      },
    );

    this.toggle(
      containerEl,
      "文档头信息",
      "文档顶部显示标题、字数、阅读时长、语雀时间与标签；关闭后笔记属性也一并隐藏",
      s.showDocHeader,
      (v) => {
        s.showDocHeader = v;
        this.plugin.reader.refresh(true);
        this.display(); // 重绘：让下面的笔记属性跟着禁用/启用
      },
    );

    // 笔记属性：属性始终写在文件里，这里只控制它在文档顶部的属性面板显不显示。
    // 用「一个下拉 + 逐项切换」而不是铺五行 toggles，设置页太长了
    const effective = new Set(hiddenSlugsFor(s.showDocHeader, s.yuqueHiddenProps || []));
    new Setting(containerEl)
      .setName("笔记属性")
      .setDesc(
        s.showDocHeader
          ? "选择要隐藏（或恢复）的属性；属性仍写在文件里，不影响读取与双链"
          : "「文档头信息」已关闭，属性当前全部隐藏",
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

    this.toggle(
      containerEl,
      "标题自动编号",
      "标题显示层级数字（1 / 1.1 / 1.1.1）；文档自带的编号不受影响",
      s.headingNumbers,
      (v) => {
        s.headingNumbers = v;
        this.plugin.reader.refresh(true);
      },
    );

    this.toggle(
      containerEl,
      "跟随窗口宽度",
      "正文铺满可用宽度；会一并放开 Obsidian 自带「可读行宽」的限制",
      s.contentWidthAuto,
      (v) => {
        s.contentWidthAuto = v;
        this.display(); // 重绘，让下面的栏宽滑块跟着禁用/启用
      },
    );

    new Setting(containerEl)
      .setName("正文栏宽")
      .setDesc("阅读与实时预览下的正文宽度（像素）；600-900 最利于阅读")
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

    // ================ 语雀文档同步 ================
    containerEl.createEl("h2", { text: "语雀文档同步" });

    new Setting(containerEl)
      .setName("语雀 Token")
      .setDesc("语雀网页「账号设置 → 开发者 → Token」，权限勾「读取知识库、文档」")
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
            const user = await this.plugin.createApi().getUser();
            new Notice(`连接成功：${user?.name ?? user?.login ?? "已认证"}`);
          } catch (e) {
            new Notice(`连接失败：${(e as Error).message}`);
          } finally {
            b.setDisabled(false);
          }
        }),
      );

    // 任务列表搬进独立弹窗（见 ui.ts 的 ManageTasksModal）：它会随使用无限增长，
    // 留在设置页会把下面真正要调的选项挤出屏幕，而配好之后几乎不会再来动它
    const taskNames = (s.yuqueTasks || []).map((t) => t.repoName);
    new Setting(containerEl)
      .setName(`同步任务（${taskNames.length}）`)
      .setDesc(
        taskNames.length === 0
          ? "还没有任务：添加后按语雀更新时间增量同步"
          : `${summarizeTaskNames(taskNames)}；可单独同步或删除`,
      )
      .addButton((b) =>
        b.setButtonText("管理任务").onClick(() => manageTasksFlow(this.plugin)),
      )
      .addButton((b) =>
        b.setButtonText("添加任务").setCta().onClick(() => {
          void addSyncTaskFlow(this.plugin);
        }),
      );

    this.toggle(
      containerEl,
      "启动时自动同步",
      "Obsidian 启动 15 秒后自动执行一次「同步全部任务」（增量，只拉有改动的文档）；配额不足时会在任务边界停下",
      s.yuqueAutoSyncOnStart,
      (v) => (s.yuqueAutoSyncOnStart = v),
    );

    this.toggle(
      containerEl,
      "图片本地化",
      "把语雀 CDN 图片下载到仓库内，避免外链失效",
      s.yuqueDownloadImages,
      (v) => (s.yuqueDownloadImages = v),
    );

    this.toggle(
      containerEl,
      "在文件浏览器中隐藏图片文件夹",
      "只在文件浏览器里隐去该目录；正文图片引用与显示完全不变（搜索仍能命中它）",
      s.yuqueHideAssetsFolder,
      (v) => (s.yuqueHideAssetsFolder = v),
    );

    this.toggle(
      containerEl,
      "在文件浏览器中标记语雀文档",
      "同步文档的行尾显示一个小圆点，扫一眼目录即知哪些内容来自语雀",
      s.yuqueMarkSyncedDocs,
      (v) => (s.yuqueMarkSyncedDocs = v),
    );

    // ================ 高级（默认收起）================
    new Setting(containerEl)
      .setName("显示高级设置")
      .setDesc("图片目录名、文字颜色、冲突备份、同步请求上限、清除增量记录等低频项")
      .addToggle((t) =>
        t.setValue(advancedShown).onChange((v) => {
          advancedShown = v;
          this.display();
        }),
      );

    if (!advancedShown) return;

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
        "同步时语雀彩色文字怎么落盘。「保留颜色」在编辑模式下会看到 span 源码；" +
          "存量文档的旧标记用命令「清理文字颜色标记」处理",
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

    this.toggle(
      containerEl,
      "本地改动冲突时备份",
      "覆盖前若检测到文件已被本地修改，先备份到 .yuque-backups/（每篇保留最近 5 份）",
      s.yuqueBackupOnConflict,
      (v) => (s.yuqueBackupOnConflict = v),
    );

    // 请求上限默认「自动」：语雀的额度不透明（官方称 5000/小时并返回 X-RateLimit-*，
    // 但实测 429 上看不到该头），所以不预设数字，只在观测到门槛后给出建议值
    const suggested = suggestBudget(s.yuqueRateLog);
    new Setting(containerEl)
      .setName("每次同步请求上限")
      .setDesc(
        "0 = 自动：能读到 X-RateLimit-Remaining 就按剩余额度走，读不到就不限（只保留 429 熔断）。" +
          "上限只在任务边界生效——不会把某个库拉一半，下次执行接着跑。" +
          (suggested === null
            ? "本机还没撞到过 429，暂无建议值（执行一次「语雀同步：诊断」可查看观测记录）"
            : `本机观测门槛 ${s.yuqueRateLog.minCeiling} 次，建议填 ${suggested}（×0.8）`),
      )
      .addText((t) =>
        t
          .setPlaceholder("0")
          .setValue(String(s.yuqueRequestBudget || 0))
          .onChange(async (v) => {
            const n = Number.parseInt(v.trim(), 10);
            s.yuqueRequestBudget = Number.isFinite(n) && n > 0 ? n : 0;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("清除增量同步记录")
      .setDesc("下次同步强制重新拉取全部文档（本地文件不会被删除）")
      .addButton((b) =>
        b.setButtonText("清除").onClick(async () => {
          s.yuqueSyncState = {};
          await this.plugin.saveSettings();
          new Notice("已清除同步记录，下次将全量拉取");
        }),
      );

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "其它维护命令在命令面板「语雀同步：…」下：诊断（排查拉取为空）、重建内部链接、" +
        "补齐文档属性、清理文字颜色标记——都不需要改设置，故不在此列。",
    });
  }

  /**
   * 插件简介。
   * 放在最上面而不是塞进 README：设置页是用户唯一一定会打开的页面，
   * 「这插件是干什么的、有哪几块能力」应该在这里一眼看完。
   */
  private renderIntro(el: HTMLElement): void {
    const card = el.createDiv({ cls: "yuque-settings-intro" });
    const head = card.createDiv({ cls: "yuque-settings-intro-head" });
    head.createEl("strong", { text: "Yuque Style" });
    head.createSpan({ cls: "yuque-settings-version", text: `v${this.plugin.manifest.version}` });
    card.createEl("p", {
      cls: "yuque-settings-intro-desc",
      text: "把语雀的写作与阅读体验搬进 Obsidian，并把语雀知识库同步到本地（单向只读，不会回写语雀）。",
    });
    const ul = card.createEl("ul", { cls: "yuque-settings-intro-list" });
    ul.createEl("li", {
      text: "编辑：文档顶部固定工具栏（段落样式 / 格式 / 列表 / 引用 / 代码块 / 插入块）与元信息行",
    });
    ul.createEl("li", {
      text: "阅读：语雀式排版——居中栏宽、行高与段距、图片圆角限高、宽表格横向滚动、标题自动编号",
    });
    ul.createEl("li", {
      text: "同步：还原知识库目录结构、图片本地化、文档间自动双链；增量同步，覆盖前先备份本地改动",
    });
  }

  /**
   * 统一的开关项。
   * 收成一个方法是为了别让每项都重复一遍「取设置 → 存设置」的样板，
   * 顺便把描述压短——设置页里最长的说明原本有四行，读起来像文档而不像开关。
   */
  private toggle(
    parent: HTMLElement,
    name: string,
    desc: string,
    value: boolean,
    onSet: (v: boolean) => void,
  ): Setting {
    return new Setting(parent)
      .setName(name)
      .setDesc(desc)
      .addToggle((t) =>
        t.setValue(value).onChange(async (v) => {
          onSet(v);
          await this.plugin.saveSettings();
        }),
      );
  }
}
