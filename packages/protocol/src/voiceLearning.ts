import { z } from 'zod';

const unit = z.number().finite().min(0).max(1);
export const VoiceFeedbackSchema = z.object({
  id: z.string().uuid(), group: z.string().uuid(), at: z.number().int().nonnegative().safe(),
  features: z.tuple([unit, unit, unit, unit, unit, unit]),
  head: z.enum(['addressed', 'finished']), label: z.union([z.literal(0), z.literal(1)]),
  source: z.literal('human'),
  // Requires separate, explicit context consent. Never PCM or unreviewed observations.
  text: z.string().trim().min(1).max(320).optional(), context: z.string().max(320).optional(),
}).strict();
export const VoicePersonalModelSchema = z.object({
  schema: z.literal(1), version: z.string().min(1).max(80), samples: z.number().int().min(0).max(500),
  mode: z.literal('shadow'),
  addressed: z.array(z.number().finite().min(-4).max(4)).length(7),
  finished: z.array(z.number().finite().min(-4).max(4)).length(7),
}).strict();
// A bounded complete snapshot, not append events: deletion and correction remove old gradients.
// The registered Peer identity determines storage; the caller cannot select another device.
export const VoiceLearningRequestSchema = z.object({
  t: z.literal('voice_learning_sync'), requestId: z.string().uuid(),
  revision: z.number().int().min(1).safe(), enabled: z.boolean(),
  samples: z.array(VoiceFeedbackSchema).max(500),
  contextConsent: z.boolean().optional(),
}).strict(); // Cross-field consent is checked by the authenticated Host before storage.
export const VoicePersonalAssistSchema = z.object({
  schema: z.literal(2), version: z.string().min(1).max(80),
  mode: z.enum(['context-assist', 'off']), examples: z.number().int().min(0).max(500),
  rules: z.number().int().min(0).max(500).optional(),
  evaluation: z.object({ groups: z.number().int().min(0).max(500), tested: z.number().int().min(0).max(100),
    matched: z.number().int().min(0).max(100), correct: z.number().int().min(0).max(100) }).strict(),
  trainedAt: z.number().int().nonnegative().safe(), trainingMs: z.number().int().nonnegative().safe(),
}).strict();
export const VoiceLearningResultSchema = z.object({
  t: z.literal('voice_learning_result'), requestId: z.string().uuid(),
  revision: z.number().int().nonnegative().safe(),
  status: z.enum(['completed', 'revoked', 'stale', 'failed']),
  model: VoicePersonalModelSchema.optional(), error: z.string().max(200).optional(),
  assist: VoicePersonalAssistSchema.optional(),
}).strict();
export type VoiceLearningRequest = z.infer<typeof VoiceLearningRequestSchema>;
export type VoiceLearningResult = z.infer<typeof VoiceLearningResultSchema>;
