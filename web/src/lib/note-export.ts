/**
 * ZeroK v3 — Note Download/Upload
 *
 * Download: saves full V2Note (with Merkle path) as JSON file
 * Upload: parses JSON file back into V2Note
 */

import { V2Note } from '@/types/note';

const NOTE_FILE_VERSION = 'zerok-v3';

interface NoteFile {
  version: string;
  note: V2Note;
  exportedAt: string;
}

/**
 * Download a single note as a JSON file.
 */
export function downloadNote(note: V2Note): void {
  const file: NoteFile = {
    version: NOTE_FILE_VERSION,
    note,
    exportedAt: new Date().toISOString(),
  };
  const json = JSON.stringify(file, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const denomSol = (Number(BigInt(note.amount)) / 1e9).toString().replace('.', 'p');
  const filename = `zerok_${denomSol}sol_leaf${note.leafIndex}.json`;

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Download multiple notes as individual JSON files (triggers multiple downloads).
 */
export function downloadAllNotes(notes: V2Note[]): void {
  for (const note of notes) {
    downloadNote(note);
  }
}

/**
 * Parse an uploaded JSON file into a V2Note.
 * Returns null if the file is invalid.
 */
export async function parseUploadedNote(file: File): Promise<V2Note | null> {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);

    // Accept both wrapped format { version, note } and raw V2Note
    const note: V2Note = parsed.note || parsed;

    // Validate required fields
    if (!note.nullifier || !note.secret || !note.amount) {
      console.warn('[NoteExport] Invalid note file: missing required fields');
      return null;
    }

    // Ensure status field exists
    if (!note.status) {
      note.status = (note as any).spent ? 'spent' : 'unspent';
    }

    // Ensure id exists
    if (!note.id) {
      note.id = note.commitment || note.nullifier;
    }

    return note;
  } catch (e) {
    console.warn('[NoteExport] Failed to parse note file:', e);
    return null;
  }
}
