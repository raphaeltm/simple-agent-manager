type SchemaObject = {
  type?: string | string[];
  format?: string;
  description?: string;
  enum?: string[];
  items?: SchemaObject | ReferenceObject;
  properties?: Record<string, SchemaObject | ReferenceObject>;
  required?: string[];
  additionalProperties?: boolean | SchemaObject | ReferenceObject;
  nullable?: boolean;
};

type ReferenceObject = {
  $ref: string;
  nullable?: boolean;
};

type MediaTypeObject = {
  schema: SchemaObject | ReferenceObject;
};

type OperationObject = {
  operationId: string;
  summary: string;
  tags: string[];
  security?: Array<Record<string, string[]>>;
  parameters?: Array<{
    name: string;
    in: 'path' | 'query';
    required?: boolean;
    schema: SchemaObject;
    description?: string;
  }>;
  requestBody?: {
    required: boolean;
    content: Record<string, MediaTypeObject>;
  };
  responses: Record<
    string,
    {
      description: string;
      content?: Record<string, MediaTypeObject>;
    }
  >;
};

export type OpenApiDocument = {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers?: Array<{ url: string; description: string }>;
  paths: Record<string, Partial<Record<'get' | 'post', OperationObject>>>;
  components: {
    securitySchemes: Record<string, { type: string; in: string; name: string }>;
    schemas: Record<string, SchemaObject>;
  };
};

const stringSchema = (description?: string): SchemaObject => ({
  type: 'string',
  ...(description ? { description } : {}),
});
const dateTimeSchema = (description?: string): SchemaObject => ({
  type: 'string',
  format: 'date-time',
  ...(description ? { description } : {}),
});
const integerSchema = (description?: string): SchemaObject => ({
  type: 'integer',
  ...(description ? { description } : {}),
});
const numberSchema = (description?: string): SchemaObject => ({
  type: 'number',
  ...(description ? { description } : {}),
});
const booleanSchema = (description?: string): SchemaObject => ({
  type: 'boolean',
  ...(description ? { description } : {}),
});
const nullable = (schema: SchemaObject | ReferenceObject): SchemaObject | ReferenceObject => ({
  ...schema,
  nullable: true,
});
const arrayOf = (items: SchemaObject | ReferenceObject): SchemaObject => ({ type: 'array', items });
const objectSchema = (
  properties: Record<string, SchemaObject | ReferenceObject>,
  required: string[] = [],
  additionalProperties: boolean | SchemaObject | ReferenceObject = false
): SchemaObject => ({ type: 'object', properties, required, additionalProperties });
const ref = (name: string): ReferenceObject => ({ $ref: `#/components/schemas/${name}` });

const json = (schema: SchemaObject | ReferenceObject): Record<string, MediaTypeObject> => ({
  'application/json': { schema },
});

const ok = (schema: SchemaObject | ReferenceObject, description = 'OK') => ({
  description,
  content: json(schema),
});

const bearerSecurity = [{ sessionCookie: [] }];
const pathParam = (name: string, description: string) => ({
  name,
  in: 'path' as const,
  required: true,
  schema: stringSchema(),
  description,
});
const queryParam = (name: string, schema: SchemaObject, description: string) => ({
  name,
  in: 'query' as const,
  schema,
  description,
});
const jsonBody = (schema: SchemaObject | ReferenceObject) => ({
  required: true,
  content: json(schema),
});

// Factory for authenticated GET path items. Collapses the repeated
// `get: { ... security: bearerSecurity ... }` boilerplate shared by every
// read endpoint into a single shape so the contract stays DRY.
const getOp = (
  operationId: string,
  summary: string,
  tags: string[],
  responses: OperationObject['responses'],
  parameters?: OperationObject['parameters']
): Partial<Record<'get' | 'post', OperationObject>> => ({
  get: {
    operationId,
    summary,
    tags,
    security: bearerSecurity,
    ...(parameters ? { parameters } : {}),
    responses,
  },
});

const projectId = pathParam('projectId', 'Project ID.');
const sessionId = pathParam('sessionId', 'Chat session ID.');
const taskId = pathParam('taskId', 'Task ID.');
const workspaceId = pathParam('id', 'Workspace ID.');

