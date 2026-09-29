import { load } from "@std/dotenv";
import { resolve } from "@std/path";
import { ConfigError, tokenUrl } from "./errors.ts";

export const DEFAULT_ENV_FILE = ".env";

export type Env = {
  serverUrl: string;
  token: string;
  /**
   * A FLOW_SERVER_URL in the process environment that the env file overrode,
   * when the two differ. Usually `--env-file` placed before the script name,
   * where Deno loads it instead of pathisync.
   */
  ignoredServerUrl?: string;
};

/**
 * Reads and validates the env file (`.env` unless `file` is given) once per
 * run. Values missing from the file fall back to the process environment,
 * which is handy in CI.
 */
export async function loadEnv(
  root = Deno.cwd(),
  { requireToken = true, file = DEFAULT_ENV_FILE } = {},
): Promise<Env> {
  const values = await load({ envPath: resolve(root, file), export: false });
  const get = (key: string) => values[key] || Deno.env.get(key) || "";

  let serverUrl = get("FLOW_SERVER_URL").trim();
  try {
    new URL(serverUrl);
  } catch (_) {
    throw new ConfigError(
      `Please edit ${file} to include a valid flow server url (FLOW_SERVER_URL).`,
    );
  }
  serverUrl = serverUrl.replace(/\/+$/, "");

  const token = get("PATHIFY_TOKEN").trim();
  if (!token && requireToken) {
    throw new ConfigError(
      [
        "PATHIFY_TOKEN is empty.",
        "Generate a token (while logged in) at:",
        `  ${tokenUrl(serverUrl)}`,
        `then set PATHIFY_TOKEN in ${file}`,
      ].join("\n"),
    );
  }

  const processUrl = Deno.env.get("FLOW_SERVER_URL")?.trim().replace(
    /\/+$/,
    "",
  );
  return values.FLOW_SERVER_URL && processUrl && processUrl !== serverUrl
    ? { serverUrl, token, ignoredServerUrl: processUrl }
    : { serverUrl, token };
}

/**
 * True if `file` is in a git repository and git doesn't ignore it (including
 * when it's tracked). False outside a repository or without git.
 */
export async function isExposedToGit(
  root: string,
  file: string,
): Promise<boolean> {
  try {
    // Exits 0 when ignored, 1 when not, 128 outside a repository.
    const { code } = await new Deno.Command("git", {
      args: ["check-ignore", "-q", "--", resolve(root, file)],
      cwd: root,
      stdout: "null",
      stderr: "null",
    }).output();
    return code === 1;
  } catch (_) {
    return false; // git not installed
  }
}
