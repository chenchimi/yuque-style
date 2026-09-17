/**
 * Markdown 表格的定位与行/列操作。
 *
 * 刻意做成纯字符串逻辑（不依赖 Obsidian / CodeMirror），因为这块最容易写错：
 * 列数补齐、表头与分隔行保护、删到没有数据行时整块移除。
 *
 * 约定：表格块内第 1 行是表头，第 2 行是分隔行（|---|），第 3 行起是数据行。
 * 行号一律 1 基，与 CodeMirror 的 doc.line(n) 对齐。
 */

export type TableOp =
  | "insert-row-above"
  | "insert-row-below"
  | "delete-row"
  | "insert-col-left"
  | "insert-col-right"
  | "delete-col";

export interface TableBlock {
  /** 表格起始行（1 基，含） */
  start: number;
  /** 表格结束行（1 基，含） */
  end: number;
  /** 每行的单元格文本（已去掉外框竖线，保留原样、含转义） */
  rows: string[][];
  /** 光标所在行在 rows 里的下标（0 = 表头，1 = 分隔行，2 起 = 数据行） */
  rowIndex: number;
  /** 光标所在列下标 */
  colIndex: number;
}

/** 按需读取行文本：编辑器里接 doc.line(n)，单测里接数组 */
export interface LineSource {
  count: number;
  at(line: number): string;
}

interface Cell {
  text: string;
  start: number;
  end: number;
}

/** 按未转义的 | 切分一行，并给出每个单元格在原行中的字符区间 */
export function splitRowCells(line: string): Cell[] {
  const cells: Cell[] = [];
  let buf = "";
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && i + 1 < line.length) {
      buf += ch + line[i + 1];
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push({ text: buf, start, end: i });
      buf = "";
      start = i + 1;
      continue;
    }
    buf += ch;
  }
  cells.push({ text: buf, start, end: line.length });

  // 首段/末段是纯空白时说明那是外框竖线，去掉；但空单元格本身要保留
  if (cells.length > 1 && cells[0].text.trim() === "") cells.shift();
  if (cells.length > 1 && cells[cells.length - 1].text.trim() === "") cells.pop();
  return cells;
}

export function splitRow(line: string): string[] {
  return splitRowCells(line).map((c) => c.text);
}

/** 分隔行：每个单元格都形如 :?---+:? */
export function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

/** 光标字符位置落在第几列（正好落在竖线上时算左边那一列） */
export function colIndexAt(line: string, ch: number): number {
  const cells = splitRowCells(line);
  for (let i = 0; i < cells.length; i++) {
    if (ch <= cells[i].end) return i;
  }
  return Math.max(cells.length - 1, 0);
}

/** 定位光标所在的表格块；光标不在表格里返回 null */
export function locateTable(src: LineSource, line: number, ch: number): TableBlock | null {
  if (line < 1 || line > src.count) return null;
  const current = src.at(line);
  if (!current.includes("|")) return null;

  const isRow = (n: number): boolean => {
    if (n < 1 || n > src.count) return false;
    const text = src.at(n);
    return text.trim() !== "" && text.includes("|");
  };

  let start = line;
  while (isRow(start - 1)) start--;
  let end = line;
  while (isRow(end + 1)) end++;

  const rows: string[][] = [];
  for (let n = start; n <= end; n++) rows.push(splitRow(src.at(n)));
  // 必须有「表头 + 分隔行」结构才算表格，否则只是正文里带了竖线
  if (rows.length < 2 || !isSeparatorRow(rows[1])) return null;

  return {
    start,
    end,
    rows,
    rowIndex: line - start,
    colIndex: colIndexAt(current, ch),
  };
}

/** 把各行补齐/截断到统一列数；分隔行补 --- 而不是空串 */
function normalize(rows: string[][], width: number): string[][] {
  return rows.map((row, index) => {
    const cells = row.slice(0, width);
    while (cells.length < width) cells.push(index === 1 ? "---" : "");
    return cells;
  });
}

/**
 * 执行一次行列操作，返回新的表格块文本（用来替换 start..end 之间的内容）。
 * - null：操作被拒绝（例如要删表头行、要删掉最后一列）
 * - []：整个表格应被移除（删掉了最后一个数据行）
 */
export function applyTableOp(block: TableBlock, op: TableOp): string[] | null {
  const width = Math.max(0, ...block.rows.map((r) => r.length));
  if (width === 0) return null;
  const rows = normalize(block.rows, width);
  const row = block.rowIndex;
  const col = Math.min(block.colIndex, width - 1);

  switch (op) {
    case "insert-row-above":
      // 表头之前、以及表头与分隔行之间都不能插数据行
      rows.splice(Math.max(row, 2), 0, new Array(width).fill(""));
      break;
    case "insert-row-below":
      rows.splice(Math.max(row + 1, 2), 0, new Array(width).fill(""));
      break;
    case "delete-row":
      if (row < 2) return null;
      rows.splice(row, 1);
      // 已经没有任何数据行：与其留一个空壳，不如整块移除
      if (rows.length <= 2) return [];
      break;
    case "insert-col-left":
    case "insert-col-right": {
      const at = op === "insert-col-left" ? col : col + 1;
      rows.forEach((cells, index) => cells.splice(at, 0, index === 1 ? "---" : ""));
      break;
    }
    case "delete-col":
      if (width <= 1) return null;
      rows.forEach((cells) => cells.splice(col, 1));
      break;
  }

  return rows.map((cells) => `| ${cells.map((c) => c.trim()).join(" | ")} |`);
}
