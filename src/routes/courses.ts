import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { v4 as uuid } from "uuid";
import { queryAll, queryOne, run, getUserById } from "../db.js";
import { isPremium } from "../lib/billing.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { saveFile, deleteFile } from "../lib/storage.js";
import { extractText, UnsupportedFileError } from "../lib/extractText.js";
import {
  generateRevisionSheet,
  generateRevisionSheetFromImages,
  suggestSubject,
  AiNotConfiguredError,
  AiGenerationError,
} from "../lib/ai.js";

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 Mo

// memoryStorage : le fichier arrive en Buffer (req.file.buffer), pas écrit sur disque —
// nécessaire pour rester compatible avec les fonctions serverless Vercel (fs éphémère).
// saveFile() se charge ensuite de l'écrire sur disque (dev) ou sur Vercel Blob (prod).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(new Error("UNSUPPORTED_TYPE"));
      return;
    }
    cb(null, true);
  },
});

export const coursesRouter = Router();
coursesRouter.use(requireAuth);

export interface CourseRow {
  id: string;
  user_id: string;
  title: string;
  filename: string | null;
  storage_path: string | null;
  mime_type: string | null;
  subject_id: string | null;
  chapter: string | null;
  status: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface CoursePhotoRow {
  id: string;
  course_id: string;
  storage_path: string;
  mime_type: string;
  position: number;
  created_at: string;
}

export async function serializeCourse(row: CourseRow) {
  const countRow = await queryOne<{ count: number }>(
    "SELECT COUNT(*) as count FROM course_photos WHERE course_id = ?",
    [row.id],
  );

  return {
    id: row.id,
    title: row.title,
    filename: row.filename,
    subjectId: row.subject_id,
    chapter: row.chapter,
    status: row.status,
    errorMessage: row.error_message,
    photoCount: Number(countRow?.count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

coursesRouter.get("/", async (req, res) => {
  const rows = await queryAll<CourseRow>("SELECT * FROM courses WHERE user_id = ? ORDER BY created_at DESC", [
    req.userId!,
  ]);
  res.json({ courses: await Promise.all(rows.map(serializeCourse)) });
});

coursesRouter.post("/", (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) {
      if (err.message === "UNSUPPORTED_TYPE") {
        return res
          .status(400)
          .json({ error: "Format non supporté. Utilise PDF, DOC, DOCX, PPT, PPTX, TXT ou une photo." });
      }
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "Fichier trop volumineux (20 Mo maximum)." });
      }
      return res.status(400).json({ error: "Impossible d'importer ce fichier." });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "Aucun fichier reçu." });
    }

    const { subjectId, chapter } = req.body ?? {};
    const id = uuid();
    const now = new Date().toISOString();
    const title = file.originalname.replace(/\.[^/.]+$/, "");
    const storedFilename = `${uuid()}${path.extname(file.originalname)}`;
    const storagePath = await saveFile(file.buffer, storedFilename, file.mimetype, `courses/${req.userId}`);

    await run(
      `INSERT INTO courses (id, user_id, title, filename, storage_path, mime_type, subject_id, chapter, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', ?, ?)`,
      [
        id,
        req.userId!,
        title,
        file.originalname,
        storagePath,
        file.mimetype,
        typeof subjectId === "string" && subjectId.length > 0 ? subjectId : null,
        typeof chapter === "string" && chapter.length > 0 ? chapter : null,
        now,
        now,
      ],
    );

    const row = (await queryOne<CourseRow>("SELECT * FROM courses WHERE id = ?", [id]))!;
    res.status(201).json({ course: await serializeCourse(row) });
  });
});

coursesRouter.get("/:id", async (req, res) => {
  const row = await queryOne<CourseRow>("SELECT * FROM courses WHERE id = ? AND user_id = ?", [
    req.params.id,
    req.userId!,
  ]);
  if (!row) {
    return res.status(404).json({ error: "Cours introuvable." });
  }
  res.json({ course: await serializeCourse(row) });
});

coursesRouter.delete("/:id", async (req, res) => {
  const row = await queryOne<CourseRow>("SELECT * FROM courses WHERE id = ? AND user_id = ?", [
    req.params.id,
    req.userId!,
  ]);
  if (!row) {
    return res.status(404).json({ error: "Cours introuvable." });
  }
  if (row.storage_path) {
    await deleteFile(row.storage_path).catch(() => {});
  }
  const photos = await queryAll<CoursePhotoRow>("SELECT * FROM course_photos WHERE course_id = ?", [row.id]);
  for (const photo of photos) {
    await deleteFile(photo.storage_path).catch(() => {});
  }
  await run("DELETE FROM courses WHERE id = ?", [row.id]);
  res.status(204).end();
});

