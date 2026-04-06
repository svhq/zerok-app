/**
 * TypeScript declarations for sdk/v2-core shared modules.
 * These CJS modules are resolved via webpack alias 'v2-core' → '../sdk/v2-core'.
 */

declare module 'v2-core/constants' {
  export const TREE_DEPTH: number;
  export const ROOT_HISTORY_SIZE: number;
  export const BN254_P: bigint;
  export const FIELD_MODULUS: bigint;
  export const ZERO_CHAIN_BE: string[];
  export const STATE_OFFSETS_V2: {
    DISC: number; VERSION: number; PAUSED: number; VK_FINALIZED: number;
    PAD0: number; DENOMINATION: number; AUTHORITY: number; PROTOCOL_WALLET: number;
    VK_ACCOUNT: number; VK_HASH: number; VK_UPLOADED_BYTES: number; PAD1: number;
    MAX_FEE_BPS: number; PAD2: number; LEAF_COUNT: number; ROOT_INDEX: number;
    FRONTIER: number; CURRENT_ROOT: number; ROOT_HISTORY: number;
  };
  export const ACCOUNT_SIZES_V2: { STATE: number; VK: number; NULLIFIER: number };
  export const SEEDS_V2: { STATE: string; VAULT: string; VK: string; NULLIFIER: string };
  export const DENOMINATIONS: bigint[];
  export const MEMO_PREFIX_V2: string;
  export const MEMO_PREFIX_BATCH: string;
}

declare module 'v2-core/field' {
  export function bytesToHex(bytes: Uint8Array): string;
  export function hexToBytes(hex: string): Uint8Array;
  export function uint8ToBase64(bytes: Uint8Array): string;
  export function base64ToUint8(b64: string): Uint8Array;
  export function concatBytes(...arrays: Uint8Array[]): Uint8Array;
  export function hexToFr(hex: string): bigint;
  export function fieldToBytesBE(bn: bigint): Uint8Array;
  export function splitAddress(pubkeyBytes: Uint8Array): { high: bigint; low: bigint };
  export function randomFieldElement(): bigint;
}

declare module 'v2-core/fee' {
  export const RELAY_FEE_BPS: bigint;
  export const MIN_RELAY_FEE: bigint;
  export function calculateRelayFee(amountLamports: bigint): bigint;
}

declare module 'v2-core/planner' {
  export function greedySplit(lamports: bigint | number): bigint[];
  export function getInventory(notes: Array<{ amount: string | bigint; status?: string; spent?: boolean; [key: string]: any }>): Record<string, any[]>;
  export function planWithdrawal(amountLamports: bigint, inventory: Record<string, any[]>): {
    directSteps: bigint[];
    redenomSteps: Array<{ sourceDenom: bigint; targetDenom: bigint }>;
    error: string | null;
  };
}

declare module 'v2-core/merkle' {
  export function readLeafCount(data: Uint8Array): number;
  export function readCurrentRoot(data: Uint8Array): string;
  export function readFrontier(data: Uint8Array): string[];
  export function readVkFinalized(data: Uint8Array): boolean;
  export function readRootHistory(data: Uint8Array): string[];
  export function isRootInHistory(noteRootHex: string, poolData: Uint8Array): boolean;
  export function computeMerklePath(leafIndex: number, frontier: string[]): {
    pathElements: bigint[];
    pathIndices: number[];
  };
  export function computeBatchMerklePaths(
    poseidon: any, commitments: bigint[], firstLeafIndex: number, preFrontier: string[]
  ): Array<{ pathElements: bigint[]; pathIndices: number[]; root: string }>;
  export function computeRoot(poseidon: any, leaf: bigint, pathElements: bigint[], pathIndices: number[]): bigint;
}

declare module 'v2-core/note' {
  export function computeCommitment(poseidon: any, amount: bigint, nullifier: bigint, secret: bigint): bigint;
  export function computeNullifierHash(poseidon: any, nullifier: bigint): bigint;
  export function generateNote(amountLamports: bigint): { amount: bigint; nullifier: bigint; secret: bigint };
  export function buildNote(
    poseidon: any, amountLamports: bigint, leafIndex: number,
    merkleRoot: string, pathElements: bigint[], pathIndices: number[]
  ): any;
  export function noteToMemoPayload(note: any): any;
  export function changeNoteToMemoPayload(changeNote: any): any;
  export function memoPayloadToNote(payload: any): any;
  export function encodeMemoPayload(payload: any): string;
  export function decodeMemoPayload(memo: string): any | null;
}

declare module 'v2-core/proof-serialize' {
  export function serializeProof(proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }): Uint8Array;
  export function g2ToBE(coords: string[][]): Uint8Array;
}

declare module 'v2-core/witness' {
  export function buildJoinSplitWitness(poseidon: any, params: {
    inputNote: any;
    merkleRoot: string;
    withdrawalAmount: bigint;
    feeAmount: bigint;
    recipientBytes: Uint8Array;
    relayerBytes: Uint8Array;
  }): {
    witness: Record<string, string | string[]>;
    changeNote: any;
    nullifierHash: bigint;
    outCommitment: bigint;
  };
  export function buildReDenomWitness(poseidon: any, params: {
    inputNote: any;
    sourceDenom: bigint;
    targetDenom: bigint;
    merkleRoot: string;
    pathElements: bigint[];
    pathIndices: number[];
  }): {
    witness: Record<string, string | string[]>;
    targetNotes: any[];
    targetCommitments: bigint[];
    nullifierHash: bigint;
  };
}

declare module 'v2-core/relay' {
  export function submitToRelay(relayUrl: string, request: {
    proofBytes: Uint8Array;
    nullifierHash: Uint8Array;
    rootHex: string;
    withdrawalAmount: bigint;
    feeAmount: bigint;
    outCommitment: Uint8Array;
    recipientBase58: string;
    memoText: string | null;
  }, options?: { retryDelayMs?: number; maxRetries?: number }): Promise<{
    signature: string; leafIndex: number; newRoot: string;
  }>;
  export function submitReDenomToRelay(relayUrl: string, redenomData: {
    proofBytes: Uint8Array;
    nullifierHashBytes: Uint8Array;
    sourceRoot: string;
    targetCommitmentBytes: Uint8Array[];
  }, sourceDenom: bigint, targetDenom: bigint, options?: any): Promise<{ signature: string }>;
}
