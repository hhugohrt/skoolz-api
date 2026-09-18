import { Router } from "express";
import { queryAll, queryOne } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const sheetsRouter = Router();
sheetsRouter.use(requireAuth);

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
  ORDER BY sheets.created_at DESC
`;

function serializeSheet(row: SheetRow) {
  return {
    id: row.id,
    courseId: row.course_id,
    title: row.title,
    summary: row.summary,
    courseTitle: row.course_title,
    subjectId: row.subject_id,
    subjectName: row.subject_name,
    chapter: row.chapter,
    createdAt: row.created_at,
  };
}

sheetsRouter.get("/", async (req, res) => {
  const rows = await queryAll<SheetRow>(LIST_QUERY, [req.userId!]);
  res.json({ sheets: rows.map(serializeSheet) });
});

sheetsRouter.get("/:id", async (req, res) => {
  const row = await queryOne<SheetRow>(
    `SELECT sheets.*, courses.title as course_title, courses.subject_id as subject_id,
            courses.chapter as chapter, subjects.name as subject_name
     FROM revision_sheets sheets
     JOIN courses ON courses.id = sheets.course_id
     LEFT JOIN subjects ON subjects.id = courses.subject_id
     WHERE sheets.id = ? AND sheets.user_id = ?`,
    [req.params.id, req.userId!],
  );

  if (!row) {
    return res.status(404).json({ error: "Fiche introuvable." });
  }

  const sections = await queryAll<SectionRow>(
    "SELECT * FROM revision_sheet_sections WHERE sheet_id = ? ORDER BY position ASC",
    [row.id],
  );

  res.json({
    sheet: {
      ...serializeSheet(row),
      sections: sections.map((s) => ({ id: s.id, type: s.type, title: s.title, content: s.content })),
    },
  });
});
