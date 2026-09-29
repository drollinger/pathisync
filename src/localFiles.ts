import { ensureDirSync } from "@std/fs";
import { basename, dirname, join, resolve } from "@std/path";
import { LocalFileError } from "./errors.ts";

/** How every config JSON file is written: 2-space indent, trailing newline. */
export const toJsonText = (value: unknown) =>
  JSON.stringify(value, null, 2) + "\n";

/**
 * Remembers the content of every file pathisync writes, so watch mode can
 * drop the file events caused by its own writes.
 */
export class WriteTracker {
  #last = new Map<string, Uint8Array>();

  record(path: string, bytes: Uint8Array) {
    this.#last.set(realPath(path), bytes);
  }

  forget(path: string) {
    this.#last.delete(realPath(path));
  }

  /** True when the file still holds exactly what pathisync last wrote. */
  isOwnWrite(path: string): boolean {
    const last = this.#last.get(realPath(path));
    if (!last) return false;
    try {
      return bytesEqual(Deno.readFileSync(path), last);
    } catch (_) {
      return false;
    }
  }
}

export const writes = new WriteTracker();

/**
 * The path with symlinks resolved, as file watchers report it (on macOS,
 * `/var/…` is really `/private/var/…`). Missing files resolve their folder.
 */
export function realPath(path: string): string {
  try {
    return Deno.realPathSync(path);
  } catch (_) {
    try {
      return join(Deno.realPathSync(dirname(path)), basename(path));
    } catch (_) {
      return resolve(path);
    }
  }
}

const encoder = new TextEncoder();

export function writeLocalFile(
  root: string,
  relPath: string,
  content: string | Uint8Array,
) {
  const path = join(root, relPath);
  const bytes = typeof content === "string" ? encoder.encode(content) : content;
  ensureDirSync(dirname(path));
  // Write to a temp file and rename, so a crash never leaves half a file.
  const temp = `${path}.pathisync-tmp`;
  Deno.writeFileSync(temp, bytes);
  Deno.renameSync(temp, path);
  writes.record(path, bytes);
}

export function removeLocalFile(root: string, relPath: string) {
  const path = join(root, relPath);
  try {
    Deno.removeSync(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  writes.forget(path);
}

/**
 * Removes `relDir` and its parents while they're empty, stopping at `stopAt`
 * (e.g. an emptied flow folder and its namespace folder, but never `flows/`).
 */
export function removeEmptyDirs(root: string, relDir: string, stopAt: string) {
  let dir = relDir;
  while (dir.startsWith(stopAt + "/")) {
    try {
      Deno.removeSync(join(root, dir)); // fails unless empty
    } catch (_) {
      return;
    }
    dir = dirname(dir);
  }
}

export function readLocalText(root: string, relPath: string): string | null {
  try {
    return Deno.readTextFileSync(join(root, relPath));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw new LocalFileError(relPath, String(error));
  }
}

export function readLocalBytes(
  root: string,
  relPath: string,
): Uint8Array | null {
  try {
    return Deno.readFileSync(join(root, relPath));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw new LocalFileError(relPath, String(error));
  }
}

export function readLocalJson<T>(root: string, relPath: string): T {
  const text = readLocalText(root, relPath);
  if (text === null) throw new LocalFileError(relPath, "file not found");
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new LocalFileError(
      relPath,
      `invalid JSON (${(error as Error).message})`,
    );
  }
}

export function exists(path: string) {
  try {
    Deno.statSync(path);
    return true;
  } catch (_) {
    return false;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
