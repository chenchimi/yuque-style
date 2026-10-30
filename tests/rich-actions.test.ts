import { describe, expect, it } from "vitest";
import {
  advance,
  clearFormatting,
  insertBlockAtCursor,
  insertLink,
  paragraphStyleLabel,
  paragraphStyleOf,
  selectedLines,
  selectionText,
  setParagraphStyle,
  setTextColor,
  toggleList,
  toggleWrap,
  wrapCodeBlock,
  type Snapshot,
} from "../src/rich-actions";

/** 造快照：lines 为各行文本，选区用 [行, 列] 表示（默认光标停在文首） */
function snap(
  lines: string[],
  from: [number, number] = [0, 0],
  to: [number, number] = from,
): Snapshot {
  return { lines, from: { line: from[0], ch: from[1] }, to: { line: to[0], ch: to[1] } };
}

/** 把编辑计划应用到文本上，方便断言「最终长什么样」 */
function apply(s: Snapshot, edits: { from: { line: number; ch: number }; to: { line: number; ch: number }; text: string }[]): string {
  const lines = [...s.lines];
  const ordered = [...edits].sort(
    (a, b) => b.from.line - a.from.line || b.from.ch - a.from.ch,
  );
  for (const e of ordered) {
    const head = lines[e.from.line].slice(0, e.from.ch);
    const tail = lines[e.to.line].slice(e.to.ch);
    const merged = head + e.text + tail;
    lines.splice(e.from.line, e.to.line - e.from.line + 1, ...merged.split("\n"));
  }
  return lines.join("\n");
}

describe("paragraphStyleOf / paragraphStyleLabel", () => {
  it("认标题、引用与正文", () => {
    expect(paragraphStyleOf("# 标题")).toBe("h1");
    expect(paragraphStyleOf("###### 小标题")).toBe("h6");
    expect(paragraphStyleOf("> 引用")).toBe("quote");
    expect(paragraphStyleOf("普通文字")).toBe("body");
    expect(paragraphStyleOf("#没空格")).toBe("body");
  });

  it("下拉按钮上的文案", () => {
    expect(paragraphStyleLabel("body")).toBe("正文");
    expect(paragraphStyleLabel("h3")).toBe("标题 3");
    expect(paragraphStyleLabel("quote")).toBe("引用块");
  });
});

describe("selectionText / selectedLines", () => {
  it("单行选区就是切片", () => {
    expect(selectionText(snap(["abcdef"], [0, 2], [0, 4]))).toBe("cd");
  });

  it("跨行选区按 \n 拼回去（与编辑器里的实际文本一致）", () => {
    expect(selectionText(snap(["abc", "def"], [0, 1], [1, 2]))).toBe("bc\nde");
    expect(selectionText(snap(["abc", "def"], [0, 0], [1, 3]))).toBe("abc\ndef");
  });

  it("收尾落在行首时最后一行不算被选中", () => {
    expect(selectedLines(snap(["a", "b"], [0, 0], [1, 0]))).toEqual({ first: 0, last: 0 });
    expect(selectedLines(snap(["a", "b"], [0, 0], [1, 1]))).toEqual({ first: 0, last: 1 });
  });

  it("advance 跨行时落到最后一行的行内偏移", () => {
    expect(advance({ line: 3, ch: 1 }, "ab")).toEqual({ line: 3, ch: 3 });
    expect(advance({ line: 3, ch: 1 }, "a\nbc")).toEqual({ line: 4, ch: 2 });
  });
});

