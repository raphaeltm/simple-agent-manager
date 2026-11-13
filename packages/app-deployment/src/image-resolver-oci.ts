/** OCI distribution URL pieces for the image resolver: repository and tag validation, manifest URLs, bearer challenges. */
const OCI_REPOSITORY_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OCI_TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

// Non-backtracking: the capture group is forced to start with a non-space
// character so it cannot overlap with the preceding `\s+`.
const BEARER_CHALLENGE_RE = /^Bearer\s+(\S.*)$/i;

const PERCENT_ENCODED_CONTROL_RE = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i;

export function hasUnsafeRawUrlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return PERCENT_ENCODED_CONTROL_RE.test(value);
}

function validateRepository(repository: string): string[] {
  if (hasUnsafeRawUrlCharacters(repository) || repository.includes('%')) {
    throw new Error(
      'Unsafe image repository rejected: encoded or control characters are not allowed.'
    );
  }
  if (repository.includes('?') || repository.includes('#') || repository.includes('\\')) {
    throw new Error('Unsafe image repository rejected: URL delimiters are not allowed.');
  }
  const segments = repository.split('/');
  if (
    segments.length === 0 ||
    segments.some((segment) => {
      return (
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        !OCI_REPOSITORY_SEGMENT_RE.test(segment)
      );
    })
  ) {
    throw new Error('Unsafe image repository rejected: invalid OCI repository path.');
  }
  return segments;
}

function validateTag(tag: string): string {
  if (hasUnsafeRawUrlCharacters(tag) || tag.includes('%')) {
    throw new Error('Unsafe image tag rejected: encoded or control characters are not allowed.');
  }
  if (tag.includes('/') || tag.includes('?') || tag.includes('#') || tag.includes('\\')) {
    throw new Error('Unsafe image tag rejected: URL delimiters are not allowed.');
  }
  if (!OCI_TAG_RE.test(tag)) {
    throw new Error('Unsafe image tag rejected: invalid OCI tag.');
  }
  return tag;
}

export function manifestUrl(base: string, repository: string, tag: string): string {
  const repositoryPath = validateRepository(repository).map(encodeURIComponent).join('/');
  const safeTag = encodeURIComponent(validateTag(tag));
  return `${base}/v2/${repositoryPath}/manifests/${safeTag}`;
}

/**
 * Parse a WWW-Authenticate: Bearer realm="...",service="...",scope="..." header.
 */
export function parseBearerChallenge(
  header: string
): { realm: string; service?: string; scope?: string } | null {
  const match = BEARER_CHALLENGE_RE.exec(header);
  if (!match) return null;

  const [, params] = match;
  if (params === undefined) return null;
  const realm = extractParam(params, 'realm');
  if (!realm) return null;

  return {
    realm,
    service: extractParam(params, 'service'),
    scope: extractParam(params, 'scope'),
  };
}

function extractParam(params: string, key: string): string | undefined {
  const re = new RegExp(`${key}="([^"]*)"`, 'i');
  const m = re.exec(params);
  return m ? m[1] : undefined;
}
