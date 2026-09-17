import { describe, expect, it } from "vitest";
import {
  applyTableOp,
  colIndexAt,
  isSeparatorRow,
  locateTable,
  splitRow,
  type LineSource,
} from "../src/table";

function source(lines: string[]): LineSource {
  return { count: lines.length, at: (n) => lines[n - 1] };
}

/** 一张标准三行表：表头 + 分隔行 + 一行数据 */
const TABLE = ["| a | b |", "| --- | --- |", "| 1 | 2 |"];
const atDataRow = (lines: string[], ch = 2) => {
  const block = locateTable(source(lines), 3, ch);
  if (!block) throw new Error("测试数据本身不是表格");
  return block;
};

describe("splitRow", () => {
  it("去掉外框竖线", () => {
    expect(splitRow("| a | b |")).toEqual([" a ", " b "]);
  });

  it("没有外框竖线时也能切分", () => {
    expect(splitRow("a | b")).toEqual(["a ", " b"]);
  });

  it("保留空的单元格", () => {
    expect(splitRow("| a |  | b |")).toEqual([" a ", "  ", " b "]);
  });

  it("转义的竖线不参与切分", () => {
    expect(splitRow("| a \\| b | c |")).toEqual([" a \\| b ", " c "]);
  });

  it("单列表格", () => {
    expect(splitRow("| a |")).toEqual([" a "]);
  });

  it("前导空白不影响判定", () => {
    expect(splitRow("   | a |")).toEqual([" a "]);
  });
});

describe("isSeparatorRow", () => {
  it("全横线算分隔行", () => {
    expect(isSeparatorRow(["---", " --- "])).toBe(true);
  });

  it("带对齐冒号也算", () => {
    expect(isSeparatorRow([":---", "---:", ":---:"])).toBe(true);
  });

  it("只要有一格不是横线就不算", () => {
    expect(isSeparatorRow(["---", "a"])).toBe(false);
  });

  it("空行不算", () => {
    expect(isSeparatorRow([])).toBe(false);
  });
});

describe("colIndexAt", () => {
  const line = "| a | b |";

  it("落在单元格内", () => {
    expect(colIndexAt(line, 2)).toBe(0);
    expect(colIndexAt(line, 6)).toBe(1);
  });

  it("正好落在竖线上 → 算左边那一列", () => {
    expect(colIndexAt(line, 4)).toBe(0);
  });

  it("落到行尾 → 算最后一列", () => {
    expect(colIndexAt(line, 99)).toBe(1);
  });
});

describe("locateTable", () => {
  it("定位到完整的表格块与光标所在行列", () => {
    const lines = [...TABLE, "| 3 | 4 |", "", "正文"];
    const block = locateTable(source(lines), 3, 6);
    expect(block).not.toBeNull();
    expect(block!.start).toBe(1);
    expect(block!.end).toBe(4);
    expect(block!.rowIndex).toBe(2);
    expect(block!.colIndex).toBe(1);
  });

  it("光标在表头行时为第 0 行", () => {
    expect(locateTable(source(TABLE), 1, 2)!.rowIndex).toBe(0);
  });

  it("光标在分隔行时为第 1 行", () => {
    expect(locateTable(source(TABLE), 2, 2)!.rowIndex).toBe(1);
  });

  it("光标不在表格里 → null", () => {
    expect(locateTable(source([...TABLE, "", "正文"]), 5, 0)).toBeNull();
  });

  it("有竖线但没有分隔行 → 不算表格", () => {
    expect(locateTable(source(["a | b", "c | d"]), 1, 0)).toBeNull();
  });

  it("重叠的普通正文行不会被吞进表格", () => {
    const lines = ["正文", ...TABLE, "正文结束"];
    const block = locateTable(source(lines), 3, 2);
    expect(block!.start).toBe(2);
    expect(block!.end).toBe(4);
  });
});

