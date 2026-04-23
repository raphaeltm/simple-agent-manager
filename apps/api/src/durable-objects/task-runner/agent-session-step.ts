/**
 * Agent session step handler for the TaskRunner DO.
 *
 * Handles the agent_session step: creating the session, generating MCP token,
 * and starting the agent with the initial prompt.
 */
import { log } from '../../lib/logger';
import { transitionToInProgress } from './state-machine';
import type { TaskRunnerContext, TaskRunnerState } from './types';

export async function handleAgentSession(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
): Promise<void> {
  await rc.updateD1ExecutionStep(state.taskId, 'agent_session');

  if (!state.stepResults.nodeId || !state.stepResults.workspaceId) {
    throw new Error('Missing nodeId or workspaceId for agent session creation');
  }

  let sessionId = state.stepResults.agentSessionId;

  // Step 1: Create the agent session (skip if already created on a previous attempt)
  if (sessionId) {
    const existing = await rc.env.DATABASE.prepare(
      `SELECT id FROM agent_sessions WHERE id = ?`
    ).bind(sessionId).first<{ id: string }>();

    if (!existing) {
      // StepResults had a sessionId but it's gone from D1 — reset and recreate
      sessionId = null;
      state.stepResults.agentSessionId = null;
      state.stepResults.agentStarted = false;
      await rc.ctx.storage.put('state', state);
    }
  }

  if (!sessionId) {
    const { ulid } = await import('../../lib/ulid');
    const { createAgentSessionOnNode } = await import('../../services/node-agent');
    const { drizzle } = await import('drizzle-orm/d1');
    const schema = await import('../../db/schema');

    const db = drizzle(rc.env.DATABASE, { schema });
    sessionId = ulid();
    const sessionLabel = `Task: ${state.config.taskTitle.slice(0, 40)}`;
    const now = new Date().toISOString();

    const agentType = state.config.agentType || rc.env.DEFAULT_TASK_AGENT_TYPE || 'opencode';

    await db.insert(schema.agentSessions).values({
      id: sessionId,
      workspaceId: state.stepResults.workspaceId,
      userId: state.userId,
      status: 'running',
      label: sessionLabel,
      agentType,
      createdAt: now,
      updatedAt: now,
    });

    state.stepResults.agentSessionId = sessionId;
    await rc.ctx.storage.put('state', state);

    await createAgentSessionOnNode(
      state.stepResults.nodeId,
      state.stepResults.workspaceId,
      sessionId,
      sessionLabel,
      rc.env,
      state.userId,
      state.stepResults.chatSessionId,
      state.projectId,
    );

    // Create ACP session in ProjectData DO so the chat session can find its agentSessionId.
    // Without this, the browser has no ACP session to connect to and shows "Agent offline".
    if (state.stepResults.chatSessionId && state.projectId) {
      const projectDataService = await import('../../services/project-data');
      try {
        const acpSession = await projectDataService.createAcpSession(
          rc.env,
          state.projectId,
          state.stepResults.chatSessionId,
          null, // initialPrompt — already sent to the VM agent directly
          agentType,
        );
        // Transition to assigned (links workspace + node)
        await projectDataService.transitionAcpSession(
          rc.env,
          state.projectId,
          acpSession.id,
          'assigned',
          {
            actorType: 'system',
            actorId: 'task-runner',
            reason: 'Task runner assigned agent session to workspace',
            workspaceId: state.stepResults.workspaceId,
            nodeId: state.stepResults.nodeId,
          },
        );
        // Transition to running (agent session created on node)
        await projectDataService.transitionAcpSession(
          rc.env,
          state.projectId,
          acpSession.id,
          'running',
          {
            actorType: 'system',
            actorId: 'task-runner',
            reason: 'Agent session started on node',
            acpSdkSessionId: sessionId,
          },
        );
        log.info('task_runner_do.step.acp_session_created', {
          taskId: state.taskId,
          acpSessionId: acpSession.id,
          chatSessionId: state.stepResults.chatSessionId,
          projectId: state.projectId,
        });
      } catch (err) {
        // ACP session creation failure is non-fatal for the task itself —
        // the agent will still run, but the browser won't have live ACP connection.
        log.error('task_runner_do.step.acp_session_create_failed', {
          taskId: state.taskId,
          chatSessionId: state.stepResults.chatSessionId,
          projectId: state.projectId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info('task_runner_do.step.agent_session_created', {
      taskId: state.taskId,
      agentSessionId: sessionId,
      workspaceId: state.stepResults.workspaceId,
      nodeId: state.stepResults.nodeId,
    });
  }

  // Step 2: Generate MCP token for agent platform awareness (skip if already created)
  if (!state.stepResults.mcpToken) {
    const { generateMcpToken, storeMcpToken } = await import('../../services/mcp-token');
    const mcpToken = generateMcpToken();
    await storeMcpToken(
      rc.env.KV,
      mcpToken,
      {
        taskId: state.taskId,
        projectId: state.projectId,
        userId: state.userId,
        workspaceId: state.stepResults.workspaceId!,
        createdAt: new Date().toISOString(),
      },
      rc.env,
    );
    state.stepResults.mcpToken = mcpToken;
    await rc.ctx.storage.put('state', state);

    log.info('task_runner_do.step.mcp_token_created', {
      taskId: state.taskId,
      projectId: state.projectId,
    });
  }

  // Step 3: Start the agent with the initial prompt (skip if already started)
  // This two-step approach ensures that if create succeeds but start fails,
  // a retry will skip creation and retry only the start call.
  if (!state.stepResults.agentStarted) {
    const { startAgentSessionOnNode } = await import('../../services/node-agent');
    const agentType = state.config.agentType || rc.env.DEFAULT_TASK_AGENT_TYPE || 'opencode';
    const taskContent = state.config.taskDescription || state.config.taskTitle;

    // Build attachment context if files were transferred
    let attachmentContext = '';
    if (state.config.attachments?.length) {
      const fileList = state.config.attachments
        .map((a) => `- \`/workspaces/.private/${a.filename}\` (${a.size} bytes, ${a.contentType})`)
        .join('\n');
      attachmentContext =
        `\n\n## Attached Files\n\nThe following files have been uploaded to the workspace:\n${fileList}\n` +
        `\nThese files are available at the paths listed above. Read them to understand the task context.\n`;
    }

    // Append agent profile system prompt if configured
    const systemPromptSuffix = state.config.systemPromptAppend
      ? `\n\n${state.config.systemPromptAppend}`
      : '';

    const initialPrompt =
      `${taskContent}${attachmentContext}${systemPromptSuffix}\n\n---\n\n` +
      `IMPORTANT: Before starting any work, you MUST call the \`get_instructions\` tool from the sam-mcp MCP server. ` +
      `This provides your task context, project information, output branch name, and instructions for reporting progress. ` +
      `Do not proceed until you have called this tool and read its response.`;

    // Construct MCP server URL for agent platform awareness
    const mcpServerUrl = `https://api.${rc.env.BASE_DOMAIN}/mcp`;

    await startAgentSessionOnNode(
      state.stepResults.nodeId,
      state.stepResults.workspaceId,
      sessionId,
      agentType,
      initialPrompt,
      rc.env,
      state.userId,
      {
        url: mcpServerUrl,
        token: state.stepResults.mcpToken!,
      },
      {
        model: state.config.model,
        permissionMode: state.config.permissionMode,
        opencodeProvider: state.config.opencodeProvider,
        opencodeBaseUrl: state.config.opencodeBaseUrl,
      },
    );

    state.stepResults.agentStarted = true;
    await rc.ctx.storage.put('state', state);

    log.info('task_runner_do.step.agent_session_started', {
      taskId: state.taskId,
      agentSessionId: sessionId,
      agentType,
      mcpServerConfigured: true,
    });
  }

  await transitionToInProgress(state, rc);
}
