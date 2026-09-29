// `check`: plan everything, print what differs, act on nothing.

import { capLines, colorize } from "./diff.ts";
import { STATUS_TEXT } from "./sync/status.ts";
import type { KindReport } from "./sync/engine.ts";
import type { Plan } from "./sync/types.ts";
import type { Output } from "./ui.ts";

export const EXIT_IN_SYNC = 0;
export const EXIT_DIFFERS = 1;
export const EXIT_ERROR = 2;

const WIDTH = Math.max(...Object.values(STATUS_TEXT).map((s) => s.length)) + 2;

const where = (plan: Plan) => plan.displayPath ?? plan.id;

/** The plans worth reporting: resources inside a one-sided collection are implied. */
function reportable(report: KindReport): Plan[] {
  return report.result.groups.flatMap(({ plan, children }) => {
    const oneSided = !plan.localHash || !plan.remoteHash;
    return [plan, ...(oneSided ? [] : children)];
  }).filter((p) => p.status !== "in-sync");
}

/** Prints the report and returns the exit code. */
export async function printCheck(
  reports: KindReport[],
  out: Output,
  showDiffs: boolean,
): Promise<number> {
  let differ = 0, conflicts = 0, errors = 0;
  for (const report of reports) {
    // Local paths first, then configs that exist only on the server.
    const sortKey = (p: Plan) => `${p.displayPath ? 0 : 1}${where(p)}`;
    const plans = reportable(report).sort((a, b) =>
      sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0
    );
    const problems = [...report.result.errors].sort((a, b) =>
      a.path < b.path ? -1 : 1
    );
    if (!plans.length && !problems.length && !report.notes.length) continue;
    out.log(report.adapter.dir);
    for (const plan of plans) {
      out.log(`  ${STATUS_TEXT[plan.status].padEnd(WIDTH)}${where(plan)}`);
      if (showDiffs) {
        const diff = await plan.diff();
        if (diff) {
          out.log(
            capLines(colorize(diff)).split("\n").map((l) => "    " + l).join(
              "\n",
            ),
          );
        }
      }
      differ++;
      if (plan.status === "conflict") conflicts++;
    }
    for (const error of problems) {
      out.error(`  ${"error".padEnd(WIDTH)}${error.message}`);
      errors++;
    }
    // Layout warnings don't affect the exit code: nothing differs from the server.
    for (const note of report.notes) {
      out.warn(`  ${"misplaced".padEnd(WIDTH)}${note}`);
    }
  }
  if (reports.length && (differ || errors)) out.log("");
  if (differ) {
    out.log(
      `${differ} config${differ === 1 ? "" : "s"} differ${
        differ === 1 ? "s" : ""
      }${
        conflicts ? ` (${conflicts} conflict${conflicts === 1 ? "" : "s"})` : ""
      }`,
    );
  } else if (!errors) {
    out.log("Everything is in sync");
  }
  if (errors) {
    out.error(
      `${errors} local file${errors === 1 ? "" : "s"} could not be read`,
    );
    return EXIT_ERROR;
  }
  return differ ? EXIT_DIFFERS : EXIT_IN_SYNC;
}
