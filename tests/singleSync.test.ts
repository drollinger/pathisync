import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { SyncState } from "../src/state.ts";
import { runSync } from "../src/sync/engine.ts";
import { flows, sharedConfigs, triggers } from "../src/sync/single.ts";
import type { SyncOptions } from "../src/sync/types.ts";
import {
  type Answer,
  FakeServer,
  fileExists,
  flow,
  makeContext,
  makeProject,
  readJson,
  readText,
  SERVER_URL,
  sharedConfig,
  trigger,
  writeFiles,
} from "./helpers.ts";

const ALL = [flows, sharedConfigs, triggers];

async function sync(
  root: string,
  server: FakeServer,
  options: Partial<SyncOptions> = {},
  answers: Answer[] = [],
) {
  const ctx = makeContext(root, server, options, answers);
  await runSync(ctx, ALL);
  assertEquals(ctx.prompter.answers, [], "every scripted answer is used");
  return ctx;
}

/** A project in sync with the server, with the baseline recorded. */
async function syncedProject(...configs: ReturnType<typeof sharedConfig>[]) {
  const server = new FakeServer().put("sharedConfig", ...configs);
  const root = makeProject(
    Object.fromEntries(
      configs.map((c) => [`sharedConfigs/${c.referenceId}.json`, c]),
    ),
  );
  const ctx = await sync(root, server);
  assertEquals(ctx.prompter.prompts, []);
  server.calls = [];
  return { root, server };
}

const edited = (c: Record<string, unknown>, value: number) => ({
  ...c,
  config: { value },
});

Deno.test("in sync: records the baseline without prompting or writing", async () => {
  const { root, server } = await syncedProject(sharedConfig("a"));
  const state = SyncState.load(root, SERVER_URL);
  assert(state.get("sharedConfig:a")?.startsWith("sha256:"));
  assertEquals(server.writes(), []);
});

Deno.test("unknown (no baseline): prompts with a diff, as before", async () => {
  const server = new FakeServer().put("sharedConfig", sharedConfig("a"));
  const root = makeProject({
    "sharedConfigs/a.json": edited(sharedConfig("a"), 2),
  });
  const ctx = await sync(root, server, {}, ["pull"]);
  assertEquals(ctx.prompter.prompts[0].choices, [
    "Nothing",
    "Overwrite local shared config",
    "Push local shared config to flow.test",
    "Show full diff",
  ]);
  const text = ctx.out.text();
  assertStringIncludes(text, "There is a difference with the shared config a");
  assertStringIncludes(text, "--- remote (server)  a.json");
  assertStringIncludes(text, '-    "value": 1');
  assertStringIncludes(text, '+    "value": 2');
  assertEquals(readJson(root, "sharedConfigs/a.json").config, { value: 1 });
  // Now in sync, so the baseline is recorded.
  assert(SyncState.load(root, SERVER_URL).get("sharedConfig:a"));
});

Deno.test("unknown in watch mode: does nothing and says to run a normal sync", async () => {
  const server = new FakeServer().put("sharedConfig", sharedConfig("a"));
  const root = makeProject({
    "sharedConfigs/a.json": edited(sharedConfig("a"), 2),
  });
  const ctx = await sync(root, server, { mode: "watch" });
  assertEquals(server.writes(), []);
  assertStringIncludes(
    ctx.out.text(),
    "run a normal sync first".replace("run", "Run"),
  );
});

Deno.test("server changed: pulls without prompting, interactive and watch", async () => {
  for (const mode of ["interactive", "watch"] as const) {
    const { root, server } = await syncedProject(sharedConfig("a"));
    server.put("sharedConfig", edited(sharedConfig("a"), 5));
    const ctx = await sync(root, server, { mode });
    assertEquals(ctx.prompter.prompts, []);
    assertEquals(readJson(root, "sharedConfigs/a.json").config, { value: 5 });
    assertEquals(server.writes(), []);
    assertStringIncludes(ctx.out.text(), "server changed, pulling");
  }
});

