/**
 * Custom Valibot validator hook for Hono that formats validation errors
 * to match the existing API error response format: { error: string, message: string }.
 */
import { vValidator } from '@hono/valibot-validator';
import * as v from 'valibot';
import type {
  GenericSchema,
  GenericSchemaAsync,
  InferOutput,
} from 'valibot';

/**
 * Formats Valibot issues into a human-readable error message string.
 */
function formatIssues(issues: v.BaseIssue<unknown>[]): string {
  return issues
    .map((issue) => {
      const path = issue.path?.map((p) => p.key).join('.') || 'body';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Wraps `vValidator` with a custom error hook that returns 400 with the standard
 * `{ error: "BAD_REQUEST", message: "..." }` format on validation failure.
 *
 * Use for routes where the request body is required and must be valid JSON.
 */
export function jsonValidator<T extends GenericSchema | GenericSchemaAsync>(schema: T) {
  return vValidator('json', schema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: 'BAD_REQUEST',
          message: formatIssues(result.issues),
        },
        400
      );
    }
  });
}

/**
 * Parses and validates an optional JSON body using Valibot.
 * Returns the fallback value if the body cannot be parsed as JSON.
 * Returns a validation error (400) if JSON parses but fails schema validation.
 *
 * Use for routes where the body may be empty/missing (the `.catch(() => ...)` pattern).
 */
export async function parseOptionalBody<T extends GenericSchema>(
  req: Request,
  schema: T,
  fallback: InferOutput<T>
): Promise<InferOutput<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fallback;
  }
  const result = v.safeParse(schema, raw);
  if (!result.success) {
    return fallback;
  }
  return result.output;
}

/** Type helper to extract the validated output type from a schema */
export type ValidatedBody<T extends GenericSchema | GenericSchemaAsync> = InferOutput<T>;
