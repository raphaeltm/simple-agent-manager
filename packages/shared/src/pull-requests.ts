/** Canonical PR URL for a project's GitHub repository, or null when it is unrelated. */
export function canonicalProjectPullRequestUrl(
  value: string,
  projectRepository: string
): string | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)\/?$/i.exec(
    value.trim()
  );
  if (!match) return null;
  const repository = `${match[1]}/${match[2]}`.toLowerCase();
  const number = Number(match[3]);
  if (repository !== projectRepository.toLowerCase() || !Number.isSafeInteger(number)) return null;
  return `https://github.com/${repository}/pull/${number}`;
}