coursesRouter.post("/:id/generate", async (req, res) => {
  const row = await queryOne<CourseRow>("SELECT * FROM courses WHERE id = ? AND user_id = ?", [
    req.params.id,
    req.userId!,
  ]);
  if (!row) {
    return res.status(404).json({ error: "Cours introuvable." });
  }

  // Chaque génération coûte des appels IA : plafond par élève et par jour pour éviter les abus.
  // Comptes gratuits : quota très réduit (leurs fiches restent floutées). Abonnés : quota confortable.
  const premium = isPremium(await getUserById(req.userId!));
  const dailyLimit = premium
    ? Number(process.env.DAILY_GENERATION_LIMIT ?? 15)
    : Number(process.env.FREE_DAILY_GENERATIONS ?? 2);
  if (dailyLimit <= 0) {
    return res.status(402).json({ error: "Abonne-toi pour générer tes fiches." });
  }
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const usage = await queryOne<{ count: number }>(
    "SELECT COUNT(*) as count FROM ai_usage WHERE user_id = ? AND created_at > ?",
    [req.userId!, since],
  );
  if (Number(usage?.count ?? 0) >= dailyLimit) {
    return res.status(premium ? 429 : 402).json({
      error: premium
        ? `Tu as atteint la limite de ${dailyLimit} fiches par jour. Réessaie demain.`
        : "Abonne-toi pour générer plus de fiches.",
    });
  }
  await run("INSERT INTO ai_usage (id, user_id, created_at) VALUES (?, ?, ?)", [
    uuid(),
    req.userId!,
    new Date().toISOString(),
  ]);

  await run("UPDATE courses SET status = 'processing', updated_at = ? WHERE id = ?", [
    new Date().toISOString(),
    row.id,
  ]);

  try {
    const photos = await queryAll<CoursePhotoRow>(
      "SELECT * FROM course_photos WHERE course_id = ? ORDER BY position ASC",
      [row.id],
    );

    let sheet;
    if (photos.length > 0) {
      sheet = await generateRevisionSheetFromImages(
        photos.map((p) => ({ path: p.storage_path, mimeType: p.mime_type })),
      );
    } else if (!row.storage_path || !row.mime_type) {
      throw new UnsupportedFileError("Ce cours n'a pas de contenu à analyser.");
    } else if (row.mime_type.startsWith("image/")) {
      sheet = await generateRevisionSheetFromImages([{ path: row.storage_path, mimeType: row.mime_type }]);
    } else {
      const text = await extractText(row.storage_path, row.mime_type);
      if (text.trim().length < 20) {
        throw new UnsupportedFileError("Le fichier ne contient pas assez de texte exploitable.");
      }
      sheet = await generateRevisionSheet(text);
    }

    // Régénérer (bouton "Réessayer") remplace la fiche précédente au lieu d'en empiler une seconde.
    // Les sections partent avec elle (ON DELETE CASCADE).
    await run("DELETE FROM revision_sheets WHERE course_id = ?", [row.id]);

    const sheetId = uuid();
    const createdAt = new Date().toISOString();
    await run(
      "INSERT INTO revision_sheets (id, course_id, user_id, title, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [sheetId, row.id, req.userId!, sheet.title, sheet.summary, createdAt],
    );

    // Un seul INSERT multi-lignes plutôt qu'un aller-retour base par section.
    await run(
      `INSERT INTO revision_sheet_sections (id, sheet_id, type, title, content, position) VALUES ${sheet.sections
        .map(() => "(?, ?, ?, ?, ?, ?)")
        .join(", ")}`,
      sheet.sections.flatMap((section, index) => [
        uuid(),
        sheetId,
        section.type,
        section.title ?? null,
        section.content,
        index,
      ]),
    );

    await run("UPDATE courses SET status = 'completed', updated_at = ? WHERE id = ?", [
      new Date().toISOString(),
      row.id,
    ]);

    // Suggestion de rangement : jamais bloquante, l'élève confirme ou choisit ailleurs côté app.
    let suggestedSubject: { id: string; name: string } | null = null;
    if (!row.subject_id) {
      try {
        let candidates = await queryAll<{ id: string; name: string }>(
          "SELECT s.id, s.name FROM subjects s JOIN user_subjects us ON us.subject_id = s.id WHERE us.user_id = ?",
          [req.userId!],
        );
        if (candidates.length === 0) {
          candidates = await queryAll<{ id: string; name: string }>("SELECT id, name FROM subjects WHERE is_custom = 0");
        }
        const subjectId = await suggestSubject(sheet, candidates);
        suggestedSubject = candidates.find((s) => s.id === subjectId) ?? null;
      } catch (subjectErr) {
        console.error("Suggestion de matière ignorée:", (subjectErr as Error)?.message);
      }
    }

    res.json({ sheetId, suggestedSubject });
  } catch (err) {
    const message =
      err instanceof UnsupportedFileError || err instanceof AiNotConfiguredError || err instanceof AiGenerationError
        ? err.message
        : "Impossible de générer la fiche pour le moment. Réessaie dans quelques instants.";

    await run("UPDATE courses SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?", [
      message,
      new Date().toISOString(),
      row.id,
    ]);

    res.status(err instanceof AiNotConfiguredError ? 503 : 422).json({ error: message });
  }
});
