/** Minimal JSON-over-HTTP client for the simulator's outbound posts. */

export async function postJson(base: string, path: string, body: unknown): Promise<void> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
}
