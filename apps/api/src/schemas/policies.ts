import * as v from 'valibot';

/**
 * Project policy request schemas (apps/api/src/routes/policies.ts).
 *
 * `category`/`source` are typed as strings because the handler passes them
 * directly to `isPolicyCategory`/`isPolicySource` (both `(value: string) =>
 * value is X` type guards) — those guards are safe for any string and
 * already produce their own specific error message on an invalid value, so
 * tightening the type only changes the message for a non-string body (a
 * case that would otherwise reach the guard's `string` parameter with an
 * incompatible type). `active`/`confidence` stay unknown: the handler
 * guards each with its own `typeof` check (safe for any input, TypeScript
 * narrows `unknown` through a `typeof` guard correctly) with its own
 * message, so there is nothing to gain from tightening them further.
 * `title`/`content` are typed as strings because the handler calls
 * `.trim()`/`.length` on them directly — a non-string, non-nullish value
 * throws today, so validating the type at the boundary turns that crash
 * into a normal 400. `sourceSessionId` is intentionally omitted: the REST
 * route never reads it (it always passes `null` for sourceSessionId — see
 * the "REST has no task context" comment in the route), so there's nothing
 * to validate.
 */

export const CreatePolicySchema = v.object({
  category: v.optional(v.string()),
  // Handler uses `body.title?.trim()` — optional chaining tolerates null.
  title: v.optional(v.nullable(v.string())),
  content: v.optional(v.nullable(v.string())),
  source: v.optional(v.string()),
  confidence: v.optional(v.unknown()),
  // `scope` is passed to the `isPolicyScope` type guard, same as category/source.
  scope: v.optional(v.string()),
  // `expiresAt` stays unknown: the handler guards it with its own `typeof` check
  // and then hands the pair to the shared `validatePolicyLifecycle`, which owns
  // the real error messages. Nullable because null means "never expires".
  expiresAt: v.optional(v.nullable(v.unknown())),
});

export const UpdatePolicySchema = v.object({
  // Handler uses `body.title.trim()` with no optional chaining — null throws today.
  title: v.optional(v.string()),
  content: v.optional(v.string()),
  category: v.optional(v.string()),
  active: v.optional(v.unknown()),
  confidence: v.optional(v.unknown()),
  scope: v.optional(v.string()),
  // On update, an explicit null clears the expiry (makes the policy permanent),
  // which is why this is nullable rather than merely optional.
  expiresAt: v.optional(v.nullable(v.unknown())),
});
