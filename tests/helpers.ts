import { ensureDirSync } from "@std/fs";
import { dirname, join } from "@std/path";
import { createClient, type FetchFn } from "../src/client.ts";
import { SyncState } from "../src/state.ts";
import type { SyncContext, SyncOptions } from "../src/sync/types.ts";
import type { Output, Prompter } from "../src/ui.ts";

export const SERVER_URL = "https://flow.test";

type Obj = Record<string, unknown>;

const ENDPOINTS: Record<string, (o: Obj) => string> = {
  flows: (o) => o.name as string,
  sharedConfig: (o) => o.referenceId as string,
  flowTriggerers: (o) =>
    ((o.config ?? o.invalidConfig) as { name: string }).name,
  resourceCollections: (o) => o.collectionId as string,
};

export type Call = { method: string; path: string; body?: unknown };

const fixture = (name: string) =>
  Deno.readTextFileSync(new URL(`./fixtures/docs/${name}`, import.meta.url));

export const DOCS_FIXTURES: Record<string, string> = {
  "index.html": fixture("index.html"),
  "json/classes.js": fixture("classes.js"),
  "json/symbols.js": fixture("symbols.js"),
};

/** An in-memory flow server speaking the `/repository/*` endpoints. */
export class FakeServer {
  data = new Map<string, Map<string, Obj>>(
    Object.keys(ENDPOINTS).map((e) => [e, new Map()]),
  );
  calls: Call[] = [];
  /** Applied to every POSTed object, to simulate server-side defaults. */
  normalize?: (endpoint: string, obj: Obj) => Obj;
  /** Answers every request matching `method path` with this response. */
  failures = new Map<string, { status: number; body: string }>();
  /** Makes `fetch` throw, like a VPN drop. */
  unreachable = false;
  /** The docs files served under /static/docs (trimmed copies of a real server's). */
  docs: Record<string, string> | null = { ...DOCS_FIXTURES };

  put(endpoint: string, ...objs: Obj[]) {
    for (const obj of objs) {
      this.data.get(endpoint)!.set(
        ENDPOINTS[endpoint](obj),
        structuredClone(obj),
      );
    }
    return this;
  }

  get(endpoint: string, name: string): Obj | undefined {
    return this.data.get(endpoint)!.get(name);
  }

  writes() {
    return this.calls.filter((c) => c.method !== "GET");
  }

  /** Requests to the config endpoints (not the docs). */
  configCalls() {
    return this.calls.filter((c) => c.path.startsWith("/repository/"));
  }

  fetch: FetchFn = (input, init) => {
    const url = new URL(input);
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, path: url.pathname, body });
    if (this.unreachable) {
      return Promise.reject(new TypeError("error sending request: dns error"));
    }
    const failure = this.failures.get(`${method} ${url.pathname}`);
    if (failure) {
      return Promise.resolve(
        new Response(failure.body, { status: failure.status }),
      );
    }
    if (url.pathname.startsWith("/static/docs/")) {
      const file = this.docs?.[url.pathname.slice("/static/docs/".length)];
      return Promise.resolve(
        file === undefined
          ? new Response("not found", { status: 404 })
          : new Response(file, { headers: { "content-type": "text/html" } }),
      );
    }
    const [, repository, endpoint, ...rest] = url.pathname.split("/");
    const store = this.data.get(endpoint);
    if (repository !== "repository" || !store) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    const json = (value: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          headers: { "content-type": "application/json" },
        }),
      );
    if (method === "GET") {
      // The server adds metadata, which pathisync must ignore.
      return json(
        [...store.values()].map((o) => ({
          ...structuredClone(o),
          metadata: { author: "someone", created: 1, modified: 2 },
        })),
      );
    }
    if (method === "POST") {
      const stored = this.normalize ? this.normalize(endpoint, body) : body;
      store.set(ENDPOINTS[endpoint](stored), structuredClone(stored));
      return json({});
    }
    if (method === "DELETE") {
      store.delete(decodeURIComponent(rest.join("/")));
      return json({});
    }
    return Promise.resolve(new Response("bad method", { status: 405 }));
  };
}

/** Creates a temp project. Objects are written as pathisync writes JSON. */
export function makeProject(files: Record<string, string | Obj> = {}): string {
  const root = Deno.makeTempDirSync({ prefix: "pathisync-test-" });
  writeFiles(root, {
    ".env": `PATHIFY_TOKEN=test-token\nFLOW_SERVER_URL=${SERVER_URL}\n`,
    ...files,
  });
  return root;
}

export function writeFiles(root: string, files: Record<string, string | Obj>) {
  for (const [path, content] of Object.entries(files)) {
    ensureDirSync(dirname(join(root, path)));
    Deno.writeTextFileSync(
      join(root, path),
      typeof content === "string"
        ? content
        : JSON.stringify(content, null, 2) + "\n",
    );
  }
}

