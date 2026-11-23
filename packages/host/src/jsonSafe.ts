/** Convert MessagePack int64 values before they reach JSON persistence or IPC. */
export function jsonSafeValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value.toString();
  }
  if (Array.isArray(value)) return value.map(jsonSafeValue);
  if (value && typeof value === 'object' && isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafeValue(item)]));
  }
  return value;
}

export function stringifyJsonSafe(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== 'bigint') return item;
    const number = Number(item);
    return Number.isSafeInteger(number) ? number : item.toString();
  }) ?? 'null';
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
