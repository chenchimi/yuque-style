import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // obsidian 只发布类型声明、没有可执行 JS，用替身顶掉，
    // 否则 import 了它的 sync.ts / api.ts 在 Node 下根本加载不了
    alias: {
      obsidian: fileURLToPath(new URL("./tests/mocks/obsidian.ts", import.meta.url)),
    },
  },
  test: {
    // lake.ts 依赖 DOMParser / Node 等浏览器全局，必须在 jsdom 下运行
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
  },
});
