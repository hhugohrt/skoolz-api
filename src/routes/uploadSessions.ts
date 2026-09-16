import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { v4 as uuid } from "uuid";
import { queryAll, queryOne, run } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { getLanIp } from "../lib/network.js";
import { saveFile, readFile, deleteFile } from "../lib/storage.js";
import { serializeCourse, type CourseRow } from "./courses.js";

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const MAX_PHOTO_SIZE = 15 * 1024 * 1024; // 15 Mo

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_SIZE },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      cb(new Error("UNSUPPORTED_TYPE"));
      return;
    }
    cb(null, true);
  },
});

export const uploadSessionsRouter = Router();

interface SessionRow {
  id: string;
  user_id: string;
  status: string;
  created_at: string;
  expires_at: string;
}

interface SessionPhotoRow {
  id: string;
  session_id: string;
  storage_path: string;
  mime_type: string;
  original_name: string | null;
  position: number;
  created_at: string;
}

function getSession(id: string) {
  return queryOne<SessionRow>("SELECT * FROM upload_sessions WHERE id = ?", [id]);
}

function getSessionPhotos(sessionId: string) {
  return queryAll<SessionPhotoRow>(
    "SELECT * FROM upload_session_photos WHERE session_id = ? ORDER BY position ASC",
    [sessionId],
  );
}

function isExpired(session: SessionRow) {
  return new Date(session.expires_at).getTime() < Date.now();
}

function serializePhoto(photo: SessionPhotoRow) {
  return {
    id: photo.id,
    position: photo.position,
    mimeType: photo.mime_type,
    createdAt: photo.created_at,
  };
}

uploadSessionsRouter.post("/", requireAuth, async (req, res) => {
  const id = uuid();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  await run("INSERT INTO upload_sessions (id, user_id, status, created_at, expires_at) VALUES (?, ?, 'pending', ?, ?)", [
    id,
    req.userId!,
    now.toISOString(),
    expiresAt.toISOString(),
  ]);

  const lanIp = getLanIp();
  res.status(201).json({ sessionId: id, expiresAt: expiresAt.toISOString(), lanIp });
});

uploadSessionsRouter.get("/:id/status", async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: "Session introuvable." });
  }
  if (session.status === "pending" && isExpired(session)) {
    await run("UPDATE upload_sessions SET status = 'expired' WHERE id = ?", [session.id]);
    return res.json({ status: "expired", photoCount: 0 });
  }
  const photos = await getSessionPhotos(session.id);
  res.json({ status: session.status, photoCount: photos.length });
});

// Liste des photos reçues pour cette session — utilisé par le PC pour afficher la galerie.
uploadSessionsRouter.get("/:id/photos", requireAuth, async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session || session.user_id !== req.userId) {
    return res.status(404).json({ error: "Session introuvable." });
  }
  res.json({ photos: (await getSessionPhotos(session.id)).map(serializePhoto) });
});

// Sert le fichier binaire d'une photo — utilisé par le PC pour afficher les miniatures.
uploadSessionsRouter.get("/:id/photos/:photoId/file", requireAuth, async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session || session.user_id !== req.userId) {
    return res.status(404).json({ error: "Session introuvable." });
  }
  const photo = await queryOne<SessionPhotoRow>(
    "SELECT * FROM upload_session_photos WHERE id = ? AND session_id = ?",
    [req.params.photoId, session.id],
  );
  if (!photo) {
    return res.status(404).json({ error: "Photo introuvable." });
  }
  const buffer = await readFile(photo.storage_path);
  res.type(photo.mime_type).send(buffer);
});

uploadSessionsRouter.post("/:id/photo", async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: "Session introuvable." });
  }
  if (session.status !== "pending" && session.status !== "received") {
    return res.status(409).json({ error: "Ce lien n'est plus valide." });
  }
  if (isExpired(session)) {
    await run("UPDATE upload_sessions SET status = 'expired' WHERE id = ?", [session.id]);
    return res.status(410).json({ error: "Ce code a expiré. Régénère-en un nouveau depuis ton ordinateur." });
  }

  upload.single("photo")(req, res, async (err) => {
    if (err) {
      if (err.message === "UNSUPPORTED_TYPE") {
        return res.status(400).json({ error: "Format non supporté. Utilise une photo (JPEG, PNG, WEBP, HEIC)." });
      }
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "Photo trop volumineuse (15 Mo maximum)." });
      }
      return res.status(400).json({ error: "Impossible d'envoyer cette photo." });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "Aucune photo reçue." });
    }

    const existingPhotos = await getSessionPhotos(session.id);
    const nextPosition = existingPhotos.length;
    const storedFilename = `${uuid()}${path.extname(file.originalname) || ".jpg"}`;
    const storagePath = await saveFile(file.buffer, storedFilename, file.mimetype, `sessions/${session.id}`);

    await run(
      "INSERT INTO upload_session_photos (id, session_id, storage_path, mime_type, original_name, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [uuid(), session.id, storagePath, file.mimetype, file.originalname, nextPosition, new Date().toISOString()],
    );

    if (session.status === "pending") {
      await run("UPDATE upload_sessions SET status = 'received' WHERE id = ?", [session.id]);
    }

    res.status(201).json({ ok: true, photoCount: nextPosition + 1 });
  });
});

// "Recommencer" — efface toutes les photos reçues, la session (et son QR code) restent valides.
uploadSessionsRouter.post("/:id/reset", requireAuth, async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session || session.user_id !== req.userId) {
    return res.status(404).json({ error: "Session introuvable." });
  }

  for (const photo of await getSessionPhotos(session.id)) {
    await deleteFile(photo.storage_path).catch(() => {});
  }
  await run("DELETE FROM upload_session_photos WHERE session_id = ?", [session.id]);
  await run("UPDATE upload_sessions SET status = 'pending' WHERE id = ?", [session.id]);

  res.json({ ok: true });
});

// "Utiliser ces photos" — combine toutes les photos reçues en un seul cours.
uploadSessionsRouter.post("/:id/import", requireAuth, async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session || session.user_id !== req.userId) {
    return res.status(404).json({ error: "Session introuvable." });
  }
  const photos = await getSessionPhotos(session.id);
  if (session.status !== "received" || photos.length === 0) {
    return res.status(409).json({ error: "Aucune photo reçue pour l'instant." });
  }

  const courseId = uuid();
  const now = new Date().toISOString();
  const title = photos.length > 1 ? `Photos de cours (${photos.length} pages)` : "Photo de cours";

  await run("INSERT INTO courses (id, user_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'uploaded', ?, ?)", [
    courseId,
    req.userId,
    title,
    now,
    now,
  ]);

  for (const [index, photo] of photos.entries()) {
    await run(
      "INSERT INTO course_photos (id, course_id, storage_path, mime_type, position, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [uuid(), courseId, photo.storage_path, photo.mime_type, index, now],
    );
  }

  await run("UPDATE upload_sessions SET status = 'consumed' WHERE id = ?", [session.id]);

  const course = (await queryOne<CourseRow>("SELECT * FROM courses WHERE id = ?", [courseId]))!;
  res.status(201).json({ course: await serializeCourse(course) });
});
