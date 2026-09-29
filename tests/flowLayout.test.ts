import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { main } from "../main.ts";
import { flowDirFor, flowNameFromDir, indexFlows } from "../src/flowLayout.ts";
import { DuplicateNamesError } from "../src/fsIndex.ts";
import { runSync } from "../src/sync/engine.ts";
import type { SyncOptions } from "../src/sync/types.ts";
import {
  type Answer,
  CaptureOutput,
  FakeServer,
  fileExists,
  flow,
  makeContext,
  makeProject,
  readJson,
  ScriptedPrompter,
  trigger,
  writeFiles,
} from "./helpers.ts";

async function sync(
  root: string,
  server: FakeServer,
  options: Partial<SyncOptions> = {},
  answers: Answer[] = [],
) {
  const ctx = makeContext(root, server, options, answers);
  await runSync(ctx);
  assertEquals(ctx.prompter.answers, [], "every scripted answer is used");
  return ctx;
}

Deno.test("flow names map to @namespace / +sub-namespace folders and back", () => {
  const cases: [string, string][] = [
    ["O265-redirect", "flows/O265-redirect"],
    ["balances@widgets", "flows/@widgets/balances"],
    [
      "sync_users@campus:accounts",
      "flows/@campus/+accounts/sync_users",
    ],
    ["deep@a:b:c", "flows/@a/+b/+c/deep"],
    ["rest_call@vendor.pathify", "flows/@vendor.pathify/rest_call"],
  ];
  for (const [name, dir] of cases) {
    assertEquals(flowDirFor(name), { dir });
    assertEquals(flowNameFromDir(dir), { name });
  }
});

Deno.test("names that can't be laid out as folders are errors", () => {
  for (
    const [name, message] of [
      ["a@b@c", 'more than one "@"'],
      ["x@", "a part is empty"],
      ["@x", "a part is empty"],
      ["a@b::c", "a part is empty"],
      ["+x@y", 'starts with "+"'],
      ["a/b@x", "a character folders can't hold"],
      ['say"hi"@x', "a character folders can't hold"],
      ["trailing.@x", "ends with a dot"],
    ]
  ) {
    const result = flowDirFor(name);
    assert("error" in result, name);
    assertStringIncludes(result.error, message);
  }
});

Deno.test("folders that break the layout are errors", () => {
  for (
    const [dir, message] of [
      ["flows/misc/x", '"misc" must be an @namespace folder'],
      ["flows/@a/b/x", '"b" must be a +sub-namespace folder'],
      ["flows/@a", "not a namespace folder"],
      ["flows/@a/+b", "not a namespace folder"],
    ]
  ) {
    const result = flowNameFromDir(dir);
    assert("error" in result, dir);
    assertStringIncludes(result.error, message);
  }
});

Deno.test("the flow index reports stray JSON files and nested flow folders", () => {
  const root = makeProject({
    "flows/@w/ok/flow.json": flow("ok@w"),
    "flows/@w/ok/t.trigger.json": trigger("t"),
    "flows/@w/ok/inner/flow.json": flow("inner"),
    "flows/old@w.json": flow("old@w"),
    "flows/misc/x/flow.json": flow("x"),
    "flows/jsconfig.json": "{}",
  });
  const index = indexFlows(root);
  assertEquals([...index.files], [["ok@w", "flows/@w/ok/flow.json"]]);
  const problems = index.problems!.map((p) => p.message).sort();
  assertEquals(problems.length, 3);
  assertStringIncludes(
    problems.join("\n"),
    "flows/old@w.json: not part of the flows layout",
  );
  assertStringIncludes(problems.join("\n"), "flow folders can't be nested");
  assertStringIncludes(
    problems.join("\n"),
    '"misc" must be an @namespace folder',
  );
});

Deno.test("a flow.json whose name doesn't match its folder is an error, never pushed", async () => {
  const server = new FakeServer();
  const root = makeProject({ "flows/@w/moved/flow.json": flow("original@w") });
  const ctx = await sync(root, server);
  assertStringIncludes(
    ctx.out.text(),
    'flow.json names the flow "original@w", but its folder is for "moved@w"',
  );
  assertEquals(server.writes(), []);
  assertEquals(ctx.failures.length, 1);
});

Deno.test("new flows from the server go to their derived folder, with no folder prompt", async () => {
  const server = new FakeServer().put("flows", flow("n@campus:accounts"));
  const root = makeProject();
  const ctx = await sync(root, server, {}, ["create-local"]);
  assertEquals(ctx.prompter.prompts.length, 1);
  assert(fileExists(root, "flows/@campus/+accounts/n/flow.json"));
  assert(fileExists(root, "flows/@campus/+accounts/n/processors.js"));
});

Deno.test("a server flow that can't be laid out isn't offered for creation", async () => {
  const server = new FakeServer().put("flows", flow("a@b@c"));
  const ctx = await sync(makeProject(), server, { preferServer: true });
  assertStringIncludes(ctx.out.text(), 'more than one "@"');
  const interactive = await sync(makeProject(), server, { allowDelete: true }, [
    "nothing",
  ]);
  assertEquals(interactive.prompter.prompts[0].choices, [
    "Nothing",
    "Delete flow on flow.test",
    "Show full diff",
  ]);
});

