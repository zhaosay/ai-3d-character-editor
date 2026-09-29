export const REQUEST_TIMEOUT_MS = 120_000;

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  const clearTimeoutOnBodyRead = (response: Response) => {
    const json = typeof response.json === 'function' ? response.json.bind(response) : undefined;
    const text = typeof response.text === 'function' ? response.text.bind(response) : undefined;
    return new Proxy(response, {
      get(target, property) {
        if (property === 'json' && json) return async () => {
          try { return await json(); }
          finally { clearTimeout(timeout); }
        };
        if (property === 'text' && text) return async () => {
          try { return await text(); }
          finally { clearTimeout(timeout); }
        };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return clearTimeoutOnBodyRead(response);
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

export function isRequestTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
