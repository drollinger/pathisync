import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { main } from "../main.ts";
import { SyncState } from "../src/state.ts";
import { TYPES_FILE } from "../src/typegen/types.ts";
import {
  type Answer,
  CaptureOutput,
  collection,
  FakeServer,
  fileExists,
  flow,
  localCollection,
  makeProject,
  readText,
  ScriptedPrompter,
  SERVER_URL,
  sharedConfig,
  trigger,
} from "./helpers.ts";

async function run(
  root: string,
  argv: string[],
  server = new FakeServer(),
  answers: Answer[] = [],
) {
  const out = new CaptureOutput();
  const prompter = new ScriptedPrompter(answers);
  const code = await main(argv, { root, fetch: server.fetch, out, prompter });
  assertEquals(prompter.answers, [], "every scripted answer is used");
  return { code, out, server, prompter };
}

const TESTING_URL = "https://testing.test";

/** Serves SERVER_URL from `prod` and TESTING_URL from `testing`. */
function twoServers(prod: FakeServer, testing: FakeServer): FakeServer {
  const router = new FakeServer();
  router.fetch = (input, init) =>
    (input.startsWith(TESTING_URL) ? testing : prod).fetch(input, init);
  return router;
}

const git = (root: string, ...args: string[]) =>
  new Deno.Command("git", { args, cwd: root, stdout: "null", stderr: "null" })
    .outputSync();

Deno.test("in a folder without .env, the first run sets up the project and stops", async () => {
  const root = Deno.makeTempDirSync();
  const { code, out, server } = await run(root, []);
  assertEquals(code, 0);
  for (
    const path of [
      ".env",
      "README.md",
      ".gitignore",
      "flows/jsconfig.json",
      "types/globals.d.ts",
      "resources",
      "sharedConfigs",
      "triggers",
    ]
  ) assert(fileExists(root, path), path);
  assertStringIncludes(
    out.text(),
    "Fill in PATHIFY_TOKEN and FLOW_SERVER_URL in .env",
  );
  assertEquals(server.calls, []);
});

Deno.test("other commands without .env say how to set up", async () => {
  const root = Deno.makeTempDirSync();
  const check = await run(root, ["check"]);
  assertEquals(check.code, 2);
  assertStringIncludes(check.out.text(), "There is no .env here");
  assertEquals((await run(root, ["types"])).code, 1);
  assertFalse(fileExists(root, ".env"));
});

Deno.test("a sync also writes the editor types, and says so only when they change", async () => {
  const server = new FakeServer().put("sharedConfig", sharedConfig("a"));
  const root = makeProject({ "sharedConfigs/a.json": sharedConfig("a") });
  const first = await run(root, [], server);
  assertEquals(first.code, 0);
  assertEquals(first.out.lines, [`Updated ${TYPES_FILE} (flow docs 1.2.3)`]);
  assertStringIncludes(
    readText(root, TYPES_FILE),
    "declare class code_data_acme_RestRequest",
  );
  const stat = Deno.statSync(join(root, TYPES_FILE)).mtime;
  const second = await run(root, [], server);
  assertEquals(second.out.lines, []);
  assertEquals(Deno.statSync(join(root, TYPES_FILE)).mtime, stat);
});

Deno.test("when the docs can't be read, the sync warns and still succeeds", async () => {
  const server = new FakeServer().put("sharedConfig", sharedConfig("a"));
  server.docs = null;
  const root = makeProject({ "sharedConfigs/a.json": sharedConfig("a") });
  const { code, out } = await run(root, [], server);
  assertEquals(code, 0);
  assertStringIncludes(out.text(), `Couldn't update ${TYPES_FILE}`);
  assertStringIncludes(out.text(), 'types" to retry');
  assertFalse(fileExists(root, TYPES_FILE));
});

Deno.test("check never fetches the docs or writes the types", async () => {
  const root = makeProject();
  const { server } = await run(root, ["check"]);
  assertEquals(
    server.calls.some((c) => c.path.startsWith("/static/docs")),
    false,
  );
  assertFalse(fileExists(root, TYPES_FILE));
});

Deno.test("types regenerates on demand and needs no token", async () => {
  const root = makeProject({
    ".env": `PATHIFY_TOKEN=\nFLOW_SERVER_URL=${SERVER_URL}\n`,
  });
  const first = await run(root, ["types"]);
  assertEquals(first.code, 0);
  assertEquals(first.out.lines, [
    `9 globals, 11 classes, 3 plugin globals → ${TYPES_FILE}`,
  ]);
  const again = await run(root, ["types"]);
  assertStringIncludes(again.out.text(), "(unchanged)");
});

Deno.test("links runs from local files only, without .env", async () => {
  const remote = collection("w", [{ id: "p", path: "/p.html", content: "" }]);
  const root = Deno.makeTempDirSync();
  Deno.mkdirSync(join(root, "resources/w"), { recursive: true });
  Deno.writeTextFileSync(
    join(root, "resources/w/_collection.json"),
    JSON.stringify(localCollection(remote)),
  );
  Deno.writeTextFileSync(join(root, "resources/w/p.html"), "<p>static</p>");
  const { code, out, server } = await run(root, ["links", "w"]);
  assertEquals(code, 0);
  assertStringIncludes(out.text(), "w (resources/w)");
  assertEquals(server.calls, []);
  assertFalse(fileExists(root, ".env"));
});

