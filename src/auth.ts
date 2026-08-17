import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { config } from "./config.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const MAX_DISPLAY_NAME_LEN = 40;

type LoginBucket = { count: number; resetAt: number };
const loginAttempts = new Map<string, LoginBucket>();

export type SessionUser = {
  clientId: string;
  displayName: string;
  expiresAt: number;
};

function sign(payload: string): string {
  return createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
}

function normalizeDisplayName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ").slice(0, MAX_DISPLAY_NAME_LEN);
  return name;
}

export function validateDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = normalizeDisplayName(raw);
  if (name.length < 1) return null;
  return name;
}

function encodeSession(user: { clientId: string; displayName: string }): string {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const nonce = randomBytes(16).toString("hex");
  const nameB64 = Buffer.from(user.displayName, "utf8").toString("base64url");
  const payload = `${expiresAt}.${user.clientId}.${nameB64}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}

function decodeSession(token: string | undefined): SessionUser | null {
  if (!token) return null;
  const parts = token.split(".");
  // New format: exp.clientId.nameB64.nonce.sig (5 parts)
  // Legacy format: exp.nonce.sig (3 parts) — treat as unauthenticated so users re-login
  if (parts.length !== 5) return null;
  const [expiresRaw, clientId, nameB64, nonce, signature] = parts;
  if (!expiresRaw || !clientId || !nameB64 || !nonce || !signature) return null;

  const payload = `${expiresRaw}.${clientId}.${nameB64}.${nonce}`;
  const expected = sign(payload);
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;
  if (!/^[a-f0-9]{16,64}$/i.test(clientId)) return null;

  let displayName: string;
  try {
    displayName = Buffer.from(nameB64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  displayName = normalizeDisplayName(displayName);
  if (!displayName) return null;

  return { clientId, displayName, expiresAt };
}

export function passwordsMatch(input: string, expected: string): boolean {
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(Buffer.alloc(b.length), b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function clientKey(c: Context): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

export function checkLoginRateLimit(c: Context): { ok: true } | { ok: false; retryAfterSec: number } {
  const key = clientKey(c);
  const now = Date.now();
  const bucket = loginAttempts.get(key);
  if (!bucket || now > bucket.resetAt) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return { ok: true };
  }
  if (bucket.count >= LOGIN_MAX_ATTEMPTS) {
    return { ok: false, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  bucket.count += 1;
  return { ok: true };
}

export function clearLoginRateLimit(c: Context): void {
  loginAttempts.delete(clientKey(c));
}

export function getSessionUser(c: Context): SessionUser | null {
  return decodeSession(getCookie(c, config.cookieName));
}

export function isAuthenticated(c: Context): boolean {
  return getSessionUser(c) !== null;
}

export function setSessionCookie(
  c: Context,
  user: { clientId?: string; displayName: string },
): SessionUser {
  const clientId = user.clientId || randomBytes(16).toString("hex");
  const displayName = normalizeDisplayName(user.displayName);
  const token = encodeSession({ clientId, displayName });
  const decoded = decodeSession(token)!;
  const secure =
    c.req.header("x-forwarded-proto") === "https" ||
    new URL(c.req.url).protocol === "https:";

  setCookie(c, config.cookieName, token, {
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    secure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return decoded;
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, config.cookieName, { path: "/" });
}

export const requireAuth: MiddlewareHandler = async (c: Context, next: Next) => {
  if (!isAuthenticated(c)) {
    return c.json({ error: "Não autenticado" }, 401);
  }
  await next();
};
