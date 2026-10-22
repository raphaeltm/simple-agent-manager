/**
 * Agent model calls through the real MCP route (`tools/call list_ai_models / run_ai_model`),
 * the real access cascade and the real budget SQL (in-memory SQLite). Only the Workers AI
 * binding and the workspace file transfer are stubbed at their boundaries.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const transfer = vi.hoisted(() => ({
  downloadFromWorkspace: vi.fn(),
  uploadToWorkspace: vi.fn(),
  resolveWorkspaceVmUrl: vi.fn(),
}));

vi.mock('../../src/services/workspace-file-transfer', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/services/workspace-file-transfer')>();
  return {
    ...actual,
    downloadFromWorkspace: transfer.downloadFromWorkspace,
    uploadToWorkspace: transfer.uploadToWorkspace,
    resolveWorkspaceVmUrl: transfer.resolveWorkspaceVmUrl,
  };
});

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import * as agentProfileService from '../../src/services/agent-profiles';
import { resetAgentModelCatalogCacheForTests } from '../../src/services/agent-models/catalog';
import { updateProjectAgentModelSettings } from '../../src/services/agent-models/project-settings';
import * as skillService from '../../src/services/skills';
import { callMcpTool, createJsonKv, createMcpApp, toolResult } from '../helpers/mcp-route';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const PROJECT = 'proj-1';
const OTHER_PROJECT = 'proj-2';
const USER = 'user-1';
const WORKSPACE = 'ws-1';
const SESSION = 'agent-session-1';
const PROFILE = 'profile-1';
const SKILL = 'skill-1';
const TOKEN = 'agent-token';

const CLEF_FLASH = '@cf/cloudflare/clef-flash';
const CLAIRIC = '@cf/cloudflare/clairic';
const DISTILBERT = '@cf/huggingface/distilbert-sst-2-int8';
const GPT_OSS = '@cf/openai/gpt-oss-120b';
const WHISPER = '@cf/openai/whisper-large-v3-turbo';
const FLUX = '@cf/black-forest-labs/flux-1-schnell';

function price(unit: string, usd: number) {
  return { unit, price: usd, currency: 'USD' };
}

/** Rows in the shape Cloudflare's model search returns. */
const CATALOG_ROWS = [
  {
    name: CLEF_FLASH,
    description: 'Fast decision model.',
    task: { name: 'Text Generation' },
    properties: [{ property_id: 'price', value: [price('per M input tokens', 0.038)] }],
  },
  {
    name: CLAIRIC,
    description: 'Extraction model.',
    task: { name: 'Text Generation' },
    properties: [{ property_id: 'price', value: [price('per M input tokens', 0.1)] }],
  },
  {
    name: DISTILBERT,
    description: 'Sentiment classifier.',
    task: { name: 'Text Classification' },
    properties: [{ property_id: 'price', value: [price('per M input tokens', 0.0263)] }],
  },
  {
    name: GPT_OSS,
    description: 'Open-weight reasoning model.',
    task: { name: 'Text Generation' },
    properties: [
      {
        property_id: 'price',
        value: [price('per M input tokens', 0.35), price('per M output tokens', 0.75)],
      },
    ],
  },
  {
    name: WHISPER,
    description: 'Speech recognition.',
    task: { name: 'Automatic Speech Recognition' },
    properties: [{ property_id: 'price', value: [price('per audio minute', 0.000513)] }],
  },
  {
    name: '@cf/deepgram/flux',
    description: 'Realtime speech recognition over a websocket.',
    task: { name: 'Automatic Speech Recognition' },
    properties: [{ property_id: 'price', value: [price('per audio minute (websocket)', 0.0077)] }],
  },
  {
    name: FLUX,
    description: 'Image generation.',
    task: { name: 'Text-to-Image' },
    properties: [{ property_id: 'terms', value: 'https://example.com/terms' }],
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('agent model calls through the MCP route', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono;
  let aiRun: ReturnType<typeof vi.fn>;

  // The MCP route imports every tool module; load it once so no single test pays for that.
  beforeAll(async () => {
    app = await createMcpApp();
  }, 60_000);

  beforeEach(async () => {
    resetAgentModelCatalogCacheForTests();
    transfer.downloadFromWorkspace.mockReset();
    transfer.uploadToWorkspace.mockReset();
    transfer.resolveWorkspaceVmUrl.mockReset();
    transfer.resolveWorkspaceVmUrl.mockResolvedValue({
      vmBaseUrl: 'https://node-1.vm.example.test:8443',
      nodeId: 'node-1',
    });
    transfer.uploadToWorkspace.mockResolvedValue(undefined);

    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema as unknown as Record<string, unknown>);
    for (const project of [PROJECT, OTHER_PROJECT]) {
      sqlite
        .prepare(
          "INSERT INTO projects (id, name, user_id, updated_at) VALUES (?, ?, ?, datetime('now'))"
        )
        .run(project, project, USER);
      sqlite
        .prepare(
          "INSERT INTO project_members (project_id, user_id, role, status) VALUES (?, ?, 'owner', 'active')"
        )
        .run(project, USER);
    }
    sqlite
      .prepare(
        "INSERT INTO workspaces (id, project_id, user_id, node_id, status) VALUES (?, ?, ?, 'node-1', 'running')"
      )
      .run(WORKSPACE, PROJECT, USER);
    sqlite
      .prepare(
        "INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, effort, is_builtin, created_at, updated_at) VALUES (?, ?, ?, 'Builder', 'claude-code', 'auto', 0, datetime('now'), datetime('now'))"
      )
      .run(PROFILE, PROJECT, USER);
    sqlite
      .prepare(
        "INSERT INTO skills (id, project_id, user_id, name, is_builtin, created_at, updated_at) VALUES (?, ?, ?, 'Review', 0, datetime('now'), datetime('now'))"
      )
      .run(SKILL, PROJECT, USER);
    sqlite
      .prepare(
        'INSERT INTO agent_sessions (id, workspace_id, user_id, agent_profile_id, skill_id) VALUES (?, ?, ?, ?, ?)'
      )
      .run(SESSION, WORKSPACE, USER, PROFILE, SKILL);

    aiRun = vi.fn(async () =>
      jsonResponse({
        answers: { done: { type: 'noul', noul: 0.97 } },
        usage: { prompt_tokens: 1000 },
      })
    );
    const kv = createJsonKv();
    await kv.put(
      `mcp:${TOKEN}`,
      JSON.stringify({
        taskId: 'task-1',
        projectId: PROJECT,
        userId: USER,
        workspaceId: WORKSPACE,
        agentSessionId: SESSION,
        createdAt: new Date().toISOString(),
      })
    );
    env = {
      DATABASE: createSqliteD1(sqlite),
      KV: kv,
      AI: { run: aiRun, models: vi.fn(async () => CATALOG_ROWS) },
      AI_GATEWAY_ID: 'sam-gateway',
      BASE_DOMAIN: 'example.test',
    } as unknown as Env;
  });

  afterEach(() => sqlite.close());

  const db = () => drizzle(env.DATABASE, { schema });

  function usageRow(projectId = PROJECT) {
    return sqlite
      .prepare(
        'SELECT reserved_micro_usd AS reserved, spent_micro_usd AS spent, call_count AS calls FROM agent_model_monthly_usage WHERE project_id = ?'
      )
      .get(projectId) as { reserved: number; spent: number; calls: number } | undefined;
  }

  it('lists only the SAM default models when nothing is configured, with the budget', async () => {
    const result = toolResult<{
      chosenBy: string;
      models: Array<{ id: string }>;
      otherModelsNotEnabled: number;
      budget: { limitUsd: number; remainingUsd: number };
    }>(await callMcpTool(app, env, TOKEN, 'list_ai_models', {}));

    expect(result.models.map((model) => model.id).sort()).toEqual([
      CLAIRIC,
      CLEF_FLASH,
      DISTILBERT,
    ]);
    expect(result.chosenBy).toContain('recommended');
    expect(result.otherModelsNotEnabled).toBe(4);
    expect(result.budget).toMatchObject({ limitUsd: 5, remainingUsd: 5 });
  });

  it('runs an enabled model through the gateway and charges the reported usage', async () => {
    const response = await callMcpTool(app, env, TOKEN, 'run_ai_model', {
      model: CLEF_FLASH,
      input: {
        model: 'clef-flash',
        state: 'All tests passed.',
        questions: { done: { type: 'noul', instructions: 'Is it done?' } },
      },
    });
    const result = toolResult<{
      output: unknown;
      costUsd: number;
      budget: { spentUsd: number; remainingUsd: number };
    }>(response);

    expect(result.output).toEqual({
      answers: { done: { type: 'noul', noul: 0.97 } },
      usage: { prompt_tokens: 1000 },
    });
    // 1,000 input tokens at $0.038 / M = $0.000038 = 38 micro-USD.
    expect(result.costUsd).toBe(0.000038);
    expect(aiRun).toHaveBeenCalledTimes(1);
    const [model, input, options] = aiRun.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(model).toBe(CLEF_FLASH);
    expect(input.state).toBe('All tests passed.');
    expect(options).toMatchObject({
      returnRawResponse: true,
      gateway: {
        id: 'sam-gateway',
        metadata: {
          source: 'agent-model-call',
          projectId: PROJECT,
          userId: USER,
          workspaceId: WORKSPACE,
          taskId: 'task-1',
          modelId: CLEF_FLASH,
        },
      },
    });
    expect(usageRow()).toEqual({ reserved: 0, spent: 38, calls: 1 });
    expect(
      sqlite
        .prepare(
          'SELECT call_count AS calls, spent_micro_usd AS spent FROM agent_model_usage_by_model WHERE model_id = ?'
        )
        .get(CLEF_FLASH)
    ).toEqual({ calls: 1, spent: 38 });
  });

  it('refuses a model that is not turned on, before any spend', async () => {
    const response = await callMcpTool(app, env, TOKEN, 'run_ai_model', {
      model: GPT_OSS,
      input: { messages: [{ role: 'user', content: 'hi' }] },
    });

    expect(response.error?.message).toContain('is not turned on for this agent');
    expect(aiRun).not.toHaveBeenCalled();
    expect(usageRow()).toBeUndefined();
  });

  it('lets the most specific layer win: project → profile → skill, and [] turns everything off', async () => {
    const enabledIds = async () =>
      toolResult<{ models: Array<{ id: string }>; chosenBy: string }>(
        await callMcpTool(app, env, TOKEN, 'list_ai_models', {})
      );

    await updateProjectAgentModelSettings(env, db(), PROJECT, { models: [GPT_OSS] });
    let result = await enabledIds();
    expect(result.models.map((model) => model.id)).toEqual([GPT_OSS]);
    expect(result.chosenBy).toContain('project');

    await agentProfileService.updateProfile(db(), PROJECT, PROFILE, USER, {
      agentModels: [CLAIRIC, WHISPER],
    });
    result = await enabledIds();
    expect(result.models.map((model) => model.id).sort()).toEqual([CLAIRIC, WHISPER]);
    expect(result.chosenBy).toContain('profile');

    await skillService.updateSkill(db(), PROJECT, SKILL, USER, { agentModels: [] });
    result = await enabledIds();
    expect(result.models).toEqual([]);
    expect(result.chosenBy).toContain('skill');

    // Clearing the skill override falls back to the profile, not to the defaults.
    await skillService.updateSkill(db(), PROJECT, SKILL, USER, { agentModels: null });
    result = await enabledIds();
    expect(result.models.map((model) => model.id).sort()).toEqual([CLAIRIC, WHISPER]);

    // Omitting the field on an unrelated update keeps the stored selection (rule 73).
    await agentProfileService.updateProfile(db(), PROJECT, PROFILE, USER, {
      description: 'renamed',
    });
    result = await enabledIds();
    expect(result.models.map((model) => model.id).sort()).toEqual([CLAIRIC, WHISPER]);
  });

  it('stops at the monthly budget and never lets two concurrent calls overspend it', async () => {
    // One cent: an unpriced model is charged the 10,000 micro-USD per-call estimate.
    await updateProjectAgentModelSettings(env, db(), PROJECT, {
      models: [FLUX],
      monthlyBudgetUsd: 0.01,
    });
    let release: () => void = () => undefined;
    aiRun.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve(
              new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), {
                headers: { 'content-type': 'image/png' },
              })
            );
        })
    );

    const first = callMcpTool(app, env, TOKEN, 'run_ai_model', {
      model: FLUX,
      input: { prompt: 'a lighthouse' },
    });
    // Wait until the first call holds its reservation and is waiting on the model.
    await vi.waitFor(() => expect(aiRun).toHaveBeenCalledTimes(1));
    expect(usageRow()).toMatchObject({ reserved: 10_000, spent: 0 });

    const second = await callMcpTool(app, env, TOKEN, 'run_ai_model', {
      model: FLUX,
      input: { prompt: 'a second lighthouse' },
    });
    expect(second.error?.message).toContain('monthly AI model budget is used up');
    expect(aiRun).toHaveBeenCalledTimes(1);

    release();
    const firstResult = toolResult<{
      output: { $savedFile: { path: string; contentType: string } };
    }>(await first);
    expect(firstResult.output.$savedFile.contentType).toBe('image/png');
    expect(firstResult.output.$savedFile.path).toMatch(
      /^\.ai-outputs\/flux-1-schnell-\d{8}T\d{6}-output-1\.png$/
    );
    expect(transfer.uploadToWorkspace).toHaveBeenCalledTimes(1);
    expect(usageRow()).toEqual({ reserved: 0, spent: 10_000, calls: 1 });
  });

  it('releases the hold and records an error when the model rejects the input', async () => {
    aiRun.mockResolvedValue(
      jsonResponse({ success: false, errors: [{ message: 'questions is required' }] }, 400)
    );
    const response = await callMcpTool(app, env, TOKEN, 'run_ai_model', {
      model: CLEF_FLASH,
      input: { state: 'x' },
    });

    expect(response.error?.message).toContain('questions is required');
    expect(usageRow()).toEqual({ reserved: 0, spent: 0, calls: 1 });
    expect(
      sqlite
        .prepare('SELECT error_count AS errors FROM agent_model_usage_by_model WHERE model_id = ?')
        .get(CLEF_FLASH)
    ).toEqual({ errors: 1 });
  });

  it('keeps the estimate charged when the model times out', async () => {
    aiRun.mockRejectedValue(
      Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })
    );
    const response = await callMcpTool(app, env, TOKEN, 'run_ai_model', {
      model: CLEF_FLASH,
      input: { state: 'x'.repeat(3_000), questions: {} },
    });

    expect(response.error?.message).toContain('did not answer');
    const row = usageRow();
    expect(row?.reserved).toBe(0);
    expect(row?.spent).toBeGreaterThan(0);
  });

  it('sends a workspace file as base64 and charges audio by the reported duration', async () => {
    await updateProjectAgentModelSettings(env, db(), PROJECT, { models: [WHISPER] });
    const audio = new Uint8Array([0x49, 0x44, 0x33, 4, 5, 6]);
    transfer.downloadFromWorkspace.mockResolvedValue({
      data: audio.buffer,
      contentType: 'audio/mpeg',
    });
    aiRun.mockResolvedValue(
      jsonResponse({ text: 'hello world', transcription_info: { duration: 120 } })
    );

    const result = toolResult<{ output: { text: string }; costUsd: number }>(
      await callMcpTool(app, env, TOKEN, 'run_ai_model', {
        model: WHISPER,
        input: { audio: { $file: 'recordings/standup.mp3' } },
      })
    );

    expect(transfer.downloadFromWorkspace).toHaveBeenCalledWith(
      env,
      'https://node-1.vm.example.test:8443',
      'node-1',
      WORKSPACE,
      USER,
      'recordings/standup.mp3',
      expect.any(Number)
    );
    const [, input] = aiRun.mock.calls[0] as [string, { audio: string }];
    expect(input.audio).toBe(btoa(String.fromCharCode(...audio)));
    expect(result.output.text).toBe('hello world');
    // 2 minutes at $0.000513 / minute = $0.001026.
    expect(result.costUsd).toBe(0.001026);
  });

  it('charges the held estimate when the model ran but its output could not be saved', async () => {
    await updateProjectAgentModelSettings(env, db(), PROJECT, { models: [FLUX] });
    aiRun.mockResolvedValue(
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]), {
        headers: { 'content-type': 'image/png' },
      })
    );
    transfer.uploadToWorkspace.mockRejectedValue(new Error('VM agent upload failed: 507'));

    const response = await callMcpTool(app, env, TOKEN, 'run_ai_model', {
      model: FLUX,
      input: { prompt: 'a lighthouse' },
    });

    expect(response.error?.message).toContain('VM agent upload failed');
    expect(usageRow()).toEqual({ reserved: 0, spent: 10_000, calls: 1 });
  });

  it('refuses an absolute or escaping outputDirectory before any call', async () => {
    for (const outputDirectory of ['/etc/cron.d', '../outside']) {
      const response = await callMcpTool(app, env, TOKEN, 'run_ai_model', {
        model: CLEF_FLASH,
        input: { state: 'x', questions: {} },
        outputDirectory,
      });
      expect(response.error?.message).toContain('outputDirectory');
    }
    expect(aiRun).not.toHaveBeenCalled();
    expect(usageRow()).toBeUndefined();
  });

  it('refuses a websocket-only model before holding any budget', async () => {
    await updateProjectAgentModelSettings(env, db(), PROJECT, { models: ['@cf/deepgram/flux'] });

    const response = await callMcpTool(app, env, TOKEN, 'run_ai_model', {
      model: '@cf/deepgram/flux',
      input: { audio: 'AAAA' },
    });

    expect(response.error?.message).toContain('realtime (websocket)');
    expect(aiRun).not.toHaveBeenCalled();
    expect(usageRow()).toBeUndefined();
  });

  it('honours the administrator kill switch', async () => {
    sqlite
      .prepare(
        "INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES ('aiModels.enabled', 'false', datetime('now'), 'admin')"
      )
      .run();

    const list = toolResult<{ enabled: boolean }>(
      await callMcpTool(app, env, TOKEN, 'list_ai_models', {})
    );
    expect(list.enabled).toBe(false);
    const run = await callMcpTool(app, env, TOKEN, 'run_ai_model', {
      model: CLEF_FLASH,
      input: { state: 'x', questions: {} },
    });
    expect(run.error?.message).toContain('turned off');
    expect(aiRun).not.toHaveBeenCalled();
  });

  it("never reads another project's profile, and charges only the caller's project", async () => {
    // A profile that belongs to another project, pointed at by this session.
    sqlite
      .prepare(
        "INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, effort, is_builtin, agent_models_json, created_at, updated_at) VALUES ('foreign', ?, ?, 'Foreign', 'claude-code', 'auto', 0, ?, datetime('now'), datetime('now'))"
      )
      .run(OTHER_PROJECT, USER, JSON.stringify([GPT_OSS]));
    sqlite
      .prepare(
        "UPDATE agent_sessions SET agent_profile_id = 'foreign', skill_id = NULL WHERE id = ?"
      )
      .run(SESSION);

    const response = await callMcpTool(app, env, TOKEN, 'run_ai_model', {
      model: GPT_OSS,
      input: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(response.error).toBeDefined();
    expect(aiRun).not.toHaveBeenCalled();

    // Owner control: the same session on its own project's profile works.
    sqlite
      .prepare('UPDATE agent_sessions SET agent_profile_id = ? WHERE id = ?')
      .run(PROFILE, SESSION);
    await agentProfileService.updateProfile(db(), PROJECT, PROFILE, USER, {
      agentModels: [GPT_OSS],
    });
    aiRun.mockResolvedValue(
      jsonResponse({ response: 'hello', usage: { prompt_tokens: 10, completion_tokens: 5 } })
    );
    toolResult(
      await callMcpTool(app, env, TOKEN, 'run_ai_model', {
        model: GPT_OSS,
        input: { messages: [{ role: 'user', content: 'hi' }] },
      })
    );
    expect(usageRow(PROJECT)?.calls).toBe(1);
    expect(usageRow(OTHER_PROJECT)).toBeUndefined();
  });
});
