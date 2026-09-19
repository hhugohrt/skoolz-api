import { randomUUID } from "node:crypto";
import { Router } from "express";
import { queryAll, queryOne, run, getUserById } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { isAdmin, requireAdmin } from "../lib/admin.js";
import { isPremium } from "../lib/billing.js";
import { deleteCourse, deleteUserAccount } from "../lib/accountDeletion.js";
import { isEmailConfigured } from "../lib/email.js";
import { isWhopConfigured } from "../lib/whop.js";

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const count = async (sql: string, params: unknown[] = []) =>
  Number((await queryOne<{ count: number | string }>(sql, params))?.count ?? 0);

adminRouter.get("/overview", async (_req, res) => {
  const [users, new24h, new7d, verified, onboarded, premium, courses, failed, sheets, gens24h, gens7d] = await Promise.all([
    count("SELECT COUNT(*) as count FROM users"),
    count("SELECT COUNT(*) as count FROM users WHERE created_at > ?", [ago(DAY)]),
    count("SELECT COUNT(*) as count FROM users WHERE created_at > ?", [ago(7 * DAY)]),
    count("SELECT COUNT(*) as count FROM users WHERE email_verified = 1"),
    count("SELECT COUNT(*) as count FROM users WHERE onboarding_completed = 1"),
    count("SELECT COUNT(*) as count FROM users WHERE plan = 'premium'"),
    count("SELECT COUNT(*) as count FROM courses"),
    count("SELECT COUNT(*) as count FROM courses WHERE status = 'failed'"),
    count("SELECT COUNT(*) as count FROM revision_sheets"),
    count("SELECT COUNT(*) as count FROM ai_usage WHERE created_at > ?", [ago(DAY)]),
    count("SELECT COUNT(*) as count FROM ai_usage WHERE created_at > ?", [ago(7 * DAY)]),
  ]);

  // Courbes sur 14 jours (inscriptions et générations par jour).
  const since = ago(14 * DAY);
  const signups = await queryAll<{ d: string; c: number | string }>(
    "SELECT substr(created_at, 1, 10) as d, COUNT(*) as c FROM users WHERE created_at > ? GROUP BY substr(created_at, 1, 10)",
    [since],
  );
  const generations = await queryAll<{ d: string; c: number | string }>(
    "SELECT substr(created_at, 1, 10) as d, COUNT(*) as c FROM ai_usage WHERE created_at > ? GROUP BY substr(created_at, 1, 10)",
    [since],
  );
  const series = Array.from({ length: 14 }, (_, i) => {
    const day = new Date(Date.now() - (13 - i) * DAY).toISOString().slice(0, 10);
    return {
      day,
      signups: Number(signups.find((r) => r.d === day)?.c ?? 0),
      generations: Number(generations.find((r) => r.d === day)?.c ?? 0),
    };
  });

  res.json({ users, new24h, new7d, verified, onboarded, premium, courses, failed, sheets, gens24h, gens7d, series });
});

interface UserListRow {
  id: string;
  email: string;
  first_name: string;
  level: string | null;
  plan: string;
  email_verified: number;
  onboarding_completed: number;
  google_sub: string | null;
  whop_membership_id: string | null;
  created_at: string;
  courses: number | string;
  sheets: number | string;
  gens24h: number | string;
}

function serializeUser(row: UserListRow) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    level: row.level,
    plan: row.plan,
    isPremium: isPremium({ plan: row.plan, email: row.email, email_verified: row.email_verified }),
    isAdmin: isAdmin({ email: row.email, email_verified: row.email_verified }),
    emailVerified: Boolean(row.email_verified),
    onboardingCompleted: Boolean(row.onboarding_completed),
    google: Boolean(row.google_sub),
    whopMembershipId: row.whop_membership_id,
    createdAt: row.created_at,
    courses: Number(row.courses),
    sheets: Number(row.sheets),
    gens24h: Number(row.gens24h),
  };
}

const USER_SELECT = `
  SELECT u.id, u.email, u.first_name, u.level, u.plan, u.email_verified, u.onboarding_completed, u.google_sub,
         u.whop_membership_id, u.created_at,
         (SELECT COUNT(*) FROM courses c WHERE c.user_id = u.id) as courses,
         (SELECT COUNT(*) FROM revision_sheets s WHERE s.user_id = u.id) as sheets,
         (SELECT COUNT(*) FROM ai_usage a WHERE a.user_id = u.id AND a.created_at > ?) as gens24h
  FROM users u`;

