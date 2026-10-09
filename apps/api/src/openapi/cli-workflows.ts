import type { OperationObject, SchemaObject } from './sam-cli';

const project = '/api/projects/{projectId}';
const jsonResponse = {
  description:
    'Complete JSON resource response, preserving continuation metadata and additional fields.',
  content: {
    'application/json': { schema: { type: 'object', additionalProperties: true } as SchemaObject },
  },
};
const errors = {
  '400': { description: 'Invalid input' },
  '401': { description: 'Authentication required' },
  '403': { description: 'Capability or creator denied' },
  '404': { description: 'Scoped resource not found' },
  '409': { description: 'Conflict or unknown keyed outcome; reconcile before retrying' },
};
const idempotency = {
  name: 'Idempotency-Key',
  in: 'header' as const,
  schema: { type: 'string' } as SchemaObject,
  description:
    'Stable key, 1–128 letters/digits/dot/underscore/colon/hyphen. Identical intent replays its receipt. Unknown reservations never execute again.',
};
function operation(
  path: string,
  method: 'get' | 'post' | 'patch',
  summary: string,
  query = '',
  body?: SchemaObject
): OperationObject {
  const parameters: NonNullable<OperationObject['parameters']> = path
    .split('/')
    .filter((segment) => segment.startsWith('{') && segment.endsWith('}'))
    .map((segment) => ({
      name: segment.slice(1, -1),
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
  parameters.push(
    ...query
      .split(' ')
      .filter(Boolean)
      .map((name) => ({ name, in: 'query' as const, schema: { type: 'string' } as SchemaObject }))
  );
  if (method === 'post' && /\/prompt$|\/cli\/(profiles|skills)$/.test(path))
    parameters.push(idempotency);
  return {
    operationId: `${method}${path.replaceAll(/[^a-zA-Z0-9]/g, '_')}`,
    summary,
    tags: ['Project workflows'],
    security: [{ sessionCookie: [] }],
    parameters,
    ...(body
      ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } }
      : {}),
    responses: {
      '200': jsonResponse,
      ...(method === 'post' ? { '201': jsonResponse, '202': jsonResponse } : {}),
      ...errors,
    },
  };
}
const reads: Array<[string, string]> = [
  ['/operation-receipts', 'key operation sessionId'],
  ['/skills', ''],
  ['/skills/{skillId}', ''],
  ['/skills/{skillId}/resolve', 'profileId'],
  ['/agent-profiles/{profileId}', ''],
  ['/tasks/{taskId}/events', ''],
  ['/tasks/{taskId}/sessions', ''],
  ['/sessions/{sessionId}/messages', 'limit before after compact order roles'],
  ['/sessions/{sessionId}/messages/{messageId}/tool-content', ''],
  ['/sessions/{sessionId}/state', ''],
  ['/sessions/{sessionId}/interactions', ''],
  ['/sessions/{sessionId}/interactions/{interactionId}', ''],
  ['/comments', 'limit status'],
  ['/sessions/{sessionId}/comments', 'messageId status afterSequence limit'],
  ['/repo/branches', ''],
  ['/repo/tree', 'ref'],
  ['/repo/file', 'ref path'],
  ['/repo/compare', 'base head'],
  ['/library/{fileId}', ''],
  ['/library/directories', 'parentDirectory search'],
  ['/knowledge/{entityId}', 'includeInactive'],
  ['/knowledge/search', 'q entityType minConfidence limit'],
  ['/policies', ''],
  ['/policies/{policyId}', ''],
  ['/triggers/{triggerId}', ''],
  ['/triggers/{triggerId}/executions', 'limit offset status'],
  ['/event-subscriptions', 'state sessionId limit'],
  ['/event-subscriptions/{subscriptionId}', ''],
  ['/event-subscriptions/{subscriptionId}/deliveries', 'limit'],
  ['/event-channels', 'limit cursor'],
  ['/event-channels/{channel}/history', 'limit cursor'],
  ['/schedules', 'limit cursor sessionId'],
  ['/schedules/{id}', ''],
  ['/standing-watches', 'limit cursor sessionId'],
  ['/standing-watches/{id}', ''],
  ['/environments', ''],
  ['/environments/{envId}', ''],
  ['/environments/{envId}/releases', ''],
  ['/environments/{envId}/releases/{releaseId}', ''],
  ['/environments/{envId}/public-routes', ''],
  ['/environments/{envId}/containers', ''],
  ['/environments/{envId}/metrics', ''],
  ['/runtime-config', ''],
];
export const cliWorkflowPaths: Record<
  string,
  Partial<Record<'get' | 'post' | 'patch', OperationObject>>
> = {};
for (const [suffix, query] of reads) {
  const path = project + suffix;
  cliWorkflowPaths[path] = {
    get: operation(
      path,
      'get',
      'Read project-scoped resource; does not launch or wake agents.',
      query
    ),
  };
}
const labels: SchemaObject = {
  type: 'object',
  properties: { name: { type: 'string' }, description: { type: ['string', 'null'] } },
  additionalProperties: false,
};
for (const family of ['profiles', 'skills']) {
  const create = `${project}/cli/${family}`;
  const update = `${create}/{id}`;
  cliWorkflowPaths[create] = {
    post: operation(
      create,
      'post',
      'Create project metadata with platform configuration defaults; security/spend/runtime fields rejected.',
      '',
      { ...labels, required: ['name'] }
    ),
  };
  cliWorkflowPaths[update] = {
    patch: operation(
      update,
      'patch',
      'Update project metadata only with compare-and-set; global resources rejected.',
      '',
      {
        ...labels,
        properties: { ...labels.properties, expectedUpdatedAt: { type: 'string' } },
        required: ['expectedUpdatedAt'],
      }
    ),
  };
}
const settings = `${project}/cli/settings`;
cliWorkflowPaths[settings] = {
  patch: operation(
    settings,
    'patch',
    'Rename/update project description only; no settings authority expansion.',
    '',
    {
      ...labels,
      properties: { ...labels.properties, expectedUpdatedAt: { type: 'string' } },
      required: ['expectedUpdatedAt'],
    }
  ),
};
const prompt = `${project}/sessions/{sessionId}/prompt`;
cliWorkflowPaths[prompt] = {
  post: operation(
    prompt,
    'post',
    'Send a follow-up, requiring task:write and session creator authority.',
    '',
    { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] }
  ),
};
const cancel = `${project}/sessions/{sessionId}/cancel`;
cliWorkflowPaths[cancel] = {
  post: operation(
    cancel,
    'post',
    'Cancel only the current agent turn, not archive or delete the session.'
  ),
};

