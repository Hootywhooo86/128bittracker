// Web transport: the browser talks to the Tracker server over HTTP.
// The Android build swaps this file for one that runs the API on-device.
export const platform = 'web';

export async function request(method, path, body) {
  const res = await fetch('/api/v1' + path, {
    method,
    headers: { 'x-128bit-client': 'web', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (res.status === 204) return { status: 204, data: null };
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
