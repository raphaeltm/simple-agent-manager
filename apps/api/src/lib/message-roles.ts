// Moved to the operations layer (`operations/message-roles.ts`); this path re-exports it so existing
// importers keep working.
export { type MessageRole, VALID_MESSAGE_ROLES, validateRoles } from '../operations/message-roles';
