// Checks that every flow in a project survives the local layout unchanged:
// implode(explode(x)) must deep-equal x. Reads local files only.
//
//   deno task roundtrip ../my-project

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { indexFlows, processorsPathFor } from "../src/flowLayout.ts";
import {
  explode,
  implode,
  joinFunctions,
  splitFunctions,
} from "../src/flowCodec.ts";
import type { FlowObj } from "../src/types.ts";

const root = Deno.args[0];
if (!root) {
  console.error("Usage: deno task roundtrip <project-dir>");
  Deno.exit(2);
}

const paths = [...indexFlows(root).files.values()].sort().map((json) => ({
  json,
  js: processorsPathFor(json),
}));
let passed = 0, functions = 0;
const failures: string[] = [];
for (const { json, js: jsPath } of paths) {
  try {
    let flow = JSON.parse(Deno.readTextFileSync(join(root, json))) as FlowObj;
    let js: string | null = null;
    try {
      js = Deno.readTextFileSync(join(root, jsPath));
    } catch (_) { /* a flow with no JavaScript */ }
    flow = implode(flow, js).flow;

    const exploded = explode(flow);
    functions += exploded.count;
    assertEquals(implode(exploded.json, exploded.js).flow, flow);
    if (exploded.js !== null) {
      const split = splitFunctions(exploded.js);
      assertEquals(split.errors, []);
      const again = joinFunctions(
        [...split.functions].map(([name, body]) => ({ name, body })),
      );
      assertEquals(again, exploded.js);
    }
    passed++;
  } catch (error) {
    failures.push(`${json}: ${(error as Error).message.split("\n")[0]}`);
  }
}

console.log(
  `${passed}/${paths.length} flows round-trip (${functions} functions)`,
);
if (failures.length) {
  console.log(failures.join("\n"));
  Deno.exit(1);
}
