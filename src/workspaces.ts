import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { config } from "./config.js";
import { closeCursorWindow, cursorWindowOpen, openCursorFolder } from "./cdp/bridge.js";
import {
  GENERAL_ROOM_ID,
  getRoom,
  listRooms,
  removeRoomRecord,
  saveRoom,
  type RoomRecord,
} from "./store.js";

export type CapacityLevel = "ok" | "warn" | "block";

export type Capacity = {
  level: CapacityLevel;
  memAvailableMb: number;
  swapFreeMb: number;
  diskFreeMb: number;
  diskCostMb: number;
  ramCostMb: number;
  roomCount: number;
  maxRooms: number;
  reason: string;
};

async function meminfo(): Promise<{ memAvailableMb: number; swapFreeMb: number }> {
  const text = await readFile("/proc/meminfo", "utf8");
  const mb = (key: string) => {
    const match = text.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
    return match ? Math.floor(Number(match[1]) / 1024) : 0;
  };
  return { memAvailableMb: mb("MemAvailable"), swapFreeMb: mb("SwapFree") };
}

async function diskFreeMb(path: string): Promise<number> {
  const { statfs } = await import("node:fs/promises");
  const stats = await statfs(path);
  return Math.floor((Number(stats.bavail) * Number(stats.bsize)) / (1024 * 1024));
}

export async function checkCapacity(sharedDeps: boolean): Promise<Capacity> {
  const mem = await meminfo();
  const disk = await diskFreeMb(config.workspacesBase);
  const rooms = await listRooms();
  const roomCount = rooms.filter((room) => room.removable).length;
  const ramCostMb = config.workspaceEstRamMb;
  const diskCostMb = sharedDeps ? config.workspaceEstDiskSharedMb : config.workspaceEstDiskMb;
  const maxRooms = config.maxWorkspaces;

  let level: CapacityLevel = "ok";
  const reasons: string[] = [];

  if (maxRooms > 0 && roomCount >= maxRooms) {
    level = "block";
    reasons.push(`limite de ${maxRooms} abas`);
  }
  const memLeft = mem.memAvailableMb - ramCostMb;
  if (memLeft < 300) {
    level = "block";
    reasons.push(`memória livre ${mem.memAvailableMb} MB, a aba pede cerca de ${ramCostMb} MB`);
  } else if (memLeft < 1024 && level !== "block") {
    level = "warn";
    reasons.push(`memória fica apertada (${memLeft} MB depois da aba)`);
  }
  if (disk < diskCostMb + 1024) {
    level = "block";
    reasons.push(`disco livre ${disk} MB, a aba pede cerca de ${diskCostMb} MB`);
  } else if (disk - diskCostMb < 3072 && level !== "block") {
    level = "warn";
    reasons.push(`disco livre depois da aba fica abaixo de 3 GB`);
  }

  return {
    level,
    memAvailableMb: mem.memAvailableMb,
    swapFreeMb: mem.swapFreeMb,
    diskFreeMb: disk,
    diskCostMb,
    ramCostMb,
    roomCount,
    maxRooms,
    reason: reasons.join(" ") || "recursos suficientes",
  };
}

export function slugFromTitle(title: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(slug)) {
    throw new Error("workspace_title_invalid");
  }
  return slug;
}

function run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      if (out.length > 20_000) out = out.slice(-20_000);
    });
    child.stderr.on("data", (chunk) => {
      out += String(chunk);
      if (out.length > 20_000) out = out.slice(-20_000);
    });
    child.on("error", (err) => resolvePromise({ code: 1, out: err.message }));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, out }));
  });
}

async function uniqueSlug(base: string): Promise<{ slug: string; folder: string }> {
  const rooms = await listRooms();
  const used = new Set(rooms.map((room) => room.id));
  for (let n = 0; n < 50; n += 1) {
    const slug = n === 0 ? base : `${base}-${n + 1}`;
    const folder = resolve(config.workspacesBase, slug);
    if (!folder.startsWith(resolve(config.workspacesBase) + "/")) {
      throw new Error("workspace_path");
    }
    if (used.has(slug) || folder === resolve(config.cursorCwd)) continue;
    try {
      await lstat(folder);
      continue;
    } catch {
      return { slug, folder };
    }
  }
  throw new Error("workspace_path");
}

