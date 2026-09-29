import { load } from "@std/dotenv";
import { join } from "@std/path";
import { ConfigError, tokenUrl } from "./errors.ts";

export type Env = {
  serverUrl: string;
  token: string;
};

/**
 * Reads and validates `.env` once per run. Values missing from `.env` fall
 * back to the process environment, which is handy in CI.
 */
export async function loadEnv(
  root = Deno.cwd(),
  { requireToken = true } = {},
): Promise<Env> {
  const file = await load({ envPath: join(root, ".env"), export: false });
  const get = (key: string) => file[key] || Deno.env.get(key) || "";

  let serverUrl = get("FLOW_SERVER_URL").trim();
  try {
    new URL(serverUrl);
  } catch (_) {
    throw new ConfigError(
      "Please edit the .env file to include a valid flow server url (FLOW_SERVER_URL).",
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
        "then set PATHIFY_TOKEN in .env",
      ].join("\n"),
    );
  }
  return { serverUrl, token };
}
