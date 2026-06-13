/**
 * CRUD routes for composable credentials (cc_credentials, cc_configurations, cc_attachments).
 *
 * All routes require authentication. Users can only manage their own resources.
 */

import { and,eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { ulid } from '../lib/ulid';
import { requireApproved, requireAuth } from '../middleware/auth';
import { getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { encrypt } from '../services/encryption';

const ccRoutes = new Hono<{ Bindings: Env }>();

ccRoutes.use('/*', requireAuth(), requireApproved());

// =============================================================================
// Credentials
// =============================================================================

/** GET /api/cc/credentials — list user's credentials (secrets omitted) */
ccRoutes.get('/credentials', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const userId = getUserId(c);

  const rows = await db
    .select({
      id: schema.ccCredentials.id,
      name: schema.ccCredentials.name,
      kind: schema.ccCredentials.kind,
      isActive: schema.ccCredentials.isActive,
      createdAt: schema.ccCredentials.createdAt,
      updatedAt: schema.ccCredentials.updatedAt,
    })
    .from(schema.ccCredentials)
    .where(eq(schema.ccCredentials.ownerId, userId));

  return c.json({ credentials: rows });
});

/** POST /api/cc/credentials — create a credential */
ccRoutes.post('/credentials', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const userId = getUserId(c);
  const body = await c.req.json();

  const { name, kind, secret } = body;
  if (!name || !kind || !secret) {
    throw errors.badRequest('name, kind, and secret are required');
  }

  const encryptionKey = getCredentialEncryptionKey(c.env);
  const tokenToEncrypt = typeof secret === 'string' ? secret : JSON.stringify(secret);
  const { ciphertext, iv } = await encrypt(tokenToEncrypt, encryptionKey);

  const id = `cc-cred-${ulid()}`;
  await db.insert(schema.ccCredentials).values({
    id,
    ownerId: userId,
    name,
    kind,
    encryptedToken: ciphertext,
    iv,
    isActive: true,
  });

  return c.json({ id, name, kind }, 201);
});

/** PATCH /api/cc/credentials/:id — update a credential (name, isActive) */
ccRoutes.patch('/credentials/:id', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const userId = getUserId(c);
  const { id } = c.req.param();
  const body = await c.req.json();

  const updates: Record<string, unknown> = {};
  if (typeof body.name === 'string') updates.name = body.name;
  if (typeof body.isActive === 'boolean') updates.isActive = body.isActive;

  if (Object.keys(updates).length === 0) {
    throw errors.badRequest('No valid fields to update');
  }

  const result = await db
    .update(schema.ccCredentials)
    .set(updates)
    .where(and(eq(schema.ccCredentials.id, id), eq(schema.ccCredentials.ownerId, userId)))
    .returning({ id: schema.ccCredentials.id });

  if (result.length === 0) throw errors.notFound('Credential');
  return c.json({ success: true });
});

/** DELETE /api/cc/credentials/:id */
ccRoutes.delete('/credentials/:id', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const userId = getUserId(c);
  const { id } = c.req.param();

  const result = await db
    .delete(schema.ccCredentials)
    .where(and(eq(schema.ccCredentials.id, id), eq(schema.ccCredentials.ownerId, userId)))
    .returning({ id: schema.ccCredentials.id });

  if (result.length === 0) throw errors.notFound('Credential');
  return c.json({ success: true });
});

// =============================================================================
// Configurations
// =============================================================================

/** GET /api/cc/configurations — list user's configurations */
ccRoutes.get('/configurations', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const userId = getUserId(c);

  const rows = await db
    .select()
    .from(schema.ccConfigurations)
    .where(eq(schema.ccConfigurations.ownerId, userId));

  const configurations = rows.map((row) => ({
    id: row.id,
    name: row.name,
    consumerKind: row.consumerKind,
    consumerTarget: row.consumerTarget,
    credentialId: row.credentialId,
    settingsJson: row.settingsJson,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));

  return c.json({ configurations });
});

/** POST /api/cc/configurations — create a configuration */
ccRoutes.post('/configurations', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const userId = getUserId(c);
  const body = await c.req.json();

  const { name, consumerKind, consumerTarget, credentialId, settings } = body;
  if (!name || !consumerKind || !consumerTarget) {
    throw errors.badRequest('name, consumerKind, and consumerTarget are required');
  }

  // Verify credential belongs to user if provided
  if (credentialId) {
    const [cred] = await db
      .select({ id: schema.ccCredentials.id })
      .from(schema.ccCredentials)
      .where(and(eq(schema.ccCredentials.id, credentialId), eq(schema.ccCredentials.ownerId, userId)))
      .limit(1);
    if (!cred) throw errors.badRequest('Credential not found or not owned by user');
  }

  const id = `cc-cfg-${ulid()}`;
  await db.insert(schema.ccConfigurations).values({
    id,
    ownerId: userId,
    name,
    consumerKind,
    consumerTarget,
    credentialId: credentialId ?? null,
    settingsJson: settings ? JSON.stringify(settings) : null,
    isActive: true,
  });

  return c.json({ id, name, consumerKind, consumerTarget }, 201);
});

