import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "dist", "public");
const pdfjs = join(root, "node_modules", "pdfjs-dist");

await rm(join(root, "dist"), { recursive: true, force: true });
await mkdir(join(out, "assets"), { recursive: true });

// 1. Bundle the TypeScript browser client.
const result = await Bun.build({
  entrypoints: [join(root, "src", "client", "main.ts")],
  outdir: join(out, "assets"),
  target: "browser",
  format: "esm",
  minify: true,
  sourcemap: "linked",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// 2. Static HTML/CSS.
await cp(join(root, "src", "client", "index.html"), join(out, "index.html"));
await cp(join(root, "src", "client", "styles.css"), join(out, "assets", "styles.css"));

// 3. pdf.js runtime assets (worker, fonts, cmaps, wasm decoders, viewer css/images).
const copies: [string, string][] = [
  ["legacy/build/pdf.worker.min.mjs", "pdfjs/pdf.worker.mjs"],
  ["legacy/web/pdf_viewer.css", "pdfjs/pdf_viewer.css"],
  ["legacy/web/images", "pdfjs/images"],
  ["cmaps", "pdfjs/cmaps"],
  ["standard_fonts", "pdfjs/standard_fonts"],
  ["wasm", "pdfjs/wasm"],
  ["iccs", "pdfjs/iccs"],
];
for (const [from, to] of copies) {
  await cp(join(pdfjs, from), join(out, to), { recursive: true });
}

console.log("Build complete ->", out);
