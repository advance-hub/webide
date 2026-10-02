export class APIError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function request<T>(path: string, payload?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: payload === undefined ? {} : { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new APIError(data.error || '请求失败，请重试', res.status);
  }
  return data;
}
