/**
 * The worker side of what an agent files in the inbox (slice D, idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9):
 * telling the person, showing a blocking question in the chat, withdrawing one the agent
 * cancelled, and checking that each link names a thing of the project. The rules about what may
 * be filed live in `packages/operations/src/inbox-agent-core.ts`; this file only reaches the
 * stores and services the operations layer cannot.
 */
import type { InboxAskAnnouncement } from '@simple-agent-manager/operations';
import type { HumanInputCategory, InboxLink } from '@simple-agent-manager/shared';
import { HUMAN_INPUT_CATEGORIES } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import * as notificationService from '../notification';
import * as projectDataService from '../project-data';
import { linkQuestionNotification } from './question-asks';

/**
 * A blocking question pauses its chat live (`recordQuestionAsked`) and pushes to the person, as
 * `request_human_input` always did; reminders resend that push (`linkQuestionNotification`).
 * Other items notify once, so the person's inbox shows them. Never throws.
 */
export async function announceAgentAsk(
  env: Env,
  input: InboxAskAnnouncement
): Promise<{ notificationScheduled: boolean }> {
  if (input.kind === 'question' && input.blocking) {
    try {
      await projectDataService.recordQuestionAsked(env, input.projectId, {
        sessionId: input.sessionId,
        askId: input.askId,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        reason: input.body,
        options: input.options,
      });
    } catch (error) {
      // The ask is filed; the chat list shows it on its next read.
      log.warn('inbox.agent_ask.live_update_failed', {
        askId: input.askId,
        projectId: input.projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (!env.NOTIFICATION) return { notificationScheduled: false };
  try {
    const [projectName, task] = await Promise.all([
      notificationService.getProjectName(env, input.projectId),
      env.DATABASE.prepare('SELECT title FROM tasks WHERE id = ? AND project_id = ?')
        .bind(input.taskId, input.projectId)
        .first<{ title: string }>(),
    ]);
    const category = (HUMAN_INPUT_CATEGORIES as readonly string[]).includes(input.category ?? '')
      ? (input.category as HumanInputCategory)
      : null;
    const notification = await notificationService.notifyNeedsInput(env, input.userId, {
      projectId: input.projectId,
      projectName,
      taskId: input.taskId,
      // A result's push leads with its outcome, not the task's name.
      taskTitle: input.kind === 'result' ? input.title : (task?.title ?? input.title),
      context: input.body,
      category,
      options: input.options.length > 0 ? input.options : null,
      sessionId: input.sessionId,
      attentionMarkerId: input.askId,
      label: input.kind === 'review' ? 'Review' : undefined,
      heading: input.kind === 'result' ? 'Result ready' : undefined,
    });
    const scheduled = notification.id !== 'suppressed';
    if (scheduled && input.kind === 'question') {
      await linkQuestionNotification(env, input.projectId, input.askId, notification.id);
    }
    return { notificationScheduled: scheduled };
  } catch (error) {
    log.warn('inbox.agent_ask.notification_failed', {
      askId: input.askId,
      projectId: input.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { notificationScheduled: false };
  }
}

/** The agent cancelled its blocking question: the chat stops showing it. Never throws. */
export async function withdrawAgentQuestion(
  env: Env,
  input: { projectId: string; sessionId: string; askId: string }
): Promise<void> {
  try {
    await projectDataService.recordQuestionWithdrawn(env, input.projectId, {
      sessionId: input.sessionId,
      askId: input.askId,
    });
  } catch (error) {
    // The row is closed and the chat list reads it as closed; SAM's check-in hold stays until the
    // question's original deadline, when the candidate is evaluated again and finds no question.
    log.warn('inbox.agent_ask.withdraw_live_update_failed', {
      askId: input.askId,
      projectId: input.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const NOT_IN_PROJECT = 'not found in this project';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `ws-<workspaceId>` or `ws-<workspaceId>--<port>` directly under the base domain. */
function previewWorkspaceId(url: URL, baseDomain: string): string | null {
  const host = url.hostname.toLowerCase();
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (!baseDomain || !host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  const match = /^ws-([a-z0-9]+)(?:--\d{1,5})?$/.exec(label);
  return match?.[1] ?? null;
}

async function checkOne(env: Env, projectId: string, link: InboxLink): Promise<string | null> {
  const db = env.DATABASE;
  const exists = async (sql: string, ...params: unknown[]) =>
    Boolean(
      await db
        .prepare(sql)
        .bind(...params)
        .first()
    );
  switch (link.kind) {
    case 'idea':
      return (await exists(
        'SELECT 1 FROM tasks WHERE id = ? AND project_id = ? AND is_idea = 1',
        link.id,
        projectId
      ))
        ? null
        : NOT_IN_PROJECT;
    case 'file':
      return (await exists(
        `SELECT 1 FROM project_files WHERE id = ? AND project_id = ?`,
        link.id,
        projectId
      ))
        ? null
        : NOT_IN_PROJECT;
    case 'chat':
      return (await projectDataService.getSession(env, projectId, link.id)) ? null : NOT_IN_PROJECT;
    case 'policy':
      return (await projectDataService.getPolicy(env, projectId, link.id)) ? null : NOT_IN_PROJECT;
    case 'knowledge':
      return (await projectDataService.getKnowledgeEntity(env, projectId, link.id))
        ? null
        : NOT_IN_PROJECT;
    case 'pr': {
      // Pinned to the project's own repository host and a numbered pull or merge request path,
      // so a chip labelled "PR" cannot point anywhere else.
      const url = new URL(link.id);
      if (url.username || url.password || url.port)
        return 'a pull request URL has no credentials or port';
      const project = await db
        .prepare(
          `SELECT p.repository, p.repo_provider, g.host AS gitlab_host, g.path_with_namespace
             FROM projects p LEFT JOIN project_gitlab_repositories g ON g.project_id = p.id
            WHERE p.id = ?`
        )
        .bind(projectId)
        .first<{
          repository: string | null;
          repo_provider: string | null;
          gitlab_host: string | null;
          path_with_namespace: string | null;
        }>();
      const host = url.hostname.toLowerCase();
      const path = url.pathname.toLowerCase().replace(/\/+$/, '');
      if (project?.repo_provider === 'gitlab') {
        const repo = (project.path_with_namespace ?? project.repository ?? '').trim().toLowerCase();
        const gitlabHost = (project.gitlab_host ?? '').trim().toLowerCase();
        return repo &&
          gitlabHost &&
          host === gitlabHost &&
          new RegExp(`^/${escapeRegExp(repo)}/-/merge_requests/\\d+$`).test(path)
          ? null
          : "not a merge request of this project's repository";
      }
      const repo = project?.repository?.trim().toLowerCase();
      return project?.repo_provider !== 'artifacts' &&
        repo &&
        host === 'github.com' &&
        new RegExp(`^/${escapeRegExp(repo)}/pull/\\d+$`).test(path)
        ? null
        : "not a pull request of this project's repository";
    }
    case 'preview': {
      const workspaceId = previewWorkspaceId(new URL(link.id), env.BASE_DOMAIN ?? '');
      if (!workspaceId) return "not a preview URL of this project's workspaces";
      // Host names are lower case; workspace ids are upper-case ULIDs. Both forms keep the
      // primary-key lookup.
      return (await exists(
        'SELECT 1 FROM workspaces WHERE project_id = ? AND id IN (?, ?)',
        projectId,
        workspaceId,
        workspaceId.toUpperCase()
      ))
        ? null
        : NOT_IN_PROJECT;
    }
    default:
      return 'unsupported link kind';
  }
}

/**
 * Whether each link names a thing of this project, in order: null when it does, else why not.
 * A check that fails to run refuses the link (fail closed): the agent can retry or drop it.
 * Cost: one D1 read or one ProjectData call per link, bounded by `inbox.linksMax`.
 */
export async function checkAgentLinkTargets(
  env: Env,
  projectId: string,
  links: readonly InboxLink[]
): Promise<Array<string | null>> {
  return Promise.all(
    links.map(async (link) => {
      try {
        return await checkOne(env, projectId, link);
      } catch (error) {
        log.warn('inbox.agent_ask.link_check_failed', {
          projectId,
          kind: link.kind,
          error: error instanceof Error ? error.message : String(error),
        });
        return 'could not be checked; retry, or leave this link out';
      }
    })
  );
}
