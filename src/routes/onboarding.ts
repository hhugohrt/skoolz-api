import { Router } from "express";
import { queryAll, run, getUserById, sanitizeUser } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const onboardingRouter = Router();

const VALID_LEVELS = ["3e", "seconde", "premiere", "terminale", "superieur"];
const VALID_THEMES = ["light", "dark", "auto"];

onboardingRouter.get("/subjects", requireAuth, async (req, res) => {
  const rows = await queryAll<{ subject_id: string }>(
    "SELECT subject_id FROM user_subjects WHERE user_id = ?",
    [req.userId!],
  );
  res.json({ subjectIds: rows.map((r) => r.subject_id) });
});

onboardingRouter.post("/", requireAuth, async (req, res) => {
  const { level, subjectIds, theme } = req.body ?? {};

  if (typeof level !== "string" || !VALID_LEVELS.includes(level)) {
    return res.status(400).json({ error: "Niveau invalide." });
  }
  if (!Array.isArray(subjectIds) || subjectIds.some((id) => typeof id !== "string")) {
    return res.status(400).json({ error: "Matières invalides." });
  }
  if (typeof theme !== "string" || !VALID_THEMES.includes(theme)) {
    return res.status(400).json({ error: "Thème invalide." });
  }

  const userId = req.userId!;

  await run("UPDATE users SET level = ?, theme = ?, onboarding_completed = 1 WHERE id = ?", [
    level,
    theme,
    userId,
  ]);

  await run("DELETE FROM user_subjects WHERE user_id = ?", [userId]);
  for (const subjectId of subjectIds as string[]) {
    await run(
      "INSERT INTO user_subjects (user_id, subject_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
      [userId, subjectId],
    );
  }

  const user = (await getUserById(userId))!;
  res.json({ user: sanitizeUser(user) });
});
