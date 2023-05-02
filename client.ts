import { load } from "https://deno.land/std@0.184.0/dotenv/mod.ts";

const env = await load();

export default function pathifyFetch(
  path: RequestInfo,
  options?: RequestInit,
): Promise<Response> {
  const headers = {
    "Content-Type": "application/json",
    "flow-token": env["PATHIFY_TOKEN"],
    ...options?.headers,
  };
  return fetch(env["FLOW_SERVER_URL"] + path, {
    ...options,
    headers,
  });
}
