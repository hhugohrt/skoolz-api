import { randomBytes } from "node:crypto";
import { Router } from "express";
import { v4 as uuid } from "uuid";
import { comparePassword, hashPassword, signToken } from "../auth.js";
import { run, queryOne, getUserByEmail, sanitizeUser, type DbUser } from "../db.js";

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
    "INSERT INTO users (id, email, first_name, password_hash, theme, onboarding_completed, created_at) VALUES (?, ?, ?, ?, 'auto', 0, ?)",
    [id, normalizedEmail, firstName.trim(), passwordHash, createdAt],
  );

  const user = (await getUserByEmail(normalizedEmail))!;
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
        await run("UPDATE users SET google_sub = ? WHERE id = ?", [profile.sub, user.id]);
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
