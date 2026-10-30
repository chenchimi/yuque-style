import { describe, expect, it, beforeEach } from "vitest";
import {
  clearSyncedDocNodes,
  markSyncedDocNodes,
  syncedDocPaths,
  SYNCED_DOC_CLASS,
} from "../src/yuque/explorer-sync";

/** 仿 Obsidian 文件浏览器 DOM：带 data-path 的条目（新旧两套结构各来一个） */
function fileEl(path: string, modern: boolean): HTMLElement {
  const row = document.createElement("div");
  row.setAttribute("data-path", path);
  const inner = document.createElement("div");
  inner.className = modern ? "tree-item-inner" : "nav-file-title-content";
  inner.textContent = path.split("/").pop() ?? path;
  row.appendChild(inner);
  return row;
}

describe("syncedDocPaths（同步记录 → 标记路径集合）", () => {
  it("path 补上 .md 扩展名；无 path 的脏记录跳过；空记录 → 空集合", () => {
    expect(
      syncedDocPaths({
        "u/a/doc": { path: "语雀/doc" },
        "u/a/broken": { title: "没有 path" },
      }),
    ).toEqual(new Set(["语雀/doc.md"]));
    expect(syncedDocPaths({})).toEqual(new Set());
  });
});

describe("markSyncedDocNodes（文件浏览器标记/自愈）", () => {
  let root: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
    root.appendChild(fileEl("语雀/doc.md", false));
    root.appendChild(fileEl("本地/note.md", true));
    root.appendChild(fileEl("assets", false)); // 文件夹不以 .md 结尾
    root.appendChild(fileEl("语雀/doc.md/assets", false));
  });

  it("命中同步记录的 .md 条目打类，其余不动", () => {
    const hits = markSyncedDocNodes(root, syncedDocPaths({ k: { path: "语雀/doc" } }));
    expect(hits).toBe(1);
    expect(root.children[0].classList.contains(SYNCED_DOC_CLASS)).toBe(true);
    expect(root.children[1].classList.contains(SYNCED_DOC_CLASS)).toBe(false);
    // 文件夹与其子目录（即使名字带 assets 且路径以 .md 结尾）不受影响
    expect(root.children[2].classList.contains(SYNCED_DOC_CLASS)).toBe(false);
  });

  it("重复调用幂等，命中数不虚增", () => {
    const synced = syncedDocPaths({ k: { path: "语雀/doc" } });
    expect(markSyncedDocNodes(root, synced)).toBe(1);
    expect(markSyncedDocNodes(root, synced)).toBe(1);
  });

  it("记录清空后旧标记被摘掉（自愈，不留幽灵圆点）", () => {
    const synced = syncedDocPaths({ k: { path: "语雀/doc" } });
    markSyncedDocNodes(root, synced);
    expect(markSyncedDocNodes(root, new Set())).toBe(0);
    expect(root.children[0].classList.contains(SYNCED_DOC_CLASS)).toBe(false);
  });

  it("clearSyncedDocNodes 清掉全部标记", () => {
    markSyncedDocNodes(root, syncedDocPaths({ k: { path: "语雀/doc" } }));
    expect(clearSyncedDocNodes(root)).toBe(1);
    expect(root.querySelectorAll(`.${SYNCED_DOC_CLASS}`).length).toBe(0);
  });
});
