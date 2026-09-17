# Obsidian Yuque Style

模仿语雀文档编辑、查看体验的 Obsidian 插件，并支持把语雀知识库一键同步到 Obsidian。

仓库：<https://github.com/chenchimi/yuque-style>　·　当前版本：**[v0.6.9](https://github.com/chenchimi/yuque-style/releases/tag/0.6.9)**

## 功能总览

### 1. 语雀文档同步（核心功能）

把语雀编辑好的文档同步到 Obsidian，保持语雀样式、还原知识库目录结构。

**快速开始：**

1. **获取 Token**：语雀网页 → 账号设置 → 开发者 → Token，勾选「读取知识库、文档」权限
2. **填入 Token**：Obsidian 设置 → Yuque Style →「语雀文档同步」→ 填入 →「测试连接」
3. **添加同步任务**：命令面板（Ctrl/Cmd+P）→「语雀同步：添加/更新同步任务」，可**一次勾选多个知识库**（显示篇数与「已配置」标记），每个库落在「根文件夹 / 库名」下；只勾选 1 个库时才能逐篇挑选
4. **执行同步**：立即同步一次；之后点左侧 ribbon 刷新图标，或执行「语雀同步：立即同步全部任务」

**同步特性：**

- **增量同步**：按语雀 `updated_at` 只拉取变化的文档；可「清除增量同步记录」强制全量
- **目录还原**：按目录树建文件夹层级，按语雀原始顺序同步，生成「XX 目录.md」索引页（树状缩进 + 双链）
- **图片本地化**：默认开启，图片下载到 `assets/`（可关闭）
- **内部链接**：文档间引用转 `[[双链]]`，跨库也认；文件名唯一写 `[[标题]]`，撞车才用 `[[完整路径|显示文本]]`；附件与未同步目标保持原样
- **来源追踪**：frontmatter 记录 `source`（原文链接）与更新时间
- **格式自适应**：识别 Lake（编辑器原生）与 Markdown（粘贴/导入）两种格式，后者只清理不重排
- **API 保护**：400ms 节流，429 时退避重试（5s/15s/30s）；「语雀同步：诊断」可看原始响应
- **批量与中断**：多库批量建任务并按勾选顺序同步，可随时「停止」，记录先落盘

**样式还原对照：**

| 语雀元素 | Obsidian 结果 |
| --- | --- |
| 标注卡片（信息/警告/危险/成功） | Callout（`> [!note]` / `[!warning]` / `[!danger]` / `[!tip]`） |
| 任务清单 | `- [ ]` / `- [x]` |
| 代码块（带语言） | fenced code block |
| 数学公式（行内/块级） | `$...$` / `$$...$$` |
| 图片 / 附件 / 书签 / 视频链接 | `![]()` / `[]()` 链接 |
| 表格 | 管道表格（高级表格 lakesheet/数据表暂以占位提示） |
| 知识库目录树 | 按目录层级建文件夹 + 目录索引页 |
| 文档间链接 | 同库内自动转为 `[[双链]]` |
| 删除线 / 下划线 / 高亮 | `~~xx~~` / `<u>xx</u>` / `==xx==` |
| 彩色文字 | 由设置项「文字颜色」决定：**不输出颜色（默认，纯文本）** / 转 `==高亮==` / 保留 `<span style="color:...">`。语雀默认正文色 #4D4D4D 与标题色 #4F4F4F 一律不输出 |
| 文档属性 | frontmatter：`标题` / `来源` / `语雀ID` / `语雀创建时间` / `语雀更新时间`（`语雀标签` 预留，语雀接口不返回标签）。属性**始终写入文件**，可以在设置里**逐个决定显不显示**（`笔记属性：xxx`） |

**已知限制：**

- 语雀「高级表格 / 数据表 / 画板」暂以占位提示代替（需回语雀查看）
- **文档接口不返回标签**：「语雀标签」不会被写入；读取逻辑保留，接口提供后自动生效
- **「笔记属性」只控显示、不动数据**：隐藏只影响顶部属性面板，文档头 / 双链索引 / Dataview 与搜索照旧可读；源码模式仍会看到 YAML 原文，对其它插件也可见。Obsidian 自带的「文档中的属性」为**全局**设置，设「隐藏」时逐个开关不再有意义
- 同步为单向（语雀 → Obsidian），本地修改会被下次同步覆盖
- 语雀中删除的文档不会自动删除本地文件（保守策略）
- 免费账户 API 配额较低，频繁全量同步可能触发限流（等待 10-60 分钟自动恢复）

### 2. 编辑器体验

