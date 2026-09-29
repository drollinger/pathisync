import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { main } from "../main.ts";
import { TYPES_FILE } from "../src/typegen/types.ts";
import {
  CaptureOutput,
  collection,
  FakeServer,
  fileExists,
  localCollection,
  makeProject,
  readText,
  ScriptedPrompter,
  SERVER_URL,
  sharedConfig,
} from "./helpers.ts";

async function run(root: string, argv: string[], server = new FakeServer()) {
  const out = new CaptureOutput();
  const code = await main(argv, {
    root,
    fetch: server.fetch,
    out,
    prompter: new ScriptedPrompter(),
  });
  return { code, out, server };
}

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
      "check [paths]",
      "watch <paths>",
      "links <widgets>",
      "types",
    ]
  ) {
    assertStringIncludes(help.out.text(), command);
  }
});
