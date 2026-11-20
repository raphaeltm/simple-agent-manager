/**
 * Git ref-name admission shared by hosted-git push validation (`validatePush` in the vendored
 * dgit protocol) and project creation, which names the branch the seed push writes. One
 * predicate, so a branch SAM accepts can always be pushed.
 *
 * Rules follow `git check-ref-format` (https://git-scm.com/docs/git-check-ref-format) plus SAM's
 * conservative bounds: no whitespace, control, quote or HTML characters and at most 255
 * characters in total. This module has no dependencies, so the Worker graph may import it.
 */
// eslint-disable-next-line no-control-regex -- git check-ref-format rejects ASCII control bytes
const BAD_REF_CHARS = /[\s~^:?*[\\'"<>&`\x00-\x1f\x7f]/;
const MAX_REF_NAME_LENGTH = 255;

/** True when `ref` (a full name such as `refs/heads/main`) is a ref name git and SAM accept. */
export function isValidGitRefName(ref: string): boolean {
  return (
    ref.startsWith('refs/') &&
    ref.length <= MAX_REF_NAME_LENGTH &&
    !ref.includes('..') &&
    !BAD_REF_CHARS.test(ref) &&
    !ref.includes('@{') &&
    !ref.includes('//') &&
    !ref.endsWith('/') &&
    !ref.endsWith('.') &&
    !ref.split('/').some((c) => c.startsWith('.') || c.endsWith('.lock'))
  );
}

/** True when `branch` (a short name such as `main`) names a valid `refs/heads/` ref. */
export function isValidGitBranchName(branch: string): boolean {
  return branch.length > 0 && isValidGitRefName(`refs/heads/${branch}`);
}
