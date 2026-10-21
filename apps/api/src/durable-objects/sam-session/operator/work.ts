import { DEFAULT_SAM_HISTORY_LOAD_LIMIT } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import type { Env } from '../../../env';
import { parsePositiveInt } from '../../../lib/route-helpers';
import { requireProjectAccess } from '../../../middleware/project-auth';
import { OPERATOR_DEFAULTS } from '../../../services/admin-settings-registry';
import type { OperatorSettings } from '../../../services/operator-settings';
import * as projectData from '../../../services/project-data';

interface Watch {
  action_id: string;
  project_id: string;
  task_id: string;
  session_id: string;
  generation: number;
  expires_at: number;
  subscription_id: string | null;
  cursor: string | null;
  status: string;
  observed_at: number | null;
  failure_count: number;
  next_check_at: number;
}

/** A bounded, record-only consumer of the existing canonical project event backbone. */
export class OperatorWork {
  private settings: OperatorSettings = { ...OPERATOR_DEFAULTS };
  configure(settings: OperatorSettings): void {
    this.settings = settings;
  }
  constructor(
    private readonly sql: SqlStorage,
    private readonly env: Env
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS operator_work (
      action_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL,
      session_id TEXT NOT NULL, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      subscription_id TEXT, cursor TEXT, status TEXT NOT NULL DEFAULT 'accepted', observed_at INTEGER,
      failure_count INTEGER NOT NULL DEFAULT 0, next_check_at INTEGER NOT NULL DEFAULT 0
    )`);
    // Append-only upgrade for private objects created before bounded retries.
    const columns = new Set(
      sql
        .exec('PRAGMA table_info(operator_work)')
        .toArray()
        .map((column) => column.name)
    );
    if (!columns.has('failure_count'))
      sql.exec('ALTER TABLE operator_work ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('next_check_at'))
      sql.exec('ALTER TABLE operator_work ADD COLUMN next_check_at INTEGER NOT NULL DEFAULT 0');
    sql.exec(
      "CREATE TABLE IF NOT EXISTS operator_work_scan(singleton INTEGER PRIMARY KEY,cursor TEXT NOT NULL DEFAULT '')"
    );
    sql.exec('INSERT OR IGNORE INTO operator_work_scan(singleton) VALUES(1)');
    sql.exec(
      "CREATE INDEX IF NOT EXISTS operator_work_active_scan ON operator_work(generation,action_id) WHERE status NOT IN ('completed','failed','cancelled')"
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS operator_inbox (
      project_id TEXT NOT NULL, event_id TEXT NOT NULL, action_id TEXT NOT NULL,
      event_type TEXT NOT NULL, occurred_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
      processed_at INTEGER, communicated_at INTEGER, PRIMARY KEY(project_id,event_id)
    )`);
  }

  track(actionId: string, projectId: string, result: unknown, generation: number): void {
    if (!result || typeof result !== 'object') return;
    const data = result as Record<string, unknown>;
    if (typeof data.taskId !== 'string' || typeof data.sessionId !== 'string') return;
    this.sql.exec(
      'INSERT OR IGNORE INTO operator_work(action_id,project_id,task_id,session_id,generation,expires_at) VALUES(?,?,?,?,?,?)',
      actionId,
      projectId,
      data.taskId,
      data.sessionId,
      generation,
      Date.now() + this.settings.watchLifetimeMs
    );
  }

  private rows(): Watch[] {
    return this.sql
      .exec<Watch & Record<string, SqlStorageValue>>(
        'SELECT * FROM operator_work ORDER BY expires_at DESC LIMIT ?',
        Math.min(
          this.settings.eventPageSize,
          parsePositiveInt(this.env.SAM_HISTORY_LOAD_LIMIT, DEFAULT_SAM_HISTORY_LOAD_LIMIT)
        )
      )
      .toArray();
  }

  pending(generation: number): boolean {
    return this.nextAlarmAt(generation) !== null;
  }

  /** Same candidate predicate as refresh; null is the durable idle/terminal exit. */
  nextAlarmAt(generation: number): number | null {
    const now = Date.now();
    const row = this.sql
      .exec(
        `SELECT MIN(MIN(expires_at,MAX(next_check_at,?))) AS deadline
       FROM operator_work WHERE generation=? AND expires_at>? AND status NOT IN ('completed','failed','cancelled','watch_failed')`,
        now,
        generation,
        now
      )
      .toArray()[0];
    return typeof row?.deadline === 'number' ? row.deadline : null;
  }

  followup(projectId: string, sessionId: string, generation: number): void {
    const row = this.sql
      .exec<Watch & Record<string, SqlStorageValue>>(
        'SELECT * FROM operator_work WHERE project_id=? AND session_id=? ORDER BY expires_at DESC LIMIT 1',
        projectId,
        sessionId
      )
      .toArray()[0];
    if (!row) return; // Existing non-SAM work stays accessible through its source session.
    this.sql.exec(
      "UPDATE operator_work SET generation=?,expires_at=?,status='accepted',subscription_id=NULL,cursor=NULL,failure_count=0,next_check_at=0 WHERE action_id=?",
      generation,
      Date.now() + this.settings.watchLifetimeMs,
      row.action_id
    );
  }

  async refresh(
    userId: string,
    generation: number,
    assertEnabled: () => void | Promise<void>
  ): Promise<void> {
    const cursor = String(
      this.sql.exec('SELECT cursor FROM operator_work_scan WHERE singleton=1').toArray()[0]
        ?.cursor ?? ''
    );
    const page = (after: string) =>
      this.sql
        .exec<Watch & Record<string, SqlStorageValue>>(
          `SELECT * FROM operator_work WHERE generation=? AND expires_at>? AND status NOT IN ('completed','failed','cancelled','watch_failed') AND next_check_at<=? AND action_id>? ORDER BY action_id LIMIT ?`,
          generation,
          Date.now(),
          Date.now(),
          after,
          this.settings.eventPageSize
        )
        .toArray();
    let rows = page(cursor);
    if (rows.length === 0 && cursor) rows = page('');
    for (const row of rows) {
      // Commit scan progress before I/O. A failed/interrupted head watch must
      // not monopolize the next bounded page after isolate reconstruction.
      this.sql.exec('UPDATE operator_work_scan SET cursor=? WHERE singleton=1', row.action_id);
      if (row.failure_count >= this.settings.watchRetryLimit) {
        this.sql.exec(
          "UPDATE operator_work SET status='watch_failed' WHERE action_id=? AND generation=? AND expires_at=?",
          row.action_id,
          row.generation,
          row.expires_at
        );
        continue;
      }
      const nextCheck = Date.now() + this.settings.workRefreshMs;
      const claimed = this.sql.exec(
        `UPDATE operator_work SET failure_count=failure_count+1,next_check_at=?
         WHERE action_id=? AND generation=? AND expires_at=? AND next_check_at<=? AND expires_at>? AND status NOT IN ('completed','failed','cancelled','watch_failed')`,
        nextCheck,
        row.action_id,
        row.generation,
        row.expires_at,
        Date.now(),
        Date.now()
      );
      if (claimed.rowsWritten === 0) continue;
      try {
        await assertEnabled();
        await requireProjectAccess(drizzle(this.env.DATABASE), row.project_id, userId);
        await assertEnabled();
        const task = await this.env.DATABASE.prepare(
          'SELECT status FROM tasks WHERE id=? AND project_id=? AND user_id=? AND chat_session_id=?'
        )
          .bind(row.task_id, row.project_id, userId, row.session_id)
          .first<{ status: string }>();
        if (!task) throw new Error('Tracked task is unavailable');
        const owner = { type: 'human' as const, id: userId };
        const target = { sessionId: row.session_id, taskId: row.task_id };
        let subscriptionId = row.subscription_id;
        if (!subscriptionId) {
          await assertEnabled();
          const created = await projectData.createProjectEventSubscription(
            this.env,
            row.project_id,
            {
              owner,
              idempotencyKey: `sam-work:${row.action_id}:${row.expires_at}`,
              filter: { version: 1, subjectId: [row.task_id, row.session_id] },
              deliveryPreference: { requested: 'record_only', resolved: 'record_only', target },
              expiresAt: row.expires_at,
              reason: 'Private SAM updates for user-dispatched work',
            }
          );
          subscriptionId = created.subscription.id;
          this.sql.exec(
            'UPDATE operator_work SET subscription_id=? WHERE action_id=? AND generation=? AND expires_at=?',
            subscriptionId,
            row.action_id,
            row.generation,
            row.expires_at
          );
        }
        await assertEnabled();
        const page = await projectData.listProjectEventSubscriptionEvents(
          this.env,
          row.project_id,
          {
            subscriptionId,
            visibility: { owner, target, userId },
            cursor: row.cursor,
            limit: this.settings.eventPageSize,
          }
        );
        await assertEnabled();
        if (!page) throw new Error('Tracked subscription is unavailable');
        // Store only references, never raw event text or project secrets in automatic context.
        for (const event of page.events) {
          if (event.subject.id !== row.task_id && event.subject.id !== row.session_id) continue;
          this.sql.exec(
            'INSERT OR IGNORE INTO operator_inbox(project_id,event_id,action_id,event_type,occurred_at,received_at,processed_at) VALUES(?,?,?,?,?,?,?)',
            row.project_id,
            event.id,
            row.action_id,
            event.eventType,
            event.occurredAt,
            Date.now(),
            Date.now()
          );
        }
        this.sql.exec(
          'UPDATE operator_work SET cursor=COALESCE(?,cursor),status=?,observed_at=?,failure_count=0 WHERE action_id=? AND generation=? AND expires_at=?',
          page.nextCursor,
          page.hasMore ? row.status : task.status,
          Date.now(),
          row.action_id,
          row.generation,
          row.expires_at
        );
      } catch {
        // Access or transport failure is not completion. Reads recheck access and hide stale data.
        this.sql.exec(
          "UPDATE operator_work SET status='watch_failed' WHERE action_id=? AND generation=? AND expires_at=? AND failure_count>=?",
          row.action_id,
          row.generation,
          row.expires_at,
          this.settings.watchRetryLimit
        );
      }
    }
    if (rows.length < this.settings.eventPageSize)
      this.sql.exec("UPDATE operator_work_scan SET cursor='' WHERE singleton=1");
  }

  async markSeen(
    userId: string,
    actionId: string,
    assertEnabled: () => void | Promise<void>
  ): Promise<void> {
    const visible = await this.view(userId);
    if (!visible.some((row) => row.actionId === actionId))
      throw new Error('Work is not accessible');
    await assertEnabled();
    this.sql.exec(
      'UPDATE operator_inbox SET communicated_at=? WHERE action_id=? AND communicated_at IS NULL',
      Date.now(),
      actionId
    );
  }

  /**
   * Runs on every history read, so its D1 reads run in parallel and each project's
   * membership is checked once; one awaited round trip per card made history slow.
   */
  async view(userId: string): Promise<Array<Record<string, unknown>>> {
    const db = drizzle(this.env.DATABASE);
    const access = new Map<string, Promise<unknown>>();
    const cards = await Promise.all(
      this.rows().map(async (row) => {
        try {
          let member = access.get(row.project_id);
          if (!member) {
            member = requireProjectAccess(db, row.project_id, userId);
            access.set(row.project_id, member);
          }
          await member;
          const task = await this.env.DATABASE.prepare(
            'SELECT t.status,t.title AS taskTitle,p.name AS projectName,t.execution_step AS executionStep FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=? AND t.project_id=? AND t.user_id=? AND t.chat_session_id=?'
          )
            .bind(row.task_id, row.project_id, userId, row.session_id)
            .first<{
              status: string;
              taskTitle: string;
              projectName: string;
              executionStep: string | null;
            }>();
          if (!task) return null;
          const inbox = this.sql
            .exec(
              'SELECT COUNT(*) AS unread FROM operator_inbox WHERE action_id=? AND communicated_at IS NULL',
              row.action_id
            )
            .toArray()[0];
          const last = this.sql
            .exec(
              'SELECT event_type,occurred_at FROM operator_inbox WHERE action_id=? ORDER BY occurred_at DESC,event_id DESC LIMIT 1',
              row.action_id
            )
            .toArray()[0];
          return {
            updates: {
              unread: Number(inbox?.unread ?? 0),
              lastEventType: last?.event_type ?? null,
              lastEventAt: last?.occurred_at ?? null,
            },
            actionId: row.action_id,
            projectId: row.project_id,
            taskId: row.task_id,
            sessionId: row.session_id,
            status: task.status,
            taskTitle: task.taskTitle,
            projectName: task.projectName,
            observedAt: Date.now(),
            attention:
              row.status === 'watch_failed' ||
              task.status === 'failed' ||
              task.executionStep === 'awaiting_followup',
            ...(row.status === 'watch_failed'
              ? {
                  error:
                    'Automatic updates stopped after repeated failures. Open project work for current status; a requested follow-up resumes updates.',
                }
              : row.expires_at <= Date.now()
                ? {
                    error: 'Automatic updates expired. Open project work for current status.',
                  }
                : {}),
            link: `https://app.${this.env.BASE_DOMAIN}/projects/${row.project_id}/chat/${row.session_id}`,
          };
        } catch {
          /* Revoked project details are not exposed from stale projections. */
          return null;
        }
      })
    );
    return cards.filter((card) => card !== null);
  }
}