adminRouter.get("/users", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase().slice(0, 80) : "";
  const filter = typeof req.query.filter === "string" ? req.query.filter : "all";
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  const where: string[] = [];
  const params: unknown[] = [];
  if (q) {
    where.push("(LOWER(u.email) LIKE ? OR LOWER(u.first_name) LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  if (filter === "premium") where.push("u.plan = 'premium'");
  if (filter === "free") where.push("u.plan <> 'premium'");
  if (filter === "unverified") where.push("u.email_verified = 0");
  const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";

  const total = await count(`SELECT COUNT(*) as count FROM users u${clause}`, params);
  const rows = await queryAll<UserListRow>(`${USER_SELECT}${clause} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`, [
    ago(DAY),
    ...params,
    limit,
    offset,
  ]);
  res.json({ total, users: rows.map(serializeUser) });
});

adminRouter.get("/users/:id", async (req, res) => {
  const row = await queryOne<UserListRow>(`${USER_SELECT} WHERE u.id = ?`, [ago(DAY), req.params.id]);
  if (!row) return res.status(404).json({ error: "Utilisateur introuvable." });

  const courses = await queryAll<{ id: string; title: string; status: string; error_message: string | null; created_at: string }>(
    "SELECT id, title, status, error_message, created_at FROM courses WHERE user_id = ? ORDER BY created_at DESC LIMIT 30",
    [row.id],
  );
  const sheets = await queryAll<{ id: string; title: string; created_at: string }>(
    "SELECT id, title, created_at FROM revision_sheets WHERE user_id = ? ORDER BY created_at DESC LIMIT 30",
    [row.id],
  );
  res.json({
    user: serializeUser(row),
    courses: courses.map((c) => ({ id: c.id, title: c.title, status: c.status, errorMessage: c.error_message, createdAt: c.created_at })),
    sheets: sheets.map((s) => ({ id: s.id, title: s.title, createdAt: s.created_at })),
  });
});

adminRouter.patch("/users/:id", async (req, res) => {
  const target = await getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: "Utilisateur introuvable." });
  const { plan, emailVerified, firstName } = req.body ?? {};

  if (plan !== undefined && plan !== "free" && plan !== "premium") return res.status(400).json({ error: "Formule invalide." });
  if (emailVerified !== undefined && typeof emailVerified !== "boolean") return res.status(400).json({ error: "Valeur invalide." });
  if (firstName !== undefined && (typeof firstName !== "string" || !firstName.trim() || firstName.length > 50)) {
    return res.status(400).json({ error: "Prénom invalide." });
  }

  if (plan !== undefined) await run("UPDATE users SET plan = ? WHERE id = ?", [plan, target.id]);
  if (emailVerified !== undefined) await run("UPDATE users SET email_verified = ? WHERE id = ?", [emailVerified ? 1 : 0, target.id]);
  if (firstName !== undefined) await run("UPDATE users SET first_name = ? WHERE id = ?", [firstName.trim(), target.id]);

  const row = (await queryOne<UserListRow>(`${USER_SELECT} WHERE u.id = ?`, [ago(DAY), target.id]))!;
  res.json({ user: serializeUser(row) });
});

// Suppression groupée : ignore ton propre compte et les administrateurs, et dit combien ont été supprimés.
adminRouter.post("/users/bulk-delete", async (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || ids.some((id) => typeof id !== "string")) {
    return res.status(400).json({ error: "Sélection invalide." });
  }
  let deleted = 0;
  let skipped = 0;
  for (const id of ids as string[]) {
    const target = id === req.userId ? undefined : await getUserById(id);
    if (!target || isAdmin(target)) {
      skipped++;
      continue;
    }
    await deleteUserAccount(target.id);
    deleted++;
  }
  res.json({ deleted, skipped });
});

adminRouter.delete("/users/:id", async (req, res) => {
  if (req.params.id === req.userId) return res.status(400).json({ error: "Tu ne peux pas supprimer ton propre compte ici." });
  const target = await getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: "Utilisateur introuvable." });
  if (isAdmin(target)) return res.status(400).json({ error: "Un administrateur ne peut pas être supprimé ici." });
  await deleteUserAccount(target.id);
  res.status(204).end();
});

