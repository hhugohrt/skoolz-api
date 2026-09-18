import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

// Sans JWT_SECRET en production, n'importe qui connaîtrait le secret par défaut et pourrait forger
// des sessions : on refuse de démarrer plutôt que de tourner avec une valeur publique.
const isProduction = process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
const JWT_SECRET = process.env.JWT_SECRET ?? (isProduction ? "" : "dev-secret-change-me");
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET est requis en production.");
}

export function hashPassword(password: string) {
  return bcrypt.hash(password, 10);
}

export function comparePassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function signToken(userId: string) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: "30d" });
}

export function verifyToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string };
    return payload.sub;
  } catch {
    return null;
  }
}
