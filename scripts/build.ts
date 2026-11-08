import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
// The desktop (Tauri) build has its own folder so a running dev watcher (which rebuilds dist/public)
// can never mix pdf.js files into the product, and building one never wipes the other.
const desktop = process.argv.includes("--desktop");
const out = join(root, "dist", desktop ? "desktop" : "public");
const pdfjs = join(root, "node_modules", "pdfjs-dist");

// `--client`: dev rebuild of only the app code (no wipe, no pdf.js asset copy, no minify).
const clientOnly = process.argv.includes("--client");
// `--desktop`: the Tauri product build (dist/desktop). Only the PDFium/EmbedPDF editor; the pdf.js
// editor and its assets are left out (they stay in the dev/web build).

if (!clientOnly) await rm(out, { recursive: true, force: true });
await mkdir(join(out, "assets"), { recursive: true });

// 1. Bundle the TypeScript browser client.
const result = await Bun.build({
  entrypoints: [
    ...(desktop ? [] : [join(root, "src", "client", "main.ts")]),
    join(root, "src", "client", "pdfium.ts"),
  ],
  external: ["/embedpdf/embedpdf.js"],
  outdir: join(out, "assets"),
  target: "browser",
  format: "esm",
  minify: !clientOnly,
  sourcemap: "linked",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  if (!clientOnly) process.exit(1);
  throw new Error("client build failed");
}

// 2. Static HTML/CSS.
if (!desktop) {
  await cp(join(root, "src", "client", "index.html"), join(out, "index.html"));
  await cp(join(root, "src", "client", "styles.css"), join(out, "assets", "styles.css"));
}
await cp(join(root, "src", "client", "pdfium.html"), join(out, "pdfium.html"));

if (clientOnly) {
  console.log("Client rebuilt");
  process.exit(0);
}

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
if (!desktop) {
  for (const [from, to] of copies) {
    await cp(join(pdfjs, from), join(out, to), { recursive: true });
  }
}

// 4. EmbedPDF (PDFium WASM) snippet viewer for /pdfium.html — skip its demo PDFs and sample page.
await cp(join(root, "node_modules", "@embedpdf", "snippet", "dist"), join(out, "embedpdf"), {
  recursive: true,
  filter: (src) => !/\.(pdf|html)$/.test(src) && !src.endsWith(".map"),
});

// 5. Fallback fonts for PDFium, served locally (EmbedPDF defaults to the jsDelivr CDN, which fails
// offline and is blocked by the desktop CSP). Hebrew + Arabic + the Latin-script family (Cyrillic,
// Greek, Vietnamese). CJK packs are 30-40 MB each and are deliberately not bundled.
const fontsDir = join(root, "node_modules", "@embedpdf");
const latinStyles = ["Regular", "Bold", "Italic", "BoldItalic"];
await cp(join(fontsDir, "fonts-hebrew", "fonts"), join(out, "embedpdf", "fonts", "hebrew"), { recursive: true });
await cp(join(fontsDir, "fonts-arabic", "fonts"), join(out, "embedpdf", "fonts", "arabic"), { recursive: true });
await cp(join(fontsDir, "fonts-latin", "fonts"), join(out, "embedpdf", "fonts", "latin"), {
  recursive: true,
  filter: (src) => !src.endsWith(".ttf") || latinStyles.some((s) => src.endsWith(`NotoSans-${s}.ttf`)),
});

console.log(`Build complete${desktop ? " (desktop)" : ""} ->`, out);
