import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import type { ChatAttachmentMeta, ChatImage } from "./agent.js";

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const ALLOWED_MIME = new Set([
  ...IMAGE_MIME,
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/xml",
  "text/xml",
  "application/javascript",
  "text/javascript",
  "application/typescript",
  "text/x-python",
  "application/octet-stream",
]);

const ALLOWED_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".pdf",
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".xml",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".log",
]);

function safeBaseName(name: string): string {
  const base = name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  return base || "file";
}

export type StoredUpload = {
  meta: ChatAttachmentMeta;
  image?: ChatImage;
};

export async function storeUploadedFile(file: File): Promise<StoredUpload> {
  if (file.size <= 0) {
    throw new Error("Arquivo vazio.");
  }
  if (file.size > config.maxUploadBytes) {
    throw new Error(`Arquivo maior que ${Math.floor(config.maxUploadBytes / (1024 * 1024))} MB.`);
  }

  const mimeType = (file.type || "application/octet-stream").toLowerCase();
  const ext = extname(file.name).toLowerCase();

  if (!ALLOWED_EXT.has(ext) && !ALLOWED_MIME.has(mimeType)) {
    throw new Error(`Tipo de arquivo não permitido: ${mimeType || ext || "desconhecido"}`);
  }

  await mkdir(config.uploadsDir, { recursive: true });
  const id = randomBytes(8).toString("hex");
  const storedName = `${Date.now()}-${id}-${safeBaseName(file.name)}`;
  const absolutePath = join(config.uploadsDir, storedName);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(absolutePath, buffer);

  if (IMAGE_MIME.has(mimeType)) {
    return {
      meta: {
        originalName: file.name,
        absolutePath,
        mimeType,
        kind: "image",
      },
      image: {
        data: buffer.toString("base64"),
        mimeType: mimeType as ChatImage["mimeType"],
      },
    };
  }

  // Heuristic: jpeg/png uploaded with empty/octet mime
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) {
    const guessed =
      ext === ".png"
        ? "image/png"
        : ext === ".webp"
          ? "image/webp"
          : ext === ".gif"
            ? "image/gif"
            : "image/jpeg";
    return {
      meta: {
        originalName: file.name,
        absolutePath,
        mimeType: guessed,
        kind: "image",
      },
      image: {
        data: buffer.toString("base64"),
        mimeType: guessed,
      },
    };
  }

  return {
    meta: {
      originalName: file.name,
      absolutePath,
      mimeType,
      kind: "file",
    },
  };
}
