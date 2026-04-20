/**
 * ZeroK v2-core — Relay Client
 *
 * Cross-environment relay communication using fetch().
 * Works in both Node 20+ and browser.
 */

'use strict';

const { fieldToBytesBE, uint8ToBase64, hexToBytes } = require('./field.js');

/**
 * Submit a JoinSplit withdrawal to the protocol relay.
 *
 * @param {string} relayUrl - Base relay URL
 * @param {Object} request
 * @param {Uint8Array} request.proofBytes       - 256-byte serialized proof
 * @param {Uint8Array} request.nullifierHash    - 32-byte nullifier hash
 * @param {string}     request.rootHex          - Merkle root hex (no 0x prefix)
 * @param {bigint}     request.withdrawalAmount - Lamports being withdrawn
 * @param {bigint}     request.feeAmount        - Protocol fee in lamports
 * @param {Uint8Array} request.outCommitment    - 32-byte change note commitment
 * @param {string}     request.recipientBase58  - Recipient address (base58)
 * @param {string|null} request.memoText        - Encrypted change note memo (optional)
 * @param {Object}    [options]
 * @param {number}    [options.retryDelayMs=500] - Base delay between retries
 * @param {number}    [options.maxRetries=3]     - Max retry attempts on 409
 * @returns {Promise<{ signature: string, leafIndex: number, newRoot: string }>}
 */
async function submitToRelay(relayUrl, request, options = {}) {
  const { retryDelayMs = 500, maxRetries = 3 } = options;
  const url = `${relayUrl.replace(/\/$/, '')}/v2/withdraw`;

  const body = JSON.stringify({
    proof:                   uint8ToBase64(request.proofBytes),
    nullifierHash:           uint8ToBase64(request.nullifierHash),
    root:                    uint8ToBase64(hexToBytes(request.rootHex)),
    publicWithdrawalAmount:  Number(request.withdrawalAmount),
    feeAmount:               Number(request.feeAmount),
    outCommitment:           uint8ToBase64(request.outCommitment),
    recipient:               request.recipientBase58,
    memoText:                request.memoText,
  });

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    const result = await response.json();

    // Retry on 409 (relay still processing previous withdrawal)
    if (response.status === 409 && attempt < maxRetries - 1) {
      await new Promise(r => setTimeout(r, retryDelayMs * (attempt + 1)));
      continue;
    }

    if (!response.ok || result.error || !result.signature) {
      throw new Error(`Relay error (${response.status}): ${result.error || result.message || JSON.stringify(result)}`);
    }

    return result;
  }
}

/**
 * Submit a re-denomination to the relay.
 *
 * @param {string} relayUrl
 * @param {Object} redenomData
 * @param {Uint8Array} redenomData.proofBytes          - Serialized proof
 * @param {Uint8Array} redenomData.nullifierHashBytes  - Source nullifier hash
 * @param {string}     redenomData.sourceRoot          - Source pool root (hex)
 * @param {Uint8Array[]} redenomData.targetCommitmentBytes - 10 × 32-byte commitments
 * @param {bigint} sourceDenom
 * @param {bigint} targetDenom
 * @param {Object} [options]
 * @returns {Promise<{ signature: string }>}
 */
async function submitReDenomToRelay(relayUrl, redenomData, sourceDenom, targetDenom, options = {}) {
  const { proofBytes, nullifierHashBytes, sourceRoot, targetCommitmentBytes } = redenomData;

  // Concatenate all 10 target commitments into one flat array
  let totalLen = 0;
  for (const c of targetCommitmentBytes) totalLen += c.length;
  const commitFlat = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of targetCommitmentBytes) {
    commitFlat.set(c, offset);
    offset += c.length;
  }

  const response = await fetch(`${relayUrl}/v2/re-denominate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proof: uint8ToBase64(proofBytes),
      sourceNullifierHash: uint8ToBase64(nullifierHashBytes),
      sourceRoot: uint8ToBase64(hexToBytes(sourceRoot)),
      targetCommitmentsFlat: uint8ToBase64(commitFlat),
      sourceDenomination: Number(sourceDenom),
      targetDenomination: Number(targetDenom),
    }),
  });

  const result = await response.json();
  if (!response.ok || result.error) {
    throw new Error(`Relay re-denomination failed: ${result.error || result.message || response.status}`);
  }

  return result;
}

module.exports = { submitToRelay, submitReDenomToRelay };
