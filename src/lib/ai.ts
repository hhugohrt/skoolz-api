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
- FICHE SYNTHÉTIQUE MAIS COMPLÈTE : condense la FORME au maximum, ne perds rien du FOND. Chaque définition, propriété, théorème, règle, loi, formule, date, nom propre, chiffre, exemple, méthode, cas particulier et exception du cours doit rester dans la fiche, mais exprimé le plus court possible. En cas de doute sur un détail, garde-le.
- Style TÉLÉGRAPHIQUE : mots-clés et expressions nominales, pas de phrases complètes ni de mots de liaison inutiles ; symboles autorisés (→, =, ≈, +, ≠). Une information = une ligne "- ..." courte (idéalement moins de 90 caractères). Exemple : "- 14 juillet 1789 : prise de la Bastille" et non « Le 14 juillet 1789, les Parisiens prennent la Bastille. »
- La fiche doit être NETTEMENT plus courte que le cours (visée : la moitié ou moins de sa longueur) et jamais plus longue.
- Conserve TOUTES les énumérations et tous les exemples cités dans le cours (noms entre parenthèses ou après « comme », « par exemple », « tels que », « notamment » : impôts, lieux, personnes, œuvres, chiffres...), sous forme de liste. Ne les remplace jamais par une formule générique comme « divers impôts ».
- Reste fidèle au cours : n'invente aucun fait, chiffre, date ou formule absent du document.
- Regroupe par THÈME : une section = un thème ou un chapitre du cours, avec toutes ses informations en liste. Une chronologie se regroupe en une section par période (une ligne par événement), pas une section par événement.
- Vise 5 à 12 sections pour un cours riche (jusqu'à 20 pour un cours très long, 3 minimum pour un cours court).
- Chaque "title" fait 2 à 6 mots, jamais une phrase (ex : "Causes de 1789", "La Terreur").
- Adapte le niveau de langage au niveau du cours.

Règles de forme :
- Texte simple uniquement : PAS de markdown (pas de **, #, tableaux). Pour une liste, une ligne par élément commençant par "- ". Sépare les paragraphes par une ligne vide.
- Écris les formules de façon lisible en texte brut (ex : "E = m × c²", "x₁ + x₂ = -b/a").
- "title" : titre court (< 70 caractères). "summary" : 1 à 2 phrases qui tutoient l'élève ("Dans ce cours, tu vois...").
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

Choix des types : "definition" pour un terme défini, "formula" pour une formule/loi, "method" pour une démarche pas à pas, "example" pour un exemple traité, "date" pour une chronologie (une seule section par période, une ligne par événement), "concept" pour une idée abstraite, "notion" par défaut, "common_mistake" pour un piège classique à éviter. N'utilise que les types pertinents pour ce cours (pas de formule dans un cours d'histoire).
Termine TOUJOURS par une section "key_point" intitulée "À retenir" qui rappelle en lignes très courtes les 4 à 6 points les plus importants (en plus de, et non à la place de, le reste).`;

const AUDIT_PROMPT = `Tu contrôles une fiche de révision (synthétique) par rapport au cours d'origine, pour vérifier qu'elle n'oublie RIEN.
Parcours le cours PHRASE PAR PHRASE et, pour chacune, vérifie que chaque information qu'elle contient figure dans la fiche, même sous une forme abrégée : y compris les exemples, les noms entre parenthèses ou après « comme », les noms d'impôts, de lieux, de personnes, d'institutions, d'œuvres, les dates et les chiffres.
Procède ensuite en deux temps :
1) Dresse la liste "missing" des éléments PRÉCIS du cours qui sont totalement ABSENTS de la fiche (cités en quelques mots). Ne liste PAS ce qui est déjà présent, même abrégé ou formulé autrement. Si la fiche est complète, "missing" est vide.
2) Pour ces éléments manquants UNIQUEMENT, renvoie "additions" : une liste d'objets {"section": string, "lines": string[]}. "section" = le titre EXACT de la section existante de la fiche la plus pertinente pour y ajouter ces lignes ; si aucune ne convient, écris "NOUVELLE : " suivi d'un titre de 2 à 6 mots. "lines" = lignes TÉLÉGRAPHIQUES courtes (mots-clés, sans phrase complète, sans tiret initial, sans rien inventer). N'ajoute une ligne QUE si elle apporte une information du cours (un fait, une date, un chiffre, un lien de cause, un nom avec son rôle) : jamais de ligne creuse du type « X : contexte de la Révolution », et rien de ce qui figure déjà dans la fiche, même abrégé. Si "missing" est vide, "additions" doit être vide.
Réponds UNIQUEMENT avec un objet JSON {"missing": string[], "additions": [...]}.`;

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

const AdditionsSchema = z.object({
  missing: z.array(z.string()).default([]),
  additions: z
    .array(z.object({ section: z.string().trim().min(1), lines: z.array(z.string()).default([]) }))
    .default([]),
});

type Addition = z.infer<typeof AdditionsSchema>["additions"][number];

function parseAdditions(raw: string | null | undefined): Addition[] {
  if (!raw) throw new AiGenerationError("Réponse IA invalide (vide).");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AiGenerationError("Réponse IA invalide (JSON malformé).");
  }
  const result = AdditionsSchema.safeParse(parsed);
  if (!result.success) throw new AiGenerationError("Réponse IA invalide (schéma inattendu).");
  // Aucune omission déclarée : on ignore d'éventuelles additions superflues.
  return result.data.missing.length > 0 ? result.data.additions : [];
}

function serializeSections(sections: GeneratedSheet["sections"]): string {
  return sections.map((s) => `[${s.type}] ${s.title ?? ""}\n${s.content}`).join("\n\n");
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Chiffres comparés sans espaces de milliers ("17 000" = "17000").
const compactDigits = (value: string) => value.replace(/(\d)[\s\u00a0.](?=\d{3}(?!\d))/g, "$1");

const STOP_TERMS = new Set(["dans", "elle", "cette", "cela", "ainsi", "pour", "avec", "comme", "selon", "mais", "donc", "alors", "puis", "entre", "apres", "avant", "lors", "depuis", "chaque", "toute", "tous", "leur", "leurs", "sont", "vocabulaire", "france", "paris", "parisiens", "francais", "francaise", "francaises"]);

// Termes du cours qu'une bonne fiche doit reprendre : noms propres (majuscule hors début de phrase),
// énumérations introduites par « comme / notamment », années et chiffres. On ne garde que ceux
// qui manquent dans la fiche : ils servent d'indices au contrôle de couverture.
function absentTerms(sourceText: string, sheet: GeneratedSheet): string[] {
  const haystack = compactDigits(normalize(sheet.title + " " + sheet.summary + " " + serializeSections(sheet.sections)));
  const terms = new Set<string>();

  for (const m of sourceText.matchAll(/(?<![.!?:]\s)(?<!^)(?<!\n)\b\p{Lu}[\p{L}'’-]{3,}/gu)) {
    const before = sourceText.slice(Math.max(0, m.index - 3), m.index);
    if (/[.!?:]\s*$/.test(before) || /\n\s*$/.test(before)) continue;
    terms.add(m[0]);
  }
  for (const m of sourceText.matchAll(/(?:comme|notamment|par exemple|tels? que|telles? que)\s+(?:la |le |les |l')?([\p{L}'’-]{4,})/giu)) terms.add(m[1]);
  for (const m of compactDigits(sourceText).matchAll(/\b\d{2,}(?:[.,]\d+)?\s?%?/g)) terms.add(m[0].trim());

  const sourceNorm = compactDigits(normalize(sourceText));
  const occurrences = (t: string) => sourceNorm.split(compactDigits(normalize(t))).length - 1;

  return [...terms]
    .filter((t) => !STOP_TERMS.has(normalize(t)) && occurrences(t) <= 5)
    .filter((t) => !haystack.includes(compactDigits(normalize(t))))
    .slice(0, 40);
}

// Une ligne est déjà couverte si la plupart de ses mots significatifs figurent déjà dans la fiche.
function alreadyCovered(line: string, knownNormalized: string): boolean {
  const words = normalize(line).split(" ").filter((w) => w.length >= 4);
  if (words.length === 0) return true;
  return words.filter((w) => knownNormalized.includes(w)).length / words.length >= 0.6;
}

const cleanLine = (line: string) => line.trim().replace(/^[-•*]\s*/, "");

// Rattache chaque ligne manquante à la section du bon thème (la fiche reste synthétique et
// regroupée), ou crée une section seulement si aucune ne convient. Ignore les lignes déjà présentes.
function applyAdditions(sheet: GeneratedSheet, additions: Addition[]): { sheet: GeneratedSheet; added: number } {
  const sections = sheet.sections.map((s) => ({ ...s }));
  const knownText = normalize(serializeSections(sections));
  let added = 0;

  for (const addition of additions) {
    const lines = addition.lines.map(cleanLine).filter(Boolean);
    if (lines.length === 0) continue;
    const wanted = normalize(addition.section.replace(/^nouvelle\s*:\s*/i, ""));
    const isNew = /^nouvelle\s*:/i.test(addition.section);
    const target = isNew ? undefined : sections.find((s) => s.type !== "key_point" && normalize(s.title ?? "") === wanted);

    if (target) {
      const fresh = lines.filter((l) => !alreadyCovered(l, knownText));
      if (fresh.length === 0) continue;
      target.content = `${target.content}\n${fresh.map((l) => `- ${l}`).join("\n")}`;
      added += fresh.length;
    } else {
      const fresh = lines.filter((l) => !alreadyCovered(l, knownText));
      if (fresh.length === 0) continue;
      const title = addition.section.replace(/^nouvelle\s*:\s*/i, "").trim() || "Compléments";
      const existing = sections.find((s) => s.type !== "key_point" && normalize(s.title ?? "") === normalize(title));
      if (existing) {
        existing.content = `${existing.content}\n${fresh.map((l) => `- ${l}`).join("\n")}`;
      } else {
        const keyIndex = sections.findIndex((s) => s.type === "key_point");
        const created = { type: "notion" as const, title, content: fresh.map((l) => `- ${l}`).join("\n") };
        sections.splice(keyIndex === -1 ? sections.length : keyIndex, 0, created);
      }
      added += fresh.length;
    }
  }
  return { sheet: { ...sheet, sections: sections.slice(0, MAX_SECTIONS) }, added };
}

const AUDIT_ROUNDS = 2;

// Passes de contrôle : un appel compare le cours à la fiche et rattache ce qui manque ; un second
// tour rattrape ce que le premier a laissé passer. Un échec ici ne doit jamais faire perdre la
// fiche déjà générée.
async function withCoverageAudit(
  source: OpenAI.Chat.ChatCompletionContentPart[],
  draft: GeneratedSheet,
  sourceText?: string,
): Promise<GeneratedSheet> {
  let sheet = draft;
  const attempted = new Set<string>();
  for (let round = 1; round <= AUDIT_ROUNDS; round++) {
    try {
      const hints = sourceText ? absentTerms(sourceText, sheet).filter((t) => !attempted.has(t)) : [];
      hints.forEach((t) => attempted.add(t));
      // Sans indice déterministe, un 2e tour ne fait que réécrire ce qui existe déjà.
      if (round > 1 && hints.length === 0) break;
      const hintText =
        hints.length > 0
          ? `\n\nTERMES DU COURS ABSENTS DE LA FICHE (vérifie chacun : s'il porte une information utile du cours, ajoute-la ; ignore les mots banals) : ${hints.join(" ; ")}`
          : "";
      const additions = await completeJson(
        AUDIT_PROMPT,
        [
          { type: "text", text: "COURS D'ORIGINE :" },
          ...source,
          { type: "text", text: `FICHE ACTUELLE :\n${serializeSections(sheet.sections)}${hintText}` },
        ],
        parseAdditions,
      );
      const result = applyAdditions(sheet, additions);
      sheet = result.sheet;
      if (result.added === 0) break;
    } catch (err) {
      console.error("Passe de contrôle ignorée:", (err as Error)?.message);
      break;
    }
  }

  return sheet;
}

async function buildSheet(
  systemPrompt: string,
  source: OpenAI.Chat.ChatCompletionContentPart[],
  sourceText?: string,
): Promise<GeneratedSheet> {
  const draft = await completeJson(systemPrompt, source, parseSheetResponse);
  return withCoverageAudit(source, draft, sourceText);
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
    return buildSheet(SYSTEM_PROMPT, [{ type: "text", text }], text);
  }

  // Long cours : chaque partie est traitée intégralement (fiche + contrôle), puis fusionnée.
  const parts = await Promise.all(
    chunks.map((chunk, index) =>
      buildSheet(
        `${SYSTEM_PROMPT}\n\nCe texte est la partie ${index + 1}/${chunks.length} d'un cours plus long : traite UNIQUEMENT cette partie, de façon exhaustive.`,
        [{ type: "text", text: chunk }],
        chunk,
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
    'Tu reçois la liste des sections d\'une fiche de révision. Réponds UNIQUEMENT avec un objet JSON {"title": string (titre court du cours, < 70 caractères), "summary": string (2-3 phrases qui tutoient l\'élève : "Dans ce cours, tu vois...")}.',
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
