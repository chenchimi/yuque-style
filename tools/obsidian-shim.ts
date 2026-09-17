/**
 * 离线 shim：在 Node 下替代 `obsidian` 模块，让 src/yuque/* 可以被原样复用。
 *
 * 只实现被复用路径上真正用到的几个 API，**不改动 src 任何文件**。
 * 通过 esbuild 的 alias 生效：obsidian → 本文件。
 */

/** 与 Obsidian 同名函数的行为对齐：反斜杠转正斜杠、合并重复斜杠、去掉首尾斜杠 */
export function normalizePath(p: string): string {
  return (p ?? "")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/** sync.ts 里只用于 `instanceof` 判定，离线工具不依赖真实实现 */
export class TFile {}
export class TFolder {}
export class App {}

export interface RequestUrlOpts {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  throw?: boolean;
}

/**
 * fetch 版 requestUrl。
 * api.ts 只会传 throw:false，因此这里从不因状态码抛异常，状态码交给调用方判断。
 */
export async function requestUrl(opts: RequestUrlOpts): Promise<any> {
  const res = await fetch(opts.url, {
    method: opts.method ?? "GET",
    headers: opts.headers as any,
    body: opts.body as any,
  });
  const buf = await res.arrayBuffer();
  const text = new TextDecoder("utf-8").decode(buf);
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text, arrayBuffer: buf };
}
