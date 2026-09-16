import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "../auth.js";
import { getUserById } from "../db.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Non authentifié." });
  }

  const userId = verifyToken(token);
  if (!userId || !(await getUserById(userId))) {
    return res.status(401).json({ error: "Session invalide." });
  }

  req.userId = userId;
  next();
}
