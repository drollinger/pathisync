import { load } from "https://deno.land/std@0.220.1/dotenv/mod.ts";

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
  let flowUrl = env["FLOW_SERVER_URL"];
  try {
    new URL(flowUrl);
    if (flowUrl.endsWith("/")) flowUrl = flowUrl.slice(0, -1);
  } catch (_) {
    console.log(
      "Please edit the .env file to include a valid flow server url.",
    );
    Deno.exit(1);
  }
  return fetch(flowUrl + path, {
    ...options,
    headers,
  });
}