Deno.test("server changed on 88 configs at once: all pulled, no prompts", async () => {
  const configs = Array.from({ length: 88 }, (_, i) => trigger(`t${i}`));
  const server = new FakeServer().put("flowTriggerers", ...configs);
  const root = makeProject(
    Object.fromEntries(
      configs.map((
        c,
      ) => [`triggers/${(c.config as { name: string }).name}.json`, c]),
    ),
  );
  await sync(root, server);
  for (const c of configs) {
    (c.config as Record<string, unknown>).useVirtualThreads = true;
    server.put("flowTriggerers", c);
  }
  const ctx = await sync(root, server);
  assertEquals(ctx.prompter.prompts, []);
  assertEquals(
    readJson(root, "triggers/t42.json").config.useVirtualThreads,
    true,
  );
});

Deno.test("local changed: interactive offers push; watch pushes", async () => {
  {
    const { root, server } = await syncedProject(sharedConfig("a"));
    writeFiles(root, { "sharedConfigs/a.json": edited(sharedConfig("a"), 3) });
    const ctx = await sync(root, server, {}, ["push"]);
    assertEquals(ctx.prompter.prompts[0].choices, [
      "Nothing",
      "Push local shared config to flow.test",
      "Show full diff",
    ]);
    assertEquals(server.get("sharedConfig", "a")!.config, { value: 3 });
  }
  {
    const { root, server } = await syncedProject(sharedConfig("a"));
    writeFiles(root, { "sharedConfigs/a.json": edited(sharedConfig("a"), 4) });
    const ctx = await sync(root, server, { mode: "watch" });
    assertEquals(server.get("sharedConfig", "a")!.config, { value: 4 });
    assertStringIncludes(ctx.out.text(), "✔ pushed shared config a");
  }
});

Deno.test("local changed with -l: not pushed and not overwritten", async () => {
  const { root, server } = await syncedProject(sharedConfig("a"));
  writeFiles(root, { "sharedConfigs/a.json": edited(sharedConfig("a"), 3) });
  const ctx = await sync(root, server, { preferServer: true });
  assertEquals(server.writes(), []);
  assertEquals(readJson(root, "sharedConfigs/a.json").config, { value: 3 });
  assertStringIncludes(ctx.out.text(), "not pushed (-l)");
});

Deno.test("conflict: interactive shows a diff and offers both sides", async () => {
  const { root, server } = await syncedProject(sharedConfig("a"));
  writeFiles(root, { "sharedConfigs/a.json": edited(sharedConfig("a"), 3) });
  server.put("sharedConfig", edited(sharedConfig("a"), 9));
  const ctx = await sync(root, server, {}, ["show-diff", "nothing"]);
  assertEquals(ctx.prompter.prompts.map((p) => p.message), [
    "What do you want to do?",
    "<pager>",
    "What do you want to do?",
  ]);
  assertStringIncludes(
    ctx.out.text(),
    "changed both locally and on the server",
  );
  assertStringIncludes(ctx.out.text(), '+    "value": 3');
  assertEquals(server.writes(), []);
});

Deno.test("conflict with -l: takes the server side", async () => {
  const { root, server } = await syncedProject(sharedConfig("a"));
  writeFiles(root, { "sharedConfigs/a.json": edited(sharedConfig("a"), 3) });
  server.put("sharedConfig", edited(sharedConfig("a"), 9));
  await sync(root, server, { preferServer: true });
  assertEquals(readJson(root, "sharedConfigs/a.json").config, { value: 9 });
});

Deno.test("conflict in watch mode: never pushes, warns with a diff", async () => {
  const { root, server } = await syncedProject(sharedConfig("a"));
  writeFiles(root, { "sharedConfigs/a.json": edited(sharedConfig("a"), 3) });
  server.put("sharedConfig", edited(sharedConfig("a"), 9));
  const ctx = await sync(root, server, { mode: "watch" });
  assertEquals(server.writes(), []);
  assertStringIncludes(ctx.out.text(), "✖ conflict on shared config a");
  assertStringIncludes(ctx.out.text(), '-    "value": 9');
});

