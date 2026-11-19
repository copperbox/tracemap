/**
 * Composite map keys built from telemetry strings (service ids, operation
 * names, error codes and messages). Those strings can contain any character,
 * so joining them with a delimiter lets two different tuples collide. Here
 * every part but the last is prefixed with its length and a colon, which
 * makes the encoding reversible and so collision-free.
 */

/** Key for the pair (a, b). */
export function key2(a: string, b: string): string {
  return a.length + ':' + a + b;
}

/** Key for (a, b, c). */
export function key3(a: string, b: string, c: string): string {
  return a.length + ':' + a + b.length + ':' + b + c;
}

/** Key for any number of parts (not for the hot path). */
export function joinKey(parts: readonly string[]): string {
  let out = '';
  const last = parts.length - 1;
  for (let i = 0; i < last; i++) out += parts[i].length + ':' + parts[i];
  return last >= 0 ? out + parts[last] : out;
}

/** Inverse of key2(). */
export function splitKey2(key: string): [string, string] {
  const i = key.indexOf(':');
  const end = i + 1 + Number(key.slice(0, i));
  return [key.slice(i + 1, end), key.slice(end)];
}
