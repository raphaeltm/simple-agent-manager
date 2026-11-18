/**
 * projectSetups (Insights · Agent setups) against a real SQL engine. Foreign-project rows are
 * seeded beside the owner's, each one a row that would change a number if a project predicate or a
 * join's project condition were missing (rules 11 and 28), and each attack has an owner control:
 * the same row in the owner's project does change the number.
 */
import type { OperationContext } from '@simple-agent-manager/operations';
import { projectSetups } from '@simple-agent-manager/operations';
import { agentSetups } from '@simple-agent-manager/operations/internal/insights-agent';
import type { RunNudgeWindow } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createOperationPorts } from '../../../src/operation-ports';
import { invalidateAdminSettings } from '../../../src/services/admin-settings';
import { recordHarnessRunUsage, recordProxyRunUsage } from '../../../src/services/agent-run-usage';
import { countD1RoundTrips } from '../../helpers/insights-d1';
import {
  createAllSchemaTables,
  createDeclaredIndexes,
  createSqliteD1,
} from '../../helpers/sqlite-d1';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const DAY = 86_400_000;
const GIB = 1024 ** 3;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const reservation = (memoryMb: number) =>
  JSON.stringify({
    version: 1,
    cpuMillis: 2000,
    memoryMb,
    diskMb: 10240,
    exclusiveNode: false,
    source: 'platform',
    sourceId: 'platform',
  });

type Row = Record<string, string | number | null>;

