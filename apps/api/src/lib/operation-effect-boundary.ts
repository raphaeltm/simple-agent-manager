// Moved to the operations layer (`operations/operation-effect-boundary.ts`); this path re-exports it so existing
// importers keep working.
export {
  markRejectedBeforeEffects,
  takeRejectedBeforeEffects,
} from '../operations/operation-effect-boundary';
