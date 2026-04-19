/**
 * Parse DepositProofData event from Solana transaction logs
 *
 * Event format (emitted by deposit instruction):
 * - 8 bytes: event discriminator
 * - 4 bytes: leaf_index (u32 LE)
 * - 32 bytes: root_after
 * - 640 bytes: siblings_be (20 × 32 bytes)
 * - 20 bytes: positions
 */

import { Connection } from '@solana/web3.js';
import { executeWithRotation } from './resilient-connection';

export interface DepositEventData {
  leafIndex: number;
  rootAfter: string;      // hex string with 0x prefix
  siblings: string[];     // array of 20 hex strings with 0x prefix
  positions: number[];    // array of 20 path position bits
}

/**
 * Parse DepositProofData event from transaction logs
 */
export function parseDepositEventFromLogs(logs: string[]): DepositEventData | null {
  for (const log of logs) {
    if (log.includes('Program data:')) {
      // Anchor events are emitted as: "Program data: <base64>"
      const parts = log.split('Program data: ');
      if (parts.length < 2) continue;

      try {
        // Decode base64 to Uint8Array
        const base64 = parts[1];
        const binaryString = atob(base64);
        const data = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          data[i] = binaryString.charCodeAt(i);
        }

        // DepositProofData layout:
        // - 8 bytes: discriminator
        // - 4 bytes: u32 leaf_index (LE)
        // - 32 bytes: root_after
        // - 640 bytes: siblings_be (20 × 32 bytes)
        // - 20 bytes: positions
        const expectedSize = 8 + 4 + 32 + 640 + 20;
        if (data.length < expectedSize) {
          continue; // Not a DepositProofData event
        }

        let offset = 8; // Skip discriminator

        // Read leaf_index (u32 LE)
        const leafIndex = data[offset] |
                          (data[offset + 1] << 8) |
                          (data[offset + 2] << 16) |
                          (data[offset + 3] << 24);
        offset += 4;

        // Read root_after (32 bytes)
        const rootAfterBytes = data.slice(offset, offset + 32);
        const rootAfter = '0x' + Array.from(rootAfterBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        offset += 32;

        // Read siblings (20 × 32 bytes)
        const siblings: string[] = [];
        for (let i = 0; i < 20; i++) {
          const sibling = data.slice(offset, offset + 32);
          siblings.push('0x' + Array.from(sibling).map(b => b.toString(16).padStart(2, '0')).join(''));
          offset += 32;
        }

        // Read positions (20 bytes)
        const positions: number[] = [];
        for (let i = 0; i < 20; i++) {
          positions.push(data[offset + i]);
        }

        return { leafIndex, rootAfter, siblings, positions };

      } catch (error) {
        console.error('Failed to parse event data:', error);
      }
    }
  }

  return null;
}

/**
 * Parse ALL DepositProofData events from transaction logs.
 * V5 batch deposits emit one event per deposit instruction — a 6-note batch has 6 events.
 * Unlike parseDepositEventFromLogs (which returns only the first), this returns all of them.
 */
export function parseAllDepositEventsFromLogs(logs: string[]): DepositEventData[] {
  const events: DepositEventData[] = [];
  for (const log of logs) {
    if (!log.includes('Program data:')) continue;
    const parts = log.split('Program data: ');
    if (parts.length < 2) continue;
    try {
      const base64 = parts[1];
      const binaryString = atob(base64);
      const data = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) data[i] = binaryString.charCodeAt(i);

      const expectedSize = 8 + 4 + 32 + 640 + 20;
      if (data.length < expectedSize) continue;

      let offset = 8;
      const leafIndex = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24);
      offset += 4;
      const rootAfter = '0x' + Array.from(data.slice(offset, offset + 32)).map(b => b.toString(16).padStart(2, '0')).join('');
      offset += 32;
      const siblings: string[] = [];
      for (let i = 0; i < 20; i++) {
        siblings.push('0x' + Array.from(data.slice(offset, offset + 32)).map(b => b.toString(16).padStart(2, '0')).join(''));
        offset += 32;
      }
      const positions: number[] = [];
      for (let i = 0; i < 20; i++) positions.push(data[offset + i]);

      events.push({ leafIndex, rootAfter, siblings, positions });
    } catch { continue; }
  }
  return events;
}

/**
 * Random jitter to prevent thundering herd on RPC endpoints
 * Ported from CLI: deposit.js line 575-576
 */
async function randomJitter(minMs: number, maxMs: number): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs);
  await new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Fetch transaction and parse DepositProofData event
 * Uses executeWithRotation internally for high rate limits via Helius.
 *
 * Added jitter (2026-01-10): Prevents thundering herd when multiple
 * deposits complete simultaneously and all call getTransaction at once.
 *
 * @param _connection - Unused, kept for API compatibility (uses executeWithRotation internally)
 * @param signature - Transaction signature to fetch
 */
// ─── v2 event types ─────────────────────────────────────────────────────────

export interface V2DepositEvent {
  leafIndex: number;
  commitment: string;   // hex, no prefix
  newRoot: string;       // hex, no prefix
  amount: bigint;
  /** Merkle path siblings (20 × hex strings). Present if event includes full path data. */
  siblings?: string[];
}

export interface V2WithdrawEvent {
  nullifierHash: string; // hex, no prefix
  outCommitment: string; // hex, no prefix
  leafIndex: number;
  withdrawalAmount: bigint;
  feeAmount: bigint;
  newRoot: string;       // hex, no prefix
}