describe("applyTableOp · 行操作", () => {
  it("上方插入行：插在光标所在行之前", () => {
    const lines = ["| a | b |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |"];
    expect(applyTableOp(atDataRow(lines), "insert-row-above")).toEqual([
      "| a | b |",
      "| --- | --- |",
      "|  |  |",
      "| 1 | 2 |",
      "| 3 | 4 |",
    ]);
  });

  it("下方插入行：插在光标所在行之后", () => {
    const lines = ["| a | b |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |"];
    expect(applyTableOp(atDataRow(lines), "insert-row-below")).toEqual([
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "|  |  |",
      "| 3 | 4 |",
    ]);
  });

  it("光标在表头时插入，不会插到表头之前", () => {
    const block = locateTable(source(TABLE), 1, 2)!;
    expect(applyTableOp(block, "insert-row-above")).toEqual([
      "| a | b |",
      "| --- | --- |",
      "|  |  |",
      "| 1 | 2 |",
    ]);
  });

  it("光标在分隔行时插入，不会插进表头与分隔行之间", () => {
    const block = locateTable(source(TABLE), 2, 2)!;
    expect(applyTableOp(block, "insert-row-above")).toEqual([
      "| a | b |",
      "| --- | --- |",
      "|  |  |",
      "| 1 | 2 |",
    ]);
  });

  it("表头行不能删除", () => {
    const block = locateTable(source(TABLE), 1, 2)!;
    expect(applyTableOp(block, "delete-row")).toBeNull();
  });

  it("分隔行不能删除", () => {
    const block = locateTable(source(TABLE), 2, 2)!;
    expect(applyTableOp(block, "delete-row")).toBeNull();
  });

  it("删除数据行", () => {
    const lines = ["| a | b |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |"];
    expect(applyTableOp(atDataRow(lines), "delete-row")).toEqual([
      "| a | b |",
      "| --- | --- |",
      "| 3 | 4 |",
    ]);
  });

  it("删掉最后一个数据行 → 整块移除（返回空数组）", () => {
    expect(applyTableOp(atDataRow(TABLE), "delete-row")).toEqual([]);
  });
});

describe("applyTableOp · 列操作", () => {
  it("左侧插入列：每一行都补，分隔行补 ---", () => {
    const block = locateTable(source(TABLE), 3, 2)!;
    expect(applyTableOp(block, "insert-col-left")).toEqual([
      "|  | a | b |",
      "| --- | --- | --- |",
      "|  | 1 | 2 |",
    ]);
  });

  it("右侧插入列", () => {
    const block = locateTable(source(TABLE), 3, 6)!;
    expect(applyTableOp(block, "insert-col-right")).toEqual([
      "| a | b |  |",
      "| --- | --- | --- |",
      "| 1 | 2 |  |",
    ]);
  });

  it("删除列", () => {
    const block = locateTable(source(TABLE), 3, 6)!;
    expect(applyTableOp(block, "delete-col")).toEqual(["| a |", "| --- |", "| 1 |"]);
  });

  it("最后一列不能删除", () => {
    const single = ["| a |", "| --- |", "| 1 |"];
    const block = locateTable(source(single), 3, 2)!;
    expect(applyTableOp(block, "delete-col")).toBeNull();
  });

  it("列数不齐的脏表格会被补齐后再操作", () => {
    const dirty = ["| a | b |", "| --- | --- |", "| 1 |"];
    const block = locateTable(source(dirty), 3, 2)!;
    expect(applyTableOp(block, "insert-col-right")).toEqual([
      "| a |  | b |",
      "| --- | --- | --- |",
      "| 1 |  |  |",
    ]);
  });

  it("多余列会被截断到最宽行", () => {
    const wide = ["| a | b | c |", "| --- | --- |", "| 1 | 2 |"];
    const block = locateTable(source(wide), 3, 2)!;
    expect(applyTableOp(block, "insert-row-below")).toEqual([
      "| a | b | c |",
      "| --- | --- | --- |",
      "| 1 | 2 |  |",
      "|  |  |  |",
    ]);
  });
});
