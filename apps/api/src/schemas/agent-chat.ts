import * as v from 'valibot';

/**
 * Shared chat request schema for the two SAM-style agent chat endpoints:
 * apps/api/src/routes/project-agent.ts (POST /chat) and
 * apps/api/src/routes/sam.ts (POST /chat). Both handlers use
 * `body.message?.trim()` to require a non-empty message, tolerating an
 * explicit null the same way as a missing field — so `message` stays
 * optional+nullable here and the handler keeps its own check (and its
 * existing `{ error: 'Message is required' }` response shape) unchanged.
 * `conversationId` is forwarded to the DO as-is with no method calls on it
 * in the route, so it is left unknown.
 */
export const AgentChatRequestSchema = v.object({
  conversationId: v.optional(v.unknown()),
  message: v.optional(v.nullable(v.string())),
});
