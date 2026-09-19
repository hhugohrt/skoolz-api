import "dotenv/config";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { authRouter } from "./routes/auth.js";
import { subjectsRouter } from "./routes/subjects.js";
import { onboardingRouter } from "./routes/onboarding.js";
import { coursesRouter } from "./routes/courses.js";
import { sheetsRouter } from "./routes/sheets.js";
import { billingRouter } from "./routes/billing.js";
import { adminRouter } from "./routes/admin.js";
import { deleteUserAccount } from "./lib/accountDeletion.js";
import { uploadSessionsRouter } from "./routes/uploadSessions.js";
import { requireAuth } from "./middleware/requireAuth.js";
import { getUserById, sanitizeUser, queryOne, run } from "./db.js";

const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5220";
const FRONTEND_PORT = new URL(FRONTEND_URL).port;
// localhost et 127.0.0.1 ne sont pas la même origine pour un navigateur.
// Les deux doivent rester autorisés pour que la preview locale fonctionne.
const localOrigins = new Set([FRONTEND_URL, `http://localhost:${FRONTEND_PORT}`, `http://127.0.0.1:${FRONTEND_PORT}`]);

// PUBLIC_URL = le domaine réel en production (ex: https://skoolz.club).
// On autorise ce domaine et sa variante www. automatiquement.
const PUBLIC_URL = process.env.PUBLIC_URL;
const publicOrigins = new Set<string>();
if (PUBLIC_URL) {
  const u = new URL(PUBLIC_URL);
  publicOrigins.add(u.origin);
  const altHost = u.hostname.startsWith("www.") ? u.hostname.slice(4) : `www.${u.hostname}`;
  publicOrigins.add(`${u.protocol}//${altHost}`);
}

// Autorise aussi le front servi sur l'IP locale (ex: http://192.168.1.23:5220) —
// nécessaire pour la page mobile ouverte via QR code depuis un téléphone sur le même Wi-Fi,
// uniquement pertinent en dev local (en production le QR pointe directement sur PUBLIC_URL).
const LAN_ORIGIN_PATTERN = new RegExp(
  `^https?://((10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})|(192\\.168\\.\\d{1,3}\\.\\d{1,3})|(172\\.(1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3})):${FRONTEND_PORT}$`,
);

export const app = express();

// Derrière le proxy de Vercel : sans ça, tous les visiteurs auraient la même adresse IP
// (celle du proxy) et la limitation de débit bloquerait tout le monde d'un coup.
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

const tooMany = { error: "Trop de requêtes. Réessaie dans quelques instants." };
// Connexion, inscription, Google : freine les essais de mots de passe en série.
app.use(
  "/api/auth",
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false, message: { error: "Trop de tentatives. Réessaie dans quelques minutes." } }),
);
app.use("/api", rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false, message: tooMany }));

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || localOrigins.has(origin) || publicOrigins.has(origin) || LAN_ORIGIN_PATTERN.test(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Not allowed by CORS"));
    },
  }),
);
app.use("/api/billing/webhook", express.raw({ type: "*/*", limit: "1mb" }));
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, async (req, res) => {
  const user = await getUserById(req.userId!);
  if (!user) {
    return res.status(404).json({ error: "Utilisateur introuvable." });
  }
  res.json({ user: sanitizeUser(user) });
});

// Modification du profil : prénom, niveau et/ou matières suivies (chaque champ est facultatif).
app.patch("/api/me", requireAuth, async (req, res) => {
  const { firstName, level, subjectIds } = req.body ?? {};
  const userId = req.userId!;

  if (firstName !== undefined) {
    if (typeof firstName !== "string" || firstName.trim().length === 0 || firstName.trim().length > 50) {
      return res.status(400).json({ error: "Prénom invalide." });
    }
  }
  if (level !== undefined && (typeof level !== "string" || !["6e", "5e", "4e", "3e", "seconde", "premiere", "terminale", "superieur"].includes(level))) {
    return res.status(400).json({ error: "Niveau invalide." });
  }
  if (subjectIds !== undefined) {
    if (!Array.isArray(subjectIds) || subjectIds.length > 60 || subjectIds.some((id) => typeof id !== "string")) {
      return res.status(400).json({ error: "Matières invalides." });
    }
    // Uniquement des matières communes ou créées par l'élève lui-même.
    for (const id of subjectIds as string[]) {
      const ok = await queryOne<{ id: string }>(
        "SELECT id FROM subjects WHERE id = ? AND (is_custom = 0 OR created_by = ?)",
        [id, userId],
      );
      if (!ok) return res.status(400).json({ error: "Matière inconnue." });
    }
  }

  if (firstName !== undefined) await run("UPDATE users SET first_name = ? WHERE id = ?", [firstName.trim(), userId]);
  if (level !== undefined) await run("UPDATE users SET level = ? WHERE id = ?", [level, userId]);
  if (subjectIds !== undefined) {
    await run("DELETE FROM user_subjects WHERE user_id = ?", [userId]);
    for (const id of subjectIds as string[]) {
      await run("INSERT INTO user_subjects (user_id, subject_id) VALUES (?, ?) ON CONFLICT DO NOTHING", [userId, id]);
    }
  }

  const user = (await getUserById(userId))!;
  res.json({ user: sanitizeUser(user) });
});

// Droit à l'effacement : supprime le compte et tout ce qui s'y rattache (cours, fiches, photos).
// La confirmation explicite évite qu'un appel accidentel détruise un compte.
app.delete("/api/me", requireAuth, async (req, res) => {
  if (req.body?.confirm !== "SUPPRIMER") {
    return res.status(400).json({ error: "Confirmation manquante." });
  }
  await deleteUserAccount(req.userId!);
  res.status(204).end();
});

app.use("/api/auth", authRouter);
app.use("/api/subjects", subjectsRouter);
app.use("/api/onboarding", onboardingRouter);
app.use("/api/courses", coursesRouter);
app.use("/api/sheets", sheetsRouter);
app.use("/api/billing", billingRouter);
app.use("/api/admin", adminRouter);
app.use("/api/upload-sessions", uploadSessionsRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Erreur serveur." });
});
