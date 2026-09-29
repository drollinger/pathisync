import { assertEquals, assertStringIncludes } from "@std/assert";
import { setColorEnabled } from "@std/fmt/colors";
import { capLines, colorize, diffFiles, isTextResource } from "../src/diff.ts";
import { runSync } from "../src/sync/engine.ts";
import { flows } from "../src/sync/single.ts";
import {
  FakeServer,
  flow,
  makeContext,
  makeProject,
  writeFiles,
} from "./helpers.ts";

Deno.test("a one-line JS change is a one-line change in the .js section", async () => {
  setColorEnabled(false);
  const body = Array.from({ length: 30 }, (_, i) => `var v${i} = ${i};`).join(
    "\n",
  );
  const remote = flow("f");
  (remote.processors as Record<string, { config: Record<string, unknown> }>)
    .transform.config.jsFunc = body;
  const server = new FakeServer().put("flows", remote);
  const root = makeProject();
  await runSync(
    makeContext(root, server, { preferServer: true, forceDefaultFolder: true }),
    [flows],
  );
  const js = Deno.readTextFileSync(`${root}/flows/f/processors.js`);
  writeFiles(root, {
    "flows/f/processors.js": js.replace("var v12 = 12;", "var v12 = 1200;"),
  });

  const ctx = makeContext(root, server, {}, ["nothing"]);
  await runSync(ctx, [flows]);
  const lines = ctx.out.lines.join("\n").split("\n");
  assertEquals(lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")), [
    "+  var v12 = 1200;",
  ]);
  assertEquals(lines.filter((l) => l.startsWith("-") && !l.startsWith("---")), [
    "-  var v12 = 12;",
  ]);
  assertEquals(lines.filter((l) => l.startsWith("---")), [
    "--- remote (server)  processors.js",
  ]);
});

Deno.test("one-sided configs show the whole file as + or -", async () => {
  const onlyLocal = await diffFiles([], [{ name: "a.json", text: "1\n2\n" }]);
  assertStringIncludes(onlyLocal, "--- remote (server)  a.json (missing)");
  assertStringIncludes(onlyLocal, "+1\n+2");
  const onlyRemote = await diffFiles([{ name: "a.json", text: "1\n" }], []);
  assertStringIncludes(onlyRemote, "+++ local  a.json (missing)");
  assertStringIncludes(onlyRemote, "-1");
});

Deno.test("diffs are capped at 200 lines", () => {
  const text = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n");
  const capped = capLines(text).split("\n");
  assertEquals(capped.length, 201);
  assertEquals(capped[200], "… 50 more lines");
  assertEquals(capLines("a\nb"), "a\nb");
});

Deno.test("--no-diff hides the diff; Show full diff is still offered", async () => {
  const server = new FakeServer().put("flows", flow("f"));
  const root = makeProject({
    "flows/f/flow.json": { ...flow("f"), description: "x" },
  });
  const ctx = makeContext(root, server, { showDiff: false }, [
    "show-diff",
    "nothing",
  ]);
  await runSync(ctx, [flows]);
  assertEquals(ctx.out.text().includes("--- remote"), false);
  assertEquals(ctx.prompter.prompts[1].message, "<pager>");
});

Deno.test("-l runs print one-line summaries, not diffs", async () => {
  const server = new FakeServer().put("flows", flow("f"));
  const root = makeProject({
    "flows/f/flow.json": { ...flow("f"), description: "x" },
  });
  const ctx = makeContext(root, server, { preferServer: true });
  await runSync(ctx, [flows]);
  assertEquals(ctx.out.text().includes("--- remote"), false);
  assertStringIncludes(
    ctx.out.text(),
    "↓ flow f: unknown, overwriting local (-l)",
  );
});

Deno.test("color is used only when enabled (NO_COLOR, not a TTY)", () => {
  setColorEnabled(true);
  assertStringIncludes(colorize("+a"), "\x1b[32m");
  setColorEnabled(false);
  assertEquals(colorize("+a\n-b\n@@ x"), "+a\n-b\n@@ x");
});

Deno.test("text resources are recognized by content type or UTF-8 content", () => {
  const bytes = new TextEncoder().encode("héllo");
  assertEquals(
    isTextResource([["Content-Type", "text/html"]], new Uint8Array([0xff])),
    true,
  );
  assertEquals(
    isTextResource(
      [["content-type", "application/json"]],
      new Uint8Array([0xff]),
    ),
    true,
  );
  assertEquals(isTextResource([], bytes), true);
  assertEquals(
    isTextResource(
      [["Content-Type", "image/png"]],
      new Uint8Array([0x89, 0xff, 0]),
    ),
    false,
  );
});
