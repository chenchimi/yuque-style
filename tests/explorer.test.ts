import { describe, expect, it } from "vitest";
import {
  buildHiddenFolderCss,
  clearHiddenFolderNodes,
  HIDDEN_FOLDER_CLASS,
  markHiddenFolderNodes,
  matchesHiddenFolder,
} from "../src/yuque/explorer";

const EXPLORER = '.workspace-leaf-content[data-type="file-explorer"]';

/** 旧版结构：.nav-folder > (.nav-folder-title + .nav-folder-children) */
const CLASSIC_DOM = `
<div class="workspace-leaf-content" data-type="file-explorer">
  <div class="nav-folder" id="root-assets">
    <div class="nav-folder-title" data-path="assets">assets</div>
    <div class="nav-folder-children">
      <div class="nav-file"><div class="nav-file-title" data-path="assets/a.png">a.png</div></div>
    </div>
  </div>
  <div class="nav-folder" id="ai">
    <div class="nav-folder-title" data-path="AI">AI</div>
    <div class="nav-folder-children" id="ai-children">
      <div class="nav-folder" id="ai-assets">
        <div class="nav-folder-title" data-path="AI/assets">assets</div>
        <div class="nav-folder-children"></div>
      </div>
      <div class="nav-folder" id="ai-myassets">
        <div class="nav-folder-title" data-path="AI/myassets">myassets</div>
        <div class="nav-folder-children"></div>
      </div>
    </div>
  </div>
  <div class="nav-folder" id="no-images">
    <div class="nav-folder-title" data-path="纯文档">纯文档</div>
    <div class="nav-folder-children">
      <div class="nav-file"><div class="nav-file-title" data-path="纯文档/笔记.md">笔记.md</div></div>
    </div>
  </div>
</div>
`;

/** 新版结构：.tree-item > (.tree-item-self + .tree-item-children) */
const TREE_ITEM_DOM = `
<div class="workspace-leaf-content" data-type="file-explorer">
  <div class="tree-item" id="ti-ai">
    <div class="tree-item-self" data-path="AI">AI</div>
    <div class="tree-item-children" id="ti-ai-children">
      <div class="tree-item" id="ti-assets">
        <div class="tree-item-self" data-path="AI/assets">assets</div>
        <div class="tree-item-children"></div>
      </div>
      <div class="tree-item">
        <div class="tree-item-self" data-path="AI/其他">其他</div>
        <div class="tree-item-children"></div>
      </div>
    </div>
  </div>
</div>
`;

function render(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

function hidden(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`.${HIDDEN_FOLDER_CLASS}`)).map(
    (el) => el.getAttribute("data-path") ?? el.id,
  );
}

describe("matchesHiddenFolder", () => {
  it("根目录与任意子目录都算命中", () => {
    expect(matchesHiddenFolder("assets", "assets")).toBe(true);
    expect(matchesHiddenFolder("AI/assets", "assets")).toBe(true);
    expect(matchesHiddenFolder("AI/大模型/assets", "assets")).toBe(true);
  });

  it("结尾同名的目录不误伤", () => {
    expect(matchesHiddenFolder("AI/myassets", "assets")).toBe(false);
    expect(matchesHiddenFolder("AI/assets-old", "assets")).toBe(false);
    expect(matchesHiddenFolder("AI", "assets")).toBe(false);
  });

  it("空目录名 / 空路径都不命中", () => {
    expect(matchesHiddenFolder("assets", "")).toBe(false);
    expect(matchesHiddenFolder("assets", "   ")).toBe(false);
    expect(matchesHiddenFolder("", "assets")).toBe(false);
  });

  it("目录名跟随设置（中文、含空格）", () => {
    expect(matchesHiddenFolder("AI/图片资源", "图片资源")).toBe(true);
    expect(matchesHiddenFolder("AI/图片 资源", "图片 资源")).toBe(true);
  });
});

describe("buildHiddenFolderCss", () => {
  it("根目录与任意子目录两种路径都覆盖", () => {
    const css = buildHiddenFolderCss("assets");
    expect(css).toContain(`${EXPLORER} [data-path="assets"]`);
    expect(css).toContain(`${EXPLORER} [data-path$="/assets"]`);
  });

  it("新版 .tree-item 结构与旧版 .nav-folder 结构都点名", () => {
    const css = buildHiddenFolderCss("assets");
    expect(css).toContain(`.nav-folder-title[data-path="assets"]`);
    expect(css).toContain(`${EXPLORER} .nav-folder:has(> [data-path="assets"])`);
    expect(css).toContain(`${EXPLORER} .tree-item:has(> [data-path$="/assets"])`);
  });

  it("兜底隐藏子节点容器，避免 :has() 不可用时留下缩进的孤儿子项", () => {
    const css = buildHiddenFolderCss("assets");
    expect(css).toContain(`${EXPLORER} [data-path$="/assets"] + .nav-folder-children`);
    expect(css).toContain(`${EXPLORER} [data-path="assets"] + .tree-item-children`);
    expect(css).toContain("display: none !important;");
  });

  it("运行时标记类也有自己的规则（选择器全部落空时仍然生效）", () => {
    expect(buildHiddenFolderCss("assets")).toContain(`.${HIDDEN_FOLDER_CLASS}`);
  });

  it("结尾匹配带斜杠：myassets 不会被误伤", () => {
    const css = buildHiddenFolderCss("assets");
    expect(css).not.toContain('[data-path$="assets"]');
    expect(css).toContain('[data-path$="/assets"]');
  });

  it("只作用于文件浏览器容器，不波及其它面板", () => {
    const css = buildHiddenFolderCss("assets");
    // 不带容器限定的只有 .nav-folder-* / .yuque-hidden-folder 这类文件浏览器专用选择器
    const unscoped = css
      .split("\n")
      .filter((line) => line.includes("[data-path") && !line.includes(EXPLORER));
    expect(unscoped.length).toBeGreaterThan(0);
    for (const line of unscoped) {
      expect(line).toMatch(/\.nav-folder-title|\.nav-folder-children/);
    }
  });

  it("空名字不生成规则（否则会命中一大片条目）", () => {
    expect(buildHiddenFolderCss("")).toBe("");
    expect(buildHiddenFolderCss("   ")).toBe("");
  });

  it("名字里的引号被转义，不会撑破选择器", () => {
    const css = buildHiddenFolderCss('a"b');
    expect(css).toContain('[data-path="a\\"b"]');
    expect(css).toContain('[data-path$="/a\\"b"]');
  });

  it("注释里的 */ 被挡掉，目录名无法注释掉样式", () => {
    const css = buildHiddenFolderCss("a*/b");
    expect(css.startsWith("/*")).toBe(true);
    expect(css).toContain('[data-path="a*/b"]');
    // 注释在收尾处才闭合，之后的规则仍是有效 CSS
    const firstClose = css.indexOf("*/");
    expect(css.slice(firstClose + 2)).toContain("display: none !important;");
  });

  it("隐藏不碰仓库内容：CSS 里没有任何改路径/引用的声明", () => {
    const css = buildHiddenFolderCss("assets");
    expect(css).not.toContain("content:");
    expect(css).not.toContain("url(");
  });
});