Deno.test("new local: offers push (and delete with -d); watch does nothing", async () => {
  const server = new FakeServer();
  const root = makeProject({ "sharedConfigs/new.json": sharedConfig("new") });
  let ctx = await sync(root, server, { allowDelete: true }, ["push"]);
  assertEquals(ctx.prompter.prompts[0].choices, [
    "Nothing",
    "Push new shared config to flow.test",
    "Delete local shared config",
    "Show full diff",
  ]);
  assert(server.get("sharedConfig", "new"));

  const root2 = makeProject({ "sharedConfigs/new.json": sharedConfig("new") });
  ctx = await sync(root2, new FakeServer(), { mode: "watch" });
  assertEquals(ctx.prompter.prompts, []);
});

Deno.test("deleted on server: offers delete local only with -d", async () => {
  const { root, server } = await syncedProject(sharedConfig("a"));
  server.data.get("sharedConfig")!.delete("a");
  let ctx = await sync(root, server);
  assertEquals(ctx.prompter.prompts, []);
  assertStringIncludes(
    ctx.out.text(),
    "was deleted on the server since the last sync",
  );
  assert(fileExists(root, "sharedConfigs/a.json"));

  ctx = await sync(root, server, { mode: "watch" });
  assert(fileExists(root, "sharedConfigs/a.json"));

  ctx = await sync(root, server, { allowDelete: true }, ["delete-local"]);
  assertFalse(fileExists(root, "sharedConfigs/a.json"));
  assertEquals(
    SyncState.load(root, SERVER_URL).get("sharedConfig:a"),
    undefined,
  );
});

Deno.test("deleted on server but edited locally: warns and offers to re-create", async () => {
  const { root, server } = await syncedProject(sharedConfig("a"));
  server.data.get("sharedConfig")!.delete("a");
  writeFiles(root, { "sharedConfigs/a.json": edited(sharedConfig("a"), 7) });
  const ctx = await sync(root, server, {}, ["push"]);
  assertStringIncludes(
    ctx.out.text(),
    "was deleted on the server, but was edited locally",
  );
  assertEquals(server.get("sharedConfig", "a")!.config, { value: 7 });
  const watch = await sync(root, server, { mode: "watch" });
  assertEquals(watch.prompter.prompts, []);
});

Deno.test("new on server: creates local with a folder prompt, or the default with -lf", async () => {
  const server = new FakeServer().put("sharedConfig", sharedConfig("fresh"));
  const root = makeProject({
    "sharedConfigs/sub/other.json": sharedConfig("other"),
  });
  server.put("sharedConfig", sharedConfig("other"));
  const ctx = await sync(root, server, {}, [
    "create-local",
    "<New Folder>",
    "made",
  ]);
  assertEquals(ctx.prompter.prompts[1].choices, [".", "sub", "<New Folder>"]);
  assertEquals(
    readJson(root, "sharedConfigs/made/fresh.json").referenceId,
    "fresh",
  );

  const root2 = makeProject();
  await sync(root2, server, { preferServer: true, forceDefaultFolder: true });
  assert(fileExists(root2, "sharedConfigs/fresh.json"));

  const root3 = makeProject();
  const watch = await sync(root3, server, { mode: "watch" });
  assertEquals(watch.prompter.prompts, []);
  assertFalse(fileExists(root3, "sharedConfigs/fresh.json"));
});

Deno.test("deleted locally: offers delete remote only with -d", async () => {
  const { root, server } = await syncedProject(sharedConfig("a"));
  Deno.removeSync(join(root, "sharedConfigs/a.json"));
  let ctx = await sync(root, server, {}, ["nothing"]);
  assertEquals(ctx.prompter.prompts[0].choices, [
    "Nothing",
    "Create new local shared config",
    "Show full diff",
  ]);
  ctx = await sync(root, server, { mode: "watch" });
  assertEquals(server.writes(), []);
  ctx = await sync(root, server, { allowDelete: true }, ["delete-remote"]);
  assertEquals(server.writes(), [{
    method: "DELETE",
    path: "/repository/sharedConfig/a",
    body: undefined,
  }]);
  assertEquals(
    SyncState.load(root, SERVER_URL).get("sharedConfig:a"),
    undefined,
  );
});

Deno.test("deleted locally but edited on server: warns and offers re-create", async () => {
  const { root, server } = await syncedProject(sharedConfig("a"));
  Deno.removeSync(join(root, "sharedConfigs/a.json"));
  server.put("sharedConfig", edited(sharedConfig("a"), 8));
  const ctx = await sync(root, server, {}, ["create-local", "."]);
  assertStringIncludes(
    ctx.out.text(),
    "was deleted locally, but changed on the server",
  );
  assertEquals(readJson(root, "sharedConfigs/a.json").config, { value: 8 });
});

