import OpenAI from "openai";
import { z } from "zod";
import { readFile } from "./storage.js";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_IMAGES = 12;
const MAX_SECTIONS = 40;
const CHUNK_CHARS = 18_000;
const MAX_TEXT_CHARS = 110_000;
const MAX_OUTPUT_TOKENS = 12_000;

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
- EXHAUSTIVITÉ ABSOLUE : la fiche doit couvrir TOUT le cours, sans exception. Chaque définition, propriété, théorème, règle, loi, formule, date, nom propre, chiffre, exemple, méthode, cas particulier, exception et remarque du cours doit apparaître dans la fiche. Tu peux condenser la FORME (phrases courtes, listes), jamais le FOND : ne supprime, ne fusionne et n'omet aucune information. En cas de doute, garde l'information.
- Reste fidèle au cours : n'invente aucun fait, chiffre, date ou formule absent du document. Tu peux reformuler et clarifier, pas ajouter.
- Respecte l'ordre logique du cours. Découpe finement : une section = UNE notion, UN événement, UNE définition, UNE formule ou UNE méthode, avec toutes ses précisions (dates, chiffres, noms) dans la section.
- Vise 15 à 30 sections pour un cours riche (jamais moins de 8 sauf cours très court), jusqu'à 40 si nécessaire pour tout couvrir.
- Chaque "title" fait 2 à 6 mots, jamais une phrase (ex : "Serment du Jeu de paume", "Loi des suspects").
- Adapte le niveau de langage au niveau du cours.

