import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  explode,
  FlowCodecError,
  functionName,
  implode,
  splitFunctions,
} from "../src/flowCodec.ts";
import type { FlowObj } from "../src/types.ts";

function flowWith(
  processors: Record<string, Record<string, unknown>>,
  steps = Object.keys(processors),
): FlowObj {
  return {
    name: "test@x",
    steps,
    processors: Object.fromEntries(
      Object.entries(processors).map((
        [k, config],
      ) => [k, { className: "dataMapper", config }]),
    ),
  };
}

function roundTrip(flow: FlowObj) {
  const { json, js } = explode(flow);
  assertEquals(implode(json, js).flow, flow);
  return { json, js };
}

Deno.test("keeps leading and trailing newlines exactly", () => {
  for (
    const body of ["\nreturn 1;\n", "return 1;\n", "\nreturn 1;", "\n\n\nx\n\n"]
  ) {
    roundTrip(flowWith({ a: { jsFunc: body } }));
  }
  const { js } = explode(flowWith({ a: { jsFunc: "\nreturn 1;\n" } }));
  assertEquals(js, "export function a_jsFunc() {\n\n  return 1;\n\n}\n");
});

Deno.test("bodies made only of whitespace lines", () => {
  for (const body of ["\n", " ", "  \n \n\t", "\n\n", "   "]) {
    roundTrip(flowWith({ a: { jsFunc: body } }));
  }
});

Deno.test("tabs are kept after the added indentation", () => {
  const body = "if (x) {\n\treturn 1;\n\t\t// deep\n}";
  const { js } = roundTrip(flowWith({ a: { jsFunc: body } }));
  assertStringIncludes(js!, "\n  \treturn 1;\n");
});

Deno.test("multi-line template literals and odd indentation", () => {
  roundTrip(flowWith({
    a: { jsFunc: "var s = `\nline one\n  line two\n no indent\n`;\nreturn s;" },
    b: { func: " one space\n   three spaces\nnone" },
  }));
});

Deno.test("a body containing an unindented } line", () => {
  const body = "function f() {\nreturn 1;\n}\nreturn f();";
  const { js } = roundTrip(
    flowWith({ a: { jsFunc: body }, b: { keyFunc: "x" } }),
  );
  // An unindented `}` typed by hand inside a body still splits correctly.
  const edited = js!.replace("  }\n  return f();", "}\n  return f();");
  const { functions, errors } = splitFunctions(edited);
  assertEquals(errors, []);
  assertEquals(functions.get("a_jsFunc"), body);
  assertEquals(functions.get("b_keyFunc"), "x");
});

Deno.test("processor keys with . : @ - make valid, unique names", () => {
  const flow = flowWith({
    "generic.call": { jsFunc: "1" },
    "campus:user@widgets": { jsFunc: "2" },
    "a-b": { jsFunc: "3" },
    "a_b": { jsFunc: "4" },
    "9lives": { jsFunc: "5" },
  });
  const { json, js } = roundTrip(flow);
  const names = Object.values(json.processors).map((p) =>
    (p.config!.jsFunc as { $fn: string }).$fn
  );
  assertEquals(names, [
    "generic_call_jsFunc",
    "campus_user_widgets_jsFunc",
    "a_b_jsFunc",
    "a_b_jsFunc_2",
    "_9lives_jsFunc",
  ]);
  assertEquals(splitFunctions(js!).functions.size, 5);
});

Deno.test("name collisions get _2, _3", () => {
  const used = new Set<string>();
  assertEquals(functionName("a.b", "func", used), "a_b_func");
  assertEquals(functionName("a-b", "func", used), "a_b_func_2");
  assertEquals(functionName("a:b", "func", used), "a_b_func_3");
});

Deno.test("null and empty fields stay inline", () => {
  const flow = flowWith({ a: { jsFunc: null, keyFunc: "", valueFunc: "x" } });
  const { json, js } = roundTrip(flow);
  assertEquals(json.processors.a.config!.jsFunc, null);
  assertEquals(json.processors.a.config!.keyFunc, "");
  assertEquals(json.processors.a.config!.valueFunc, { $fn: "a_valueFunc" });
  assertEquals(js, "export function a_valueFunc() {\n  x\n}\n");
  assertEquals(explode(flowWith({ a: { jsFunc: null } })).js, null);
});

