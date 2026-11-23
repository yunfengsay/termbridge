# Termbridge Cloudflare relay

This directory is shipped with `agent-termbridge`. The Worker uses one Durable
Object to coordinate host and client WebSockets, and WebSocket Hibernation keeps
idle personal usage inexpensive.

The normal path is:

```sh
tb cloudflare login
tb cloudflare deploy
```

Deployment generates a local 256-bit Termbridge password when none exists,
stores the same value as the Worker's encrypted `TB_SECRET`, and selects the
resulting `wss://…workers.dev` URL as `tb middle`. The Worker fails closed until
that secret is present.

For manual deployment, first run `pnpm build`, then:

```sh
pnpm exec wrangler deploy --config cloudflare/wrangler.jsonc
pnpm exec wrangler secret put TB_SECRET --config cloudflare/wrangler.jsonc
```
