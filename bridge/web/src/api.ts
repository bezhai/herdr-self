const unauthorizedListeners = new Set<() => void>();

// Called on every 401 seen by request(). Returns an unsubscribe function.
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

// Raw call to /api: GET without a body, POST with a JSON body. Returns the fetch Response.
export function callApi(path: string, body?: unknown) {
  const headers = { 'Content-Type': 'application/json' };
  return fetch(`/api${path}`, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) });
}

// Request used by the console: notifies 401 listeners and throws the server's error message.
// T: what the caller reads of the answer; the JSON is not checked, so a caller that reads nothing leaves it unknown.
export async function request<T = unknown>(path: string, body?: unknown): Promise<T> {
  const response = await callApi(path, body);
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) unauthorizedListeners.forEach((listener) => listener());
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
