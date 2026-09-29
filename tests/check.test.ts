import { assertEquals, assertStringIncludes } from "@std/assert";
import { main } from "../main.ts";
import { SyncState } from "../src/state.ts";
import {
  CaptureOutput,
  collection,
  FakeServer,
  fileExists,
  flow,
  localCollection,
  makeProject,
  ScriptedPrompter,
  sharedConfig,
  trigger,
  writeFiles,
} from "./helpers.ts";

function run(root: string, server: FakeServer, argv: string[]) {
  const out = new CaptureOutput();
  const prompter = new ScriptedPrompter();
  return main(argv, { root, fetch: server.fetch, out, prompter }).then((
    code,
  ) => ({
    code,
    out,
    prompter,
  }));
}

function snapshot(root: string) {
  const files: Record<string, string> = {};
  for (const entry of Deno.readDirSync(root)) {
    if (entry.isDirectory) {
      for (const [k, v] of Object.entries(snapshot(`${root}/${entry.name}`))) {
        files[`${entry.name}/${k}`] = v;
      }
    } else files[entry.name] = Deno.readTextFileSync(`${root}/${entry.name}`);
  }
  return files;
}

Deno.test("check: exit 0 when in sync", async () => {
  const server = new FakeServer().put("sharedConfig", sharedConfig("a"));
  const root = makeProject({ "sharedConfigs/a.json": sharedConfig("a") });
  const { code, out } = await run(root, server, ["check"]);
  assertEquals(code, 0);
  assertStringIncludes(out.text(), "Everything is in sync");
});

Deno.test("check: never prompts, writes, records state or calls POST/DELETE", async () => {
  const server = new FakeServer()
    .put(
      "sharedConfig",
      sharedConfig("a", { config: { v: 2 } }),
      sharedConfig("remoteOnly"),
    )
    .put("flows", flow("f@x"));
  const root = makeProject({
    "sharedConfigs/a.json": sharedConfig("a"),
    "sharedConfigs/localOnly.json": sharedConfig("localOnly"),
    "flows/@x/f/flow.json": { ...flow("f@x"), description: "local" },
  });
  const before = snapshot(root);
  const { code, out, prompter } = await run(root, server, ["check"]);
  assertEquals(code, 1);
  assertEquals(prompter.prompts, []);
  assertEquals(server.writes(), []);
  assertEquals(snapshot(root), before);
  assertEquals(fileExists(root, ".pathisync/state.json"), false);
  assertEquals(out.lines.slice(0, 5), [
    "flows",
    "  differs            flows/@x/f/",
    "sharedConfigs",
    "  differs            sharedConfigs/a.json",
    "  new local          sharedConfigs/localOnly.json",
  ]);
  assertStringIncludes(out.text(), "  new on server      remoteOnly");
  assertStringIncludes(out.text(), "4 configs differ");
});

Deno.test("check uses the last-sync wording when a baseline exists", async () => {
  const server = new FakeServer()
    .put(
      "sharedConfig",
      sharedConfig("a"),
      sharedConfig("b"),
      sharedConfig("c"),
    )
    .put("flowTriggerers", trigger("t"));
  const root = makeProject({
    "sharedConfigs/a.json": sharedConfig("a"),
    "sharedConfigs/b.json": sharedConfig("b"),
    "sharedConfigs/c.json": sharedConfig("c"),
    "triggers/t.json": trigger("t"),
  });
  assertEquals((await run(root, server, [])).code, 0);
  server.put(
    "sharedConfig",
    sharedConfig("a", { config: 9 }),
    sharedConfig("c", { config: 7 }),
  );
  writeFiles(root, {
    "sharedConfigs/b.json": sharedConfig("b", { config: 1 }),
    "sharedConfigs/c.json": sharedConfig("c", { config: 8 }),
  });
  server.data.get("flowTriggerers")!.clear();
  const state = Deno.readTextFileSync(SyncState.path(root));
  const { code, out } = await run(root, server, ["check", "--diff"]);
  assertEquals(code, 1);
  assertStringIncludes(out.text(), "  server changed     sharedConfigs/a.json");
  assertStringIncludes(out.text(), "  local changed      sharedConfigs/b.json");
  assertStringIncludes(out.text(), "  conflict           sharedConfigs/c.json");
  assertStringIncludes(out.text(), "  deleted on server  triggers/t.json");
  assertStringIncludes(out.text(), "4 configs differ (1 conflict)");
  assertStringIncludes(out.text(), "--- remote (server)  c.json");
  assertEquals(Deno.readTextFileSync(SyncState.path(root)), state);
});

Deno.test("check with a path limits the scope", async () => {
  const server = new FakeServer().put("flows", flow("a@one"), flow("b@two"));
  const root = makeProject({
    "flows/@one/a/flow.json": { ...flow("a@one"), description: "x" },
    "flows/@two/b/flow.json": { ...flow("b@two"), description: "y" },
  });
  const { code, out } = await run(root, server, ["check", "flows/@one"]);
  assertEquals(code, 1);
  assertStringIncludes(out.text(), "flows/@one/a/");
  assertEquals(out.text().includes("flows/@two/b/"), false);
  // Other config types aren't even fetched.
  assertEquals(server.configCalls().map((c) => c.path), ["/repository/flows"]);
});

Deno.test("check reports resource-level differences and skips one-sided collections' resources", async () => {
  const remote = collection("c", [{ id: "r", path: "/a.html", content: "A" }]);
  const remoteOnly = collection("r2", [{
    id: "x",
    path: "/x.html",
    content: "X",
  }]);
  const server = new FakeServer().put(
    "resourceCollections",
    remote,
    remoteOnly,
  );
  const root = makeProject({
    "resources/c/_collection.json": localCollection(remote),
    "resources/c/a.html": "B",
  });
  const { out } = await run(root, server, ["check"]);
  assertEquals(out.lines.slice(0, 3), [
    "resources",
    "  differs            resources/c/a.html",
    "  new on server      r2",
  ]);
});

Deno.test("check: exit 2 on an unreadable local file, and on server errors", async () => {
  const server = new FakeServer();
  const root = makeProject({ "flows/bad/flow.json": "{ not json" });
  const { code, out } = await run(root, server, ["check"]);
  assertEquals(code, 2);
  assertStringIncludes(out.text(), "flows/bad/flow.json: invalid JSON");

  const down = new FakeServer();
  down.unreachable = true;
  assertEquals((await run(makeProject(), down, ["check"])).code, 2);
});

Deno.test("check can't be combined with -l or -d", async () => {
  for (const extra of [["-l"], ["-d"]]) {
    const server = new FakeServer();
    const { code, out } = await run(makeProject(), server, ["check", ...extra]);
    assertEquals(code, 2);
    assertStringIncludes(out.text(), "check can't be combined");
    assertEquals(server.calls, []);
  }
});