async function finishWorkspace(room: RoomRecord, branch: string): Promise<void> {
  try {
    const added = await run("git", [
      "-C",
      config.cursorCwd,
      "worktree",
      "add",
      "-b",
      branch,
      room.folder,
      "HEAD",
    ]);
    if (added.code !== 0) throw new Error(added.out.trim() || "git worktree add failed");

    if (room.sharedDeps) {
      await symlink(join(config.cursorCwd, "node_modules"), join(room.folder, "node_modules"));
    } else {
      const installed = await run("npm", ["ci", "--no-audit", "--no-fund"], room.folder);
      if (installed.code !== 0) {
        throw new Error(installed.out.trim().slice(-1500) || "npm ci failed");
      }
    }

    await openCursorFolder(room.folder);
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (await cursorWindowOpen(room.cdpTitle)) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!(await cursorWindowOpen(room.cdpTitle))) {
      throw new Error("a janela do Cursor não apareceu no CDP");
    }

    room.status = "ready";
    room.statusError = undefined;
    await saveRoom(room);
    console.log(`[workspace] ready id=${room.id} folder=${room.folder}`);
  } catch (err) {
    room.status = "error";
    room.statusError = err instanceof Error ? err.message : String(err);
    await saveRoom(room);
    console.error(`[workspace] failed id=${room.id}`, room.statusError);
  }
}

export async function createWorkspace(opts: {
  title: string;
  createdBy: string;
  sharedDeps: boolean;
  force: boolean;
}): Promise<{ room: RoomRecord; capacity: Capacity }> {
  const title = opts.title.trim().replace(/\s+/g, " ").slice(0, 40);
  if (!title) throw new Error("workspace_title_invalid");
  const capacity = await checkCapacity(opts.sharedDeps);
  if (capacity.level === "block") {
    const error = new Error("workspace_blocked");
    (error as Error & { capacity: Capacity }).capacity = capacity;
    throw error;
  }
  if (capacity.level === "warn" && !opts.force) {
    const error = new Error("workspace_warn");
    (error as Error & { capacity: Capacity }).capacity = capacity;
    throw error;
  }

  const base = slugFromTitle(title);
  const { slug, folder } = await uniqueSlug(base);
  const room: RoomRecord = {
    id: slug,
    title,
    folder,
    cdpTitle: basename(folder),
    createdBy: opts.createdBy,
    createdAt: Date.now(),
    sharedDeps: opts.sharedDeps,
    removable: true,
    status: "creating",
  };
  await saveRoom(room);
  void finishWorkspace(room, `ws/${slug}`);
  return { room, capacity };
}

export async function deleteWorkspace(opts: {
  id: string;
  keepFolder: boolean;
  force: boolean;
}): Promise<void> {
  const room = await getRoom(opts.id);
  if (!room) throw new Error("room_unknown");
  if (!room.removable || room.id === GENERAL_ROOM_ID) throw new Error("room_fixed");

  if (!opts.keepFolder) {
    try {
      await lstat(room.folder);
      const dirty = await run("git", ["-C", room.folder, "status", "--porcelain"]);
      if (dirty.out.trim() && !opts.force) {
        const error = new Error("workspace_dirty");
        (error as Error & { detail: string }).detail = dirty.out.trim().slice(0, 1500);
        throw error;
      }
    } catch (err) {
      if (err instanceof Error && err.message === "workspace_dirty") throw err;
    }
  }

  try {
    await closeCursorWindow(room.cdpTitle);
  } catch (err) {
    console.warn(`[workspace] close window ${room.id}`, err instanceof Error ? err.message : err);
  }

  if (!opts.keepFolder) {
    const removed = await run("git", [
      "-C",
      config.cursorCwd,
      "worktree",
      "remove",
      "--force",
      room.folder,
    ]);
    if (removed.code !== 0) {
      await rm(room.folder, { recursive: true, force: true });
      await run("git", ["-C", config.cursorCwd, "worktree", "prune"]);
    }
    await run("git", ["-C", config.cursorCwd, "branch", "-D", `ws/${room.id}`]);
  }

  await rm(join(config.dataDir, "rooms", room.id), { recursive: true, force: true });
  await removeRoomRecord(room.id);
  console.log(`[workspace] removed id=${room.id} keepFolder=${opts.keepFolder}`);
}

export async function ensureRoomWindow(room: RoomRecord): Promise<void> {
  if (room.status !== "ready") return;
  if (await cursorWindowOpen(room.cdpTitle)) return;
  console.log(`[workspace] reopening window id=${room.id}`);
  await openCursorFolder(room.folder);
}

export async function ensureAllWindows(): Promise<void> {
  const rooms = await listRooms();
  for (const room of rooms) {
    try {
      await ensureRoomWindow(room);
    } catch (err) {
      console.warn(`[workspace] ensure ${room.id}`, err instanceof Error ? err.message : err);
    }
  }
}

export async function prepareWorkspaceBase(): Promise<void> {
  await mkdir(config.workspacesBase, { recursive: true });
}
