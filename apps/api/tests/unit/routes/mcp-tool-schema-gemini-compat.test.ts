import { describe, expect, it } from 'vitest';

import { MCP_TOOLS } from '../../../src/routes/mcp/tool-definitions';
import {
  findAnyOfWithSiblings,
  findGeminiSchemaViolations,
  opencodeSanitizeGemini,
} from '../../helpers/gemini-tool-schema';

type Tool = { name: string; inputSchema: Record<string, unknown> };
const tools = MCP_TOOLS as unknown as Tool[];

function tool(name: string): Tool {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`MCP_TOOLS has no tool named ${name}`);
  return found;
}

function property(toolName: string, name: string): Record<string, unknown> {
  const properties = tool(toolName).inputSchema.properties as Record<
    string,
    Record<string, unknown>
  >;
  return properties[name]!;
}

// The exact shape that failed every OpenCode prompt on gemini-4-argon on 2026-10-31.
const PRE_FIX_RUNTIME = {
  type: ['string', 'null'],
  enum: ['vm', 'cf-container', null],
  description: 'Execution runtime: vm or cf-container. Use null to inherit the default.',
};

describe('sam-mcp tool schemas are accepted by Gemini function calling', () => {
  it('flags the pre-fix create_agent_profile.runtime shape, before and after OpenCode sanitizes it', () => {
    expect(findGeminiSchemaViolations(PRE_FIX_RUNTIME, 'runtime')).toEqual([
      'runtime: type array ["string","null"]',
      'runtime: non-string enum ["vm","cf-container",null]',
    ]);
    // What Vertex actually received: anyOf next to enum, description and nullable.
    expect(findAnyOfWithSiblings(opencodeSanitizeGemini(PRE_FIX_RUNTIME), 'runtime')).toEqual([
      'runtime: anyOf alongside enum, description, nullable',
    ]);
  });

  it.each(tools.map((candidate) => [candidate.name, candidate] as const))(
    '%s has no Gemini-incompatible schema node',
    (name, candidate) => {
      expect(findGeminiSchemaViolations(candidate.inputSchema, name)).toEqual([]);
      expect(findAnyOfWithSiblings(opencodeSanitizeGemini(candidate.inputSchema), name)).toEqual(
        []
      );
    }
  );

  it('covers the whole tool list, including the tool that failed', () => {
    expect(tools.length).toBeGreaterThan(100);
    expect(property('create_agent_profile', 'runtime')).toBeDefined();
  });

  it.each([
    ['create_agent_profile', 'runtime'],
    ['update_agent_profile', 'runtime'],
    ['update_agent_profile', 'resourceRequirements'],
    ['update_skill', 'agentType'],
    ['update_trigger', 'vmSizeOverride'],
    ['update_trigger', 'description'],
    ['update_policy', 'expiresAt'],
    ['dispatch_task', 'devcontainerConfigName'],
  ])('%s.%s still offers null, so an update can clear the field', (toolName, name) => {
    const branches = property(toolName, name).anyOf as Array<Record<string, unknown>>;
    expect(branches).toContainEqual({ type: 'null' });
    const valueBranch = branches.find((branch) => branch.type !== 'null')!;
    expect(valueBranch.description).toEqual(expect.any(String));
    expect(JSON.stringify(valueBranch.enum ?? [])).not.toContain('null');
  });

  it('keeps the runtime values on the non-null branch', () => {
    const branches = property('create_agent_profile', 'runtime').anyOf as Array<
      Record<string, unknown>
    >;
    expect(branches[0]).toMatchObject({ type: 'string', enum: ['vm', 'cf-container'] });
  });
});
