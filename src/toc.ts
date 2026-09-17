/**
 * 由标题列表生成「文档内目录块」。
 *
 * 语雀的目录块是嵌在正文里的标题列表；在 Markdown 里最稳的表达就是一组
 * Obsidian 同文件双链 `[[#标题]]`——纯文本、可编辑，阅读模式和实时预览都能点。
 * 这是一份静态快照：标题改了需要重新生成一次，而不是动态渲染
 * （动态渲染离不开 markdown post processor，那东西在实时预览下根本不跑）。
 */

export interface HeadingLike {
  level: number;
  heading: string;
}

export function buildTocBlock(headings: HeadingLike[]): string {
  const valid = headings.filter((h) => h.heading.trim() !== "");
  if (valid.length === 0) return "";
  // 以最浅的标题为顶级，避免文档从 h2 起笔时整块被缩进
  const top = Math.min(...valid.map((h) => h.level));
  return valid
    .map((h) => `${"  ".repeat(Math.max(h.level - top, 0))}- [[#${h.heading.trim()}]]`)
    .join("\n");
}
