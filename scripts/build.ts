import { mkdir } from "node:fs/promises";
const standalone = process.argv.includes("--standalone");
await mkdir("dist", { recursive: true });
const outfile = standalone
  ? `dist/kest${process.platform === "win32" ? ".exe" : ""}`
  : "dist/kest.js";
const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  target: "bun",
  minify: true,
  sourcemap: "none",
  // Avoid embedding provider credentials from the build environment.
  env: "disable",
  ...(standalone
    ? { compile: { outfile } }
    : { external: ["@opentui/core"], outdir: "dist", naming: "kest.js" }),
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(
  `${outfile}: ${(Bun.file(outfile).size / 1_000_000).toFixed(2)} MB${standalone ? " (standalone)" : " (requires Bun and installed @opentui/core)"}`,
);
