/**
 * The brief's facts and its read against a real SQL engine. Which asks are facts is a SQL
 * predicate over membership and assignment, and every read binds the project, so a foreign
 * project's rows are seeded beside the owner's and must never appear (rule 11, rule 28 section 5).
 * Each attack case has an owner-path control.
 */
import {
  BRIEF_FAILED_CHATS_SQL,
  BRIEF_FAILING_AUTOMATIONS_SQL,
  BRIEF_MERGED_PULL_REQUESTS_SQL,
  BRIEF_NEW_IDEAS_SQL,
  briefFactsAreQuiet,
  briefFactsFingerprint,
  readBriefFacts,
  briefText,
  readProjectBrief,
} from '@simple-agent-manager/operations';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import {
  createAllSchemaTables,
  createDeclaredIndexes,
  createSqliteD1,
} from '../../helpers/sqlite-d1';

const NOW = 1_794_000_000_000;
const ISO_NOW = new Date(NOW).toISOString();

describe('project brief facts and read', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  function insert(table: string, row: Record<string, string | number | null>): void {
    const columns = Object.keys(row);
    sqlite
      .prepare(
        `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
      )
      .run(...Object.values(row));
  }

  function ask(id: string, fields: Record<string, string | number | null> = {}): void {
    insert('asks', {
      id,
      project_id: 'p',
      assignee_kind: 'user',
      assignee_user_id: 'owner',
      kind: 'question',
      blocking: 1,
      title: `Ask ${id}`,
      status: 'open',
      created_at: NOW - 60_000,
      updated_at: NOW - 60_000,
      ...fields,
    });
  }

  function runningChat(id: string, projectId = 'p'): void {
    insert('tasks', {
      id: `task-${id}`,
      project_id: projectId,
      user_id: 'owner',
      title: `Task ${id}`,
      status: 'in_progress',
      execution_step: 'running',
      chat_session_id: id,
      created_at: ISO_NOW,
      updated_at: ISO_NOW,
    });
    insert('session_summaries', {
      id,
      project_id: projectId,
      user_id: 'owner',
      status: 'active',
      topic: `Chat ${id}`,
      task_id: `task-${id}`,
      message_count: 1,
      started_at: NOW - 60_000,
      created_at: NOW - 60_000,
      last_message_at: NOW - 1_000,
      agent_completed_at: null,
      attention_json: null,
      created_by_user_id: 'owner',
      updated_at: NOW,
    });
  }

  function trigger(
    id: string,
    runs: string[],
    fields: Record<string, string | number | null> = {}
  ) {
    insert('triggers', {
      id,
      project_id: 'p',
      user_id: 'owner',
      name: `Automation ${id}`,
      status: 'active',
      source_type: 'cron',
      prompt_template: 'Do the thing',
      ...fields,
    });
    // `runs` newest first.
    runs.forEach((status, index) =>
      insert('trigger_executions', {
        id: `${id}-run-${index}`,
        trigger_id: id,
        project_id: String(fields.project_id ?? 'p'),
        status,
        sequence_number: runs.length - index,
      })
    );
  }

  function window(
    reference: string,
    source: string,
    level: string,
    fields: Record<string, string | number | null> = {}
  ) {
    insert('credential_limit_windows', {
      project_id: 'p',
      credential_reference: reference,
      window_type: 'claude.five_hour',
      credential_source: source,
      provider: 'anthropic',
      provider_mode: 'direct',
      user_id: 'owner',
      source: 'test',
      status: 'allowed_warning',
      last_event_level: level,
      observed_at: NOW,
      created_at: NOW,
      updated_at: NOW,
      ...fields,
    });
  }

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(`
      INSERT INTO projects (id, name, repository) VALUES ('p', 'Project', 'acme/app'), ('foreign', 'Other', 'acme/other');
      INSERT INTO users (id, name, email) VALUES ('owner','Owner','o@example.com'), ('teammate','Mate','m@example.com'), ('outsider','Out','x@example.com');
      INSERT INTO project_members (project_id, user_id, role, status) VALUES
        ('p','owner','owner','active'), ('foreign','outsider','owner','active');
    `);
    db = createSqliteD1(sqlite) as unknown as D1Database;
  });
  afterEach(() => sqlite.close());

  const addTeammate = () =>
    insert('project_members', {
      project_id: 'p',
      user_id: 'teammate',
      role: 'member',
      status: 'active',
    });

  describe('asks every member may see', () => {
    it('includes the only member’s own ask (control) and leaves out answered, expired and foreign ones', async () => {
      ask('mine');
      ask('answered', { status: 'answered' });
      ask('expired', { expires_at: NOW - 1 });
      ask('foreign-ask', { project_id: 'foreign', assignee_user_id: 'outsider' });
      const facts = await readBriefFacts(db, 'p', NOW);
      expect(facts.asks.map((a) => a.id)).toEqual(['mine']);
    });

    it('with another active member, a user’s own ask and a claimed team ask are not facts; an unclaimed team ask is', async () => {
      addTeammate();
      ask('mine');
      ask('claimed', {
        assignee_kind: 'team',
        assignee_user_id: null,
        claimed_by_user_id: 'owner',
      });
      ask('team', { assignee_kind: 'team', assignee_user_id: null });
      const facts = await readBriefFacts(db, 'p', NOW);
      expect(facts.asks.map((a) => a.id)).toEqual(['team']);
    });

    it('a removed member does not hide anything (only active members count)', async () => {
      insert('project_members', {
        project_id: 'p',
        user_id: 'teammate',
        role: 'member',
        status: 'removed',
      });
      ask('mine');
      expect((await readBriefFacts(db, 'p', NOW)).asks.map((a) => a.id)).toEqual(['mine']);
    });

    it('cleans and caps titles, blocking first, and gives ages in words', async () => {
      ask('later', { blocking: 0, created_at: NOW - 3 * 86_400_000 });
      ask('long', {
        title: `Line one\nline two\u0007 ${'x'.repeat(300)}`,
        created_at: NOW - 30 * 60_000,
      });
      const facts = await readBriefFacts(db, 'p', NOW);
      expect(facts.asks.map((a) => [a.id, a.blocking, a.age])).toEqual([
        ['long', true, 'just now'],
        ['later', false, 'this week'],
      ]);
      expect(facts.asks[0]!.title).not.toMatch(/\n|\p{Cc}/u);
      expect(facts.asks[0]!.title.length).toBeLessThanOrEqual(120);
    });
  });

  it('reads running chats, failing automations and shared accounts, never another project’s', async () => {
    runningChat('live');
    runningChat('elsewhere', 'foreign');
    trigger('broken', ['failed', 'failed', 'failed', 'completed']);
    trigger('recovered', ['completed', 'failed', 'failed', 'failed']);
    trigger('two-failures', ['failed', 'failed', 'completed']);
    trigger('disabled', ['failed', 'failed', 'failed'], { status: 'disabled' });
    trigger('foreign-trigger', ['failed', 'failed', 'failed'], {
      project_id: 'foreign',
      user_id: 'outsider',
    });
    window('platform-cred', 'platform', 'critical');
    window('project-cred', 'project', 'warning');
    window('my-cred', 'user', 'rejected');
    window('reset-cred', 'platform', 'rejected', { resets_at: NOW - 1 });
    window('calm-cred', 'project', 'ok');

    const facts = await readBriefFacts(db, 'p', NOW);
    expect(facts.runningChats.map((c) => c.id)).toEqual(['live']);
    expect(facts.failingAutomations.map((a) => a.id)).toEqual(['broken']);
    expect(facts.accounts.map((a) => [a.id, a.level])).toEqual([
      ['platform-cred', 'critical'],
      ['project-cred', 'warning'],
    ]);
    expect(briefFactsAreQuiet(facts)).toBe(false);
  });

  it('is quiet with nothing open and nothing running, and the fingerprint follows only material changes', async () => {
    const empty = await readBriefFacts(db, 'p', NOW);
    expect(briefFactsAreQuiet(empty)).toBe(true);

    ask('a');
    runningChat('live');
    const before = await briefFactsFingerprint(await readBriefFacts(db, 'p', NOW));
    // A new idea is an input but not a reason to regenerate.
    insert('tasks', {
      id: 'idea-1',
      project_id: 'p',
      user_id: 'owner',
      title: 'An idea',
      status: 'draft',
      is_idea: 1,
      created_at: ISO_NOW,
      updated_at: ISO_NOW,
    });
    const withIdea = await readBriefFacts(db, 'p', NOW);
    expect(withIdea.newIdeas.map((i) => i.id)).toEqual(['idea-1']);
    expect(await briefFactsFingerprint(withIdea)).toBe(before);
    // Answering the ask is.
    sqlite.prepare(`UPDATE asks SET status = 'answered' WHERE id = 'a'`).run();
    expect(await briefFactsFingerprint(await readBriefFacts(db, 'p', NOW))).not.toBe(before);
  });

  describe('readProjectBrief', () => {
    function storeBrief(
      sentences: unknown[],
      refs: { asks?: string[]; chats?: string[]; automations?: string[]; accounts?: string[] } = {},
      fields: Record<string, string | number | null> = {}
    ) {
      insert('project_briefs', {
        project_id: 'p',
        brief_json: JSON.stringify({ sentences }),
        ref_asks_json: JSON.stringify(refs.asks ?? []),
        ref_chats_json: JSON.stringify(refs.chats ?? []),
        ref_automations_json: JSON.stringify(refs.automations ?? []),
        ref_accounts_json: JSON.stringify(refs.accounts ?? []),
        fingerprint: 'f',
        generated_at: NOW - 60_000,
        checked_at: NOW - 60_000,
        updated_at: NOW,
        ...fields,
      });
    }
    const about = (kind: string, id: string) => ({
      parts: [{ ref: { kind, id, label: id } }, { text: ' matters.' }],
    });

    it('drops a claim whose ask is answered, or whose ask belongs to another project; keeps an open one (control)', async () => {
      ask('open-ask');
      ask('answered-ask', { status: 'answered' });
      ask('foreign-open', { project_id: 'foreign', assignee_user_id: 'outsider' });
      storeBrief(
        [about('ask', 'open-ask'), about('ask', 'answered-ask'), about('ask', 'foreign-open')],
        { asks: ['open-ask', 'answered-ask', 'foreign-open'] }
      );
      const brief = await readProjectBrief(db, 'p', NOW);
      expect(
        brief?.sentences.map((s) => ('ref' in s.parts[0]! ? s.parts[0].ref.id : null))
      ).toEqual(['open-ask']);
      expect(brief?.stale).toBe(true);
    });

    it('drops a running-chat claim once the chat ends and a foreign chat never counts as running; a failed-chat claim stays', async () => {
      runningChat('live');
      runningChat('foreign-live', 'foreign');
      runningChat('ended');
      sqlite.prepare(`UPDATE tasks SET status = 'completed' WHERE id = 'task-ended'`).run();
      storeBrief([about('chat', 'live'), about('chat', 'ended'), about('chat', 'failed-earlier')], {
        chats: ['live', 'ended'],
      });
      const brief = await readProjectBrief(db, 'p', NOW);
      expect(
        brief?.sentences.map((s) => ('ref' in s.parts[0]! ? s.parts[0].ref.id : null))
      ).toEqual(['live', 'failed-earlier']);
      // A chat id that is running in another project never counts as running here.
      sqlite
        .prepare(`UPDATE project_briefs SET brief_json = ?, ref_chats_json = ?`)
        .run(
          JSON.stringify({ sentences: [about('chat', 'foreign-live'), about('chat', 'live')] }),
          JSON.stringify(['foreign-live', 'live'])
        );
      const scoped = await readProjectBrief(db, 'p', NOW);
      expect(
        scoped?.sentences.map((s) => ('ref' in s.parts[0]! ? s.parts[0].ref.id : null))
      ).toEqual(['live']);
    });

    it('is fresh when every claim still holds, and null when none does', async () => {
      ask('open-ask');
      storeBrief([about('ask', 'open-ask')], { asks: ['open-ask'] });
      expect(await readProjectBrief(db, 'p', NOW)).toEqual({
        sentences: [about('ask', 'open-ask')],
        generatedAt: new Date(NOW - 60_000).toISOString(),
        stale: false,
        refreshing: false,
      });
      sqlite.prepare(`UPDATE asks SET status = 'archived'`).run();
      expect(await readProjectBrief(db, 'p', NOW)).toBeNull();
    });

    it('says refreshing while a generation is in flight, and not after it is abandoned', async () => {
      ask('open-ask');
      storeBrief(
        [about('ask', 'open-ask')],
        { asks: ['open-ask'] },
        { pending_since: NOW - 10_000 }
      );
      expect(await readProjectBrief(db, 'p', NOW)).toMatchObject({ stale: true, refreshing: true });
      expect(await readProjectBrief(db, 'p', NOW + 10 * 60_000)).toMatchObject({
        refreshing: false,
      });
    });

    it('hides a stale brief whose catch-up failed, and a stored brief that is not valid', async () => {
      ask('open-ask');
      storeBrief(
        [about('ask', 'open-ask')],
        { asks: ['open-ask'] },
        { stale: 1, last_error_at: NOW - 1_000 }
      );
      expect(await readProjectBrief(db, 'p', NOW)).toBeNull();
      sqlite
        .prepare(
          `UPDATE project_briefs SET stale = 0, last_error_at = NULL, brief_json = '{"sentences":[{"parts":[{"ref":{"kind":"evil","id":"x","label":"x"}}]}]}'`
        )
        .run();
      expect(await readProjectBrief(db, 'p', NOW)).toBeNull();
      sqlite
        .prepare(
          `UPDATE project_briefs SET brief_json = '{"sentences":[{"parts":[{"ref":{"kind":"pullRequest","id":"1","label":"x","url":"javascript:alert(1)"}}]}]}'`
        )
        .run();
      expect(await readProjectBrief(db, 'p', NOW)).toBeNull();
    });

    it('drops an ask claim once a second member joins: they must not see, through the brief, an ask their inbox hides (owner control first)', async () => {
      ask('mine');
      storeBrief([about('ask', 'mine')], { asks: ['mine'] });
      expect(await readProjectBrief(db, 'p', NOW)).not.toBeNull();
      addTeammate();
      expect(await readProjectBrief(db, 'p', NOW)).toBeNull();
    });

    it('drops a claim about an expired ask the sweep has not closed yet', async () => {
      ask('expiring', { expires_at: NOW + 1_000 });
      storeBrief([about('ask', 'expiring')], { asks: ['expiring'] });
      expect(await readProjectBrief(db, 'p', NOW)).not.toBeNull();
      expect(await readProjectBrief(db, 'p', NOW + 2_000)).toBeNull();
    });

    it('re-checks a named account, and never sends its credential reference to the page', async () => {
      window('cc_credentials:shared-anthropic', 'project', 'critical');
      storeBrief(
        [
          {
            parts: [
              {
                ref: {
                  kind: 'account',
                  id: 'cc_credentials:shared-anthropic',
                  label: "the project's anthropic account",
                },
              },
              { text: ' is almost out of usage.' },
            ],
          },
        ],
        { accounts: ['cc_credentials:shared-anthropic'] }
      );
      const brief = await readProjectBrief(db, 'p', NOW);
      expect(brief?.sentences[0]?.parts[0]).toEqual({
        ref: { kind: 'account', id: 'account', label: "the project's anthropic account" },
      });
      expect(JSON.stringify(brief)).not.toContain('cc_credentials:');
      // Back to calm: the claim is no longer true.
      sqlite.prepare(`UPDATE credential_limit_windows SET last_event_level = 'ok'`).run();
      expect(await readProjectBrief(db, 'p', NOW)).toBeNull();
    });

    it('reads a malformed ref list as empty instead of failing the read', async () => {
      ask('open-ask');
      storeBrief([about('chat', 'failed-earlier')], {}, { ref_asks_json: 'not json' });
      expect(await readProjectBrief(db, 'p', NOW)).not.toBeNull();
    });
  });

  it('strips invisible and smuggling characters from titles', () => {
    const tagged = `Ship${String.fromCodePoint(0xe0041, 0xe0042)} it\u2060 now\ufeff`;
    expect(briefText(tagged, 'x')).toBe('Ship it now');
  });

  describe('query plans at production indexes (rule 69)', () => {
    function plan(sql: string, params: unknown[]): string {
      return (
        sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>
      )
        .map((row) => row.detail)
        .join('\n');
    }
    beforeEach(() => {
      createDeclaredIndexes(sqlite, Object.values(schema).filter(isTable));
    });
    function isTable(value: unknown): value is Parameters<typeof createDeclaredIndexes>[1][number] {
      return (
        typeof value === 'object' &&
        value !== null &&
        Symbol.for('drizzle:IsDrizzleTable') in (value as object)
      );
    }

    it('reads each trigger’s newest runs without sorting its history', () => {
      const detail = plan(BRIEF_FAILING_AUTOMATIONS_SQL, ['p', 3, 3, 8]).split('\n');
      // Each trigger's runs come straight off the new index, newest first.
      const te = detail.findIndex((line) => line.startsWith('SEARCH te'));
      expect(detail[te]).toBe(
        'SEARCH te USING INDEX idx_trigger_executions_trigger_sequence (trigger_id=?)'
      );
      // The only sort is the outer one over this project's (capped) triggers by name.
      expect(detail.filter((line) => line.includes('TEMP B-TREE'))).toEqual([
        'USE TEMP B-TREE FOR LAST TERM OF ORDER BY',
      ]);
    });

    it('drives failed chats from the project’s failed tasks, not its whole chat history', () => {
      const detail = plan(BRIEF_FAILED_CHATS_SQL, ['p', '2026-11-15', '2026-11-15T00:00:00Z', 8]);
      expect(detail).toMatch(/SEARCH t USING INDEX \S+ \(project_id=\? AND status=\?/);
      expect(detail).toMatch(/SEARCH ss USING INDEX idx_session_summaries_task \(task_id=\?\)/);
    });

    it('bounds merged pull requests and new ideas by date in the index', () => {
      expect(
        plan(BRIEF_MERGED_PULL_REQUESTS_SQL, ['p', '2026-11-09', '2026-11-09T00:00:00Z', 8])
      ).toMatch(/merged_at>\?/);
      expect(plan(BRIEF_NEW_IDEAS_SQL, ['p', '2026-11-09', '2026-11-09T00:00:00Z', 8])).toMatch(
        /created_at>\?/
      );
    });
  });
});
