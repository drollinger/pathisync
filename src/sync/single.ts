// The adapter shared by flows, shared configs and triggers: configs pushed
// and deleted one at a time. Where each type lives on disk is its `Layout`.

import { basename, dirname, join } from "@std/path";
import { diffFiles, type DiskFile } from "../diff.ts";
import { AuthError, errorMessage, LocalFileError } from "../errors.ts";
import {
  changedFunctionCount,
  explode,
  FlowCodecError,
  implode,
} from "../flowCodec.ts";
import {
  FLOW_FILE,
  flowDirFor,
  flowNameFromDir,
  FLOWS_DIR,
  indexFlows,
  indexTriggers,
  invalidPathPart,
  PROCESSORS_FILE,
  processorsPathFor,
  TRIGGER_SUFFIX,
  triggerFileIn,
  TRIGGERS_DIR,
} from "../flowLayout.ts";
import { type ConfigIndex, indexConfigs } from "../fsIndex.ts";
import { guardFor, hasPlainTextSecret } from "../guardrails.ts";
import { deepEqual, hashConfig } from "../hash.ts";
import {
  exists,
  readLocalJson,
  readLocalText,
  removeEmptyDirs,
  removeLocalFile,
  toJsonText,
  writeLocalFile,
} from "../localFiles.ts";
import type { FlowObj, TriggerObj } from "../types.ts";
import type { Adapter, PlanResult } from "./adapter.ts";
import { decide } from "./decide.ts";
import { makePlan } from "./status.ts";
import { offerTriggerMoves, triggerLayoutNotes } from "./triggerPlacement.ts";
import type {
  AdapterName,
  Decision,
  Kind,
  Plan,
  SyncContext,
} from "./types.ts";

type Obj = Record<string, unknown>;

/** Where one config type lives on disk. */
export type Layout = {
  index(ctx: SyncContext): ConfigIndex;
  /** The file holding a config's JavaScript, for types that split it out (flows). */
  jsPath?(jsonPath: string): string;
  /** Where a config pulled from the server is created. May prompt. */
  newPath(
    ctx: SyncContext,
    id: string,
    remote: Obj,
    index: ConfigIndex,
  ): Promise<string>;
  /** Why a server config can't be created locally, if it can't. */
  cannotCreate?(id: string): string | null;
  /** An error when a local file's content doesn't fit where it is. */
  checkLocal?(id: string, path: string, config: Obj): string | null;
  /** Maps a local file to the id of the config it belongs to. */
  ownerOf(ctx: SyncContext, relPath: string): string | null;
  /** How the config's files are named in diffs. */
  fileNames(id: string): { json: string; js: string };
  displayPath(path: string): string;
};

export type SingleSpec = {
  name: AdapterName;
  kind: Kind;
  typeLabel: string;
  dir: string;
  urlPath: string;
  getName(obj: Obj): string;
  /** Removes fields that change constantly and don't need tracking. */
  removeAttributes?(obj: Obj): void;
  layout: Layout;
  /** Runs after every action has been applied (trigger placement). */
  afterApply?(ctx: SyncContext): Promise<void>;
  /** Layout warnings for `check`. */
  layoutNotes?(ctx: SyncContext): string[];
};

type LocalCopy = {
  /** Server form, rebuilt from the local files. */
  config: Obj;
  warnings: string[];
};