Deno.test("re-fetch after push records the server's normalized form", async () => {
  const { root, server } = await syncedProject(sharedConfig("a"));
  server.normalize = (_e, obj) => ({ ...obj, addedDefault: true });
  writeFiles(root, { "sharedConfigs/a.json": edited(sharedConfig("a"), 3) });
  const ctx = await sync(root, server, {}, ["push"]);
  assertStringIncludes(ctx.out.text(), "The server normalized shared config a");
  assertEquals(readJson(root, "sharedConfigs/a.json").addedDefault, true);
  server.calls = [];
  const next = await sync(root, server);
  assertEquals(next.prompter.prompts, []);
  assertEquals(server.writes(), []);
  assertFalse(next.out.text().includes("server changed"));
});

Deno.test("deleting state.json returns to two-way prompting, with no errors", async () => {
  const { root, server } = await syncedProject(sharedConfig("a"));
  Deno.removeSync(SyncState.path(root));
  writeFiles(root, { "sharedConfigs/a.json": edited(sharedConfig("a"), 3) });
  const ctx = await sync(root, server, {}, ["nothing"]);
  assertStringIncludes(ctx.out.text(), "There is a difference");
});

Deno.test("changing FLOW_SERVER_URL invalidates the record", async () => {
  const { root } = await syncedProject(sharedConfig("a"));
  assert(SyncState.load(root, SERVER_URL).get("sharedConfig:a"));
  assertEquals(
    SyncState.load(root, "https://other.test").get("sharedConfig:a"),
    undefined,
  );
});

Deno.test("each server keeps its own record, and a version 1 record is kept", () => {
  const root = makeProject({
    ".pathisync/state.json": {
      version: 1,
      server: SERVER_URL,
      entries: { "sharedConfig:a": "old" },
    },
  });
  assertEquals(SyncState.load(root, SERVER_URL).get("sharedConfig:a"), "old");
  const other = SyncState.load(root, "https://other.test");
  other.set("sharedConfig:b", "new");
  other.save();
  assertEquals(readJson(root, ".pathisync/state.json"), {
    version: 2,
    servers: {
      [SERVER_URL]: { "sharedConfig:a": "old" },
      "https://other.test": { "sharedConfig:b": "new" },
    },
  });
  assertEquals(
    SyncState.load(root, SERVER_URL).get("sharedConfig:b"),
    undefined,
  );
});

Deno.test("flows: pull writes the .json and .js; editing the .js pushes inline code", async () => {
  const remote = flow("f@x");
  const server = new FakeServer().put("flows", remote);
  const root = makeProject();
  await sync(root, server, { preferServer: true, forceDefaultFolder: true });
  assertEquals(
    readJson(root, "flows/@x/f/flow.json").processors.transform.config.jsFunc,
    {
      $fn: "transform_jsFunc",
    },
  );
  assertEquals(
    readText(root, "flows/@x/f/processors.js"),
    "export function transform_jsFunc() {\n\n  return item;\n\n}\n",
  );

  writeFiles(root, {
    "flows/@x/f/processors.js":
      "export function transform_jsFunc() {\n\n  return item.id;\n\n}\n",
  });
  server.calls = [];
  const ctx = await sync(root, server, { mode: "watch" });
  const pushed = server.writes()[0].body as ReturnType<typeof flow>;
  assertEquals(
    (pushed.processors as Record<string, { config: { jsFunc: string } }>)
      .transform.config.jsFunc,
    "\nreturn item.id;\n",
  );
  assertStringIncludes(
    ctx.out.text(),
    "✔ pushed flow f@x (1 functions changed)",
  );
});

Deno.test("flows: a stale .js is deleted when the flow has no JavaScript left", async () => {
  const server = new FakeServer().put("flows", flow("f"));
  const root = makeProject();
  await sync(root, server, { preferServer: true, forceDefaultFolder: true });
  assert(fileExists(root, "flows/f/processors.js"));
  const noJs = flow("f");
  (noJs.processors as Record<string, { config: Record<string, unknown> }>)
    .transform.config.jsFunc = null;
  server.put("flows", noJs);
  await sync(root, server);
  assertFalse(fileExists(root, "flows/f/processors.js"));
});

