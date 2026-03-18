import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';

describe('MCP Server Integration', () => {
  let server: McpServer;
  let client: Client;
  let cleanup: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    server = new McpServer({ name: 'test-workspace-mcp', version: '1.0.0' });

    // Register a test tool that mimics the workspace-mcp pattern
    server.tool(
      'get_workspace_info',
      'Get workspace info',
      {},
      async () => ({
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ workspaceId: 'ws-test', mode: 'task' }),
        }],
      }),
    );

    server.tool(
      'expose_port',
      'Expose a port',
      { port: z.number(), label: z.string().optional() },
      async (args) => ({
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ port: args.port, externalUrl: `https://ws-test--${args.port}.example.com` }),
        }],
      }),
    );

    // Create linked in-memory transports
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: 'test-client', version: '1.0.0' });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    cleanup = async () => {
      await client.close();
      await server.close();
    };
  });

  afterEach(async () => {
    if (cleanup) await cleanup();
  });

  it('discovers all registered tools', async () => {
    const tools = await client.listTools();

    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toContain('get_workspace_info');
    expect(toolNames).toContain('expose_port');
  });

  it('calls a tool with no arguments and gets structured result', async () => {
    const result = await client.callTool({ name: 'get_workspace_info', arguments: {} });

    expect(result.content).toHaveLength(1);
    const textContent = result.content[0] as { type: string; text: string };
    expect(textContent.type).toBe('text');

    const parsed = JSON.parse(textContent.text);
    expect(parsed.workspaceId).toBe('ws-test');
    expect(parsed.mode).toBe('task');
  });

  it('calls a tool with arguments and gets correct result', async () => {
    const result = await client.callTool({
      name: 'expose_port',
      arguments: { port: 3000, label: 'dev server' },
    });

    const textContent = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(textContent.text);
    expect(parsed.port).toBe(3000);
    expect(parsed.externalUrl).toBe('https://ws-test--3000.example.com');
  });
});