export function singleAdapter(spec: SingleSpec): Adapter {
  const { layout } = spec;

  /** Server form with volatile fields removed: what gets compared and hashed. */
  const comparable = (obj: Obj): Obj => {
    const copy = structuredClone(obj);
    delete copy.metadata;
    spec.removeAttributes?.(copy);
    return copy;
  };

  function readLocal(ctx: SyncContext, path: string): LocalCopy {
    const json = readLocalJson<Obj>(ctx.root, path);
    if (!layout.jsPath) return { config: json, warnings: [] };
    const js = readLocalText(ctx.root, layout.jsPath(path));
    try {
      const { flow, warnings } = implode(json as FlowObj, js);
      return { config: flow as Obj, warnings };
    } catch (error) {
      if (error instanceof FlowCodecError) {
        throw new LocalFileError(
          path,
          `cannot rebuild the flow from its ${FLOW_FILE} and ${PROCESSORS_FILE}:\n  ${
            error.problems.join("\n  ")
          }`,
        );
      }
      throw error;
    }
  }

  /** The files a config would be written as, for diffs. */
  function render(obj: Obj | undefined, id: string): DiskFile[] {
    if (!obj) return [];
    const names = layout.fileNames(id);
    if (!layout.jsPath) return [{ name: names.json, text: toJsonText(obj) }];
    const { json, js } = explode(obj as FlowObj);
    return [
      { name: names.json, text: toJsonText(json) },
      ...(js === null ? [] : [{ name: names.js, text: js }]),
    ];
  }

  function writeLocal(ctx: SyncContext, path: string, obj: Obj) {
    if (!layout.jsPath) {
      writeLocalFile(ctx.root, path, toJsonText(obj));
      ctx.out.log(`File "${path}" Saved`);
      return;
    }
    const { json, js } = explode(obj as FlowObj);
    writeLocalFile(ctx.root, path, toJsonText(json));
    if (js === null) removeLocalFile(ctx.root, layout.jsPath(path));
    else writeLocalFile(ctx.root, layout.jsPath(path), js);
    ctx.out.log(
      `File "${path}"${js === null ? "" : ` (+${PROCESSORS_FILE})`} Saved`,
    );
  }

  const adapter: Adapter = {
    name: spec.name,
    dir: spec.dir,

    index: (ctx) => layout.index(ctx),

    fetch: (ctx) => ctx.client.requestJson<Obj[]>(spec.urlPath),

    async plan(ctx, remoteList, index): Promise<PlanResult> {
      const remoteById = new Map(
        (remoteList as Obj[]).map((r) => [spec.getName(r), r]),
      );
      const scoped = ctx.scope?.ids.get(spec.name);
      const inScope = (id: string) => !scoped || scoped.has(id);
      const ids = [...new Set([...index.files.keys(), ...remoteById.keys()])]
        .filter(inScope).sort();
      const result: PlanResult = {
        groups: [],
        errors: (index.problems ?? []).filter((p) => {
          const owner = layout.ownerOf(ctx, p.path);
          return !scoped || (owner !== null && inScope(owner));
        }),
      };

      for (const id of ids) {
        const path = index.files.get(id);
        let local: LocalCopy | undefined;
        if (path) {
          try {
            local = readLocal(ctx, path);
            const problem = layout.checkLocal?.(id, path, local.config);
            if (problem) throw new LocalFileError(path, problem);
          } catch (error) {
            if (!(error instanceof LocalFileError)) throw error;
            result.errors.push(error);
            continue;
          }
        }
        const remote = remoteById.get(id);
        const localCmp = local && comparable(local.config);
        const remoteCmp = remote && comparable(remote);
        const notes = [...(local?.warnings ?? [])];
        if (local && spec.getName(local.config) !== id) {
          notes.push(
            `the name inside the file is "${
              spec.getName(local.config)
            }", but the file is named for ${id}`,
          );
        }
        const cannotCreate = !local && layout.cannotCreate?.(id);
        if (cannotCreate) {
          notes.push(`can't be created locally: ${cannotCreate}`);
        }
        if (hasPlainTextSecret(spec.kind, local?.config)) {
          ctx.out.warn(
            `Warning: ${path} is a secure shared config with a plain-text "config" value. Make sure the secret isn't committed to git.`,
          );
        }
        const plan = makePlan(
          {
            key: `${spec.kind}:${id}`,
            kind: spec.kind,
            id,
            typeLabel: spec.typeLabel,
            path,
            displayPath: path && layout.displayPath(path),
            local: local?.config,
            remote: remoteCmp,
            localHash: localCmp && await hashConfig(localCmp),
            remoteHash: remoteCmp && await hashConfig(remoteCmp),
            guard: guardFor(
              spec.kind,
              local?.config,
              remote,
              ctx.options.allowBundled,
            ),
            notes,
            diff: () => diffFiles(render(remoteCmp, id), render(localCmp, id)),
          },
          ctx.state.get(`${spec.kind}:${id}`),
          ctx.options,
        );
        if (!plan) continue;
        if (cannotCreate) {
          plan.options = plan.options.filter((o) => o !== "create-local");
        }
        result.groups.push({ plan, children: [] });
      }
      return result;
    },

    async apply(ctx, result, initialIndex) {
      const { state, out } = ctx;
      let index = initialIndex;
      const pushed: { plan: Plan; body: Obj; path: string }[] = [];

      for (const { plan } of result.groups) {
        if (plan.status === "in-sync") {
          state.set(plan.key, plan.remoteHash!);
          continue;
        }
        const decision = await decide(
          plan,
          ctx,
          () => layout.newPath(ctx, plan.id, plan.remote as Obj, index),
        );
        try {
          const wrote = await applyOne(ctx, plan, decision, pushed);
          // Later lookups in this run must see files created or deleted here.
          if (wrote) index = adapter.index(ctx);
        } catch (error) {
          if (error instanceof AuthError) throw error;
          const failure = `${decision.action} ${plan.typeLabel} ${plan.id}: ${
            errorMessage(error)
          }`;
          ctx.failures.push(failure);
          out.error(`✖ ${failure}`);
        }
        state.save();
      }

      if (pushed.length) await reconcile(ctx, pushed);
      // Forget configs that no longer exist on either side. Skipped when a
      // local file couldn't be read, since it may belong to one of them.
      if (!ctx.scope && !result.errors.length) {
        const seen = new Set(result.groups.map((g) => g.plan.key));
        for (const key of state.keys()) {
          if (key.startsWith(`${spec.kind}:`) && !seen.has(key)) {
            state.delete(key);
          }
        }
      }
      state.save();
      await spec.afterApply?.(ctx);
    },

    ownerOf: (ctx, relPath) => layout.ownerOf(ctx, relPath),

    notes: spec.layoutNotes,
  };

  /** Returns true when local files were created or deleted. */
  async function applyOne(
    ctx: SyncContext,
    plan: Plan,
    decision: Decision,
    pushed: { plan: Plan; body: Obj; path: string }[],
  ): Promise<boolean> {
    const { client, state, out } = ctx;
    const remote = plan.remote as Obj | undefined;
    const local = plan.local as Obj | undefined;
    switch (decision.action) {
      case "nothing":
        return false;
      case "pull":
        writeLocal(ctx, plan.path!, remote!);
        state.set(plan.key, plan.remoteHash!);
        return false;
      case "create-local": {
        const path = decision.location!;
        writeLocal(ctx, path, remote!);
        state.set(plan.key, plan.remoteHash!);
        return true;
      }
      case "push": {
        await client.request("POST", spec.urlPath, local);
        const detail = layout.jsPath && remote
          ? ` (${
            changedFunctionCount(
              remote as FlowObj,
              comparable(local!) as FlowObj,
            )
          } functions changed)`
          : "";
        out.log(`✔ pushed ${plan.typeLabel} ${plan.id}${detail}`);
        pushed.push({ plan, body: local!, path: plan.path! });
        return false;
      }
      case "delete-local":
        removeLocalFile(ctx.root, plan.path!);
        if (layout.jsPath) removeLocalFile(ctx.root, layout.jsPath(plan.path!));
        removeEmptyDirs(ctx.root, dirname(plan.path!), spec.dir);
        out.log(`Deleted ${plan.displayPath}`);
        if (!plan.remoteHash) state.delete(plan.key);
        return true;
      case "delete-remote":
        await client.request("DELETE", `${spec.urlPath}/${plan.id}`);
        out.log(`✔ deleted remote ${plan.typeLabel} ${plan.id}`);
        if (!plan.localHash) state.delete(plan.key);
        return false;
    }
  }

  /**
   * Re-fetches after pushing and records what the server actually stored. If
   * it normalized what it was given (added defaults, new fields), the local
   * copy is updated so the next sync doesn't report a server change.
   */
  async function reconcile(
    ctx: SyncContext,
    pushed: { plan: Plan; body: Obj; path: string }[],
  ) {
    const fresh = new Map(
      (await adapter.fetch(ctx) as Obj[]).map((r) => [spec.getName(r), r]),
    );
    for (const { plan, body, path } of pushed) {
      const stored = fresh.get(spec.getName(body));
      if (!stored) {
        ctx.out.warn(
          `${plan.typeLabel} ${plan.id} was pushed, but the server doesn't list it afterwards`,
        );
        continue;
      }
      const storedCmp = comparable(stored);
      if (!deepEqual(storedCmp, comparable(body))) {
        ctx.out.log(
          `The server normalized ${plan.typeLabel} ${plan.id}; updating the local copy`,
        );
        writeLocal(ctx, path, storedCmp);
      }
      ctx.state.set(plan.key, await hashConfig(storedCmp));
    }
    ctx.state.save();
  }

  return adapter;
}

