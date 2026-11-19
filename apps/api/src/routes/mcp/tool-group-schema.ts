/**
 * Builds the listed definition of each domain tool group from the member tools'
 * definitions, so a group schema cannot drift from the handlers it routes to.
 *
 * A group's input schema is a required `method` enum plus the union of its members'
 * properties. Each property description says which methods use it and which require it.
 * Two members declaring the same property name with different schemas is a build error
 * (the group could not pass one value that both handlers accept), except a create/update
 * pair where only one member also accepts `null` (see `mergeShapes`).
 */
import type { McpToolGroup } from './tool-groups';

type JsonSchema = Record<string, unknown>;

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
    readonly [key: string]: unknown;
  };
}

function withoutDescriptions(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutDescriptions);
  if (!schema || typeof schema !== 'object') return schema;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema as JsonSchema)) {
    if (key !== 'description') out[key] = withoutDescriptions(value);
  }
  return out;
}

function sameShape(a: unknown, b: unknown): boolean {
  return JSON.stringify(withoutDescriptions(a)) === JSON.stringify(withoutDescriptions(b));
}

/** True when the property schema admits JSON `null`. */
export function schemaAcceptsNull(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const node = schema as JsonSchema;
  if (node.type === 'null') return true;
  if (Array.isArray(node.type) && node.type.includes('null')) return true;
  return Array.isArray(node.anyOf) && node.anyOf.some((branch) => schemaAcceptsNull(branch));
}

/** The non-null branch of an `anyOf: [X, { type: 'null' }]` schema, else undefined. */
function nonNullBranch(schema: unknown): unknown {
  const anyOf = (schema as JsonSchema | undefined)?.anyOf;
  if (!Array.isArray(anyOf) || anyOf.length !== 2) return undefined;
  const others = anyOf.filter((branch) => (branch as JsonSchema).type !== 'null');
  return others.length === 1 ? others[0] : undefined;
}

/**
 * Merges two member schemas for one property. Identical shapes merge; a create/update
 * pair where only the update accepts `null` (to clear the field) merges to the nullable
 * form, and the dispatcher rejects `null` for the methods whose member does not accept it.
 */
function mergeShapes(existing: unknown, incoming: unknown): unknown | undefined {
  if (sameShape(existing, incoming)) return existing;
  if (sameShape(nonNullBranch(existing), incoming)) return existing;
  if (sameShape(nonNullBranch(incoming), existing)) return incoming;
  return undefined;
}

/**
 * Appends method usage to a property description. An `anyOf` property keeps its
 * descriptions on the branches: Gemini rejects `anyOf` with sibling keys.
 */
function describeUsage(schema: JsonSchema, usage: string): JsonSchema {
  if (Array.isArray(schema.anyOf)) {
    return {
      ...schema,
      anyOf: (schema.anyOf as JsonSchema[]).map((branch) =>
        branch.type === 'null'
          ? branch
          : { ...branch, description: [branch.description, usage].filter(Boolean).join(' ') }
      ),
    };
  }
  return { ...schema, description: [schema.description, usage].filter(Boolean).join(' ') };
}

export function buildGroupDefinition(
  group: McpToolGroup,
  toolsByName: ReadonlyMap<string, McpToolDefinition>
): McpToolDefinition {
  const merged = new Map<string, { schema: JsonSchema; methods: string[]; requiredBy: string[] }>();

  for (const [method, { tool }] of Object.entries(group.methods)) {
    const member = toolsByName.get(tool);
    if (!member) throw new Error(`MCP tool group ${group.name}: unknown member tool ${tool}`);
    const required = new Set(member.inputSchema.required ?? []);
    for (const [prop, schema] of Object.entries(member.inputSchema.properties ?? {})) {
      if (prop === 'method') {
        throw new Error(`MCP tool group ${group.name}: member ${tool} declares 'method'`);
      }
      const entry = merged.get(prop);
      const mergedSchema = entry ? mergeShapes(entry.schema, schema) : schema;
      if (mergedSchema === undefined) {
        throw new Error(
          `MCP tool group ${group.name}: property '${prop}' differs between ${entry?.methods.join(', ')} and ${method}`
        );
      }
      const target = entry ?? { schema: schema as JsonSchema, methods: [], requiredBy: [] };
      target.schema = mergedSchema as JsonSchema;
      target.methods.push(method);
      if (required.has(prop)) target.requiredBy.push(method);
      merged.set(prop, target);
    }
  }

  const methodNames = Object.keys(group.methods);
  const properties: Record<string, unknown> = {
    method: {
      type: 'string',
      enum: methodNames,
      description: 'Operation to run. Each method is described in the tool description.',
    },
  };
  for (const [prop, { schema, methods, requiredBy }] of merged) {
    const usage = methods.length === methodNames.length ? '' : `(Methods: ${methods.join(', ')}.)`;
    const requirement = requiredBy.length ? `Required for: ${requiredBy.join(', ')}.` : '';
    const note = [usage, requirement].filter(Boolean).join(' ');
    properties[prop] = note ? describeUsage(schema, note) : schema;
  }

  const methodLines = Object.entries(group.methods)
    .map(([method, { summary }]) => `${method}: ${summary}.`)
    .join(' ');
  const formerNames = Object.values(group.methods)
    .map(({ tool }) => tool)
    .join(', ');

  return {
    name: group.name,
    description: `${group.summary} Methods: ${methodLines} Replaces the tools ${formerNames}.`,
    inputSchema: {
      type: 'object',
      properties,
      required: ['method'],
      additionalProperties: false,
    },
  };
}

/** Member tool name → its group and method name. */
export function indexGroupMembers(
  groups: readonly McpToolGroup[]
): ReadonlyMap<string, { group: string; method: string }> {
  const index = new Map<string, { group: string; method: string }>();
  for (const group of groups) {
    for (const [method, { tool }] of Object.entries(group.methods)) {
      const existing = index.get(tool);
      if (existing) {
        throw new Error(`MCP tool ${tool} is in both ${existing.group} and ${group.name}`);
      }
      index.set(tool, { group: group.name, method });
    }
  }
  return index;
}
