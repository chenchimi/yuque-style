/**
 * obsidian 模块的运行时替身（仅测试用，不参与打包）。
 *
 * npm 上的 obsidian 包只发布 obsidian.d.ts，没有可执行 JS，因此任何
 * `import ... from "obsidian"` 的源码在 Node/vitest 下都无法加载 ——
 * sync.ts 这条主链长期没有自动化覆盖，根源就在这里。
 * 本文件提供最小替身，由 vitest 的 resolve.alias 顶替真实模块。
 *
 * 类型仍取自真实 obsidian.d.ts（tsconfig 只收录 src/，测试目录不参与 tsc），
 * 这里只负责运行时语义：instanceof 判定、路径归一化。
 * 其余 API（Modal / Setting / Editor / Plugin…）待对应模块需要测试时再补。
 */

export class TAbstractFile {
  path: string;

  constructor(path: string) {
    this.path = path;
  }

  get name(): string {
    const i = this.path.lastIndexOf("/");
    return i >= 0 ? this.path.slice(i + 1) : this.path;
  }
}

export class TFile extends TAbstractFile {
  get basename(): string {
    return this.name.replace(/\.[^.]+$/, "");
  }

  get extension(): string {
    const i = this.name.lastIndexOf(".");
    return i > 0 ? this.name.slice(i + 1) : "";
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

export class App {
  vault: unknown = undefined;
}

/** 与 Obsidian 一致：反斜杠转正斜杠、合并重复斜杠、去除首尾斜杠 */
export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/** 测试里不弹真实通知；记录下来便于断言 */
export class Notice {
  static messages: string[] = [];

  constructor(
    public message: string,
    public timeout?: number,
  ) {
    Notice.messages.push(message);
  }

  setMessage(message: string): void {
    this.message = message;
  }

  hide(): void {}
}

/**
 * 网络出口：默认直接失败，避免测试意外打到真实语雀 API。
 * 需要测网络层逻辑（api.ts 的节流/429 熔断等）时，
 * 用 `setRequestUrlHandler` 注入假实现，用完记得 `resetRequestUrlHandler` 还原。
 */
let requestUrlHandler: ((opts: unknown) => unknown) | null = null;

export function setRequestUrlHandler(fn: (opts: unknown) => unknown): void {
  requestUrlHandler = fn;
}

export function resetRequestUrlHandler(): void {
  requestUrlHandler = null;
}

export function requestUrl(opts: unknown): unknown {
  if (!requestUrlHandler) {
    throw new Error("requestUrl 未实现：测试不应发起真实网络请求，请注入假的 YuqueApi");
  }
  return requestUrlHandler(opts);
}

/**
 * 弹窗基类替身：只为让 `class X extends Modal` 的模块在 Node 下完成求值
 * （真实 obsidian 包没有可执行 JS，缺它时模块加载即抛
 * 「Class extends value undefined」）。元素字段用 jsdom 现造，
 * 交互方法留空——需要断言弹窗行为的测试按需在替身之上覆写。
 */
export class Modal {
  contentEl: HTMLElement;
  titleEl: HTMLElement;
  modalEl: HTMLElement;

  constructor(_app?: unknown) {
    this.contentEl = document.createElement("div");
    this.titleEl = document.createElement("div");
    this.modalEl = document.createElement("div");
  }

  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}
