import { walkSync } from "@std/fs";
import { basename, dirname, join, relative, SEPARATOR } from "@std/path";
import { type LocalFileError, PathisyncError } from "./errors.ts";

export type WalkEntry = { path: string; isFile: boolean; isDirectory: boolean };
/** Injectable so tests can count how often each directory is walked. */
export type Walker = (dir: string) => Iterable<WalkEntry>;

export const defaultWalker: Walker = (dir) => walkSync(dir);

/** Name → path index of one config directory, built once per run. */
export type ConfigIndex = {
  /** The config directory, relative to the project root (e.g. `flows`). */
  dir: string;
  /** Base name (without `.json`) → path relative to the project root. */
  files: Map<string, string>;
  /** Folders a new config can be created in, relative to `dir` (`.` first). */
  folders: string[];
  /** Base names found more than once. */
  duplicates: Map<string, string[]>;
  /** Files that break the directory's layout rules; those configs are skipped. */
  problems?: LocalFileError[];
};

export class DuplicateNamesError extends PathisyncError {
  override name = "DuplicateNamesError";
  constructor(duplicates: Map<string, string[]>) {
    const lines = [...duplicates.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    ).flatMap(([name, paths]) => [
      `  ${name}:`,
      ...paths.sort().map((p) => `    ${p}`),
    ]);
    super(
      `Duplicate config names found. Each name may exist only once:\n${
        lines.join("\n")
      }`,
    );
  }
}

const toPosix = (path: string) =>
  SEPARATOR === "/" ? path : path.replaceAll(SEPARATOR, "/");

/** Walks a config directory, skipping dotfiles and node_modules. */
export function* walkConfigDir(root: string, dir: string, walk: Walker) {
  const top = join(root, dir);
  try {
    if (!Deno.statSync(top).isDirectory) return;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  for (const entry of walk(top)) {
    const rel = toPosix(relative(root, entry.path));
    const inside = toPosix(relative(top, entry.path));
    // Skip dotfiles (.DS_Store, .git), dot-directories and node_modules.
    if (
      inside !== "" &&
      inside.split("/").some((s) => s.startsWith(".") || s === "node_modules")
    ) continue;
    yield { rel, inside, entry };
  }
}

/** Indexes `*.json` configs in a flows/triggers/sharedConfigs directory. */
export function indexConfigs(
  root: string,
  dir: string,
  walk: Walker = defaultWalker,
): ConfigIndex {
  const found = new Map<string, string[]>();
  const folders: string[] = ["."];
  for (const { rel, inside, entry } of walkConfigDir(root, dir, walk)) {
    if (entry.isDirectory) {
      if (inside !== "") folders.push(inside);
    } else if (entry.isFile && rel.endsWith(".json")) {
      const name = basename(rel, ".json");
      found.set(name, [...(found.get(name) ?? []), rel]);
    }
  }
  return finish(dir, found, folders);
}

/**
 * Indexes resource collections: every folder holding a `_collection.json`,
 * keyed by the folder name (which must equal the collection id).
 */
export function indexCollections(
  root: string,
  dir: string,
  walk: Walker = defaultWalker,
): ConfigIndex {
  const found = new Map<string, string[]>();
  const dirs: string[] = [];
  for (const { rel, inside, entry } of walkConfigDir(root, dir, walk)) {
    if (entry.isDirectory && inside !== "") dirs.push(inside);
    if (entry.isFile && basename(rel) === "_collection.json") {
      const id = basename(dirname(rel));
      found.set(id, [...(found.get(id) ?? []), rel]);
    }
  }
  const collectionDirs = [...found.values()].flat().map((p) =>
    toPosix(relative(dir, dirname(p)))
  );
  // Collections can be sorted into folders, but not nested in each other.
  const folders = [
    ".",
    ...dirs.filter((d) =>
      !collectionDirs.some((c) => d === c || d.startsWith(c + "/"))
    ),
  ];
  return finish(dir, found, folders);
}

function finish(
  dir: string,
  found: Map<string, string[]>,
  folders: string[],
): ConfigIndex {
  // Sorted, so the index doesn't depend on the order the OS lists files in.
  const files = new Map<string, string>();
  const duplicates = new Map<string, string[]>();
  for (const [name, paths] of sortedEntries(found)) {
    if (paths.length > 1) duplicates.set(name, paths.sort());
    else files.set(name, paths[0]);
  }
  const sorted = [...new Set(folders)].filter((f) => f !== ".").sort();
  return { dir, files, folders: [".", ...sorted], duplicates };
}

/** Map entries sorted by key, independent of the order they were found in. */
export const sortedEntries = <T>(map: Map<string, T>): [string, T][] =>
  [...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);

/** Throws one error listing every duplicate across the given indexes. */
export function assertNoDuplicates(indexes: ConfigIndex[]) {
  const all = new Map<string, string[]>();
  for (const index of indexes) {
    for (const [name, paths] of index.duplicates) {
      all.set(`${index.dir}/${name}`, paths);
    }
  }
  if (all.size) throw new DuplicateNamesError(all);
}