- **悬浮格式工具栏（双形态）**：选中文本显示「文本排版条」：加粗、斜体、删除线、高亮、行内代码、**H1-H4 标题**、引用、待办、**插入链接**、**文字颜色**（8 色板，写 `<span style="color:…">`）；光标停在表格且无选区时切成「表格工具条」：上/下插行、删行、左/右插列、删列，表头与分隔行受保护，删掉最后一个数据行整块移除
- **斜杠快捷菜单**：输入 `/` 唤起语雀式块插入菜单，支持中英文/拼音过滤：标题 1-4 级；待办、无序/有序列表、引用；**10 种卡片块** note / tip / warning / info / success / question / failure / danger / example / quote（即原生 callout）；**折叠块**（`> [!note]+`；不用 `<details>`，其内部 Markdown 不解析）、**目录块**（标题双链列表，静态快照）、**两栏对比**（用表格模拟）；表格、分割线、数学公式、今日日期；**代码块（13 种语言）**默认收起，输入 `/py`、`/ps`、`/sql` 等缩写才出现

### 3. 阅读 / 查看体验

- **标题自动编号**：阅读模式与实时预览下标题显示层级数字（`1` / `1.1` / `1.1.1` / `1.1.1.1`）；无一级标题时以二级为顶级；自带编号（「一、」「2、」）不受影响；可开关
- **文档头信息**：标题、字数、预计阅读时长（400 字/分钟）、**创建于 / 更新于**（取语雀真实时间，缺失就整项不显示）；标签不显示（接口不提供）；正文已有 h1 时只显示元信息
- **文档目录**：交给 Obsidian 原生「大纲」面板（滚动定位、章节高亮、可拖拽），插件不再自绘
- **笔记属性的显隐**：「笔记属性」下拉可逐项切换五个属性在顶部面板显不显示（另含「全部显示」「全部隐藏」）；**「文档头信息」是总开关**；全隐藏时整块面板收起，不留空的标题与「+ 添加笔记属性」按钮
- **语雀式排版**：**阅读模式与实时预览都生效**——居中栏宽（600-1600px 或「跟随窗口宽度」）、行高 1.75 与段间距、图片圆角居中限高 70vh、语雀式引用（浅灰竖线无背景）、表格边框与表头底色、**宽表格横向滚动**、行内代码样式、标题层级字号（源码模式不套版式）

### 命令列表

| 命令 | 说明 |
| --- | --- |
| 语雀同步：立即同步全部任务 | 执行所有已创建的同步任务（无任务时引导创建） |
| 语雀同步：添加/更新同步任务 | 单弹窗向导：多选知识库 → 根文件夹 → 范围；可随时「停止」 |
| 语雀同步：诊断 | 输出 API 原始响应，排查拉取为空等问题 |
| 语雀同步：重建内部链接 | 只读本地文件，把正文里已有的语雀链接补转成双链（不调 API） |
| 语雀同步：清理文字颜色标记 | 去掉存量文档里的颜色包裹；口径跟随设置项「文字颜色」，高亮背景不动 |
| 语雀同步：补齐文档属性 | 只调列表接口（每 100 篇 1 次请求）：补全五个中文属性、旧英文键就地迁移，前言区被删的也能整块补回；并列孤儿文档（仅报告） |
| 开启 / 关闭阅读增强 | 开关阅读模式增强 |
| 插入卡片块 / 待办清单 / 表格 | 快捷插入常用块 |

## 安装

### 方式一：直接安装（不需要 Node，推荐）

插件就是三个文件，放进 vault 即可，不用编译。

**1. 找到（或新建）插件目录**

```
<你的仓库>/.obsidian/plugins/yuque-style/
```

> 目录名必须是 `yuque-style`（与 `manifest.json` 里的 `id` 一致）。`.obsidian` 是隐藏目录：Windows 在资源管理器勾上「查看 → 隐藏的项目」，或在 Obsidian 里右键文件夹 →「在系统资源管理器中显示」再往上退。

**2. 把这三个文件放进该目录**（注意**不要再套一层文件夹**）

| 文件 | 作用 |
| --- | --- |
| `main.js` | 插件代码（构建产物，已随仓库提交，不需要自己编译） |
| `manifest.json` | 插件元信息：名称、版本、最低 Obsidian 版本 |
| `styles.css` | 插件的全部样式 |

