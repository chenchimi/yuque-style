/**
 * 阅读模式图片灯箱（语雀同款体验）：点击正文图片全屏放大，点击任意处或 Esc 关闭。
 *
 * 此前图片只有圆角居中限高样式（v0.5.0），大图细节看不清。实现刻意保持极简：
 * 一个全屏遮罩 + 原图 `<img>`，不做缩放手势与旋转——语雀网页端也只有这一层。
 * 判定与展示拆成纯函数（pickZoomableImage / openLightbox / closeLightbox），jsdom 可测。
 */

const LIGHTBOX_ID = "yuque-lightbox";

/**
 * 事件目标是否是「可放大的正文图片」。
 * 只认阅读模式容器（.markdown-preview-view）与实时预览装饰容器（.yuque-reader）内的
 * `<img>`——编辑器工具栏图标、设置页图等一律不放行。
 */
export function pickZoomableImage(target: EventTarget | null): { src: string; alt: string } | null {
  if (!(target instanceof HTMLImageElement)) return null;
  const scope = target.closest(".markdown-preview-view, .yuque-reader");
  if (!scope) return null;
  const src = target.getAttribute("src");
  if (!src) return null;
  return { src, alt: target.alt ?? "" };
}

/** 打开灯箱；重复调用会先关掉旧的（幂等） */
export function openLightbox(src: string, alt: string): void {
  closeLightbox();
  const overlay = document.createElement("div");
  overlay.id = LIGHTBOX_ID;
  const img = document.createElement("img");
  img.src = src;
  img.alt = alt;
  overlay.appendChild(img);
  overlay.addEventListener("click", closeLightbox);
  overlay.tabIndex = -1;
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onKeydown);
}

export function closeLightbox(): void {
  document.getElementById(LIGHTBOX_ID)?.remove();
  document.removeEventListener("keydown", onKeydown);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") closeLightbox();
}
