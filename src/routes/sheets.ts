import { Router } from "express";
import { v4 as uuid } from "uuid";
import { queryAll, queryOne, run, getUserById } from "../db.js";
import { isPremium, maskText } from "../lib/billing.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const sheetsRouter = Router();
sheetsRouter.use(requireAuth);
// Compte gratuit : les fiches sont générées mais leur contenu reste masqué tant qu'il n'y a pas d'abonnement.
sheetsRouter.use(async (req, res, next) => {
  res.locals.premium = isPremium(await getUserById(req.userId!));
  next();
});

interface SheetRow {
  id: string;
  course_id: string;
  user_id: string;
  title: string;
  summary: string;
  created_at: string;
  course_title: string;
  subject_id: string | null;
  subject_name: string | null;
  chapter: string | null;
  part: number | string;
  part_count: number | string;
}

interface SectionRow {
  id: string;
  sheet_id: string;
  type: string;
  title: string | null;
  content: string;
  position: number;
}

const LIST_QUERY = `
  SELECT sheets.*, courses.title as course_title, courses.subject_id as subject_id,
         courses.chapter as chapter, subjects.name as subject_name
  FROM revision_sheets sheets
  JOIN courses ON courses.id = sheets.course_id
  LEFT JOIN subjects ON subjects.id = courses.subject_id
  WHERE sheets.user_id = ?
  ORDER BY sheets.created_at DESC, sheets.part ASC
`;

function serializeSheet(row: SheetRow, locked = false) {
  return {
    id: row.id,
    courseId: row.course_id,
    title: row.title,
    summary: locked ? maskText(row.summary) : row.summary,
    locked,
    courseTitle: row.course_title,
    subjectId: row.subject_id,
    subjectName: row.subject_name,
    chapter: row.chapter,
    part: Number(row.part ?? 1),
    partCount: Number(row.part_count ?? 1),
    createdAt: row.created_at,
  };
}

sheetsRouter.get("/", async (req, res) => {
  const rows = await queryAll<SheetRow>(LIST_QUERY, [req.userId!]);
  res.json({ sheets: rows.map((row) => serializeSheet(row, !res.locals.premium)) });
});

const SECTION_TYPES = new Set([
  "notion",
  "definition",
  "formula",
  "example",
  "key_point",
  "common_mistake",
  "date",
  "concept",
  "method",
]);

async function loadSheetDetail(id: string, userId: string, premium: boolean) {
  const row = await queryOne<SheetRow>(
    `SELECT sheets.*, courses.title as course_title, courses.subject_id as subject_id,
            courses.chapter as chapter, subjects.name as subject_name
     FROM revision_sheets sheets
     JOIN courses ON courses.id = sheets.course_id
     LEFT JOIN subjects ON subjects.id = courses.subject_id
     WHERE sheets.id = ? AND sheets.user_id = ?`,
    [id, userId],
  );
  if (!row) return null;

  const sections = await queryAll<SectionRow>(
    "SELECT * FROM revision_sheet_sections WHERE sheet_id = ? ORDER BY position ASC",
    [row.id],
  );

  // Les autres fiches du même cours (un long cours donne plusieurs fiches) pour naviguer de l'une à l'autre.
  const siblings = await queryAll<{ id: string; title: string; part: number | string }>(
    "SELECT id, title, part FROM revision_sheets WHERE course_id = ? AND user_id = ? ORDER BY part ASC, created_at ASC",
    [row.course_id, userId],
  );

  const locked = !premium;
  return {
    ...serializeSheet(row, locked),
    siblings: siblings.map((s) => ({ id: s.id, title: s.title, part: Number(s.part) })),
    sections: sections.map((s) => ({
      id: s.id,
      type: s.type,
      title: locked && s.title ? maskText(s.title) : s.title,
      content: locked ? maskText(s.content) : s.content,
    })),
  };
}

sheetsRouter.get("/:id", async (req, res) => {
  const sheet = await loadSheetDetail(req.params.id, req.userId!, res.locals.premium);
  if (!sheet) {
    return res.status(404).json({ error: "Fiche introuvable." });
  }
  res.json({ sheet });
});

