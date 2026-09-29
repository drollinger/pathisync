import {
  assertNoDuplicates,
  type ConfigIndex,
  defaultWalker,
  type WalkEntry,
  type Walker,
} from "../fsIndex.ts";
import type { Adapter, PlanResult } from "./adapter.ts";
import { resources } from "./resources.ts";
import { flows, sharedConfigs, triggers } from "./single.ts";
import type { SyncContext } from "./types.ts";

// Flows come before triggers, so a trigger pulled in the same run can be
// placed in the folder of a flow that was just created.
export const ADAPTERS: Adapter[] = [flows, sharedConfigs, triggers, resources];

export type KindReport = {
  adapter: Adapter;
  result: PlanResult;
  /** Layout warnings (`check` only). */
  notes: string[];
};

/**
 * Runs a sync: index every directory (reporting all duplicate names before
 * any request), then per config type fetch, plan, and, unless checking,
 * decide and apply.
 */
export async function runSync(
  ctx: SyncContext,
  adapters: Adapter[] = ADAPTERS,
): Promise<KindReport[]> {
  const active = adapters.filter((a) =>
    !ctx.scope || ctx.scope.ids.has(a.name)
  );
  // Flows and triggers both look inside flows/; walk each directory once.
  const indexCtx = { ...ctx, walk: cachingWalker(ctx.walk ?? defaultWalker) };
  const indexes = new Map<Adapter, ConfigIndex>(
    active.map((a) => [a, a.index(indexCtx)]),
  );
  assertNoDuplicates([...indexes.values()]);

  const reports: KindReport[] = [];
  for (const adapter of active) {
    const index = indexes.get(adapter)!;
    const remote = await adapter.fetch(ctx);
    const result = await adapter.plan(ctx, remote, index);
    const check = ctx.options.mode === "check";
    if (!check) {
      for (const error of result.errors) {
        ctx.out.error(`✖ skipped ${error.message}`);
        ctx.failures.push(error.message);
      }
      await adapter.apply(ctx, result, index);
    }
    reports.push({
      adapter,
      result,
      notes: check ? adapter.notes?.(ctx) ?? [] : [],
    });
  }
  return reports;
}

function cachingWalker(walk: Walker): Walker {
  const cache = new Map<string, WalkEntry[]>();
  return (dir) => {
    if (!cache.has(dir)) cache.set(dir, [...walk(dir)]);
    return cache.get(dir)!;
  };
}
