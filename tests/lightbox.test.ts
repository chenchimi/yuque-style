import { afterEach, describe, expect, it } from "vitest";
import {
  closeLightbox,
  openLightbox,
  pickZoomableImage,
} from "../src/lightbox";

const LIGHTBOX_ID = "yuque-lightbox";

function imgIn(scopeClass: string, src = "app://vault/img.png"): HTMLImageElement {
  const scope = document.createElement("div");
  scope.className = scopeClass;
  const img = document.createElement("img");
  img.src = src;
  img.alt = "示例图";
  scope.appendChild(img);
  document.body.appendChild(scope);
  return img;
}

afterEach(() => {
  closeLightbox();
  document.body.innerHTML = "";
});

describe("pickZoomableImage（哪些图片可放大）", () => {
  it("阅读模式容器内的 img → 放行，带回 src 与 alt", () => {
    const img = imgIn("markdown-preview-view");
    expect(pickZoomableImage(img)).toEqual({
      src: "app://vault/img.png",
      alt: "示例图",
    });
  });

  it("实时预览装饰容器（.yuque-reader）内的 img 同样放行", () => {
    const img = imgIn("yuque-reader");
    expect(pickZoomableImage(img)?.src).toBe("app://vault/img.png");
  });

  it("容器外的 img（编辑器图标等）不放行", () => {
    const img = imgIn("some-toolbar");
    expect(pickZoomableImage(img)).toBeNull();
  });

  it("非图片目标不放行；无 src 的 img 不放行", () => {
    expect(pickZoomableImage(document.createElement("div"))).toBeNull();
    expect(pickZoomableImage(null)).toBeNull();
    const img = imgIn("markdown-preview-view");
    img.removeAttribute("src");
    expect(pickZoomableImage(img)).toBeNull();
  });
});

describe("openLightbox / closeLightbox", () => {
  it("打开后遮罩与图片都在；再次打开幂等（不叠两层）", () => {
    openLightbox("a.png", "A");
    expect(document.getElementById(LIGHTBOX_ID)).not.toBeNull();
    openLightbox("b.png", "B");
    expect(document.querySelectorAll(`#${LIGHTBOX_ID}`)).toHaveLength(1);
    const overlay = document.getElementById(LIGHTBOX_ID)!;
    const img = overlay.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("b.png");
    expect(img.getAttribute("alt")).toBe("B");
  });

  it("点击遮罩关闭", () => {
    openLightbox("a.png", "A");
    document.getElementById(LIGHTBOX_ID)!.dispatchEvent(new MouseEvent("click"));
    expect(document.getElementById(LIGHTBOX_ID)).toBeNull();
  });

  it("Esc 关闭", () => {
    openLightbox("a.png", "A");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.getElementById(LIGHTBOX_ID)).toBeNull();
  });

  it("closeLightbox 幂等（没有遮罩时也安全）", () => {
    expect(() => closeLightbox()).not.toThrow();
  });
});
