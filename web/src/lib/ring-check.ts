/**
 * Root Validation - DEPRECATED
 *
 * This module is deprecated. Use root-acceptance.ts instead.
 *
 * All functionality has been moved to root-acceptance.ts which implements
 * the complete ACCEPTED_ROOT_SET check (STATE_ROOT_HISTORY ∪ SHARDED_ROOT_RING).
 *
 * This file re-exports for backward compatibility only.
 */

// Re-export everything from the new unified module
export { isRootInRing, isAcceptedRoot } from './root-acceptance';
export type { RootAcceptanceResult, RootSource } from './protocol-constants';