// Shared field sets extracted to reduce duplication between base and detail schemas
const projectBaseFields: Record<string, SchemaObject | ReferenceObject> = {
  id: stringSchema(),
  name: stringSchema(),
  repository: stringSchema(),
  repoProvider: stringSchema(),
  status: stringSchema(),
  defaultBranch: stringSchema(),
  lastActivityAt: nullable(dateTimeSchema()),
  activeSessionCount: integerSchema(),
  activeWorkspaceCount: integerSchema(),
};

const taskBaseFields: Record<string, SchemaObject | ReferenceObject> = {
  id: stringSchema(),
  projectId: stringSchema(),
  title: stringSchema(),
  description: stringSchema(),
  status: stringSchema(),
  priority: integerSchema(),
  executionStep: nullable(stringSchema()),
  taskMode: stringSchema(),
  outputBranch: nullable(stringSchema()),
  outputPrUrl: nullable(stringSchema()),
  outputSummary: nullable(stringSchema()),
  completionEvidence: nullable(objectSchema({}, [], true)),
  errorMessage: nullable(stringSchema()),
  finalizedAt: nullable(dateTimeSchema()),
  createdAt: dateTimeSchema(),
  updatedAt: dateTimeSchema(),
};

export const samCliOpenApiDocument: OpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'SAM CLI REST API',
    version: '0.1.0',
    description: 'Generated contract for the REST API surface consumed by the SAM Go CLI.',
  },
  paths: {
    '/api/auth/token-login': {
      post: {
        operationId: 'exchangeApiToken',
        summary: 'Exchange a SAM API token for a session cookie.',
        tags: ['Auth'],
        requestBody: jsonBody(ref('TokenLoginRequest')),
        responses: {
          '200': ok(ref('TokenLoginResponse')),
          '400': ok(ref('ApiError'), 'Bad request'),
          '401': ok(ref('ApiError'), 'Unauthorized'),
        },
      },
    },
    '/api/auth/device/code': {
      post: {
        operationId: 'createDeviceCode',
        summary: 'Create a device authorization code for CLI login.',
        tags: ['Auth'],
        responses: {
          '200': ok(ref('DeviceCodeResponse')),
          '429': ok(ref('ApiError'), 'Rate limited'),
        },
      },
    },
    '/api/auth/device/token': {
      post: {
        operationId: 'exchangeDeviceCode',
        summary: 'Poll a device authorization code for a session cookie.',
        tags: ['Auth'],
        requestBody: jsonBody(ref('DeviceTokenRequest')),
        responses: {
          '200': ok(ref('TokenLoginResponse')),
          '410': ok(ref('ApiError'), 'Expired device code'),
          '428': ok(ref('ApiError'), 'Authorization pending'),
          '429': ok(ref('ApiError'), 'Rate limited'),
        },
      },
    },
    '/api/projects': getOp(
      'listProjects',
      'List projects visible to the authenticated user.',
      ['Projects'],
      { '200': ok(ref('ListProjectsResponse')) },
      [
        queryParam('limit', integerSchema(), 'Maximum number of projects to return.'),
        queryParam('cursor', stringSchema(), 'Pagination cursor.'),
      ]
    ),
    '/api/projects/{projectId}': getOp(
      'getProject',
      'Get project details.',
      ['Projects'],
      { '200': ok(ref('ProjectDetailResponse')), '404': ok(ref('ApiError'), 'Not found') },
      [projectId]
    ),
    '/api/projects/{projectId}/sessions': getOp(
      'listProjectSessions',
      'List chat sessions for a project.',
      ['Sessions'],
      { '200': ok(ref('ListSessionsResponse')) },
      [
        projectId,
        queryParam('status', stringSchema(), 'Optional session status filter.'),
        queryParam('limit', integerSchema(), 'Maximum number of sessions to return.'),
        queryParam('offset', integerSchema(), 'Offset for session pagination.'),
      ]
    ),
    '/api/projects/{projectId}/sessions/{sessionId}': getOp(
      'getProjectSession',
      'Get a chat session with messages.',
      ['Sessions'],
      { '200': ok(ref('SessionDetailResponse')), '404': ok(ref('ApiError'), 'Not found') },
      [
        projectId,
        sessionId,
        queryParam('limit', integerSchema(), 'Maximum number of messages to return.'),
        queryParam('before', integerSchema(), 'Message pagination cursor.'),
      ]
    ),
    '/api/projects/{projectId}/tasks/submit': {
      post: {
        operationId: 'submitProjectTask',
        summary: 'Submit a task for agent execution.',
        tags: ['Tasks'],
        security: bearerSecurity,
        parameters: [projectId],
        requestBody: jsonBody(ref('SubmitTaskRequest')),
        responses: { '202': ok(ref('SubmitTaskResponse'), 'Accepted') },
      },
    },
    '/api/projects/{projectId}/tasks': getOp(
      'listProjectTasks',
      'List project tasks. The CLI currently uses status=draft for ideas.',
      ['Tasks'],
      { '200': ok(ref('ListTasksResponse')) },
      [
        projectId,
        queryParam('status', stringSchema('Task status filter.'), 'Task status filter.'),
        queryParam('limit', integerSchema(), 'Maximum number of tasks to return.'),
        queryParam('cursor', stringSchema(), 'Pagination cursor.'),
      ]
    ),
    '/api/projects/{projectId}/tasks/{taskId}': getOp(
      'getProjectTask',
      'Get project task details.',
      ['Tasks'],
      { '200': ok(ref('TaskDetailResponse')), '404': ok(ref('ApiError'), 'Not found') },
      [projectId, taskId]
    ),
    '/api/projects/{projectId}/library': getOp(
      'listProjectLibraryFiles',
      'List files in the project library.',
      ['Library'],
      { '200': ok(ref('ListFilesResponse')) },
      [
        projectId,
        queryParam('tag', stringSchema(), 'Tag filter.'),
        queryParam('uploadSource', stringSchema(), 'Upload source filter.'),
        queryParam('limit', integerSchema(), 'Maximum number of files to return.'),
        queryParam('cursor', stringSchema(), 'Pagination cursor.'),
      ]
    ),
    '/api/projects/{projectId}/knowledge': getOp(
      'listProjectKnowledge',
      'List project knowledge graph entities.',
      ['Knowledge'],
      { '200': ok(ref('ListKnowledgeEntitiesResponse')) },
      [projectId, queryParam('limit', integerSchema(), 'Maximum number of entities to return.')]
    ),
    '/api/notifications': getOp(
      'listNotifications',
      'List user notifications.',
      ['Notifications'],
      { '200': ok(ref('ListNotificationsResponse')) },
      [
        queryParam('limit', integerSchema(), 'Maximum number of notifications to return.'),
        queryParam('cursor', stringSchema(), 'Pagination cursor.'),
      ]
    ),
    '/api/projects/{projectId}/triggers': getOp(
      'listProjectTriggers',
      'List project triggers.',
      ['Triggers'],
      { '200': ok(ref('ListTriggersResponse')) },
      [projectId]
    ),
    '/api/projects/{projectId}/agent-profiles': getOp(
      'listProjectAgentProfiles',
      'List project and builtin agent profiles.',
      ['Agent profiles'],
      { '200': ok(ref('ListAgentProfilesResponse')) },
      [projectId]
    ),
    '/api/projects/{projectId}/activity': getOp(
      'listProjectActivity',
      'List project activity events.',
      ['Activity'],
      { '200': ok(ref('ListActivityEventsResponse')) },
      [projectId, queryParam('limit', integerSchema(), 'Maximum number of events to return.')]
    ),
    '/api/nodes': getOp(
      'listNodes',
      'List infrastructure nodes for the authenticated user.',
      ['Nodes'],
      { '200': ok(arrayOf(ref('Node'))) }
    ),
    '/api/workspaces/{id}': getOp(
      'getWorkspace',
      'Get workspace details.',
      ['Workspaces'],
      { '200': ok(ref('WorkspaceResponse')), '404': ok(ref('ApiError'), 'Not found') },
      [workspaceId]
    ),
    '/api/workspaces/{id}/ports': getOp(
      'listWorkspacePorts',
      'List detected ports for a workspace.',
      ['Workspaces'],
      { '200': ok(ref('PortsResponse')) },
      [workspaceId]
    ),
    '/api/workspaces/{id}/port-access': getOp(
      'createWorkspacePortAccess',
      'Create an access token and URL for a workspace port.',
      ['Workspaces'],
      { '200': ok(ref('PortAccessResponse')) },
      [workspaceId, queryParam('port', integerSchema(), 'Workspace port number.')]
    ),
  },
  components: {
    securitySchemes: {
      sessionCookie: {
        type: 'apiKey',
        in: 'header',
        name: 'Cookie',
      },
    },
    schemas: {
      ApiError: objectSchema(
        {
          error: stringSchema(),
          message: stringSchema(),
        },
        ['error', 'message']
      ),
      AuthUser: objectSchema({
        id: stringSchema(),
        email: stringSchema(),
        name: stringSchema(),
      }),
      TokenLoginRequest: objectSchema({ token: stringSchema() }, ['token']),
      DeviceTokenRequest: objectSchema({ deviceCode: stringSchema() }, ['deviceCode']),
      TokenLoginResponse: objectSchema(
        {
          success: booleanSchema(),
          user: ref('AuthUser'),
          sessionCookie: stringSchema(),
        },
        ['success', 'sessionCookie']
      ),
      DeviceCodeResponse: objectSchema(
        {
          deviceCode: stringSchema(),
          userCode: stringSchema(),
          verificationUri: stringSchema(),
          verificationUriComplete: stringSchema(),
          expiresIn: integerSchema(),
          interval: integerSchema(),
        },
        [
          'deviceCode',
          'userCode',
          'verificationUri',
          'verificationUriComplete',
          'expiresIn',
          'interval',
        ]
      ),
      Project: objectSchema({ ...projectBaseFields }, ['id', 'name']),
      ListProjectsResponse: objectSchema(
        {
          projects: arrayOf(ref('Project')),
          nextCursor: nullable(stringSchema()),
        },
        ['projects']
      ),
      ProjectDetailResponse: objectSchema(
        {
          ...projectBaseFields,
          recentSessions: arrayOf(ref('ChatSession')),
        },
        ['id', 'name']
      ),
      ChatSession: objectSchema(
        {
          id: stringSchema(),
          projectId: stringSchema(),
          workspaceId: nullable(stringSchema()),
          topic: nullable(stringSchema()),
          status: stringSchema(),
          startedAt: nullable(dateTimeSchema()),
          lastMessageAt: nullable(dateTimeSchema()),
          messageCount: integerSchema(),
          taskId: nullable(stringSchema()),
          agentSessionId: nullable(stringSchema()),
          agentType: nullable(stringSchema()),
          task: nullable(ref('ChatSessionTask')),
        },
        ['id']
      ),
      ChatSessionTask: objectSchema(
        {
          id: stringSchema(),
          status: stringSchema(),
          executionStep: nullable(stringSchema()),
          errorMessage: nullable(stringSchema()),
          outputBranch: nullable(stringSchema()),
          outputPrUrl: nullable(stringSchema()),
          outputSummary: nullable(stringSchema()),
          finalizedAt: nullable(dateTimeSchema()),
          taskMode: nullable(stringSchema()),
          agentProfileHint: nullable(stringSchema()),
        },
        ['id', 'status']
      ),
      ChatMessage: objectSchema(
        {
          id: stringSchema(),
          sessionId: stringSchema(),
          role: stringSchema(),
          content: stringSchema(),
          createdAt: numberSchema(),
          metadata: objectSchema({}, [], true),
        },
        ['id', 'role', 'content']
      ),
      ListSessionsResponse: objectSchema(
        {
          sessions: arrayOf(ref('ChatSession')),
          total: integerSchema(),
        },
        ['sessions']
      ),
      SessionDetailResponse: objectSchema(
        {
          session: ref('ChatSession'),
          messages: arrayOf(ref('ChatMessage')),
          hasMore: booleanSchema(),
          state: nullable(objectSchema({}, [], true)),
        },
        ['session', 'messages', 'hasMore']
      ),
      SubmitTaskRequest: objectSchema(
        {
          prompt: stringSchema(),
          agentType: stringSchema(),
          agentProfile: stringSchema(),
          contextSummary: stringSchema(),
          parentTaskId: stringSchema(),
          nodeId: stringSchema(),
          workspaceId: stringSchema(),
          provider: stringSchema(),
          vmLocation: stringSchema(),
          vmSize: stringSchema(),
          taskMode: stringSchema(),
          devcontainerConfigName: stringSchema(),
        },
        ['prompt']
      ),
      SubmitTaskResponse: objectSchema(
        {
          taskId: stringSchema(),
          sessionId: stringSchema(),
          branchName: stringSchema(),
          status: stringSchema(),
        },
        ['taskId', 'status']
      ),
      Task: objectSchema({ ...taskBaseFields }, ['id', 'title', 'status']),
      ListTasksResponse: objectSchema(
        {
          tasks: arrayOf(ref('Task')),
          nextCursor: nullable(stringSchema()),
        },
        ['tasks']
      ),
      TaskDetailResponse: objectSchema(
        {
          ...taskBaseFields,
          dependencies: arrayOf(objectSchema({}, [], true)),
          blocked: booleanSchema(),
        },
        ['id', 'title', 'status']
      ),
      ProjectFileTag: objectSchema(
        {
          fileId: stringSchema(),
          tag: stringSchema(),
          tagSource: stringSchema(),
        },
        ['fileId', 'tag', 'tagSource']
      ),
      ProjectFile: objectSchema(
        {
          id: stringSchema(),
          projectId: stringSchema(),
          filename: stringSchema(),
          directory: stringSchema(),
          mimeType: stringSchema(),
          sizeBytes: integerSchema(),
          description: nullable(stringSchema()),
          uploadedBy: stringSchema(),
          uploadSource: stringSchema(),
          uploadSessionId: nullable(stringSchema()),
          uploadTaskId: nullable(stringSchema()),
          replacedAt: nullable(dateTimeSchema()),
          replacedBy: nullable(stringSchema()),
          status: stringSchema(),
          extractedTextPreview: nullable(stringSchema()),
          createdAt: dateTimeSchema(),
          updatedAt: dateTimeSchema(),
          tags: arrayOf(ref('ProjectFileTag')),
        },
        ['id', 'projectId', 'filename', 'sizeBytes', 'uploadSource', 'createdAt']
      ),
      ListFilesResponse: objectSchema(
        {
          files: arrayOf(ref('ProjectFile')),
          cursor: nullable(stringSchema()),
          total: integerSchema(),
        },
        ['files', 'total']
      ),
      KnowledgeEntity: objectSchema(
        {
          id: stringSchema(),
          name: stringSchema(),
          entityType: stringSchema(),
          description: nullable(stringSchema()),
          observationCount: integerSchema(),
          createdAt: integerSchema(),
          updatedAt: integerSchema(),
        },
        ['id', 'name', 'entityType', 'updatedAt']
      ),
      ListKnowledgeEntitiesResponse: objectSchema(
        {
          entities: arrayOf(ref('KnowledgeEntity')),
          total: integerSchema(),
        },
        ['entities', 'total']
      ),
      Notification: objectSchema(
        {
          id: stringSchema(),
          type: stringSchema(),
          title: stringSchema(),
          message: stringSchema(),
          read: booleanSchema(),
          createdAt: dateTimeSchema(),
        },
        ['id', 'type', 'title', 'read']
      ),
      ListNotificationsResponse: objectSchema(
        {
          notifications: arrayOf(ref('Notification')),
          unreadCount: integerSchema(),
          nextCursor: nullable(stringSchema()),
        },
        ['notifications']
      ),
      Trigger: objectSchema(
        {
          id: stringSchema(),
          projectId: stringSchema(),
          userId: stringSchema(),
          name: stringSchema(),
          description: nullable(stringSchema()),
          status: stringSchema(),
          sourceType: {
            type: 'string',
            enum: ['cron', 'webhook', 'github'],
            description: 'Trigger source. Cron fields are null for event-driven sources.',
          },
          cronExpression: nullable(stringSchema()),
          cronTimezone: stringSchema(),
          skipIfRunning: booleanSchema(),
          promptTemplate: stringSchema(),
          agentProfileId: nullable(stringSchema()),
          taskMode: stringSchema(),
          vmSizeOverride: nullable(stringSchema()),
          maxConcurrent: integerSchema(),
          lastTriggeredAt: nullable(dateTimeSchema()),
          triggerCount: integerSchema(),
          nextFireAt: nullable(dateTimeSchema()),
          createdAt: dateTimeSchema(),
          updatedAt: dateTimeSchema(),
          cronHumanReadable: stringSchema(),
          webhookConfig: ref('WebhookTriggerConfig'),
        },
        ['id', 'name', 'sourceType', 'cronExpression', 'nextFireAt']
      ),
      WebhookTriggerFilter: objectSchema(
        {
          path: stringSchema('Dot-separated path in the JSON request body.'),
          operator: { type: 'string', enum: ['exists', 'equals', 'contains'] },
          value: { type: ['string', 'number', 'boolean', 'null'] },
        },
        ['path', 'operator']
      ),
      WebhookTriggerConfig: objectSchema(
        {
          sourceLabel: nullable(stringSchema()),
          filterMode: { type: 'string', enum: ['all', 'any'] },
          filters: arrayOf(ref('WebhookTriggerFilter')),
          includedHeaders: arrayOf(stringSchema()),
          tokenLastFour: stringSchema(
            'Only the final four token characters; never credential material.'
          ),
          tokenCreatedAt: dateTimeSchema(),
          tokenRotatedAt: nullable(dateTimeSchema()),
        },
        [
          'sourceLabel',
          'filterMode',
          'filters',
          'includedHeaders',
          'tokenLastFour',
          'tokenCreatedAt',
          'tokenRotatedAt',
        ]
      ),
      ListTriggersResponse: objectSchema(
        {
          triggers: arrayOf(ref('Trigger')),
        },
        ['triggers']
      ),
      AgentProfile: objectSchema(
        {
          id: stringSchema(),
          projectId: nullable(stringSchema()),
          userId: stringSchema(),
          name: stringSchema(),
          description: nullable(stringSchema()),
          agentType: stringSchema(),
          model: nullable(stringSchema()),
          permissionMode: nullable(stringSchema()),
          systemPromptAppend: nullable(stringSchema()),
          maxTurns: nullable(integerSchema()),
          timeoutMinutes: nullable(integerSchema()),
          vmSizeOverride: nullable(stringSchema()),
          provider: nullable(stringSchema()),
          vmLocation: nullable(stringSchema()),
          workspaceProfile: nullable(stringSchema()),
          devcontainerConfigName: nullable(stringSchema()),
          taskMode: nullable(stringSchema()),
          isBuiltin: booleanSchema(),
          createdAt: dateTimeSchema(),
          updatedAt: dateTimeSchema(),
        },
        ['id', 'name', 'agentType']
      ),
      ListAgentProfilesResponse: objectSchema(
        {
          items: arrayOf(ref('AgentProfile')),
        },
        ['items']
      ),
      ActivityEvent: objectSchema(
        {
          id: stringSchema(),
          eventType: stringSchema(),
          actorType: stringSchema(),
          actorId: nullable(stringSchema()),
          workspaceId: nullable(stringSchema()),
          sessionId: nullable(stringSchema()),
          taskId: nullable(stringSchema()),
          payload: nullable(objectSchema({}, [], true)),
          createdAt: integerSchema(),
        },
        ['id', 'eventType', 'payload', 'createdAt']
      ),
      ListActivityEventsResponse: objectSchema(
        {
          events: arrayOf(ref('ActivityEvent')),
          hasMore: booleanSchema(),
        },
        ['events']
      ),
      Node: objectSchema(
        {
          id: stringSchema(),
          provider: stringSchema(),
          name: stringSchema(),
          status: stringSchema(),
          healthStatus: stringSchema(),
          location: stringSchema(),
          vmSize: stringSchema(),
          ipAddress: stringSchema(),
          domain: stringSchema(),
          workspaceCount: integerSchema(),
          lastHeartbeatAt: nullable(dateTimeSchema()),
          createdAt: dateTimeSchema(),
        },
        ['id', 'status']
      ),
      WorkspaceResponse: objectSchema(
        {
          id: stringSchema(),
          userId: stringSchema(),
          nodeId: nullable(stringSchema()),
          projectId: nullable(stringSchema()),
          displayName: nullable(stringSchema()),
          status: stringSchema(),
          url: stringSchema(),
          repository: stringSchema(),
          branch: stringSchema(),
          createdAt: dateTimeSchema(),
          updatedAt: dateTimeSchema(),
        },
        ['id', 'status']
      ),
      DetectedPort: objectSchema(
        {
          port: integerSchema(),
          address: stringSchema(),
          label: stringSchema(),
          url: stringSchema(),
          detectedAt: dateTimeSchema(),
        },
        ['port']
      ),
      PortsResponse: objectSchema(
        {
          ports: arrayOf(ref('DetectedPort')),
        },
        ['ports']
      ),
      PortAccessResponse: objectSchema(
        {
          token: stringSchema(),
          url: stringSchema(),
          port: integerSchema(),
        },
        ['token', 'url', 'port']
      ),
    },
  },
};
