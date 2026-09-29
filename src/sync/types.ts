import type { Client } from "../client.ts";
import type { Walker } from "../fsIndex.ts";
import type { Guard } from "../guardrails.ts";
import type { SyncState } from "../state.ts";
import type { Output, Prompter } from "../ui.ts";

export type Kind =
  | "flow"
  | "sharedConfig"
  | "trigger"
  | "resourceCollection"
  | "resource";

/** The rows of the decision table in issue 03. */
export type Status =
  | "in-sync"
  /** Both sides exist and differ, and there is no record of the last sync. */
  | "unknown"
  | "server-changed"
  | "local-changed"
  | "conflict"
  | "new-local"
  | "deleted-on-server"
  | "deleted-on-server-edited"
  | "new-on-server"
  | "deleted-locally"
  | "deleted-locally-edited";

export type Action =
  | "nothing"
  | "pull"
  | "push"
  | "create-local"
  | "delete-local"
  | "delete-remote";

/**
 * One comparable config: a flow, trigger, shared config, a collection's
 * metadata, or a single resource. `local`/`remote` are in server form with
 * volatile fields removed, or undefined when that side doesn't exist.
 */
export type Unit = {
  /** State file key, e.g. `flow:grades@widgets`. */
  key: string;
  kind: Kind;
  id: string;
  /** e.g. `flow`, `shared config`, `resource`. */
  typeLabel: string;
  /** Where the config lives locally, for display (may not exist yet). */
  path?: string;
  /** `path` plus sibling files, e.g. `flows/x.json (+.js)`. */
  displayPath?: string;
  local?: unknown;
  remote?: unknown;
  localHash?: string;
  remoteHash?: string;
  guard: Guard | null;
  /** Warnings to show next to the plan, e.g. unreferenced functions. */
  notes: string[];
  /** Unified diff of the files as they'd look on disk. */
  diff(): Promise<string>;
  /** Overrides for the default wording of an action in prompts. */
  labels?: Partial<Record<Action, string>>;
  /** Actions the adapter allows beyond the table (e.g. removing a dangling entry). */
  extraOptions?: Action[];
};

/** A unit with its status and the actions the user may pick from. */
export type Plan = Unit & {
  status: Status;
  baseline?: string;
  options: Action[];
};

export type Decision = {
  action: Action;
  /**
   * Where `create-local` writes: a folder (relative to `resources/`) for a
   * collection, the file path for a single config.
   */
  location?: string;
  /** For deleting a resource: also delete the file, not just the entry. */
  deleteFile?: boolean;
};

export type Mode = "interactive" | "watch" | "check";

export type SyncOptions = {
  mode: Mode;
  /** `-l`: resolve conflicts and ambiguous cases in favor of the server. */
  preferServer: boolean;
  /** `-d`: offer delete options. */
  allowDelete: boolean;
  /** `-f` (with `-l`): create new local files in the default folder. */
  forceDefaultFolder: boolean;
  allowBundled: boolean;
  /** Show diffs before prompts (`--no-diff` turns this off). */
  showDiff: boolean;
};

/** Which configs a run covers. Absent means everything. */
export type Scope = {
  /** Adapter name → config ids to include, or null for all of that type. */
  ids: Map<AdapterName, Set<string> | null>;
};

export type AdapterName = "flows" | "sharedConfigs" | "triggers" | "resources";

export type SyncContext = {
  root: string;
  client: Client;
  state: SyncState;
  prompter: Prompter;
  out: Output;
  options: SyncOptions;
  scope?: Scope;
  walk?: Walker;
  /** Failed actions, reported at the end and reflected in the exit code. */
  failures: string[];
  /** Watch mode: guard refusals already printed this session. */
  refusedOnce?: Set<string>;
};
