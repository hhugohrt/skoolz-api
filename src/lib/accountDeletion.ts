import { queryAll, run } from "../db.js";
import { deleteFile } from "./storage.js";

async function deleteStoredFiles(paths: (string | null)[]) {
  await Promise.all(paths.map((p) => (p ? deleteFile(p).catch(() => {}) : undefined)));
}

// Supprime un cours (fichiers importés compris) ; les fiches et photos suivent en cascade dans la base.
export async function deleteCourse(courseId: string) {
  const files = [
    ...(await queryAll<{ p: string | null }>("SELECT storage_path AS p FROM courses WHERE id = ?", [courseId])),
    ...(await queryAll<{ p: string | null }>("SELECT storage_path AS p FROM course_photos WHERE course_id = ?", [courseId])),
  ];
  await deleteStoredFiles(files.map((f) => f.p));
  await run("DELETE FROM courses WHERE id = ?", [courseId]);
}

// Supprime un compte et tout ce qui s'y rattache (cours, fiches, photos). Utilisé par « Supprimer mon compte » et l'admin.
export async function deleteUserAccount(userId: string) {
  const rows = [
    ...(await queryAll<{ p: string | null }>("SELECT storage_path AS p FROM courses WHERE user_id = ?", [userId])),
    ...(await queryAll<{ p: string | null }>(
      "SELECT cp.storage_path AS p FROM course_photos cp JOIN courses c ON c.id = cp.course_id WHERE c.user_id = ?",
      [userId],
    )),
    ...(await queryAll<{ p: string | null }>(
      "SELECT sp.storage_path AS p FROM upload_session_photos sp JOIN upload_sessions s ON s.id = sp.session_id WHERE s.user_id = ?",
      [userId],
    )),
  ];
  await deleteStoredFiles(rows.map((r) => r.p));

  // Les matières créées par l'élève restent disponibles pour les autres : on retire juste le lien.
  await run("UPDATE subjects SET created_by = NULL WHERE created_by = ?", [userId]);
  await run("DELETE FROM users WHERE id = ?", [userId]);
}
