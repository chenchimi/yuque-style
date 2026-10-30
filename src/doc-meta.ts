/**
 * 文档元信息的格式化：字数 / 阅读时长 / 相对时间 / 语雀同步状态。
 *
 * 顶部元信息行与阅读模式的文档头共用这里——同一份信息在两处显示，
 * 口径必须一致（以前字数统计只写在 reader.ts 里，顶部区域再抄一遍就迟早对不上）。
 *
 * 纯函数、不依赖 Obsidian，便于单测；时间一律靠入参传入，不用 `Date.now()`，
 * 否则「3 分钟前」这类断言会随运行时刻飘。
 */

/** 每字多少字（与阅读模式文档头保持一致） */
const WORDS_PER_MINUTE = 400;

/**
 * 字数：先去掉围栏代码块，再把 Markdown 记号换成空格，最后数**非空白字符**。
 * 口径与旧实现逐字一致——只搬位置，不改数字，免得用户觉得「字数怎么变了」。
 */
export function countWords(content: string): number {
  const plain = content.replace(/```[\s\S]*?```/g, " ").replace(/[#>*_`~|\[\]()!-]/g, " ");
  return plain.replace(/\s+/g, "").length;
}

/** 字数的展示写法：过万就换成「万字」，免得一长串数字挤在元信息行里 */
export function formatWordCount(words: number): string {
  if (words >= 10000) return `${(words / 10000).toFixed(1)} 万字`;
  return `${words} 字`;
}

export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 本地日期 YYYY-MM-DD */
export function formatDate(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 「最近编辑」的相对时间。
 * 一周以内用相对说法（刚刚 / N 分钟前 / N 小时前 / N 天前），更久就直接给日期——
 * 「37 天前」这种既算不出准确日期，也没有信息量。
 */
export function formatRelativeTime(ts: number, now: number): string {
  if (!Number.isFinite(ts) || Number.isNaN(new Date(ts).getTime())) return "";
  const diff = now - ts;
  // 时钟回拨 / 未来时间：不显示负数，按「刚刚」处理
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatDate(ts);
}

/** 解析语雀返回的 ISO 时间；拿不到或解析失败返回 null（宁可不显示，也不显示错的） */
export function parseYuqueDate(raw: unknown): Date | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const at = new Date(raw.trim());
  return Number.isNaN(at.getTime()) ? null : at;
}

export interface SyncBadge {
  /** yuque = 从语雀同步下来的文档；local = 本地新增（没有来源） */
  kind: "yuque" | "local";
  text: string;
  /** 语雀原文地址，可点击打开 */
  url: string | null;
}

/**
 * 「协作状态」位。
 *
 * Obsidian 没有多人协作，这里落成**语雀同步状态**——对这套工作流来说，
 * 「这篇是不是语雀那边同步下来的、语雀侧最后一次改动是什么时候」才是真实的协作信息。
 * 判据是 frontmatter 的「来源」（同步写入，指向语雀原文），本地新增的文档没有它。
 */
export function syncBadge(source: unknown, yuqueUpdatedAt: unknown): SyncBadge {
  const url = typeof source === "string" && /^https?:\/\//.test(source.trim()) ? source.trim() : null;
  if (!url) return { kind: "local", text: "本地文档 · 未同步", url: null };
  const at = parseYuqueDate(yuqueUpdatedAt);
  return {
    kind: "yuque",
    text: at ? `语雀 · 更新于 ${formatDate(at.getTime())}` : "语雀已同步",
    url,
  };
}
