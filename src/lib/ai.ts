import OpenAI from "openai";
import { z } from "zod";
import { readFile } from "./storage.js";

const SectionSchema = z.object({
  type: z.enum([
    "notion",
    "definition",
    "formula",
    "example",
    "key_point",
    "common_mistake",
    "date",
    "concept",
    "method",
  ]),
  title: z.string().optional(),
  content: z.string(),
});

const SheetSchema = z.object({
  title: z.string(),
  summary: z.string(),
  sections: z.array(SectionSchema).min(1),
});

export type GeneratedSheet = z.infer<typeof SheetSchema>;

export class AiNotConfiguredError extends Error {}
export class AiGenerationError extends Error {}

const SYSTEM_PROMPT = `Tu es l'assistant pédagogique de SKOOLZ, une app d'aide aux révisions pour élèves (3e au supérieur).
On te donne le texte brut d'un cours. Transforme-le en fiche de révision claire, structurée et synthétique, en français, en tutoyant l'élève dans le résumé.

Réponds UNIQUEMENT avec un objet JSON respectant exactement ce schéma :
{
  "title": string (titre court de la fiche),
  "summary": string (résumé express en 2-3 phrases),
  "sections": [
    {
      "type": "notion" | "definition" | "formula" | "example" | "key_point" | "common_mistake" | "date" | "concept" | "method",
      "title": string (optionnel, court),
      "content": string
    }
  ]
}

Inclue uniquement les types de sections pertinents pour ce cours (ne force pas des formules si ce n'est pas un cours de maths/physique, etc.).
Termine toujours par au moins une section "key_point" listant les points à retenir.`;

const IMAGE_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

Les photos peuvent contenir un cours manuscrit ou imprimé, parfois de travers ou partiellement flou. Lis-les du mieux possible. Si une partie est vraiment illisible, ignore-la plutôt que d'inventer du contenu. Si plusieurs photos sont fournies, ce sont les pages successives d'un même cours : combine-les en une seule fiche cohérente, dans l'ordre.`;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new AiNotConfiguredError(
      "Clé API IA manquante. Ajoute OPENAI_API_KEY dans le fichier .env du serveur.",
    );
  }
  if (!client) {
    client = new OpenAI({ apiKey });
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

export async function generateRevisionSheet(courseText: string): Promise<GeneratedSheet> {
  const openai = getClient();
  const truncated = courseText.slice(0, 40_000);

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: truncated },
    ],
  });

  return parseSheetResponse(completion.choices[0]?.message?.content);
}

export interface ImageInput {
  path: string;
  mimeType: string;
}

export async function generateRevisionSheetFromImages(images: ImageInput[]): Promise<GeneratedSheet> {
  const openai = getClient();

  const imageBlocks = await Promise.all(
    images.map(async ({ path: storagePath, mimeType }) => {
      const buffer = await readFile(storagePath);
      const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
      return { type: "image_url" as const, image_url: { url: dataUrl } };
    }),
  );

  const introText =
    images.length > 1
      ? `Voici ${images.length} photos, les pages successives d'un même cours. Génère une seule fiche de révision.`
      : "Voici la photo d'un cours. Génère la fiche de révision.";

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: IMAGE_SYSTEM_PROMPT },
      {
        role: "user",
        content: [{ type: "text", text: introText }, ...imageBlocks],
      },
    ],
  });

  return parseSheetResponse(completion.choices[0]?.message?.content);
}