// Édition manuelle de la fiche : titre, résumé et sections (ajout, suppression, ordre, type).
sheetsRouter.put("/:id", async (req, res) => {
  if (!res.locals.premium) {
    return res.status(402).json({ error: "Débloque tes fiches pour pouvoir les modifier." });
  }
  const owned = await queryOne<{ id: string }>("SELECT id FROM revision_sheets WHERE id = ? AND user_id = ?", [
    req.params.id,
    req.userId!,
  ]);
  if (!owned) {
    return res.status(404).json({ error: "Fiche introuvable." });
  }

  const { title, summary, sections } = req.body ?? {};
  if (typeof title !== "string" || title.trim().length === 0 || title.length > 200) {
    return res.status(400).json({ error: "Le titre est requis (200 caractères maximum)." });
  }
  if (typeof summary !== "string" || summary.length > 2_000) {
    return res.status(400).json({ error: "Le résumé est trop long (2 000 caractères maximum)." });
  }
  if (!Array.isArray(sections) || sections.length === 0 || sections.length > 60) {
    return res.status(400).json({ error: "Une fiche doit contenir entre 1 et 60 sections." });
  }

  const cleaned: { type: string; title: string | null; content: string }[] = [];
  for (const raw of sections) {
    const type = raw?.type;
    const sectionTitle = typeof raw?.title === "string" ? raw.title.trim() : "";
    const content = typeof raw?.content === "string" ? raw.content.trim() : "";
    if (typeof type !== "string" || !SECTION_TYPES.has(type)) {
      return res.status(400).json({ error: "Type de section invalide." });
    }
    if (content.length === 0) {
      return res.status(400).json({ error: "Une section ne peut pas être vide." });
    }
    if (content.length > 10_000 || sectionTitle.length > 200) {
      return res.status(400).json({ error: "Une section est trop longue." });
    }
    cleaned.push({ type, title: sectionTitle || null, content });
  }

  await run("UPDATE revision_sheets SET title = ?, summary = ? WHERE id = ?", [title.trim(), summary.trim(), owned.id]);
  await run("DELETE FROM revision_sheet_sections WHERE sheet_id = ?", [owned.id]);
  await run(
    `INSERT INTO revision_sheet_sections (id, sheet_id, type, title, content, position) VALUES ${cleaned
      .map(() => "(?, ?, ?, ?, ?, ?)")
      .join(", ")}`,
    cleaned.flatMap((section, index) => [uuid(), owned.id, section.type, section.title, section.content, index]),
  );

  res.json({ sheet: await loadSheetDetail(owned.id, req.userId!, res.locals.premium) });
});

// Rangement de la fiche dans une matière (ou retrait) : la matière est portée par le cours.
sheetsRouter.patch("/:id/subject", async (req, res) => {
  const sheet = await queryOne<{ id: string; course_id: string }>(
    "SELECT id, course_id FROM revision_sheets WHERE id = ? AND user_id = ?",
    [req.params.id, req.userId!],
  );
  if (!sheet) {
    return res.status(404).json({ error: "Fiche introuvable." });
  }

  const { subjectId } = req.body ?? {};
  if (subjectId !== null && typeof subjectId !== "string") {
    return res.status(400).json({ error: "Matière invalide." });
  }
  if (subjectId !== null) {
    const subject = await queryOne<{ id: string }>(
      "SELECT id FROM subjects WHERE id = ? AND (is_custom = 0 OR created_by = ?)",
      [subjectId, req.userId!],
    );
    if (!subject) {
      return res.status(400).json({ error: "Matière introuvable." });
    }
  }

  await run("UPDATE courses SET subject_id = ?, updated_at = ? WHERE id = ?", [
    subjectId,
    new Date().toISOString(),
    sheet.course_id,
  ]);

  res.json({ sheet: await loadSheetDetail(sheet.id, req.userId!, res.locals.premium) });
});