// Anchor event discriminators — SHA256("event:<Name>")[0..8], computed lazily
let _discDeposit: Uint8Array | null = null;
let _discWithdraw: Uint8Array | null = null;

async function getV2Discriminators(): Promise<{ deposit: Uint8Array; withdraw: Uint8Array }> {
  if (!_discDeposit) {
    const enc = new TextEncoder();
    const dData = enc.encode('event:DepositEventV2');
    const wData = enc.encode('event:WithdrawEventV2');
    const [dBuf, wBuf] = await Promise.all([
      crypto.subtle.digest('SHA-256', dData.buffer.slice(dData.byteOffset, dData.byteOffset + dData.byteLength) as ArrayBuffer),
      crypto.subtle.digest('SHA-256', wData.buffer.slice(wData.byteOffset, wData.byteOffset + wData.byteLength) as ArrayBuffer),
    ]);
    _discDeposit  = new Uint8Array(dBuf).slice(0, 8);
    _discWithdraw = new Uint8Array(wBuf).slice(0, 8);
  }
  return { deposit: _discDeposit, withdraw: _discWithdraw! };
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function readU32LE(data: Uint8Array, off: number): number {
  return data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24);
}

function readU64LE(data: Uint8Array, off: number): bigint {
  const lo = BigInt(data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24)) & 0xFFFFFFFFn;
  const hi = BigInt(data[off + 4] | (data[off + 5] << 8) | (data[off + 6] << 16) | (data[off + 7] << 24)) & 0xFFFFFFFFn;
  return lo | (hi << 32n);
}

function discMatch(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < 8; i++) { if (a[i] !== b[i]) return false; }
  return true;
}

/**
 * Parse DepositEventV2 from v2 transaction logs.
 * Layout: disc(8) + leaf_index(4 LE) + commitment(32 BE) + new_root(32 BE) + amount(8 LE) + siblings(20×32 BE)
 * Total: 84 bytes (without siblings) or 724 bytes (with siblings)
 */
export async function parseV2DepositEventFromLogs(logs: string[]): Promise<V2DepositEvent | null> {
  const { deposit: disc } = await getV2Discriminators();
  for (const log of logs) {
    if (!log.includes('Program data:')) continue;
    const parts = log.split('Program data: ');
    if (parts.length < 2) continue;
    try {
      const bin = atob(parts[1]);
      const data = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      if (data.length < 84) continue;
      if (!discMatch(data.slice(0, 8), disc)) continue;

      const event: V2DepositEvent = {
        leafIndex:  readU32LE(data, 8),
        commitment: bytesToHex(data.slice(12, 44)),
        newRoot:    bytesToHex(data.slice(44, 76)),
        amount:     readU64LE(data, 76),
      };

      // Extract siblings if present (20 × 32 bytes starting at offset 84)
      if (data.length >= 724) {
        const siblings: string[] = [];
        for (let i = 0; i < 20; i++) {
          const off = 84 + i * 32;
          siblings.push(bytesToHex(data.slice(off, off + 32)));
        }
        event.siblings = siblings;
      }

      return event;
    } catch { continue; }
  }
  return null;
}

/**
 * Parse WithdrawEventV2 from v2 transaction logs.
 * Layout: disc(8) + nullifier_hash(32 BE) + out_commitment(32 BE) + leaf_index(4 LE)
 *         + withdrawal_amount(8 LE) + fee_amount(8 LE) + new_root(32 BE) = 124 bytes
 */
export async function parseV2WithdrawEventFromLogs(logs: string[]): Promise<V2WithdrawEvent | null> {
  const { withdraw: disc } = await getV2Discriminators();
  for (const log of logs) {
    if (!log.includes('Program data:')) continue;
    const parts = log.split('Program data: ');
    if (parts.length < 2) continue;
    try {
      const bin = atob(parts[1]);
      const data = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      if (data.length < 124) continue;
      if (!discMatch(data.slice(0, 8), disc)) continue;
      return {
        nullifierHash:    bytesToHex(data.slice(8, 40)),
        outCommitment:    bytesToHex(data.slice(40, 72)),
        leafIndex:        readU32LE(data, 72),
        withdrawalAmount: readU64LE(data, 76),
        feeAmount:        readU64LE(data, 84),
        newRoot:          bytesToHex(data.slice(92, 124)),
      };
    } catch { continue; }
  }
  return null;
}

export async function parseDepositEvent(
  _connection: Connection,
  signature: string
): Promise<DepositEventData> {
  // Rate limiting is now applied inside executeWithRotation() for ALL RPC calls.
  // Additional jitter to prevent thundering herd when multiple
  // operations complete simultaneously.
  await randomJitter(100, 500);

  // Use Helius first (better rate limits than Solana Public)
  const tx = await executeWithRotation(
    (conn) => conn.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    })
  );

  if (!tx) {
    throw new Error(`Transaction not found: ${signature}`);
  }

  if (!tx.meta) {
    throw new Error(`Transaction metadata not available: ${signature}`);
  }

  if (!tx.meta.logMessages) {
    throw new Error(`Transaction logs not available: ${signature}`);
  }

  // Parse event from logs
  const eventData = parseDepositEventFromLogs(tx.meta.logMessages);

  if (!eventData) {
    throw new Error(`DepositProofData event not found in transaction logs`);
  }

  return eventData;
}
