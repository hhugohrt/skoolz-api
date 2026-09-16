import { readFile } from "./storage.js";

export class UnsupportedFileError extends Error {}

export async function extractText(storagePath: string, mimeType: string): Promise<string> {
  const buffer = await readFile(storagePath);

  if (mimeType === "application/pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    const result = await pdfParse(buffer);
    return result.text;
  }

  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "application/msword"
  ) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (mimeType === "text/plain") {
    return buffer.toString("utf-8");
  }

  throw new UnsupportedFileError(
    "Ce format n'est pas encore supporté pour l'extraction automatique (PDF, DOC, DOCX et TXT uniquement pour l'instant).",
  );
}