Deno.test("bad commands and missing arguments are errors", async () => {
  const root = makeProject();
  for (
    const [argv, message] of [
      [["snyc"], "Unknown command snyc"],
      [["watch"], "watch needs a path"],
      [["links"], "links needs a widget"],
      [["--watch=flows"], "Unknown option --watch=flows"],
      [["flows"], "Unknown command flows"],
      [["types", "flows"], "Unknown command flows"],
      [["sync", "nope"], "nope is not inside"],
      [["--env-file"], "--env-file needs a file"],
      [["--env-file=.missing.env"], ".missing.env does not exist"],
    ] as const
  ) {
    const { code, out, server } = await run(root, [...argv]);
    assertEquals(code, 1, argv.join(" "));
    assertStringIncludes(out.text(), message);
    assertEquals(server.calls, []);
  }
  const help = await run(root, ["--help"]);
  for (
    const command of [
      "sync [paths]",
      "check [paths]",
      "watch <paths>",
      "links <widgets>",
      "types",
      "--env-file <file>",
    ]
  ) {
    assertStringIncludes(help.out.text(), command);
  }
});

Deno.test("sync <flow folder> --env-file pushes just that flow and its triggers to that server", async () => {
  const prod = new FakeServer()
    .put("flows", flow("f@w"), flow("g@w"))
    .put("sharedConfig", sharedConfig("s"))
    .put("flowTriggerers", trigger("tf", { orchestratorName: "f@w" }));
  const testing = new FakeServer();
  const server = twoServers(prod, testing);
  const root = makeProject({
    ".testing.env":
      `PATHIFY_TOKEN=test-token\nFLOW_SERVER_URL=${TESTING_URL}\n`,
  });
  assertEquals((await run(root, ["-lf"], server)).code, 0);
  assert(fileExists(root, "flows/@w/f/tf.trigger.json"));
  prod.calls = [];

  // Only f@w and tf are offered; a prompt for g@w or s would fail the run.
  const { code, out, prompter } = await run(
    root,
    ["sync", "flows/@w/f", "--env-file=.testing.env"],
    server,
    ["push", "push"],
  );
  assertEquals(code, 0);
  assertEquals(out.lines[0], `Using .testing.env (${TESTING_URL})`);
  assertStringIncludes(out.text(), "testing.test doesn't have the flow f@w");
  assert(
    prompter.prompts[0].choices!.includes("Push new flow to testing.test"),
  );
  assertEquals([...testing.data.get("flows")!.keys()], ["f@w"]);
  assertEquals([...testing.data.get("flowTriggerers")!.keys()], ["tf"]);
  assertEquals(testing.data.get("sharedConfig")!.size, 0);
  assertEquals(prod.calls, []);

  // Each server keeps its own record.
  const prodState = SyncState.load(root, SERVER_URL);
  assert(prodState.get("flow:g@w") && prodState.get("sharedConfig:s"));
  const testingState = SyncState.load(root, TESTING_URL);
  assert(testingState.get("flow:f@w") && testingState.get("trigger:tf"));
  assertEquals(testingState.get("flow:g@w"), undefined);

  // A default sync still talks to prod, which is unchanged.
  const again = await run(root, [], server);
  assertEquals(again.code, 0);
  assertEquals(again.prompter.prompts, []);
  assertEquals(prod.writes(), []);
});

Deno.test("--env-file doesn't need a .env, and never sets up a project", async () => {
  const root = Deno.makeTempDirSync();
  Deno.writeTextFileSync(
    join(root, ".testing.env"),
    `PATHIFY_TOKEN=test-token\nFLOW_SERVER_URL=${TESTING_URL}\n`,
  );
  const { code } = await run(root, ["check", "--env-file", ".testing.env"]);
  assertEquals(code, 0);
  assertFalse(fileExists(root, ".env"));

  const empty = Deno.makeTempDirSync();
  const missing = await run(empty, ["--env-file=.testing.env"]);
  assertEquals(missing.code, 1);
  assertStringIncludes(missing.out.text(), ".testing.env does not exist");
  assertFalse(fileExists(empty, ".env"));
});

Deno.test("a FLOW_SERVER_URL in the environment that the env file overrides is warned about", async () => {
  // What `deno run --env-file=.testing.env jsr:@usu/pathisync` does.
  Deno.env.set("FLOW_SERVER_URL", TESTING_URL);
  try {
    const { out } = await run(makeProject(), ["check"]);
    assertStringIncludes(
      out.text(),
      `FLOW_SERVER_URL is ${TESTING_URL} in the environment, but .env says ${SERVER_URL}; using .env`,
    );
    Deno.env.set("FLOW_SERVER_URL", SERVER_URL + "/");
    const same = await run(makeProject(), ["check"]);
    assertFalse(same.out.text().includes("in the environment"));
  } finally {
    Deno.env.delete("FLOW_SERVER_URL");
  }
});

Deno.test("an env file git doesn't ignore is warned about", async () => {
  const root = makeProject({
    ".testing.env":
      `PATHIFY_TOKEN=test-token\nFLOW_SERVER_URL=${TESTING_URL}\n`,
    ".gitignore": ".env\n",
  });
  git(root, "init", "-q");
  const exposed = await run(root, ["check", "--env-file=.testing.env"]);
  assertStringIncludes(
    exposed.out.text(),
    ".testing.env isn't ignored by git",
  );
  const quiet = await run(root, ["check"]);
  assertFalse(quiet.out.text().includes("ignored by git"));

  Deno.writeTextFileSync(join(root, ".gitignore"), ".env\n*.env\n");
  const ignored = await run(root, ["check", "--env-file=.testing.env"]);
  assertFalse(ignored.out.text().includes("ignored by git"));
});
