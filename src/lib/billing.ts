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

// Mots de remplissage : l'aperçu flouté ressemble à un vrai cours, mais le contenu réel ne quitte jamais
// le serveur pour un compte gratuit. Chaque mot garde sa longueur, espaces et retours à la ligne sont conservés.
const FILLER = [
  "cours", "notion", "exemple", "methode", "propriete", "definition", "resultat", "theoreme", "important",
  "chapitre", "relation", "fonction", "etape", "systeme", "rappel", "forme", "valeur", "regle", "point",
  "cause", "effet", "schema", "lecture", "exercice", "principe", "analyse", "sens", "cadre", "usage", "terme",
];

export function maskText(text: string): string {
  let n = 0;
  return text.replace(/[\p{L}\p{N}]+/gu, (word) => {
    const base = FILLER[(n++ * 7 + word.length) % FILLER.length];
    return (base + base).slice(0, word.length);
  });
}
