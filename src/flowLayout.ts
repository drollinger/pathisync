// Where flows and triggers live on disk.
//
//   flows/@campus/+accounts/sync_users/
//     flow.json                        the flow   sync_users@campus:accounts
//     processors.js                    its JavaScript (issue 01)
//     http_sync.trigger.json           a trigger whose orchestratorName is this flow
//   flows/login_redirect/flow.json     a flow with no namespace
//   triggers/dnsOverride.json          a trigger with no local flow
//
// A flow's name comes from its path: an `@namespace` folder, one `+sub`
// folder per `:` level, then the flow's own folder. The Pathify UI groups
// flows by that namespace; it groups nothing else, so other config types
// keep their flat layout.

import { basename, dirname } from "@std/path";
import { LocalFileError } from "./errors.ts";
import {
  type ConfigIndex,
  defaultWalker,
  indexConfigs,
  sortedEntries,
  walkConfigDir,
  type Walker,
} from "./fsIndex.ts";

export const FLOWS_DIR = "flows";
export const TRIGGERS_DIR = "triggers";
export const FLOW_FILE = "flow.json";
export const PROCESSORS_FILE = "processors.js";
export const TRIGGER_SUFFIX = ".trigger.json";

/** Editor settings that live among the flows (issue 10) but aren't configs. */
const EDITOR_FILES = new Set(["jsconfig.json", "tsconfig.json"]);

/** Characters no folder name may hold on any OS, plus `/`. */
// deno-lint-ignore no-control-regex
const INVALID = /[\\/<>:"|?*\u0000-\u001f]/;

/** Why `part` can't be a file or folder name, or null if it can. */
export function invalidPathPart(part: string): string | null {
  if (!part) return "is empty";
  if (part === "." || part === "..") return `"${part}" is not a folder name`;
  if (INVALID.test(part)) {
    return `"${part}" contains a character folders can't hold`;
  }
  if (/[. ]$/.test(part)) return `"${part}" ends with a dot or space`;
  return null;
}

/**
 * The folder a flow lives in, relative to the project root, or an error
 * saying why its name can't be laid out as folders.
 */
export function flowDirFor(name: string): { dir: string } | { error: string } {
  const at = name.indexOf("@");
  const short = at === -1 ? name : name.slice(0, at);
  const namespace = at === -1 ? [] : name.slice(at + 1).split(":");
  if (at !== -1 && name.includes("@", at + 1)) {
    return { error: `the flow name ${name} has more than one "@"` };
  }
  if (/^[@+]/.test(short)) {
    return { error: `the flow name ${name} starts with "${short[0]}"` };
  }
  for (const part of [short, ...namespace]) {
    const problem = invalidPathPart(part);
    if (problem) {
      return {
        error:
          `the flow name ${name} can't be a folder path: a part ${problem}`,
      };
    }
  }
  const [top, ...subs] = namespace;
  const parts = [
    ...(top === undefined ? [] : [`@${top}`]),
    ...subs.map((s) => `+${s}`),
    short,
  ];
  return { dir: [FLOWS_DIR, ...parts].join("/") };
}

/** The flow name a folder (relative to the project root) stands for. */
export function flowNameFromDir(
  dir: string,
): { name: string } | { error: string } {
  const parts = dir.split("/").slice(1); // drop "flows"
  const short = parts.pop();
  if (!short || /^[@+]/.test(short)) {
    return {
      error:
        `${FLOW_FILE} must be inside a flow's own folder, not a namespace folder`,
    };
  }
  if (!parts.length) return { name: short };
  const [top, ...subs] = parts;
  if (!top.startsWith("@") || top.length < 2) {
    return {
      error:
        `the folder "${top}" must be an @namespace folder (flows can't be sorted into other folders)`,
    };
  }
  for (const sub of subs) {
    if (!sub.startsWith("+") || sub.length < 2) {
      return {
        error:
          `the folder "${sub}" must be a +sub-namespace folder (flow folders can't be nested)`,
      };
    }
  }
  return {
    name: `${short}@${top.slice(1)}${
      subs.map((s) => ":" + s.slice(1)).join("")
    }`,
  };
}

export const processorsPathFor = (flowJsonPath: string) =>
  `${dirname(flowJsonPath)}/${PROCESSORS_FILE}`;

export const triggerFileIn = (flowJsonPath: string, triggerName: string) =>
  `${dirname(flowJsonPath)}/${triggerName}${TRIGGER_SUFFIX}`;

/** Flow index: name (from the path) → path of its `flow.json`. */
export function indexFlows(
  root: string,
  walk: Walker = defaultWalker,
): ConfigIndex {
  const found = new Map<string, string[]>();
  const problems: LocalFileError[] = [];
  const flowDirs: string[] = [];
  for (const { rel, entry } of walkConfigDir(root, FLOWS_DIR, walk)) {
    if (!entry.isFile) continue;
    const file = basename(rel);
    if (file === FLOW_FILE) {
      const result = flowNameFromDir(dirname(rel));
      if ("error" in result) {
        problems.push(new LocalFileError(rel, result.error));
        continue;
      }
      flowDirs.push(dirname(rel));
      found.set(result.name, [...(found.get(result.name) ?? []), rel]);
    } else if (
      file.endsWith(".json") && !file.endsWith(TRIGGER_SUFFIX) &&
      !EDITOR_FILES.has(file)
    ) {
      problems.push(
        new LocalFileError(
          rel,
          `not part of the flows layout (each flow is a folder with a ${FLOW_FILE}, and triggers are <name>${TRIGGER_SUFFIX})`,
        ),
      );
    }
  }
  // A flow folder holding another flow folder would give two flows one path.
  for (const dir of flowDirs) {
    const outer = flowDirs.find((d) => dir.startsWith(d + "/"));
    if (outer) {
      problems.push(
        new LocalFileError(
          `${dir}/${FLOW_FILE}`,
          `flow folders can't be nested (inside ${outer})`,
        ),
      );
    }
  }
  const files = new Map<string, string>();
  const duplicates = new Map<string, string[]>();
  for (const [name, paths] of sortedEntries(found)) {
    if (paths.length > 1) duplicates.set(name, paths.sort());
    else if (!problems.some((p) => p.path === paths[0])) {
      files.set(name, paths[0]);
    }
  }
  return { dir: FLOWS_DIR, files, folders: [], duplicates, problems };
}

/**
 * Trigger index: name → path, covering `<name>.trigger.json` files in flow
 * folders and `<name>.json` files under `triggers/`. Folder prompts only
 * offer `triggers/` folders.
 */
export function indexTriggers(
  root: string,
  walk: Walker = defaultWalker,
): ConfigIndex {
  const loose = indexConfigs(root, TRIGGERS_DIR, walk);
  const found = new Map<string, string[]>(
    [...loose.files].map(([name, path]) => [name, [path]]),
  );
  for (const [name, paths] of loose.duplicates) found.set(name, paths);
  for (const { rel, entry } of walkConfigDir(root, FLOWS_DIR, walk)) {
    if (!entry.isFile || !rel.endsWith(TRIGGER_SUFFIX)) continue;
    const name = basename(rel, TRIGGER_SUFFIX);
    found.set(name, [...(found.get(name) ?? []), rel]);
  }
  const files = new Map<string, string>();
  const duplicates = new Map<string, string[]>();
  for (const [name, paths] of sortedEntries(found)) {
    if (paths.length > 1) duplicates.set(name, paths.sort());
    else files.set(name, paths[0]);
  }
  return { dir: TRIGGERS_DIR, files, folders: loose.folders, duplicates };
}
