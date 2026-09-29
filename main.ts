// pathisync: sync a project folder with a Pathify flow server.
//
//   deno run -A jsr:@usu/pathisync [command] [options]

import { parseArgs } from "@std/cli/parse-args";
import { setColorEnabled } from "@std/fmt/colors";
import { join } from "@std/path";
import { EXIT_ERROR, printCheck } from "./src/check.ts";
import { createClient, type FetchFn } from "./src/client.ts";
import { loadEnv } from "./src/env.ts";
import { ConfigError, errorMessage, PathisyncError } from "./src/errors.ts";
import { formatLinks, widgetLinks } from "./src/links.ts";
import { exists } from "./src/localFiles.ts";
import { initProject } from "./src/scaffold.ts";
import { isStateTrackedByGit, STATE_DIR, SyncState } from "./src/state.ts";
import { ADAPTERS, runSync } from "./src/sync/engine.ts";
import type { Mode, SyncContext } from "./src/sync/types.ts";
import { resolveTargets } from "./src/targets.ts";
import { TYPES_FILE, updateTypes } from "./src/typegen/types.ts";
import {
  consoleOutput,
  inquirerPrompter,
  type Output,
  type Prompter,
} from "./src/ui.ts";
import { startWatch } from "./src/watch.ts";

const RUN = "deno run -A jsr:@usu/pathisync";

const HELP = `Usage: ${RUN} [command] [options]

Commands:
  (none)              Sync flows, shared configs, triggers and resources, and
                      update the editor types. In a folder without a .env, set
                      up a new project instead
  check [paths]       Only report what differs; never prompt, write or push.
                      Exits 0 when in sync, 1 when something differs, 2 on errors
  watch <paths>       Push saved changes for a flow folder, config, file or folder
  links <widgets>     Print the triggers a widget calls, their flows and sub-flows
  types               Regenerate ${TYPES_FILE} from the flow server's docs

Options:
  -d                  Offer delete options
  -l                  Resolve conflicts and unclear differences in favor of the server
  -f                  With -l, create new local files in the default folder (-lf)
  --diff              With check, include diffs
  --no-diff           Don't print diffs before prompts
  --allow-bundled     Offer to push or delete bundled configs (asks per config)
  -h, --help          Show this help
`;

const COMMANDS = ["sync", "check", "watch", "links", "types"] as const;
type Command = typeof COMMANDS[number];

export type MainDeps = {
  root?: string;
  fetch?: FetchFn;
  prompter?: Prompter;
  out?: Output;
};