/** Asks which folder of `dir` a new config goes in (skipped with `-lf`). */
export async function chooseFolderIn(
  ctx: SyncContext,
  dir: string,
  folders: string[],
): Promise<string> {
  const { options, prompter } = ctx;
  if (options.preferServer && options.forceDefaultFolder) return ".";
  const folder = await prompter.select(
    "Choose a folder in " + dir,
    [...folders, "<New Folder>"].map((f) => ({ name: f, value: f })),
  );
  return folder === "<New Folder>"
    ? await prompter.input("Enter new folder name:")
    : folder;
}

/** One `<name>.json` per config, sortable into any folders. */
function flatLayout(dir: string): Layout {
  return {
    index: (ctx) => indexConfigs(ctx.root, dir, ctx.walk),
    async newPath(ctx, id, _remote, index) {
      const folder = await chooseFolderIn(ctx, dir, index.folders);
      return join(dir, folder, `${id}.json`).replaceAll("\\", "/");
    },
    ownerOf(_ctx, relPath) {
      if (!relPath.startsWith(dir + "/") || !relPath.endsWith(".json")) {
        return null;
      }
      return basename(relPath, ".json");
    },
    fileNames: (id) => ({ json: `${id}.json`, js: "" }),
    displayPath: (path) => path,
  };
}

