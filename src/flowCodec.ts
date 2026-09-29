// Converts between the server's form of a flow (JavaScript inline as JSON
// strings) and the local form: a `.json` file whose JavaScript fields are
// `{ "$fn": "<name>" }` pointers, plus a sibling `.js` file holding one
// `export function <name>() { … }` per pointer.

import type { FlowObj, Processor } from "./types.ts";

/** Processor config fields typed `Js` in the server's stream processor docs. */
export const JS_FIELDS: ReadonlySet<string> = new Set([
  "jsFunc",
  "func",
  "keyFunc",
  "valueFunc",
  "valueSerializer",
  "valueDeserializer",
  "predicateFunc",
  "selectorFunc",
  "valueStreamFunc",
  "valueRefFunc",
  "idRefFunc",
  "queueFunc",
  "groupingFunc",
  "flowOrchestratorFunc",
  "extract",
  "apply",
  "zipFileFilterFunc",
  "takeWhileFunc",
  "dropWhileFunc",
  "shouldRepeatFunc",
  "serializerFunc",
  "ownerFunc",
  "fieldSelectorFunc",
  "byteEncoderFunc",
]);

export type FnPointer = { $fn: string };

export const isPointer = (value: unknown): value is FnPointer =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  Object.keys(value).length === 1 &&
  typeof (value as FnPointer).$fn === "string";

export class FlowCodecError extends Error {
  override name = "FlowCodecError";
  constructor(readonly problems: string[]) {
    super(problems.join("\n"));
  }
}

type Extracted = {
  name: string;
  processor: string;
  field: string;
  body: string;
};

/** Processor keys in pipeline order: `steps` first, then the rest in key order. */
function processorOrder(flow: FlowObj): string[] {
  const keys = Object.keys(flow.processors ?? {});
  const ordered: string[] = [];
  for (const step of flow.steps ?? []) {
    if (keys.includes(step) && !ordered.includes(step)) ordered.push(step);
  }
  for (const key of keys) if (!ordered.includes(key)) ordered.push(key);
  return ordered;
}

export function functionName(
  processor: string,
  field: string,
  used: Set<string>,
): string {
  let base = `${processor}_${field}`.replace(/[^A-Za-z0-9_$]/g, "_");
  if (/^[0-9]/.test(base)) base = "_" + base;
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
  used.add(name);
  return name;
}

function extract(flow: FlowObj): Extracted[] {
  const used = new Set<string>();
  const found: Extracted[] = [];
  for (const key of processorOrder(flow)) {
    const config = flow.processors[key]?.config;
    if (!config) continue;
    for (const [field, value] of Object.entries(config)) {
      if (JS_FIELDS.has(field) && typeof value === "string" && value !== "") {
        found.push({
          name: functionName(key, field, used),
          processor: key,
          field,
          body: value,
        });
      }
    }
  }
  return found;
}

/**
 * Server form → local files. `js` is null when the flow has no JavaScript
 * worth extracting (`null` and `""` fields stay inline).
 */
export function explode(
  flow: FlowObj,
): { json: FlowObj; js: string | null; count: number } {
  const json = structuredClone(flow);
  const found = extract(flow);
  for (const { name, processor, field } of found) {
    json.processors[processor].config![field] = { $fn: name };
  }
  return {
    json,
    js: found.length ? joinFunctions(found) : null,
    count: found.length,
  };
}

