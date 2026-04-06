'use client';

/**
 * ZeroK v2 Deposit Card
 *
 * Deposits any arbitrary SOL amount into the v2 JoinSplit pool.
 * Unlike v1 (fixed denomination), v2 accepts any amount ≥ 0.01 SOL.
 *
 * One Phantom popup → funds enter the pool → encrypted change note
 * embedded in the tx memo for wallet-based recovery.
 */

import { useState } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { Card, Button } from './ui';
import { generateRandomFieldElement, computeV2CommitmentFromBigInts } from '@/lib/sdk/poseidon';
import { getCachedKey } from '@/lib/note-encryption';
import { V2Note } from '@/types/note';

// ─── v2 program constants ─────────────────────────────────────────────────────

const V2_PROGRAM_ID  = new PublicKey('HVcTokFF4rwvcU7sC7GjS317CSf7QDgfCvW7edijKS2v');
const MEMO_PROGRAM   = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const MEMO_PREFIX_V2 = 'zerok:v2:';

// Use TextEncoder for browser-safe PDA seed bytes
const _enc = new TextEncoder();
const [V2_STATE_PDA] = PublicKey.findProgramAddressSync(
  [_enc.encode('zerok_v2')],
  V2_PROGRAM_ID,
);
const [V2_VAULT_PDA] = PublicKey.findProgramAddressSync(
  [_enc.encode('vault_v2'), V2_STATE_PDA.toBytes()],
  V2_PROGRAM_ID,
);

// ─── v2 memo encryption (AES-256-GCM, same key as v1, zerok:v2: prefix) ──────

async function encryptV2Memo(
  key: CryptoKey,
  payload: { n: string; s: string; a: string; i: number }
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const buf = encoded.buffer as ArrayBuffer;
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buf);
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);
  return MEMO_PREFIX_V2 + btoa(String.fromCharCode(...combined));
}

// Minimum deposit = smallest withdrawal denomination (0.1 SOL)
// Users must deposit in multiples of 0.1 SOL so they can always withdraw.
const MIN_DENOMINATION_SOL  = 0.1;
const MIN_DENOMINATION_LAMP = 100_000_000n; // 0.1 SOL in lamports

/** Round a SOL value down to the nearest 0.1 SOL multiple. */
function snapToGrid(sol: number): number {
  return Math.floor(sol / MIN_DENOMINATION_SOL) * MIN_DENOMINATION_SOL;
}
const MIN_DEPOSIT_SOL  = MIN_DENOMINATION_SOL;
const MIN_DEPOSIT_LAMP = MIN_DENOMINATION_LAMP;

// ─── discriminator (sha256("global:deposit_v2")[0..8]) ────────────────────────

async function getDepositV2Discriminator(): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode('global:deposit_v2') as unknown as ArrayBuffer);
  return new Uint8Array(buf).slice(0, 8);
}

// ─── instruction builder ──────────────────────────────────────────────────────