export const readJson = (root: string, path: string) =>
  JSON.parse(Deno.readTextFileSync(join(root, path)));

export const readText = (root: string, path: string) =>
  Deno.readTextFileSync(join(root, path));

export const fileExists = (root: string, path: string) => {
  try {
    Deno.statSync(join(root, path));
    return true;
  } catch (_) {
    return false;
  }
};

export type Answer = string | boolean;

/** Answers prompts from a script, failing on any prompt it didn't expect. */
export class ScriptedPrompter implements Prompter {
  prompts: { message: string; choices?: string[] }[] = [];
  constructor(public answers: Answer[] = []) {}

  #next(message: string): Answer {
    if (!this.answers.length) throw new Error(`Unexpected prompt: ${message}`);
    return this.answers.shift()!;
  }

  select<T extends string>(
    message: string,
    choices: { name: string; value: T }[],
  ): Promise<T> {
    this.prompts.push({ message, choices: choices.map((c) => c.name) });
    const answer = this.#next(message);
    const choice = choices.find((c) => c.value === answer || c.name === answer);
    if (!choice) {
      throw new Error(
        `Answer ${answer} is not a choice for "${message}": ${
          choices.map((c) => c.value).join(", ")
        }`,
      );
    }
    return Promise.resolve(choice.value);
  }

  confirm(message: string): Promise<boolean> {
    this.prompts.push({ message });
    return Promise.resolve(this.#next(message) as boolean);
  }

  input(message: string): Promise<string> {
    this.prompts.push({ message });
    return Promise.resolve(this.#next(message) as string);
  }

  pager(_text: string): Promise<void> {
    this.prompts.push({ message: "<pager>" });
    return Promise.resolve();
  }
}

export class CaptureOutput implements Output {
  lines: string[] = [];
  log = (message: string) => void this.lines.push(message);
  warn = (message: string) => void this.lines.push(message);
  error = (message: string) => void this.lines.push(message);
  text = () => this.lines.join("\n");
}

export function makeContext(
  root: string,
  server: FakeServer,
  options: Partial<SyncOptions> = {},
  answers: Answer[] = [],
): SyncContext & { prompter: ScriptedPrompter; out: CaptureOutput } {
  return {
    root,
    client: createClient({
      serverUrl: SERVER_URL,
      token: "test-token",
      fetch: server.fetch,
    }),
    state: SyncState.load(root, SERVER_URL, options.mode !== "check"),
    prompter: new ScriptedPrompter(answers),
    out: new CaptureOutput(),
    options: {
      mode: "interactive",
      preferServer: false,
      allowDelete: false,
      forceDefaultFolder: false,
      allowBundled: false,
      showDiff: true,
      ...options,
    },
    failures: [],
  };
}

// Small config builders.

export function flow(name: string, extra: Obj = {}): Obj {
  return {
    name,
    steps: ["transform"],
    processors: {
      transform: {
        className: "dataMapper",
        config: {
          name: "transform",
          classPath: "dataMapper",
          jsFunc: "\nreturn item;\n",
        },
      },
    },
    description: "",
    type: "flow",
    entityId: `f:${name}`,
    ...extra,
  };
}

export function sharedConfig(referenceId: string, extra: Obj = {}): Obj {
  return {
    referenceId,
    secure: false,
    entityId: `sc:${referenceId}`,
    type: "sharedConfig",
    config: { value: 1 },
    ...extra,
  };
}

export function trigger(name: string, extra: Obj = {}): Obj {
  return {
    classPath: "http",
    config: { name, bundle: null, path: `/${name}`, ...extra },
    type: "statefulBehaviour",
    entityId: `sb:${name}`,
    lastRun: "Never",
  };
}

const b64 = (text: string) => btoa(text);

export function collection(
  collectionId: string,
  resources: { id: string; path: string; content: string }[],
  extra: Obj = {},
): Obj {
  return {
    collectionId,
    entityId: `rc:${collectionId}`,
    type: "resourceCollection",
    resources: resources.map((r) => ({
      resourceId: r.id,
      resourceCollectionId: collectionId,
      resourceStatusCode: 200,
      resourceAccessorPath: r.path,
      resourceAccessorMethod: "GET",
      resourceAccessorHeaders: [],
      resourceStateful: false,
      resourceHeaders: [["Content-Type", "text/html"]],
      resourceBytes: b64(r.content),
      resourceDescription: "",
    })),
    ...extra,
  };
}

/** The local `_collection.json` for a server collection (bytes cleared). */
export function localCollection(remote: Obj): Obj {
  return {
    ...remote,
    resources: (remote.resources as Obj[]).map((r) => ({
      ...r,
      resourceBytes: "",
    })),
  };
}
