import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { gitignoreLines, globalsDts, jsconfig } from "../fileConstants.ts";
import { main } from "../main.ts";
import { initProject } from "../src/scaffold.ts";
import {
  CaptureOutput,
  FakeServer,
  makeProject,
  readText,
  ScriptedPrompter,
} from "./helpers.ts";

Deno.test("init creates the project layout", () => {
  const root = join(Deno.makeTempDirSync(), "new");
  const lines = initProject(root);
  for (const dir of ["flows", "resources", "sharedConfigs", "triggers"]) {
    assertEquals(Deno.statSync(join(root, dir)).isDirectory, true);
  }
  assertEquals(readText(root, "flows/jsconfig.json"), jsconfig);
  assertEquals(readText(root, "types/globals.d.ts"), globalsDts);
  assertEquals(readText(root, ".gitignore"), gitignoreLines.join("\n") + "\n");
  assertStringIncludes(lines.join("\n"), "created .env");
});

Deno.test("init in an existing project changes nothing that exists", () => {
  const root = makeProject({
    "README.md": "my readme",
    ".gitignore": "node_modules\n.env",
    "flows/jsconfig.json": '{ "mine": true }',
    "types/globals.d.ts": "declare var mine: any;",
  });
  const env = readText(root, ".env");
  const lines = initProject(root);
  assertEquals(readText(root, ".env"), env);
  assertEquals(readText(root, "README.md"), "my readme");
  assertEquals(readText(root, "flows/jsconfig.json"), '{ "mine": true }');
  assertEquals(readText(root, "types/globals.d.ts"), "declare var mine: any;");
  // Missing lines are added, existing ones kept.
  assertEquals(
    readText(root, ".gitignore"),
    "node_modules\n.env\n.DS_Store\n.pathisync/\n",
  );
  assertStringIncludes(lines.join("\n"), "skipped .env (exists)");
  assertStringIncludes(lines.join("\n"), "skipped README.md (exists)");
});

Deno.test("the sync warns if .pathisync/ is tracked by git", async () => {
  const root = makeProject({ ".pathisync/state.json": "{}" });
  const git = (...args: string[]) =>
    new Deno.Command("git", { args, cwd: root, stdout: "null", stderr: "null" })
      .outputSync();
  git("init", "-q");
  git("add", ".pathisync/state.json");
  const out = new CaptureOutput();
  const server = new FakeServer();
  await main([], {
    root,
    fetch: server.fetch,
    out,
    prompter: new ScriptedPrompter(),
  });
  assertStringIncludes(out.text(), ".pathisync/ is tracked by git");

  const clean = makeProject();
  const quiet = new CaptureOutput();
  await main([], {
    root: clean,
    fetch: server.fetch,
    out: quiet,
    prompter: new ScriptedPrompter(),
  });
  assertEquals(quiet.text().includes("tracked by git"), false);
});