/** Runs a command and returns the exit code. */
export async function main(
  argv: string[],
  deps: MainDeps = {},
): Promise<number> {
  const out = deps.out ?? consoleOutput;
  const root = deps.root ?? Deno.cwd();
  // `deno run … pathisync -- check` passes the `--` through; ignore it.
  if (argv[0] === "--") argv = argv.slice(1);
  let command: Command = "sync";
  try {
    const args = parseArgs(argv, {
      boolean: ["l", "d", "f", "diff", "allow-bundled", "help"],
      negatable: ["diff"],
      alias: { h: "help" },
      default: { diff: undefined },
      unknown: (arg) => {
        if (arg.startsWith("-")) {
          throw new ConfigError(`Unknown option ${arg}\n\n${HELP}`);
        }
        return true;
      },
    });
    const positional = args._.map(String);
    if ((COMMANDS as readonly string[]).includes(positional[0])) {
      command = positional.shift() as Command;
    }
    if (args.help) {
      out.log(HELP);
      return 0;
    }
    if ((command === "sync" || command === "types") && positional.length) {
      throw new ConfigError(`Unknown command ${positional[0]}\n\n${HELP}`);
    }
    if ((command === "watch" || command === "links") && !positional.length) {
      throw new ConfigError(
        command === "watch"
          ? "watch needs a path, for example: watch flows/@widgets/grades"
          : "links needs a widget, for example: links resources/my_widget",
      );
    }
    if (command === "check" && (args.l || args.d)) {
      throw new ConfigError("check can't be combined with -l or -d");
    }

    if (command === "links") {
      out.log(
        positional.map((t) => formatLinks(widgetLinks(root, t))).join("\n\n"),
      );
      return 0;
    }

    // A folder without a .env is a new project (or a fresh clone): set it up.
    if (!exists(join(root, ".env"))) {
      if (command !== "sync") {
        throw new ConfigError(
          `There is no .env here. Run "${RUN}" in your project folder to set it up.`,
        );
      }
      for (const line of initProject(root)) out.log(line);
      out.log(
        `\nProject set up. Fill in PATHIFY_TOKEN and FLOW_SERVER_URL in .env, then run "${RUN}" again.`,
      );
      return 0;
    }

    if (command === "types") {
      const env = await loadEnv(root, { requireToken: false });
      const result = await updateTypes(root, env.serverUrl, deps.fetch);
      out.log(
        `${result.globals} globals, ${result.classes} classes, ${result.pluginGlobals} plugin globals → ${TYPES_FILE}` +
          (result.changed ? "" : " (unchanged)"),
      );
      return 0;
    }

    const env = await loadEnv(root);
    const check = command === "check";
    if (!check && await isStateTrackedByGit(root)) {
      out.warn(
        `Warning: ${STATE_DIR}/ is tracked by git. It is per machine; add it to .gitignore and run "git rm -r --cached ${STATE_DIR}".`,
      );
    }
    const mode: Mode = check
      ? "check"
      : command === "watch"
      ? "watch"
      : "interactive";
    const ctx: SyncContext = {
      root,
      client: createClient({ ...env, fetch: deps.fetch }),
      state: SyncState.load(root, env.serverUrl, !check),
      prompter: deps.prompter ?? inquirerPrompter,
      out,
      options: {
        mode,
        preferServer: args.l,
        allowDelete: args.d,
        forceDefaultFolder: args.f,
        allowBundled: args["allow-bundled"],
        showDiff: args.diff !== false,
      },
      failures: [],
    };

    if (check) {
      if (positional.length) {
        ctx.scope = resolveTargets(ctx, ADAPTERS, positional).scope;
      }
      const reports = await runSync(ctx);
      return await printCheck(reports, out, args.diff === true);
    }

    if (command === "watch") {
      const targets = resolveTargets(ctx, ADAPTERS, positional);
      await startWatch(ctx, ADAPTERS, targets).closed;
      return 0;
    }

    // The editor types are fetched while the sync runs, and never fail it.
    const types = updateTypes(root, env.serverUrl, deps.fetch).catch((error) =>
      error as Error
    );
    await runSync(ctx);
    const typesResult = await types;
    if (typesResult instanceof Error) {
      out.warn(
        `Couldn't update ${TYPES_FILE}: ${
          errorMessage(typesResult)
        }. Run "${RUN} types" to retry.`,
      );
    } else if (typesResult.changed) {
      out.log(
        `Updated ${TYPES_FILE}${
          typesResult.version ? ` (flow docs ${typesResult.version})` : ""
        }`,
      );
    }
    if (ctx.failures.length) {
      out.error(
        `\n${ctx.failures.length} action${
          ctx.failures.length === 1 ? "" : "s"
        } failed:\n${ctx.failures.map((f) => `  ${f}`).join("\n")}`,
      );
      return 1;
    }
    return 0;
  } catch (error) {
    out.error(
      error instanceof PathisyncError
        ? error.message
        : (error as Error)?.stack ?? errorMessage(error),
    );
    return command === "check" ? EXIT_ERROR : 1;
  }
}

if (import.meta.main) {
  setColorEnabled(Deno.stdout.isTerminal() && !Deno.noColor);
  Deno.exit(await main(Deno.args));
}
