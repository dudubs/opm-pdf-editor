/**
 * Where PDFs live. The browser build talks to the Bun server's `/api/files`
 * library; the Tauri (desktop) build opens/saves files anywhere on disk through
 * native dialogs. `main.ts` only depends on the `Storage` shape below.
 */

export interface FileEntry {
  /** Stable identifier: the library file name (web) or the absolute path (desktop). */
  id: string;
  /** Display name. */
  name: string;
  size?: number;
  modified?: string;
}

/** What to hand to pdf.js `getDocument`. */
export type PdfSource = { url: string } | { data: Uint8Array };

interface StorageBase {
  list(): Promise<FileEntry[]>;
  source(id: string): Promise<PdfSource>;
  write(id: string, bytes: Uint8Array): Promise<void>;
  remove(id: string): Promise<void>;
  nameOf(id: string): string;
}

export interface WebStorage extends StorageBase {
  kind: "web";
  /** Upload into the server library; never overwrites an existing file. */
  add(file: File): Promise<FileEntry>;
  downloadUrl(id: string): string;
}

export interface DesktopStorage extends StorageBase {
  kind: "desktop";
  /** Native "Open" dialog. Resolves to null if cancelled. */
  pick(): Promise<FileEntry | null>;
  /** Native "Save As" dialog. Resolves to null if cancelled. */
  saveAs(suggestedName: string, bytes: Uint8Array): Promise<FileEntry | null>;
  /** Register a path (e.g. from a drag-and-drop) in the recent list. */
  remember(path: string): FileEntry;
  /** Called with the first dropped .pdf path. */
  onDrop(cb: (path: string) => void): void;
}

export type Storage = WebStorage | DesktopStorage;

function assertPdf(bytes: Uint8Array) {
  const head = new TextDecoder().decode(bytes.subarray(0, 1024));
  if (!head.includes("%PDF-")) throw new Error("Not a valid PDF");
}

// ---------- web: Bun server library ----------

function createWebStorage(): WebStorage {
  const fileUrl = (name: string) => `/api/files/${encodeURIComponent(name)}`;

  async function failure(res: Response): Promise<Error> {
    const body = await res.json().catch(() => null);
    return new Error(body?.error ?? res.statusText);
  }

  return {
    kind: "web",
    nameOf: (id) => id,
    downloadUrl: fileUrl,
    async list() {
      const res = await fetch("/api/files");
      if (!res.ok) throw await failure(res);
      const files: { name: string; size: number; modified: string }[] = await res.json();
      return files.map((f) => ({ id: f.name, ...f }));
    },
    async source(id) {
      return { url: `${fileUrl(id)}?t=${Date.now()}` };
    },
    async write(id, bytes) {
      const res = await fetch(fileUrl(id), {
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
        body: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }),
      });
      if (!res.ok) throw await failure(res);
    },
    async remove(id) {
      const res = await fetch(fileUrl(id), { method: "DELETE" });
      if (!res.ok) throw await failure(res);
    },
    async add(file) {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch("/api/files", { method: "POST", body: form });
      if (!res.ok) throw await failure(res);
      const { name } = await res.json();
      return { id: name, name };
    },
  };
}

// ---------- desktop: Tauri + native dialogs ----------

const RECENTS_KEY = "opm.recents";
const MAX_RECENTS = 20;
const PDF_FILTER = [{ name: "PDF", extensions: ["pdf"] }];

const baseName = (path: string) => path.split(/[\\/]/).pop() || path;

function loadRecents(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function saveRecents(paths: string[]) {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(paths.slice(0, MAX_RECENTS)));
  } catch {
    // Recents are a convenience; ignore storage failures.
  }
}

function createDesktopStorage(): DesktopStorage {
  const entry = (path: string): FileEntry => ({ id: path, name: baseName(path) });

  function remember(path: string): FileEntry {
    saveRecents([path, ...loadRecents().filter((p) => p !== path)]);
    return entry(path);
  }

  return {
    kind: "desktop",
    nameOf: baseName,
    remember,
    async list() {
      return loadRecents().map(entry);
    },
    async source(id) {
      const { readFile } = await import("@tauri-apps/plugin-fs");
      return { data: await readFile(id) };
    },
    async write(id, bytes) {
      assertPdf(bytes);
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(id, bytes);
      remember(id);
    },
    async remove(id) {
      // Only forgets the file from the recent list; the file on disk is untouched.
      saveRecents(loadRecents().filter((p) => p !== id));
    },
    async pick() {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ multiple: false, directory: false, filters: PDF_FILTER });
      return typeof path === "string" ? remember(path) : null;
    },
    async saveAs(suggestedName, bytes) {
      assertPdf(bytes);
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({ defaultPath: suggestedName, filters: PDF_FILTER });
      if (!path) return null;
      await writeFile(path, bytes);
      return remember(path);
    },
    onDrop(cb) {
      void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type !== "drop") return;
          const path = event.payload.paths.find((p) => p.toLowerCase().endsWith(".pdf"));
          if (path) cb(path);
        }),
      );
    },
  };
}

export const storage: Storage =
  "__TAURI_INTERNALS__" in window ? createDesktopStorage() : createWebStorage();
