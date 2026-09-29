import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { main } from "../main.ts";
import { createClient, type FetchFn } from "../src/client.ts";
import { loadEnv } from "../src/env.ts";
import {
  AuthError,
  ConfigError,
  NetworkError,
  ServerError,
} from "../src/errors.ts";
import {
  CaptureOutput,
  FakeServer,
  makeProject,
  ScriptedPrompter,
  sharedConfig,
} from "./helpers.ts";

const client = (fetch: FetchFn) =>
  createClient({ serverUrl: "https://flow.example.edu", token: "t", fetch });

const respond =
  (body: string, init: ResponseInit = {}, redirected = false): FetchFn =>
  () => {
    const resp = new Response(body, init);
    if (redirected) Object.defineProperty(resp, "redirected", { value: true });
    return Promise.resolve(resp);
  };

Deno.test("401, 403, a redirect and an HTML login page are all auth errors", async () => {
  for (
    const fetch of [
      respond("", { status: 401 }),
      respond("", { status: 403 }),
      respond("[]", { headers: { "content-type": "application/json" } }, true),
      respond("<html>Login</html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    ]
  ) {
    const error = await assertRejects(
      () => client(fetch).requestJson("/repository/flows"),
      AuthError,
    );
    assertStringIncludes(
      error.message,
      "https://flow.example.edu/auth/s2s/token/create",
    );
    assertStringIncludes(error.message, "update PATHIFY_TOKEN in .env");
  }
});

Deno.test("a thrown fetch is a network error, not a token problem", async () => {
  const error = await assertRejects(
    () =>
      client(() => Promise.reject(new TypeError("dns error"))).requestJson(
        "/repository/flows",
      ),
    NetworkError,
  );
  assertEquals(
    error.message,
    "Could not reach https://flow.example.edu/repository/flows: dns error (check VPN/network)",
  );
});

Deno.test("server errors show method, path, status and the start of the body", async () => {
  const error = await assertRejects(
    () =>
      client(respond("x".repeat(600), { status: 500 })).request(
        "POST",
        "/repository/flows",
        {},
      ),
    ServerError,
  );
  assertStringIncludes(
    error.message,
    "POST /repository/flows failed with status 500",
  );
  assertStringIncludes(error.message, "x".repeat(500) + "…");
});

Deno.test("201 and 204 are success", async () => {
  await client(respond("", { status: 201 })).request("POST", "/x", {});
  await client(respond(null as unknown as string, { status: 204 })).request(
    "DELETE",
    "/x",
  );
});

Deno.test("the token and JSON content type are sent", async () => {
  let seen: Parameters<FetchFn>[1] | undefined;
  await client((_url, init) => {
    seen = init;
    return Promise.resolve(
      new Response("[]", { headers: { "content-type": "application/json" } }),
    );
  }).requestJson("/repository/flows");
  assertEquals(seen?.headers, {
    "Content-Type": "application/json",
    "flow-token": "t",
  });
});

Deno.test(".env: an empty token or invalid URL fails before any request", async () => {
  const empty = makeProject({
    ".env": "PATHIFY_TOKEN=\nFLOW_SERVER_URL=https://flow.test/\n",
  });
  const error = await assertRejects(() => loadEnv(empty), ConfigError);
  assertStringIncludes(
    error.message,
    "https://flow.test/auth/s2s/token/create",
  );
  const placeholder = makeProject({
    ".env": "PATHIFY_TOKEN=x\nFLOW_SERVER_URL=https://<your.flow.server>\n",
  });
  await assertRejects(
    () => loadEnv(placeholder),
    ConfigError,
    "valid flow server url",
  );
  const ok = makeProject({
    ".env": "PATHIFY_TOKEN=x\nFLOW_SERVER_URL=https://flow.test/\n",
  });
  assertEquals(await loadEnv(ok), {
    serverUrl: "https://flow.test",
    token: "x",
  });

  const server = new FakeServer();
  const out = new CaptureOutput();
  const code = await main([], {
    root: empty,
    fetch: server.fetch,
    out,
    prompter: new ScriptedPrompter(),
  });
  assertEquals(code, 1);
  assertEquals(server.calls, []);
});

Deno.test("an auth error stops the whole sync with exit code 1", async () => {
  const server = new FakeServer();
  server.failures.set("GET /repository/flows", { status: 401, body: "" });
  const out = new CaptureOutput();
  const root = makeProject({ "sharedConfigs/a.json": sharedConfig("a") });
  const code = await main([], {
    root,
    fetch: server.fetch,
    out,
    prompter: new ScriptedPrompter(),
  });
  assertEquals(code, 1);
  assertStringIncludes(
    out.text(),
    "Your Pathify token is missing, expired, or invalid.",
  );
  assertEquals(server.configCalls().length, 1);
});

Deno.test("an auth error during a push stops the run", async () => {
  const server = new FakeServer();
  server.failures.set("POST /repository/sharedConfig", {
    status: 401,
    body: "",
  });
  const out = new CaptureOutput();
  const root = makeProject({
    "sharedConfigs/a.json": sharedConfig("a"),
    "sharedConfigs/b.json": sharedConfig("b"),
  });
  const prompter = new ScriptedPrompter(["push", "push"]);
  const code = await main([], { root, fetch: server.fetch, out, prompter });
  assertEquals(code, 1);
  assertEquals(server.writes().length, 1);
});

Deno.test("a leading -- is ignored and unknown options are rejected", async () => {
  const server = new FakeServer();
  const root = makeProject();
  const out = new CaptureOutput();
  assertEquals(await main(["--", "--help"], { root, out }), 0);
  assertStringIncludes(out.text(), "Usage:");
  assertEquals(
    await main(["--whatch=flows"], { root, out, fetch: server.fetch }),
    1,
  );
  assertStringIncludes(out.text(), "Unknown option --whatch=flows");
});
