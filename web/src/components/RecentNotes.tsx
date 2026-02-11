'use client';

import { useState, useEffect } from 'react';
import { Card, Button } from './ui';
import { Note } from '@/types/note';
import { exportNoteToFile, getNoteFileName, exportNotesAsZip } from '@/lib/note-storage';
import { formatSol, getPoolConfig } from '@/lib/pool-config';

interface RecentNotesProps {
  notes: Note[];
  onClear: () => void;
  isRecovered?: boolean; // True if notes were recovered from localStorage
  autoDownloadedIds?: Set<string>; // IDs of notes that were auto-downloaded during deposit
}

export default function RecentNotes({ notes, onClear, isRecovered, autoDownloadedIds }: RecentNotesProps) {
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());

  // Merge auto-downloaded IDs when they change (new deposits)
  useEffect(() => {
    if (autoDownloadedIds && autoDownloadedIds.size > 0) {
      setDownloadedIds(prev => new Set([...prev, ...autoDownloadedIds]));
    }
  }, [autoDownloadedIds]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (notes.length === 0) {
    return null;
  }

  const handleDownload = (note: Note) => {
    exportNoteToFile(note);
    setDownloadedIds(prev => new Set(prev).add(note.id));
  };

  const handleDownloadAll = async () => {
    if (notes.length > 1) {
      // Use ZIP for multiple notes (single download, no browser blocking)
      await exportNotesAsZip(notes);
      setDownloadedIds(new Set(notes.map(n => n.id)));
    } else {
      // Single note: direct download
      notes.forEach((note) => {
        exportNoteToFile(note);
        setDownloadedIds(prev => new Set(prev).add(note.id));
      });
    }
  };

  const handleCopyNote = async (note: Note) => {
    try {
      const noteJson = JSON.stringify(note, null, 2);
      await navigator.clipboard.writeText(noteJson);
      setCopiedId(note.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  // Sum up total using each note's pool denomination
  const totalValue = notes.reduce((sum, note) => {
    const poolConfig = getPoolConfig(note.poolId);
    return sum + BigInt(poolConfig.denominationLamports);
  }, 0n);
  const allDownloaded = notes.every(n => downloadedIds.has(n.id));

  return (
    <div className="flex justify-center py-4">
      <Card className="w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold text-zk-text">Recent Notes</h3>
            <p className="text-zk-text-muted text-xs">
              {notes.length} note{notes.length > 1 ? 's' : ''} - {formatSol(totalValue)} SOL
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownloadAll}
            >
              {notes.length > 1 ? 'Download ZIP' : 'Download'}
            </Button>
            {allDownloaded && (
              <Button
                variant="outline"
                size="sm"
                onClick={onClear}
              >
                Clear
              </Button>
            )}
          </div>
        </div>

        {/* Recovery Notice */}
        {isRecovered && (
          <div className="mb-4 p-3 bg-zk-success/10 border border-zk-success/30 rounded-xl">
            <p className="text-zk-success text-xs">
              Recovered {notes.length} note{notes.length > 1 ? 's' : ''} from previous session. Download them now!
            </p>
          </div>
        )}

        {/* Warning */}
        <div className="mb-4 p-3 bg-zk-warning/10 border border-zk-warning/30 rounded-xl">
          <p className="text-zk-warning text-xs">
            Notes are backed up locally but you should still download them for safekeeping!
          </p>
        </div>

        {/* Note List */}
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {notes.map((note, index) => (
            <div
              key={note.id}
              className="bg-zk-bg/50 rounded-xl border border-zk-teal/20"
            >
              <div className="flex items-center justify-between p-3">
                <div className="flex-1 min-w-0">
                  <div className="text-zk-text text-sm font-mono truncate">
                    Note #{index + 1}
                  </div>
                  <div className="text-zk-text-muted text-xs truncate">
                    {getNoteFileName(note)}
                  </div>
                </div>

                <div className="flex items-center gap-2 ml-2">
                  {/* Download status */}
                  {downloadedIds.has(note.id) && (
                    <span className="text-zk-success text-xs">Saved</span>
                  )}

                  {/* Expand/collapse JSON button */}
                  <button
                    onClick={() => setExpandedId(expandedId === note.id ? null : note.id)}
                    className="p-1.5 text-zk-text-muted hover:text-zk-teal transition-colors"
                    title="Show/hide note data"
                  >
                    <svg
                      className={`w-4 h-4 transition-transform ${expandedId === note.id ? 'rotate-180' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {/* Copy button */}
                  <button
                    onClick={() => handleCopyNote(note)}
                    className="p-1.5 text-zk-text-muted hover:text-zk-teal transition-colors"
                    title="Copy to clipboard"
                  >
                    {copiedId === note.id ? (
                      <svg className="w-4 h-4 text-zk-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    )}
                  </button>

                  {/* Download button */}
                  <button
                    onClick={() => handleDownload(note)}
                    className="p-1.5 text-zk-text-muted hover:text-zk-teal transition-colors"
                    title="Download note file"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Collapsible JSON display */}
              {expandedId === note.id && (
                <div className="px-3 pb-3">
                  <div className="p-2 bg-black/50 rounded-lg border border-zk-teal/10">
                    <p className="text-zk-text-muted text-xs mb-1">
                      Manual backup - copy this if download fails:
                    </p>
                    <pre className="text-xs text-zk-success font-mono overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap break-all">
                      {JSON.stringify(note, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Info footer */}
        <p className="text-zk-text-muted text-xs text-center mt-4">
          Keep your notes safe - you need them to withdraw your funds!
        </p>
      </Card>
    </div>
  );
}
