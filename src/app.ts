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
import { uploadSessionsRouter } from "./routes/uploadSessions.js";
import { requireAuth } from "./middleware/requireAuth.js";
import { getUserById, sanitizeUser, queryAll, run } from "./db.js";
import { deleteFile } from "./lib/storage.js";

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

// Droit à l'effacement : supprime le compte et tout ce qui s'y rattache (cours, fiches, photos).
// La confirmation explicite évite qu'un appel accidentel détruise un compte.
app.delete("/api/me", requireAuth, async (req, res) => {
  if (req.body?.confirm !== "SUPPRIMER") {
    return res.status(400).json({ error: "Confirmation manquante." });
  }
  const userId = req.userId!;

  const rows = [
    ...(await queryAll<{ p: string | null }>("SELECT storage_path AS p FROM courses WHERE user_id = ?", [userId])),
    ...(await queryAll<{ p: string | null }>(
      "SELECT cp.storage_path AS p FROM course_photos cp JOIN courses c ON c.id = cp.course_id WHERE c.user_id = ?",
      [userId],
    )),
    ...(await queryAll<{ p: string | null }>(
      "SELECT sp.storage_path AS p FROM upload_session_photos sp JOIN upload_sessions s ON s.id = sp.session_id WHERE s.user_id = ?",
      [userId],
    )),
  ];
  await Promise.all(rows.map((row) => (row.p ? deleteFile(row.p).catch(() => {}) : undefined)));

  // Les matières créées par l'élève restent disponibles pour les autres : on retire juste le lien.
  await run("UPDATE subjects SET created_by = NULL WHERE created_by = ?", [userId]);
  await run("DELETE FROM users WHERE id = ?", [userId]);
  res.status(204).end();
});

app.use("/api/auth", authRouter);
app.use("/api/subjects", subjectsRouter);
app.use("/api/onboarding", onboardingRouter);
app.use("/api/courses", coursesRouter);
app.use("/api/sheets", sheetsRouter);
app.use("/api/upload-sessions", uploadSessionsRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Erreur serveur." });
});
