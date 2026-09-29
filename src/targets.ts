// Resolves paths given to `watch` or `check` into the configs they cover.

import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import { ConfigError } from "./errors.ts";
import { FLOW_FILE, FLOWS_DIR, PROCESSORS_FILE } from "./flowLayout.ts";
import { exists } from "./localFiles.ts";
import type { Adapter } from "./sync/adapter.ts";
import type { AdapterName, Scope, SyncContext } from "./sync/types.ts";

export type WatchRoot = { path: string; recursive: boolean };

export type Targets = {
  scope: Scope;
  /** Directories to watch (absolute). */
  roots: WatchRoot[];
  /** Whether a changed file (relative to the project root) is covered. */
  covers(relPath: string): boolean;
  /** e.g. `1 flow (grades@widgets: flow.json + processors.js + 1 trigger)`. */
  describe(): string;
};

const toPosix = (p: string) =>
  SEPARATOR === "/" ? p : p.replaceAll(SEPARATOR, "/");

/** The first adapter claiming a file, with the id of the config it belongs to. */
export function ownerOf(
  ctx: SyncContext,
  adapters: Adapter[],
  relPath: string,
): { adapter: Adapter; id: string } | null {
  for (const adapter of adapters) {
    const id = adapter.ownerOf(ctx, relPath);
    if (id) return { adapter, id };
  }
  return null;
}

export function resolveTargets(
  ctx: SyncContext,
  adapters: Adapter[],
  paths: string[],
): Targets {
  const ids = new Map<AdapterName, Set<string> | null>();
  const roots: WatchRoot[] = [];
  const files = new Set<string>();
  /** Covered with everything below them. */
  const trees: string[] = [];
  /** Covered for the files directly inside them (a flow's folder). */
  const folders: string[] = [];
  const described: string[] = [];

  const add = (name: AdapterName, id: string) => {
    const current = ids.get(name);
    if (current === null) return;
    ids.set(name, (current ?? new Set()).add(id));
  };

  for (const input of paths) {
    const rel = toPosix(relative(ctx.root, resolve(ctx.root, input))) || ".";
    const top = adapters.find((a) =>
      rel === a.dir || rel.startsWith(a.dir + "/")
    );
    if (!top) {
      throw new ConfigError(
        `${input} is not inside ${adapters.map((a) => a.dir + "/").join(", ")}`,
      );
    }
    const abs = join(ctx.root, rel);
    if (!exists(abs)) throw new ConfigError(`${input} does not exist`);
    const isDir = Deno.statSync(abs).isDirectory;

    // A flow's folder, or a file in it: the flow and the triggers beside it.
    const flowFolder = rel.startsWith(FLOWS_DIR + "/")
      ? (isDir ? rel : dirname(rel))
      : null;
    if (flowFolder && exists(join(ctx.root, flowFolder, FLOW_FILE))) {
      const inFolder = [...Deno.readDirSync(join(ctx.root, flowFolder))]
        .filter((e) => e.isFile).map((e) => `${flowFolder}/${e.name}`);
      let flowId = "", triggerCount = 0;
      for (const file of inFolder) {
        const owner = ownerOf(ctx, adapters, file);
        if (!owner) continue;
        add(owner.adapter.name, owner.id);
        if (owner.adapter.name === "flows") flowId = owner.id;
        else triggerCount++;
      }
      folders.push(flowFolder);
      roots.push({ path: join(ctx.root, flowFolder), recursive: false });
      const parts = [
        FLOW_FILE,
        ...(inFolder.some((f) => basename(f) === PROCESSORS_FILE)
          ? [PROCESSORS_FILE]
          : []),
        ...(triggerCount
          ? [`${triggerCount} trigger${triggerCount === 1 ? "" : "s"}`]
          : []),
      ];
      described.push(`1 flow (${flowId}: ${parts.join(" + ")})`);
      continue;
    }

    if (isDir) {
      trees.push(rel);
      roots.push({ path: abs, recursive: true });
      let count = 0;
      for (const adapter of adapters) {
        if (rel === adapter.dir) {
          ids.set(adapter.name, null);
          continue;
        }
        // The collection a folder sits in, if any.
        const owner = adapter.ownerOf(ctx, `${rel}/_`);
        if (owner) {
          add(adapter.name, owner);
          count++;
        }
        for (const [id, path] of adapter.index(ctx).files) {
          if (path.startsWith(rel + "/")) {
            add(adapter.name, id);
            count++;
          }
        }
      }
      described.push(
        rel === top.dir ? `all ${rel}` : `${rel} (${count} configs)`,
      );
      continue;
    }

    const owner = ownerOf(ctx, adapters, rel);
    if (!owner) throw new ConfigError(`${input} does not belong to any config`);
    add(owner.adapter.name, owner.id);
    if (owner.adapter.name === "resources") {
      // A resource file or _collection.json: watch the whole collection folder.
      const collectionDir = findCollectionDir(ctx.root, rel);
      trees.push(collectionDir);
      roots.push({ path: join(ctx.root, collectionDir), recursive: true });
      described.push(`collection ${owner.id} (${collectionDir})`);
    } else {
      files.add(rel);
      roots.push({ path: join(ctx.root, dirname(rel)), recursive: false });
      described.push(`1 ${owner.adapter.dir.replace(/s$/, "")} (${owner.id})`);
    }
  }

  return {
    scope: { ids },
    roots: dedupeRoots(roots),
    covers: (relPath) =>
      files.has(relPath) || folders.includes(dirname(relPath)) ||
      trees.some((d) => relPath === d || relPath.startsWith(d + "/")),
    describe: () => described.join(", "),
  };
}

function findCollectionDir(root: string, relPath: string): string {
  let dir = dirname(relPath);
  while (dir !== "." && !exists(join(root, dir, "_collection.json"))) {
    dir = dirname(dir);
  }
  return dir;
}

function dedupeRoots(roots: WatchRoot[]): WatchRoot[] {
  const byPath = new Map<string, WatchRoot>();
  for (const r of roots) {
    const existing = byPath.get(r.path);
    byPath.set(r.path, {
      path: r.path,
      recursive: r.recursive || !!existing?.recursive,
    });
  }
  return [...byPath.values()];
}
