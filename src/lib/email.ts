// Envoi d'e-mails transactionnels via Resend (API HTTP, aucune dépendance).
// Sans RESEND_API_KEY / EMAIL_FROM, rien n'est envoyé : on le signale dans les logs et la fonction renvoie false.

export function appUrl(): string {
  return (process.env.APP_URL || process.env.PUBLIC_URL || process.env.FRONTEND_URL || "http://localhost:5220").replace(/\/$/, "");
}

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function sendEmail(message: { to: string; subject: string; html: string; text: string }): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) {
    console.warn(`[e-mail non configuré] « ${message.subject} » n'a pas été envoyé à ${message.to}`);
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [message.to], subject: message.subject, html: message.html, text: message.text }),
    });
    if (!res.ok) {
      console.error("Resend a refusé l'envoi:", res.status, await res.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (err) {
    console.error("Envoi d'e-mail impossible:", (err as Error)?.message);
    return false;
  }
}

function layout(title: string, intro: string, buttonLabel: string, url: string, outro: string): string {
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#f8f8fa;font-family:Arial,Helvetica,sans-serif;color:#111114">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;padding:32px">
<tr><td style="font-size:22px;font-weight:800;color:#6d4aff;padding-bottom:16px">skoolz</td></tr>
<tr><td style="font-size:20px;font-weight:700;padding-bottom:12px">${escapeHtml(title)}</td></tr>
<tr><td style="font-size:15px;line-height:1.6;color:#444;padding-bottom:24px">${intro}</td></tr>
<tr><td style="padding-bottom:24px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#6d4aff;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 26px;border-radius:12px">${escapeHtml(buttonLabel)}</a></td></tr>
<tr><td style="font-size:13px;line-height:1.6;color:#777">${outro}<br><br>Si le bouton ne fonctionne pas, copie ce lien dans ton navigateur :<br><span style="word-break:break-all;color:#6d4aff">${escapeHtml(url)}</span></td></tr>
</table></td></tr></table></body></html>`;
}

export function verificationEmail(to: string, firstName: string, url: string) {
  const name = escapeHtml(firstName);
  return {
    to,
    subject: "Confirme ton adresse e-mail — Skoolz",
    html: layout(
      "Confirme ton adresse e-mail",
      `Salut ${name}, bienvenue sur Skoolz ! Clique sur le bouton pour confirmer que cette adresse e-mail est bien la tienne.`,
      "Confirmer mon adresse",
      url,
      "Ce lien est valable 24 heures. Si tu n'as pas créé de compte Skoolz, ignore simplement ce message.",
    ),
    text: `Salut ${firstName}, bienvenue sur Skoolz !\n\nConfirme ton adresse e-mail en ouvrant ce lien (valable 24 heures) :\n${url}\n\nSi tu n'as pas créé de compte Skoolz, ignore ce message.`,
  };
}

export function resetEmail(to: string, firstName: string, url: string) {
  const name = escapeHtml(firstName);
  return {
    to,
    subject: "Réinitialise ton mot de passe — Skoolz",
    html: layout(
      "Réinitialise ton mot de passe",
      `Salut ${name}, tu as demandé à changer ton mot de passe Skoolz. Clique sur le bouton pour en choisir un nouveau.`,
      "Choisir un nouveau mot de passe",
      url,
      "Ce lien est valable 1 heure et ne peut servir qu'une fois. Si tu n'es pas à l'origine de cette demande, ignore ce message : ton mot de passe reste inchangé.",
    ),
    text: `Salut ${firstName},\n\nPour choisir un nouveau mot de passe Skoolz, ouvre ce lien (valable 1 heure, usage unique) :\n${url}\n\nSi tu n'es pas à l'origine de cette demande, ignore ce message : ton mot de passe reste inchangé.`,
  };
}