/** PATCH /api/cc/configurations/:id — update a configuration */
ccRoutes.patch('/configurations/:id', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const userId = getUserId(c);
  const { id } = c.req.param();
  const body = await c.req.json();

  const updates: Record<string, unknown> = {};
  if (typeof body.name === 'string') updates.name = body.name;
  if (typeof body.credentialId === 'string' || body.credentialId === null) updates.credentialId = body.credentialId;
  if (body.settings !== undefined) updates.settingsJson = body.settings ? JSON.stringify(body.settings) : null;
  if (typeof body.isActive === 'boolean') updates.isActive = body.isActive;

  if (Object.keys(updates).length === 0) {
    throw errors.badRequest('No valid fields to update');
  }

  const result = await db
    .update(schema.ccConfigurations)
    .set(updates)
    .where(and(eq(schema.ccConfigurations.id, id), eq(schema.ccConfigurations.ownerId, userId)))
    .returning({ id: schema.ccConfigurations.id });

  if (result.length === 0) throw errors.notFound('Configuration');
  return c.json({ success: true });
});

/** DELETE /api/cc/configurations/:id */
ccRoutes.delete('/configurations/:id', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const userId = getUserId(c);
  const { id } = c.req.param();

  const result = await db
    .delete(schema.ccConfigurations)
    .where(and(eq(schema.ccConfigurations.id, id), eq(schema.ccConfigurations.ownerId, userId)))
    .returning({ id: schema.ccConfigurations.id });

  if (result.length === 0) throw errors.notFound('Configuration');
  return c.json({ success: true });
});

// =============================================================================
// Attachments
// =============================================================================

/** GET /api/cc/attachments — list user's attachments */
ccRoutes.get('/attachments', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const userId = getUserId(c);

  const rows = await db
    .select()
    .from(schema.ccAttachments)
    .where(eq(schema.ccAttachments.userId, userId));

  const attachments = rows.map((row) => ({
    id: row.id,
    configurationId: row.configurationId,
    consumerKind: row.consumerKind,
    consumerTarget: row.consumerTarget,
    projectId: row.projectId,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));

  return c.json({ attachments });
});

/** POST /api/cc/attachments — create an attachment */
ccRoutes.post('/attachments', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const userId = getUserId(c);
  const body = await c.req.json();

  const { configurationId, projectId } = body;
  if (!configurationId) {
    throw errors.badRequest('configurationId is required');
  }

  // Verify configuration belongs to user
  const [cfg] = await db
    .select()
    .from(schema.ccConfigurations)
    .where(and(eq(schema.ccConfigurations.id, configurationId), eq(schema.ccConfigurations.ownerId, userId)))
    .limit(1);
  if (!cfg) throw errors.badRequest('Configuration not found or not owned by user');

  const id = `cc-att-${ulid()}`;
  await db.insert(schema.ccAttachments).values({
    id,
    configurationId,
    consumerKind: cfg.consumerKind,
    consumerTarget: cfg.consumerTarget,
    userId,
    projectId: projectId ?? null,
    isActive: true,
  });

  return c.json({ id, configurationId, projectId: projectId ?? null }, 201);
});

/** PATCH /api/cc/attachments/:id — update an attachment (isActive) */
ccRoutes.patch('/attachments/:id', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const userId = getUserId(c);
  const { id } = c.req.param();
  const body = await c.req.json();

  const updates: Record<string, unknown> = {};
  if (typeof body.isActive === 'boolean') updates.isActive = body.isActive;

  if (Object.keys(updates).length === 0) {
    throw errors.badRequest('No valid fields to update');
  }

  const result = await db
    .update(schema.ccAttachments)
    .set(updates)
    .where(and(eq(schema.ccAttachments.id, id), eq(schema.ccAttachments.userId, userId)))
    .returning({ id: schema.ccAttachments.id });

  if (result.length === 0) throw errors.notFound('Attachment');
  return c.json({ success: true });
});

/** DELETE /api/cc/attachments/:id */
ccRoutes.delete('/attachments/:id', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const userId = getUserId(c);
  const { id } = c.req.param();

  const result = await db
    .delete(schema.ccAttachments)
    .where(and(eq(schema.ccAttachments.id, id), eq(schema.ccAttachments.userId, userId)))
    .returning({ id: schema.ccAttachments.id });

  if (result.length === 0) throw errors.notFound('Attachment');
  return c.json({ success: true });
});

export { ccRoutes };
