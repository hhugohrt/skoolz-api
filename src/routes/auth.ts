import { randomBytes } from "node:crypto";
import { Router } from "express";
import { v4 as uuid } from "uuid";
import { comparePassword, hashPassword, signToken } from "../auth.js";
import { run, queryOne, getUserByEmail, getUserById, sanitizeUser, type DbUser } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { appUrl, isEmailConfigured, resetEmail, sendEmail, verificationEmail } from "../lib/email.js";
import { consumeAuthToken, createAuthToken, createdRecently } from "../lib/authTokens.js";

export const authRouter = Router();

authRouter.post("/register", async (req, res) => {
  const { email, password, firstName } = req.body ?? {};

  if (typeof firstName !== "string" || firstName.trim().length === 0) {
    return res.status(400).json({ error: "Le prénom est requis." });
  }
  if (typeof email !== "string" || !email.includes("@")) {
    return res.status(400).json({ error: "Adresse e-mail invalide." });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Le mot de passe doit contenir au moins 8 caractères." });
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (await getUserByEmail(normalizedEmail)) {
    return res.status(409).json({ error: "Un compte existe déjà avec cet e-mail." });
  }

  const id = uuid();
  const passwordHash = await hashPassword(password);
  const createdAt = new Date().toISOString();

  await run(
    "INSERT INTO users (id, email, first_name, password_hash, theme, onboarding_completed, email_verified, created_at) VALUES (?, ?, ?, ?, 'auto', 0, 0, ?)",
    [id, normalizedEmail, firstName.trim(), passwordHash, createdAt],
  );

  const user = (await getUserByEmail(normalizedEmail))!;

  // Confirmation de l'adresse : n'empêche jamais l'inscription (si l'envoi échoue, l'élève peut
  // redemander le mail depuis l'application).
  try {
    const verifyToken = await createAuthToken(user.id, "verify");
    await sendEmail(verificationEmail(user.email, user.first_name, `${appUrl()}/verify-email?token=${verifyToken}`));
  } catch (err) {
    console.error("E-mail de confirmation non envoyé:", (err as Error)?.message);
  }

  const token = signToken(user.id);
  res.status(201).json({ token, user: sanitizeUser(user) });
});

authRouter.post("/login", async (req, res) => {
  const { email, password } = req.body ?? {};

  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "E-mail et mot de passe requis." });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const user = await getUserByEmail(normalizedEmail);
  if (!user || !(await comparePassword(password, user.password_hash))) {
    return res.status(401).json({ error: "E-mail ou mot de passe incorrect." });
  }

  const token = signToken(user.id);
  res.json({ token, user: sanitizeUser(user) });
});

// Connexion / inscription avec Google. Le navigateur obtient un jeton d'accès via Google Identity
// Services ; on vérifie ici qu'il a bien été émis pour NOTRE application (audience) avant de faire
// confiance à l'adresse e-mail qu'il désigne. Aucun secret client n'est nécessaire.
authRouter.post("/google", async (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(503).json({ error: "La connexion avec Google n'est pas encore activée." });
  }

  const { accessToken } = req.body ?? {};
  if (typeof accessToken !== "string" || accessToken.length < 20 || accessToken.length > 4096) {
    return res.status(400).json({ error: "Jeton Google manquant." });
  }

  try {
    const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
    const info = (await infoRes.json()) as { aud?: string; azp?: string };
    if (!infoRes.ok || (info.aud !== clientId && info.azp !== clientId)) {
      return res.status(401).json({ error: "Connexion Google refusée." });
    }

    const profileRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const profile = (await profileRes.json()) as {
      sub?: string;
      email?: string;
      email_verified?: boolean | string;
      name?: string;
      given_name?: string;
    };
    if (!profileRes.ok || !profile.sub || !profile.email) {
      return res.status(401).json({ error: "Impossible de lire ton profil Google." });
    }
    if (profile.email_verified !== true && profile.email_verified !== "true") {
      return res.status(401).json({ error: "Ton adresse Google n'est pas vérifiée." });
    }

    const email = profile.email.trim().toLowerCase();
    let isNew = false;
    let user = await queryOne<DbUser>("SELECT * FROM users WHERE google_sub = ?", [profile.sub]);

    if (!user) {
      // Un compte existe déjà avec cette adresse (créé par mot de passe) : Google a vérifié
      // qu'elle appartient bien à cette personne, on relie donc les deux.
      user = await getUserByEmail(email);
      if (user) {
        await run("UPDATE users SET google_sub = ?, email_verified = 1 WHERE id = ?", [profile.sub, user.id]);
      }
    }

    if (!user) {
      isNew = true;
      const id = uuid();
      const firstName = (profile.given_name || profile.name || email.split("@")[0]).trim().slice(0, 60) || "Élève";
      // Compte sans mot de passe : on stocke un hash d'une valeur aléatoire que personne ne connaît.
      const unusableHash = await hashPassword(randomBytes(32).toString("hex"));
      await run(
        "INSERT INTO users (id, email, first_name, password_hash, google_sub, theme, onboarding_completed, created_at) VALUES (?, ?, ?, ?, ?, 'auto', 0, ?)",
        [id, email, firstName, unusableHash, profile.sub, new Date().toISOString()],
      );
      user = (await getUserByEmail(email))!;
    }

    res.json({ token: signToken(user.id), user: sanitizeUser(user), isNew });
  } catch (err) {
    console.error("Erreur connexion Google:", (err as Error)?.message);
    res.status(502).json({ error: "Impossible de joindre Google pour le moment. Réessaie dans un instant." });
  }
});

