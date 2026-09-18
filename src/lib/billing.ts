import type { DbUser } from "../db.js";

// Adresses (séparées par des virgules) traitées comme abonnées sans paiement : le propriétaire, les testeurs.
function premiumEmails(): Set<string> {
  return new Set(
    (process.env.PREMIUM_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isPremium(user: Pick<DbUser, "plan" | "email"> | undefined): boolean {
  if (!user) return false;
  return user.plan === "premium" || premiumEmails().has(user.email.toLowerCase());
}

// Remplace chaque lettre/chiffre par « x » en gardant espaces et retours à la ligne : la mise en page reste
// fidèle pour l'aperçu flouté, mais le vrai contenu ne quitte jamais le serveur pour un compte gratuit.
export function maskText(text: string): string {
  return text.replace(/[\p{L}\p{N}]/gu, "x");
}
