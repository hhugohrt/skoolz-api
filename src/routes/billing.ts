import { Router } from "express";
import { getUserById } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { createAuthToken, peekAuthToken } from "../lib/authTokens.js";
import { appUrl } from "../lib/email.js";

export const billingRouter = Router();

// Génère le lien à envoyer à un parent pour qu'il règle l'abonnement à la place de l'élève.
billingRouter.post("/parent-link", requireAuth, async (req, res) => {
  const token = await createAuthToken(req.userId!, "parent_pay");
  res.json({ url: `${appUrl()}/pay/${token}` });
});

// Page publique du parent : ne révèle que le prénom de l'élève.
billingRouter.get("/parent/:token", async (req, res) => {
  const token = req.params.token;
  const userId = /^[a-f0-9]{64}$/.test(token) ? await peekAuthToken(token, "parent_pay") : null;
  const user = userId ? await getUserById(userId) : undefined;
  if (!user) {
    return res.status(404).json({ error: "Ce lien n'est plus valide. Demande à ton enfant d'en générer un nouveau." });
  }
  res.json({ firstName: user.first_name });
});
