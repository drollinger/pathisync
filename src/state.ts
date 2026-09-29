// The per-machine record of what each config looked like at the last
// successful sync, kept in `.pathisync/state.json` (gitignored).

import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";

export const STATE_DIR = ".pathisync";
const STATE_VERSION = 1;

type StateFile = {
  version: number;
  server: string;
  entries: Record<string, string>;
};

export class SyncState {
  #entries: Map<string, string>;
  #dirty = false;

  private constructor(
    readonly root: string,
    readonly server: string,
    entries: Record<string, string>,
    /** When false (`check`), nothing is ever written. */
    readonly writable: boolean,
  ) {
    this.#entries = new Map(Object.entries(entries));
  }

  static path(root: string) {
    return join(root, STATE_DIR, "state.json");
  }

  /**
   * Loads the record for `server`. A missing or unreadable file, another
   * version, or a different server URL all start an empty record.
   */
  static load(root: string, server: string, writable = true): SyncState {
    let entries: Record<string, string> = {};
    try {
      const file = JSON.parse(
        Deno.readTextFileSync(SyncState.path(root)),
      ) as StateFile;
      if (
        file.version === STATE_VERSION && file.server === server &&
        file.entries && typeof file.entries === "object"
      ) entries = file.entries;
    } catch (_) {
      // No record yet: behave as before pathisync kept one.
    }
    return new SyncState(root, server, entries, writable);
  }

  get(key: string): string | undefined {
    return this.#entries.get(key);
  }

  keys(): string[] {
    return [...this.#entries.keys()];
  }

  set(key: string, hash: string) {
    if (this.#entries.get(key) === hash) return;
    this.#entries.set(key, hash);
    this.#dirty = true;
  }

  delete(key: string) {
    if (this.#entries.delete(key)) this.#dirty = true;
  }

  /** Writes atomically (temp file, then rename) if anything changed. */
  save() {
    if (!this.writable || !this.#dirty) return;
    const file: StateFile = {
      version: STATE_VERSION,
      server: this.server,
      entries: Object.fromEntries(
        [...this.#entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
      ),
    };
    ensureDirSync(join(this.root, STATE_DIR));
    const path = SyncState.path(this.root);
    Deno.writeTextFileSync(`${path}.tmp`, JSON.stringify(file, null, 2) + "\n");
    Deno.renameSync(`${path}.tmp`, path);
    this.#dirty = false;
  }
}

/** True if git tracks anything under `.pathisync/`, which it shouldn't. */
export async function isStateTrackedByGit(root: string): Promise<boolean> {
  try {
    const { success, stdout } = await new Deno.Command("git", {
      args: ["ls-files", "--", STATE_DIR],
      cwd: root,
      stdout: "piped",
      stderr: "null",
    }).output();
    return success && new TextDecoder().decode(stdout).trim() !== "";
  } catch (_) {
    return false; // git not installed, or not a repository
  }
}
