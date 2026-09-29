// A trigger belongs in the folder of the flow it runs (`orchestratorName`),
// or under `triggers/` when that flow isn't local. When the two disagree
// (the flow changed, or was deleted), pathisync says so and offers to move
// the file, but never moves it on its own.

import { dirname } from "@std/path";
import {
  FLOWS_DIR,
  indexFlows,
  indexTriggers,
  invalidPathPart,
  TRIGGER_SUFFIX,
  triggerFileIn,
  TRIGGERS_DIR,
} from "../flowLayout.ts";
import {
  exists,
  readLocalBytes,
  readLocalJson,
  removeEmptyDirs,
  removeLocalFile,
  writeLocalFile,
} from "../localFiles.ts";
import type { TriggerObj } from "../types.ts";
import type { SyncContext } from "./types.ts";

export type Misplaced = {
  id: string;
  path: string;
  expected: string;
  reason: string;
};

export function findMisplacedTriggers(ctx: SyncContext): Misplaced[] {
  const flows = indexFlows(ctx.root);
  const triggers = indexTriggers(ctx.root);
  const scoped = ctx.scope?.ids.get("triggers");
  const found: Misplaced[] = [];
  for (const [id, path] of [...triggers.files].sort()) {
    if (scoped && !scoped.has(id)) continue;
    let flow: string | undefined;
    try {
      flow = readLocalJson<TriggerObj>(ctx.root, path).config?.orchestratorName;
    } catch (_) {
      continue; // reported by the sync itself
    }
    const flowPath = flow ? flows.files.get(flow) : undefined;
    let expected: string, reason: string;
    if (flowPath && !invalidPathPart(id + TRIGGER_SUFFIX)) {
      expected = triggerFileIn(flowPath, id);
      reason = `it runs the flow ${flow}`;
    } else {
      expected = path.startsWith(TRIGGERS_DIR + "/")
        ? path
        : `${TRIGGERS_DIR}/${id}.json`;
      reason = flow
        ? `it runs the flow ${flow}, which isn't in this folder`
        : "it doesn't run a flow";
    }
    if (expected !== path) found.push({ id, path, expected, reason });
  }
  return found;
}

export const triggerLayoutNotes = (ctx: SyncContext) =>
  findMisplacedTriggers(ctx).map((m) =>
    `trigger ${m.id} is in ${m.path}, but ${m.reason}; it belongs in ${m.expected}`
  );

export async function offerTriggerMoves(ctx: SyncContext) {
  const { out, options, prompter } = ctx;
  for (const m of findMisplacedTriggers(ctx)) {
    out.warn(
      `\nThe trigger ${m.id} is in ${m.path}, but ${m.reason}.\nIt belongs in ${m.expected}`,
    );
    if (options.mode !== "interactive" || options.preferServer) continue;
    if (exists(`${ctx.root}/${m.expected}`)) {
      out.warn(`  ${m.expected} already exists, so it can't be moved there`);
      continue;
    }
    if (!await prompter.confirm(`Move it to ${m.expected}?`, true)) continue;
    writeLocalFile(ctx.root, m.expected, readLocalBytes(ctx.root, m.path)!);
    removeLocalFile(ctx.root, m.path);
    removeEmptyDirs(
      ctx.root,
      dirname(m.path),
      m.path.startsWith(FLOWS_DIR + "/") ? FLOWS_DIR : TRIGGERS_DIR,
    );
    out.log(`Moved ${m.path} to ${m.expected}`);
  }
}
