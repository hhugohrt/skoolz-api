import { Router } from "express";
import { getUserById, queryOne, run } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { createAuthToken, peekAuthToken } from "../lib/authTokens.js";
import { appUrl } from "../lib/email.js";
import { isPremium } from "../lib/billing.js";
import { createCheckout, isPlanId, isWhopConfigured, verifyWebhook, WhopError, type PlanId } from "../lib/whop.js";

export const billingRouter = Router();

async function startCheckout(userId: string, plan: PlanId, redirectUrl: string, payer: "student" | "parent") {
  const { checkoutId, url } = await createCheckout({ plan, userId, redirectUrl, payer });
  await run("INSERT INTO checkouts (id, user_id, plan, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", [
    checkoutId,
    userId,
    plan,
    new Date().toISOString(),
  ]);
  return { url, sessionId: checkoutId };
}

// L'élève s'abonne lui-même : renvoie l'adresse de la page de paiement Whop.
billingRouter.post("/checkout", requireAuth, async (req, res) => {
  const plan = req.body?.plan;
  if (!isPlanId(plan)) return res.status(400).json({ error: "Formule invalide." });
  if (!isWhopConfigured()) return res.status(503).json({ error: "Le paiement n'est pas encore disponible." });

  const user = await getUserById(req.userId!);
  if (isPremium(user)) return res.status(409).json({ error: "Tu es déjà abonné." });

  try {
    res.json(await startCheckout(req.userId!, plan, `${appUrl()}/app/courses?paid=1`, "student"));
  } catch (err) {
    if (err instanceof WhopError) return res.status(502).json({ error: err.message });
    throw err;
  }
});

// Génère le lien à envoyer à un parent pour qu'il règle l'abonnement à la place de l'élève.
billingRouter.post("/parent-link", requireAuth, async (req, res) => {
  const token = await createAuthToken(req.userId!, "parent_pay");
  res.json({ url: `${appUrl()}/pay/${token}` });
});

async function parentUser(token: string) {
  const userId = /^[a-f0-9]{64}$/.test(token) ? await peekAuthToken(token, "parent_pay") : null;
  return userId ? await getUserById(userId) : undefined;
}

const INVALID_LINK = "Ce lien n'est plus valide. Demande à ton enfant d'en générer un nouveau.";

// Page publique du parent : ne révèle que le prénom de l'élève.
billingRouter.get("/parent/:token", async (req, res) => {
  const user = await parentUser(req.params.token);
  if (!user) return res.status(404).json({ error: INVALID_LINK });
  res.json({ firstName: user.first_name, alreadyPremium: isPremium(user) });
});

billingRouter.post("/parent/:token/checkout", async (req, res) => {
  const plan = req.body?.plan;
  if (!isPlanId(plan)) return res.status(400).json({ error: "Formule invalide." });
  const user = await parentUser(req.params.token);
  if (!user) return res.status(404).json({ error: INVALID_LINK });
  if (isPremium(user)) return res.status(409).json({ error: `${user.first_name} est déjà abonné(e).` });
  if (!isWhopConfigured()) return res.status(503).json({ error: "Le paiement n'est pas encore disponible." });

  try {
    res.json(await startCheckout(user.id, plan, `${appUrl()}/pay/${req.params.token}?paid=1`, "parent"));
  } catch (err) {
    if (err instanceof WhopError) return res.status(502).json({ error: err.message });
    throw err;
  }
});

interface WhopEvent {
  type?: string;
  data?: {
    id?: string;
    checkout_configuration_id?: string | null;
    membership?: { id?: string } | null;
    metadata?: { user_id?: unknown } | null;
  };
}

// Webhook Whop (corps brut, voir app.ts) : paiement réussi → abonné, abonnement terminé → gratuit.
billingRouter.post("/webhook", async (req, res) => {
  const raw = req.body as Buffer;
  if (!Buffer.isBuffer(raw) || !verifyWebhook(raw, req.headers)) {
    return res.status(400).json({ error: "Signature invalide." });
  }

  let event: WhopEvent;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Corps invalide." });
  }
  const data = event.data ?? {};

  if (event.type === "payment.succeeded") {
    // L'élève est retrouvé par la session de paiement que nous avons créée, sinon par les métadonnées.
    let userId: string | undefined;
    if (data.checkout_configuration_id) {
      userId = (await queryOne<{ user_id: string }>("SELECT user_id FROM checkouts WHERE id = ?", [data.checkout_configuration_id]))?.user_id;
    }
    if (!userId && typeof data.metadata?.user_id === "string") {
      userId = (await getUserById(data.metadata.user_id))?.id;
    }
    if (!userId) {
      console.error("Webhook Whop: paiement sans élève identifiable", data.id);
      return res.json({ received: true });
    }
    await run("UPDATE users SET plan = 'premium', whop_membership_id = COALESCE(?, whop_membership_id) WHERE id = ?", [
      data.membership?.id ?? null,
      userId,
    ]);
  } else if (event.type === "membership.deactivated" && data.id) {
    await run("UPDATE users SET plan = 'free' WHERE whop_membership_id = ?", [data.id]);
  }

  res.json({ received: true });
});