describe("setParagraphStyle", () => {
  it("正文 → 标题 2", () => {
    const s = snap(["标题文字"], [0, 0], [0, 4]);
    const plan = setParagraphStyle(s, "h2");
    expect(apply(s, plan.edits)).toBe("## 标题文字");
    // 光标按前缀长度平移，连点两个按钮不会越点越偏
    expect(plan.selection).toEqual({ from: { line: 0, ch: 3 }, to: { line: 0, ch: 7 } });
  });

  it("标题 1 → 标题 3 时替换而不是叠加（不会变成 # ### 标题）", () => {
    expect(apply(snap(["# 标题"]), setParagraphStyle(snap(["# 标题"]), "h3").edits)).toBe("### 标题");
  });

  it("任何样式 → 正文时剥掉前缀", () => {
    expect(apply(snap(["### 标题"]), setParagraphStyle(snap(["### 标题"]), "body").edits)).toBe("标题");
    expect(apply(snap(["> 引用"]), setParagraphStyle(snap(["> 引用"]), "body").edits)).toBe("引用");
  });

  it("引用块样式加 '> '", () => {
    expect(apply(snap(["引用"]), setParagraphStyle(snap(["引用"]), "quote").edits)).toBe("> 引用");
  });

  it("本来就是正文 → 不改动（幂等，不产生多余编辑）", () => {
    expect(setParagraphStyle(snap(["普通"], [0, 0], [0, 2]), "body").edits).toEqual([]);
  });

  it("多行选区逐行改", () => {
    const s = snap(["A", "B"], [0, 0], [1, 1]);
    expect(apply(s, setParagraphStyle(s, "h1").edits)).toBe("# A\n# B");
  });

  it("选区收尾在行首时不动那一行", () => {
    const s = snap(["A", "B"], [0, 0], [1, 0]);
    expect(apply(s, setParagraphStyle(s, "h1").edits)).toBe("# A\nB");
  });
});

describe("toggleList", () => {
  it("加无序列表并保留缩进", () => {
    const s = snap(["  条目"], [0, 2], [0, 4]);
    expect(apply(s, toggleList(s, "bullet").edits)).toBe("  - 条目");
  });

  it("已是同类型 → 取消（再点一次回到普通段落）", () => {
    const s = snap(["- 条目"]);
    expect(apply(s, toggleList(s, "bullet").edits)).toBe("条目");
  });

  it("无序 → 有序：不会两套标记叠在一起", () => {
    const s = snap(["- 条目"]);
    expect(apply(s, toggleList(s, "ordered").edits)).toBe("1. 条目");
  });

  it("待办不会被「无序列表」按钮吃掉方框（而是整行转成普通无序）", () => {
    const s = snap(["- [ ] 待办"]);
    expect(apply(s, toggleList(s, "bullet").edits)).toBe("- 待办");
  });

  it("待办的开关是双向的", () => {
    const s1 = snap(["待办"]);
    expect(apply(s1, toggleList(s1, "task").edits)).toBe("- [ ] 待办");
    const s2 = snap(["- [ ] 待办"]);
    expect(apply(s2, toggleList(s2, "task").edits)).toBe("待办");
  });

  it("多行统一成有序列表", () => {
    const s = snap(["一", "二"], [0, 0], [1, 1]);
    expect(apply(s, toggleList(s, "ordered").edits)).toBe("1. 一\n1. 二");
  });
});

describe("toggleWrap", () => {
  it("包裹选区并把选区留在文字上", () => {
    const s = snap(["选中文字"], [0, 0], [0, 4]);
    const plan = toggleWrap(s, "**");
    expect(apply(s, plan.edits)).toBe("**选中文字**");
    expect(plan.selection).toEqual({ from: { line: 0, ch: 2 }, to: { line: 0, ch: 6 } });
  });

  it("标记在选区内 → 去掉（不叠第二层）", () => {
    const s = snap(["**选中文字**"], [0, 0], [0, 10]);
    expect(apply(s, toggleWrap(s, "**").edits)).toBe("选中文字");
  });

  it("标记紧贴选区外侧 → 也能去掉", () => {
    const s = snap(["**选中文字**"], [0, 2], [0, 6]);
    const plan = toggleWrap(s, "**");
    expect(apply(s, plan.edits)).toBe("选中文字");
    expect(plan.selection).toEqual({ from: { line: 0, ch: 0 }, to: { line: 0, ch: 4 } });
  });

  it("空选区 → 插入成对标记并把光标放进中间", () => {
    const s = snap(["ab"], [0, 1]);
    const plan = toggleWrap(s, "**");
    expect(apply(s, plan.edits)).toBe("a****b");
    expect(plan.selection).toEqual({ from: { line: 0, ch: 3 }, to: { line: 0, ch: 3 } });
  });

  it("不对称标记（下划线用 <u></u>）", () => {
    const s = snap(["下划线"], [0, 0], [0, 3]);
    expect(apply(s, toggleWrap(s, "<u>", "</u>").edits)).toBe("<u>下划线</u>");
  });

  it("跨行包裹", () => {
    const s = snap(["a", "b"], [0, 0], [1, 1]);
    expect(apply(s, toggleWrap(s, "==").edits)).toBe("==a\nb==");
  });
});

