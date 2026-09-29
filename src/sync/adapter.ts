import type { ConfigIndex } from "../fsIndex.ts";
import type { LocalFileError } from "../errors.ts";
import type { AdapterName, Plan, SyncContext } from "./types.ts";

/** One config's plan. For resource collections, `children` holds a plan per resource. */
export type PlanGroup = { plan: Plan; children: Plan[] };

export type PlanResult = {
  groups: PlanGroup[];
  /** Local files that could not be read or rebuilt; those configs are skipped. */
  errors: LocalFileError[];
};

/** How one config type is listed, read, compared, written, pushed and deleted. */
export interface Adapter {
  name: AdapterName;
  /** Local directory, relative to the project root. */
  dir: string;
  index(ctx: SyncContext): ConfigIndex;
  /** Fetches every remote config of this type. */
  fetch(ctx: SyncContext): Promise<unknown[]>;
  plan(
    ctx: SyncContext,
    remote: unknown[],
    index: ConfigIndex,
  ): Promise<PlanResult>;
  /** Decides each plan, then carries out the chosen actions. */
  apply(
    ctx: SyncContext,
    result: PlanResult,
    index: ConfigIndex,
  ): Promise<void>;
  /** Maps a local file to the id of the config that owns it (for watch/check scoping). */
  ownerOf(ctx: SyncContext, relPath: string): string | null;
  /** Local layout warnings for `check`, e.g. a trigger outside its flow's folder. */
  notes?(ctx: SyncContext): string[];
}
