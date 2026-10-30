import { Modal, Setting } from "obsidian";
import type { App } from "obsidian";
import type { YuqueStylePlugin } from "../main";
import type { SyncLogFn } from "./sync";

/** 同步进度弹窗：滚动日志 */
export class SyncModal extends Modal {
  private logEl!: HTMLElement;

  constructor(app: App, private title: string) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    this.contentEl.empty();
    this.logEl = this.contentEl.createDiv({ cls: "yuque-sync-log" });
    this.modalEl.addClass("yuque-sync-modal");
  }

  log(msg: string, type: "info" | "success" | "error" = "info"): void {
    if (!this.logEl) return;
    const line = this.logEl.createDiv({ cls: `yuque-sync-log-line yuque-sync-${type}` });
    line.setText(`[${new Date().toLocaleTimeString()}] ${msg}`);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * 打开同步进度弹窗并执行回调。
 * stoppable 为真时提供「停止」按钮：中断信号会传给 syncTask，
 * 它在每篇文档之间检查，停下前先把已写入文档的 state 落盘。
 */
export async function runWithSyncModal(
  plugin: YuqueStylePlugin,
  title: string,
  fn: (log: SyncLogFn, modal: SyncModal, signal?: AbortSignal) => Promise<void>,
  opts?: { stoppable?: boolean },
): Promise<void> {
  const modal = new SyncModal(plugin.app, title);
  const controller = new AbortController();
  modal.open();
  // 用对象包一层：回调里赋值的局部变量会被控制流分析收窄成 never
  const stop: { btn: HTMLButtonElement | null } = { btn: null };
  if (opts?.stoppable) {
    new Setting(modal.contentEl).addButton((b) => {
      stop.btn = b.buttonEl;
      b.setButtonText("停止")
        .setWarning()
        .onClick(() => {
          controller.abort();
          b.setButtonText("正在停止…").setDisabled(true);
        });
    });
  }
  const log: SyncLogFn = (msg, type) => modal.log(msg, type);
  try {
    await fn(log, modal, controller.signal);
  } catch (e) {
    console.error("[yuque-style] 同步出错", e);
    log(`出错：${(e as Error).message}`, "error");
  } finally {
    if (stop.btn) {
      stop.btn.textContent = "已结束";
      stop.btn.disabled = true;
      stop.btn.style.opacity = "0.5";
    }
    log("—— 结束 ——");
  }
}
