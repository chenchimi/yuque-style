/**
 * 文件浏览器里隐藏「图片文件夹」。
 *
 * 背景：图片本地化会在每个同步任务的**目标文件夹之下**再建一层资源目录
 * （默认 `assets`，见设置项「图片存放文件夹」），它只服务于正文里的图片引用，
 * 本身不是可读内容；在文件浏览器里与文档混在一起，既占位置也打断阅读节奏。
 *
 * 做法是把它从文件浏览器中**视觉隐去**，而不是真的移动/删除目录：
 * Obsidian 的 `![[assets/x.png]]` 是**按 vault 路径解析**的，与文件浏览器显不显示无关，
 * 所以隐藏后正文图片照旧引用、照旧渲染，仓库结构一个字节都没变。
 *
 * 两条腿走路，互为保险：
 * 1. **CSS 规则**（`buildHiddenFolderCss`）：纯样式就能生效，不依赖任何运行时逻辑；
 * 2. **DOM 标记**（`markHiddenFolderNodes`）：由插件用工作区 API 定位文件浏览器视图，
 *    在视图内部找带 `data-path` 的节点并打上 `yuque-hidden-folder` 类。
 *    第 1 条要猜类名与容器属性，而这里只依赖 `data-path`（Obsidian 拖拽功能的基础，
 *    多年稳定），所以换版本时更不容易失灵。
 *
 * 已知边界（都是「看不见但不等于不存在」）：
 * - 只是视觉隐藏：目录与图片仍在仓库里，搜索、快速切换、双链补全仍能命中。
 *   要让它们连搜索也排除，可在 Obsidian「设置 → 文件与链接 → 排除的文件」里加上该目录名。
 *
 * 本模块除 DOM 标记外都是纯字符串/纯 DOM 逻辑，不依赖 Obsidian，便于在 jsdom 下单测。
 */

/** 文件浏览器视图容器（`data-type` 与视图类型 id 一致，长期稳定） */
const EXPLORER = '.workspace-leaf-content[data-type="file-explorer"]';

/** 运行时给命中的节点打的类，由注入的 <style> 负责隐藏 */
export const HIDDEN_FOLDER_CLASS = "yuque-hidden-folder";