adminRouter.get("/courses", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : "";
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
  const filtered = ["uploaded", "processing", "completed", "failed"].includes(status);
  const rows = await queryAll<{
    id: string;
    title: string;
    status: string;
    error_message: string | null;
    created_at: string;
    email: string;
    subject_name: string | null;
    sheet_id: string | null;
  }>(
    `SELECT c.id, c.title, c.status, c.error_message, c.created_at, u.email, s.name as subject_name,
            (SELECT rs.id FROM revision_sheets rs WHERE rs.course_id = c.id LIMIT 1) as sheet_id
     FROM courses c JOIN users u ON u.id = c.user_id LEFT JOIN subjects s ON s.id = c.subject_id${filtered ? " WHERE c.status = ?" : ""}
     ORDER BY c.created_at DESC LIMIT ?`,
    filtered ? [status, limit] : [limit],
  );
  res.json({
    courses: rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      errorMessage: r.error_message,
      createdAt: r.created_at,
      userEmail: r.email,
      subjectName: r.subject_name,
      sheetId: r.sheet_id,
    })),
  });
});

adminRouter.delete("/courses/:id", async (req, res) => {
  const course = await queryOne<{ id: string }>("SELECT id FROM courses WHERE id = ?", [req.params.id]);
  if (!course) return res.status(404).json({ error: "Cours introuvable." });
  await deleteCourse(course.id);
  res.status(204).end();
});

adminRouter.get("/subjects", async (_req, res) => {
  const rows = await queryAll<{ id: string; name: string; is_custom: number; courses: number | string; users: number | string }>(
    `SELECT s.id, s.name, s.is_custom,
            (SELECT COUNT(*) FROM courses c WHERE c.subject_id = s.id) as courses,
            (SELECT COUNT(*) FROM user_subjects us WHERE us.subject_id = s.id) as users
     FROM subjects s ORDER BY s.is_custom ASC, s.name ASC`,
  );
  res.json({
    subjects: rows.map((r) => ({ id: r.id, name: r.name, isCustom: Boolean(r.is_custom), courses: Number(r.courses), users: Number(r.users) })),
  });
});

adminRouter.post("/subjects", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name || name.length > 60) return res.status(400).json({ error: "Nom invalide." });
  if (await queryOne("SELECT id FROM subjects WHERE name = ?", [name])) return res.status(409).json({ error: "Cette matière existe déjà." });
  const id = randomUUID();
  await run("INSERT INTO subjects (id, name, is_custom) VALUES (?, ?, 0)", [id, name]);
  res.status(201).json({ subject: { id, name, isCustom: false, courses: 0, users: 0 } });
});

adminRouter.patch("/subjects/:id", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name || name.length > 60) return res.status(400).json({ error: "Nom invalide." });
  const clash = await queryOne<{ id: string }>("SELECT id FROM subjects WHERE name = ?", [name]);
  if (clash && clash.id !== req.params.id) return res.status(409).json({ error: "Ce nom est déjà utilisé." });
  await run("UPDATE subjects SET name = ? WHERE id = ?", [name, req.params.id]);
  res.json({ ok: true });
});

adminRouter.delete("/subjects/:id", async (req, res) => {
  const subject = await queryOne<{ id: string }>("SELECT id FROM subjects WHERE id = ?", [req.params.id]);
  if (!subject) return res.status(404).json({ error: "Matière introuvable." });
  // Les cours rangés dedans deviennent « non rangés » ; les choix des élèves sont supprimés en cascade.
  await run("UPDATE courses SET subject_id = NULL WHERE subject_id = ?", [subject.id]);
  await run("DELETE FROM subjects WHERE id = ?", [subject.id]);
  res.status(204).end();
});

adminRouter.get("/system", async (_req, res) => {
  const has = (name: string) => Boolean(process.env[name]);
  res.json({
    services: [
      { name: "Base de données", ok: true, detail: has("POSTGRES_URL") ? "PostgreSQL (Neon)" : "SQLite local" },
      { name: "Stockage des fichiers", ok: has("BLOB_READ_WRITE_TOKEN") || !process.env.VERCEL, detail: has("BLOB_READ_WRITE_TOKEN") ? "Vercel Blob" : "Disque local" },
      { name: "OpenAI (génération)", ok: has("OPENAI_API_KEY"), detail: process.env.OPENAI_MODEL ?? "gpt-4o-mini" },
      { name: "E-mails (Resend)", ok: isEmailConfigured(), detail: process.env.EMAIL_FROM ?? "non configuré" },
      { name: "Paiements (Whop)", ok: isWhopConfigured() && has("WHOP_WEBHOOK_SECRET"), detail: isWhopConfigured() ? "clé et formules configurées" : "non configuré" },
      { name: "Connexion Google", ok: has("GOOGLE_CLIENT_ID"), detail: has("GOOGLE_CLIENT_ID") ? "configurée" : "non configurée" },
    ],
    limits: {
      premiumDaily: Number(process.env.DAILY_GENERATION_LIMIT ?? 15),
      freeDaily: Number(process.env.FREE_DAILY_GENERATIONS ?? 2),
    },
  });
});
