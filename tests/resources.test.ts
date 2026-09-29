import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { join } from "@std/path";
import { SyncState } from "../src/state.ts";
import { runSync } from "../src/sync/engine.ts";
import { resources } from "../src/sync/resources.ts";
import type { SyncOptions } from "../src/sync/types.ts";
import type { CollectionObj } from "../src/types.ts";
import {
  type Answer,
  collection,
  FakeServer,
  fileExists,
  localCollection,
  makeContext,
  makeProject,
  readJson,
  readText,
  SERVER_URL,
  writeFiles,
} from "./helpers.ts";

async function sync(
  root: string,
  server: FakeServer,
  options: Partial<SyncOptions> = {},
  answers: Answer[] = [],
) {
  const ctx = makeContext(root, server, options, answers);
  await runSync(ctx, [resources]);
  assertEquals(ctx.prompter.answers, [], "every scripted answer is used");
  return ctx;
}

const RESOURCES = [
  { id: "html", path: "/widgets/a.html", content: "<p>A</p>" },
  { id: "js", path: "/widgets/a.js", content: "console.log(1)" },
];

function project(remote = collection("c", RESOURCES)) {
  const server = new FakeServer().put("resourceCollections", remote);
  const root = makeProject({
    "resources/group/c/_collection.json": localCollection(remote),
    "resources/group/c/widgets/a.html": "<p>A</p>",
    "resources/group/c/widgets/a.js": "console.log(1)",
  });
  return { root, server };
}

const remoteBytes = (server: FakeServer, resourceId: string) => {
  const c = server.get("resourceCollections", "c") as CollectionObj;
  const r = c.resources.find((r) => r.resourceId === resourceId);
  return r && new TextDecoder().decode(decodeBase64(r.resourceBytes));
};

Deno.test("an in-sync collection records a baseline per resource", async () => {
  const { root, server } = project();
  const ctx = await sync(root, server);
  assertEquals(ctx.prompter.prompts, []);
  const state = SyncState.load(root, SERVER_URL);
  assert(state.get("resourceCollection:c"));
  assert(state.get("resource:c/html"));
  assert(state.get("resource:c/js"));
  assertEquals(server.writes(), []);
});

Deno.test("a changed resource shows a text diff; pushing sends the whole collection", async () => {
  const { root, server } = project();
  writeFiles(root, { "resources/group/c/widgets/a.html": "<p>B</p>" });
  const ctx = await sync(root, server, {}, ["push"]);
  assertEquals(ctx.prompter.prompts[0].choices, [
    "Nothing",
    "Overwrite local resource",
    "Push local resource to flow.test",
    "Show full diff",
  ]);
  assertStringIncludes(ctx.out.text(), "-<p>A</p>");
  assertStringIncludes(ctx.out.text(), "+<p>B</p>");
  assertEquals(server.writes().length, 1);
  assertEquals(remoteBytes(server, "html"), "<p>B</p>");
  assertEquals(remoteBytes(server, "js"), "console.log(1)");
  assertEquals(
    readJson(root, "resources/group/c/_collection.json").resources[0]
      .resourceBytes,
    "",
  );
});

Deno.test("only one resource changed on the server: it's pulled, nothing else touched", async () => {
  const { root, server } = project();
  await sync(root, server);
  server.put(
    "resourceCollections",
    collection("c", [RESOURCES[0], {
      ...RESOURCES[1],
      content: "console.log(2)",
    }]),
  );
  const before = readText(root, "resources/group/c/_collection.json");
  const ctx = await sync(root, server);
  assertEquals(ctx.prompter.prompts, []);
  assertEquals(
    readText(root, "resources/group/c/widgets/a.js"),
    "console.log(2)",
  );
  assertEquals(readText(root, "resources/group/c/_collection.json"), before);
});

Deno.test("watch pushes a locally changed resource, and never a conflicting one", async () => {
  const { root, server } = project();
  await sync(root, server);
  writeFiles(root, { "resources/group/c/widgets/a.js": "console.log(3)" });
  await sync(root, server, { mode: "watch" });
  assertEquals(remoteBytes(server, "js"), "console.log(3)");

  writeFiles(root, { "resources/group/c/widgets/a.js": "console.log(4)" });
  server.put(
    "resourceCollections",
    collection("c", [RESOURCES[0], { ...RESOURCES[1], content: "server" }]),
  );
  server.calls = [];
  const ctx = await sync(root, server, { mode: "watch" });
  assertEquals(server.writes(), []);
  assertStringIncludes(ctx.out.text(), "✖ conflict on resource c/js");
});

