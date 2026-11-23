import { z } from 'zod';
import { createHash } from 'node:crypto';

export const MAX_SCRIPT_BYTES = 64_000;
const id = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);
const field = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/)
  .refine(s => !['constructor', 'prototype', '__proto__'].includes(s));
const scalar = z.union([z.string().max(4000), z.number().finite(), z.boolean()]);
const input = z.object({ type: z.enum(['string', 'number', 'boolean']), description: z.string().max(300),
  enum: z.array(scalar).min(1).max(32).optional() }).strict();
const schema = z.object({ formatVersion: z.literal(1), id, version: z.number().int().positive(),
  description: z.string().min(1).max(500), inputs: z.record(field, input),
  steps: z.array(z.object({ id,
    tool: z.enum(['inspect_workspace', 'workspace_files', 'search_web', 'inspect_images',
      'continue_agent', 'dispatch_agent', 'phone_action', 'home_assistant']),
    arguments: z.record(z.unknown()),
  }).strict()).min(1).max(12) }).strict();
export type ToolScript = z.infer<typeof schema>;
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);

export function parseScript(value: unknown): ToolScript {
  // Inspect raw JSON before Zod normalizes records (which can drop __proto__).
  const json = JSON.stringify(value, (key, item: unknown) => {
    if (forbidden.has(key)) throw new Error('Unsafe script property');
    return item;
  });
  if (Buffer.byteLength(json ?? '') > MAX_SCRIPT_BYTES) throw new Error('Script too large');
  const script = schema.parse(value);
  if (Object.keys(script.inputs).length > 16) throw new Error('Too many inputs');
  const prior = new Set<string>();
  for (const step of script.steps) {
    if (prior.has(step.id)) throw new Error('Duplicate step id');
    inspectValue(step.arguments, script, prior, 0);
    // Reusable scripts cannot turn individually permitted home control into bulk writes.
    if (step.tool === 'home_assistant' && !['inventory', 'states', 'state'].includes(String(step.arguments.action))) {
      throw new Error('Scripts support read-only home actions only');
    }
    // Existing sessions must be supplied live, never cached in a reusable script.
    const session = step.arguments.sessionId;
    if (step.tool === 'continue_agent' && (!session || typeof session !== 'object' ||
      !('$input' in session || '$result' in session))) {
      throw new Error('continue_agent sessionId must be a live input or prior result reference');
    }
    prior.add(step.id);
  }
  return script;
}

function inspectValue(value: unknown, script: ToolScript, prior: Set<string>, depth: number): void {
  if (depth > 10) throw new Error('Script nesting too deep');
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value === 'string' && value.length <= 4000) return;
  if (Array.isArray(value)) {
    if (value.length > 64) throw new Error('Array too large');
    value.forEach(v => inspectValue(v, script, prior, depth + 1)); return;
  }
  if (!value || typeof value !== 'object') throw new Error('Invalid script value');
  const obj = value as Record<string, unknown>, keys = Object.keys(obj);
  if ('$input' in obj) {
    if (keys.length !== 1 || typeof obj.$input !== 'string' || !Object.hasOwn(script.inputs, obj.$input)) throw new Error('Unknown input reference');
    return;
  }
  if ('$result' in obj) {
    if (keys.length !== 2 || typeof obj.$result !== 'string' || !prior.has(obj.$result) ||
      !Array.isArray(obj.path) || obj.path.length > 8 || !obj.path.every(k =>
        (typeof k === 'string' && k.length < 100 && !forbidden.has(k)) || (Number.isSafeInteger(k) && Number(k) >= 0))) {
      throw new Error('Invalid prior result reference');
    }
    return;
  }
  for (const k of keys) {
    if (forbidden.has(k) || k.startsWith('$')) throw new Error('Unsafe script property');
    inspectValue(obj[k], script, prior, depth + 1);
  }
}

export function bindInputs(script: ToolScript, values: Record<string, unknown>): void {
  if (Object.keys(values).some(k => !Object.hasOwn(script.inputs, k))) throw new Error('Unknown input argument');
  for (const [key, spec] of Object.entries(script.inputs)) {
    const value = values[key];
    if (!Object.hasOwn(values, key) || typeof value !== spec.type ||
      (typeof value === 'string' && value.length > 4000) ||
      (typeof value === 'number' && !Number.isFinite(value)) ||
      (spec.enum && !spec.enum.includes(value as string | number | boolean))) throw new Error(`Invalid input: ${key}`);
  }
}

export function resolveValue(value: unknown, inputs: Record<string, unknown>, results: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map(v => resolveValue(v, inputs, results));
  if (!value || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  if (typeof obj.$input === 'string') return inputs[obj.$input];
  if (typeof obj.$result === 'string') {
    let current = results[obj.$result];
    for (const part of obj.path as (string | number)[]) {
      if (!current || typeof current !== 'object' || forbidden.has(String(part)) || !Object.hasOwn(current, part)) {
        throw new Error('Referenced result field is unavailable');
      }
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveValue(v, inputs, results)]));
}

export function scriptDigest(script: ToolScript): string {
  return createHash('sha256').update(JSON.stringify(script)).digest('hex');
}