// These are the mutation boundaries consumed by the CLI, not permission to
// execute them. Existing route schemas remain the request-validation authority.
export const cliWorkflowMutations: Record<
  string,
  Partial<Record<'post' | 'patch', OperationObject>>
> = {};
const string: SchemaObject = { type: 'string' };
const metadata: SchemaObject = {
  type: 'object',
  properties: { title: string, description: string, priority: { type: 'integer' } },
};
const note: SchemaObject = {
  type: 'object',
  properties: { body: string, clientMutationId: string },
};
const mutations: Array<[string, 'post' | 'patch', string, SchemaObject | undefined]> = [
  [
    '/tasks',
    'post',
    'Create draft task metadata; does not submit execution.',
    { ...metadata, required: ['title'] },
  ],
  [
    '/tasks/{taskId}',
    'patch',
    'Update task metadata, subject to the task route capability checks.',
    metadata,
  ],
  [
    '/agent-profiles/resolve',
    'post',
    'Read-only effective profile resolution; never launches work.',
    { type: 'object', properties: { profileNameOrId: string }, required: ['profileNameOrId'] },
  ],
  [
    '/tasks/request-upload',
    'post',
    'Create an attachment upload URL; does not submit work.',
    {
      type: 'object',
      properties: { filename: string, size: { type: 'integer' }, contentType: string },
      required: ['filename', 'size', 'contentType'],
    },
  ],
  [
    '/sessions/{sessionId}/ideas',
    'post',
    'Link an accepted conversation to an existing Idea.',
    { type: 'object', properties: { taskId: string }, required: ['taskId'] },
  ],
  [
    '/sessions/{sessionId}/attention/{markerId}/resolve',
    'post',
    'Answer current needs_input marker; permission/auth interaction markers are rejected.',
    { type: 'object', properties: { answer: string }, required: ['answer'] },
  ],
  [
    '/sessions/{sessionId}/comments',
    'post',
    'Add a message-anchored note without sending work.',
    {
      ...note,
      properties: { ...note.properties, messageId: string },
      required: ['messageId', 'body'],
    },
  ],
  [
    '/sessions/{sessionId}/comments/{threadId}/replies',
    'post',
    'Reply to a note without sending work.',
    { ...note, required: ['body'] },
  ],
  [
    '/sessions/{sessionId}/comments/{threadId}/resolve',
    'post',
    'Resolve a note thread without sending work.',
    { type: 'object', properties: { clientMutationId: string } },
  ],
  [
    '/sessions/{sessionId}/comments/{threadId}/reopen',
    'post',
    'Reopen a note thread without sending work.',
    { type: 'object', properties: { clientMutationId: string } },
  ],
];
for (const [suffix, method, summary, body] of mutations) {
  const path = project + suffix;
  cliWorkflowMutations[path] = { [method]: operation(path, method, summary, '', body) };
}
const upload = project + '/library/upload';
cliWorkflowMutations[upload] = {
  post: {
    ...operation(
      upload,
      'post',
      'Upload a new project artifact; no automatic replay or destructive replace.'
    ),
    requestBody: {
      required: true,
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            properties: {
              file: { type: 'string', format: 'binary' },
              filename: string,
              mimeType: string,
              directory: string,
              description: string,
            },
            required: ['file'],
          },
        },
      },
    },
  },
};
for (const [suffix, query] of [
  ['/library/{fileId}/download', ''],
  ['/repo/raw', 'ref path'],
]) {
  const path = project + suffix;
  const read = operation(
    path,
    'get',
    'Download private artifact bytes; does not modify remote resources.',
    query
  );
  read.responses['200'] = {
    description: 'Artifact bytes.',
    content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
  };
  cliWorkflowPaths[path] = { get: read };
}
const sleep = '/api/workspaces/{id}/sleep';
cliWorkflowMutations[sleep] = {
  post: operation(
    sleep,
    'post',
    'Suspend the session workspace resumably; owner authorization applies.'
  ),
};
