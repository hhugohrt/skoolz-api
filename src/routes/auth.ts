import { Router } from "express";
import { v4 as uuid } from "uuid";
import { comparePassword, hashPassword, signToken } from "../auth.js";
import { run, getUserByEmail, sanitizeUser } from "../db.js";

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
