import type { Env } from "./env.ts";
import {
  AuthError,
  errorMessage,
  NetworkError,
  ServerError,
} from "./errors.ts";

export type Method = "GET" | "POST" | "DELETE";

export type Client = {
  serverUrl: string;
  /** Sends a request and throws a typed error unless the response is ok. */
  request(method: Method, path: string, body?: unknown): Promise<Response>;
  /** GETs a JSON endpoint, treating an HTML answer as a login page. */
  requestJson<T>(path: string): Promise<T>;
};

/** The part of `fetch` the client uses. Injectable so tests can fake the server. */
export type FetchFn = (
  url: string,
  init: { method: Method; headers: Record<string, string>; body?: string },
) => Promise<Response>;

export type ClientOptions = Env & {
  /** Defaults to the global `fetch`. */
  fetch?: FetchFn;
};

export function createClient(
  { serverUrl, token, fetch: fetchFn = fetch }: ClientOptions,
): Client {
  async function request(
    method: Method,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = serverUrl + path;
    let resp: Response;
    try {
      resp = await fetchFn(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "flow-token": token } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new NetworkError(url, errorMessage(error));
    }
    // An expired token may come back as a redirect to a login page rather
    // than a 401, so both count as auth problems.
    if (resp.status === 401 || resp.status === 403 || resp.redirected) {
      await resp.body?.cancel();
      throw new AuthError(serverUrl);
    }
    if (!resp.ok) {
      throw new ServerError(method, path, resp.status, await safeText(resp));
    }
    return resp;
  }

  async function requestJson<T>(path: string): Promise<T> {
    const resp = await request("GET", path);
    const text = await safeText(resp);
    if ((resp.headers.get("content-type") ?? "").includes("text/html")) {
      throw new AuthError(serverUrl);
    }
    try {
      return JSON.parse(text) as T;
    } catch (_) {
      throw new ServerError("GET", path, resp.status, text);
    }
  }

  return { serverUrl, request, requestJson };
}

async function safeText(resp: Response) {
  try {
    return await resp.text();
  } catch (_) {
    return "";
  }
}
