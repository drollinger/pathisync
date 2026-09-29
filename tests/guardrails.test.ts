import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { bundleOf, guardFor, isBundled } from "../src/guardrails.ts";
import { runSync } from "../src/sync/engine.ts";
import { resources } from "../src/sync/resources.ts";
import { flows, sharedConfigs, triggers } from "../src/sync/single.ts";
import type { SyncOptions } from "../src/sync/types.ts";
import {
  type Answer,
  collection,
  FakeServer,
  flow,
  localCollection,
  makeContext,
  makeProject,
  sharedConfig,
  trigger,
} from "./helpers.ts";

const ALL = [flows, sharedConfigs, triggers, resources];

async function sync(
  root: string,
  server: FakeServer,
  options: Partial<SyncOptions> = {},
  answers: Answer[] = [],
) {
  const ctx = makeContext(root, server, options, answers);
  await runSync(ctx, ALL);
  assertEquals(ctx.prompter.answers, []);
  return ctx;
}

Deno.test("bundle lives in a different place per type", () => {
  assertEquals(bundleOf("flow", { bundle: "b1" }), "b1");
  assertEquals(bundleOf("sharedConfig", { bundle: "b2" }), "b2");
  assertEquals(bundleOf("resourceCollection", { bundle: "b3" }), "b3");
  assertEquals(bundleOf("trigger", { config: { bundle: "b4" } }), "b4");
  assertEquals(
    bundleOf("trigger", { bundle: "wrong place", config: {} }),
    null,
  );
  assertFalse(isBundled("trigger", { config: { bundle: null } }));
  assertFalse(isBundled("flow", { bundle: "" }));
});

Deno.test("removing bundle locally doesn't get around the check", () => {
  assert(guardFor("flow", { name: "x" }, { name: "x", bundle: "b" }, false));
});

Deno.test("a bundled flow is not offered for push without --allow-bundled", async () => {
  const bundled = flow("f", { bundle: "v1_example_widget_1_0_0" });
  const server = new FakeServer().put("flows", bundled);
  const root = makeProject({
    "flows/f/flow.json": { ...bundled, description: "local edit" },
  });
  const ctx = await sync(root, server, {}, ["nothing"]);
  assertEquals(ctx.prompter.prompts[0].choices, [
    "Nothing",
    "Overwrite local flow",
    "Show full diff",
  ]);
  assertStringIncludes(
    ctx.out.text(),
    "(bundled: v1_example_widget_1_0_0 — read-only, use --allow-bundled)",
  );
  assertEquals(server.writes(), []);
});

Deno.test("--allow-bundled offers push, with a confirmation per config", async () => {
  for (const confirm of [true, false]) {
    const bundled = trigger("t", { bundle: "bundle_x" });
    const server = new FakeServer().put("flowTriggerers", bundled);
    const edited = trigger("t", { bundle: "bundle_x", path: "/changed" });
    const root = makeProject({ "triggers/t.json": edited });
    const ctx = await sync(root, server, { allowBundled: true }, [
      "push",
      confirm,
    ]);
    assertStringIncludes(
      ctx.prompter.prompts[1].message,
      "belongs to bundle bundle_x",
    );
    assertEquals(server.writes().length, confirm ? 1 : 0);
  }
});

Deno.test("triggers with config.bundle: null are not bundled", async () => {
  const server = new FakeServer().put("flowTriggerers", trigger("t"));
  const root = makeProject({
    "triggers/t.json": trigger("t", { path: "/changed" }),
  });
  const ctx = await sync(root, server, {}, ["push"]);
  assertEquals(server.writes().length, 1);
  assertFalse(ctx.out.text().includes("bundled"));
});

Deno.test("bundled collections and new bundled configs are refused too", async () => {
  const remote = collection("c", [{ id: "r", path: "/a.html", content: "A" }], {
    bundle: "b",
  });
  const server = new FakeServer().put("resourceCollections", remote);
  const root = makeProject({
    "resources/c/_collection.json": localCollection(remote),
    "resources/c/a.html": "changed",
    "flows/new/flow.json": flow("new", { bundle: "b" }),
  });
  const ctx = await sync(root, server, {}, ["nothing"]);
  // The new bundled flow has no options left, so there's no prompt for it.
  assertEquals(ctx.prompter.prompts.length, 1);
  assertEquals(ctx.prompter.prompts[0].choices, [
    "Nothing",
    "Overwrite local resource",
    "Show full diff",
  ]);
  assertEquals(server.writes(), []);
});

Deno.test("secure shared configs are never pushed or deleted, in any mode", async () => {
  const secure = sharedConfig("s", {
    secure: true,
    config: undefined,
    redactedConfig: "hidden",
  });
  delete secure.config;
  const cases: [Partial<SyncOptions>, Answer[]][] = [
    // Deleting the local copy is still offered; pushing isn't.
    [{ allowDelete: true, allowBundled: true }, ["nothing"]],
    [{ preferServer: true }, []],
    [{ mode: "watch" }, []],
  ];
  for (const [options, answers] of cases) {
    const server = new FakeServer();
    const root = makeProject({ "sharedConfigs/s.json": secure });
    const ctx = await sync(root, server, options, answers);
    assertEquals(server.writes(), []);
    for (const p of ctx.prompter.prompts) {
      assertEquals(p.choices, [
        "Nothing",
        "Delete local shared config",
        "Show full diff",
      ]);
    }
  }
  // Remote only, with -d: no "Delete remote" offered.
  const server = new FakeServer().put("sharedConfig", secure);
  const ctx = await sync(makeProject(), server, { allowDelete: true }, [
    "nothing",
  ]);
  assertEquals(ctx.prompter.prompts[0].choices, [
    "Nothing",
    "Create new local shared config",
    "Show full diff",
  ]);
  assertStringIncludes(
    ctx.out.text(),
    "secure shared config — pathisync never pushes or deletes secrets",
  );
});

Deno.test("watch mode refuses bundled configs even with --allow-bundled, once per session", async () => {
  const bundled = flow("f", { bundle: "b" });
  const server = new FakeServer().put("flows", bundled);
  const root = makeProject({ "flows/f/flow.json": bundled });
  const ctx = makeContext(root, server, { mode: "watch", allowBundled: true });
  await runSync(ctx, ALL);
  Deno.writeTextFileSync(
    `${root}/flows/f/flow.json`,
    JSON.stringify({ ...bundled, description: "x" }),
  );
  await runSync(ctx, ALL);
  await runSync(ctx, ALL);
  assertEquals(server.writes(), []);
  assertEquals(
    ctx.out.lines.filter((l) => l.includes("✖ flow f not pushed")).length,
    1,
  );
});

Deno.test("a plain-text secret in a local secure shared config triggers a warning", async () => {
  const server = new FakeServer();
  const root = makeProject({
    "sharedConfigs/s.json": sharedConfig("s", {
      secure: true,
      config: { password: "hunter2" },
    }),
  });
  const ctx = await sync(root, server, { preferServer: true });
  assertStringIncludes(ctx.out.text(), "plain-text");
});
