import { Note, NoteHealth } from '@/types/note';
import JSZip from 'jszip';

// localStorage key for backup notes
const BACKUP_NOTES_KEY = 'zerok_backup_notes';

// ==========================================
// localStorage Backup Functions
// ==========================================

/**
 * Save a note to localStorage backup immediately after creation.
 * This provides a safety net if the download fails or browser crashes.
 */
export function saveNoteToBackup(note: Note): void {
  try {
    const existing = localStorage.getItem(BACKUP_NOTES_KEY);
    const notes: Note[] = existing ? JSON.parse(existing) : [];

    // Avoid duplicates by checking commitment ID
    if (!notes.some(n => n.id === note.id)) {
      notes.unshift(note); // Add to beginning (most recent first)
      localStorage.setItem(BACKUP_NOTES_KEY, JSON.stringify(notes));
      console.log('[note-storage] Backed up note to localStorage:', note.id.slice(0, 8));
    }
  } catch (err) {
    console.error('[note-storage] Failed to save backup:', err);
  }
}

/**
 * Load all backed-up notes from localStorage.
 * Returns empty array if none exist or on error.
 */
export function loadBackupNotes(): Note[] {
  try {
    const stored = localStorage.getItem(BACKUP_NOTES_KEY);
    if (!stored) return [];

    const notes = JSON.parse(stored);
    console.log('[note-storage] Loaded', notes.length, 'notes from localStorage backup');
    return notes;
  } catch (err) {
    console.error('[note-storage] Failed to load backup:', err);
    return [];
  }
}

/**
 * Clear all backed-up notes from localStorage.
 * Call this after user confirms they've downloaded all notes.
 */
export function clearBackupNotes(): void {
  try {
    localStorage.removeItem(BACKUP_NOTES_KEY);
    console.log('[note-storage] Cleared localStorage backup');
  } catch (err) {
    console.error('[note-storage] Failed to clear backup:', err);
  }
}

/**
 * Remove a specific note from backup (e.g., after confirmed download).
 */
export function removeNoteFromBackup(noteId: string): void {
  try {
    const existing = localStorage.getItem(BACKUP_NOTES_KEY);
    if (!existing) return;

    const notes: Note[] = JSON.parse(existing);
    const filtered = notes.filter(n => n.id !== noteId);

    if (filtered.length === 0) {
      localStorage.removeItem(BACKUP_NOTES_KEY);
    } else {
      localStorage.setItem(BACKUP_NOTES_KEY, JSON.stringify(filtered));
    }
  } catch (err) {
    console.error('[note-storage] Failed to remove from backup:', err);
  }
}

// Calculate note health based on current pool state
export function calculateNoteHealth(
  leafIndex: number,
  currentLeafCount: number,
  ringCapacity: number
): NoteHealth {
  // Formula: depositsRemaining = (leafIndex + ringCapacity) - currentLeafCount
  const depositsRemaining = (leafIndex + ringCapacity) - currentLeafCount;

  // Health is percentage of remaining deposits vs ring capacity
  const healthPercent = Math.max(0, Math.min(100, (depositsRemaining / ringCapacity) * 100));

  let status: NoteHealth['status'] = 'ready';
  if (depositsRemaining <= 0) {
    status = 'expired';
  } else if (healthPercent < 30) {
    status = 'expiring';
  }

  return {
    depositsRemaining: Math.max(0, depositsRemaining),
    healthPercent,
    status,
  };
}

// Get the filename for a note
export function getNoteFileName(note: Note): string {
  return `${note.id.slice(0, 8)}_${note.poolId}.tsolnote`;
}

/**
 * Export note to .tsolnote file with download verification.
 * Returns true if download was triggered successfully, false on error.
 * Note: Browser downloads can still fail silently (e.g., popup blocker),
 * so we also save to localStorage as backup.
 */
export function exportNoteToFile(note: Note): boolean {
  try {
    // FIRST: Save to localStorage backup (safety net)
    saveNoteToBackup(note);

    // Then trigger download
    const content = JSON.stringify(note, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = getNoteFileName(note);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log('[note-storage] Download triggered for:', getNoteFileName(note));
    return true;
  } catch (err) {
    console.error('[note-storage] Download failed:', err);
    // Note is still in localStorage backup
    return false;
  }
}

// Validate note structure
export function validateNoteStructure(note: unknown): note is Note {
  if (typeof note !== 'object' || note === null) return false;

  const n = note as Record<string, unknown>;

  // Required fields
  const requiredFields = ['id', 'commitment', 'nullifierSecret', 'nullifierHash'];
  for (const field of requiredFields) {
    if (!n[field] || typeof n[field] !== 'string') {
      return false;
    }
  }

  // leafIndex can be 0, so check explicitly
  if (typeof n.leafIndex !== 'number' && n.leafIndex !== 0) {
    return false;
  }

  return true;
}

// Parse note from pasted text (JSON)
export function parseNoteFromText(text: string): Note {
  const trimmed = text.trim();

  if (!trimmed) {
    throw new Error('Empty note data');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('Invalid JSON format. Please paste valid note JSON.');
  }

  if (!validateNoteStructure(parsed)) {
    throw new Error('Invalid note structure. Required fields: id, commitment, nullifierSecret, nullifierHash, leafIndex');
  }

  return parsed as Note;
}

// Import note from .tsolnote file
export function importNoteFromFile(file: File): Promise<Note> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const note = parseNoteFromText(content);
        resolve(note);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

// Export multiple notes as a ZIP file
export async function exportNotesAsZip(notes: Note[]): Promise<void> {
  if (notes.length === 0) return;

  const zip = new JSZip();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // Add each note as a file in the ZIP
  notes.forEach((note, index) => {
    const filename = getNoteFileName(note);
    const content = JSON.stringify(note, null, 2);
    zip.file(filename, content);
  });

  // Generate the ZIP file
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);

  // Download the ZIP
  const a = document.createElement('a');
  a.href = url;
  a.download = `zerok-notes_${timestamp}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
