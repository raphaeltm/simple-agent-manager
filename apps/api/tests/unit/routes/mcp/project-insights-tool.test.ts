/**
 * The sam-mcp `project_insights` JSON schema is hand-written (sam-mcp tool definitions are static),
 * while the Connector derives its schema from the catalog operation `sam_project_insights`. This
 * keeps the two in step: same arguments (less `projectId`, which sam-mcp takes from the token) and
 * the same allowed values.
 */
import { operationInputJsonSchema, operations } from '@simple-agent-manager/operations';
import { describe, expect, it } from 'vitest';

import { INSIGHTS_TOOLS } from '../../../../src/routes/mcp/tool-definitions-insights-tools';

interface JsonSchema {
  properties: Record<string, { enum?: unknown[]; type?: string }>;
  required?: string[];
}

describe('project_insights tool schema', () => {
  const operation = operations.find((op) => op.name === 'sam_project_insights');
  const opSchema = operationInputJsonSchema(operation!) as JsonSchema;
  const toolSchema = INSIGHTS_TOOLS[0]!.inputSchema as unknown as JsonSchema;

  it('is the catalog operation the Connector lists', () => {
    expect(operation?.kind).toBe('read');
  });

  it('takes the operation arguments except projectId', () => {
    const opKeys = Object.keys(opSchema.properties).filter((key) => key !== 'projectId');
    expect(Object.keys(toolSchema.properties).sort()).toEqual(opKeys.sort());
    expect(toolSchema.required).toEqual(['method']);
  });

  it.each(['method', 'range', 'groupBy'])('offers the same %s values', (key) => {
    expect(toolSchema.properties[key]?.enum).toEqual(opSchema.properties[key]?.enum);
  });
});
