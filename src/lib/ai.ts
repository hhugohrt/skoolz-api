import OpenAI from "openai";
import { z } from "zod";
import { readFile } from "./storage.js";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_IMAGES = 12;
const MAX_SECTIONS = 20;

// Un type de section inattendu ne doit pas faire échouer toute la fiche : on le
// rabat sur "notion" plutôt que de rejeter la réponse (et de facturer un appel pour rien).
const SectionSchema = z.object({
  type: z
    .enum(["notion", "definition", "formula", "example", "key_point", "common_mistake", "date", "concept", "method"])
    .catch("notion"),
  title: z.string().nullish().transform((v) => v?.trim() || undefined),
  content: z.string().trim().min(1),
});

const SheetSchema = z.object({
  title: z.string().trim().min(1),
  summary: z.string().trim(),
  sections: z.array(SectionSchema).min(1).transform((s) => s.slice(0, MAX_SECTIONS)),
});

export type GeneratedSheet = z.infer<typeof SheetSchema>;

export class AiNotConfiguredError extends Error {}
export class AiGenerationError extends Error {}

const SYSTEM_PROMPT = `Tu es l'assistant pédagogique de SKOOLZ, une app de révisions pour élèves (de la 3e au supérieur).
On te donne un cours. Transforme-le en fiche de révision claire, structurée et mémorisable, en français.

Règles de fond :
- Reste fidèle au cours : n'invente aucun fait, chiffre, date ou formule absent du document. Tu peux reformuler et clarifier, pas ajouter.
- Sois synthétique : phrases courtes, idées séparées, pas de remplissage. Vise une fiche qu'on relit en 5 minutes.
- Respecte l'ordre logique du cours. Regroupe les idées proches dans une même section.
- Adapte le niveau de langage au niveau du cours.

Règles de forme :
- Texte simple uniquement : PAS de markdown (pas de **, #, tableaux). Pour une liste, une ligne par élément commençant par "- ". Sépare les paragraphes par une ligne vide.
- Écris les formules de façon lisible en texte brut (ex : "E = m × c²", "x₁ + x₂ = -b/a").
- "title" : titre court (< 70 caractères). "summary" : 2-3 phrases qui tutoient l'élève ("Dans ce cours, tu vois...").
- Entre 3 et 8 sections selon la richesse du cours. Une section = UNE idée complète : regroupe les phrases qui parlent du même sujet (plusieurs lignes "- ..." ou un court paragraphe), ne fais JAMAIS une section par phrase.
- Chaque section a un "title" court et parlant (ex : "Où ça se passe", "Équation bilan"), sauf éventuellement une définition très courte.

Réponds UNIQUEMENT avec un objet JSON respectant exactement ce schéma :
{
  "title": string,
  "summary": string,
  "sections": [
    {
      "type": "notion" | "definition" | "formula" | "example" | "key_point" | "common_mistake" | "date" | "concept" | "method",
      "title": string (court, parlant),
      "content": string
    }
  ]
}

Choix des types : "definition" pour un terme défini, "formula" pour une formule/loi, "method" pour une démarche pas à pas, "example" pour un exemple traité, "date" pour une chronologie, "concept" pour une idée abstraite, "notion" par défaut, "common_mistake" pour un piège classique à éviter. N'utilise que les types pertinents pour ce cours (pas de formule dans un cours d'histoire).
Termine TOUJOURS par une section "key_point" intitulée "À retenir" qui liste les 3 à 6 points essentiels.`;

const IMAGE_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

Le cours t'est fourni en photos : manuscrit ou imprimé, parfois de travers, mal éclairé ou partiellement flou. Lis-les du mieux possible. Si un passage est vraiment illisible, ignore-le plutôt que d'inventer. Si plusieurs photos sont fournies, ce sont les pages successives d'un même cours : combine-les en UNE seule fiche cohérente, sans doublons, dans l'ordre. Si les photos ne montrent manifestement pas un cours, renvoie une fiche avec une seule section "notion" expliquant que le contenu n'est pas exploitable.`;

let client: OpenAI | null = null;

/**
 * Fallback volontairement simple pour le mode local. Il ne prétend pas être une
 * IA : il découpe le texte fourni afin que le parcours import → fiche reste
 * testable avant la configuration d'OPENAI_API_KEY.
 */
