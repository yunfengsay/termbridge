import { z } from 'zod';

/**
 * Optional client/host TCP proxy tunnel over existing Control frames.
 * Relays forward these frames unchanged once authenticated.
 */
export const ProxyTunnelPolicySchema = z.enum(['full', 'loopback', 'off']);
export type ProxyTunnelPolicy = z.infer<typeof ProxyTunnelPolicySchema>;

export const ProxyTunnelSchema = z.object({
  t: z.literal('proxy_tunnel'),
  id: z.string().min(1).max(64),
  kind: z.enum(['open', 'opened', 'data', 'ack', 'close']),
  host: z.string().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  /** Base64-encoded raw TCP payload chunk (up to 48 KiB raw -> 64 KiB base64). */
  data: z.string().max(96_000).optional(),
  /** Flow-control credit replenishment in raw bytes consumed by the peer. */
  bytes: z.number().int().min(1).max(4 * 1024 * 1024).optional(),
  reason: z.string().max(512).optional(),
});

export type ProxyTunnelMessage = z.infer<typeof ProxyTunnelSchema>;
