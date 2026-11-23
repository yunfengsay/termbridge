// Secrets are intentionally absent from wrangler.jsonc, so Wrangler cannot
// generate their types. This declaration augments its generated Env safely.
interface Env {
  TB_SECRET?: string;
  TB_PUBLIC_ROOMS?: string;
}