**推荐用 Release 附件**——链接固定在这一版，不受 `main` 分支改动影响（也可直接打开 [Release 页面](https://github.com/chenchimi/yuque-style/releases/latest) 下载附件）：

[main.js](https://github.com/chenchimi/yuque-style/releases/download/0.6.9/main.js) ·
[manifest.json](https://github.com/chenchimi/yuque-style/releases/download/0.6.9/manifest.json) ·
[styles.css](https://github.com/chenchimi/yuque-style/releases/download/0.6.9/styles.css)

命令行一次到位（PowerShell，把第一行的路径换成你自己的仓库）：

```powershell
$p = "$env:USERPROFILE\Documents\我的仓库\.obsidian\plugins\yuque-style"
$base = "https://raw.githubusercontent.com/chenchimi/yuque-style/main"
New-Item -ItemType Directory -Force -Path $p | Out-Null
foreach ($f in 'main.js','manifest.json','styles.css') {
  Invoke-WebRequest "$base/$f" -OutFile "$p\$f"
}
```

**3. 在 Obsidian 里启用**

**设置 → 第三方插件**：首次装插件先关「安全模式 / 限制模式」→「刷新」→ 启用 **Yuque Style**。

**4. 配好就能用**

到 **设置 → Yuque Style** 填 Token（获取见「快速开始」第 1 步），再执行「语雀同步：添加/更新同步任务」建第一个任务。

### 方式二：BRAT（在 Obsidian 内安装与更新，推荐长期使用）

[BRAT](https://github.com/TfTHacker/obsidian42-brat) 是「从 GitHub 仓库安装插件」的社区插件，**新版本发布后能在 Obsidian 里直接升级**。

1. 先装 BRAT（社区插件市场搜 `BRAT`，或按方式一放进 `.obsidian/plugins/`）
2. 启用 BRAT，命令面板执行 **BRAT: Add a beta plugin for testing**
3. 填仓库名 `chenchimi/yuque-style` 并确认，BRAT 自动下载 Release 里的三个文件
4. 之后升级：BRAT 设置 → **Check for updates**

> BRAT 认的是**仓库的 Release**，读 `manifest.json` 的版本号判断是否需要更新。

### 方式三：从源码构建

1. 安装 [Node.js](https://nodejs.org/)（v18+）
2. 克隆并构建：

   ```bash
   git clone https://github.com/chenchimi/yuque-style.git
   cd yuque-style
   npm install
   npm run build
   ```

3. 把 `manifest.json`、`main.js`、`styles.css` 复制到 `<你的仓库>/.obsidian/plugins/yuque-style/`
4. 接方式一的第 3、4 步

### 更新已安装的版本

覆盖 `main.js` / `manifest.json` / `styles.css`（从 [Release 页面](https://github.com/chenchimi/yuque-style/releases/latest) 下载），
再把插件关掉重开（或重启 Obsidian）。用 BRAT 安装的直接检查更新即可。

设置、Token 与同步记录都保存在 `data.json`，更新不会丢。

## 开发调试

```bash
npm run dev        # watch 模式，改代码自动重新构建
npm run build      # 类型检查（含 tools/）+ 产物构建
npm test           # 全部单测（vitest，260+ 个用例）
npm run probe      # 打包 tools/ 下的离线探针（体检 / 配额盘点 / 失联文件诊断）
```

配合热重载插件（Hot Reload）或手动重启即可调试。

> 仓库里提交了构建产物 `main.js`，所以**改完源码记得 `npm run build` 并一起提交**，否则成品会与源码脱节。

## 技术说明

- 基于 Obsidian 官方插件 API + CodeMirror 6 扩展机制
- 工具栏通过 `registerEditorExtension` 注册 `ViewPlugin`，随选区定位，按上下文切换「文本排版条 / 表格工具条」
- 纯逻辑抽成不依赖 Obsidian 的模块以便单测：`src/table.ts`（表格行列操作）、`src/toc.ts`（目录块生成）、`src/slash-items.ts`（菜单条目与过滤）
- 斜杠菜单基于 `EditorSuggest` 实现
- 阅读增强为 DOM 装饰：监听 `active-leaf-change` / `layout-change` / markdown 渲染事件，注入文档头
- 标题编号使用 CSS counter（阅读模式作用于 `.markdown-preview-view`，实时预览作用于 CM6 的 `HyperMD-header-N`）
- 同步模块结构：`src/yuque/api.ts`（API v2 客户端 + 节流退避）、`lake.ts`（Lake/Markdown 双通道转换）、`sync.ts`（增量同步 + 目录还原 + 图片本地化）、`ui.ts`（向导 + 进度 + 诊断）
- 排版样式全部走 `styles.css`，使用 Obsidian CSS 变量，自动适配亮/暗主题

## 更新日志

- **v0.6.9** 属性全隐藏时的收起规则改用运行时注入 `<style>`（`styles.css` 那条未生效）；四个选择器点名容器，两模式同时生效
- **v0.6.8** 全部隐藏时整块属性面板收起；五个 toggles 收成「笔记属性」下拉，带「隐藏 N / 5 个」统计
- **v0.6.7** 修复「笔记属性：语雀ID」因键名被强制转小写而失效；「文档头信息」成为总开关
- **v0.6.6** 「补齐文档属性」的清单加上 `标题` / `来源`，前言区被整体删掉的文件也能新建
- **v0.6.5** 属性改为五个逐个的显示开关（中英文键都覆盖），取缔「文档属性」开关与「移除文档属性」命令
- **v0.6.4** 新增设置项「文字颜色」（不输出／高亮／保留 span）；「清理默认文字颜色」更名「清理文字颜色标记」
- **v0.6.3** 关闭「文档属性」时可选清理已写入的属性；新增命令「语雀同步：移除文档属性」
- **v0.6.2** 修复正文被默认色 `<span>` 包成噪声（#4D4D4D / #4F4F4F 不再输出），新增就地清理命令
- **v0.6.1** 属性键名全面中文化，新增「文档属性」开关，旧英文键仍可回读
- **v0.6.0** 文档头「创建于」改为语雀真实创建时间；补 `yuque_id` / `yuque_created_at` / `yuque_tags` 落盘；新增命令「补齐文档属性」

**v0.5.x 及更早**见 [更新日志全文](docs/CHANGELOG.md)。
