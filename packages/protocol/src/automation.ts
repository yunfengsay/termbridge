import { z } from 'zod';

/** Optional client/host extension; relays forward these existing Control frames unchanged. */
export const AutomationSchema = z.object({
  t: z.literal('automation'), id: z.string().min(1).max(128),
  kind: z.enum(['request', 'data', 'ack', 'eof', 'result', 'cancel']),
  op: z.string().max(40).optional(), args: z.record(z.unknown()).optional(),
  stream: z.string().max(16).optional(), seq: z.number().int().nonnegative().optional(),
  data: z.string().max(180000).optional(), result: z.record(z.unknown()).optional(),
  error: z.string().max(4000).optional(),
});
export type AutomationMessage = z.infer<typeof AutomationSchema>;
