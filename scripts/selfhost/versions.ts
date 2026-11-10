/**
 * Pinned celld release used by `scripts/selfhost/deploy.ts` for `celld deploy` and
 * `celld d1 migrations apply`. It must match the image in deploy/selfhost/docker-compose.yml
 * (`versions.test.ts` checks this). 0.6.3 or later: 0.6.2 has a path where a cell whose
 * `own.json` is lost restarts empty.
 */

export const CELLD_VERSION = '0.6.3';

/** sha256 of each release asset (`celld-<target>.gz`), from the GitHub release digests. */
export const CELLD_RELEASE_SHA256: Readonly<Record<string, string>> = {
  'x86_64-unknown-linux-gnu': '5084a083472cf036551a7eac63fa24d22bb9a56323c517f63205724c12783047',
  'aarch64-unknown-linux-gnu': '6d617cdf9f049e43ca6a4e37c4cce5d8e35395c8e86b371c984d32ba7d803bf5',
  'aarch64-apple-darwin': '2df6b08369345db8c1f9a5edcf3932cecaa6fb35f4658575a6db17df28c22371',
};

/** Overridable with CELLD_RELEASE_BASE_URL (a mirror); the checksum still has to match. */
export const DEFAULT_CELLD_RELEASE_BASE_URL = 'https://github.com/denoland/celld/releases/download';