describe('projectSetups', () => {
  let sqlite: Database.Database;
  let env: Env;
  let nudgeCalls: RunNudgeWindow[][];
  let nudgeAnswer: (windows: RunNudgeWindow[]) => Array<number | null>;
  let prNumber = 0;

  function ctx(userId = 'owner'): OperationContext {
    const ports = createOperationPorts(env);
    return {
      env,
      ports: {
        ...ports,
        projectData: {
          ...ports.projectData,
          countRunNudges: async (_projectId: string, windows: RunNudgeWindow[]) => {
            nudgeCalls.push(windows);
            return { counts: nudgeAnswer(windows) };
          },
        },
      },
      requestId: 'test',
      actor: { userId, via: 'web', scopes: new Set(['sam.read']) },
    };
  }

  function insert(table: string, row: Row): void {
    const columns = Object.keys(row);
    sqlite
      .prepare(
        `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
      )
      .run(...Object.values(row));
  }

  function profile(id: string, name: string, projectId: string | null, userId = 'owner'): void {
    insert('agent_profiles', { id, project_id: projectId, user_id: userId, name });
  }

  function skill(id: string, name: string, fields: Row = {}): void {
    insert('skills', { id, project_id: 'p', user_id: 'owner', name, ...fields });
  }

  function pullRequest(fields: Row): string {
    prNumber += 1;
    const number = (fields.number as number | undefined) ?? prNumber;
    const url = (fields.url as string | undefined) ?? `https://github.com/acme/app/pull/${number}`;
    insert('pull_requests', {
      id: `pr-${prNumber}`,
      project_id: 'p',
      repository: 'acme/app',
      number,
      url,
      state: 'open',
      head_ref: null,
      created_at: iso(5 * DAY),
      updated_at: iso(5 * DAY),
      last_synced_at: iso(5 * DAY),
      ...fields,
    });
    return url;
  }

  /** A finished run with a workspace, an agent session and a chat. */
  function run(id: string, fields: Row = {}, session: Row = {}): void {
    const projectId = (fields.project_id as string | undefined) ?? 'p';
    insert('workspaces', {
      id: `w-${id}`,
      project_id: projectId,
      user_id: 'owner',
      name: `ws ${id}`,
      repository: 'acme/app',
      branch: 'main',
      status: 'deleted',
      vm_size: 'small',
      vm_location: 'fsn1',
      resolved_reservation_json: reservation(8192),
    });
    insert('agent_sessions', {
      id: `s-${id}`,
      workspace_id: `w-${id}`,
      user_id: 'owner',
      status: 'stopped',
      agent_type: 'claude-code',
      runtime_contract_json: JSON.stringify({ model: 'claude-opus-5-5' }),
      ...session,
    });
    insert('tasks', {
      id,
      project_id: projectId,
      user_id: 'owner',
      title: `Run ${id}`,
      status: 'completed',
      task_mode: 'task',
      is_idea: 0,
      workspace_id: `w-${id}`,
      chat_session_id: `chat-${id}`,
      created_at: iso(6 * DAY),
      updated_at: iso(5 * DAY),
      completed_at: iso(5 * DAY),
      ...fields,
    });
  }

  function memory(taskId: string, peakGb: number, fields: Row = {}): void {
    const id = `rs-${taskId}-${Math.random().toString(36).slice(2)}`;
    insert('workspace_resource_summaries', {
      id,
      project_id: 'p',
      workspace_id: `w-${taskId}`,
      task_id: taskId,
      source_version: 1,
      started_at: NOW - 6 * DAY,
      ended_at: NOW - 5 * DAY,
      sample_count: 10,
      memory_peak_bytes: Math.round(peakGb * GIB),
      oom_count: 0,
      completeness_json: '{}',
      summary_json: '{}',
      created_at: NOW - 5 * DAY,
      updated_at: NOW - 5 * DAY,
      ...fields,
    });
  }

  function usage(chatSessionId: string, tokens: number, fields: Row = {}): void {
    insert('agent_run_usage', {
      project_id: 'p',
      chat_session_id: chatSessionId,
      source: 'harness',
      usage_epoch: 'e1',
      model: 'claude-opus-5-5',
      credential_key: '',
      input_tokens: tokens,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      created_at: NOW - 5 * DAY,
      updated_at: NOW - 5 * DAY,
      ...fields,
    });
  }

  /** The same one-row admission setup for accepted and marker-only callback reports. */
  function limitedUsageRun(id: string) {
    createDeclaredIndexes(sqlite, [schema.agentRunUsage, schema.agentRunUsageAdmissionHits]);
    sqlite.exec(
      "INSERT INTO platform_settings(key,value,updated_at) VALUES ('insights.runUsageMaxRowsPerSession','1','2026-11-16T12:00:00.000Z')"
    );
    invalidateAdminSettings(env);
    run(id);
    const scope = {
      projectId: 'p',
      chatSessionId: `chat-${id}`,
      workspaceId: `w-${id}`,
      agentSessionId: `s-${id}`,
      agentType: 'claude-code',
      credentialReference: null,
      credentialSource: null,
    };
    const model = {
      model: 'claude-opus-5-5',
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: null,
    };
    return { scope, model };
  }

  beforeEach(() => {
    prNumber = 0;
    nudgeCalls = [];
    nudgeAnswer = (windows) => windows.map(() => 0);
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(`
      INSERT INTO users (id, name, email) VALUES ('owner','Owner','o@example.com'),
        ('mate','Mate','m@example.com'), ('outsider','Out','x@example.com');
      INSERT INTO projects (id, name, repository, user_id) VALUES ('p', 'Project', 'acme/app', 'owner'),
        ('foreign', 'Other', 'acme/app', 'outsider');
      INSERT INTO project_members (project_id, user_id, role, status) VALUES
        ('p','owner','owner','active'), ('p','mate','member','active'), ('foreign','outsider','owner','active');
    `);
    env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'example.test' } as unknown as Env;
  });
  afterEach(() => sqlite.close());

  it('discloses rejected usage for a picked run while keeping proxy measurements complete', async () => {
    const { scope, model } = limitedUsageRun('limited');
    await recordHarnessRunUsage(env, scope, 'accepted', [model], NOW);
    await recordHarnessRunUsage(env, scope, 'refused', [model], NOW);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM agent_run_usage').get()).toEqual({ n: 1 });
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM agent_run_usage_admission_hits').get()
    ).toEqual({ n: 1 });
    sqlite.exec('UPDATE agent_run_usage_admission_hits SET last_rejected_at=0');
    const partial = await projectSetups(ctx(), { projectId: 'p', nowMs: NOW });
    expect(partial.groups[0]?.tokens).toMatchObject({ state: 'reported', total: 11 });
    expect(partial).toHaveProperty('usageAdmissionLimited', true);
    expect(agentSetups(partial)).toHaveProperty('usageAdmissionLimited', true);
    await recordProxyRunUsage(
      env,
      scope,
      model.model,
      { ...model, inputTokens: 90, outputTokens: 9 },
      NOW
    );
    const complete = await projectSetups(ctx(), { projectId: 'p', nowMs: NOW });
    expect(complete.groups[0]?.tokens).toMatchObject({ state: 'reported', total: 99 });
    expect(complete).toHaveProperty('usageAdmissionLimited', false);
    expect(agentSetups(complete)).toHaveProperty('usageAdmissionLimited', false);
  });

  it('ignores a foreign marker with the same chat id and keeps the owner run exact', async () => {
    run('scope');
    usage('chat-scope', 11);
    insert('agent_run_usage_admission_hits', {
      project_id: 'foreign',
      chat_session_id: 'chat-scope',
      last_rejected_at: NOW,
    });
    const complete = await projectSetups(ctx(), { projectId: 'p', nowMs: NOW });
    expect(complete.groups[0]?.tokens).toMatchObject({ state: 'reported', total: 11 });
    expect(complete).toHaveProperty('usageAdmissionLimited', false);
    expect(agentSetups(complete)).toHaveProperty('usageAdmissionLimited', false);
  });

  it('discloses marker-only usage only for the selected project and run window', async () => {
    const { scope, model } = limitedUsageRun('empty-usage');
    await recordHarnessRunUsage(
      env,
      scope,
      'refused',
      [model, { ...model, model: 'claude-sonnet-5-5' }],
      NOW
    );
    const partial = await projectSetups(ctx(), { projectId: 'p', range: '7d', nowMs: NOW });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM agent_run_usage').get()).toEqual({ n: 0 });
    expect(partial.groups[0]?.tokens).toMatchObject({ state: 'not_reported' });
    expect(partial).toHaveProperty('usageAdmissionLimited', true);
    expect(agentSetups(partial)).toHaveProperty('usageAdmissionLimited', true);
    expect(
      await projectSetups(ctx('outsider'), { projectId: 'foreign', nowMs: NOW })
    ).toHaveProperty('usageAdmissionLimited', false);
    sqlite
      .prepare('UPDATE tasks SET created_at=?, completed_at=? WHERE id=?')
      .run(iso(9 * DAY), iso(8 * DAY), 'empty-usage');
    expect(await projectSetups(ctx(), { projectId: 'p', range: '7d', nowMs: NOW })).toHaveProperty(
      'usageAdmissionLimited',
      false
    );
  });

  it('groups runs by profile with each measure, and names only what the viewer may see', async () => {
    profile('prof-proj', 'Opus Chat', 'p');
    profile('prof-mine', 'My Sonnet', null, 'owner');
    profile('prof-mate', 'Mate Secret Profile', null, 'mate');
    const merged = pullRequest({
      state: 'merged',
      created_at: iso(6 * DAY - 30 * 60_000),
      merged_at: iso(5 * DAY),
    });
    run('a1', { agent_profile_hint: 'prof-proj', output_pr_url: merged });
    run('a2', { agent_profile_hint: 'prof-proj', status: 'failed' });
    run('b1', {}, { agent_profile_id: 'prof-mine' });
    run('c1', { agent_profile_hint: 'prof-mate' });
    run('n1');
    memory('a1', 3);
    usage('chat-a1', 1_000_000);

    const result = await projectSetups(ctx(), { projectId: 'p', range: '30d', nowMs: NOW });
    expect(result.unavailable).toEqual([]);
    expect(result.groupBy).toBe('profile');
    const byKey = new Map(result.groups.map((g) => [g.key, g]));
    const proj = byKey.get('prof-proj');
    expect(proj).toMatchObject({
      label: 'Opus Chat',
      owner: 'project',
      runs: 2,
      finished: 2,
      merged: 1,
      mergedClean: 1,
      mergedCleanRate: 0.5,
      pullRequests: 1,
      medianToPullRequestMs: 30 * 60_000,
      tokens: { state: 'reported', total: 1_000_000, perMergedPullRequest: 1_000_000 },
      memory: { state: 'measured', p90Bytes: 3 * GIB, requestedMb: 8192, runs: 1 },
    });
    expect(byKey.get('prof-mine')).toMatchObject({ label: 'My Sonnet', owner: 'you' });
    // A teammate's personal profile is never named.
    expect(byKey.get('prof-mate')).toMatchObject({ label: null, owner: 'teammate' });
    expect(JSON.stringify(result)).not.toContain('Mate Secret Profile');
    // Runs with no profile come last.
    expect(result.groups.at(-1)).toMatchObject({ key: '__none__', owner: 'none', runs: 1 });
    expect(byKey.get('prof-mine')?.tokens).toEqual({ state: 'not_reported' });
    expect(byKey.get('prof-mine')?.memory).toEqual({ state: 'not_recorded' });
  });

  it('never counts another project’s runs, pull requests, usage, memory or follow-ups', async () => {
    skill('sk', 'do');
    const url = pullRequest({
      state: 'merged',
      head_ref: 'feat/x',
      merged_at: iso(5 * DAY),
    });
    run('own', { skill_id: 'sk', output_pr_url: url });
    // Attack rows: same chat id, same task id, same branch and same URL in another project.
    run('alien', { project_id: 'foreign', skill_id: 'sk' });
    insert('pull_requests', {
      id: 'pr-foreign-follow',
      project_id: 'foreign',
      repository: 'acme/app',
      number: 900,
      url: 'https://github.com/acme/app/pull/900',
      state: 'open',
      head_ref: 'feat/x',
      created_at: iso(4 * DAY),
      updated_at: iso(4 * DAY),
      last_synced_at: iso(4 * DAY),
    });
    usage('chat-own', 777, { project_id: 'foreign' });
    memory('own', 7, { project_id: 'foreign', id: 'rs-foreign' });

    const attacked = await projectSetups(ctx(), {
      projectId: 'p',
      groupBy: 'skill',
      nowMs: NOW,
    });
    const group = attacked.groups.find((g) => g.key === 'sk');
    expect(group).toMatchObject({ runs: 1, merged: 1, mergedClean: 1 });
    expect(group?.tokens).toEqual({ state: 'not_reported' });
    expect(group?.memory).toEqual({ state: 'not_recorded' });

    // Owner control: the same rows in the owner's project do count.
    insert('pull_requests', {
      id: 'pr-own-follow',
      project_id: 'p',
      repository: 'acme/app',
      number: 901,
      url: 'https://github.com/acme/app/pull/901',
      state: 'open',
      head_ref: 'feat/x',
      created_at: iso(4 * DAY),
      updated_at: iso(4 * DAY),
      last_synced_at: iso(4 * DAY),
    });
    usage('chat-own', 777);
    memory('own', 7);
    const owner = await projectSetups(ctx(), { projectId: 'p', groupBy: 'skill', nowMs: NOW });
    const ownGroup = owner.groups.find((g) => g.key === 'sk');
    expect(ownGroup).toMatchObject({ runs: 1, merged: 1, mergedClean: 0 });
    expect(ownGroup?.tokens).toMatchObject({ state: 'reported', total: 777 });
    expect(ownGroup?.memory).toMatchObject({ state: 'measured', p90Bytes: 7 * GIB });
  });

  it('counts a follow-up on the same branch as rework only inside the window', async () => {
    skill('sk', 'do');
    const early = pullRequest({ state: 'merged', head_ref: 'b1', merged_at: iso(20 * DAY) });
    const late = pullRequest({ state: 'merged', head_ref: 'b2', merged_at: iso(20 * DAY) });
    pullRequest({ head_ref: 'b1', created_at: iso(18 * DAY) }); // 2 days later: rework
    pullRequest({ head_ref: 'b2', created_at: iso(5 * DAY) }); // 15 days later: outside 7
    run('r1', { skill_id: 'sk', output_pr_url: early, completed_at: iso(20 * DAY) });
    run('r2', { skill_id: 'sk', output_pr_url: late, completed_at: iso(20 * DAY) });
    const result = await projectSetups(ctx(), { projectId: 'p', groupBy: 'skill', nowMs: NOW });
    expect(result.rework).toEqual({ windowDays: 7, rule: 'same_branch' });
    expect(result.groups[0]).toMatchObject({ merged: 2, mergedClean: 1, mergedCleanRate: 0.5 });
  });

  it('counts tokens once per chat and prefers the AI proxy’s measurement', async () => {
    skill('sk', 'do');
    const merged = pullRequest({ state: 'merged', merged_at: iso(5 * DAY) });
    // A woken run continues its predecessor's chat: two runs, one chat.
    run('first', { skill_id: 'sk', chat_session_id: 'chat-shared', status: 'cancelled' });
    run('second', { skill_id: 'sk', chat_session_id: 'chat-shared', output_pr_url: merged });
    usage('chat-shared', 5_000, { source: 'harness' });
    usage('chat-shared', 3_000, { source: 'ai_proxy' });
    const result = await projectSetups(ctx(), { projectId: 'p', groupBy: 'skill', nowMs: NOW });
    expect(result.groups[0]?.tokens).toEqual({
      state: 'reported',
      total: 3_000,
      perMergedPullRequest: 3_000,
      reportedRuns: 2,
      merged: 1,
    });
  });

  it('groups by model, with the harness default and unrecorded sessions apart', async () => {
    run('m1');
    run('m2', {}, { runtime_contract_json: JSON.stringify({ model: null }) });
    run('m3', {}, { runtime_contract_json: 'not json' });
    const result = await projectSetups(ctx(), { projectId: 'p', groupBy: 'model', nowMs: NOW });
    expect(result.groups.map((g) => [g.key, g.runs, g.agentType])).toEqual([
      ['default:claude-code', 2, 'claude-code'],
      ['claude-opus-5-5', 1, null],
    ]);
  });

  it('skips a malformed run row and keeps the good ones', async () => {
    run('good1');
    run('bad', {}, { runtime_contract_json: JSON.stringify({ model: 5 }) });
    run('good2');
    const result = await projectSetups(ctx(), { projectId: 'p', groupBy: 'model', nowMs: NOW });
    expect(result.unavailable).toEqual([]);
    expect(result.groups.reduce((sum, g) => sum + g.runs, 0)).toBe(2);
  });

  it('reports nudges per measured run, and marks only nudges unavailable when the read fails', async () => {
    profile('prof', 'P', 'p');
    run('x1', { agent_profile_hint: 'prof' });
    run('x2', { agent_profile_hint: 'prof' });
    run('x3', { agent_profile_hint: 'prof' });
    nudgeAnswer = (windows) => windows.map((w) => (w.sessionId === 'chat-x3' ? null : 2));
    const result = await projectSetups(ctx(), { projectId: 'p', nowMs: NOW });
    expect(nudgeCalls).toHaveLength(1);
    const window = nudgeCalls[0]?.find((w) => w.sessionId === 'chat-x1');
    expect(window).toEqual({ sessionId: 'chat-x1', fromMs: NOW - 6 * DAY, toMs: NOW - 5 * DAY });
    expect(result.groups[0]?.nudges).toEqual({ state: 'measured', perRun: 2, total: 4, runs: 2 });

    nudgeAnswer = () => {
      throw new Error('ProjectData unavailable');
    };
    const failed = await projectSetups(ctx(), { projectId: 'p', nowMs: NOW });
    expect(failed.unavailable).toEqual(['nudges']);
    // Liveness: the rest of the page still renders.
    expect(failed.groups[0]).toMatchObject({ runs: 3, nudges: { state: 'not_recorded' } });
  });

  it('suggests a default profile for a skill only with enough runs and a clear gap', async () => {
    profile('fast', 'Fast', 'p');
    profile('slow', 'Slow', 'p');
    skill('fix', 'fix', { default_profile_id: 'slow' });
    const add = (prefix: string, profileId: string, total: number, clean: number) => {
      for (let i = 0; i < total; i += 1) {
        const url = i < clean ? pullRequest({ state: 'merged', merged_at: iso(5 * DAY) }) : null;
        run(`${prefix}${i}`, {
          skill_id: 'fix',
          agent_profile_hint: profileId,
          output_pr_url: url,
        });
      }
    };
    add('f', 'fast', 10, 8);
    add('s', 'slow', 10, 5);
    const result = await projectSetups(ctx(), { projectId: 'p', groupBy: 'skill', nowMs: NOW });
    const suggestion = result.suggestions.find((s) => s.kind === 'default_profile');
    expect(suggestion).toMatchObject({
      skill: { id: 'fix', name: 'fix' },
      profile: { id: 'fast', name: 'Fast', runs: 10, mergedCleanRate: 0.8 },
      compared: { id: 'slow', runs: 10, mergedCleanRate: 0.5 },
      currentDefault: true,
      apply: { skillId: 'fix', patch: { defaultProfileId: 'fast' } },
    });
    expect(result.suggestionMinRuns).toBe(10);

    // Control: one run short of the minimum on the compared profile, no suggestion.
    sqlite.prepare("DELETE FROM tasks WHERE id = 's9'").run();
    const short = await projectSetups(ctx(), { projectId: 'p', groupBy: 'skill', nowMs: NOW });
    expect(short.suggestions.filter((s) => s.kind === 'default_profile')).toEqual([]);
  });

  it('does not suggest the profile that is already the default, or a teammate’s', async () => {
    profile('fast', 'Fast', 'p');
    profile('mate', 'Mate Profile', null, 'mate');
    skill('fix', 'fix', { default_profile_id: 'fast' });
    for (let i = 0; i < 10; i += 1) {
      const url = pullRequest({ state: 'merged', merged_at: iso(5 * DAY) });
      run(`f${i}`, { skill_id: 'fix', agent_profile_hint: 'fast', output_pr_url: url });
      run(`m${i}`, { skill_id: 'fix', agent_profile_hint: 'mate' });
    }
    const result = await projectSetups(ctx(), { projectId: 'p', groupBy: 'skill', nowMs: NOW });
    expect(result.suggestions.filter((s) => s.kind === 'default_profile')).toEqual([]);
    // Liveness: the skill's runs are all there.
    expect(result.groups[0]).toMatchObject({ key: 'fix', runs: 20 });
  });

  it('suggests a smaller memory request from the p90 peak, and never shrinks after an OOM kill', async () => {
    skill('do', 'do', {
      resource_requirements_json: JSON.stringify({ minMemoryGb: 8, minVcpu: 2 }),
    });
    for (let i = 0; i < 10; i += 1) {
      run(`r${i}`, { skill_id: 'do' });
      memory(`r${i}`, i === 9 ? 3.9 : 2 + i * 0.15);
    }
    const result = await projectSetups(ctx(), { projectId: 'p', groupBy: 'skill', nowMs: NOW });
    const size = result.suggestions.find((s) => s.kind === 'request_size');
    // p90 of ten runs is the ninth: 2 + 8 * 0.15 = 3.2 GB; with 25% headroom 4 GB.
    expect(size).toMatchObject({
      skill: { id: 'do' },
      currentGb: 8,
      suggestedGb: 4,
      runs: 10,
      oomKills: 0,
    });
    expect(
      size?.kind === 'request_size' && JSON.parse(size.apply.patch.resourceRequirementsJson)
    ).toEqual({
      minVcpu: 2,
      minMemoryGb: 4,
    });

    sqlite
      .prepare("UPDATE workspace_resource_summaries SET oom_count = 1 WHERE task_id = 'r0'")
      .run();
    const oom = await projectSetups(ctx(), { projectId: 'p', groupBy: 'skill', nowMs: NOW });
    expect(oom.suggestions.filter((s) => s.kind === 'request_size')).toEqual([]);
  });

  it('says when the run cap cut the range short, keeping the newest runs', async () => {
    for (let i = 0; i < 105; i += 1) run(`t${i}`, { created_at: iso(6 * DAY - i * 60_000) });
    const base = ctx();
    const capped: OperationContext = {
      ...base,
      ports: {
        ...base.ports,
        settings: {
          ...base.ports.settings,
          resolveDetailsMany: async (names: readonly string[]) =>
            names.map((name) => ({ value: name === 'insights.setupsRunScanCap' ? 100 : null })),
        },
      } as OperationContext['ports'],
    };
    const result = await projectSetups(capped, { projectId: 'p', nowMs: NOW });
    expect(result.sample).toEqual({ runs: 100, cap: 100, truncated: true });
    // The five oldest runs are the ones left out.
    const windows = nudgeCalls[0]?.map((w) => w.sessionId) ?? [];
    expect(windows).toContain('chat-t104');
    expect(windows).not.toContain('chat-t4');
    // Control: the default cap covers all of them.
    const full = await projectSetups(ctx(), { projectId: 'p', nowMs: NOW });
    expect(full.sample).toEqual({ runs: 105, cap: 2000, truncated: false });
  });

  it('never echoes a free-text profile hint, which can be a teammate’s profile name', async () => {
    profile('prof-mate', 'alice-private-prod-deployer', null, 'mate');
    // A task can name a profile; with no agent session the hint is all the run has.
    run('hinted', { agent_profile_hint: 'alice-private-prod-deployer' });
    sqlite.prepare("DELETE FROM agent_sessions WHERE id = 's-hinted'").run();
    run('named', { agent_profile_hint: 'prof-mate' }); // control: an id resolves to the teammate row
    // A hint naming one of the project's profiles resolves to it, as task submission does.
    profile('prof-proj', 'Claude MCP Test (Instant)', 'p');
    run('by-name', { agent_profile_hint: 'Claude MCP Test (Instant)' });
    sqlite.prepare("DELETE FROM agent_sessions WHERE id = 's-by-name'").run();
    const result = await projectSetups(ctx(), { projectId: 'p', nowMs: NOW });
    expect(JSON.stringify(result)).not.toContain('alice-private-prod-deployer');
    expect(result.groups.map((g) => [g.key, g.label, g.owner, g.runs])).toEqual([
      ['prof-mate', null, 'teammate', 1],
      ['prof-proj', 'Claude MCP Test (Instant)', 'project', 1],
      ['__not_recorded__', null, 'not_recorded', 1],
    ]);
  });

  it('never reads another project’s profile or skill through a run’s ids', async () => {
    insert('projects', {
      id: 'p2',
      name: 'Other owned',
      repository: 'acme/other',
      user_id: 'owner',
    });
    profile('prof-foreign', 'Foreign Profile Name', 'p2');
    insert('skills', {
      id: 'sk-foreign',
      project_id: 'p2',
      user_id: 'owner',
      name: 'Foreign Skill Name',
      default_profile_id: 'prof-foreign',
      resource_requirements_json: JSON.stringify({ minMemoryGb: 64 }),
    });
    for (let i = 0; i < 10; i += 1) {
      run(`f${i}`, { agent_profile_hint: 'prof-foreign', skill_id: 'sk-foreign' });
      memory(`f${i}`, 1);
    }
    const bySkill = await projectSetups(ctx(), { projectId: 'p', groupBy: 'skill', nowMs: NOW });
    const byProfile = await projectSetups(ctx(), { projectId: 'p', nowMs: NOW });
    for (const result of [bySkill, byProfile]) {
      expect(JSON.stringify(result)).not.toContain('Foreign');
      expect(result.groups.map((g) => [g.key, g.owner, g.runs])).toEqual([
        ['__not_recorded__', 'not_recorded', 10],
      ]);
      expect(result.suggestions).toEqual([]);
    }

    // Owner control: the same profile and skill in this project are named and suggested on.
    sqlite.prepare("UPDATE agent_profiles SET project_id = 'p' WHERE id = 'prof-foreign'").run();
    sqlite.prepare("UPDATE skills SET project_id = 'p' WHERE id = 'sk-foreign'").run();
    const owned = await projectSetups(ctx(), { projectId: 'p', groupBy: 'skill', nowMs: NOW });
    expect(owned.groups[0]).toMatchObject({ key: 'sk-foreign', label: 'Foreign Skill Name' });
    expect(owned.suggestions.map((s) => s.kind)).toEqual(['request_size']);
  });

  it('does not suggest the viewer’s personal profile as a project skill default', async () => {
    profile('mine', 'My Personal', null, 'owner');
    profile('proj', 'Project Profile', 'p');
    skill('fix', 'fix');
    for (let i = 0; i < 10; i += 1) {
      const url = pullRequest({ state: 'merged', merged_at: iso(5 * DAY) });
      run(`a${i}`, { skill_id: 'fix', agent_profile_hint: 'mine', output_pr_url: url });
      run(`b${i}`, { skill_id: 'fix', agent_profile_hint: 'proj' });
    }
    const result = await projectSetups(ctx(), { projectId: 'p', groupBy: 'skill', nowMs: NOW });
    expect(result.suggestions.filter((s) => s.kind === 'default_profile')).toEqual([]);
    // Control: the same numbers on a project profile are suggested.
    sqlite.prepare("UPDATE agent_profiles SET project_id = 'p' WHERE id = 'mine'").run();
    const promoted = await projectSetups(ctx(), { projectId: 'p', groupBy: 'skill', nowMs: NOW });
    expect(promoted.suggestions.find((s) => s.kind === 'default_profile')).toMatchObject({
      profile: { id: 'mine' },
    });
  });

  it('skips a memory suggestion for a skill whose stored requirements cannot be read', async () => {
    skill('do', 'do', { resource_requirements_json: '{not json' });
    skill('ok', 'ok', { resource_requirements_json: JSON.stringify({ minMemoryGb: 8 }) });
    for (let i = 0; i < 10; i += 1) {
      run(`d${i}`, { skill_id: 'do' });
      memory(`d${i}`, 2);
      run(`o${i}`, { skill_id: 'ok' });
      memory(`o${i}`, 2);
    }
    const result = await projectSetups(ctx(), { projectId: 'p', groupBy: 'skill', nowMs: NOW });
    expect(result.suggestions.map((s) => s.skill.id)).toEqual(['ok']);
    expect(result.groups.map((g) => g.runs)).toEqual([10, 10]);
  });

  it('reads past the default run cap through the real statement and keeps the newest', async () => {
    const insertMany = sqlite.transaction(() => {
      for (let i = 0; i < 2100; i += 1) run(`m${i}`, { created_at: iso(6 * DAY - i * 1000) });
    });
    insertMany();
    const started = Date.now();
    const result = await projectSetups(ctx(), { projectId: 'p', nowMs: NOW });
    expect(result.sample).toEqual({ runs: 2000, cap: 2000, truncated: true });
    expect(result.groups.reduce((sum, g) => sum + g.runs, 0)).toBe(2000);
    expect(nudgeCalls[0]).toHaveLength(2000);
    expect(nudgeCalls[0]?.map((w) => w.sessionId)).not.toContain('chat-m0');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('refuses a non-member, a foreign project, an unknown range or grouping', async () => {
    run('a1');
    await expect(projectSetups(ctx('outsider'), { projectId: 'p', nowMs: NOW })).rejects.toThrow();
    await expect(projectSetups(ctx(), { projectId: 'foreign', nowMs: NOW })).rejects.toThrow();
    await expect(
      projectSetups(ctx(), { projectId: 'p', range: '365d', nowMs: NOW })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      projectSetups(ctx(), { projectId: 'p', groupBy: 'person', nowMs: NOW })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    // Owner control: defaults work for a member.
    const result = await projectSetups(ctx('mate'), { projectId: 'p', nowMs: NOW });
    expect(result).toMatchObject({ range: '30d', groupBy: 'profile' });
    expect(result.groups[0]?.runs).toBe(1);
  });

  it('stays within its round-trip budget', async () => {
    const counted = countD1RoundTrips(env);
    env = counted.env;
    profile('prof', 'P', 'p');
    skill('sk', 'do');
    for (let i = 0; i < 120; i += 1) {
      run(`t${i}`, { agent_profile_hint: 'prof', skill_id: 'sk' });
      memory(`t${i}`, 2);
      usage(`chat-t${i}`, 100);
    }
    await projectSetups(ctx(), { projectId: 'p', nowMs: NOW }); // warm settings
    counted.reset();
    nudgeCalls = [];
    const result = await projectSetups(ctx(), { projectId: 'p', nowMs: NOW });
    expect(result.groups[0]?.runs).toBe(120);
    // Rule 60 budget for this read is 6 (Insights spec). Measured: membership and the batch on
    // D1 (settings are cached after the first call), plus one ProjectData call for nudges.
    expect(counted.trips() + nudgeCalls.length).toBe(3);
  });
});
