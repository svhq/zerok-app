/**
 * v2 Serialization Module (Browser TypeScript)
 *
 * Provides canonical serialization for v2 withdrawals:
 * - 8 public inputs, all BE
 * - G2 limb ordering corrected
 * - Client-side A negation
 */

export const BN254_P = BigInt('21888242871839275222246405745257275088696311157297823662689037894645226208583');

/**
 * Convert a value to 32-byte big-endian Uint8Array
 */
export function toBE32(x: bigint | string | number): Uint8Array {
  const bigInt = typeof x === 'bigint' ? x : BigInt(x);
  if (bigInt >= BN254_P) {
    throw new Error(`Value ${x} exceeds field modulus`);
  }

  let hex = bigInt.toString(16);
  if (hex.length > 64) {
    throw new Error('Value too large for 32 bytes');
  }
  hex = hex.padStart(64, '0');

  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Convert u64 to 32-byte big-endian (last 8 bytes)
 */
export function u64ToBE32(x: bigint | string | number): Uint8Array {
  const bigInt = typeof x === 'bigint' ? x : BigInt(x);
  if (bigInt > 0xFFFFFFFFFFFFFFFFn) {
    throw new Error(`Value ${x} exceeds u64`);
  }

  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(24, bigInt);
  return bytes;
}

/**
 * Serialize Groth16 proof with client-side negation and G2 limb ordering fix
 */
export function serializeProof(proof: {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}): Uint8Array {
  // Negate A.Y with double-modulo for safety
  const aX = BigInt(proof.pi_a[0]);
  const aY = ((BN254_P - BigInt(proof.pi_a[1])) % BN254_P + BN254_P) % BN254_P;

  // G2 ordering: x1,x0,y1,y0 (canonical)
  // snarkjs gives [[x.c0, x.c1], [y.c0, y.c1]]
  // We need: [x.c1, x.c0, y.c1, y.c0]
  const [[bx0, bx1], [by0, by1]] = proof.pi_b;

  const proofA = new Uint8Array(64);
  proofA.set(toBE32(aX), 0);
  proofA.set(toBE32(aY), 32);

  const proofB = new Uint8Array(128);
  proofB.set(toBE32(BigInt(bx1)), 0);
  proofB.set(toBE32(BigInt(bx0)), 32);
  proofB.set(toBE32(BigInt(by1)), 64);
  proofB.set(toBE32(BigInt(by0)), 96);

  const proofC = new Uint8Array(64);
  proofC.set(toBE32(BigInt(proof.pi_c[0])), 0);
  proofC.set(toBE32(BigInt(proof.pi_c[1])), 32);

  const serialized = new Uint8Array(256);
  serialized.set(proofA, 0);
  serialized.set(proofB, 64);
  serialized.set(proofC, 192);

  return serialized;
}

/**
 * Pack 8 public inputs for v2 withdrawal
 */
export function packPublicInputs(witness: {
  root: string | bigint;
  nullifierHash: string | bigint;
  recipientHigh: string | bigint;
  recipientLow: string | bigint;
  protocolHigh: string | bigint;
  protocolLow: string | bigint;
  fee: string | bigint | number;
  refund: string | bigint | number;
}): Uint8Array {
  const packed = new Uint8Array(256);

  packed.set(toBE32(BigInt(witness.root)), 0);
  packed.set(toBE32(BigInt(witness.nullifierHash)), 32);
  packed.set(toBE32(BigInt(witness.recipientHigh)), 64);
  packed.set(toBE32(BigInt(witness.recipientLow)), 96);
  packed.set(toBE32(BigInt(witness.protocolHigh)), 128);
  packed.set(toBE32(BigInt(witness.protocolLow)), 160);
  packed.set(u64ToBE32(BigInt(witness.fee)), 192);
  packed.set(u64ToBE32(BigInt(witness.refund)), 224);

  return packed;
}

/**
 * Split Solana address (32 bytes) into two BE32 field elements
 */
export function addressToBE32Parts(address: Uint8Array): [bigint, bigint] {
  if (address.length !== 32) {
    throw new Error('Address must be 32 bytes');
  }

  // High: first 16 bytes, left-padded to 32
  const highBytes = new Uint8Array(32);
  highBytes.set(address.slice(0, 16), 16);

  // Low: last 16 bytes, left-padded to 32
  const lowBytes = new Uint8Array(32);
  lowBytes.set(address.slice(16, 32), 16);

  // Convert to BigInt
  let highHex = '';
  let lowHex = '';
  for (let i = 0; i < 32; i++) {
    highHex += highBytes[i].toString(16).padStart(2, '0');
    lowHex += lowBytes[i].toString(16).padStart(2, '0');
  }

  return [BigInt('0x' + highHex), BigInt('0x' + lowHex)];
}
