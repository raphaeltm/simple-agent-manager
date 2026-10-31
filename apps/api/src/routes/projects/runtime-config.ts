import { and, count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { type Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { getCredentialEncryptionKey } from '../../lib/secrets';
import { ulid } from '../../lib/ulid';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireProjectCapability } from '../../middleware/project-auth';
import {
  jsonValidator,
  UpsertProjectRuntimeEnvVarSchema,
  UpsertProjectRuntimeFileSchema,
} from '../../schemas';
import { encrypt } from '../../services/encryption';
import { getRuntimeLimits } from '../../services/limits';
import {
  buildProjectRuntimeConfigResponse,
  byteLength,
  normalizeProjectFilePath,
  PROJECT_ENV_KEY_PATTERN,
} from './_helpers';

export function registerProjectRuntimeConfigRoutes(crudRoutes: Hono<{ Bindings: Env }>) {
  crudRoutes.get('/:id/runtime-config', async (c) => {
    const userId = getUserId(c);
    const projectId = c.req.param('id');
    const db = drizzle(c.env.DATABASE, { schema });

    const project = await requireProjectCapability(db, projectId, userId, 'secret:read');
    const response = await buildProjectRuntimeConfigResponse(db, project);
    return c.json(response);
  });

  crudRoutes.post(
    '/:id/runtime/env-vars',
    jsonValidator(UpsertProjectRuntimeEnvVarSchema),
    async (c) => {
      const userId = getUserId(c);
      const projectId = c.req.param('id');
      const db = drizzle(c.env.DATABASE, { schema });
      const body = c.req.valid('json');
      const limits = getRuntimeLimits(c.env);

      const project = await requireProjectCapability(db, projectId, userId, 'secret:write');
      const envKey = body.key?.trim();
      if (!envKey || !PROJECT_ENV_KEY_PATTERN.test(envKey)) {
        throw errors.badRequest('key must match [A-Za-z_][A-Za-z0-9_]*');
      }

      if (typeof body.value !== 'string') {
        throw errors.badRequest('value is required');
      }
      if (byteLength(body.value) > limits.maxProjectRuntimeEnvValueBytes) {
        throw errors.badRequest(
          `value exceeds max size of ${limits.maxProjectRuntimeEnvValueBytes} bytes`
        );
      }

      const isSecret = Boolean(body.isSecret);
      const [existingRows, countRows] = await Promise.all([
        db
          .select({ id: schema.projectRuntimeEnvVars.id })
          .from(schema.projectRuntimeEnvVars)
          .where(
            and(
              eq(schema.projectRuntimeEnvVars.projectId, project.id),
              eq(schema.projectRuntimeEnvVars.envKey, envKey)
            )
          )
          .limit(1),
        db
          .select({ count: count() })
          .from(schema.projectRuntimeEnvVars)
          .where(and(eq(schema.projectRuntimeEnvVars.projectId, project.id))),
      ]);

      if (!existingRows[0]) {
        if ((countRows[0]?.count ?? 0) >= limits.maxProjectRuntimeEnvVarsPerProject) {
          throw errors.badRequest(
            `Maximum ${limits.maxProjectRuntimeEnvVarsPerProject} runtime env vars allowed per project`
          );
        }
      }

      const stored = isSecret
        ? await encrypt(body.value, getCredentialEncryptionKey(c.env))
        : { ciphertext: body.value, iv: null };

      const now = new Date().toISOString();
      if (existingRows[0]) {
        await db
          .update(schema.projectRuntimeEnvVars)
          .set({
            storedValue: stored.ciphertext,
            valueIv: stored.iv,
            isSecret,
            updatedAt: now,
          })
          .where(eq(schema.projectRuntimeEnvVars.id, existingRows[0].id));
      } else {
        await db.insert(schema.projectRuntimeEnvVars).values({
          id: ulid(),
          projectId: project.id,
          userId,
          envKey,
          storedValue: stored.ciphertext,
          valueIv: stored.iv,
          isSecret,
          createdAt: now,
          updatedAt: now,
        });
      }

      const response = await buildProjectRuntimeConfigResponse(db, project);
      return c.json(response);
    }
  );

  crudRoutes.delete('/:id/runtime/env-vars/:envKey', async (c) => {
    const userId = getUserId(c);
    const projectId = c.req.param('id');
    const envKey = c.req.param('envKey')?.trim();
    const db = drizzle(c.env.DATABASE, { schema });

    if (!envKey || !PROJECT_ENV_KEY_PATTERN.test(envKey)) {
      throw errors.badRequest('envKey must match [A-Za-z_][A-Za-z0-9_]*');
    }

    const project = await requireProjectCapability(db, projectId, userId, 'secret:write');

    await db
      .delete(schema.projectRuntimeEnvVars)
      .where(
        and(
          eq(schema.projectRuntimeEnvVars.projectId, project.id),
          eq(schema.projectRuntimeEnvVars.envKey, envKey)
        )
      );

    const response = await buildProjectRuntimeConfigResponse(db, project);
    return c.json(response);
  });

  crudRoutes.post(
    '/:id/runtime/files',
    jsonValidator(UpsertProjectRuntimeFileSchema),
    async (c) => {
      const userId = getUserId(c);
      const projectId = c.req.param('id');
      const db = drizzle(c.env.DATABASE, { schema });
      const body = c.req.valid('json');
      const limits = getRuntimeLimits(c.env);
      const project = await requireProjectCapability(db, projectId, userId, 'secret:write');

      const path = normalizeProjectFilePath(body.path ?? '');
      if (path.length > limits.maxProjectRuntimeFilePathLength) {
        throw errors.badRequest(
          `path exceeds max length of ${limits.maxProjectRuntimeFilePathLength} characters`
        );
      }

      if (typeof body.content !== 'string') {
        throw errors.badRequest('content is required');
      }
      if (byteLength(body.content) > limits.maxProjectRuntimeFileContentBytes) {
        throw errors.badRequest(
          `content exceeds max size of ${limits.maxProjectRuntimeFileContentBytes} bytes`
        );
      }

      const isSecret = Boolean(body.isSecret);
      const [existingRows, countRows] = await Promise.all([
        db
          .select({ id: schema.projectRuntimeFiles.id })
          .from(schema.projectRuntimeFiles)
          .where(
            and(
              eq(schema.projectRuntimeFiles.projectId, project.id),
              eq(schema.projectRuntimeFiles.filePath, path)
            )
          )
          .limit(1),
        db
          .select({ count: count() })
          .from(schema.projectRuntimeFiles)
          .where(and(eq(schema.projectRuntimeFiles.projectId, project.id))),
      ]);

      if (!existingRows[0]) {
        if ((countRows[0]?.count ?? 0) >= limits.maxProjectRuntimeFilesPerProject) {
          throw errors.badRequest(
            `Maximum ${limits.maxProjectRuntimeFilesPerProject} runtime files allowed per project`
          );
        }
      }

      const stored = isSecret
        ? await encrypt(body.content, getCredentialEncryptionKey(c.env))
        : { ciphertext: body.content, iv: null };
      const now = new Date().toISOString();

      if (existingRows[0]) {
        await db
          .update(schema.projectRuntimeFiles)
          .set({
            storedContent: stored.ciphertext,
            contentIv: stored.iv,
            isSecret,
            updatedAt: now,
          })
          .where(eq(schema.projectRuntimeFiles.id, existingRows[0].id));
      } else {
        await db.insert(schema.projectRuntimeFiles).values({
          id: ulid(),
          projectId: project.id,
          userId,
          filePath: path,
          storedContent: stored.ciphertext,
          contentIv: stored.iv,
          isSecret,
          createdAt: now,
          updatedAt: now,
        });
      }

      const response = await buildProjectRuntimeConfigResponse(db, project);
      return c.json(response);
    }
  );

  crudRoutes.delete('/:id/runtime/files', async (c) => {
    const userId = getUserId(c);
    const projectId = c.req.param('id');
    const rawPath = c.req.query('path');
    const db = drizzle(c.env.DATABASE, { schema });
    const project = await requireProjectCapability(db, projectId, userId, 'secret:write');

    if (!rawPath) {
      throw errors.badRequest('path query parameter is required');
    }
    const path = normalizeProjectFilePath(rawPath);

    await db
      .delete(schema.projectRuntimeFiles)
      .where(
        and(
          eq(schema.projectRuntimeFiles.projectId, project.id),
          eq(schema.projectRuntimeFiles.filePath, path)
        )
      );

    const response = await buildProjectRuntimeConfigResponse(db, project);
    return c.json(response);
  });
}
