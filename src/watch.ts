// `watch`: sync saved files to the server, pushing only when the server
// hasn't changed since the last sync.

import { relative, SEPARATOR } from "@std/path";
import { AuthError, errorMessage } from "./errors.ts";
import { exists, realPath, writes } from "./localFiles.ts";
import type { Adapter } from "./sync/adapter.ts";
import { runSync } from "./sync/engine.ts";
import type { AdapterName, SyncContext } from "./sync/types.ts";
import { ownerOf, type Targets } from "./targets.ts";

export const DEBOUNCE_MS = 500;

const toPosix = (p: string) =>
  SEPARATOR === "/" ? p : p.replaceAll(SEPARATOR, "/");

/**
 * Maps changed files to the configs that own them and syncs those, in watch
 * mode. Files that no longer exist are ignored (a delete never reaches the
 * server), as are files still holding exactly what pathisync last wrote.
 */
export async function syncChangedFiles(
  ctx: SyncContext,
  adapters: Adapter[],
  targets: Targets,
  paths: string[],
): Promise<boolean> {
  const ids = new Map<AdapterName, Set<string>>();
  const root = realPath(ctx.root);
  for (const path of paths) {
    const rel = toPosix(relative(root, realPath(path)));
    if (!targets.covers(rel) || rel.endsWith(".pathisync-tmp")) continue;
    if (!exists(path) || !Deno.statSync(path).isFile) continue;
    if (writes.isOwnWrite(path)) continue;
    const owner = ownerOf(ctx, adapters, rel);
    if (!owner) continue;
    const name = owner.adapter.name;
    ids.set(name, (ids.get(name) ?? new Set()).add(owner.id));
  }
  if (!ids.size) return false;
  ctx.failures.length = 0;
  await runSync({ ...ctx, scope: { ids } }, adapters);
  return true;
}

export type WatchHandle = { closed: Promise<void>; close(): void };

export function startWatch(
  ctx: SyncContext,
  adapters: Adapter[],
  targets: Targets,
): WatchHandle {
  ctx.out.log(`Watching ${targets.describe()} for changes...`);
  const watchers = targets.roots.map((r) =>
    Deno.watchFs(r.path, { recursive: r.recursive })
  );
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Syncs run one at a time, in the order saves happened.
  let queue = Promise.resolve();
  let fatal: ((error: unknown) => void) | undefined;
  const failed = new Promise<never>((_, reject) => (fatal = reject));

  const flush = () => {
    const paths = [...pending];
    pending.clear();
    queue = queue.then(async () => {
      try {
        await syncChangedFiles(ctx, adapters, targets, paths);
      } catch (error) {
        if (error instanceof AuthError) return fatal!(error);
        ctx.out.error(`✖ ${errorMessage(error)}`);
      }
    });
  };

  const closeAll = () => {
    clearTimeout(timer);
    for (const w of watchers) {
      try {
        w.close();
      } catch (_) { /* already closed */ }
    }
  };

  const loops = watchers.map(async (watcher) => {
    // Atomic saves arrive as create/rename/remove, so only `access` is ignored.
    for await (const event of watcher) {
      if (event.kind === "access") continue;
      for (const path of event.paths) pending.add(path);
      clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE_MS);
    }
  });

  const closed = Promise.race([
    Promise.all(loops).then(() => queue),
    failed,
  ]).finally(closeAll);
  return { closed, close: closeAll };
}
