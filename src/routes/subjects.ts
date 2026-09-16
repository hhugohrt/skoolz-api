import { Router } from "express";
import { v4 as uuid } from "uuid";
import { queryAll, queryOne, run } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const subjectsRouter = Router();

interface SubjectRow {
  id: string;
  name: string;
  is_custom: number;
}

subjectsRouter.get("/", async (_req, res) => {
  const subjects = await queryAll<SubjectRow>(
    "SELECT id, name, is_custom FROM subjects ORDER BY is_custom ASC, name ASC",
  );
  res.json({
    subjects: subjects.map((s) => ({ id: s.id, name: s.name, isCustom: Boolean(s.is_custom) })),
  });
});

subjectsRouter.post("/", requireAuth, async (req, res) => {
  const { name } = req.body ?? {};
  if (typeof name !== "string" || name.trim().length === 0) {
    return res.status(400).json({ error: "Le nom de la matière est requis." });
  }

  const trimmed = name.trim();
  const existing = await queryOne<SubjectRow>("SELECT id, name, is_custom FROM subjects WHERE name = ?", [trimmed]);
  if (existing) {
    return res.json({ subject: { id: existing.id, name: existing.name, isCustom: Boolean(existing.is_custom) } });
  }

  const id = uuid();
  await run("INSERT INTO subjects (id, name, is_custom, created_by) VALUES (?, ?, 1, ?)", [
    id,
    trimmed,
    req.userId!,
  ]);
  res.status(201).json({ subject: { id, name: trimmed, isCustom: true } });
});
