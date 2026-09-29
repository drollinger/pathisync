// Reads the flow server's reference docs. The docs page loads its data from
// `json/classes.js` and `json/symbols.js`, and `index.html` itself adds the
// globals that installed plugins provide (FlowSGI modules, such as the
// classes of a vendor integration). The docs are public, so no token is sent.

import type { Client } from "../client.ts";

export type DocSymbol = {
  symbol: string;
  /** `function`, `object` or `constant`. */
  type: string;
  /** Description, as HTML. */
  hint?: string;
  /** Parameter names (top-level functions). */
  args?: string[];
  /** A signature like `function(msg,args){...}`, or the function's code. */
  body?: string;
  /** The id of the symbol's docs page. */
  fsClassName?: string;
  children?: DocSymbol[];
};

export type DocClass = {
  className: string;
  jsClassName: string;
  aliases: string[];
  fsClassName: string;
};

/** A global defined by an installed plugin. */
export type DocLib = {
  jsClassName: string;
  hint?: string;
  fsClassName: string;
  /** How the runtime defines it, e.g. `…lazyType('code.data.x.Y', …)`. */
  js: string;
};

export type Docs = {
  server: string;
  version?: string;
  symbols: DocSymbol[];
  classes: DocClass[];
  pluginLibs: DocLib[];
};

export const DOCS_PATH = "/static/docs";

export async function fetchDocs(client: Client): Promise<Docs> {
  const text = async (path: string) =>
    await (await client.request("GET", `${DOCS_PATH}/${path}`)).text();
  const [indexHtml, classesJs, symbolsJs] = await Promise.all([
    text("index.html"),
    text("json/classes.js"),
    text("json/symbols.js"),
  ]);
  return parseDocs(client.serverUrl, { indexHtml, classesJs, symbolsJs });
}

export function parseDocs(
  server: string,
  files: { indexHtml: string; classesJs: string; symbolsJs: string },
): Docs {
  return {
    server,
    version: /docsSingleVersion\s*=\s*'([^']*)'/.exec(files.indexHtml)?.[1],
    symbols: assignedArray(files.symbolsJs, "symbols") as DocSymbol[],
    classes: assignedArray(files.classesJs, "classes") as DocClass[],
    pluginLibs: pushedArrays(files.indexHtml, "jsLibs") as DocLib[],
  };
}

/** The array in `var <name> = [...];`. */
function assignedArray(js: string, name: string): unknown[] {
  const match = new RegExp(`\\b${name}\\s*=\\s*\\[`).exec(js);
  if (!match) {
    throw new Error(`the docs file for ${name} has an unexpected format`);
  }
  return jsonArrayAt(js, match.index + match[0].length - 1);
}

/** Every array pushed onto `window.<name>` by inline scripts. */
function pushedArrays(html: string, name: string): unknown[] {
  const found: unknown[] = [];
  // (function(){var t=window.jsLibs;if(!t){t=window.jsLibs=[];}Array.prototype.push.apply(t,[…]);})();
  const pattern = new RegExp(
    `window\\.${name}\\s*;\\s*if\\s*\\(!t\\)\\s*\\{\\s*t\\s*=\\s*window\\.${name}\\s*=\\s*\\[\\]\\s*;?\\s*\\}\\s*` +
      `Array\\.prototype\\.push\\.apply\\(t,\\s*\\[`,
    "g",
  );
  for (const match of html.matchAll(pattern)) {
    found.push(...jsonArrayAt(html, match.index! + match[0].length - 1));
  }
  return found;
}

/** Parses the JSON array starting at `text[start] === "["`. */
function jsonArrayAt(text: string, start: number): unknown[] {
  let depth = 0, inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      if (--depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error("the docs data ends unexpectedly");
}
