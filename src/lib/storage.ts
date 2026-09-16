import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { put, del } from "@vercel/blob";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_ROOT = path.join(__dirname, "..", "..", "uploads");

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

// En local (dev), les fichiers vont sur le disque du serveur — simple, aucun compte requis.
// En production sur Vercel, le système de fichiers est éphémère (fonctions serverless), donc
// on stocke sur Vercel Blob dès que BLOB_READ_WRITE_TOKEN est configuré. Le champ "storage_path"
// contient soit un chemin local, soit une URL Blob — readFile()/deleteFile() gèrent les deux.

export async function saveFile(buffer: Buffer, filename: string, mimeType: string, folder: string): Promise<string> {
  if (BLOB_TOKEN) {
    const blob = await put(`${folder}/${filename}`, buffer, {
      access: "public",
      contentType: mimeType,
      token: BLOB_TOKEN,
      addRandomSuffix: true,
    });
    return blob.url;
  }

  const dir = path.join(UPLOAD_ROOT, folder);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

export async function readFile(storagePath: string): Promise<Buffer> {
  if (storagePath.startsWith("http://") || storagePath.startsWith("https://")) {
    const res = await fetch(storagePath);
    if (!res.ok) throw new Error(`Impossible de lire le fichier stocké (${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  }
  return fs.readFile(storagePath);
}

export async function deleteFile(storagePath: string): Promise<void> {
  if (storagePath.startsWith("http://") || storagePath.startsWith("https://")) {
    if (BLOB_TOKEN) {
      await del(storagePath, { token: BLOB_TOKEN }).catch(() => {});
    }
    return;
  }
  await fs.rm(storagePath, { force: true });
}
