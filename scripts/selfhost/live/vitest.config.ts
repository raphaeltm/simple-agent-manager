import { defineConfig } from 'vitest/config';

/**
 * Live self-host suite: real frp and celld binaries (checksum-pinned downloads), the box's Caddy
 * image built from deploy/selfhost/caddy/Dockerfile, and digest-pinned Mailpit and MinIO images.
 * Run with `pnpm selfhost:live-test`; needs network access (downloads, image pulls, the Caddy
 * build) and a Linux Docker daemon that supports `--network host`. No root or nftables.
 */
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['**/*.live.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