/** Each flow is a folder named for it, under its @namespace and +sub-namespace folders. */
const flowLayout: Layout = {
  index: (ctx) => indexFlows(ctx.root, ctx.walk),
  jsPath: processorsPathFor,
  newPath(_ctx, id) {
    const target = flowDirFor(id);
    if ("error" in target) {
      return Promise.reject(new LocalFileError(id, target.error));
    }
    return Promise.resolve(`${target.dir}/${FLOW_FILE}`);
  },
  cannotCreate(id) {
    const target = flowDirFor(id);
    return "error" in target ? target.error : null;
  },
  checkLocal(id, _path, config) {
    const name = (config as FlowObj).name;
    if (name === id) return null;
    return `${FLOW_FILE} names the flow "${name}", but its folder is for "${id}". ` +
      `Rename the folder, or the name, so they match (a different name would create a new flow on the server)`;
  },
  ownerOf(ctx, relPath) {
    const file = basename(relPath);
    if (
      !relPath.startsWith(FLOWS_DIR + "/") ||
      (file !== FLOW_FILE && file !== PROCESSORS_FILE)
    ) return null;
    if (!exists(join(ctx.root, dirname(relPath), FLOW_FILE))) return null;
    const result = flowNameFromDir(dirname(relPath));
    return "name" in result ? result.name : null;
  },
  fileNames: () => ({ json: FLOW_FILE, js: PROCESSORS_FILE }),
  displayPath: (path) => `${dirname(path)}/`,
};

/**
 * `<name>.trigger.json` in the folder of the flow it runs, or `<name>.json`
 * under `triggers/` when that flow isn't local.
 */
const triggerLayout: Layout = {
  index: (ctx) => indexTriggers(ctx.root, ctx.walk),
  async newPath(ctx, id, remote, index) {
    const flow = (remote as TriggerObj).config?.orchestratorName;
    const flowPath = flow && indexFlows(ctx.root).files.get(flow);
    if (flowPath && !invalidPathPart(id + TRIGGER_SUFFIX)) {
      return triggerFileIn(flowPath, id);
    }
    const folder = await chooseFolderIn(ctx, TRIGGERS_DIR, index.folders);
    return join(TRIGGERS_DIR, folder, `${id}.json`).replaceAll("\\", "/");
  },
  ownerOf(_ctx, relPath) {
    if (
      relPath.startsWith(FLOWS_DIR + "/") && relPath.endsWith(TRIGGER_SUFFIX)
    ) {
      return basename(relPath, TRIGGER_SUFFIX);
    }
    if (relPath.startsWith(TRIGGERS_DIR + "/") && relPath.endsWith(".json")) {
      return basename(relPath, ".json");
    }
    return null;
  },
  fileNames: (id) => ({ json: `${id}.json`, js: "" }),
  displayPath: (path) => path,
};

export const flows = singleAdapter({
  name: "flows",
  kind: "flow",
  typeLabel: "flow",
  dir: FLOWS_DIR,
  urlPath: "/repository/flows",
  getName: (obj) => (obj as FlowObj).name,
  removeAttributes: (obj) => {
    // These ids constantly change and do not need to be tracked
    for (const processor of Object.values((obj as FlowObj).processors ?? {})) {
      const config = processor?.config;
      if (config?.userFetchProviderWhenUsingClaims?.id) {
        delete config.userFetchProviderWhenUsingClaims.id;
      }
      if (Array.isArray(config?.testConfig)) {
        for (const item of config.testConfig) if (item?.id) delete item.id;
      }
    }
  },
  layout: flowLayout,
});

export const sharedConfigs = singleAdapter({
  name: "sharedConfigs",
  kind: "sharedConfig",
  typeLabel: "shared config",
  dir: "sharedConfigs",
  urlPath: "/repository/sharedConfig",
  getName: (obj) => obj.referenceId as string,
  layout: flatLayout("sharedConfigs"),
});

export const triggers = singleAdapter({
  name: "triggers",
  kind: "trigger",
  typeLabel: "trigger",
  dir: TRIGGERS_DIR,
  urlPath: "/repository/flowTriggerers",
  getName: (obj) =>
    ((obj.config ?? obj.invalidConfig) as { name: string }).name,
  layout: triggerLayout,
  afterApply: offerTriggerMoves,
  layoutNotes: triggerLayoutNotes,
});
