import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './packages/cloudflare-relay/src/index.ts',
      miniflare: {
        bindings: { TB_PUBLIC_ROOMS: '1' },
        durableObjects: {
          RELAY: { className: 'TermbridgeRelay', useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ['packages/cloudflare-relay/src/**/*.test.ts'],
  },
});
