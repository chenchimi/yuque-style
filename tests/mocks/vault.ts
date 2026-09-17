import { TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";

/**
 * 内存版 Vault，供 sync.ts 等主链逻辑做端到端测试。
 *
 * 只实现 sync.ts 实际用到的那部分 API，但语义尽量贴近真实 Obsidian：
 * - create 时文件已存在要抛错（真实 vault 同样如此，靠这个能抓出重复写入）
 * - getAbstractFileByPath 对目录返回带 children 的 TFolder（备份轮转依赖 children）
 * - adapter.exists 对「隐式目录」（有文件落在里面）同样返回 true
 */
export class FakeVault {
  /** vault 相对路径 → 文本内容 */
  readonly files = new Map<string, string>();
  /** vault 相对路径 → 二进制内容 */
  readonly binaries = new Map<string, ArrayBuffer>();
  /** 显式 mkdir 出来的目录（未含文件的空目录也在此） */
  readonly dirs = new Set<string>();
  /** 每次 create / modify 的路径，用于断言「是否真的写了文件」 */
  readonly writes: string[] = [];

  private renameHandlers: ((file: TAbstractFile, oldPath: string) => void)[] = [];

  readonly adapter = {
    exists: async (p: string): Promise<boolean> => this.exists(p),
    mkdir: async (p: string): Promise<void> => {
      this.dirs.add(this.norm(p));
    },
    write: async (p: string, data: string): Promise<void> => {
      this.files.set(this.norm(p), data);
    },
    read: async (p: string): Promise<string | null> => this.files.get(this.norm(p)) ?? null,
    writeBinary: async (p: string, data: ArrayBuffer): Promise<void> => {
      this.binaries.set(this.norm(p), data);
    },
    readBinary: async (p: string): Promise<ArrayBuffer | null> =>
      this.binaries.get(this.norm(p)) ?? null,
    remove: async (p: string): Promise<void> => {
      this.files.delete(this.norm(p));
    },
  };

  private norm(p: string): string {
    return normalizePath(p);
  }

  isFile(path: string): boolean {
    return this.files.has(this.norm(path));
  }

  /** 目录 = 显式 mkdir 过，或有文件/目录落在其下 */
  isFolder(path: string): boolean {
    const n = this.norm(path);
    if (this.dirs.has(n)) return true;
    const prefix = n ? `${n}/` : "";
    for (const f of this.files.keys()) if (f.startsWith(prefix)) return true;
    for (const d of this.dirs) if (d.startsWith(prefix)) return true;
    return false;
  }

  exists(path: string): boolean {
    return this.isFile(path) || this.isFolder(path);
  }

  /** 直接子项的完整路径（文件夹与文件一并列出） */
  private childNames(dir: string): string[] {
    const prefix = dir ? `${dir}/` : "";
    const names = new Set<string>();
    const add = (p: string) => {
      if (!p.startsWith(prefix)) return;
      const rest = p.slice(prefix.length);
      if (!rest) return;
      const i = rest.indexOf("/");
      names.add(i >= 0 ? rest.slice(0, i) : rest);
    };
    for (const p of this.files.keys()) add(p);
    for (const p of this.dirs) add(p);
    return [...names];
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    const n = this.norm(path);
    if (this.files.has(n)) return new TFile(n);
    if (!this.isFolder(n)) return null;
    const folder = new TFolder(n);
    folder.children = this.childNames(n).map((name) => {
      const childPath = n ? `${n}/${name}` : name;
      return this.files.has(childPath) ? new TFile(childPath) : new TFolder(childPath);
    });
    return folder;
  }

  getFileByPath(path: string): TFile | null {
    const f = this.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  /** 全部 markdown 文件（真实 Vault 同名 API 的等价实现） */
  getMarkdownFiles(): TFile[] {
    return [...this.files.keys()].filter((p) => p.endsWith(".md")).map((p) => new TFile(p));
  }

  async create(path: string, content: string): Promise<TFile> {
    const n = this.norm(path);
    if (this.files.has(n) || this.isFolder(n)) throw new Error(`文件已存在：${n}`);
    this.files.set(n, content);
    this.writes.push(n);
    return new TFile(n);
  }

  async modify(file: TAbstractFile, content: string): Promise<void> {
    const n = this.norm(file.path);
    if (!this.files.has(n)) throw new Error(`文件不存在：${n}`);
    this.files.set(n, content);
    this.writes.push(n);
  }

  async read(file: TAbstractFile): Promise<string> {
    const n = this.norm(file.path);
    const content = this.files.get(n);
    if (content === undefined) throw new Error(`文件不存在：${n}`);
    return content;
  }

  async delete(file: TAbstractFile): Promise<void> {
    const n = this.norm(file.path);
    this.files.delete(n);
    this.dirs.delete(n);
  }

  on(name: string, cb: (...args: never[]) => void): void {
    if (name === "rename") this.renameHandlers.push(cb as never);
  }

  /**
   * 模拟用户在 Obsidian 里重命名 / 移动，并派发 rename 事件。
   * 文件夹会连同其下所有内容一起搬走；目标已存在时抛错（与真实 vault 一致）。
   */
  async rename(file: TAbstractFile, newPath: string): Promise<void> {
    const from = this.norm(file.path);
    const to = this.norm(newPath);
    if (this.files.has(to) || this.isFolder(to)) throw new Error(`目标已存在：${to}`);
    const wasFile = this.files.has(from);
    if (wasFile) {
      const content = this.files.get(from)!;
      this.files.delete(from);
      this.files.set(to, content);
    } else {
      this.moveFolder(from, to);
    }
    const next: TAbstractFile = wasFile ? new TFile(to) : new TFolder(to);
    for (const h of this.renameHandlers) h(next, from);
  }

  private moveFolder(from: string, to: string): void {
    const prefix = `${from}/`;
    for (const [p, content] of [...this.files]) {
      if (p === from || p.startsWith(prefix)) {
        this.files.set(to + p.slice(from.length), content);
        this.files.delete(p);
      }
    }
    for (const d of [...this.dirs]) {
      if (d === from || d.startsWith(prefix)) {
        this.dirs.add(to + d.slice(from.length));
        this.dirs.delete(d);
      }
    }
  }
}
