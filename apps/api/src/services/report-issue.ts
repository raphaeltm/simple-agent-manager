import {
  DEFAULT_REPORT_ISSUE_CONTENT_MAX_LENGTH,
  DEFAULT_REPORT_ISSUE_DESCRIPTION_MAX_LENGTH,
  DEFAULT_REPORT_ISSUE_TITLE_MAX_LENGTH,
  type ReportIssueRefs,
  type ReportIssueResponse,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import { sanitizeUserInput } from '../routes/mcp/_helpers';
import {
  configuredFeedbackProjectId,
  upsertUserReportIncident,
} from './platform-feedback-incidents';
import { redactSecretPatterns } from './secret-redaction';

type FeedbackProject = { id: string; userId: string };

const SAFE_TECHNICAL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export async function getConfiguredFeedbackProject(env: Env): Promise<FeedbackProject | undefined> {
  const feedbackProjectId = await configuredFeedbackProjectId(env);
  if (!feedbackProjectId) return undefined;

  const db = drizzle(env.DATABASE, { schema });
  const project = await db
    .select({ id: schema.projects.id, userId: schema.projects.userId })
    .from(schema.projects)
    .where(eq(schema.projects.id, feedbackProjectId))
    .get();

  return project;
}

export async function isReportEnabled(env: Env): Promise<boolean> {
  return Boolean(await getConfiguredFeedbackProject(env));
}

function logMissingFeedbackProject(projectId: string): void {
  log.error('report_issue.feedback_project_missing', {
    configuredProjectIdLength: projectId.length,
  });
}

function parsePositiveInt(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Validate that the reporting user has access to every referenced resource.
 * Returns the subset of refs the user is authorized to attach.
 * Refs the user cannot access are silently dropped (not errors — they just
 * don't get attached, and the response lists what was actually attached).
 */
async function validateRefs(
  db: ReturnType<typeof drizzle>,
  userId: string,
  refs: ReportIssueRefs
): Promise<{ authorized: ReportIssueRefs; authorizedKeys: string[] }> {
  const authorized: ReportIssueRefs = {};
  const authorizedKeys: string[] = [];

  const addAuthorizedRef = (key: keyof ReportIssueRefs, value: string): void => {
    if (!SAFE_TECHNICAL_REF_PATTERN.test(value)) return;
    authorized[key] = value;
    authorizedKeys.push(key);
  };

  if (refs.taskId) {
    const task = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .innerJoin(schema.projects, eq(schema.tasks.projectId, schema.projects.id))
      .innerJoin(
        schema.projectMembers,
        and(
          eq(schema.projectMembers.projectId, schema.projects.id),
          eq(schema.projectMembers.userId, userId),
          eq(schema.projectMembers.status, 'active')
        )
      )
      .where(eq(schema.tasks.id, refs.taskId))
      .get();
    if (task) {
      addAuthorizedRef('taskId', refs.taskId);
    }
  }

  if (refs.sessionId) {
    const ws = await db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.chatSessionId, refs.sessionId),
          eq(schema.workspaces.userId, userId)
        )
      )
      .get();
    if (ws) {
      addAuthorizedRef('sessionId', refs.sessionId);
    }
  }

  if (refs.nodeId) {
    const node = await db
      .select({ id: schema.nodes.id })
      .from(schema.nodes)
      .where(and(eq(schema.nodes.id, refs.nodeId), eq(schema.nodes.userId, userId)))
      .get();
    if (node) {
      addAuthorizedRef('nodeId', refs.nodeId);
    }
  }

  if (refs.errorId) {
    addAuthorizedRef('errorId', refs.errorId);
  }

  if (refs.diagnosisId) {
    const diagnosis = await db
      .select({ id: schema.debugDiagnoses.id })
      .from(schema.debugDiagnoses)
      .where(
        and(
          eq(schema.debugDiagnoses.id, refs.diagnosisId),
          eq(schema.debugDiagnoses.createdBy, userId)
        )
      )
      .get();
    if (diagnosis) {
      addAuthorizedRef('diagnosisId', refs.diagnosisId);
    }
  }

  return { authorized, authorizedKeys };
}

const REPORT_SECRET_PATTERNS = [
  /["']?(?:api[_-]?key|token|secret|password|credential|auth|authorization)["']?\s*[:=]\s*["'][^"'\s,}\]]+["']/gi,
  /(?:api[_-]?key|token|secret|password|credential|auth)\s*[:=]\s*\S+/gi,
  /(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|glpat|xoxb|xoxp|xoxa|xapp)-[a-zA-Z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
] as const;

function redactSecrets(text: string): string {
  const redacted = REPORT_SECRET_PATTERNS.reduce(
    (result, pattern) => result.replace(pattern, '[REDACTED]'),
    text
  );
  return redactSecretPatterns(redacted);
}

export async function submitReport(
  env: Env,
  userId: string,
  title: string,
  description: string,
  consentToAttachRefs: boolean,
  refs?: ReportIssueRefs
): Promise<ReportIssueResponse> {
  const feedbackProjectId = await configuredFeedbackProjectId(env);
  if (!feedbackProjectId) {
    throw errors.notFound('Report issue feature is not configured');
  }

  const db = drizzle(env.DATABASE, { schema });
  const project = await getConfiguredFeedbackProject(env);
  if (!project) {
    logMissingFeedbackProject(feedbackProjectId);
    throw errors.internal('Report issue feature is temporarily unavailable');
  }

  const titleMaxLen = parsePositiveInt(
    env.REPORT_ISSUE_TITLE_MAX_LENGTH,
    DEFAULT_REPORT_ISSUE_TITLE_MAX_LENGTH
  );
  const descMaxLen = parsePositiveInt(
    env.REPORT_ISSUE_DESCRIPTION_MAX_LENGTH,
    DEFAULT_REPORT_ISSUE_DESCRIPTION_MAX_LENGTH
  );

  const sanitizedTitle = redactSecrets(sanitizeUserInput(title.trim())).slice(0, titleMaxLen);
  const sanitizedDesc = redactSecrets(sanitizeUserInput(description.trim())).slice(0, descMaxLen);

  let authorized: ReportIssueRefs = {};
  let authorizedKeys: string[] = [];

  if (consentToAttachRefs && refs) {
    const result = await validateRefs(db, userId, refs);
    authorized = result.authorized;
    authorizedKeys = result.authorizedKeys;
  }

  const contentMaxLen = parsePositiveInt(
    env.REPORT_ISSUE_CONTENT_MAX_LENGTH,
    DEFAULT_REPORT_ISSUE_CONTENT_MAX_LENGTH
  );

  const incident = await upsertUserReportIncident(env, {
    userId,
    feedbackProjectId,
    feedbackProjectOwnerId: project.userId,
    title: sanitizedTitle,
    description: sanitizedDesc,
    authorizedRefs: { ...authorized },
    authorizedKeys,
    contentMaxLength: contentMaxLen,
  });

  return {
    ideaId: incident.ideaId,
    status: 'draft',
    refsAttached: authorizedKeys.length > 0,
    attachedRefKeys: authorizedKeys,
    message:
      authorizedKeys.length > 0
        ? `Report submitted with ${authorizedKeys.length} technical reference(s) attached.`
        : 'Report submitted without technical references.',
  };
}
