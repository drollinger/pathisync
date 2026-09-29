import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { ConfigError } from "../src/errors.ts";
import { ADAPTERS, runSync } from "../src/sync/engine.ts";
import { resolveTargets } from "../src/targets.ts";
import { startWatch, syncChangedFiles } from "../src/watch.ts";
import {
  collection,
  FakeServer,
  flow,
  localCollection,
  makeContext,
  makeProject,
  readJson,
  sharedConfig,
  trigger,
} from "./helpers.ts";

/** A project in sync with the server (baseline recorded), in watch mode. */
async function watchedProject() {
  const remoteCollection = collection("c", [{
    id: "r",
    path: "/a.html",
    content: "A",
  }]);
  const server = new FakeServer()
    .put("flows", flow("f@w"), flow("g@w"))
    .put("sharedConfig", sharedConfig("s"))
    .put(
      "flowTriggerers",
      trigger("t"),
      trigger("tf", { orchestratorName: "f@w" }),
    )
    .put("resourceCollections", remoteCollection);
  const root = makeProject({
    "sharedConfigs/s.json": sharedConfig("s"),
    "triggers/t.json": trigger("t"),
    "resources/c/_collection.json": localCollection(remoteCollection),
    "resources/c/a.html": "A",
  });
  const setup = makeContext(root, server, {
    preferServer: true,
    forceDefaultFolder: true,
  });
  await runSync(setup);
  server.calls = [];
  return { root, server, ctx: makeContext(root, server, { mode: "watch" }) };
}

const editJs = (root: string, name: string, code: string) =>
  Deno.writeTextFileSync(
    join(root, `flows/@w/${name}/processors.js`),
    `export function transform_jsFunc() {\n  ${code}\n}\n`,
  );

Deno.test("targets: a flow's folder covers the flow and its triggers; directories cover everything below", async () => {
  const { root, ctx } = await watchedProject();
  const one = resolveTargets(ctx, ADAPTERS, ["flows/@w/f/processors.js"]);
  assertEquals(
    one.describe(),
    "1 flow (f@w: flow.json + processors.js + 1 trigger)",
  );
  assertEquals([...one.scope.ids.get("flows")!], ["f@w"]);
  assertEquals([...one.scope.ids.get("triggers")!], ["tf"]);
  assertEquals(one.covers("flows/@w/f/flow.json"), true);
  assertEquals(one.covers("flows/@w/f/tf.trigger.json"), true);
  assertEquals(one.covers("flows/@w/g/processors.js"), false);
  assertEquals(one.roots, [{
    path: join(root, "flows/@w/f"),
    recursive: false,
  }]);
  assertEquals(
    resolveTargets(ctx, ADAPTERS, ["flows/@w/f"]).describe(),
    one.describe(),
  );

  const namespace = resolveTargets(ctx, ADAPTERS, ["flows/@w"]);
  assertEquals([...namespace.scope.ids.get("flows")!].sort(), ["f@w", "g@w"]);
  assertEquals([...namespace.scope.ids.get("triggers")!], ["tf"]);

  const all = resolveTargets(ctx, ADAPTERS, [
    "flows",
    "triggers",
    "sharedConfigs",
    "resources",
  ]);
  assertEquals(all.scope.ids.get("flows"), null);
  const resource = resolveTargets(ctx, ADAPTERS, ["resources/c/a.html"]);
  assertEquals(resource.describe(), "collection c (resources/c)");
  assertThrows(() => resolveTargets(ctx, ADAPTERS, ["."]), ConfigError);
  assertThrows(
    () => resolveTargets(ctx, ADAPTERS, ["flows/@w/nope/flow.json"]),
    ConfigError,
  );
});

Deno.test("saving a flow's .js pushes that flow, and only that flow", async () => {
  const { root, server, ctx } = await watchedProject();
  const targets = resolveTargets(ctx, ADAPTERS, ["flows"]);
  editJs(root, "f", "return 42;");
  await syncChangedFiles(ctx, ADAPTERS, targets, [
    join(root, "flows/@w/f/processors.js"),
  ]);
  assertEquals(server.writes().map((c) => (c.body as { name: string }).name), [
    "f@w",
  ]);
  assertStringIncludes(
    ctx.out.text(),
    "✔ pushed flow f@w (1 functions changed)",
  );
});

Deno.test("saving a trigger in a flow's folder pushes the trigger", async () => {
  const { root, server, ctx } = await watchedProject();
  const targets = resolveTargets(ctx, ADAPTERS, ["flows/@w/f"]);
  const path = join(root, "flows/@w/f/tf.trigger.json");
  Deno.writeTextFileSync(
    path,
    JSON.stringify(trigger("tf", { orchestratorName: "f@w", path: "/new" })),
  );
  await syncChangedFiles(ctx, ADAPTERS, targets, [path]);
  assertEquals(server.writes().map((c) => c.path), [
    "/repository/flowTriggerers",
  ]);
});

