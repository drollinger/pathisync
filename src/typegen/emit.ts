// Writes `types/pathify.d.ts`. Everything is `any` unless the docs say
// otherwise, every parameter is optional, and objects and classes accept
// undocumented members, so the checker flags misspelled globals without
// flooding flows with false errors.

import { type DocLib, type Docs, DOCS_PATH, type DocSymbol } from "./docs.ts";

const RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends " +
    "false finally for function if import in instanceof new null return super switch this throw " +
    "true try typeof var void while with implements interface let package private protected " +
    "public static yield await arguments eval"
  ).split(" "),
);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export const isIdentifier = (name: string) =>
  IDENTIFIER.test(name) && !RESERVED.has(name);

/** Globals from the es2015 lib that the docs must not redeclare. */
const LIB_GLOBALS = new Set(
  (
    "Array ArrayBuffer Boolean DataView Date Error EvalError Float32Array Float64Array Function " +
    "Infinity Int16Array Int32Array Int8Array JSON Map Math NaN Number Object Promise Proxy " +
    "RangeError ReferenceError Reflect RegExp Set String Symbol SyntaxError TypeError URIError " +
    "Uint16Array Uint32Array Uint8Array Uint8ClampedArray WeakMap WeakSet decodeURI " +
    "decodeURIComponent encodeURI encodeURIComponent escape eval isFinite isNaN parseFloat " +
    "parseInt undefined unescape"
  ).split(" "),
);

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** A docs hint (HTML) as plain text for hover docs: `<code>x</code>` becomes `` `x` ``. */
export function hintText(html = ""): string {
  return html
    .replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, "")
    .replace(
      /&(#\d+|\w+);/g,
      (whole, code: string) =>
        code[0] === "#"
          ? String.fromCodePoint(Number(code.slice(1)))
          : ENTITIES[code] ?? whole,
    )
    .split("\n").map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line, i, all) => line || (i > 0 && all[i - 1]))
    .join("\n").trim();
}

function docComment(lines: string[], indent: string): string {
  const text = lines.filter(Boolean).join("\n").replaceAll("*/", "*\\/").trim();
  if (!text) return "";
  const body = text.split("\n").map((l) => `${indent} *${l ? " " + l : ""}`);
  return `${indent}/**\n${body.join("\n")}\n${indent} */\n`;
}

function sanitizeParams(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw, i) => {
    let name = raw.replace(/^\.\.\./, "").split(".").pop()!.replace(
      /[^A-Za-z0-9_$]/g,
      "_",
    );
    if (!name) name = `arg${i}`;
    if (/^[0-9]/.test(name) || RESERVED.has(name)) name = "_" + name;
    while (used.has(name)) name += "_";
    used.add(name);
    return name;
  });
}

/**
 * Named parameters, all optional, then a rest parameter: JavaScript functions
 * accept extra arguments, and the logging helpers (`trace(msg, …)`) rely on it.
 */
function optional(names: string[]): string {
  const params = sanitizeParams(names);
  let rest = "more";
  while (params.includes(rest)) rest += "_";
  return [...params.map((n) => `${n}?: any`), `...${rest}: any[]`].join(", ");
}

/**
 * A function's parameters: its `args`, else a signature body like
 * `function(html,policy){...}`. Other bodies are real code with unknown
 * parameters, so they take any arguments.
 */
export function paramList(symbol: Pick<DocSymbol, "args" | "body">): string {
  if (symbol.args) return optional(symbol.args);
  const m = /^function\s*\(([^)]*)\)\s*\{\s*\.\.\.\s*\}$/.exec(
    (symbol.body ?? "").trim(),
  );
  if (!m) return "...args: any[]";
  return optional(m[1].split(",").map((p) => p.trim()).filter(Boolean));
}

const propertyName = (name: string) =>
  IDENTIFIER.test(name) ? name : JSON.stringify(name);

const byName = (a: DocSymbol, b: DocSymbol) =>
  a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;

export type EmitResult = {
  text: string;
  globals: number;
  classes: number;
  pluginGlobals: number;
  skipped: string[];
};