// --- Mot de passe oublié -----------------------------------------------------------------------

// Réponse identique que le compte existe ou non : on ne révèle pas quelles adresses sont inscrites.
authRouter.post("/forgot-password", async (req, res) => {
  const { email } = req.body ?? {};
  if (typeof email !== "string" || !email.includes("@") || email.length > 200) {
    return res.status(400).json({ error: "Adresse e-mail invalide." });
  }

  const user = await getUserByEmail(email.trim().toLowerCase());
  if (user && !(await createdRecently(user.id, "reset", 60_000))) {
    const token = await createAuthToken(user.id, "reset");
    await sendEmail(resetEmail(user.email, user.first_name, `${appUrl()}/reset-password?token=${token}`));
  }
  res.json({ ok: true });
});

authRouter.post("/reset-password", async (req, res) => {
  const { token, password } = req.body ?? {};
  if (typeof token !== "string" || token.length < 20 || token.length > 200) {
    return res.status(400).json({ error: "Ce lien est invalide ou a expiré." });
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 200) {
    return res.status(400).json({ error: "Le mot de passe doit contenir au moins 8 caractères." });
  }

  const userId = await consumeAuthToken(token, "reset");
  if (!userId) {
    return res.status(400).json({ error: "Ce lien est invalide ou a expiré. Refais une demande de réinitialisation." });
  }

  // Avoir reçu le lien prouve que la boîte mail est la sienne : l'adresse devient vérifiée.
  await run("UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?", [await hashPassword(password), userId]);
  res.json({ ok: true });
});

// --- Confirmation de l'adresse e-mail ----------------------------------------------------------

authRouter.post("/send-verification", requireAuth, async (req, res) => {
  const user = await getUserById(req.userId!);
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable." });
  if (user.email_verified) return res.json({ ok: true, alreadyVerified: true });

  if (!isEmailConfigured()) {
    return res.status(503).json({ error: "L'envoi d'e-mails n'est pas encore activé. Réessaie plus tard." });
  }
  if (await createdRecently(user.id, "verify", 60_000)) {
    return res.status(429).json({ error: "Un e-mail vient déjà d'être envoyé. Patiente une minute avant d'en redemander un." });
  }

  const token = await createAuthToken(user.id, "verify");
  const sent = await sendEmail(verificationEmail(user.email, user.first_name, `${appUrl()}/verify-email?token=${token}`));
  if (!sent) return res.status(502).json({ error: "Impossible d'envoyer l'e-mail pour le moment. Réessaie plus tard." });
  res.json({ ok: true });
});

authRouter.post("/verify-email", async (req, res) => {
  const { token } = req.body ?? {};
  if (typeof token !== "string" || token.length < 20 || token.length > 200) {
    return res.status(400).json({ error: "Ce lien est invalide ou a expiré." });
  }
  const userId = await consumeAuthToken(token, "verify");
  if (!userId) {
    return res.status(400).json({ error: "Ce lien est invalide ou a expiré. Demande un nouvel e-mail depuis l'application." });
  }
  await run("UPDATE users SET email_verified = 1 WHERE id = ?", [userId]);
  res.json({ ok: true });
});