function generateLocalSheet(courseText: string): GeneratedSheet {
  const cleaned = courseText.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  const blocks = cleaned.split(/\n\s*\n/).filter((block) => block.trim().length > 0);
  const lines = cleaned.split("\n").map((line) => line.trim()).filter(Boolean);
  const title = lines[0]?.replace(/^#\s*/, "").slice(0, 90) || "Fiche de révision";
  const body = blocks.length > 1 ? blocks.slice(1) : [cleaned];
  const sections = body.slice(0, 6).map((content, index) => ({
    type: index === body.length - 1 ? "key_point" as const : "notion" as const,
    title: index === body.length - 1 ? "À retenir" : `Notion ${index + 1}`,
    content: content.slice(0, 1_200),
  }));

  if (!sections.some((section) => section.type === "key_point")) {
    sections.push({ type: "key_point", title: "À retenir", content: lines.slice(0, 5).join("\n") });
  }

  return {
    title,
    summary: "Fiche générée en mode local à partir de ton cours. Ajoute une clé IA pour une synthèse plus fine.",
    sections: sections.length > 0 ? sections : [{ type: "key_point", title: "À retenir", content: cleaned }],
  };
}

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new AiNotConfiguredError(
      "Clé API IA manquante. Ajoute OPENAI_API_KEY dans le fichier .env du serveur.",
    );
  }
  if (!client) {
    // timeout : mieux vaut échouer proprement qu'atteindre la limite de la fonction serverless.
    client = new OpenAI({ apiKey, timeout: 90_000, maxRetries: 2 });
  }
  return client;
}

function parseSheetResponse(raw: string | null | undefined): GeneratedSheet {
  if (!raw) {
    throw new AiGenerationError("L'IA n'a renvoyé aucun contenu.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AiGenerationError("Réponse IA invalide (JSON malformé).");
  }

  const result = SheetSchema.safeParse(parsed);
  if (!result.success) {
    throw new AiGenerationError("Réponse IA invalide (schéma inattendu).");
  }

  return result.data;
}

// Traduit les erreurs de l'API OpenAI en messages compréhensibles (le SDK a déjà
// retenté les erreurs réseau / 429 / 5xx transitoires avant d'arriver ici).
function toFriendlyError(err: unknown): Error {
  if (err instanceof AiGenerationError || err instanceof AiNotConfiguredError) return err;
  const status = (err as { status?: number })?.status;
  const code = (err as { code?: string })?.code;
  if (status === 401) return new AiNotConfiguredError("La clé API IA est invalide ou révoquée.");
  if (code === "insufficient_quota" || /quota|billing|credit/i.test(String((err as Error)?.message))) {
    return new AiNotConfiguredError("Le crédit du compte IA est épuisé. Recharge-le pour continuer à générer des fiches.");
  }
  if (status === 429) console.error("OpenAI 429:", code, (err as Error)?.message);
  if (status === 429) return new AiGenerationError("L'IA est très sollicitée en ce moment. Réessaie dans une minute.");
  if (status === 400 && /image/i.test(String((err as Error).message))) {
    return new AiGenerationError("Une des photos n'a pas pu être lue. Reprends-la plus nettement et réessaie.");
  }
  if ((err as Error)?.name === "APIConnectionTimeoutError") {
    return new AiGenerationError("La génération a pris trop de temps. Réessaie, ou envoie moins de pages à la fois.");
  }
  console.error("Erreur OpenAI:", status, code, (err as Error)?.message);
  return err instanceof Error ? err : new Error(String(err));
}

// Un JSON malformé est rare mais arrive : on retente une fois avant d'abandonner.
async function completeSheet(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): Promise<GeneratedSheet> {
  const openai = getClient();
  for (let attempt = 1; ; attempt++) {
    try {
      const completion = await openai.chat.completions.create({
        model: MODEL,
        response_format: { type: "json_object" },
        temperature: 0.3,
        max_tokens: 4_000,
        messages,
      });
      const choice = completion.choices[0];
      if (choice?.finish_reason === "length") {
        throw new AiGenerationError("Le cours est trop long pour être résumé en une seule fiche. Découpe-le par chapitre.");
      }
      return parseSheetResponse(choice?.message?.content);
    } catch (err) {
      const retryable = err instanceof AiGenerationError && /invalide/.test(err.message);
      if (retryable && attempt < 2) continue;
      throw toFriendlyError(err);
    }
  }
}

export async function generateRevisionSheet(courseText: string): Promise<GeneratedSheet> {
  if (!process.env.OPENAI_API_KEY) {
    return generateLocalSheet(courseText);
  }
  const truncated = courseText.replace(/\n{3,}/g, "\n\n").trim().slice(0, 40_000);

  return completeSheet([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: truncated },
  ]);
}

export interface ImageInput {
  path: string;
  mimeType: string;
}

export async function generateRevisionSheetFromImages(images: ImageInput[]): Promise<GeneratedSheet> {
  if (!process.env.OPENAI_API_KEY) {
    throw new AiNotConfiguredError(
      "L'analyse de photos nécessite une clé IA. Importe un fichier texte, PDF ou DOCX pour tester le mode local.",
    );
  }
  const pages = images.slice(0, MAX_IMAGES);

  const imageBlocks = await Promise.all(
    pages.map(async ({ path: storagePath, mimeType }) => {
      // En prod les photos sont sur Vercel Blob (URL publique) : OpenAI les télécharge lui-même,
      // ce qui évite de les rapatrier dans la fonction puis de les regonfler en base64 (+33 %).
      // En local, le fichier est sur disque : on l'envoie en data URL.
      const url = /^https?:\/\//.test(storagePath)
        ? storagePath
        : `data:${mimeType};base64,${(await readFile(storagePath)).toString("base64")}`;
      return { type: "image_url" as const, image_url: { url, detail: "high" as const } };
    }),
  );

  const introText =
    pages.length > 1
      ? `Voici ${pages.length} photos, les pages successives d'un même cours. Génère une seule fiche de révision.`
      : "Voici la photo d'un cours. Génère la fiche de révision.";

  return completeSheet([
    { role: "system", content: IMAGE_SYSTEM_PROMPT },
    { role: "user", content: [{ type: "text", text: introText }, ...imageBlocks] },
  ]);
}

