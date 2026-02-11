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
