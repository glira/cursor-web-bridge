import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
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

let artifacts = new Map<string, ArtifactRecord>();
let loaded = false;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await readFile(config.artifactsPath, "utf8");
    const parsed = JSON.parse(raw) as ArtifactRecord[];
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item?.path && typeof item.path === "string") {
          artifacts.set(normalizeRegisteredPath(item.path), item);
        }
      }
    }
  } catch {
    artifacts = new Map();
  }
}

async function persist(): Promise<void> {
  await mkdir(dirname(config.artifactsPath), { recursive: true });
  const list = [...artifacts.values()].sort((a, b) => a.registeredAt - b.registeredAt);
  await writeFile(config.artifactsPath, JSON.stringify(list, null, 2), "utf8");
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

/**
 * Resolve a path for download: must be under /tmp after realpath,
 * and must be registered (or a child of a registered dir).
 */
export async function resolveSafeTmpPath(requested: string): Promise<{
  absolutePath: string;
  kind: ArtifactKind;
  registered: ArtifactRecord | null;
}> {
  await ensureLoaded();
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
    findParentRegistered(real);

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

function findParentRegistered(realPath: string): ArtifactRecord | null {
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

export async function registerArtifacts(paths: string[]): Promise<ArtifactRecord[]> {
  await ensureLoaded();
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
  if (created.length > 0) await persist();
  return created;
}

export async function listArtifacts(): Promise<ArtifactRecord[]> {
  await ensureLoaded();
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

export function createFileReadStream(absolutePath: string): Readable {
  return createReadStream(absolutePath);
}

export async function zipDirectoryToTemp(dirPath: string): Promise<string> {
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
  await registerArtifacts([outZip]);
  return outZip;
}

export function downloadFileName(absolutePath: string, kind: ArtifactKind): string {
  if (kind === "dir") return `${basename(absolutePath)}.zip`;
  return basename(absolutePath);
}

export function relativeUnderTmp(absolutePath: string): string {
  return relative(TMP_ROOT, absolutePath) || basename(absolutePath);
}
