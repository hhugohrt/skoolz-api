import type { NextFunction, Request, Response } from "express";
import { getUserById, type DbUser } from "../db.js";

// Administrateurs : adresses (séparées par des virgules) dans ADMIN_EMAILS. L'adresse doit aussi être confirmée,
// pour qu'on ne puisse pas devenir admin en s'inscrivant avec l'adresse du propriétaire avant lui.
function adminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAdmin(user: Pick<DbUser, "email" | "email_verified"> | undefined): boolean {
  if (!user || !user.email_verified) return false;
  return adminEmails().has(user.email.toLowerCase());
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = await getUserById(req.userId!);
  if (!isAdmin(user)) return res.status(403).json({ error: "Accès réservé aux administrateurs." });
  next();
}