export function emitDeclarations(docs: Docs): EmitResult {
  const see = (section: string, id?: string) =>
    id ? `@see ${docs.server}${DOCS_PATH}/${section}/${id}.html` : "";
  const symbolDoc = (s: DocSymbol, indent: string) =>
    docComment([hintText(s.hint), see("jsSymbols", s.fsClassName)], indent);

  /** An object's documented members, as a type literal. */
  const objectType = (obj: DocSymbol, indent: string): string => {
    const lines: string[] = [];
    const emitted = new Set<string>();
    for (const child of [...(obj.children ?? [])].sort(byName)) {
      const name = propertyName(child.symbol);
      let line: string;
      if (child.type === "function") {
        line = `${indent}  ${name}(${paramList(child)}): any;`;
      } else if (child.type === "object" && child.children?.length) {
        line = `${indent}  ${name}: ${objectType(child, indent + "  ")};`;
      } else {
        line = `${indent}  ${name}: any;`;
      }
      // Overloads are kept unless identical; other duplicates are dropped.
      const key = child.type === "function" ? line : name;
      if (emitted.has(key)) continue;
      emitted.add(key);
      lines.push(symbolDoc(child, indent + "  ") + line);
    }
    lines.push(`${indent}  [key: string]: any;`);
    return `{\n${lines.join("\n")}\n${indent}}`;
  };

  const skipped: string[] = [];
  const declared = new Set<string>();
  const claim = (name: string) => {
    if (!isIdentifier(name) || LIB_GLOBALS.has(name)) {
      skipped.push(name);
      return false;
    }
    if (declared.has(name)) return false;
    declared.add(name);
    return true;
  };

  // Documented globals come first, so they win over a class of the same name.
  const symbolBlocks: string[] = [];
  const grouped = new Map<string, DocSymbol[]>();
  for (const s of docs.symbols) {
    grouped.set(s.symbol, [...(grouped.get(s.symbol) ?? []), s]);
  }
  for (const name of [...grouped.keys()].sort()) {
    if (!claim(name)) continue;
    const overloads = grouped.get(name)!;
    const functions = overloads.filter((s) => s.type === "function");
    if (functions.length) {
      const seen = new Set<string>();
      for (const s of functions) {
        const line = `declare function ${name}(${paramList(s)}): any;`;
        if (seen.has(line)) continue;
        seen.add(line);
        symbolBlocks.push(symbolDoc(s, "") + line);
      }
      continue;
    }
    const s = overloads[0];
    const type = s.type === "object" && s.children?.length
      ? objectType(s, "")
      : "any";
    symbolBlocks.push(`${symbolDoc(s, "")}declare var ${name}: ${type};`);
  }

  const classes = new Map<string, string>();
  for (const c of docs.classes) {
    // A class's aliases are constructible too, with dots turned into underscores.
    for (
      const name of [
        c.jsClassName,
        ...(c.aliases ?? []).map((a) => a.replaceAll(".", "_")),
      ]
    ) {
      if (!classes.has(name) && !declared.has(name) && isIdentifier(name)) {
        classes.set(
          name,
          classDeclaration(
            name,
            `\`${c.className}\` ${see("classes", c.fsClassName)}`,
          ),
        );
      }
    }
  }
  for (const name of classes.keys()) claim(name);

  const plugins = new Map<string, string>();
  for (const lib of docs.pluginLibs) {
    const name = lib.jsClassName;
    if (declared.has(name) || plugins.has(name) || !claim(name)) continue;
    plugins.set(name, pluginDeclaration(lib, see("jsLibs", lib.fsClassName)));
  }

  const sorted = (m: Map<string, string>) =>
    [...m].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, v]) => v);
  const header = [
    `// Generated by pathisync from ${docs.server}${DOCS_PATH}${
      docs.version ? ` (docs version ${docs.version})` : ""
    }.`,
    "// Do not edit by hand: every sync regenerates it. Runtime-injected names",
    "// the docs don't list belong in globals.d.ts.",
    "",
    "",
  ].join("\n");
  const sections = [
    symbolBlocks.join("\n\n"),
    "// Classes",
    sorted(classes).join("\n"),
    "// Provided by installed plugins (FlowSGI modules)",
    sorted(plugins).join("\n"),
  ];
  return {
    text: header + sections.filter(Boolean).join("\n\n") + "\n",
    globals: symbolBlocks.length
      ? [...grouped.keys()].filter((n) => declared.has(n)).length
      : 0,
    classes: classes.size,
    pluginGlobals: plugins.size,
    skipped: [...new Set(skipped)].sort(),
  };
}

/** One line per class keeps the file small and its diffs readable. */
function classDeclaration(name: string, doc: string): string {
  return `${
    oneLineDoc(doc)
  }\ndeclare class ${name} { constructor(...args: any[]); [key: string]: any; static [key: string]: any; }`;
}

const oneLineDoc = (doc: string) =>
  `/** ${doc.replace(/\s+/g, " ").replaceAll("*/", "*\\/").trim()} */`;

function pluginDeclaration(lib: DocLib, see: string): string {
  const vended = /lazyType\(\s*'([^']+)'/.exec(lib.js)?.[1];
  const doc = [vended ? `\`${vended}\`` : "", hintText(lib.hint), see]
    .filter(Boolean).join(" ");
  return vended
    ? classDeclaration(lib.jsClassName, doc)
    : `${oneLineDoc(doc)}\ndeclare var ${lib.jsClassName}: any;`;
}
