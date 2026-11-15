/**
 * Reviewed facts about container image inputs that cannot be read from a
 * Dockerfile: which apt suites a base image ships, and which copied build
 * scripts were read for unpinned downloads. Used by `container-image-inputs.ts`.
 */
import type { AptSource } from './container-image-inputs';

/**
 * apt suites shipped by each reviewed base image, by manifest digest. A stage
 * that runs `apt-get install` on a base missing here gets no key: its package
 * sources are unknown, so their changes could not be detected.
 */
export const BASE_IMAGE_APT_SOURCES: Readonly<Record<string, readonly AptSource[]>> = {
  // docker.io/library/node:22-bookworm-slim (Debian 12), /etc/apt/sources.list.d/debian.sources
  'sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436': [
    { url: 'https://deb.debian.org/debian', suite: 'bookworm', components: ['main'] },
    { url: 'https://deb.debian.org/debian', suite: 'bookworm-updates', components: ['main'] },
    {
      url: 'https://deb.debian.org/debian-security',
      suite: 'bookworm-security',
      components: ['main'],
    },
  ],
  // docker.io/cloudflare/sandbox:0.12.10 (Ubuntu 22.04), /etc/apt/sources.list
  'sha256:35c932d3e5b35f28d350800cf00551cac46dfe28274afb54e16325b8d8f560d1': [
    'jammy',
    'jammy-updates',
    'jammy-backports',
  ]
    .map((suite) => ({
      url: 'https://archive.ubuntu.com/ubuntu',
      suite,
      components: ['main', 'restricted', 'universe', 'multiverse'],
    }))
    .concat({
      url: 'https://security.ubuntu.com/ubuntu',
      suite: 'jammy-security',
      components: ['main', 'restricted', 'universe', 'multiverse'],
    }),
};

/**
 * Copied files a Dockerfile executes at build time, with the sha256 they were
 * reviewed at. Their content is hashed like any copied file, but what they
 * fetch is not visible here, so each was read to confirm it installs only
 * digest-pinned or local artifacts. Any edit changes the hash and disables
 * reuse until the script is read again and this entry updated.
 */
export const REVIEWED_BUILD_SCRIPTS: Readonly<Record<string, { sha256: string; reason: string }>> =
  {
    'container-artifacts/install-opencode.sh': {
      // packages/vm-agent/internal/acp/opencode_install.sh, copied by `make prepare-container`.
      sha256: '4220eb1f3100f32dbd8ed69f21305c84500988a8a26223895dbf8bf3703955be',
      reason:
        'downloads one opencode release archive checked against a pinned sha256; its apt-get fallback only runs when curl/tar/gzip/sha256sum are missing, and the Dockerfile installs them first',
    },
    'container-artifacts/install-codex-runtime.sh': {
      // packages/vm-agent/internal/acp/codex_runtime_installer.sh
      sha256: '4b7423700284436e21ed40995d5b8bf10c00f0fe47a1526d6bd1298968b462a3',
      reason: 'installs from the copied, checksum-verified codex runtime archive only',
    },
    'container-entrypoints/patch-acp-amp.py': {
      sha256: '69d60cd8f785160beba1c30d51becedac0cbd599d490b9579c015f45311d2ec5',
      reason: 'edits files of the already-installed acp-amp tool; no network access',
    },
  };