describe("markHiddenFolderNodes", () => {
  it("旧版结构：行与子节点容器一起标记", () => {
    const root = render(CLASSIC_DOM);
    expect(markHiddenFolderNodes(root, "assets")).toBe(2);
    expect(document.getElementById("root-assets")!.classList.contains(HIDDEN_FOLDER_CLASS)).toBe(
      true,
    );
    expect(document.getElementById("ai-assets")!.classList.contains(HIDDEN_FOLDER_CLASS)).toBe(
      true,
    );
    expect(
      document
        .querySelector('#root-assets .nav-folder-title[data-path="assets"]')!
        .classList.contains(HIDDEN_FOLDER_CLASS),
    ).toBe(true);
    expect(
      document
        .querySelector("#root-assets .nav-folder-children")!
        .classList.contains(HIDDEN_FOLDER_CLASS),
    ).toBe(true);
  });

  it("同级目录与它们的父容器不受牵连", () => {
    const root = render(CLASSIC_DOM);
    markHiddenFolderNodes(root, "assets");
    expect(document.getElementById("ai-myassets")!.classList.contains(HIDDEN_FOLDER_CLASS)).toBe(
      false,
    );
    expect(document.getElementById("ai")!.classList.contains(HIDDEN_FOLDER_CLASS)).toBe(false);
    expect(document.getElementById("ai-children")!.classList.contains(HIDDEN_FOLDER_CLASS)).toBe(
      false,
    );
    expect(document.getElementById("no-images")!.classList.contains(HIDDEN_FOLDER_CLASS)).toBe(
      false,
    );
  });

  it("新版 .tree-item 结构同样命中", () => {
    const root = render(TREE_ITEM_DOM);
    expect(markHiddenFolderNodes(root, "assets")).toBe(1);
    const marked = hidden(root);
    expect(marked).toContain("AI/assets");
    expect(marked).toContain("ti-assets");
    // AI 与「AI/其他」不能被标记
    expect(document.getElementById("ti-ai")!.classList.contains(HIDDEN_FOLDER_CLASS)).toBe(false);
    expect(document.getElementById("ti-ai-children")!.classList.contains(HIDDEN_FOLDER_CLASS)).toBe(
      false,
    );
  });

  it("同名文件行只藏自己，不牵连同级的其它文件", () => {
    const root = render(`
      <div class="workspace-leaf-content" data-type="file-explorer">
        <div class="nav-folder">
          <div class="nav-folder-title" data-path="AI">AI</div>
          <div class="nav-folder-children" id="list">
            <div class="nav-file"><div class="nav-file-title" data-path="assets">assets</div></div>
            <div class="nav-file"><div class="nav-file-title" data-path="AI/其他.md">其他.md</div></div>
          </div>
        </div>
      </div>
    `);
    markHiddenFolderNodes(root, "assets");
    expect(document.querySelector('[data-path="assets"]')!.classList.contains(HIDDEN_FOLDER_CLASS)).toBe(
      true,
    );
    expect(document.getElementById("list")!.classList.contains(HIDDEN_FOLDER_CLASS)).toBe(false);
    expect(
      document.querySelector('[data-path="AI/其他.md"]')!.classList.contains(HIDDEN_FOLDER_CLASS),
    ).toBe(false);
  });

  it("幂等：重复标记不会重复计数，类也不会重复", () => {
    const root = render(CLASSIC_DOM);
    expect(markHiddenFolderNodes(root, "assets")).toBe(2);
    expect(markHiddenFolderNodes(root, "assets")).toBe(2);
    // 每处命中 3 个节点：行本身、子节点容器、该文件夹自己的容器
    expect(hidden(root).length).toBe(6);
  });

  it("目录名为空时什么都不做", () => {
    const root = render(CLASSIC_DOM);
    expect(markHiddenFolderNodes(root, "")).toBe(0);
    expect(hidden(root).length).toBe(0);
  });
});

describe("clearHiddenFolderNodes", () => {
  it("撤销全部标记（改目录名 / 关开关时不留下幽灵隐藏）", () => {
    const root = render(CLASSIC_DOM);
    markHiddenFolderNodes(root, "assets");
    expect(hidden(root).length).toBe(6);
    expect(clearHiddenFolderNodes(root)).toBe(6);
    expect(hidden(root).length).toBe(0);
  });
});
