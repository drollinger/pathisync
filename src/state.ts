// The per-machine record of what each config looked like at the last
// successful sync, kept in `.pathisync/state.json` (gitignored).

import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";

export const STATE_DIR = ".pathisync";
const STATE_VERSION = 2;

type Entries = Record<string, string>;

/** One record per server URL, so switching env files keeps each server's. */
type StateFile = { version: 2; servers: Record<string, Entries> };

/** Before version 2 the file held one server. */
type StateFileV1 = { version: 1; server: string; entries: Entries };

/** Every server's record in the file; empty if missing or unreadable. */
function readServers(root: string): Record<string, Entries> {
  try {
    const file = JSON.parse(
      Deno.readTextFileSync(SyncState.path(root)),
    ) as StateFile | StateFileV1;
    const valid = (e: unknown): e is Entries => !!e && typeof e === "object";
    if (file.version === STATE_VERSION) {
      return Object.fromEntries(
        Object.entries(file.servers ?? {}).filter(([, e]) => valid(e)),
      );
    }
    if (file.version === 1 && valid(file.entries)) {
      return { [file.server]: file.entries };
    }
  } catch (_) {
    // No record yet: behave as before pathisync kept one.
  }
  return {};
}

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
   * Loads the record for `server`. A missing or unreadable file, an unknown
   * version, or a server with no record yet all start an empty record.
   */
  static load(root: string, server: string, writable = true): SyncState {
    return new SyncState(
      root,
      server,
      readServers(root)[server] ?? {},
      writable,
    );
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

  /**
   * Writes atomically (temp file, then rename) if anything changed, keeping
   * the other servers' records.
   */
  save() {
    if (!this.writable || !this.#dirty) return;
    const byKey = ([a]: [string, unknown], [b]: [string, unknown]) =>
      a < b ? -1 : a > b ? 1 : 0;
    const servers = {
      ...readServers(this.root),
      [this.server]: Object.fromEntries([...this.#entries].sort(byKey)),
    };
    const file: StateFile = {
      version: STATE_VERSION,
      servers: Object.fromEntries(Object.entries(servers).sort(byKey)),
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
