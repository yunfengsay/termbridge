/** Host-local policy only; credentials are never included in this object. */
export const HOME_COMMANDS = {
  light: ['on', 'off', 'brightness', 'color_temperature'],
  fan: ['on', 'off', 'percentage'],
  air_conditioner: ['off', 'cool', 'temperature'],
  curtain: ['open', 'close', 'stop', 'position'],
} as const;
export type HomeEquipment = keyof typeof HOME_COMMANDS;
export interface HomeEntity {
  entityId: string;
  name: string;
  purpose: string;
  room?: string;
  /** Explicit standing authorization for this equipment and these commands. Absent means read-only. */
  control?: { equipment: HomeEquipment; commands: string[] };
}
export interface HomeAssistantSettings {
  enabled: boolean;
  baseUrl: string;
  tokenEnv?: string;
  entities: HomeEntity[];
}
const ENTITY_ID = /^(light|sensor|binary_sensor|fan|climate|cover)\.[a-z0-9_]{1,160}$/;
const DOMAIN: Record<HomeEquipment, string> = { light: 'light', fan: 'fan', air_conditioner: 'climate', curtain: 'cover' };

/** Reject the entire malformed policy; never silently widen authorization. */
export function parseHomeAssistantSettings(value: unknown): HomeAssistantSettings | undefined {
  if (value == null) return undefined;
  const invalid = () => new Error('Invalid Host Home Assistant configuration');
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['enabled', 'baseUrl', 'tokenEnv', 'entities'].includes(key)) ||
      typeof raw.enabled !== 'boolean' || typeof raw.baseUrl !== 'string' ||
      !Array.isArray(raw.entities) || raw.entities.length > 100) throw invalid();
  let url: URL;
  try { url = new URL(raw.baseUrl); } catch { throw invalid(); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') throw invalid();
  const tokenEnv = raw.tokenEnv ?? 'TB_HA_TOKEN';
  if (typeof tokenEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(tokenEnv)) throw invalid();
  const seen = new Set<string>();
  const entities: HomeEntity[] = raw.entities.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    const entity = value as Record<string, unknown>;
    if (Object.keys(entity).some(key => !['entityId', 'name', 'purpose', 'room', 'control'].includes(key)) ||
        typeof entity.entityId !== 'string' || !ENTITY_ID.test(entity.entityId) || seen.has(entity.entityId) ||
        typeof entity.name !== 'string' || !entity.name.trim() || entity.name.length > 80 ||
        typeof entity.purpose !== 'string' || !entity.purpose.trim() || entity.purpose.length > 160 ||
        (entity.room !== undefined && (typeof entity.room !== 'string' || !entity.room.trim() || entity.room.length > 80))) throw invalid();
    seen.add(entity.entityId);
    const result: HomeEntity = { entityId: entity.entityId, name: entity.name.trim(), purpose: entity.purpose.trim() };
    if (typeof entity.room === 'string') result.room = entity.room.trim();
    if (entity.control !== undefined) {
      const c = entity.control as Record<string, unknown>;
      if (!c || typeof c !== 'object' || Array.isArray(c) ||
          Object.keys(c).some(key => !['equipment', 'commands'].includes(key)) ||
          typeof c.equipment !== 'string' || !Object.hasOwn(HOME_COMMANDS, c.equipment) ||
          !Array.isArray(c.commands) || !c.commands.length || new Set(c.commands).size !== c.commands.length) throw invalid();
      const equipment = c.equipment as HomeEquipment;
      if (entity.entityId.split('.')[0] !== DOMAIN[equipment] ||
          c.commands.some(command => typeof command !== 'string' || !(HOME_COMMANDS[equipment] as readonly string[]).includes(command))) throw invalid();
      result.control = { equipment, commands: [...c.commands] as string[] };
    }
    return result;
  });
  return { enabled: raw.enabled, baseUrl: url.origin, tokenEnv, entities };
}