describe("wrapCodeBlock", () => {
  it("有选区时用围栏包住（可带语言）", () => {
    const s = snap(["a", "b"], [0, 0], [1, 1]);
    expect(apply(s, wrapCodeBlock(s, "python").edits)).toBe("```python\na\nb\n```");
  });

  it("无选区时插入空围栏，光标落在两行之间", () => {
    const s = snap([""], [0, 0]);
    const plan = wrapCodeBlock(s);
    expect(apply(s, plan.edits)).toBe("```\n\n```");
    expect(plan.selection).toEqual({ from: { line: 1, ch: 0 }, to: { line: 1, ch: 0 } });
  });
});

describe("insertBlockAtCursor（分割线等块级插入）", () => {
  it("光标在行中间也不会把一句话劈成两半", () => {
    const s = snap(["abc"], [0, 1]);
    const plan = insertBlockAtCursor(s, "---");
    expect(apply(s, plan.edits)).toBe("abc\n\n---\n");
    expect(plan.selection).toEqual({ from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } });
  });

  it("空行上直接占用该行", () => {
    const s = snap([""], [0, 0]);
    expect(apply(s, insertBlockAtCursor(s, "2026-09-22").edits)).toBe("2026-09-22\n");
  });
});

describe("insertLink", () => {
  it("有选区时用选区做锚文本", () => {
    const s = snap(["文字"], [0, 0], [0, 2]);
    expect(apply(s, insertLink(s, "https://x.com").edits)).toBe("[文字](https://x.com)");
  });

  it("无选区时插入空锚文本并把光标停进方括号", () => {
    const s = snap([""], [0, 0]);
    const plan = insertLink(s, "https://x.com");
    expect(apply(s, plan.edits)).toBe("[](https://x.com)");
    expect(plan.selection).toEqual({ from: { line: 0, ch: 1 }, to: { line: 0, ch: 1 } });
  });
});

describe("setTextColor", () => {
  it("写入与语雀同步同一套 span 语法", () => {
    const s = snap(["文字"], [0, 0], [0, 2]);
    expect(apply(s, setTextColor(s, "#e53935")!.edits)).toBe(
      '<span style="color:#e53935">文字</span>',
    );
  });

  it("color 为 null 时清掉颜色标签", () => {
    const s = snap(['<span style="color:#e53935">文字</span>'], [0, 0], [0, 37]);
    expect(apply(s, setTextColor(s, null)!.edits)).toBe("文字");
  });

  it("没有颜色标签时返回 null（不产生无意义的编辑）", () => {
    const s = snap(["文字"], [0, 0], [0, 2]);
    expect(setTextColor(s, null)).toBeNull();
  });

  it("空选区返回 null（上色必须先选文字）", () => {
    expect(setTextColor(snap(["文字"], [0, 1]), "#000")).toBeNull();
  });
});

describe("clearFormatting", () => {
  it("清掉常见行内标记", () => {
    const s = snap(["**粗** ~~删~~ ==高== <u>下</u>"], [0, 0], [0, 29]);
    expect(apply(s, clearFormatting(s)!.edits)).toBe("粗 删 高 下");
  });

  it("清掉颜色 span 与行内代码", () => {
    const s = snap(['<span style="color:red">红</span>与`码`'], [0, 0], [0, 39]);
    expect(apply(s, clearFormatting(s)!.edits)).toBe("红与码");
  });

  it("本来就没有标记 → null", () => {
    const s = snap(["干净文字"], [0, 0], [0, 4]);
    expect(clearFormatting(s)).toBeNull();
  });

  it("不动行前缀（标题/列表属于段落样式）", () => {
    const s = snap(["## **粗**"], [0, 0], [0, 9]);
    expect(apply(s, clearFormatting(s)!.edits)).toBe("## 粗");
  });
});
