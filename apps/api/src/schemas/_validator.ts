/**
 * Custom Valibot validator hook for Hono that formats validation errors
 * to match the existing API error response format: { error: string, message: string }.
 */
import { vValidator } from '@hono/valibot-validator';
import type {
  GenericSchema,
  GenericSchemaAsync,
  InferOutput,
} from 'valibot';

/**
 * Wraps `vValidator` with a custom error hook that returns 400 with the standard
 * `{ error: "BAD_REQUEST", message: "..." }` format on validation failure.
 */
export function jsonValidator<T extends GenericSchema | GenericSchemaAsync>(schema: T) {
  return vValidator('json', schema, (result, c) => {
    if (!result.success) {
      const issues = result.issues;
      const messages = issues.map((issue) => {
        const path = issue.path?.map((p) => p.key).join('.') || 'body';
        return `${path}: ${issue.message}`;
      });
      return c.json(
        {
          error: 'BAD_REQUEST',
          message: messages.join('; '),
        },
        400
      );
    }
  });
}

/** Type helper to extract the validated output type from a schema */
export type ValidatedBody<T extends GenericSchema | GenericSchemaAsync> = InferOutput<T>;
