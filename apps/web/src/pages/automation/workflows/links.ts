/**
 * Where a step's outputs point. Every value here was written by an agent, so links are built
 * only for shapes we can vouch for: a Library file in this project, or an http(s) URL. Anything
 * else is shown as text.
 */
import type { WorkflowArtifactRef } from '@simple-agent-manager/shared';

import { projectLibraryFilePath } from '../../../lib/project-routes';
import { sanitizeUrl } from '../../../lib/url-utils';

export interface OutputLink {
  kind: 'library' | 'pull-request' | 'url' | 'branch' | 'text';
  /** What the chip says, for example "Library file" or "Pull request". */
  label: string;
  /** The reference itself, shown under or beside the label. */
  detail: string;
  href: string | null;
  external: boolean;
  /** A Library file, which the chip opens in place (its `href` is the Library fallback). */
  libraryFile?: { projectId: string; fileId: string };
}

/** Library file IDs are ULIDs. */
const LIBRARY_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

const safeHttp = (value: string) => {
  const url = sanitizeUrl(value.trim());
  return url === '#' ? null : url;
};

const isPullRequestUrl = (url: string) => /\/pull\/\d+/.test(url);

export function pullRequestLink(prUrl: string): OutputLink {
  const href = safeHttp(prUrl);
  return {
    kind: href ? 'pull-request' : 'text',
    label: 'Pull request',
    detail: prUrl.replace(/^https?:\/\/(www\.)?github\.com\//, ''),
    href,
    external: Boolean(href),
  };
}

export function branchLink(branch: string): OutputLink {
  return { kind: 'branch', label: 'Branch', detail: branch, href: null, external: false };
}

export function artifactLink(ref: WorkflowArtifactRef, projectId: string): OutputLink {
  const type = ref.type.toLowerCase();
  const value = ref.ref.trim();
  const http = safeHttp(value);
  if (http)
    return isPullRequestUrl(http)
      ? pullRequestLink(http)
      : { kind: 'url', label: 'Link', detail: value, href: http, external: true };
  if (type.includes('branch')) return branchLink(value);
  const libraryType = type.includes('library') || type === 'file' || type === 'document';
  if (libraryType && LIBRARY_ID.test(value))
    return {
      kind: 'library',
      label: 'Library file',
      detail: value,
      href: projectLibraryFilePath(projectId, value),
      external: false,
      libraryFile: { projectId, fileId: value },
    };
  return {
    kind: 'text',
    label: ref.type || 'Reference',
    detail: value,
    href: null,
    external: false,
  };
}