Règles de forme :
- Texte simple uniquement : PAS de markdown (pas de **, #, tableaux). Pour une liste, une ligne par élément commençant par "- ". Sépare les paragraphes par une ligne vide.
- Écris les formules de façon lisible en texte brut (ex : "E = m × c²", "x₁ + x₂ = -b/a").
- "title" : titre court (< 70 caractères). "summary" : 2-3 phrases qui tutoient l'élève ("Dans ce cours, tu vois...").
- Ne fais JAMAIS une section par phrase : plusieurs lignes "- ..." ou un court paragraphe par section.

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
Termine TOUJOURS par une section "key_point" intitulée "À retenir" qui rappelle les 4 à 8 points les plus importants (en plus de, et non à la place de, tout le reste).`;

const AUDIT_PROMPT = `Tu contrôles une fiche de révision par rapport au cours d'origine, pour vérifier qu'elle n'oublie RIEN.
Parcours le cours PHRASE PAR PHRASE et, pour chacune, vérifie que chaque information qu'elle contient figure dans la fiche : y compris les exemples, les noms entre parenthèses ou après « comme », les noms d'impôts, de lieux, de personnes, d'œuvres et les chiffres.
Procède ensuite en deux temps :
1) Dresse la liste "missing" des éléments PRÉCIS du cours qui sont totalement ABSENTS de la fiche (un élément = une définition, propriété, théorème, règle, formule, date, nom propre, chiffre, exemple, méthode, cas particulier ou exception, cité en quelques mots). Ne liste PAS ce qui est déjà présent, même formulé autrement. Si la fiche est déjà complète, "missing" est vide : c'est le cas le plus fréquent pour une bonne fiche.
2) Pour ces éléments manquants UNIQUEMENT, écris de nouvelles sections dans "sections" (texte simple, pas de markdown, listes "- ", en français, sans rien inventer). Regroupe-les PAR THÈME dans peu de sections. Chaque section a un "title" de 2 à 6 mots (jamais vide, jamais une phrase) et un "content". Si "missing" est vide, "sections" doit être vide.
Types autorisés : "notion" | "definition" | "formula" | "example" | "common_mistake" | "date" | "concept" | "method".
Réponds UNIQUEMENT avec {"missing": string[], "sections": [...]}.`;

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

type UserContent = string | OpenAI.Chat.ChatCompletionContentPart[];

// Un JSON malformé est rare mais arrive : on retente une fois avant d'abandonner.
async function completeJson<T>(
  system: string,
  user: UserContent,
  parse: (raw: string | null | undefined) => T,
): Promise<T> {
  const openai = getClient();
  for (let attempt = 1; ; attempt++) {
    try {
      const completion = await openai.chat.completions.create({
        model: MODEL,
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      const choice = completion.choices[0];
      if (choice?.finish_reason === "length") {
        throw new AiGenerationError("Ce cours est trop dense pour une seule fiche. Découpe-le par chapitre.");
      }
      return parse(choice?.message?.content);
    } catch (err) {
      const retryable = err instanceof AiGenerationError && /invalide/.test(err.message);
      if (retryable && attempt < 2) continue;
      throw toFriendlyError(err);
    }
  }
}

const ExtraSectionsSchema = z.object({
  missing: z.array(z.string()).default([]),
  sections: z.array(SectionSchema).default([]),
});

function parseExtraSections(raw: string | null | undefined) {
  if (!raw) throw new AiGenerationError("Réponse IA invalide (vide).");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AiGenerationError("Réponse IA invalide (JSON malformé).");
  }
  const result = ExtraSectionsSchema.safeParse(parsed);
  if (!result.success) throw new AiGenerationError("Réponse IA invalide (schéma inattendu).");
  // Aucune omission déclarée : on ignore d'éventuelles sections superflues.
  return result.data.missing.length > 0 ? result.data.sections : [];
}

function serializeSections(sections: GeneratedSheet["sections"]): string {
  return sections.map((s) => `[${s.type}] ${s.title ?? ""}\n${s.content}`).join("\n\n");
}

// Titre de repli si le modèle n'en a pas donné : les premiers mots de la première ligne.
function fallbackTitle(content: string): string {
  const first = content.split("\n")[0].replace(/^[-•*]\s+/, "").trim();
  const words = first.split(/\s+/).slice(0, 6).join(" ").replace(/[:;,.\s]+$/, "");
  return words || "Complément";
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Écarte les sections déjà présentes (même titre, ou même début de contenu), y compris
// celles ajoutées par un tour précédent : le contrôle a tendance à se répéter.
function withoutDuplicates(candidates: GeneratedSheet["sections"], existing: GeneratedSheet["sections"]) {
  const titles = new Set(existing.map((s) => normalize(s.title ?? "")).filter(Boolean));
  const starts = new Set(existing.map((s) => normalize(s.content).slice(0, 50)));
  const kept: GeneratedSheet["sections"] = [];
  for (const section of candidates) {
    const title = normalize(section.title ?? "");
    const start = normalize(section.content).slice(0, 50);
    if ((title && titles.has(title)) || starts.has(start)) continue;
    if (title) titles.add(title);
    starts.add(start);
    kept.push(section);
  }
  return kept;
}

const AUDIT_ROUNDS = 2;

// Passes de contrôle : un appel compare le cours à la fiche et ajoute ce qui manque ; un second
// tour rattrape ce que le premier a laissé passer. Un échec ici ne doit jamais faire perdre la
// fiche déjà générée.
async function withCoverageAudit(source: OpenAI.Chat.ChatCompletionContentPart[], draft: GeneratedSheet): Promise<GeneratedSheet> {
  let sheet = draft;
  for (let round = 1; round <= AUDIT_ROUNDS; round++) {
    try {
      const extra = await completeJson(
        AUDIT_PROMPT,
        [
          { type: "text", text: "COURS D'ORIGINE :" },
          ...source,
          { type: "text", text: `FICHE ACTUELLE :\n${serializeSections(sheet.sections)}` },
        ],
        parseExtraSections,
      );
      const missing = withoutDuplicates(
        extra.filter((s) => s.type !== "key_point").map((s) => ({ ...s, title: s.title ?? fallbackTitle(s.content) })),
        sheet.sections,
      ).slice(0, 15);
      if (missing.length === 0) break;
      const body = sheet.sections.filter((s) => s.type !== "key_point");
      const keys = sheet.sections.filter((s) => s.type === "key_point");
      sheet = { ...sheet, sections: [...body, ...missing, ...keys].slice(0, MAX_SECTIONS) };
    } catch (err) {
      console.error("Passe de contrôle ignorée:", (err as Error)?.message);
      break;
    }
  }
  return sheet;
}

async function buildSheet(systemPrompt: string, source: OpenAI.Chat.ChatCompletionContentPart[]): Promise<GeneratedSheet> {
  const draft = await completeJson(systemPrompt, source, parseSheetResponse);
  return withCoverageAudit(source, draft);
}

// Coupe un long cours aux frontières de paragraphes pour que rien ne soit tronqué.
function splitIntoChunks(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const paragraph of text.split(/\n{2,}/)) {
    if (current && current.length + paragraph.length + 2 > CHUNK_CHARS) push();
    if (paragraph.length > CHUNK_CHARS) {
      for (let i = 0; i < paragraph.length; i += CHUNK_CHARS) {
        current = paragraph.slice(i, i + CHUNK_CHARS);
        push();
      }
      continue;
    }
    current += (current ? "\n\n" : "") + paragraph;
  }
  push();
  return chunks;
}

const TitleSummarySchema = z.object({ title: z.string().trim().min(1), summary: z.string().trim() });

export async function generateRevisionSheet(courseText: string): Promise<GeneratedSheet> {
  if (!process.env.OPENAI_API_KEY) {
    return generateLocalSheet(courseText);
  }
  const text = courseText.replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT_CHARS);
  const chunks = splitIntoChunks(text);

  if (chunks.length <= 1) {
    return buildSheet(SYSTEM_PROMPT, [{ type: "text", text }]);
  }

  // Long cours : chaque partie est traitée intégralement (fiche + contrôle), puis fusionnée.
  const parts = await Promise.all(
    chunks.map((chunk, index) =>
      buildSheet(
        `${SYSTEM_PROMPT}\n\nCe texte est la partie ${index + 1}/${chunks.length} d'un cours plus long : traite UNIQUEMENT cette partie, de façon exhaustive.`,
        [{ type: "text", text: chunk }],
      ),
    ),
  );

  const body = parts.flatMap((p) => p.sections.filter((s) => s.type !== "key_point"));
  const keyPoints = parts.flatMap((p) => p.sections.filter((s) => s.type === "key_point"));
  const merged: GeneratedSheet["sections"] = [...body];
  if (keyPoints.length > 0) {
    merged.push({ type: "key_point", title: "À retenir", content: keyPoints.map((k) => k.content).join("\n") });
  }

  const overview = await completeJson(
    'Tu reçois la liste des sections d\'une fiche de révision. Réponds UNIQUEMENT avec {"title": string (titre court du cours, < 70 caractères), "summary": string (2-3 phrases qui tutoient l\'élève : "Dans ce cours, tu vois...")}.',
    parts.length > 0 ? merged.map((s) => s.title ?? s.type).join("\n") : "",
    (raw) => {
      const parsed = TitleSummarySchema.safeParse(JSON.parse(raw ?? "{}"));
      if (!parsed.success) throw new AiGenerationError("Réponse IA invalide (titre).");
      return parsed.data;
    },
  ).catch(() => ({ title: parts[0].title, summary: parts[0].summary }));

  return { title: overview.title, summary: overview.summary, sections: merged.slice(0, MAX_SECTIONS) };
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
      ? `Voici ${pages.length} photos, les pages successives d'un même cours. Génère une seule fiche de révision, exhaustive.`
      : "Voici la photo d'un cours. Génère la fiche de révision, exhaustive.";

  return buildSheet(IMAGE_SYSTEM_PROMPT, [{ type: "text", text: introText }, ...imageBlocks]);
}
