import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { migrateLegacyArtifacts } from "./artifacts.js";
import { migrateLegacyHistory } from "./history.js";

const scrypt = promisify(scryptCb);

export type Role = "admin" | "member";

export type UserRecord = {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  role: Role;
  createdAt: number;
};

export type PublicUser = Omit<UserRecord, "passwordHash">;

export type RoomStatus = "ready" | "creating" | "error";

export type RoomRecord = {
  id: string;
  title: string;
  folder: string;
  cdpTitle: string;
  createdBy: string;
  createdAt: number;
  sharedDeps: boolean;
  removable: boolean;
  status: RoomStatus;
  statusError?: string;
};

export const GENERAL_ROOM_ID = "geral";

const usersPath = () => join(config.dataDir, "users.json");
const roomsPath = () => join(config.dataDir, "rooms.json");

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const hash = (await scrypt(password, salt, 32)) as Buffer;
  return `scrypt$${salt}$${hash.toString("base64url")}`;
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const [algo, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const got = (await scrypt(password, salt, 32)) as Buffer;
  const expected = Buffer.from(hash, "base64url");
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

export function normalizeUsername(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(name)) return null;
  return name;
}

async function readUsers(): Promise<UserRecord[]> {
  const list = await readJson<UserRecord[]>(usersPath(), []);
  return Array.isArray(list) ? list : [];
}

async function writeUsers(users: UserRecord[]): Promise<void> {
  await writeJson(usersPath(), users);
}

export async function listUsers(): Promise<PublicUser[]> {
  return (await readUsers()).map(({ passwordHash: _hash, ...user }) => user);
}

export async function findUserByUsername(username: string): Promise<UserRecord | null> {
  const want = normalizeUsername(username);
  if (!want) return null;
  return (await readUsers()).find((user) => user.username === want) ?? null;
}

export async function findUserById(id: string): Promise<UserRecord | null> {
  return (await readUsers()).find((user) => user.id === id) ?? null;
}

export async function createUser(input: {
  username: string;
  displayName: string;
  password: string;
  role: Role;
}): Promise<PublicUser> {
  const username = normalizeUsername(input.username);
  if (!username) throw new Error("user_invalid");
  const displayName = input.displayName.trim().replace(/\s+/g, " ").slice(0, 40);
  if (!displayName) throw new Error("name_required");
  if (input.password.length < 8) throw new Error("password_short");
  if (input.role !== "admin" && input.role !== "member") throw new Error("user_invalid");

  const users = await readUsers();
  if (users.some((user) => user.username === username)) throw new Error("user_exists");

  const record: UserRecord = {
    id: randomBytes(8).toString("hex"),
    username,
    displayName,
    passwordHash: await hashPassword(input.password),
    role: input.role,
    createdAt: Date.now(),
  };
  users.push(record);
  await writeUsers(users);
  const { passwordHash: _hash, ...pub } = record;
  return pub;
}

export async function deleteUser(id: string, actorId: string): Promise<void> {
  const users = await readUsers();
  const target = users.find((user) => user.id === id);
  if (!target) throw new Error("user_missing");
  if (target.id === actorId) throw new Error("cannot_delete_self");
  const admins = users.filter((user) => user.role === "admin");
  if (target.role === "admin" && admins.length <= 1) throw new Error("cannot_delete_last_admin");
  await writeUsers(users.filter((user) => user.id !== id));
}

async function readRooms(): Promise<RoomRecord[]> {
  const list = await readJson<RoomRecord[]>(roomsPath(), []);
  return Array.isArray(list) ? list : [];
}

async function writeRooms(rooms: RoomRecord[]): Promise<void> {
  await writeJson(roomsPath(), rooms);
}

export async function listRooms(): Promise<RoomRecord[]> {
  return readRooms();
}

export async function getRoom(id: string): Promise<RoomRecord | null> {
  return (await readRooms()).find((room) => room.id === id) ?? null;
}

export async function saveRoom(room: RoomRecord): Promise<void> {
  const rooms = await readRooms();
  const index = rooms.findIndex((item) => item.id === room.id);
  if (index >= 0) rooms[index] = room;
  else rooms.push(room);
  await writeRooms(rooms);
}

export async function removeRoomRecord(id: string): Promise<void> {
  if (id === GENERAL_ROOM_ID) throw new Error("room_fixed");
  const rooms = await readRooms();
  await writeRooms(rooms.filter((room) => room.id !== id));
}

function generalRoom(): RoomRecord {
  return {
    id: GENERAL_ROOM_ID,
    title: "Geral",
    folder: config.cursorCwd,
    cdpTitle: basename(config.cursorCwd),
    createdBy: "system",
    createdAt: Date.now(),
    sharedDeps: false,
    removable: false,
    status: "ready",
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function initStore(): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  await migrateLegacyHistory();
  await migrateLegacyArtifacts();

  if (!(await fileExists(usersPath())) && config.adminUser && config.adminPassword) {
    await createUser({
      username: config.adminUser,
      displayName: config.adminUser,
      password: config.adminPassword,
      role: "admin",
    });
    console.log(`[store] admin created username=${config.adminUser}`);
  }

  const rooms = await readRooms();
  if (!rooms.some((room) => room.id === GENERAL_ROOM_ID)) {
    rooms.unshift(generalRoom());
    await writeRooms(rooms);
  } else {
    const geral = rooms.find((room) => room.id === GENERAL_ROOM_ID)!;
    let changed = false;
    if (geral.folder !== config.cursorCwd) {
      geral.folder = config.cursorCwd;
      geral.cdpTitle = basename(config.cursorCwd);
      changed = true;
    }
    if (geral.status === "creating") {
      geral.status = "error";
      geral.statusError = "interrupted";
      changed = true;
    }
    if (changed) await writeRooms(rooms);
  }

  const refreshed = await readRooms();
  let interrupted = false;
  for (const room of refreshed) {
    if (room.status === "creating") {
      room.status = "error";
      room.statusError = "interrupted";
      interrupted = true;
    }
  }
  if (interrupted) await writeRooms(refreshed);
}