Deno.test("hand-written inline strings are still accepted", () => {
  const flow = flowWith({
    a: { jsFunc: "return 1;" },
    b: { jsFunc: "return 2;" },
  });
  const { json, js } = explode(flow);
  // Hand-edited: b is back to an inline string, and its function removed.
  json.processors.b.config!.jsFunc = "return 2;";
  const onlyA = js!.split("\n\n")[0] + "\n";
  assertEquals(implode(json, onlyA).flow, flow);
  // A flow with only inline strings needs no processors.js.
  assertEquals(implode(flow, null).flow, flow);
});

Deno.test("only allowlisted processor-level fields are extracted", () => {
  const flow = flowWith({
    a: {
      jsFunc: "1",
      schemaJSON: "{}",
      notJs: "return 1",
      testConfig: [{ testDataTransformFunc: "return 1" }],
    },
  });
  const { json } = roundTrip(flow);
  const config = json.processors.a.config!;
  assertEquals(config.schemaJSON, "{}");
  assertEquals(config.notJs, "return 1");
  assertEquals(config.testConfig, [{ testDataTransformFunc: "return 1" }]);
});

Deno.test("functions follow steps order, then the remaining processors", () => {
  const flow = flowWith(
    {
      z: { jsFunc: "z" },
      y: { jsFunc: "y", keyFunc: "yk" },
      x: { jsFunc: "x" },
      w: { jsFunc: "w" },
    },
    ["x", "y", "x", "shared@elsewhere", "z"],
  );
  const names = [...splitFunctions(explode(flow).js!).functions.keys()];
  assertEquals(names, [
    "x_jsFunc",
    "y_jsFunc",
    "y_keyFunc",
    "z_jsFunc",
    "w_jsFunc",
  ]);
});

Deno.test("processors without a config (shared processors) are skipped", () => {
  const flow: FlowObj = {
    name: "f",
    steps: ["s"],
    processors: {
      s: { sharedProcessor: "other" },
      t: { className: "x", config: { jsFunc: "1" } },
    },
  };
  roundTrip(flow);
});

Deno.test("a syntax error inside one function still recovers every function", () => {
  const js = [
    "// header comment",
    "export function a_jsFunc() {",
    "  var x = {{{ ;; this is not javascript",
    "  return (",
    "}",
    "",
    "/* a block",
    "   comment */",
    "export function b_jsFunc() {",
    "  return 2;",
    "}",
    "",
  ].join("\n");
  const { functions, errors } = splitFunctions(js);
  assertEquals(errors, []);
  assertEquals(
    functions.get("a_jsFunc"),
    "var x = {{{ ;; this is not javascript\nreturn (",
  );
  assertEquals(functions.get("b_jsFunc"), "return 2;");
});

Deno.test("text outside functions is an error", () => {
  const { errors } = splitFunctions(
    "var stray = 1;\nexport function a() {\n  1\n}\nreturn 2;\n",
  );
  assertEquals(errors.length, 2);
  assertStringIncludes(errors[0], "line 1");
  assertStringIncludes(errors[1], "line 5");
});

Deno.test("missing pointers are errors, unreferenced functions are warnings", () => {
  const flow = flowWith({ a: { jsFunc: "1" } });
  const { json, js } = explode(flow);
  const error = assertThrows(
    () => implode(json, js!.replace("a_jsFunc", "renamed")),
    FlowCodecError,
  );
  assertStringIncludes(error.message, "points to function a_jsFunc");
  assertThrows(() => implode(json, null), FlowCodecError, "no .js file");

  const extra = js + "\nexport function unused() {\n  1\n}\n";
  const { warnings } = implode(json, extra);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "unused");
});

Deno.test("a function without a closing brace is an error", () => {
  const { errors } = splitFunctions("export function a() {\n  return 1;\n");
  assertStringIncludes(errors[0], 'no closing "}"');
});

Deno.test("CRLF line endings from an editor don't change the code", () => {
  const flow = flowWith({ a: { jsFunc: "\nvar a = 1;\nreturn a;\n" } });
  const { json, js } = explode(flow);
  assertEquals(implode(json, js!.replaceAll("\n", "\r\n")).flow, flow);
});

Deno.test("editing one line in a function changes one line of the file", () => {
  const body = Array.from({ length: 20 }, (_, i) => `var v${i} = ${i};`).join(
    "\n",
  );
  const before = explode(flowWith({ a: { jsFunc: body } })).js!.split("\n");
  const after = explode(
    flowWith({ a: { jsFunc: body.replace("v7 = 7", "v7 = 70") } }),
  )
    .js!.split("\n");
  assertEquals(before.length, after.length);
  assertEquals(before.filter((line, i) => line !== after[i]).length, 1);
});
