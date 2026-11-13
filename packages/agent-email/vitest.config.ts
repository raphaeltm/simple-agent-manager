import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // smtp-client.ts imports the Workers-only socket API; see the stub for why it is never called.
    alias: { 'cloudflare:sockets': resolve(__dirname, 'tests/mocks/cloudflare-sockets.ts') },
  },
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
});
