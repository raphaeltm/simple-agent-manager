/**
 * MCP tool definitions — session management, session–idea linking, idea CRUD, and deployment credentials.
 */

export const SESSION_IDEA_TOOLS = [
  // ─── Session management tools ───────────────────────────────────────
  {
    name: 'update_session_topic',
    description:
      "Update the topic (title) of your current chat session. Use this when you understand the conversation's true subject after a few messages, " +
      'or when the conversation changes direction. The topic is displayed in the session list and helps users identify what each session is about.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic: {
          type: 'string',
          description: 'New topic/title for the session. Should be concise and descriptive.',
        },
      },
      required: ['topic'],
      additionalProperties: false,
    },
  },
  // ─── Session–Idea linking tools ──────────────────────────────────────
  {
    name: 'link_idea',
    description:
      'Associate the current chat session with an idea (task). Use this when the conversation touches on an existing idea. Linking is idempotent — linking the same idea twice is a no-op.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'The idea (task) ID to link to the current session',
        },
        context: {
          type: 'string',
          description: 'Optional reasoning for why this session relates to the idea',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'unlink_idea',
    description:
      'Remove the association between the current chat session and an idea (task). No-op if the link does not exist.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'The idea (task) ID to unlink from the current session',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_linked_ideas',
    description:
      'List all ideas (tasks) linked to the current chat session. Returns each idea with its title, status, link context, and when it was linked.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'find_related_ideas',
    description:
      'Search existing ideas in your project by keyword. Defaults to searching draft (idea) tasks only. Use this to find ideas that might relate to the current conversation before creating a new one.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword to find in idea titles and descriptions',
        },
        status: {
          type: 'string',
          description: 'Filter by idea status. Omit for all statuses.',
          enum: [
            'draft',
            'queued',
            'in_progress',
            'delegated',
            'awaiting_followup',
            'completed',
            'failed',
            'cancelled',
          ],
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default: 10, max: 20)',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  // ─── Idea management tools ───────────────────────────────────────────
  {
    name: 'create_idea',
    description:
      'Create a new idea in the current project. Ideas are lightweight notes for future consideration — they are NOT dispatched for execution. ' +
      'Use this to capture ideas, feature requests, or anything worth tracking. Returns the idea ID so you can link it to the current session via link_idea.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Short title for the idea',
        },
        content: {
          type: 'string',
          description: 'Detailed content — supports checklists, notes, research findings, etc.',
        },
        priority: {
          type: 'number',
          description: 'Priority (0 = default). Higher = more important.',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_idea',
    description:
      'Update an existing idea. By default, new content is appended to the existing content (great for adding notes from multiple conversations). Set append=false to replace content entirely.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ideaId: {
          type: 'string',
          description: 'The idea ID to update',
        },
        title: {
          type: 'string',
          description: 'New title (optional — only updates if provided)',
        },
        content: {
          type: 'string',
          description: 'Content to append (or replace if append=false)',
        },
        append: {
          type: 'boolean',
          description:
            'If true (default), append content to existing description. If false, replace it.',
        },
        priority: {
          type: 'number',
          description: 'New priority (optional — only updates if provided)',
        },
        status: {
          type: 'string',
          description:
            'Transition the idea to a new status. Allowed transitions: draft→ready, draft→cancelled, ready→draft, ready→completed, ready→cancelled. Terminal statuses (completed, cancelled) cannot be changed.',
          enum: ['draft', 'ready', 'completed', 'cancelled'],
        },
      },
      required: ['ideaId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_idea',
    description:
      'Get full details of a specific idea, including its complete content. Works for ideas in any status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ideaId: {
          type: 'string',
          description: 'The idea ID to retrieve',
        },
      },
      required: ['ideaId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_ideas',
    description:
      'List all ideas (draft tasks) in your project, ordered by most recently updated. Use this to see what ideas exist before creating duplicates.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Max results to return',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_ideas',
    description:
      'Search ideas in your project by keyword. Searches both title and content fields. Only returns ideas (draft tasks), not executed tasks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword to find in idea titles and content',
        },
        limit: {
          type: 'number',
          description: 'Max results to return',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'build_and_publish',
    description:
      "Start an asynchronous build/publish job for your project's Docker Compose stack and return a durable publishJobId immediately. This is the publish path for compose-based projects. SAM builds services on the host Docker daemon, uploads scoped image artifacts, records a deployment release server-side, and rewrites safe declared named Compose volumes to SAM provider-backed deployment volumes. You run ZERO docker or registry commands and never receive credentials. Unsafe volume forms are rejected with unsupported_compose_volumes: host bind mounts, Docker socket mounts, anonymous volumes, undeclared named volumes, volumes_from, tmpfs, external volumes, custom volume drivers, and driver options. After this tool returns, call get_publish_status with the publishJobId every 10-20 seconds until the status is succeeded, failed, canceled, or unknown. Do not treat the initial response as deployment success.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        environment: {
          type: 'string',
          description:
            'Deployment environment name (e.g. "staging", "production"). The environment must exist, be active, and have agent deployment enabled by a user.',
        },
        reference: {
          type: 'string',
          description: 'Optional release tag for the published images (defaults to "latest").',
        },
        workingDir: {
          type: 'string',
          description:
            'Optional absolute path to the working directory to build, under /workspaces (e.g. "/workspaces/myrepo" or a git worktree like "/workspaces/myrepo-wt-feature"). Pass your current working directory — especially when working in a git worktree — so SAM builds the source you actually edited. Defaults to the workspace\'s primary repository directory.',
        },
      },
      required: ['environment'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_publish_status',
    description:
      'Poll a durable build_and_publish job. Returns current status, current step, recent events, terminal release details on success, and sanitized failure diagnostics on failure. Use sinceSeq to fetch only new events after an earlier poll.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        publishJobId: {
          type: 'string',
          description: 'The publishJobId returned by build_and_publish.',
        },
        sinceSeq: {
          type: 'number',
          description:
            'Optional last seen event sequence. Only events with seq greater than this value are returned.',
        },
        limit: {
          type: 'number',
          description: 'Optional maximum number of events to return (default 50, max 100).',
        },
      },
      required: ['publishJobId'],
      additionalProperties: false,
    },
  },
];
