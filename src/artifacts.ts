import { createReadStream } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { config } from "./config.js";

export type ArtifactKind = "file" | "dir";

export type ArtifactRecord = {
  path: string;
  name: string;
  kind: ArtifactKind;
  size: number | null;
  mtimeMs: number | null;
  registeredAt: number;
  children?: string[];
};

const TMP_ROOT = "/tmp";
const PATH_RE = /(?:^|[\s`"'(=:])(\/tmp\/[A-Za-z0-9._+@%-]+(?:\/[A-Za-z0-9._+@%-]+)*)\/?/g;
/** Basename the agent printed without the /tmp prefix, e.g. `maiva-logs-2026-09-30.zip`. */
const BASENAME_RE = /(?:^|[\s`"'(=:])([A-Za-z0-9][A-Za-z0-9._+-]{0,180}\.[A-Za-z0-9]{1,8})/g;

const stores = new Map<string, { artifacts: Map<string, ArtifactRecord>; loaded: boolean }>();

function storeOf(roomId: string) {
  let store = stores.get(roomId);
  if (!store) {
    store = { artifacts: new Map(), loaded: false };
    stores.set(roomId, store);
  }
  return store;
}

function artifactsFile(roomId: string): string {
  return join(config.dataDir, "rooms", roomId, "artifacts.json");
}

export async function migrateLegacyArtifacts(): Promise<void> {
  const dest = artifactsFile("geral");
  try {
    await readFile(dest, "utf8");
    return;
  } catch {
    // not migrated yet
  }
  try {
    await mkdir(dirname(dest), { recursive: true });
    const { rename } = await import("node:fs/promises");
    await rename(config.artifactsPath, dest);
    console.log("[artifacts] migrated legacy index to the general tab");
  } catch {
    // no legacy file
  }
}

async function ensureLoaded(roomId: string): Promise<Map<string, ArtifactRecord>> {
  const store = storeOf(roomId);
  if (store.loaded) return store.artifacts;
  store.loaded = true;
  try {
    const raw = await readFile(artifactsFile(roomId), "utf8");
    const parsed = JSON.parse(raw) as ArtifactRecord[];
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item?.path && typeof item.path === "string") {
          store.artifacts.set(normalizeRegisteredPath(item.path), item);
        }
      }
    }
  } catch {
    store.artifacts = new Map();
  }
  return store.artifacts;
}

async function persist(roomId: string): Promise<void> {
  const artifacts = storeOf(roomId).artifacts;
  const path = artifactsFile(roomId);
  await mkdir(dirname(path), { recursive: true });
  const list = [...artifacts.values()].sort((a, b) => a.registeredAt - b.registeredAt);
  await writeFile(path, JSON.stringify(list, null, 2), "utf8");
}

function stripTrailingSlash(p: string): string {
  if (p.length > 1 && p.endsWith("/")) return p.slice(0, -1);
  return p;
}

function normalizeRegisteredPath(input: string): string {
  return stripTrailingSlash(input.trim());
}

/** Normalize file:// URIs so /tmp paths are visible to PATH_RE. */
function normalizeFileUris(text: string): string {
  return text
    .replace(/file:\/\/\/tmp\//gi, `${TMP_ROOT}/`)
    .replace(/file:\/\/localhost\/tmp\//gi, `${TMP_ROOT}/`);
}

/** Extract absolute /tmp paths from agent text (also accepts file:///tmp/...). */
export function extractTmpPaths(text: string): string[] {
  const found = new Set<string>();
  const normalized = normalizeFileUris(text || "");
  PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PATH_RE.exec(normalized)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    const cleaned = stripTrailingSlash(raw.replace(/[.,;:!?)]+$/, ""));
    if (cleaned.startsWith(`${TMP_ROOT}/`) && cleaned.length > TMP_ROOT.length + 1) {
      found.add(cleaned);
    }
  }
  return [...found];
}

/** Filenames mentioned in the reply. Callers check that `/tmp/<name>` exists. */
export function extractTmpBasenameCandidates(text: string): string[] {
  const found = new Set<string>();
  BASENAME_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BASENAME_RE.exec(text || "")) !== null) {
    const name = match[1];
    if (!name || name.includes("/") || name.includes("..")) continue;
    found.add(`${TMP_ROOT}/${name}`);
  }
  return [...found];
}

/** Keep only candidates that are a real file or directory under /tmp. */
export async function filterExistingTmpPaths(paths: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const raw of paths) {
    const path = normalizeRegisteredPath(raw);
    if (!path.startsWith(`${TMP_ROOT}/`) || path.includes("..")) continue;
    try {
      await access(path);
    } catch {
      continue;
    }
    found.push(path);
  }
  return found;
}

/**
 * Resolve a path for download: must be under /tmp after realpath,
 * and must be registered (or a child of a registered dir).
 */
