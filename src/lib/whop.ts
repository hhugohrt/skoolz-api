import { createHmac, timingSafeEqual } from "node:crypto";

export type PlanId = "monthly" | "yearly";

const API_BASE = "https://api.whop.com/api/v1";

function planIdFor(plan: PlanId): string | undefined {
  return plan === "monthly" ? process.env.WHOP_PLAN_MONTHLY : process.env.WHOP_PLAN_YEARLY;
}

export function isWhopConfigured(): boolean {
  return Boolean(process.env.WHOP_API_KEY && process.env.WHOP_PLAN_MONTHLY && process.env.WHOP_PLAN_YEARLY);
}

export function isPlanId(value: unknown): value is PlanId {
  return value === "monthly" || value === "yearly";
}

export class WhopError extends Error {}

// Crée une session de paiement Whop pour l'abonnement choisi et renvoie l'adresse de la page de paiement.
// L'identifiant de session (ch_…) sert à retrouver l'élève quand le webhook de paiement arrive.
export async function createCheckout(opts: {
  plan: PlanId;
  userId: string;
  redirectUrl: string;
  payer: "student" | "parent";
}): Promise<{ checkoutId: string; url: string }> {
  const planId = planIdFor(opts.plan);
  if (!process.env.WHOP_API_KEY || !planId) throw new WhopError("Whop n'est pas configuré.");

  const response = await fetch(`${API_BASE}/checkout_configurations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHOP_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      plan_id: planId,
      redirect_url: opts.redirectUrl,
      metadata: { user_id: opts.userId, payer: opts.payer },
    }),
  });
  if (!response.ok) {
    console.error("Whop a refusé la création du paiement:", response.status, (await response.text()).slice(0, 300));
    throw new WhopError("Impossible de démarrer le paiement pour le moment.");
  }

  const body = (await response.json()) as { id?: string; purchase_url?: string };
  if (!body.id || !body.purchase_url) throw new WhopError("Réponse de paiement inattendue.");
  const url = body.purchase_url.startsWith("http") ? body.purchase_url : `https://whop.com${body.purchase_url}`;
  return { checkoutId: body.id, url };
}

// Signature Whop : HMAC-SHA256 en base64 de « {webhook-id}.{webhook-timestamp}.{corps brut} », en-tête « v1,<signature> ».
export function verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
  const secret = process.env.WHOP_WEBHOOK_SECRET;
  const one = (name: string) => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const id = one("webhook-id");
  const timestamp = one("webhook-timestamp");
  const signature = one("webhook-signature");
  if (!secret || !id || !timestamp || !signature) return false;

  // Rejette les envois vieux de plus de 5 minutes (rejeu).
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;

  const expected = createHmac("sha256", secret).update(`${id}.${timestamp}.`).update(rawBody).digest();
  return signature.split(" ").some((part) => {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