// ---------------------------------------------------------------------------
// Fiche visuelle : le texte de la fiche est mis en page en image(s) par l'API d'images.
// ---------------------------------------------------------------------------

const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
const IMAGE_QUALITY = (process.env.OPENAI_IMAGE_QUALITY || "medium") as "low" | "medium" | "high";
const MAX_IMAGE_PAGES = 4;
const CHARS_PER_PAGE = 1_300;

const SECTION_LABELS: Record<string, string> = {
  notion: "Notion",
  definition: "Définition",
  formula: "Formule",
  example: "Exemple",
  key_point: "À retenir",
  common_mistake: "Erreur fréquente",
  date: "Date",
  concept: "Concept",
  method: "Méthode",
};

// Répartit les sections en pages d'image lisibles (au-delà, un texte trop dense devient illisible
// une fois rendu en image). La fiche texte, elle, reste complète.
function paginateSections(sheet: GeneratedSheet): GeneratedSheet["sections"][] {
  const pages: GeneratedSheet["sections"][] = [];
  let current: GeneratedSheet["sections"] = [];
  let size = 0;
  for (const section of sheet.sections) {
    const len = section.content.length + (section.title?.length ?? 0) + 20;
    if (current.length > 0 && size + len > CHARS_PER_PAGE) {
      pages.push(current);
      current = [];
      size = 0;
    }
    current.push(section);
    size += len;
  }
  if (current.length > 0) pages.push(current);
  return pages.slice(0, MAX_IMAGE_PAGES);
}

function buildImagePrompt(sheet: GeneratedSheet, sections: GeneratedSheet["sections"], page: number, total: number) {
  const blocks = sections
    .map((s) => `[${SECTION_LABELS[s.type] ?? s.type}]${s.title ? ` ${s.title}` : ""}\n${s.content}`)
    .join("\n\n");
  const header = page === 1 ? `Title: "${sheet.title}"\nSubtitle (summary): "${sheet.summary}"\n\n` : "";
  return `Design ONE portrait revision sheet ("fiche de révision") for a French student, as a clean, modern, well-organized infographic study card.

Visual style: white / very light background, primary color violet (#6d4aff) with soft blue-to-purple accents, rounded cards, one card per section with a small colored label tag (the bracketed label), clear typographic hierarchy, generous spacing, flat vector look. Formulas in a highlighted box. The "À retenir" section, if present, in an emphasized box. No photos, no watermark, no decorative text other than the content.
${total > 1 ? `This is page ${page} of ${total}; keep the same style on every page and write "${page}/${total}" small in a corner.` : ""}

CRITICAL: all text must be in French and rendered EXACTLY as written below, with correct spelling and accents, fully legible, nothing cut off. Do not add, translate or invent any text.

${header}${blocks}`;
}

export async function generateSheetImages(sheet: GeneratedSheet): Promise<Buffer[]> {
  const openai = getClient();
  const pages = paginateSections(sheet);

  try {
    return await Promise.all(
      pages.map(async (sections, index) => {
        const result = await openai.images.generate(
          {
            model: IMAGE_MODEL,
            prompt: buildImagePrompt(sheet, sections, index + 1, pages.length),
            size: "1024x1536",
            quality: IMAGE_QUALITY,
            n: 1,
          } as Parameters<typeof openai.images.generate>[0],
          { timeout: 240_000 },
        );
        const b64 = (result as { data?: { b64_json?: string }[] }).data?.[0]?.b64_json;
        if (!b64) throw new AiGenerationError("L'IA n'a renvoyé aucune image.");
        return Buffer.from(b64, "base64");
      }),
    );
  } catch (err) {
    const status = (err as { status?: number })?.status;
    const message = String((err as Error)?.message ?? "");
    if (status === 403 || /verif/i.test(message)) {
      throw new AiNotConfiguredError(
        "La génération d'images demande de vérifier ton organisation OpenAI (platform.openai.com → Settings → Organization → Verify).",
      );
    }
    if (status === 400 && /safety|moderation|content/i.test(message)) {
      throw new AiGenerationError("L'image a été refusée par la modération d'OpenAI. Réessaie ou utilise la fiche texte.");
    }
    throw toFriendlyError(err);
  }
}
