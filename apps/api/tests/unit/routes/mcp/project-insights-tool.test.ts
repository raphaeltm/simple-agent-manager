/**
 * The sam-mcp `project_insights` JSON schema is hand-written (sam-mcp tool definitions are static),
 * while the Connector derives its schema from the catalog operation `sam_project_insights`. This
 * keeps the two in step: same arguments (less `projectId`, which sam-mcp takes from the token) and
 * the same constraints, so a call the advertised schema accepts is one the handler accepts.
 */
import { operationInputJsonSchema, operations } from '@simple-agent-manager/operations';
import { describe, expect, it } from 'vitest';

import { INSIGHTS_TOOLS } from '../../../../src/routes/mcp/tool-definitions-insights-tools';

interface JsonSchema {
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
}

/**
 * A property's constraints: everything but the human description. The tool also states
 * `type: 'string'` beside an enum, which the derived schema leaves implicit.
 */
function constraints(property: Record<string, unknown> | undefined): Record<string, unknown> {
  const rest = { ...property };
  delete rest.description;
  if (rest.enum !== undefined && rest.type === 'string') delete rest.type;
  return rest;
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

  it.each([
    'method',
    'taskId',
    'range',
    'groupBy',
    'skillId',
    'agentProfileId',
    'operation',
    'phaseNames',
    'windowDays',
  ])('advertises the same constraints for %s', (key) => {
    expect(constraints(toolSchema.properties[key])).toEqual(constraints(opSchema.properties[key]));
  });
});
