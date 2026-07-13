import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { OpenApiDocument } from '../../../src/openapi/sam-cli';
import { samCliOpenApiDocument } from '../../../src/openapi/sam-cli';
import { cliRoutes } from '../../../src/routes/cli';

type SchemaLike = {
  $ref?: string;
  type?: string | string[];
  format?: string;
  items?: SchemaLike;
  properties?: Record<string, SchemaLike>;
};

function schema(name: string): SchemaLike {
  const value = samCliOpenApiDocument.components.schemas[name];
  expect(value, `Missing schema ${name}`).toBeDefined();
  return value as SchemaLike;
}

function property(source: SchemaLike, name: string): SchemaLike {
  const value = source.properties?.[name];
  expect(value, `Missing property ${name}`).toBeDefined();
  return value as SchemaLike;
}

function arrayItem(source: SchemaLike): SchemaLike {
  expect(source.type).toBe('array');
  expect(source.items).toBeDefined();
  return source.items as SchemaLike;
}

function refName(source: SchemaLike): string {
  expect(source.$ref, 'Expected a schema reference').toBeDefined();
  return source.$ref?.replace('#/components/schemas/', '') ?? '';
}

function responseSchema(path: string, method: 'get' | 'post', status: string): SchemaLike {
  const operation = samCliOpenApiDocument.paths[path]?.[method];
  expect(operation, `Missing ${method.toUpperCase()} ${path}`).toBeDefined();
  const content = operation?.responses[status]?.content?.['application/json'];
  expect(
    content,
    `Missing JSON response ${status} for ${method.toUpperCase()} ${path}`
  ).toBeDefined();
  return content?.schema as SchemaLike;
}

describe('SAM CLI OpenAPI contract', () => {
  const requiredOperations: Array<[string, 'get' | 'post']> = [
    ['/api/auth/token-login', 'post'],
    ['/api/auth/device/code', 'post'],
    ['/api/auth/device/token', 'post'],
    ['/api/projects', 'get'],
    ['/api/projects/{projectId}', 'get'],
    ['/api/projects/{projectId}/sessions', 'get'],
    ['/api/projects/{projectId}/sessions/{sessionId}', 'get'],
    ['/api/projects/{projectId}/tasks/submit', 'post'],
    ['/api/projects/{projectId}/tasks', 'get'],
    ['/api/projects/{projectId}/tasks/{taskId}', 'get'],
    ['/api/projects/{projectId}/library', 'get'],
    ['/api/projects/{projectId}/knowledge', 'get'],
    ['/api/notifications', 'get'],
    ['/api/projects/{projectId}/triggers', 'get'],
    ['/api/projects/{projectId}/agent-profiles', 'get'],
    ['/api/projects/{projectId}/activity', 'get'],
    ['/api/nodes', 'get'],
    ['/api/workspaces/{id}', 'get'],
    ['/api/workspaces/{id}/ports', 'get'],
    ['/api/workspaces/{id}/port-access', 'get'],
  ];

  it('declares every CLI-facing path and method', () => {
    for (const [path, method] of requiredOperations) {
      expect(
        samCliOpenApiDocument.paths[path]?.[method],
        `${method.toUpperCase()} ${path}`
      ).toBeDefined();
    }
  });

  it('keeps drift-sensitive response fields in the contract', () => {
    const profileList = schema('ListAgentProfilesResponse');
    expect(refName(arrayItem(property(profileList, 'items')))).toBe('AgentProfile');

    const nodeList = responseSchema('/api/nodes', 'get', '200');
    expect(refName(arrayItem(nodeList))).toBe('Node');

    const file = schema('ProjectFile');
    expect(property(file, 'sizeBytes').type).toBe('integer');
    expect(property(file, 'uploadSource').type).toBe('string');
    expect(property(file, 'createdAt').format).toBe('date-time');

    const knowledgeEntity = schema('KnowledgeEntity');
    expect(property(knowledgeEntity, 'name').type).toBe('string');
    expect(property(knowledgeEntity, 'entityType').type).toBe('string');
    expect(property(knowledgeEntity, 'updatedAt').type).toBe('integer');

    const trigger = schema('Trigger');
    expect(property(trigger, 'cronExpression').type).toBe('string');
    expect(property(trigger, 'nextFireAt').format).toBe('date-time');
    expect(refName(property(trigger, 'webhookConfig'))).toBe('WebhookTriggerConfig');

    const webhookConfig = schema('WebhookTriggerConfig');
    expect(refName(arrayItem(property(webhookConfig, 'filters')))).toBe('WebhookTriggerFilter');
    expect(property(webhookConfig, 'tokenLastFour').type).toBe('string');
    expect(webhookConfig.properties?.token).toBeUndefined();

    const activity = schema('ActivityEvent');
    expect(property(activity, 'eventType').type).toBe('string');
    expect(property(activity, 'payload').type).toBe('object');
    expect(property(activity, 'createdAt').type).toBe('integer');

    const sessionDetail = schema('SessionDetailResponse');
    expect(refName(arrayItem(property(sessionDetail, 'messages')))).toBe('ChatMessage');
  });

  it('keeps the checked artifact in sync with the source document', async () => {
    const artifact = await readFile(
      new URL('../../../openapi/sam-cli.openapi.json', import.meta.url),
      'utf8'
    );
    const parsed = JSON.parse(artifact) as OpenApiDocument;
    expect(parsed).toEqual(samCliOpenApiDocument);
  });

  it('serves the same document from the CLI API route', async () => {
    const response = await cliRoutes.request('/openapi.json');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(samCliOpenApiDocument);
  });
});
