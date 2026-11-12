// Moved to @simple-agent-manager/agent-email (worker modularization W6). This file keeps the
// old import path.
export {
  acceptDelivery,
  type ClaimedDelivery,
  claimForRetry,
  type ClosedDelivery,
  closeDelivery,
  closeExhausted,
  dueDeliveries,
  heldBy,
  type IntakeResult,
  type IntakeValues,
  ownsLease,
  recordIntake,
  retryDelayMs,
  scheduleRetry,
  type StoredInboundEmail,
} from '@simple-agent-manager/agent-email';