async function buildDepositV2Instruction(
  commitment: Uint8Array,
  amountLamports: bigint,
  depositor: PublicKey,
): Promise<TransactionInstruction> {
  const disc = await getDepositV2Discriminator();

  // Layout: disc(8) + commitment(32) + amount(8 LE u64) + memo_blob_len(4 LE u32, = 0)
  const data = new Uint8Array(8 + 32 + 8 + 4);
  data.set(disc, 0);
  data.set(commitment, 8);
  const dv = new DataView(data.buffer);
  dv.setBigUint64(40, amountLamports, true);  // LE u64
  dv.setUint32(48, 0, true);                  // empty memo_blob

  return new TransactionInstruction({
    programId: V2_PROGRAM_ID,
    keys: [
      { pubkey: V2_STATE_PDA, isSigner: false, isWritable: true },
      { pubkey: V2_VAULT_PDA, isSigner: false, isWritable: true },
      { pubkey: depositor,    isSigner: true,  isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

// ─── component ───────────────────────────────────────────────────────────────

export interface V2DepositCardProps {
  onNoteCreated?: (note: V2Note) => void;
  keyReady?: boolean;
}

type Phase = 'idle' | 'generating' | 'signing' | 'confirming' | 'done' | 'error';

export default function V2DepositCard({ onNoteCreated, keyReady = false }: V2DepositCardProps) {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();

  const [amountSol, setAmountSol] = useState('');
  const [phase, setPhase]         = useState<Phase>('idle');
  const [error, setError]         = useState<string | null>(null);

  // Snap to 0.1 SOL grid — prevents deposits that can't be fully withdrawn
  const amountLamports = (() => {
    const n = parseFloat(amountSol);
    if (isNaN(n) || n <= 0) return 0n;
    const snapped = snapToGrid(n);
    return BigInt(Math.round(snapped * 1e9));
  })();

  // Display the effective (snapped) amount to user
  const effectiveSol = amountLamports > 0n ? Number(amountLamports) / 1e9 : 0;

  const isValid = amountLamports >= MIN_DEPOSIT_LAMP;

  async function handleDeposit() {
    if (!publicKey || !signTransaction || !isValid) return;
    setError(null);
    setPhase('generating');

    try {
      // 1. Generate random note fields
      const nullifier = generateRandomFieldElement();
      const secret    = generateRandomFieldElement();

      const { commitment, nullifierHash } = await computeV2CommitmentFromBigInts(
        amountLamports, nullifier, secret
      );

      // 2. Encrypt note for memo (if encryption key available)
      let memoText: string | null = null;
      const aesKey = publicKey ? getCachedKey(publicKey.toBase58()) : undefined;
      if (aesKey) {
        const commitHexEarly = Array.from(commitment).map(b => b.toString(16).padStart(2, '0')).join('');
        memoText = await encryptV2Memo(aesKey, {
          n: nullifier.toString(),
          s: secret.toString(),
          a: amountLamports.toString(),
          i: -1,  // leafIndex unknown until confirmed — resolved by StatusTab scan
        });
        void commitHexEarly; // silence unused warning
      }

      // 3. Build transaction
      setPhase('signing');
      const { blockhash } = await connection.getLatestBlockhash();
      const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });

      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));
      tx.add(await buildDepositV2Instruction(commitment, amountLamports, publicKey));

      if (memoText) {
        tx.add(new TransactionInstruction({
          programId: MEMO_PROGRAM,
          keys: [{ pubkey: publicKey, isSigner: true, isWritable: false }],
          data: Buffer.from(memoText, 'utf8'),
        }));
      }

      const signed = await signTransaction(tx);

      // 4. Send and confirm
      setPhase('confirming');
      const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      await connection.confirmTransaction(sig, 'confirmed');

      // 5. Emit note (leafIndex resolved from StatusTab memo scan)
      const commitHex = Array.from(commitment).map(b => b.toString(16).padStart(2, '0')).join('');
      const nullHashHex = Array.from(nullifierHash).map(b => b.toString(16).padStart(2, '0')).join('');
      const note: V2Note = {
        id:            commitHex,
        amount:        amountLamports.toString(),
        nullifier:     nullifier.toString(),
        secret:        secret.toString(),
        commitment:    commitHex,
        nullifierHash: nullHashHex,
        leafIndex:     -1,   // unknown until StatusTab scans events
        merkleRoot:    '',
        pathElements:  [],
        pathIndices:   [],
        status:        'unspent' as const,
        depositTx:     sig,
        createdAt:     new Date().toISOString(),
      };

      onNoteCreated?.(note);
      setPhase('done');
      setAmountSol('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }

  return (
    <Card>
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-200 mb-1">Private Deposit (v2)</h3>
          <p className="text-xs text-gray-400">
            Deposit any amount — withdraw in fixed denominations later.
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-xs text-gray-400" htmlFor="v2-amount">Amount (SOL)</label>
          <div className="flex gap-2">
            <input
              id="v2-amount"
              type="number"
              min={MIN_DEPOSIT_SOL}
              step="0.1"
              placeholder="0.0"
              value={amountSol}
              onChange={e => { setAmountSol(e.target.value); setError(null); setPhase('idle'); }}
              onBlur={e => {
                // Snap to 0.1 SOL grid on blur so user sees the effective amount
                const n = parseFloat(e.target.value);
                if (!isNaN(n) && n > 0) {
                  setAmountSol(snapToGrid(n).toFixed(1));
                }
              }}
              disabled={phase === 'signing' || phase === 'confirming'}
              className="flex-1 bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm text-white
                         focus:outline-none focus:border-blue-500 disabled:opacity-50"
            />
            <Button
              onClick={handleDeposit}
              disabled={!publicKey || !isValid || !keyReady || phase === 'signing' || phase === 'confirming' || phase === 'generating'}
              className="px-4"
            >
              {phase === 'generating' ? 'Preparing…' :
               phase === 'signing'    ? 'Sign…' :
               phase === 'confirming' ? 'Confirming…' :
               phase === 'done'       ? '✓ Done' : 'Deposit'}
            </Button>
          </div>

          {amountSol && !isValid && (
            <p className="text-xs text-red-400">Minimum deposit: {MIN_DEPOSIT_SOL} SOL (multiples of 0.1 only)</p>
          )}
          {amountSol && isValid && effectiveSol !== parseFloat(amountSol) && (
            <p className="text-xs text-yellow-400">Will deposit {effectiveSol} SOL (rounded down to 0.1 SOL grid)</p>
          )}
          {!keyReady && publicKey && (
            <p className="text-xs text-yellow-400">Sign once to enable encrypted note recovery</p>
          )}
        </div>

        {error && (
          <div className="text-xs text-red-400 bg-red-900/20 rounded p-2 break-all">{error}</div>
        )}

        {phase === 'done' && (
          <div className="text-xs text-green-400">
            Deposited {amountSol} SOL into the private pool. Your change note will appear in Notes.
          </div>
        )}
      </div>
    </Card>
  );
}
