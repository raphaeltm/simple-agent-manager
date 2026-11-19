/**
 * cc_profile_attachments routes, registered on the `/api/cc` router (which applies auth).
 *
 * A profile pin is one person's private choice: "when I run this agent profile, use
 * this account of mine". It applies only to the caller's own runs, so it needs no
 * project secret permission: the caller must own the account and be able to run the
 * profile — their own global profile, or a project profile in a project where they
 * hold `task:write`. Resolution: `explainResolution` (packages/shared resolver.ts).
 */
import type {
  CCProfileAttachmentItem,
  CCProfilePinCandidatesResponse,
} from '@simple-agent-manager/shared';
import { and, asc, eq, exists, inArray, isNotNull, isNull, or, type SQL, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import { getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { projectMemberRolesWithCapability } from '../middleware/project-auth';
import { CreateCCProfileAttachmentSchema, jsonValidator } from '../schemas';
import { DEFAULT_PROFILE_PIN_CANDIDATE_LIMIT } from '../services/admin-settings-registry';
import { resolveAdminSetting } from '../services/admin-settings-resolution';
import { requireActiveAccount } from './composable-credentials-attachments';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * The one predicate for "the caller may pin an account to this profile", shared by
 * the create route and the candidate list so they cannot disagree.
 */
function pinnableProfileCondition(db: Db, userId: string): SQL {
  const profiles = schema.agentProfiles;
  const members = schema.projectMembers;
  const runnerRoles = projectMemberRolesWithCapability('task:write');
  return or(
    and(isNull(profiles.projectId), eq(profiles.userId, userId)),
    and(
      isNotNull(profiles.projectId),
      exists(
        db
          .select({ one: sql`1` })
          .from(members)
          .where(
            and(
              eq(members.projectId, profiles.projectId),
              eq(members.userId, userId),
              eq(members.status, 'active'),
              inArray(members.role, runnerRoles)
            )
          )
      )
    )
  ) as SQL;
}

async function candidateLimit(env: Env): Promise<number> {
  const value = await resolveAdminSetting(env, 'chat.profilePinCandidateLimit');
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_PROFILE_PIN_CANDIDATE_LIMIT;
}

function toItem(row: {
  pin: schema.CCProfileAttachmentRow;
  profileName: string;
  projectId: string | null;
  projectName: string | null;
}): CCProfileAttachmentItem {
  return {
    id: row.pin.id,
    configurationId: row.pin.configurationId,
    agentProfileId: row.pin.agentProfileId,
    profileName: row.profileName,
    projectId: row.projectId,
    projectName: row.projectName,
    consumerKind: row.pin.consumerKind,
    consumerTarget: row.pin.consumerTarget,
    isActive: row.pin.isActive,
    createdAt: row.pin.createdAt,
    updatedAt: row.pin.updatedAt,
  };
}

export function registerCCProfileAttachmentRoutes(ccRoutes: Hono<{ Bindings: Env }>): void {
  /** GET /api/cc/profile-attachments — the caller's own profile pins */
  ccRoutes.get('/profile-attachments', async (c) => {
    const db = drizzle(c.env.DATABASE, { schema });
    const userId = getUserId(c);
    const rows = await db
      .select({
        pin: schema.ccProfileAttachments,
        profileName: schema.agentProfiles.name,
        projectId: schema.agentProfiles.projectId,
        projectName: schema.projects.name,
      })
      .from(schema.ccProfileAttachments)
      .innerJoin(
        schema.agentProfiles,
        eq(schema.agentProfiles.id, schema.ccProfileAttachments.agentProfileId)
      )
      .leftJoin(schema.projects, eq(schema.projects.id, schema.agentProfiles.projectId))
      .where(eq(schema.ccProfileAttachments.userId, userId));
    return c.json({ attachments: rows.map(toItem) });
  });

  /**
   * GET /api/cc/profile-attachments/profiles?agentType= — profiles the caller may pin
   * an account to, grouped by project (global profiles first). Capped by the admin
   * setting `chat.profilePinCandidateLimit`; `truncated` discloses the cut (rule 65).
   */
  ccRoutes.get('/profile-attachments/profiles', async (c) => {
    const db = drizzle(c.env.DATABASE, { schema });
    const userId = getUserId(c);
    const agentType = c.req.query('agentType')?.trim() || null;
    const limit = await candidateLimit(c.env);
    const profiles = schema.agentProfiles;

    const rows = await db
      .select({
        id: profiles.id,
        name: profiles.name,
        agentType: profiles.agentType,
        projectId: profiles.projectId,
        projectName: schema.projects.name,
      })
      .from(profiles)
      .leftJoin(schema.projects, eq(schema.projects.id, profiles.projectId))
      .where(
        and(
          pinnableProfileCondition(db, userId),
          agentType ? eq(profiles.agentType, agentType) : undefined
        )
      )
      .orderBy(
        sql`${profiles.projectId} IS NOT NULL`,
        asc(schema.projects.name),
        asc(profiles.name),
        asc(profiles.id)
      )
      .limit(limit + 1);

    const response: CCProfilePinCandidatesResponse = {
      profiles: rows.slice(0, limit),
      truncated: rows.length > limit,
      limit,
    };
    return c.json(response);
  });

  /**
   * POST /api/cc/profile-attachments — run one of the caller's agent accounts for a
   * profile. Replaces the caller's previous pin for that profile and agent in one D1
   * batch (one transaction), so a profile never holds two pins for one agent.
   */
  ccRoutes.post(
    '/profile-attachments',
    jsonValidator(CreateCCProfileAttachmentSchema),
    async (c) => {
      const db = drizzle(c.env.DATABASE, { schema });
      const userId = getUserId(c);
      const { configurationId, profileId } = c.req.valid('json');

      const [cfg] = await db
        .select()
        .from(schema.ccConfigurations)
        .where(
          and(
            eq(schema.ccConfigurations.id, configurationId),
            eq(schema.ccConfigurations.ownerId, userId)
          )
        )
        .limit(1);
      if (!cfg) throw errors.badRequest('Configuration not found or not owned by user');
      if (cfg.consumerKind !== 'agent') throw errors.badRequest('Only agent accounts run profiles');

      // Missing and foreign profiles share one not-found answer.
      const [profile] = await db
        .select({ id: schema.agentProfiles.id, agentType: schema.agentProfiles.agentType })
        .from(schema.agentProfiles)
        .where(and(eq(schema.agentProfiles.id, profileId), pinnableProfileCondition(db, userId)))
        .limit(1);
      if (!profile) throw errors.notFound('Agent profile');
      if (cfg.consumerTarget !== profile.agentType) {
        throw errors.badRequest(
          `This account is for ${cfg.consumerTarget}, but the profile runs ${profile.agentType}`
        );
      }
      // A paused pin would halt the profile's runs (no fallback).
      await requireActiveAccount(db, userId, cfg);

      const id = `cc-pin-${ulid()}`;
      const pins = schema.ccProfileAttachments;
      await db.batch([
        db
          .delete(pins)
          .where(
            and(
              eq(pins.userId, userId),
              eq(pins.agentProfileId, profile.id),
              eq(pins.consumerKind, cfg.consumerKind),
              eq(pins.consumerTarget, cfg.consumerTarget)
            )
          ),
        db.insert(pins).values({
          id,
          configurationId,
          userId,
          agentProfileId: profile.id,
          consumerKind: cfg.consumerKind,
          consumerTarget: cfg.consumerTarget,
          isActive: true,
        }),
      ]);
      return c.json({ id, configurationId, agentProfileId: profile.id }, 201);
    }
  );

  /** DELETE /api/cc/profile-attachments/:id — the profile goes back to your usual account */
  ccRoutes.delete('/profile-attachments/:id', async (c) => {
    const db = drizzle(c.env.DATABASE, { schema });
    const userId = getUserId(c);
    const { id } = c.req.param();
    const pins = schema.ccProfileAttachments;
    const result = await db
      .delete(pins)
      .where(and(eq(pins.id, id), eq(pins.userId, userId)))
      .returning({ id: pins.id });
    if (result.length === 0) throw errors.notFound('Profile account');
    return c.json({ success: true });
  });
}
