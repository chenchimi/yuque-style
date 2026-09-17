/**
 * 同步状态表。
 *
 * 旧版本只存 `updated_at` 字符串，本地路径每次靠 TOC + 标题现算，
 * 因此无法回答「这个文件现在在哪」——用户重命名或移动后插件查不到原文件，
 * 只能再次 create，从而产生重复文件。
 * 这里额外记录 path / url / title，为 rename 跟随与冲突检测提供依据。
 */

export interface YuqueDocState {
  /** 语雀侧 updated_at，用于增量判定 */
  updatedAt: string;
  /** 本地 vault 相对路径（不含 .md 后缀）；旧记录迁移后为空串，表示「未知」 */
  path: string;
  /** 语雀线上地址 */
  url: string;
  /** 同步时的文档标题 */
  title: string;
  /** 上次写入内容的指纹，用于判断本地是否被用户改动；空串表示「未知」 */
  hash: string;
  /**
   * 上次同步时由语雀 TOC 推出的分组（相对任务目标文件夹，"" = 直接放在根下）。
   *
   * 这是判断「语雀端给分组改名 / 挪动」的唯一依据：文档正文没变时 updated_at 也不变，
   * 只看 updated_at 会整组跳过，本地目录名永远停在旧的那一个。
   * `null` 表示未知（升级前写下的旧记录），此时不猜、只补记，避免把用户自己改的目录名搬回去。
   */
  folder: string | null;
}

/** key 为 `${namespace}/${slug}` */
export type YuqueSyncState = Record<string, YuqueDocState>;

const EMPTY_STATE: YuqueDocState = {
  updatedAt: "",
  path: "",
  url: "",
  title: "",
  hash: "",
  folder: null,
};

export function stateKey(namespace: string, slug: string): string {
  return `${namespace}/${slug}`;
}

export function docUrl(namespace: string, slug: string): string {
  return `https://www.yuque.com/${namespace}/${slug}`;
}

/** 归一化单条记录：兼容旧的字符串格式，无法识别时返回 null（调用方丢弃） */
function toDocState(raw: unknown): YuqueDocState | null {
  // 旧格式：value 直接就是 updated_at
  if (typeof raw === "string") return { ...EMPTY_STATE, updatedAt: raw };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  return {
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : "",
    path: typeof o.path === "string" ? o.path : "",
    url: typeof o.url === "string" ? o.url : "",
    title: typeof o.title === "string" ? o.title : "",
    hash: typeof o.hash === "string" ? o.hash : "",
    // 缺字段 = 升级前写下的记录，分组历史无从得知 → null（未知）
    folder: typeof o.folder === "string" ? o.folder : null,
  };
}

/**
 * 内容指纹：两组不同乘数的 32 位 hash 拼接。
 * 单组 32 位对长文档存在碰撞可能，而碰撞的后果是「用户改过却判定为未改」从而漏备份，
 * 因此用两组不同乘数降低碰撞概率。
 */
export function hashContent(content: string): string {
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    h1 = (h1 * 33 + c) >>> 0;
    h2 = (h2 * 31 + c) >>> 0;
  }
  return `${h1.toString(36)}-${h2.toString(36)}`;
}

/** 写入决策 */
export type WriteDecision =
  /** 本地不存在，新建 */
  | "create"
  /** 本地存在且未被用户改动，直接覆盖 */
  | "overwrite"
  /** 本地存在且已被改动（或改动与否未知），先备份再覆盖 */
  | "backup-overwrite"
  /** 本地内容与待写内容一致，无需写入 */
  | "skip-identical";

/**
 * 判断本次写入应如何处理本地已有文件。
 *
 * knownHash 为空表示「上次写入内容未知」（旧记录或未同步过）。此时只要本地内容
 * 与待写内容不同，就保守地先备份——宁可多留一份，不可丢改动。
 */
export function decideWrite(args: {
  exists: boolean;
  currentContent: string | null;
  nextContent: string;
  knownHash?: string;
}): WriteDecision {
  const { exists, currentContent, nextContent, knownHash } = args;
  if (!exists || currentContent === null) return "create";
  if (currentContent === nextContent) return "skip-identical";
  if (!knownHash) return "backup-overwrite";
  return hashContent(currentContent) === knownHash ? "overwrite" : "backup-overwrite";
}

/**
 * 把任意历史格式的同步状态升级为结构化记录。
 *
 * 必须保持幂等：每次 loadSettings 都会调用，重复执行结果不变。
 * 同时不能引入「升级后全量重拉」——旧记录的 updated_at 会原样保留。
 */
export function migrateSyncState(raw: unknown): YuqueSyncState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: YuqueSyncState = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // 合法 key 形如 `${ns}/${slug}`，其余视为脏数据丢弃
    if (!key || !key.includes("/")) continue;
    const next = toDocState(value);
    if (!next) continue;
    out[key] = next;
  }
  return out;
}

