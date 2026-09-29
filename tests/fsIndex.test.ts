import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { walkSync } from "@std/fs";
import { indexTriggers } from "../src/flowLayout.ts";
import {
  assertNoDuplicates,
  DuplicateNamesError,
  indexCollections,
  indexConfigs,
  type Walker,
} from "../src/fsIndex.ts";
import { runSync } from "../src/sync/engine.ts";
import {
  FakeServer,
  flow,
  makeContext,
  makeProject,
  sharedConfig,
  trigger,
} from "./helpers.ts";

Deno.test("indexes only *.json, skipping dotfiles and node_modules", () => {
  const root = makeProject({
    "sharedConfigs/a.json": "{}",
    "sharedConfigs/a.js": "",
    "sharedConfigs/.DS_Store": "x",
    "sharedConfigs/.hidden/b.json": "{}",
    "sharedConfigs/node_modules/c.json": "{}",
    "sharedConfigs/sub/d.json": "{}",
    "sharedConfigs/sub/.d.json.swp": "x",
  });
  const index = indexConfigs(root, "sharedConfigs");
  assertEquals([...index.files.entries()], [["a", "sharedConfigs/a.json"], [
    "d",
    "sharedConfigs/sub/d.json",
  ]]);
  assertEquals(index.folders, [".", "sub"]);
});

Deno.test("a missing config directory is an empty index", () => {
  assertEquals(indexConfigs(makeProject(), "triggers").files.size, 0);
});

Deno.test("every duplicate is listed in a single error", () => {
  const root = makeProject({
    "sharedConfigs/a/x.json": "{}",
    "sharedConfigs/b/x.json": "{}",
    "triggers/one/t.json": "{}",
    "flows/@w/f/t.trigger.json": "{}",
  });
  const error = assertThrows(
    () =>
      assertNoDuplicates([
        indexConfigs(root, "sharedConfigs"),
        indexTriggers(root),
      ]),
    DuplicateNamesError,
  );
  for (
    const path of [
      "sharedConfigs/a/x.json",
      "sharedConfigs/b/x.json",
      "triggers/one/t.json",
      "flows/@w/f/t.trigger.json",
    ]
  ) {
    assertStringIncludes(error.message, path);
  }
});

Deno.test("duplicates stop the sync before any network call", async () => {
  const root = makeProject({
    "triggers/a/t.json": trigger("t"),
    "triggers/b/t.json": trigger("t"),
  });
  const server = new FakeServer();
  await assertRejects(
    () => runSync(makeContext(root, server)),
    DuplicateNamesError,
  );
  assertEquals(server.calls, []);
});

Deno.test("collections are keyed by folder; folders inside collections aren't offered", () => {
  const root = makeProject({
    "resources/social/c1/_collection.json": "{}",
    "resources/social/c1/widgets/a.html": "",
    "resources/c2/_collection.json": "{}",
  });
  const index = indexCollections(root, "resources");
  assertEquals([...index.files.keys()].sort(), ["c1", "c2"]);
  assertEquals(index.folders, [".", "social"]);
});

Deno.test("each config directory is walked once per run, though flows/ holds triggers too", async () => {
  const root = makeProject({
    "flows/f/flow.json": flow("f"),
    "flows/f/tf.trigger.json": trigger("tf", { orchestratorName: "f" }),
    "sharedConfigs/s.json": sharedConfig("s"),
    "triggers/t.json": trigger("t"),
    "resources/c/_collection.json": { collectionId: "c", resources: [] },
  });
  const server = new FakeServer()
    .put("flows", flow("f"))
    .put("sharedConfig", sharedConfig("s"))
    .put(
      "flowTriggerers",
      trigger("t"),
      trigger("tf", { orchestratorName: "f" }),
    )
    .put("resourceCollections", { collectionId: "c", resources: [] });
  const walked: string[] = [];
  const walk: Walker = (dir) => {
    walked.push(dir.split("/").pop()!);
    return walkSync(dir);
  };
  const ctx = makeContext(root, server);
  ctx.walk = walk;
  await runSync(ctx);
  assertEquals(walked.sort(), [
    "flows",
    "resources",
    "sharedConfigs",
    "triggers",
  ]);
});