Deno.test("a new trigger is created in its flow's folder, even when the flow is new too", async () => {
  const server = new FakeServer()
    .put("flows", flow("f@w"))
    .put(
      "flowTriggerers",
      trigger("http_f", { orchestratorName: "f@w" }),
      trigger("dns"),
    );
  const root = makeProject();
  const ctx = await sync(root, server, {}, [
    "create-local", // flow f@w
    "create-local", // trigger dns (no flow): asks for a folder in triggers/
    ".",
    "create-local", // trigger http_f: goes next to its flow
  ]);
  assertEquals(
    ctx.prompter.prompts.map((p) => p.message).filter((m) =>
      m.startsWith("Choose")
    ),
    [
      "Choose a folder in triggers",
    ],
  );
  assert(fileExists(root, "flows/@w/f/http_f.trigger.json"));
  assert(fileExists(root, "triggers/dns.json"));
  const next = await sync(root, server);
  assertEquals(next.prompter.prompts, []);
});

/** f@w and g@w synced, with trigger t running f@w in f's folder. */
async function projectWithTrigger() {
  const server = new FakeServer()
    .put("flows", flow("f@w"), flow("g@w"))
    .put("flowTriggerers", trigger("t", { orchestratorName: "f@w" }));
  const root = makeProject();
  await sync(root, server, { preferServer: true, forceDefaultFolder: true });
  assert(fileExists(root, "flows/@w/f/t.trigger.json"));
  return { root, server };
}

Deno.test("a trigger pointed at another flow is reported and, if you agree, moved", async () => {
  const { root, server } = await projectWithTrigger();
  server.put("flowTriggerers", trigger("t", { orchestratorName: "g@w" }));
  const ctx = await sync(root, server, {}, [true]);
  assertStringIncludes(
    ctx.out.text(),
    "The trigger t is in flows/@w/f/t.trigger.json, but it runs the flow g@w.",
  );
  assertEquals(
    ctx.prompter.prompts.at(-1)!.message,
    "Move it to flows/@w/g/t.trigger.json?",
  );
  assert(fileExists(root, "flows/@w/g/t.trigger.json"));
  assertFalse(fileExists(root, "flows/@w/f/t.trigger.json"));
  assertEquals(
    readJson(root, "flows/@w/g/t.trigger.json").config.orchestratorName,
    "g@w",
  );
  // Moving doesn't change anything on the server, and the record still holds.
  const next = await sync(root, server);
  assertEquals(next.prompter.prompts, []);
  assertEquals(server.writes(), []);
});

Deno.test("with -l, or when declined, a misplaced trigger is only reported", async () => {
  for (
    const [options, answers] of [[{ preferServer: true }, []], [{}, [
      false,
    ]]] as const
  ) {
    const { root, server } = await projectWithTrigger();
    server.put("flowTriggerers", trigger("t", { orchestratorName: "g@w" }));
    const ctx = await sync(root, server, options, [...answers]);
    assertStringIncludes(
      ctx.out.text(),
      "It belongs in flows/@w/g/t.trigger.json",
    );
    assert(fileExists(root, "flows/@w/f/t.trigger.json"));
  }
});

Deno.test("deleting a flow locally keeps its trigger, which is then offered a move to triggers/", async () => {
  const { root, server } = await projectWithTrigger();
  server.data.get("flows")!.delete("f@w");
  const ctx = await sync(root, server, { allowDelete: true }, [
    "delete-local",
    true,
  ]);
  assertFalse(fileExists(root, "flows/@w/f/flow.json"));
  assertStringIncludes(ctx.out.text(), "which isn't in this folder");
  assert(fileExists(root, "triggers/t.json"));
  assertFalse(
    fileExists(root, "flows/@w/f"),
    "the emptied flow folder is removed",
  );
});

Deno.test("check lists misplaced triggers without failing", async () => {
  const { root, server } = await projectWithTrigger();
  Deno.renameSync(
    join(root, "flows/@w/f/t.trigger.json"),
    join(root, "flows/@w/g/t.trigger.json"),
  );
  const out = new CaptureOutput();
  const code = await main(["check"], {
    root,
    fetch: server.fetch,
    out,
    prompter: new ScriptedPrompter(),
  });
  assertEquals(code, 0);
  assertStringIncludes(
    out.text(),
    "misplaced          trigger t is in flows/@w/g/t.trigger.json, but it runs the flow f@w; it belongs in flows/@w/f/t.trigger.json",
  );
});

Deno.test("a trigger in both a flow folder and triggers/ is a duplicate", async () => {
  const { root, server } = await projectWithTrigger();
  writeFiles(root, {
    "triggers/t.json": trigger("t", { orchestratorName: "f@w" }),
  });
  await assertRejects(
    () => runSync(makeContext(root, server)),
    DuplicateNamesError,
  );
});