Deno.test("flows: deleting local removes the .js too", async () => {
  const root = makeProject();
  const server = new FakeServer().put("flows", flow("f"));
  await sync(root, server, { preferServer: true, forceDefaultFolder: true });
  server.data.get("flows")!.clear();
  await sync(root, server, { allowDelete: true }, ["delete-local"]);
  assertFalse(fileExists(root, "flows/f"), "the emptied folder is removed");
});

Deno.test("flows: a broken .js is reported and skipped; other flows still sync", async () => {
  const server = new FakeServer().put("flows", flow("good"), flow("bad"));
  const root = makeProject();
  await sync(root, server, { preferServer: true, forceDefaultFolder: true });
  writeFiles(root, { "flows/bad/processors.js": "stray text\n" });
  server.put("flows", { ...flow("good"), description: "changed" });
  const ctx = await sync(root, server);
  assertStringIncludes(ctx.out.text(), "✖ skipped flows/bad/flow.json");
  assertEquals(readJson(root, "flows/good/flow.json").description, "changed");
  assertEquals(ctx.failures.length, 1);
});

Deno.test("volatile flow ids and server metadata are ignored", async () => {
  const withIds = flow("f");
  const processors = withIds.processors as Record<
    string,
    { config: Record<string, unknown> }
  >;
  processors.transform.config.userFetchProviderWhenUsingClaims = {
    id: "123",
    x: 1,
  };
  processors.transform.config.testConfig = [{ id: "abc", name: null }];
  const server = new FakeServer().put("flows", withIds);
  const root = makeProject();
  await sync(root, server, { preferServer: true, forceDefaultFolder: true });
  const local = readJson(root, "flows/f/flow.json");
  assertEquals(local.metadata, undefined);
  assertEquals(
    local.processors.transform.config.userFetchProviderWhenUsingClaims,
    { x: 1 },
  );
  processors.transform.config.userFetchProviderWhenUsingClaims = {
    id: "456",
    x: 1,
  };
  server.put("flows", withIds);
  const ctx = await sync(root, server);
  assertEquals(ctx.prompter.prompts, []);
  assertFalse(ctx.out.text().includes("pulling"));
});

Deno.test("non-JSON files don't crash the sync or show up as configs", async () => {
  const server = new FakeServer().put("flows", flow("f"));
  const root = makeProject();
  await sync(root, server, { preferServer: true, forceDefaultFolder: true });
  writeFiles(root, {
    "flows/.DS_Store": "\u0000\u0001binary",
    "flows/f/.flow.json.swp": "junk",
    "flows/f/notes.txt": "hi",
  });
  const ctx = await sync(root, server);
  assertEquals(ctx.prompter.prompts, []);
  assertEquals(ctx.failures, []);
});

Deno.test("a failed push shows status and body, the sync continues, and it's counted", async () => {
  const server = new FakeServer();
  server.failures.set("POST /repository/sharedConfig", {
    status: 500,
    body: "boom: database locked",
  });
  const root = makeProject({
    "sharedConfigs/a.json": sharedConfig("a"),
    "triggers/t.json": trigger("t"),
  });
  const ctx = await sync(root, server, {}, ["push", "push"]);
  assertStringIncludes(
    ctx.out.text(),
    "POST /repository/sharedConfig failed with status 500",
  );
  assertStringIncludes(ctx.out.text(), "boom: database locked");
  assert(
    server.get("flowTriggerers", "t"),
    "the trigger push after the failure still happens",
  );
  assertEquals(ctx.failures.length, 1);
});

Deno.test("201 and 204 responses count as success", async () => {
  for (const status of [201, 204]) {
    const server = new FakeServer();
    const inner = server.fetch;
    server.fetch = async (input, init) => {
      const resp = await inner(input, init);
      return init.method === "POST" ? new Response(null, { status }) : resp;
    };
    const root = makeProject({ "sharedConfigs/a.json": sharedConfig("a") });
    const ctx = await sync(root, server, {}, ["push"]);
    assertEquals(ctx.failures, []);
  }
});
