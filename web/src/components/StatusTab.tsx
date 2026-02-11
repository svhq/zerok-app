'use client';

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { Card, Button, HealthBar } from './ui';
import { Note, NoteHealth } from '@/types/note';
import { importNoteFromFile, parseNoteFromText, calculateNoteHealth } from '@/lib/note-storage';
import { formatSol, getPoolConfig } from '@/lib/pool-config';
import { getFullNoteStatuses, FullNoteStatus } from '@/lib/on-chain-status';
import WithdrawBar from './WithdrawBar';

interface LoadedNote {
  note: Note;
  health: NoteHealth;
  selected: boolean;
  status: 'checking' | 'ready' | 'expiring' | 'spent' | 'expired' | 'error';
  error?: string;
}

export default function StatusTab() {
  const { publicKey } = useWallet();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [loadedNotes, setLoadedNotes] = useState<LoadedNote[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [showPasteArea, setShowPasteArea] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const [pendingNotes, setPendingNotes] = useState<Note[]>([]);
  const [importMessage, setImportMessage] = useState<{ type: 'success' | 'warning'; text: string } | null>(null);

  // Single-flight guard: prevent concurrent status check requests
  const statusCheckInFlight = useRef(false);

  // Check on-chain status when new notes are added
  useEffect(() => {
    if (pendingNotes.length === 0) return;

    // Single-flight guard: skip if a check is already in progress
    if (statusCheckInFlight.current) {
      console.log('[StatusTab] Skipping status check - already in flight');
      return;
    }

    const checkStatuses = async () => {
      statusCheckInFlight.current = true;
      setIsCheckingStatus(true);
      try {
        const statuses = await getFullNoteStatuses(pendingNotes);

        // Convert to LoadedNote format
        const newLoadedNotes: LoadedNote[] = pendingNotes.map((note, index) => {
          const status = statuses[index];
          return {
            note,
            health: status.health,
            selected: false,
            status: status.finalStatus,
            error: status.error,
          };
        });

        setLoadedNotes(prev => {
          // Filter out duplicates
          const existingIds = new Set(prev.map(n => n.note.id));
          const uniqueNew = newLoadedNotes.filter(n => !existingIds.has(n.note.id));
          return [...prev, ...uniqueNew];
        });
      } catch (error) {
        console.error('Failed to check note statuses:', error);
        // Add notes with 'error' status if check fails
        const errorNotes: LoadedNote[] = pendingNotes.map(note => {
          const poolConfig = getPoolConfig(note.poolId);
          return {
            note,
            health: calculateNoteHealth(note.leafIndex, 0, poolConfig.ringCapacity),
            selected: false,
            status: 'error' as const,
            error: error instanceof Error ? error.message : 'Failed to check status',
          };
        });
        setLoadedNotes(prev => {
          const existingIds = new Set(prev.map(n => n.note.id));
          const uniqueNew = errorNotes.filter(n => !existingIds.has(n.note.id));
          return [...prev, ...uniqueNew];
        });
      } finally {
        statusCheckInFlight.current = false;
        setIsCheckingStatus(false);
        setPendingNotes([]);
      }
    };

    checkStatuses();
  }, [pendingNotes]);

  // Refresh all notes' status
  const refreshStatuses = useCallback(async () => {
    if (loadedNotes.length === 0) return;

    // Single-flight guard: skip if a check is already in progress
    if (statusCheckInFlight.current) {
      console.log('[StatusTab] Skipping refresh - already in flight');
      return;
    }

    statusCheckInFlight.current = true;
    setIsCheckingStatus(true);
    try {
      const notes = loadedNotes.map(n => n.note);
      const statuses = await getFullNoteStatuses(notes);

      setLoadedNotes(prev => prev.map((item, index) => {
        const status = statuses[index];
        return {
          ...item,
          health: status.health,
          status: status.finalStatus,
          error: status.error,
        };
      }));
    } catch (error) {
      console.error('Failed to refresh statuses:', error);
    } finally {
      statusCheckInFlight.current = false;
      setIsCheckingStatus(false);
    }
  }, [loadedNotes]);

  // Calculate totals - each note uses its own pool's denomination
  const { availableNotes, selectedNotes, selectedBalance, totalBalance } = useMemo(() => {
    const available = loadedNotes.filter(n => n.status === 'ready' || n.status === 'expiring');
    const selected = loadedNotes.filter(n => n.selected);

    // Sum up balances using each note's pool denomination
    const selectedBal = selected.reduce((sum, item) => {
      const poolConfig = getPoolConfig(item.note.poolId);
      return sum + BigInt(poolConfig.denominationLamports);
    }, 0n);

    const totalBal = available.reduce((sum, item) => {
      const poolConfig = getPoolConfig(item.note.poolId);
      return sum + BigInt(poolConfig.denominationLamports);
    }, 0n);

    return {
      availableNotes: available,
      selectedNotes: selected.map(n => n.note),
      selectedBalance: selectedBal,
      totalBalance: totalBal,
    };
  }, [loadedNotes]);

  // Add notes from files
  const addNotesFromFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    const newNotes: Note[] = [];
    let skippedDuplicates = 0;
    let failedParse = 0;

    for (const file of fileArray) {
      try {
        const note = await importNoteFromFile(file);

        // Check for duplicates (both in loaded and pending)
        if (loadedNotes.some(n => n.note.id === note.id) ||
            pendingNotes.some(n => n.id === note.id) ||
            newNotes.some(n => n.id === note.id)) {
          console.warn('Duplicate note skipped:', note.id);
          skippedDuplicates++;
          continue;
        }

        newNotes.push(note);
      } catch (err) {
        console.error('Failed to parse note file:', file.name, err);
        failedParse++;
      }
    }

    // Show feedback message
    if (fileArray.length > 0) {
      const totalSkipped = skippedDuplicates + failedParse;
      if (newNotes.length === 0 && totalSkipped > 0) {
        // All files were skipped
        const reasons: string[] = [];
        if (skippedDuplicates > 0) reasons.push(`${skippedDuplicates} duplicate(s)`);
        if (failedParse > 0) reasons.push(`${failedParse} invalid file(s)`);
        setImportMessage({
          type: 'warning',
          text: `No new notes added: ${reasons.join(', ')} skipped`
        });
      } else if (newNotes.length > 0 && totalSkipped > 0) {
        // Some added, some skipped
        const reasons: string[] = [];
        if (skippedDuplicates > 0) reasons.push(`${skippedDuplicates} duplicate(s)`);
        if (failedParse > 0) reasons.push(`${failedParse} invalid file(s)`);
        setImportMessage({
          type: 'warning',
          text: `Added ${newNotes.length} note(s), skipped ${reasons.join(', ')}`
        });
      } else if (newNotes.length > 0) {
        // All files added successfully
        setImportMessage({
          type: 'success',
          text: `Successfully added ${newNotes.length} note(s)`
        });
      }

      // Auto-dismiss message after 5 seconds
      setTimeout(() => setImportMessage(null), 5000);
    }

    if (newNotes.length > 0) {
      // Add to pending notes - effect will check status
      setPendingNotes(prev => [...prev, ...newNotes]);
    }
  }, [loadedNotes, pendingNotes]);

  // Handle drag events
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      addNotesFromFiles(files);
    }
  }, [addNotesFromFiles]);

  // Handle file input
  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      addNotesFromFiles(files);
    }
    // Reset input
    e.target.value = '';
  }, [addNotesFromFiles]);

  // Handle paste
  const handleAddFromPaste = useCallback(() => {
    setPasteError(null);

    if (!pasteText.trim()) {
      setPasteError('Please paste note data');
      return;
    }

    try {
      const note = parseNoteFromText(pasteText);

      // Check for duplicates (both in loaded and pending)
      if (loadedNotes.some(n => n.note.id === note.id) ||
          pendingNotes.some(n => n.id === note.id)) {
        setPasteError('This note is already loaded');
        return;
      }

      // Add to pending notes - effect will check status
      setPendingNotes(prev => [...prev, note]);

      setPasteText('');
      setShowPasteArea(false);
    } catch (err) {
      setPasteError(err instanceof Error ? err.message : 'Invalid note data');
    }
  }, [pasteText, loadedNotes, pendingNotes]);

  // Toggle note selection
  const toggleSelect = useCallback((noteId: string) => {
    setLoadedNotes(prev => prev.map(n => {
      if (n.note.id === noteId && (n.status === 'ready' || n.status === 'expiring')) {
        return { ...n, selected: !n.selected };
      }
      return n;
    }));
  }, []);

  // Remove note from view
  const removeNote = useCallback((noteId: string) => {
    setLoadedNotes(prev => prev.filter(n => n.note.id !== noteId));
  }, []);

  // Select all available
  const selectAll = useCallback(() => {
    setLoadedNotes(prev => prev.map(n => ({
      ...n,
      selected: n.status === 'ready' || n.status === 'expiring',
    })));
  }, []);

  // Clear selection
  const clearSelection = useCallback(() => {
    setLoadedNotes(prev => prev.map(n => ({ ...n, selected: false })));
  }, []);

  // Format date
  const formatDate = (isoString: string) => {
    const date = new Date(isoString);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  // Get status display
  const getStatusDisplay = (status: LoadedNote['status']) => {
    switch (status) {
      case 'checking': return { text: 'Checking...', color: 'text-zk-text-muted' };
      case 'ready': return { text: 'Ready', color: 'text-zk-success' };
      case 'expiring': return { text: 'Expiring', color: 'text-zk-warning' };
      case 'spent': return { text: 'Spent', color: 'text-zk-text-muted' };
      case 'expired': return { text: 'Expired', color: 'text-zk-danger' };
      case 'error': return { text: 'Error', color: 'text-zk-danger' };
      default: return { text: 'Unknown', color: 'text-zk-text-muted' };
    }
  };

  const selectedCount = loadedNotes.filter(n => n.selected).length;

  return (
    <div className="pb-24">
      {/* Drop Zone */}
      <div
        className={`relative border-2 border-dashed rounded-2xl p-8 mb-6 transition-all cursor-pointer ${
          isDragOver
            ? 'border-zk-teal bg-zk-teal/10'
            : 'border-zk-teal/30 hover:border-zk-teal/50 bg-zk-surface/50'
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".tsolnote"
          multiple
          className="hidden"
          onChange={handleFileInput}
        />

        <div className="text-center">
          {isCheckingStatus && pendingNotes.length > 0 ? (
            <>
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-zk-teal/20 flex items-center justify-center">
                <div className="animate-spin w-8 h-8 border-2 border-zk-teal border-t-transparent rounded-full" />
              </div>
              <h3 className="text-zk-text font-semibold mb-1">Checking note status...</h3>
              <p className="text-zk-text-muted text-sm">Verifying {pendingNotes.length} note(s) on-chain</p>
            </>
          ) : (
            <>
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-zk-teal/20 flex items-center justify-center">
                <svg className="w-8 h-8 text-zk-teal" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
              </div>
              <h3 className="text-zk-text font-semibold mb-1">Drop your .tsolnote files here</h3>
              <p className="text-zk-text-muted text-sm">or click to browse (select multiple)</p>
            </>
          )}
        </div>
      </div>

      {/* Import Message */}
      {importMessage && (
        <div
          className={`mb-4 p-3 rounded-xl flex items-center justify-between ${
            importMessage.type === 'success'
              ? 'bg-zk-success/20 border border-zk-success/50'
              : 'bg-zk-warning/20 border border-zk-warning/50'
          }`}
        >
          <div className="flex items-center gap-2">
            {importMessage.type === 'success' ? (
              <svg className="w-5 h-5 text-zk-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-5 h-5 text-zk-warning" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            )}
            <span className={importMessage.type === 'success' ? 'text-zk-success' : 'text-zk-warning'}>
              {importMessage.text}
            </span>
          </div>
          <button
            onClick={() => setImportMessage(null)}
            className={`p-1 hover:opacity-70 transition-opacity ${
              importMessage.type === 'success' ? 'text-zk-success' : 'text-zk-warning'
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Paste Section */}
      <div className="mb-6">
        <button
          className="flex items-center gap-2 text-zk-text-muted hover:text-zk-text text-sm transition-colors"
          onClick={() => setShowPasteArea(!showPasteArea)}
        >
          <svg
            className={`w-4 h-4 transition-transform ${showPasteArea ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
          Or paste note data
        </button>

        {showPasteArea && (
          <div className="mt-3">
            <textarea
              className="w-full h-32 bg-zk-surface border border-zk-teal/30 rounded-xl p-4 text-zk-text text-sm font-mono resize-none focus:outline-none focus:border-zk-teal"
              placeholder='Paste note JSON here...&#10;{&#10;  "id": "...",&#10;  "commitment": "0x...",&#10;  ...&#10;}'
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
            />
            {pasteError && (
              <p className="text-zk-danger text-sm mt-2">{pasteError}</p>
            )}
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={handleAddFromPaste}
            >
              Add from paste
            </Button>
          </div>
        )}
      </div>

      {/* Notes Table */}
      {loadedNotes.length === 0 ? (
        <Card className="text-center py-12">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-zk-surface flex items-center justify-center">
            <svg className="w-8 h-8 text-zk-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <h3 className="text-zk-text font-semibold mb-2">No Notes Loaded</h3>
          <p className="text-zk-text-muted text-sm">
            Upload your .tsolnote files to check status and withdraw
          </p>
        </Card>
      ) : (
        <>
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-zk-text">Your Notes ({loadedNotes.length})</h2>
              <p className="text-zk-text-muted text-sm">
                Available: <span className="text-zk-text">{formatSol(totalBalance)} SOL</span>
                <span className="text-zk-text-muted ml-1">({availableNotes.length} notes)</span>
              </p>
            </div>

            <div className="flex gap-2">
              {/* Refresh button */}
              <Button
                variant="outline"
                size="sm"
                onClick={refreshStatuses}
                disabled={isCheckingStatus || loadedNotes.length === 0}
              >
                <svg
                  className={`w-4 h-4 mr-1 ${isCheckingStatus ? 'animate-spin' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {isCheckingStatus ? 'Checking...' : 'Refresh'}
              </Button>

              {selectedCount > 0 ? (
                <Button variant="outline" size="sm" onClick={clearSelection}>
                  Clear ({selectedCount})
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={selectAll} disabled={availableNotes.length === 0}>
                  Select All
                </Button>
              )}
            </div>
          </div>

          <Card className="p-0 overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-zk-teal/20">
                  <th className="w-12 p-3"></th>
                  <th className="text-left text-zk-text-muted text-xs font-medium p-3">Note</th>
                  <th className="text-left text-zk-text-muted text-xs font-medium p-3">Amount</th>
                  <th className="text-left text-zk-text-muted text-xs font-medium p-3">Health</th>
                  <th className="text-left text-zk-text-muted text-xs font-medium p-3">Status</th>
                  <th className="text-right text-zk-text-muted text-xs font-medium p-3"></th>
                </tr>
              </thead>
              <tbody>
                {loadedNotes.map((item) => {
                  const isSelectable = item.status === 'ready' || item.status === 'expiring';
                  const isSpent = item.status === 'spent';
                  const statusDisplay = getStatusDisplay(item.status);
                  const notePoolConfig = getPoolConfig(item.note.poolId);

                  return (
                    <tr
                      key={item.note.id}
                      className={`note-row border-b border-zk-teal/10 last:border-0 ${
                        item.selected ? 'selected' : ''
                      } ${isSpent ? 'opacity-50' : ''}`}
                      onClick={() => isSelectable && toggleSelect(item.note.id)}
                    >
                      {/* Checkbox */}
                      <td className="p-3">
                        {isSelectable ? (
                          <input
                            type="checkbox"
                            className="custom-checkbox"
                            checked={item.selected}
                            onChange={() => toggleSelect(item.note.id)}
                            onClick={e => e.stopPropagation()}
                          />
                        ) : (
                          <span className="w-5 h-5 flex items-center justify-center text-zk-text-muted">
                            {isSpent ? '✓' : '-'}
                          </span>
                        )}
                      </td>

                      {/* Note ID */}
                      <td className="p-3 font-mono text-sm text-zk-text-muted">
                        {item.note.id.slice(0, 8)}...
                      </td>

                      {/* Amount */}
                      <td className={`p-3 font-medium ${isSpent ? 'line-through text-zk-text-muted' : 'text-zk-text'}`}>
                        {notePoolConfig.denominationDisplay}
                      </td>

                      {/* Health Bar */}
                      <td className="p-3">
                        {isSpent ? (
                          <span className="text-zk-text-muted text-sm">---</span>
                        ) : (
                          <div className="w-20">
                            <HealthBar health={item.health.healthPercent} />
                          </div>
                        )}
                      </td>

                      {/* Status */}
                      <td className="p-3">
                        <span className={`text-sm ${statusDisplay.color}`}>
                          {statusDisplay.text}
                        </span>
                      </td>

                      {/* Remove button */}
                      <td className="p-3 text-right">
                        <button
                          className="text-zk-text-muted hover:text-zk-danger transition-colors p-1"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeNote(item.note.id);
                          }}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {/* Withdraw Bar */}
      {selectedCount > 0 && (
        <WithdrawBar
          selectedNotes={selectedNotes}
          selectedBalance={selectedBalance}
          onClear={clearSelection}
        />
      )}
    </div>
  );
}
