import type { Action, Plan, Status, Unit } from "./types.ts";

/**
 * Issue 03's decision table: which side changed since the last sync, given
 * the hashes of the local copy, the remote copy and the recorded baseline.
 */
export function classify(
  local: string | undefined,
  remote: string | undefined,
  baseline: string | undefined,
): Status | null {
  if (local !== undefined && remote !== undefined) {
    if (local === remote) return "in-sync";
    if (baseline === undefined) return "unknown";
    if (local === baseline) return "server-changed";
    if (remote === baseline) return "local-changed";
    return "conflict";
  }
  if (local !== undefined) {
    if (baseline === undefined) return "new-local";
    return local === baseline
      ? "deleted-on-server"
      : "deleted-on-server-edited";
  }
  if (remote !== undefined) {
    if (baseline === undefined) return "new-on-server";
    return remote === baseline ? "deleted-locally" : "deleted-locally-edited";
  }
  return null;
}

/** The actions each status offers, before guardrails remove any. */
export function optionsFor(status: Status, allowDelete: boolean): Action[] {
  const del = (action: Action) => allowDelete ? [action] : [];
  switch (status) {
    case "in-sync":
      return [];
    case "unknown":
    case "server-changed":
    case "conflict":
      return ["nothing", "pull", "push"];
    case "local-changed":
      return ["nothing", "push"];
    case "new-local":
      return ["nothing", "push", ...del("delete-local")];
    case "deleted-on-server":
      return ["nothing", ...del("delete-local")];
    case "deleted-on-server-edited":
      return ["nothing", "push", ...del("delete-local")];
    case "new-on-server":
    case "deleted-locally":
    case "deleted-locally-edited":
      return ["nothing", "create-local", ...del("delete-remote")];
  }
}

export function makePlan(
  unit: Unit,
  baseline: string | undefined,
  { allowDelete, allowBundled }: {
    allowDelete: boolean;
    allowBundled: boolean;
  },
): Plan | null {
  const status = classify(unit.localHash, unit.remoteHash, baseline);
  if (!status) return null;
  let options = optionsFor(status, allowDelete);
  for (const extra of unit.extraOptions ?? []) {
    if (status !== "in-sync" && !options.includes(extra)) {
      options = [...options, extra];
    }
  }
  // Guardrails: refused actions are never offered.
  const guard = unit.guard;
  if (
    guard?.type === "secure" || (guard?.type === "bundled" && !allowBundled)
  ) {
    options = options.filter((o) => o !== "push" && o !== "delete-remote");
  }
  return { ...unit, status, baseline, options };
}

/** Wording used by `check` and one-line summaries. */
export const STATUS_TEXT: Record<Status, string> = {
  "in-sync": "in sync",
  "unknown": "differs",
  "server-changed": "server changed",
  "local-changed": "local changed",
  "conflict": "conflict",
  "new-local": "new local",
  "deleted-on-server": "deleted on server",
  "deleted-on-server-edited": "deleted on server",
  "new-on-server": "new on server",
  "deleted-locally": "deleted locally",
  "deleted-locally-edited": "deleted locally",
};
