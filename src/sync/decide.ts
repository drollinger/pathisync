import { capLines, colorize } from "../diff.ts";
import type { Action, Decision, Plan, SyncContext } from "./types.ts";

const NOTHING: Decision = { action: "nothing" };

/** The first line of the prompt for a plan; `server` is the flow server's host. */
export function describe(plan: Plan, server: string): string {
  const what = `${plan.typeLabel} ${plan.id}`;
  const where = plan.displayPath ? `\nlocated at ${plan.displayPath}` : "";
  switch (plan.status) {
    case "in-sync":
      return `The ${what} is in sync`;
    case "unknown":
      return `There is a difference with the ${what}${where}`;
    case "server-changed":
      return `The ${what} changed on the server since the last sync${where}`;
    case "local-changed":
      return `The ${what} changed locally since the last sync${where}`;
    case "conflict":
      return `The ${what} changed both locally and on the server since the last sync${where}`;
    case "new-local":
      return `${server} doesn't have the ${what}${where}`;
    case "deleted-on-server":
      return `The ${what} was deleted on the server since the last sync${where}`;
    case "deleted-on-server-edited":
      return `The ${what} was deleted on the server, but was edited locally since the last sync${where}`;
    case "new-on-server":
      return `The ${what} does not exist locally`;
    case "deleted-locally":
      return `The ${what} was deleted locally since the last sync`;
    case "deleted-locally-edited":
      return `The ${what} was deleted locally, but changed on the server since the last sync`;
  }
}

export function actionLabel(
  plan: Plan,
  action: Action,
  server: string,
): string {
  const custom = plan.labels?.[action];
  if (custom) return custom;
  const t = plan.typeLabel;
  switch (action) {
    case "nothing":
      return "Nothing";
    case "pull":
      return `Overwrite local ${t}`;
    case "push":
      return plan.remoteHash
        ? `Push local ${t} to ${server}`
        : `Push new ${t} to ${server}`;
    case "create-local":
      return `Create new local ${t}`;
    case "delete-local":
      return `Delete local ${t}`;
    case "delete-remote":
      return `Delete ${t} on ${server}`;
  }
}

async function printDiff(plan: Plan, ctx: SyncContext, print = ctx.out.log) {
  const diff = await plan.diff();
  if (diff) print(capLines(colorize(diff)));
  return diff;
}

/**
 * Picks the action for one plan: prompts in interactive mode, or applies the
 * `-l` and watch rules. Never writes or makes network calls.
 */
export async function decide(
  plan: Plan,
  ctx: SyncContext,
  /** Asks where to create a new local config; absent when the location is fixed by its parent. */
  chooseLocation?: () => Promise<string>,
): Promise<Decision> {
  const { out, options, prompter } = ctx;
  const label = `${plan.typeLabel} ${plan.id}`;
  if (plan.status === "in-sync" || options.mode === "check") return NOTHING;

  // Only the server changed: the local copy is the last-synced one, so
  // pulling can't lose any local edit.
  if (plan.status === "server-changed") {
    out.log(`↓ ${label}: server changed, pulling`);
    return { action: "pull" };
  }

  if (options.mode === "watch") return decideWatch(plan, ctx, label);

  if (options.preferServer) {
    switch (plan.status) {
      case "unknown":
      case "conflict":
        out.log(`↓ ${label}: ${plan.status}, overwriting local (-l)`);
        return { action: "pull" };
      case "new-on-server":
      case "deleted-locally":
      case "deleted-locally-edited":
        if (!plan.options.includes("create-local")) {
          for (const note of plan.notes) out.warn(`· ${label}: ${note}`);
          return NOTHING;
        }
        return { action: "create-local", location: await chooseLocation?.() };
      case "local-changed":
        out.log(`· ${label}: changed locally, not pushed (-l)`);
        return NOTHING;
      default:
        return NOTHING;
    }
  }

  out.log("\n" + describe(plan, ctx.server));
  for (const note of plan.notes) out.warn(`  ${note}`);
  if (plan.guard) out.log(`(${plan.guard.reason})`);
  const diff = options.showDiff
    ? await printDiff(plan, ctx)
    : await plan.diff();
  if (plan.options.length <= 1) return NOTHING;

  const defaultAction: Action = plan.status === "new-on-server"
    ? "create-local"
    : "nothing";
  let action: Action | "show-diff";
  for (;;) {
    action = await prompter.select<Action | "show-diff">(
      "What do you want to do?",
      [
        ...plan.options.map((value) => ({
          name: actionLabel(plan, value, ctx.server),
          value,
        })),
        ...(diff
          ? [{ name: "Show full diff", value: "show-diff" as const }]
          : []),
      ],
      defaultAction,
    );
    if (action !== "show-diff") break;
    await prompter.pager(colorize(diff));
  }

  if (
    (action === "push" || action === "delete-remote") &&
    plan.guard?.type === "bundled"
  ) {
    const ok = await prompter.confirm(
      `This ${plan.typeLabel} belongs to bundle ${plan.guard.bundle}. ${
        action === "push" ? "Push" : "Delete"
      } anyway?`,
    );
    if (!ok) return NOTHING;
  }
  if (action === "create-local") {
    return { action, location: await chooseLocation?.() };
  }
  if (action === "delete-local" && plan.kind === "resource" && plan.localHash) {
    const deleteFile = await prompter.confirm(
      "Do you also want to delete the local file?",
    );
    return { action, deleteFile };
  }
  return { action };
}

async function decideWatch(
  plan: Plan,
  ctx: SyncContext,
  label: string,
): Promise<Decision> {
  const { out } = ctx;
  switch (plan.status) {
    case "local-changed":
      // Guardrails apply in watch mode even with --allow-bundled.
      if (plan.guard) {
        const refused = ctx.refusedOnce ??= new Set();
        if (!refused.has(plan.key)) {
          refused.add(plan.key);
          out.warn(`✖ ${label} not pushed (${plan.guard.reason})`);
        }
        return NOTHING;
      }
      return { action: "push" };
    case "conflict":
      out.warn(
        `✖ conflict on ${label}: it also changed on the server since the last sync, not pushed`,
      );
      await printDiff(plan, ctx);
      return NOTHING;
    case "unknown":
      out.warn(
        `✖ ${label} differs from the server and there is no record of the last sync, not pushed. Run a normal sync first.`,
      );
      await printDiff(plan, ctx);
      return NOTHING;
    default:
      out.log(
        `· ${label}: ${
          describe(plan, ctx.server).split("\n")[0]
        }; run a normal sync`,
      );
      return NOTHING;
  }
}