Deno.test("a _collection.json difference offers overwrite or push", async () => {
  const remote = collection("c", RESOURCES, { description: "server" });
  const { root, server } = project(remote);
  writeFiles(root, {
    "resources/group/c/_collection.json": {
      ...localCollection(remote),
      description: "local",
    },
  });
  const ctx = await sync(root, server, {}, ["push"]);
  assertEquals(ctx.prompter.prompts[0].choices, [
    "Nothing",
    "Overwrite local _collection.json",
    "Push local _collection.json to flow.test",
    "Show full diff",
  ]);
  assertEquals(server.get("resourceCollections", "c")!.description, "local");
  // Resource bytes still go up with the metadata push.
  assertEquals(remoteBytes(server, "html"), "<p>A</p>");
});

Deno.test("an entry whose file is missing offers to save the server's copy or remove it", async () => {
  const { root, server } = project();
  Deno.removeSync(join(root, "resources/group/c/widgets/a.js"));
  const ctx = await sync(root, server, { allowDelete: true }, ["create-local"]);
  assertEquals(ctx.prompter.prompts[0].choices, [
    "Nothing",
    "Save flow.test's resource to /widgets/a.js",
    "Delete resource on flow.test (will also remove local _collection.json resource)",
    "Remove resource listed in the local _collection.json file",
    "Show full diff",
  ]);
  assertEquals(
    readText(root, "resources/group/c/widgets/a.js"),
    "console.log(1)",
  );

  Deno.removeSync(join(root, "resources/group/c/widgets/a.js"));
  await sync(root, server, {}, ["delete-local"]);
  const entries =
    readJson(root, "resources/group/c/_collection.json").resources;
  assertEquals(entries.map((r: { resourceId: string }) => r.resourceId), [
    "html",
  ]);
});

Deno.test("a new server collection is created locally with all its files", async () => {
  const server = new FakeServer().put(
    "resourceCollections",
    collection("c", RESOURCES),
  );
  const root = makeProject({
    "resources/existing/other/_collection.json": localCollection(
      collection("other", []),
    ),
  });
  server.put("resourceCollections", collection("other", []));
  const ctx = await sync(root, server, {}, ["create-local", "existing"]);
  // Folders inside collections aren't offered.
  assertEquals(ctx.prompter.prompts[1].choices, [
    ".",
    "existing",
    "<New Folder>",
  ]);
  assertEquals(
    readText(root, "resources/existing/c/widgets/a.html"),
    "<p>A</p>",
  );
  assertEquals(
    readJson(root, "resources/existing/c/_collection.json").resources[1]
      .resourceBytes,
    "",
  );

  const root2 = makeProject();
  await sync(root2, server, { preferServer: true, forceDefaultFolder: true });
  assert(fileExists(root2, "resources/c/widgets/a.js"));
  const next = await sync(root2, server);
  assertEquals(next.prompter.prompts, []);
});

Deno.test("a new local collection is pushed with its files' bytes", async () => {
  const remote = collection("c", RESOURCES);
  const server = new FakeServer();
  const root = makeProject({
    "resources/c/_collection.json": localCollection(remote),
    "resources/c/widgets/a.html": "<p>A</p>",
    "resources/c/widgets/a.js": "console.log(1)",
  });
  const ctx = await sync(root, server, {}, ["push"]);
  assertEquals(ctx.prompter.prompts[0].choices, [
    "Nothing",
    "Push new collection to flow.test",
    "Show full diff",
  ]);
  assertEquals(remoteBytes(server, "js"), "console.log(1)");
  const next = await sync(root, server);
  assertEquals(next.prompter.prompts, []);
});

