import { parseHomeAssistantSettings, type HomeAssistantSettings, type HomeEntity } from '@termbridge/settings';

type Result = Record<string, unknown>;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
function failure(code: string, error: string, retryable = false): Result {
  return { ok: false, code, error, failureKind: retryable ? 'transient' : 'invalid_request', retryable };
}
class RequestFailure extends Error {
  constructor(readonly result: Result) { super('Home Assistant request failed'); }
}

/** Shared text/voice execution boundary. Only exact Host policy targets and fixed services. */
export class HomeActions {
  private readonly policy?: HomeAssistantSettings;
  private readonly token: string;
  private readonly configurationInvalid: boolean;
  private readonly receipts = new Map<string, { fingerprint: string; expires: number; result: Promise<Result> }>();
  private readonly busy = new Set<string>();
  constructor(
    configuration: unknown,
    env: NodeJS.ProcessEnv = process.env,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    let policy: HomeAssistantSettings | undefined;
    let invalid = false;
    try { policy = parseHomeAssistantSettings(configuration); } catch { invalid = true; }
    this.policy = policy;
    this.configurationInvalid = invalid;
    this.token = policy ? env[policy.tokenEnv || 'TB_HA_TOKEN']?.trim() || '' : '';
  }
  async execute(args: Record<string, unknown>, requestId?: string): Promise<Result> {
    const keys: Record<string, string[]> = {
      inventory: ['action', 'offset', 'room', 'query'], states: ['action', 'offset', 'room', 'query'],
      state: ['action', 'entityId'], control: ['action', 'entityId', 'command', 'value'],
    };
    if (typeof args.action !== 'string' || !Object.hasOwn(keys, args.action) ||
        Object.keys(args).some(key => !keys[args.action as string].includes(key))) {
      return failure('unsupported_action', 'Use inventory, states, state, or an explicitly allowlisted control command');
    }
    if (this.configurationInvalid) return failure('invalid_configuration', 'Invalid Host Home Assistant configuration');
    const policy = this.policy;
    if (!policy?.enabled) return failure('not_configured', 'Home Assistant is not configured or enabled on this Host');
    if (args.action === 'inventory' || args.action === 'states') {
      const offset = args.offset ?? 0;
      if (!Number.isSafeInteger(offset) || (offset as number) < 0 ||
          [args.room, args.query].some(v => v !== undefined && (typeof v !== 'string' || !v.trim() || v.length > 80))) {
        return failure('invalid_request', 'Use a non-negative offset and optional room/name filters of 1-80 characters');
      }
      const selected = policy.entities.filter(e => (args.room === undefined || e.room === args.room) &&
        (args.query === undefined || `${e.name} ${e.entityId}`.toLowerCase().includes((args.query as string).toLowerCase())));
      const start = offset as number, page = selected.slice(start, start + 20);
      const common = { action: args.action, countUnit: 'entity', total: selected.length, controllableCount: selected.filter(e => !!e.control).length, readOnlyCount: selected.filter(e => !e.control).length, nextOffset: start + 20 < selected.length ? start + 20 : null };
      if (args.action === 'inventory') return {
        ok: true, ...common, source: 'host_allowlist', live: false, credentialConfigured: Boolean(this.token),
        writesEnabled: policy.entities.some(e => !!e.control), entities: page,
      };
      if (!this.token) return this.missingCredential();
      const entities: Result[] = [];
      // Four bounded reads at once; never request HA's unrestricted all-states endpoint.
      for (let i = 0; i < page.length; i += 4) entities.push(...await Promise.all(page.slice(i, i + 4).map(e => this.readState(e))));
      return { ok: true, ...common, source: 'home_assistant', live: true,
        partial: entities.some(e => !e.ok), entities };
    }
    const entity = policy.entities.find(item => item.entityId === args.entityId);
    if (!entity) return failure('entity_denied', 'An exact Host-allowlisted entityId is required');
    if (args.action === 'state') return this.token ? this.readState(entity) : this.missingCredential();
    const command = args.command;
    if (typeof command !== 'string' || !entity.control?.commands.includes(command)) {
      return failure('command_denied', 'This entity/command has no standing authorization in Host policy');
    }
    const parameterized = ['brightness', 'color_temperature', 'percentage', 'position', 'cool', 'temperature'].includes(command);
    const min = command === 'color_temperature' ? 2200 : ['cool', 'temperature'].includes(command) ? 18 : 0;
    const max = command === 'color_temperature' ? 6500 : ['cool', 'temperature'].includes(command) ? 30 : 100;
    if (parameterized ? typeof args.value !== 'number' || !Number.isFinite(args.value) || args.value < min || args.value > max : args.value !== undefined) {
      return failure('invalid_value', parameterized ? `value must be between ${min} and ${max}` : 'This command accepts no value');
    }
    if (!requestId || requestId.length > 512) return failure('missing_request_id', 'Control requires a Host-generated tool request identity');
    if (!this.token) return this.missingCredential();
    const fingerprint = JSON.stringify([entity.entityId, command, args.value ?? null]);
    for (const [id, receipt] of this.receipts) if (receipt.expires < this.now()) this.receipts.delete(id);
    const previous = this.receipts.get(requestId);
    if (previous) return previous.fingerprint === fingerprint ? previous.result : failure('request_conflict', 'Request identity already belongs to another command');
    if (this.receipts.size >= 1000) return failure('capacity', 'Control receipt capacity reached; no command sent');
    if (this.busy.has(entity.entityId)) return failure('entity_busy', 'A command for this entity is already in progress; query its state first');
    this.busy.add(entity.entityId);
    const result = this.control(entity, command, args.value as number | undefined).finally(() => this.busy.delete(entity.entityId));
    this.receipts.set(requestId, { fingerprint, expires: this.now() + RECEIPT_TTL_MS, result });
    return result;
  }
  private missingCredential(): Result { return failure('missing_credential', 'Provision the dedicated Home Assistant credential in the Host environment'); }
  private async request(path: string, body?: Result): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.policy!.baseUrl}${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status)) throw new RequestFailure({ ...failure('authorization', 'Home Assistant rejected the Host credential'), failureKind: 'authorization' });
        if (body && response.status >= 500) throw new RequestFailure(failure('outcome_unknown', 'Control outcome is unknown; read state before another command'));
        throw new RequestFailure(failure('upstream_error', `Home Assistant returned HTTP ${response.status}`, !body && (response.status === 429 || response.status >= 500)));
      }
      return await readBoundedJson(response);
    } catch (error) {
      if (error instanceof RequestFailure) throw error;
      throw new RequestFailure(body
        ? failure('outcome_unknown', 'Control outcome is unknown; do not replay automatically, query state first')
        : controller.signal.aborted ? failure('timeout', 'Home Assistant read timed out; retry this read later', true)
        : failure('read_failed', 'Home Assistant read failed (network or invalid response)', true));
    } finally { clearTimeout(timer); }
  }
  private async readState(entity: HomeEntity): Promise<Result> {
    try {
      const raw = await this.request(`/api/states/${encodeURIComponent(entity.entityId)}`);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid response');
      const state = raw as Result;
      if (state.entity_id !== entity.entityId || typeof state.state !== 'string' || state.state.length > 256) throw new Error('invalid response');
      const attributes = state.attributes && typeof state.attributes === 'object' && !Array.isArray(state.attributes) ? state.attributes as Result : {};
      const result: Result = { ok: true, action: 'state', source: 'home_assistant', entityId: entity.entityId,
        name: entity.name, purpose: entity.purpose, ...(entity.room ? { room: entity.room } : {}),
        state: state.state, available: !['unavailable', 'unknown'].includes(state.state),
        observedAt: new Date(this.now()).toISOString(), writesEnabled: !!entity.control };
      for (const key of ['last_changed', 'last_updated']) if (typeof state[key] === 'string' && Number.isFinite(Date.parse(state[key]))) result[key] = new Date(state[key]).toISOString();
      if (typeof attributes.unit_of_measurement === 'string' && attributes.unit_of_measurement.length <= 20) result.unit = attributes.unit_of_measurement;
      const projected: Result = {};
      for (const key of ['brightness', 'color_temp_kelvin', 'min_color_temp_kelvin', 'max_color_temp_kelvin', 'temperature', 'current_temperature', 'current_humidity', 'min_temp', 'max_temp', 'percentage', 'current_position', 'supported_features']) {
        if (typeof attributes[key] === 'number' && Number.isFinite(attributes[key])) projected[key] = attributes[key];
      }
      for (const key of ['hvac_action', 'color_mode', 'device_class']) if (typeof attributes[key] === 'string' && attributes[key].length <= 40) projected[key] = attributes[key];
      for (const key of ['hvac_modes', 'supported_color_modes']) if (Array.isArray(attributes[key])) projected[key] = (attributes[key] as unknown[]).filter(v => typeof v === 'string' && v.length <= 40).slice(0, 16);
      if (typeof projected.brightness === 'number' && projected.brightness >= 0 && projected.brightness <= 255) projected.brightness_pct = Math.round(projected.brightness / 255 * 100);
      if (Object.keys(projected).length) result.attributes = projected;
      return JSON.parse(JSON.stringify(result, (_key, value: unknown) => typeof value === 'string' ? value.split(this.token).join('[redacted]') : value)) as Result;
    } catch (error) { return { ...(error instanceof RequestFailure ? error.result : failure('read_failed', 'Home Assistant returned an invalid state', true)), entityId: entity.entityId, name: entity.name }; }
  }
  private async control(entity: HomeEntity, command: string, value?: number): Promise<Result> {
    const before = await this.readState(entity);
    if (!before.ok) return { ...before, retryable: false };
    if (!before.available) return failure('unavailable', 'The entity is unavailable; no command sent');
    const attrs = (before.attributes ?? {}) as Result;
    const domain = entity.entityId.split('.')[0];
    let service = '', data: Result = { entity_id: entity.entityId };
    if (domain === 'light') {
      service = command === 'off' ? 'turn_off' : 'turn_on';
      const modes = Array.isArray(attrs.supported_color_modes) ? attrs.supported_color_modes : [];
      if (command === 'brightness') {
        if (!modes.some(m => ['brightness', 'color_temp', 'hs', 'xy', 'rgb', 'rgbw', 'rgbww', 'white'].includes(String(m)))) return failure('unsupported_capability', 'Light does not report brightness support');
        data.brightness_pct = value;
      }
      if (command === 'color_temperature') {
        if (!modes.includes('color_temp') || typeof attrs.min_color_temp_kelvin !== 'number' || typeof attrs.max_color_temp_kelvin !== 'number' || value! < attrs.min_color_temp_kelvin || value! > attrs.max_color_temp_kelvin) return failure('unsupported_capability', 'Color temperature is outside reported light capabilities');
        data.color_temp_kelvin = value;
      }
    } else if (domain === 'fan') {
      service = command === 'percentage' ? 'set_percentage' : command === 'off' ? 'turn_off' : 'turn_on';
      if (command === 'percentage') {
        if (!(Number(attrs.supported_features) & 1)) return failure('unsupported_capability', 'Fan does not report speed support');
        data.percentage = value;
      }
    } else if (domain === 'climate') {
      service = command === 'off' ? 'set_hvac_mode' : 'set_temperature';
      if (command === 'off') data.hvac_mode = 'off';
      else {
        if (!Array.isArray(attrs.hvac_modes) || !attrs.hvac_modes.includes('cool') || (command === 'temperature' && before.state !== 'cool')) return failure('unsupported_capability', 'Only cooling is permitted; use cool to start cooling explicitly');
        if (typeof attrs.min_temp !== 'number' || typeof attrs.max_temp !== 'number' || value! < attrs.min_temp || value! > attrs.max_temp) return failure('unsupported_capability', 'Temperature is outside reported device limits');
        try {
          const config = await this.request('/api/config') as { unit_system?: { temperature?: string } };
          if (config?.unit_system?.temperature !== '°C') return failure('unsupported_units', 'Cooling commands require Home Assistant Celsius units');
        } catch (error) { return error instanceof RequestFailure ? { ...error.result, retryable: false } : failure('read_failed', 'Cannot verify temperature units'); }
        data.temperature = value; data.hvac_mode = 'cool';
      }
    } else if (domain === 'cover') {
      if (attrs.device_class !== 'curtain') return failure('unsafe_equipment', 'Only entities reporting curtain device class may move');
      const feature = { open: 1, close: 2, position: 4, stop: 8 }[command];
      if (!feature || !(Number(attrs.supported_features) & feature)) return failure('unsupported_capability', 'Curtain does not report this capability');
      service = { open: 'open_cover', close: 'close_cover', position: 'set_cover_position', stop: 'stop_cover' }[command]!;
      if (command === 'position') data.position = value;
    }
    if (!service) return failure('command_denied', 'No supported service mapping');
    try {
      // Service result can contain unrelated changed entities. Discard it entirely.
      const raw = await this.request(`/api/services/${domain}/${service}`, data);
      if (!Array.isArray(raw)) return failure('outcome_unknown', 'Unexpected service response; read state before any retry');
    } catch (error) { return error instanceof RequestFailure ? error.result : failure('outcome_unknown', 'Control outcome is unknown'); }
    const observation = await this.readState(entity);
    return { ok: true, action: 'control', entityId: entity.entityId, name: entity.name, command,
      ...(value === undefined ? {} : { value }), status: 'accepted', retryable: false,
      physicalVerified: false, observation,
      summary: 'Home Assistant accepted the command; the follow-up state is an observation, not physical verification' };
  }
}
async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty response');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error('response too large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
