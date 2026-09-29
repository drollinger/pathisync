/** Base class for every error pathisync reports to the user. */
export class PathisyncError extends Error {
  override name = "PathisyncError";
}

/** A problem with `.env` or the command line, found before any request. */
export class ConfigError extends PathisyncError {
  override name = "ConfigError";
}

/** The token is missing, expired or invalid. Every later request would fail too. */
export class AuthError extends PathisyncError {
  override name = "AuthError";
  constructor(serverUrl: string) {
    super(
      [
        "Your Pathify token is missing, expired, or invalid.",
        "Generate a new one (while logged in) at:",
        `  ${tokenUrl(serverUrl)}`,
        "then update PATHIFY_TOKEN in .env",
      ].join("\n"),
    );
  }
}

/** `fetch` itself threw: DNS, VPN, TLS, connection refused. */
export class NetworkError extends PathisyncError {
  override name = "NetworkError";
  constructor(url: string, reason: string) {
    super(`Could not reach ${url}: ${reason} (check VPN/network)`);
  }
}

/** The server answered, but not with success. */
export class ServerError extends PathisyncError {
  override name = "ServerError";
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    const snippet = body.length > 500 ? body.slice(0, 500) + "…" : body;
    super(
      `${method} ${path} failed with status ${status}` +
        (snippet.trim() ? `\n${snippet.trim()}` : ""),
    );
  }
}

/** A local config file could not be read, parsed or rebuilt. */
export class LocalFileError extends PathisyncError {
  override name = "LocalFileError";
  constructor(readonly path: string, reason: string) {
    super(`${path}: ${reason}`);
  }
}

export const tokenUrl = (serverUrl: string) =>
  `${serverUrl}/auth/s2s/token/create`;

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