Deno.test("a new local resource is pushed; deleting one can also delete its file", async () => {
  const { root, server } = project();
  const local = readJson(root, "resources/group/c/_collection.json");
  local.resources.push({
    ...local.resources[0],
    resourceId: "new",
    resourceAccessorPath: "/new.html",
  });
  writeFiles(root, {
    "resources/group/c/_collection.json": local,
    "resources/group/c/new.html": "new!",
  });
  await sync(root, server, {}, ["push"]);
  assertEquals(remoteBytes(server, "new"), "new!");

  const again = readJson(root, "resources/group/c/_collection.json");
  again.resources.push({
    ...again.resources[0],
    resourceId: "gone",
    resourceAccessorPath: "/gone.html",
  });
  writeFiles(root, {
    "resources/group/c/_collection.json": again,
    "resources/group/c/gone.html": "x",
  });
  await sync(root, server, { allowDelete: true }, ["delete-local", true]);
  assertFalse(fileExists(root, "resources/group/c/gone.html"));
  assertFalse(
    readJson(root, "resources/group/c/_collection.json").resources.some((
      r: { resourceId: string },
    ) => r.resourceId === "gone"),
  );
});

Deno.test("a binary resource difference shows sizes and hashes, never bytes", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0xff, 0xfe]);
  const remote = collection("c", [{
    id: "img",
    path: "/logo.png",
    content: "",
  }]);
  (remote.resources as { resourceBytes: string; resourceHeaders: unknown }[])[0]
    .resourceBytes = encodeBase64(png);
  (remote.resources as { resourceHeaders: unknown }[])[0].resourceHeaders = [[
    "Content-Type",
    "image/png",
  ]];
  const server = new FakeServer().put("resourceCollections", remote);
  const root = makeProject({
    "resources/c/_collection.json": localCollection(remote),
  });
  Deno.writeFileSync(
    join(root, "resources/c/logo.png"),
    new Uint8Array([...png, 7]),
  );
  const ctx = await sync(root, server, {}, ["nothing"]);
  assertStringIncludes(ctx.out.text(), "binary /logo.png");
  assertStringIncludes(ctx.out.text(), "remote (server): 9 bytes, sha256");
  assertStringIncludes(ctx.out.text(), "local:           10 bytes, sha256");
});

Deno.test("resource paths match exactly: nested/b.html is not /b.html", async () => {
  const remote = collection("c", [{ id: "b", path: "/b.html", content: "B" }]);
  const server = new FakeServer().put("resourceCollections", remote);
  const root = makeProject({
    "resources/c/_collection.json": localCollection(remote),
    "resources/c/nested/b.html": "B",
  });
  const ctx = await sync(root, server, {}, ["nothing"]);
  assertStringIncludes(
    ctx.out.text(),
    "there is no local file at resources/c/b.html",
  );
});

Deno.test("an accessor path leaving the collection folder is refused", async () => {
  const remote = collection("c", [{
    id: "x",
    path: "/../../escape.txt",
    content: "x",
  }]);
  const server = new FakeServer().put("resourceCollections", remote);
  const root = makeProject({
    "resources/c/_collection.json": localCollection(remote),
  });
  const state = SyncState.load(root, SERVER_URL);
  state.set("resourceCollection:c", "sha256:kept");
  state.save();
  const ctx = await sync(root, server);
  assertStringIncludes(
    ctx.out.text(),
    "resources/c/_collection.json: resourceAccessorPath /../../escape.txt points outside the collection folder",
  );
  assertFalse(fileExists(root, "escape.txt"));
  // The collection was skipped, not forgotten.
  assertEquals(
    SyncState.load(root, SERVER_URL).get("resourceCollection:c"),
    "sha256:kept",
  );
});

Deno.test("server normalization after a resource push is written back locally", async () => {
  const { root, server } = project();
  await sync(root, server);
  server.normalize = (_e, obj) => ({
    ...obj,
    resources: (obj.resources as Record<string, unknown>[]).map((r) => ({
      ...r,
      useVirtualThreads: true,
    })),
  });
  writeFiles(root, { "resources/group/c/widgets/a.html": "<p>C</p>" });
  await sync(root, server, { mode: "watch" });
  const entry =
    readJson(root, "resources/group/c/_collection.json").resources[0];
  assertEquals(entry.useVirtualThreads, true);
  server.calls = [];
  const next = await sync(root, server);
  assertEquals(next.prompter.prompts, []);
  assertEquals(server.writes(), []);
});
