/**
 * 把 tools/*.ts 打包成可在 Node 下直接运行的 CJS。
 * 关键：把 `obsidian` 别名到 tools/obsidian-shim.ts，从而原样复用 src/yuque/*。
 */
import esbuild from "esbuild";
import path from "path";

await esbuild.build({
  absWorkingDir: process.cwd(),
  entryPoints: ["tools/probe.ts", "tools/census.ts", "tools/orphan-diag.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outdir: "tools/.probe",
  outExtension: { ".js": ".cjs" },
  alias: { obsidian: path.resolve("tools/obsidian-shim.ts") },
  logLevel: "info",
  sourcemap: "inline",
});

console.log("构建完成：tools/.probe/{probe,census}.cjs");