/**
 * 让同步记录跟随 vault 内的重命名 / 移动。
 *
 * oldPath / newPath 是 vault 完整路径；文件的带 .md 后缀，而 state.path 不带，
 * 因此需要按类型分别处理。文件夹重命名时，其下所有记录的 path 前缀一并替换
 * （Obsidian 只为该文件夹派发一次事件，不会为每个子文件各派发一次）。
 *
 * 原地修改 state，返回被更新的 key 列表；空数组表示无变化、无需落盘。
 */
export function applyRename(
  state: YuqueSyncState,
  oldPath: string,
  newPath: string,
  isFolder: boolean,
): string[] {
  const changed: string[] = [];
  if (!oldPath || !newPath) return changed;

  let oldBase: string;
  let newBase: string;
  if (isFolder) {
    oldBase = oldPath;
    newBase = newPath;
  } else {
    // 只跟踪笔记本体；图片等附件不在 state 里
    if (!oldPath.endsWith(".md") || !newPath.endsWith(".md")) return changed;
    oldBase = oldPath.slice(0, -3);
    newBase = newPath.slice(0, -3);
  }
  if (!oldBase) return changed;

  // 带斜杠，避免 `yuque/a` 误匹配到 `yuque/ab`
  const prefix = `${oldBase}/`;
  for (const [key, rec] of Object.entries(state)) {
    // path 为空表示「位置未知」（旧记录），无从匹配，留待下一轮同步重新解析
    if (!rec.path) continue;
    const hit = isFolder
      ? rec.path === oldBase || rec.path.startsWith(prefix)
      : rec.path === oldBase;
    if (!hit) continue;
    rec.path = newBase + rec.path.slice(oldBase.length);
    changed.push(key);
  }
  return changed;
}

/**
 * 语雀端目录调整后，决定把哪个旧位置的文件搬移到新位置（而不是另建一份）。
 *
 * 优先级：state 记录的旧路径（本地真实位置）> 按标题在目标文件夹内的唯一匹配。
 * 匹配到多个同名文件时不猜（返回 null，走正常新建），避免搬错文档。
 * 返回值只是候选，调用方必须确认该路径的文件确实存在且 ≠ 新路径。
 */
export function pickRelocateSource(
  recPath: string,
  newPath: string,
  titleMatches: string[],
): string | null {
  if (!newPath) return null;
  if (recPath && recPath !== newPath) return recPath;
  return titleMatches.length === 1 ? titleMatches[0] : null;
}

/** 路径最后一段（文件名，不含 .md） */
function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * 从本地路径反推它所在的语雀分组（相对任务目标文件夹）。
 *
 * 只用于给升级前写下的旧记录补一个「上次分组」的初值：这类记录没有分组历史，
 * 先按当前本地结构认账，之后语雀端再改分组才跟随。
 * 路径不在目标文件夹下（用户把整个任务目录搬走了）时返回 null，表示无从判断。
 */
export function folderOfPath(path: string, targetFolder: string): string | null {
  if (!path) return null;
  const prefix = targetFolder ? `${targetFolder}/` : "";
  if (prefix && !path.startsWith(prefix)) return null;
  const rel = prefix ? path.slice(prefix.length) : path;
  const seg = rel.split("/");
  seg.pop(); // 去掉文件名，剩下的是分组层级
  return seg.join("/");
}

/**
 * 语雀端分组改名 / 挪动后，本地文件应搬去的新路径。
 *
 * `prevFolder` 为记录里的语雀分组，`nextFolder` 为本次 TOC 推出的分组；两者相同即无事发生。
 * 只替换「分组」这一段，文件名与更上层的目录原样保留——用户在本地改过的文件名，
 * 以及整个任务目录被搬走的情况都不受影响。
 *
 * 两种情况返回 null（不搬）：
 * - `prevFolder` 未知（旧记录）——不猜，避免把用户自己改的目录名搬回去；
 * - 本地路径结尾对不上记录里的分组（用户自己改过分组名）——尊重用户的选择。
 */
export function followTocFolderMove(
  recPath: string,
  prevFolder: string | null,
  nextFolder: string,
): string | null {
  if (!recPath || prevFolder === null || prevFolder === nextFolder) return null;
  const name = nameOf(recPath);
  const prevSeg = prevFolder ? `${prevFolder}/${name}` : name;
  if (!recPath.endsWith(prevSeg)) return null;
  const prefix = recPath.slice(0, recPath.length - prevSeg.length);
  // 段边界必须落在 `/` 上，否则「我的分组」会被误配成「分组」
  if (prefix && !prefix.endsWith("/")) return null;
  // 目标分组已经在这条路径上（例如用户自己先把文件放进了同名目录）→ 视为已就位，
  // 否则会套出 `语雀/新分组/新分组/标题A` 这种越搬越深的路径
  if (nextFolder && prefix.endsWith(`${nextFolder}/`)) return null;
  const nextSeg = nextFolder ? `${nextFolder}/${name}` : name;
  return `${prefix}${nextSeg}`;
}