Deno.test("files pathisync wrote itself, deleted files and uncovered files are ignored", async () => {
  const { root, server, ctx } = await watchedProject();
  const targets = resolveTargets(ctx, ADAPTERS, ["flows/@w/f/flow.json"]);
  // Written by the setup sync: an own write.
  assertEquals(
    await syncChangedFiles(ctx, ADAPTERS, targets, [
      join(root, "flows/@w/f/flow.json"),
    ]),
    false,
  );
  Deno.removeSync(join(root, "flows/@w/f/processors.js"));
  assertEquals(
    await syncChangedFiles(ctx, ADAPTERS, targets, [
      join(root, "flows/@w/f/processors.js"),
    ]),
    false,
  );
  editJs(root, "g", "return 1;");
  assertEquals(
    await syncChangedFiles(ctx, ADAPTERS, targets, [
      join(root, "flows/@w/g/processors.js"),
    ]),
    false,
  );
  assertEquals(server.calls, []);
});

Deno.test("--watch on a directory works for every config type", async () => {
  const { root, server, ctx } = await watchedProject();
  const targets = resolveTargets(ctx, ADAPTERS, [
    "triggers",
    "sharedConfigs",
    "resources",
  ]);
  Deno.writeTextFileSync(
    join(root, "triggers/t.json"),
    JSON.stringify(trigger("t", { path: "/new" })),
  );
  Deno.writeTextFileSync(
    join(root, "sharedConfigs/s.json"),
    JSON.stringify(sharedConfig("s", { config: { v: 2 } })),
  );
  Deno.writeTextFileSync(join(root, "resources/c/a.html"), "B");
  await syncChangedFiles(ctx, ADAPTERS, targets, [
    join(root, "triggers/t.json"),
    join(root, "sharedConfigs/s.json"),
    join(root, "resources/c/a.html"),
  ]);
  assertEquals(server.writes().map((c) => c.path).sort(), [
    "/repository/flowTriggerers",
    "/repository/resourceCollections",
    "/repository/sharedConfig",
  ]);
});

Deno.test("a server change made while watching gives a conflict warning and no push", async () => {
  const { root, server, ctx } = await watchedProject();
  const targets = resolveTargets(ctx, ADAPTERS, ["flows/@w/f/flow.json"]);
  server.put("flows", {
    ...flow("f@w"),
    description: "edited in the Pathify UI",
  });
  editJs(root, "f", "return 1;");
  await syncChangedFiles(ctx, ADAPTERS, targets, [
    join(root, "flows/@w/f/processors.js"),
  ]);
  assertEquals(server.writes(), []);
  assertStringIncludes(ctx.out.text(), "✖ conflict on flow f@w");
  assertStringIncludes(ctx.out.text(), "edited in the Pathify UI");
});

// These use the real file watcher, so they wait for events to arrive.

async function waitFor(check: () => boolean, ms = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

const settle = () => new Promise((r) => setTimeout(r, 1500));

Deno.test({
  name: "an atomic save (temp file + rename) triggers exactly one sync",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { root, server, ctx } = await watchedProject();
    const targets = resolveTargets(ctx, ADAPTERS, ["flows/@w/f/flow.json"]);
    const handle = startWatch(ctx, ADAPTERS, targets);
    await new Promise((r) => setTimeout(r, 300));
    // What editors like Neovim (backupcopy=no) do.
    const temp = join(root, "flows/@w/f/.processors.js.swp");
    Deno.writeTextFileSync(
      temp,
      "export function transform_jsFunc() {\n  return 'atomic';\n}\n",
    );
    Deno.renameSync(temp, join(root, "flows/@w/f/processors.js"));
    const pushed = await waitFor(() => server.writes().length > 0);
    await settle();
    handle.close();
    await handle.closed;
    assertEquals(pushed, true);
    assertEquals(server.writes().length, 1);
    assertEquals(
      server.calls.filter((c) =>
        c.method === "GET" && c.path === "/repository/flows"
      ).length,
      2,
    ); // sync + re-fetch
  },
});

Deno.test({
  name:
    "a pull made by watch mode doesn't trigger another sync; deleting pushes nothing",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { root, server, ctx } = await watchedProject();
    const targets = resolveTargets(ctx, ADAPTERS, ["flows"]);
    const handle = startWatch(ctx, ADAPTERS, targets);
    await new Promise((r) => setTimeout(r, 300));
    // f@w changed on the server. Re-saving its .json (same content, other
    // formatting) syncs it, which pulls and rewrites both of its files. Those
    // writes must not start another sync.
    server.put("flows", { ...flow("f@w"), description: "server" });
    Deno.writeTextFileSync(join(root, "flows/unrelated.txt"), "x");
    Deno.writeTextFileSync(
      join(root, "flows/@w/f/flow.json"),
      JSON.stringify(readJson(root, "flows/@w/f/flow.json"), null, 1),
    );
    await waitFor(() =>
      readJson(root, "flows/@w/f/flow.json").description === "server"
    );
    await settle();
    const gets = server.calls.filter((c) => c.method === "GET").length;
    Deno.removeSync(join(root, "flows/@w/g/flow.json"));
    await settle();
    handle.close();
    await handle.closed;
    assertEquals(readJson(root, "flows/@w/f/flow.json").description, "server");
    assertEquals(gets, 1);
    assertEquals(server.writes(), []);
  },
});
