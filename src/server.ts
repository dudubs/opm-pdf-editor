import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, extname, join, normalize, resolve, sep } from "node:path";

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = resolve(process.env.DATA_DIR ?? "./data");
const PUBLIC_DIR = resolve(process.env.PUBLIC_DIR ?? "./dist/public");
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 200) * 1024 * 1024;

await mkdir(DATA_DIR, { recursive: true });

const json = (data: unknown, status = 200) => Response.json(data, { status });
const error = (status: number, message: string) => json({ error: message }, status);

/** Validate a user-supplied file name: a plain `*.pdf` basename, no path parts. */
function safeName(raw: string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (name !== basename(name) || name.startsWith(".") || name.includes("\0")) return null;
  if (extname(name).toLowerCase() !== ".pdf") return null;
  return name;
}

const pdfPath = (name: string) => join(DATA_DIR, name);

async function exists(path: string) {
  return stat(path).then(() => true, () => false);
}

/** Pick a free name ("a.pdf" -> "a (1).pdf") so uploads never overwrite. */
async function uniqueName(name: string): Promise<string> {
  if (!(await exists(pdfPath(name)))) return name;
  const ext = extname(name);
  const base = name.slice(0, -ext.length);
  for (let i = 1; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!(await exists(pdfPath(candidate)))) return candidate;
  }
}

async function isPdf(blob: Blob) {
  const head = new TextDecoder().decode(await blob.slice(0, 1024).arrayBuffer());
  return head.includes("%PDF-");
}

/** Write atomically so a crash mid-save can't corrupt the existing PDF. */
async function writeAtomic(path: string, data: Blob | ArrayBuffer) {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  await Bun.write(tmp, data);
  await rename(tmp, path);
}

async function listFiles() {
  const entries = await readdir(DATA_DIR);
  const files = await Promise.all(
    entries
      .filter((n) => safeName(encodeURIComponent(n)) !== null)
      .map(async (name) => {
        const s = await stat(pdfPath(name));
        return { name, size: s.size, modified: s.mtime.toISOString() };
      }),
  );
  return files.sort((a, b) => b.modified.localeCompare(a.modified));
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "files", name?]
  if (parts[1] !== "files") return error(404, "Not found");
  const rawName = parts[2];

  if (!rawName) {
    if (req.method === "GET") return json(await listFiles());
    if (req.method === "POST") {
      let form: FormData;
      try {
        form = await req.formData();
      } catch {
        return error(400, "Expected multipart/form-data");
      }
      const file = form.get("file");
      if (!(file instanceof File)) return error(400, "Missing 'file' field");
      const name = safeName(encodeURIComponent(basename(file.name)));
      if (!name) return error(400, "File must be a .pdf with a plain name");
      if (!(await isPdf(file))) return error(400, "Not a valid PDF");
      const finalName = await uniqueName(name);
      await writeAtomic(pdfPath(finalName), file);
      return json({ name: finalName }, 201);
    }
    return error(405, "Method not allowed");
  }

  const name = safeName(rawName);
  if (!name) return error(400, "Invalid file name");
  const path = pdfPath(name);

  switch (req.method) {
    case "GET":
    case "HEAD": {
      if (!(await exists(path))) return error(404, "File not found");
      return new Response(Bun.file(path), {
        headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store" },
      });
    }
    case "PUT": {
      if (!(await exists(path))) return error(404, "File not found");
      const body = await req.blob();
      if (!(await isPdf(body))) return error(400, "Not a valid PDF");
      await writeAtomic(path, body);
      return json({ name, size: body.size });
    }
    case "DELETE": {
      if (!(await exists(path))) return error(404, "File not found");
      await rm(path);
      return json({ ok: true });
    }
    default:
      return error(405, "Method not allowed");
  }
}

async function serveStatic(pathname: string): Promise<Response> {
  let rel: string;
  try {
    rel = normalize(decodeURIComponent(pathname));
  } catch {
    return error(400, "Bad path");
  }
  if (rel === sep || rel === "/") rel = "/index.html";
  const full = resolve(join(PUBLIC_DIR, rel));
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + sep)) return error(403, "Forbidden");
  const file = Bun.file(full);
  if (!(await file.exists())) return error(404, "Not found");
  return new Response(file);
}

const server = Bun.serve({
  port: PORT,
  maxRequestBodySize: MAX_UPLOAD_BYTES,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/health") return json({ ok: true });
      if (url.pathname.startsWith("/api/")) return await handleApi(req, url);
      if (req.method !== "GET" && req.method !== "HEAD") return error(405, "Method not allowed");
      return await serveStatic(url.pathname);
    } catch (err) {
      console.error(err);
      return error(500, "Internal server error");
    }
  },
});

console.log(`PDF editor listening on http://localhost:${server.port}  (data: ${DATA_DIR})`);