/** Local files → server form. Throws `FlowCodecError` if they don't fit together. */
export function implode(
  json: FlowObj,
  js: string | null,
): { flow: FlowObj; warnings: string[] } {
  const flow = structuredClone(json);
  const problems: string[] = [];
  const warnings: string[] = [];
  const functions = new Map<string, string>();
  if (js !== null) {
    const split = splitFunctions(js);
    problems.push(...split.errors);
    for (const [name, body] of split.functions) functions.set(name, body);
  }
  const referenced = new Set<string>();
  for (const [key, processor] of Object.entries(flow.processors ?? {})) {
    const config = (processor as Processor).config;
    if (!config) continue;
    for (const [field, value] of Object.entries(config)) {
      if (!isPointer(value)) continue;
      const body = functions.get(value.$fn);
      if (body === undefined) {
        problems.push(
          js === null
            ? `processors.${key}.config.${field} points to function ${value.$fn}, but there is no .js file`
            : `processors.${key}.config.${field} points to function ${value.$fn}, which is not in the .js file`,
        );
        continue;
      }
      referenced.add(value.$fn);
      config[field] = body;
    }
  }
  for (const name of functions.keys()) {
    if (!referenced.has(name)) {
      warnings.push(
        `function ${name} is not referenced by any "$fn" pointer and will not be pushed`,
      );
    }
  }
  if (problems.length) throw new FlowCodecError(problems);
  return { flow, warnings };
}

const indent = (body: string) =>
  body.split("\n").map((line) => line.length ? "  " + line : line).join("\n");

const unindent = (body: string) =>
  body.split("\n").map((line) => line.startsWith("  ") ? line.slice(2) : line)
    .join("\n");

export function joinFunctions(
  functions: { name: string; body: string }[],
): string {
  return functions.map(({ name, body }) =>
    `export function ${name}() {\n${indent(body)}\n}`
  ).join("\n\n") + "\n";
}

const OPENING = /^export function ([A-Za-z_$][A-Za-z0-9_$]*)\(\) \{$/;

/**
 * Splits a flow's `.js` file line by line rather than with a parser, so a
 * syntax error inside one function doesn't stop the others being recovered.
 */
export function splitFunctions(
  js: string,
): { functions: Map<string, string>; errors: string[] } {
  const lines = js.replaceAll("\r\n", "\n").split("\n");
  const functions = new Map<string, string>();
  const errors: string[] = [];
  const openings: { line: number; name: string }[] = [];
  lines.forEach((line, i) => {
    const match = OPENING.exec(line);
    if (match) openings.push({ line: i, name: match[1] });
  });

  // Everything outside a function must be blank or a comment.
  const checkOutside = (from: number, to: number) => {
    let inBlock = false;
    for (let i = from; i < to; i++) {
      const text = lines[i].trim();
      if (inBlock) {
        if (text.includes("*/")) inBlock = false;
      } else if (text.startsWith("/*")) {
        inBlock = !text.includes("*/", 2);
      } else if (text !== "" && !text.startsWith("//")) {
        errors.push(
          `line ${
            i + 1
          }: text outside a function would never reach the server: ${
            lines[i].slice(0, 60)
          }`,
        );
      }
    }
  };

  checkOutside(0, openings[0]?.line ?? lines.length);
  openings.forEach(({ line, name }, k) => {
    const end = openings[k + 1]?.line ?? lines.length;
    let close = -1;
    for (let i = end - 1; i > line; i--) {
      if (lines[i] === "}") {
        close = i;
        break;
      }
    }
    if (close === -1) {
      errors.push(
        `line ${
          line + 1
        }: function ${name} has no closing "}" at the start of a line`,
      );
      return;
    }
    if (functions.has(name)) {
      errors.push(`line ${line + 1}: function ${name} is defined twice`);
    } else {
      functions.set(name, unindent(lines.slice(line + 1, close).join("\n")));
    }
    checkOutside(close + 1, end);
  });
  return { functions, errors };
}

/** Number of JavaScript fields whose code differs between two server-form flows. */
export function changedFunctionCount(a: FlowObj, b: FlowObj): number {
  let count = 0;
  const keys = new Set([
    ...Object.keys(a.processors ?? {}),
    ...Object.keys(b.processors ?? {}),
  ]);
  for (const key of keys) {
    const ca = a.processors?.[key]?.config ?? {};
    const cb = b.processors?.[key]?.config ?? {};
    for (const field of JS_FIELDS) {
      const va = ca[field], vb = cb[field];
      if ((va ?? null) !== (vb ?? null)) count++;
    }
  }
  return count;
}
