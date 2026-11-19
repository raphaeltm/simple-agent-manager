/**
 * Gemini function-calling compatibility checks for MCP tool input schemas.
 *
 * Gemini models reach sam-mcp through agents such as OpenCode, whose `opencode-go` provider
 * forwards tool schemas over an OpenAI-compatible transport to Vertex. Vertex accepts only an
 * OpenAPI subset of JSON Schema and rejects the whole request when one tool is invalid, so a
 * single bad property breaks every prompt on a Gemini model. On 2026-10-31 that property was
 * `create_agent_profile.runtime`:
 *
 *   Unable to submit request because `sam-mcp_create_agent_profile` functionDeclaration
 *   `parameters.runtime` schema specified other fields alongside any_of.
 */

export type JsonSchemaNode = Record<string, unknown>;

/** Keywords Vertex function declarations do not support and OpenCode forwards unchanged. */
const UNSUPPORTED_KEYWORDS = [
  'oneOf',
  'allOf',
  'const',
  'not',
  'if',
  'then',
  'else',
  '$ref',
  'patternProperties',
  'prefixItems',
] as const;

function isNode(value: unknown): value is JsonSchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns one `path: reason` entry per schema node Gemini would reject.
 *
 * - `type` must be a single string. OpenCode rewrites a type array into `anyOf` and keeps the
 *   node's other fields, which is the shape Vertex rejected.
 * - `anyOf` must be the only field of its node.
 * - Enum values must be strings. OpenCode stringifies them, so `enum: [1]` reaches the model as
 *   `"1"` and `enum: [..., null]` as `"null"`, neither of which a handler expects.
 */
export function findGeminiSchemaViolations(schema: unknown, path: string): string[] {
  const violations: string[] = [];
  const walk = (node: unknown, at: string) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${at}[${index}]`));
      return;
    }
    if (!isNode(node)) return;
    if (Array.isArray(node.type)) violations.push(`${at}: type array ${JSON.stringify(node.type)}`);
    if ('anyOf' in node) {
      const siblings = Object.keys(node).filter((key) => key !== 'anyOf');
      if (siblings.length > 0) violations.push(`${at}: anyOf alongside ${siblings.join(', ')}`);
    }
    for (const keyword of UNSUPPORTED_KEYWORDS) {
      if (keyword in node) violations.push(`${at}: unsupported keyword ${keyword}`);
    }
    if (Array.isArray(node.enum) && node.enum.some((value) => typeof value !== 'string')) {
      violations.push(`${at}: non-string enum ${JSON.stringify(node.enum)}`);
    }
    for (const [key, child] of Object.entries(node)) {
      // `properties` maps names to schemas; a property literally named `type` is not a keyword.
      if (key === 'properties' && isNode(child)) {
        for (const [name, property] of Object.entries(child)) walk(property, `${at}.${name}`);
      } else if (key !== 'enum' && key !== 'required') {
        walk(child, `${at}.${key}`);
      }
    }
  };
  walk(schema, path);
  return violations;
}

/**
 * The parts of OpenCode's Gemini sanitizer that change schema structure, ported from
 * `sanitizeGemini` in `packages/opencode/src/provider/transform.ts` (anomalyco/opencode
 * v1.18.32, the version SAM pins in `packages/vm-agent/internal/acp/gateway.go`). It runs for
 * every model whose id contains "gemini", whatever the transport.
 */
export function opencodeSanitizeGemini(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(opencodeSanitizeGemini);
  if (!isNode(node)) return node;
  const result: JsonSchemaNode = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'enum' && Array.isArray(value)) {
      result.enum = value.map((entry) => String(entry));
      if (result.type === 'integer' || result.type === 'number') result.type = 'string';
    } else {
      result[key] =
        typeof value === 'object' && value !== null ? opencodeSanitizeGemini(value) : value;
    }
  }
  if (Array.isArray(result.type)) {
    const types = result.type as unknown[];
    const nonNull = types.filter((entry) => entry !== 'null');
    if (nonNull.length === 0) {
      result.type = 'null';
    } else {
      delete result.type;
      result.anyOf = nonNull.map((entry) => ({ type: entry }));
      if (types.includes('null')) result.nullable = true;
    }
  }
  return result;
}

/** Vertex's `anyOf` rule, applied to a schema after OpenCode has sanitized it. */
export function findAnyOfWithSiblings(schema: unknown, path: string): string[] {
  return findGeminiSchemaViolations(schema, path).filter((violation) =>
    violation.includes(': anyOf alongside ')
  );
}