export async function resolveSafeTmpPath(roomId: string, requested: string): Promise<{
  absolutePath: string;
  kind: ArtifactKind;
  registered: ArtifactRecord | null;
}> {
  const artifacts = await ensureLoaded(roomId);
  const requestedNorm = normalizeRegisteredPath(requested);
  if (!requestedNorm.startsWith(`${TMP_ROOT}/`)) {
    throw new Error("Only paths under /tmp/ are allowed.");
  }
  if (requestedNorm.includes("\0") || requestedNorm.includes("..")) {
    throw new Error("Invalid path.");
  }

  const abs = resolve(requestedNorm);
  if (abs !== TMP_ROOT && !abs.startsWith(`${TMP_ROOT}${sep}`)) {
    throw new Error("Path is outside /tmp.");
  }

  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    throw new Error("File not found.");
  }
  if (real !== TMP_ROOT && !real.startsWith(`${TMP_ROOT}${sep}`)) {
    throw new Error("Symlink outside /tmp is blocked.");
  }

  const registered =
    artifacts.get(normalizeRegisteredPath(abs)) ||
    artifacts.get(normalizeRegisteredPath(real)) ||
    findParentRegistered(artifacts, real);

  if (!registered) {
    throw new Error("File is not registered in this session.");
  }

  const st = await lstat(real);
  return {
    absolutePath: real,
    kind: st.isDirectory() ? "dir" : "file",
    registered,
  };
}

function findParentRegistered(
  artifacts: Map<string, ArtifactRecord>,
  realPath: string,
): ArtifactRecord | null {
  for (const rec of artifacts.values()) {
    if (rec.kind !== "dir") continue;
    const parent = resolve(rec.path);
    if (realPath === parent || realPath.startsWith(`${parent}${sep}`)) {
      return rec;
    }
  }
  return null;
}

async function statArtifact(path: string): Promise<{
  kind: ArtifactKind;
  size: number | null;
  mtimeMs: number | null;
  children?: string[];
}> {
  try {
    const st = await lstat(path);
    if (st.isDirectory()) {
      let children: string[] | undefined;
      try {
        const entries = await readdir(path);
        children = entries.slice(0, 100);
      } catch {
        children = undefined;
      }
      return { kind: "dir", size: null, mtimeMs: st.mtimeMs, children };
    }
    return { kind: "file", size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { kind: path.endsWith(".zip") ? "file" : "dir", size: null, mtimeMs: null };
  }
}

export async function registerArtifacts(roomId: string, paths: string[]): Promise<ArtifactRecord[]> {
  const artifacts = await ensureLoaded(roomId);
  const created: ArtifactRecord[] = [];
  for (const raw of paths) {
    const path = normalizeRegisteredPath(raw);
    if (!path.startsWith(`${TMP_ROOT}/`)) continue;
    if (artifacts.has(path)) continue;

    const meta = await statArtifact(path);
    const record: ArtifactRecord = {
      path,
      name: basename(path),
      kind: meta.kind,
      size: meta.size,
      mtimeMs: meta.mtimeMs,
      registeredAt: Date.now(),
      children: meta.children,
    };
    artifacts.set(path, record);
    created.push(record);

    // Also register child files when a directory is mentioned
    if (meta.kind === "dir" && meta.children) {
      for (const child of meta.children) {
        const childPath = join(path, child);
        if (artifacts.has(childPath)) continue;
        const childMeta = await statArtifact(childPath);
        if (childMeta.kind !== "file") continue;
        const childRec: ArtifactRecord = {
          path: childPath,
          name: child,
          kind: "file",
          size: childMeta.size,
          mtimeMs: childMeta.mtimeMs,
          registeredAt: Date.now(),
        };
        artifacts.set(childPath, childRec);
        created.push(childRec);
      }
    }
  }
  if (created.length > 0) await persist(roomId);
  return created;
}

export async function listArtifacts(roomId: string): Promise<ArtifactRecord[]> {
  const artifacts = await ensureLoaded(roomId);
  // Refresh sizes for existing entries (best-effort)
  const out: ArtifactRecord[] = [];
  for (const rec of artifacts.values()) {
    const meta = await statArtifact(rec.path);
    const updated = {
      ...rec,
      kind: meta.kind,
      size: meta.size,
      mtimeMs: meta.mtimeMs,
      children: meta.children ?? rec.children,
    };
    artifacts.set(rec.path, updated);
    out.push(updated);
  }
  return out.sort((a, b) => a.registeredAt - b.registeredAt);
}

export async function clearArtifacts(roomId: string): Promise<void> {
  const store = storeOf(roomId);
  await ensureLoaded(roomId);
  store.artifacts = new Map();
  await persist(roomId);
}

export function createFileReadStream(absolutePath: string): Readable {
  return createReadStream(absolutePath);
}

export async function zipDirectoryToTemp(roomId: string, dirPath: string): Promise<string> {
  const siblingZip = `${stripTrailingSlash(dirPath)}.zip`;
  try {
    const st = await lstat(siblingZip);
    if (st.isFile()) return siblingZip;
  } catch {
    // no sibling zip
  }

  const outZip = join(
    TMP_ROOT,
    `bridge-export-${basename(dirPath)}-${Date.now()}.zip`,
  );

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      "zip",
      ["-r", "-q", outZip, basename(dirPath)],
      { cwd: dirname(dirPath) },
    );
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`zip failed with code ${code}`));
    });
  });

  // Register the export zip so it can be re-downloaded
  await registerArtifacts(roomId, [outZip]);
  return outZip;
}

export function downloadFileName(absolutePath: string, kind: ArtifactKind): string {
  if (kind === "dir") return `${basename(absolutePath)}.zip`;
  return basename(absolutePath);
}

export function relativeUnderTmp(absolutePath: string): string {
  return relative(TMP_ROOT, absolutePath) || basename(absolutePath);
}
