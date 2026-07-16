import { drizzle } from 'drizzle-orm/d1';
import { type Context, Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireProjectAccess } from '../../middleware/project-auth';
import { getExternalInstallationId } from '../../services/github-installation-ids';
import type { RepoBrowser } from '../../services/repo-browse';
import { resolveRepoBrowser } from '../../services/repo-browse';
import { requireProjectInstallation, requireRepositoryUserAccess } from './_helpers';

const repoBrowseRoutes = new Hono<{ Bindings: Env }>();

/** Allowed characters in a git ref/branch name (rejects control chars, whitespace, CRLF, NUL). */
const VALID_REF = /^[A-Za-z0-9._\-/]+$/;
/**
 * MIME types the browser will execute as script if served inline. We force these
 * to octet-stream + attachment so a committed .svg/.html cannot run as stored XSS
 * on the api origin. Mirrors apps/api/src/routes/library.ts.
 */
const DANGEROUS_MIMES = ['text/html', 'application/javascript', 'application/xhtml+xml', 'image/svg+xml', 'text/xml'];

/** Validate a git ref: non-empty, no `..`, only ref-safe characters. */
function validateRef(ref: string, label = 'ref'): string {
  if (!VALID_REF.test(ref) || ref.split('/').includes('..')) {
    throw errors.badRequest(`${label} contains invalid characters`);
  }
  return ref;
}

function requireRef(c: Context): string {
  const ref = c.req.query('ref');
  if (!ref) throw errors.badRequest('ref query parameter is required');
  return validateRef(ref);
}

function requirePath(c: Context): string {
  const path = c.req.query('path');
  if (!path) throw errors.badRequest('path query parameter is required');
  const normalized = path.replace(/^\/+/, '');
  if (normalized.split('/').some((s) => s === '..' || s === '.')) {
    throw errors.badRequest('path must not contain "." or ".." segments');
  }
  return normalized;
}

/**
 * Resolve the project (with access check + user∩app repo gate) and its
 * {@link RepoBrowser}. The user∩app gate ensures a member who lost GitHub repo
 * access cannot read the repo via the app installation token.
 */
async function resolveBrowser(
  c: Context<{ Bindings: Env }>
): Promise<{ project: schema.Project; browser: RepoBrowser }> {
  const userId = getUserId(c);
  const projectId = c.req.param('id') ?? '';
  const db = drizzle(c.env.DATABASE, { schema });
  const project = await requireProjectAccess(db, projectId, userId);

  // Security gate: user∩app GitHub access (no-op for Artifacts).
  await requireRepositoryUserAccess(c, db, project, userId);

  let externalInstallationId: string | undefined;
  if ((project.repoProvider ?? 'github') === 'github') {
    const installation = await requireProjectInstallation(db, project.installationId);
    externalInstallationId = getExternalInstallationId(installation);
  }

  const browser = await resolveRepoBrowser({ project, env: c.env, userId, externalInstallationId });
  return { project, browser };
}

/** GET /:id/repo/branches — list branches (default first). */
repoBrowseRoutes.get('/:id/repo/branches', async (c) => {
  const { browser } = await resolveBrowser(c);
  return c.json(await browser.listBranches());
});

/** GET /:id/repo/tree?ref= — full recursive tree at ref. */
repoBrowseRoutes.get('/:id/repo/tree', async (c) => {
  const { browser } = await resolveBrowser(c);
  return c.json(await browser.listTree(requireRef(c)));
});

/** GET /:id/repo/file?ref=&path= — text file content (or metadata + rawUrl). */
repoBrowseRoutes.get('/:id/repo/file', async (c) => {
  const projectId = c.req.param('id');
  const { browser } = await resolveBrowser(c);
  const ref = requireRef(c);
  const path = requirePath(c);
  const file = await browser.getFile(ref, path);
  if ((file.isBinary || file.tooLarge) && !file.content) {
    const params = new URLSearchParams({ ref, path });
    file.rawUrl = `/api/projects/${projectId}/repo/raw?${params.toString()}`;
  }
  return c.json(file);
});

/** GET /:id/repo/raw?ref=&path= — raw file bytes (images, binary, oversized).
 *  Script-capable MIME types are forced to a download so a committed .svg/.html
 *  cannot execute as stored XSS on the api origin. */
repoBrowseRoutes.get('/:id/repo/raw', async (c) => {
  const { browser } = await resolveBrowser(c);
  const path = requirePath(c);
  const { bytes, contentType } = await browser.getRawFile(requireRef(c), path);
  const safe = DANGEROUS_MIMES.includes(contentType.toLowerCase());
  const filename = (path.split('/').pop() || 'file').replace(/[^\x20-\x7E]|["\\;]/g, '_');
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      'Content-Type': safe ? 'application/octet-stream' : contentType,
      'Content-Length': String(bytes.length),
      'Content-Disposition': `${safe ? 'attachment' : 'inline'}; filename="${filename}"`,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

/** GET /:id/repo/compare?base=&head= — changed files vs base (default branch if base omitted). */
repoBrowseRoutes.get('/:id/repo/compare', async (c) => {
  const { project, browser } = await resolveBrowser(c);
  const head = c.req.query('head');
  if (!head) throw errors.badRequest('head query parameter is required');
  validateRef(head, 'head');
  const rawBase = c.req.query('base');
  const base = rawBase ? validateRef(rawBase, 'base') : project.defaultBranch;
  return c.json(await browser.compare(base, head));
});

export { repoBrowseRoutes };
