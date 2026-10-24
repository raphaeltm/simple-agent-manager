/** Canonical identity for a GitHub pull request in one configured project repository. */
export function canonicalProjectPullRequestUrl(
  value: string,
  projectRepository: string
): string | null {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([0-9]+)\/?$/.exec(value);
  if (!match || match[1]?.toLowerCase() !== projectRepository.toLowerCase()) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return `https://github.com/${projectRepository.toLowerCase()}/pull/${number}`;
}