/** 转义成可安全放进 CSS 属性选择器的字符串（文件夹名允许中文、空格、引号等） */
function cssAttrValue(name: string): string {
  return name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * 判断某个条目的 `data-path` 是否属于要被隐藏的图片文件夹。
 *
 * `data-path` 是**仓库相对完整路径**，所以既要认根目录下的 `assets`，
 * 也要认任意子目录下的 `xx/assets`；用 `endsWith("/" + name)` 而不是 `endsWith(name)`，
 * 是为了不误伤 `myassets` 这类名字结尾相同的目录。
 */
export function matchesHiddenFolder(path: string, folderName: string): boolean {
  const name = (folderName || "").trim();
  if (!name || !path) return false;
  return path === name || path.endsWith(`/${name}`);
}

/**
 * 生成「隐藏文件浏览器中名为 folderName 的文件夹」的 CSS。
 *
 * 三类规则各司其职：
 * 1. 隐藏文件夹行本身。带容器限定的一份适配新版 `.tree-item` 结构；不带限定的
 *    `.nav-folder-title` 一份适配旧版结构（该类名是文件浏览器专用，不会误伤别处）。
 * 2. 兜底隐藏行下方的子节点容器：`:has()` 不可用时，靠它先收起内容，
 *    否则只剩一行缩进的孤儿子项挂在原处。
 * 3. 用 `:has()` 连空壳容器一起移除，不留一条无法交互的空白。
 *    单独成条是为了即使 `:has()` 不被支持，也不会让前两组选择器一起失效。
 *
 * 末尾那条针对 `HIDDEN_FOLDER_CLASS`，给运行时标记（`markHiddenFolderNodes`）兜底：
 * 万一上面几组选择器因版本变化全部落空，已打标记的节点仍然会被隐藏。
 *
 * @returns 空字符串表示无需注入（名称为空）
 */
export function buildHiddenFolderCss(folderName: string): string {
  const name = (folderName || "").trim();
  // 空名字一律不生成：`[data-path=""]` 与 `$="/"` 会命中一大片条目
  if (!name) return "";
  const v = cssAttrValue(name);
  const paths = [`[data-path="${v}"]`, `[data-path$="/${v}"]`];

  // 1) 文件夹行
  const rows = paths.flatMap((p) => [`${EXPLORER} ${p}`, `.nav-folder-title${p}`]);
  // 2) 行下方的子节点容器（两种 DOM 结构都点名）
  const children = rows.flatMap((s) => [
    `${s} + .nav-folder-children`,
    `${s} + .tree-item-children`,
  ]);
  // 3) 空壳容器
  const shells = paths.flatMap((p) => [
    `${EXPLORER} .nav-folder:has(> ${p})`,
    `${EXPLORER} .tree-item:has(> ${p})`,
  ]);
  // 4) 运行时标记
  const marked = [`.${HIDDEN_FOLDER_CLASS}`];

  const rule = (selectors: string[]): string =>
    `${selectors.join(",\n")} {\n  display: none !important;\n}`;
  const css = [rule(rows), rule(children), rule(shells), rule(marked)].join("\n");

  // 注释里也要挡一手 `*/`，否则目录名能把整段样式注释掉
  const label = name.replace(/\*\//g, "*\\/");
  return `/* yuque-style：在文件浏览器中隐藏图片文件夹「${label}」 */\n${css}\n`;
}

/**
 * 在给定的文件浏览器视图内，给图片文件夹条目打上隐藏类，返回命中的条目数。
 *
 * 不认类名、只认 `data-path`：
 * - 条目本身就是容器（内部还有带 `data-path` 的子孙）→ 藏它就够；
 * - 否则它是「行」，下面通常跟着一个子节点容器。此时**只在下一个兄弟节点自身不带
 *   `data-path` 时**才继续往里收——那个兄弟是子节点容器而不是同级的下一条目，
 *   这样既能把缩进的子项一起藏掉，又绝不会误伤同级条目的父容器。
 *
 * 幂等：重复调用只会重复加同一个类（`classList.add` 本身幂等）。
 */
export function markHiddenFolderNodes(root: ParentNode, folderName: string): number {
  const name = (folderName || "").trim();
  if (!name) return 0;

  let matched = 0;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-path]"))) {
    if (!matchesHiddenFolder(el.getAttribute("data-path") ?? "", name)) continue;
    matched++;
    el.classList.add(HIDDEN_FOLDER_CLASS);
    // 自己就是整个文件夹容器（内部还有带 data-path 的子孙）时，藏它就完整了
    if (el.querySelector("[data-path]")) continue;
    // 行下面通常还跟一个子节点容器。这里**只认名字里带 children 的下一个兄弟**：
    // 拿不准宁可不收——把同级的其它条目连坐藏掉，比留下一段缩进严重得多
    // （文件行的下一个兄弟是另一个文件条目，同样没有 data-path，只靠属性区分不开）
    const sibling = el.nextElementSibling as HTMLElement | null;
    if (!sibling || !/children/i.test(sibling.className)) continue;
    sibling.classList.add(HIDDEN_FOLDER_CLASS);
    // 此时结构已确认为「行 + 子节点容器」，再往上收一层就是该文件夹自己的容器
    const parent = el.parentElement;
    if (parent && parent !== root && !parent.hasAttribute("data-path")) {
      parent.classList.add(HIDDEN_FOLDER_CLASS);
    }
  }
  return matched;
}

/** 撤销本插件打过的所有隐藏类（关掉开关或改目录名时调用，避免留下「幽灵隐藏」） */
export function clearHiddenFolderNodes(root: ParentNode = document): number {
  const marked = Array.from(root.querySelectorAll<HTMLElement>(`.${HIDDEN_FOLDER_CLASS}`));
  for (const el of marked) el.classList.remove(HIDDEN_FOLDER_CLASS);
  return marked.length;
}
