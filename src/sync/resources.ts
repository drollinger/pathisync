// Resource collections: `_collection.json` holds the collection and its
// resource entries (with `resourceBytes: ""`), and each resource's content
// sits next to it at its `resourceAccessorPath`. The server takes the whole
// collection in one POST, so resource-level decisions are gathered per
// collection before anything is pushed.

import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import { diffFiles, type DiskFile, isTextResource } from "../diff.ts";
import { AuthError, errorMessage, LocalFileError } from "../errors.ts";
import { type ConfigIndex, indexCollections } from "../fsIndex.ts";
import { type Guard, guardFor } from "../guardrails.ts";
import { deepEqual, hashConfig } from "../hash.ts";
import {
  exists,
  readLocalBytes,
  readLocalJson,
  removeLocalFile,
  toJsonText,
  writeLocalFile,
} from "../localFiles.ts";
import type { CollectionObj, ResourceObj } from "../types.ts";
import type { Adapter, PlanGroup, PlanResult } from "./adapter.ts";
import { decide } from "./decide.ts";
import { makePlan } from "./status.ts";
import type { Action, Decision, Plan, SyncContext } from "./types.ts";

const DIR = "resources";
const URL_PATH = "/repository/resourceCollections";

type Meta = Omit<CollectionObj, "resources">;

/** Collection fields other than its resources, without server metadata. */
function metaOf(collection: CollectionObj): Meta {
  const { resources: _, metadata: __, ...meta } = collection;
  return meta;
}

/** A collection with `meta`'s fields and the given resources, in `meta`'s key order. */
function assemble(
  meta: Meta,
  resources: ResourceObj[],
  keyOrder?: string[],
): CollectionObj {
  const out: Record<string, unknown> = {};
  const keys = keyOrder ?? [...Object.keys(meta), "resources"];
  for (const key of keys) {
    if (key === "resources") out.resources = resources;
    else if (key in meta) out[key] = (meta as Record<string, unknown>)[key];
  }
  for (const [key, value] of Object.entries(meta)) {
    if (!(key in out)) out[key] = value;
  }
  if (!("resources" in out)) out.resources = resources;
  return out as CollectionObj;
}

const withoutBytes = (r: ResourceObj): ResourceObj => ({
  ...r,
  resourceBytes: "",
});

/** Resolves a resource's file path, refusing paths that leave the collection. */
function resourcePath(collectionDir: string, accessorPath: string): string {
  const path = join(collectionDir, accessorPath);
  const rel = relative(collectionDir, path);
  if (rel.startsWith("..") || resolve(path) === resolve(collectionDir)) {
    throw new LocalFileError(
      `${collectionDir}/_collection.json`,
      `resourceAccessorPath ${accessorPath} points outside the collection folder`,
    );
  }
  return SEPARATOR === "/" ? path : path.replaceAll(SEPARATOR, "/");
}

type ChildInfo = {
  resourceId: string;
  localEntry?: ResourceObj;
  remoteEntry?: ResourceObj;
  /** The entry is in `_collection.json` but its file is missing. */
  dangling: boolean;
  filePath?: string;
};

type CollectionGroup = PlanGroup & {
  id: string;
  collectionDir?: string;
  local?: CollectionObj;
  remote?: CollectionObj;
  childInfo: Map<string, ChildInfo>;
};

export const resources: Adapter = {
  name: "resources",
  dir: DIR,

  index: (ctx) => indexCollections(ctx.root, DIR, ctx.walk),

  fetch: (ctx) => ctx.client.requestJson<CollectionObj[]>(URL_PATH),

  async plan(ctx, remoteList, index) {
    const remoteById = new Map(
      (remoteList as CollectionObj[]).map((c) => [c.collectionId, c]),
    );
    const scoped = ctx.scope?.ids.get("resources");
    const ids = [...new Set([...index.files.keys(), ...remoteById.keys()])]
      .filter((id) => !scoped || scoped.has(id)).sort();
    const result: PlanResult = { groups: [], errors: [] };
    for (const id of ids) {
      try {
        const group = await planCollection(
          ctx,
          id,
          index.files.get(id),
          remoteById.get(id),
        );
        if (group) result.groups.push(group);
      } catch (error) {
        if (!(error instanceof LocalFileError)) throw error;
        result.errors.push(error);
      }
    }
    return result;
  },

  async apply(ctx, result, initialIndex) {
    let index = initialIndex;
    const pushed: {
      group: CollectionGroup;
      body: CollectionObj;
      units: Set<string>;
    }[] = [];
    for (const group of result.groups as CollectionGroup[]) {
      try {
        const outcome = await applyCollection(ctx, group, () => index);
        if (outcome.pushed) pushed.push({ group, ...outcome.pushed });
        if (outcome.wroteFiles) index = resources.index(ctx);
      } catch (error) {
        if (error instanceof AuthError) throw error;
        const failure = `collection ${group.id}: ${errorMessage(error)}`;
        ctx.failures.push(failure);
        ctx.out.error(`✖ ${failure}`);
      }
      ctx.state.save();
    }
    if (pushed.length) await reconcile(ctx, pushed);
    if (!ctx.scope) {
      const seen = new Set(
        result.groups.flatMap((
          g,
        ) => [g.plan.key, ...g.children.map((c) => c.key)]),
      );
      // Collections skipped because of a local error keep their record.
      const failed = new Set(
        result.errors.map((e) => basename(dirname(e.path))),
      );
      for (const key of ctx.state.keys()) {
        const match = /^(?:resourceCollection|resource):([^/]+)/.exec(key);
        if (!match || seen.has(key) || failed.has(match[1])) continue;
        ctx.state.delete(key);
      }
    }
    ctx.state.save();
  },

  ownerOf(ctx, relPath) {
    if (!relPath.startsWith(DIR + "/")) return null;
    // Walk up to the folder holding the collection's _collection.json.
    let dir = dirname(relPath);
    while (dir !== DIR && dir !== "." && dir !== "") {
      if (exists(join(ctx.root, dir, "_collection.json"))) {
        return dir.split("/").pop()!;
      }
      dir = dirname(dir);
    }
    return null;
  },
};

async function planCollection(
  ctx: SyncContext,
  id: string,
  collectionPath: string | undefined,
  remoteRaw: CollectionObj | undefined,
): Promise<CollectionGroup | null> {
  const { state, options } = ctx;
  const collectionDir = collectionPath && dirname(collectionPath);
  const local = collectionPath
    ? readLocalJson<CollectionObj>(ctx.root, collectionPath)
    : undefined;
  if (local && !Array.isArray(local.resources)) {
    throw new LocalFileError(collectionPath!, `"resources" must be a list`);
  }
  const remote = remoteRaw &&
    assemble(
      metaOf(remoteRaw),
      remoteRaw.resources ?? [],
      Object.keys(remoteRaw),
    );
  const guard = guardFor(
    "resourceCollection",
    local as Record<string, unknown> | undefined,
    remote as Record<string, unknown> | undefined,
    options.allowBundled,
  );
  const localMeta = local && metaOf(local);
  const remoteMeta = remote && metaOf(remote);
  const metaFile = (meta?: Meta): DiskFile[] =>
    meta
      ? [{
        name: "_collection.json (without resources)",
        text: toJsonText(meta),
      }]
      : [];

  const bothSides = !!local && !!remote;
  const labels: Partial<Record<Action, string>> = bothSides
    ? {
      pull: "Overwrite local _collection.json",
      push: "Push local _collection.json to remote prod",
    }
    : {
      push: "Push new collection to prod",
      "create-local": "Create new local collection",
      "delete-local": "Delete local collection",
      "delete-remote": "Delete remote prod collection",
    };

  // Resources, matched by id.
  const childInfo = new Map<string, ChildInfo>();
  for (const entry of local?.resources ?? []) {
    childInfo.set(entry.resourceId, {
      resourceId: entry.resourceId,
      localEntry: entry,
      dangling: false,
    });
  }
  for (const entry of remote?.resources ?? []) {
    const info = childInfo.get(entry.resourceId) ??
      { resourceId: entry.resourceId, dangling: false };
    info.remoteEntry = entry;
    childInfo.set(entry.resourceId, info);
  }

  const children: Plan[] = [];
  for (const info of childInfo.values()) {
    const { localEntry, remoteEntry } = info;
    let localShape: ResourceObj | undefined;
    if (localEntry && collectionDir) {
      info.filePath = resourcePath(
        collectionDir,
        localEntry.resourceAccessorPath,
      );
      const bytes = readLocalBytes(ctx.root, info.filePath);
      if (bytes) {
        localShape = { ...localEntry, resourceBytes: encodeBase64(bytes) };
      } else if (remoteEntry) info.dangling = true;
      // No file and nothing on the server: the entry alone can still be pushed.
      else localShape = { ...localEntry, resourceBytes: "" };
    } else if (remoteEntry && collectionDir) {
      info.filePath = resourcePath(
        collectionDir,
        remoteEntry.resourceAccessorPath,
      );
    }
    const key = `resource:${id}/${info.resourceId}`;
    const accessor = (localEntry ?? remoteEntry)!.resourceAccessorPath;
    const plan = makePlan(
      {
        key,
        kind: "resource",
        id: `${id}/${info.resourceId}`,
        typeLabel: "resource",
        path: info.filePath,
        displayPath: info.filePath ?? accessor,
        local: localShape,
        remote: remoteEntry,
        localHash: localShape && await hashConfig(localShape),
        remoteHash: remoteEntry && await hashConfig(remoteEntry),
        guard,
        notes: info.dangling
          ? [
            `_collection.json lists this resource, but there is no local file at ${info.filePath}`,
          ]
          : [],
        labels: info.dangling
          ? {
            "create-local": `Save prods resource to ${accessor}`,
            "delete-local":
              "Remove resource listed in the local _collection.json file",
            "delete-remote":
              "Delete remote prod resource (will also remove local _collection.json resource)",
          }
          : {},
        extraOptions: info.dangling ? ["delete-local"] : [],
        diff: () =>
          diffFiles(resourceFiles(remoteEntry), resourceFiles(localShape)),
      },
      state.get(key),
      options,
    );
    if (plan) children.push(plan);
  }

  const metaKey = `resourceCollection:${id}`;
  const metaPlan = makePlan(
    {
      key: metaKey,
      kind: "resourceCollection",
      id,
      typeLabel: "collection",
      path: collectionPath,
      displayPath: collectionPath,
      local: localMeta,
      remote: remoteMeta,
      localHash: localMeta && await hashConfig(localMeta),
      remoteHash: remoteMeta && await hashConfig(remoteMeta),
      guard,
      notes: [],
      labels,
      diff: async () => {
        // When a whole collection exists on one side only, show all of it.
        const parts = [
          await diffFiles(metaFile(remoteMeta), metaFile(localMeta)),
        ];
        if (!bothSides) {
          for (const c of children) {
            parts.push(await c.diff());
          }
        }
        return parts.filter(Boolean).join("\n");
      },
    },
    state.get(metaKey),
    options,
  );
  if (!metaPlan) return null;

  // A collection deleted on one side counts as edited if any resource changed.
  if (!bothSides) {
    const edited = children.some((c) =>
      (c.remoteHash ?? c.localHash) !== state.get(c.key)
    );
    if (edited && metaPlan.status === "deleted-locally") {
      metaPlan.status = "deleted-locally-edited";
    }
    if (edited && metaPlan.status === "deleted-on-server") {
      metaPlan.status = "deleted-on-server-edited";
      if (
        !metaPlan.options.includes("push") &&
        guardAllowsPush(guard, options.allowBundled)
      ) {
        metaPlan.options.splice(1, 0, "push");
      }
    }
  }
  return {
    plan: metaPlan,
    children,
    id,
    collectionDir,
    local,
    remote,
    childInfo,
  };
}

const guardAllowsPush = (guard: Guard | null, allowBundled: boolean) =>
  !guard || (guard.type === "bundled" && allowBundled);

function resourceFiles(entry?: ResourceObj): DiskFile[] {
  if (!entry) return [];
  const bytes = decodeBase64(entry.resourceBytes ?? "");
  const content: DiskFile = isTextResource(entry.resourceHeaders, bytes)
    ? {
      name: entry.resourceAccessorPath,
      text: new TextDecoder().decode(bytes),
    }
    : { name: entry.resourceAccessorPath, bytes };
  return [
    { name: "_collection.json entry", text: toJsonText(withoutBytes(entry)) },
    content,
  ];
}

type Outcome = {
  pushed?: { body: CollectionObj; units: Set<string> };
  wroteFiles: boolean;
};

async function applyCollection(
  ctx: SyncContext,
  group: CollectionGroup,
  getIndex: () => ConfigIndex,
): Promise<Outcome> {
  const { state, client, out } = ctx;
  const { plan: meta, children, id } = group;
  const chooseFolder = () => chooseCollectionFolder(ctx, getIndex());

  // The collection exists on one side only: resources follow its decision.
  if (!group.local || !group.remote) {
    const decision = meta.status === "in-sync"
      ? { action: "nothing" as const }
      : await decide(meta, ctx, chooseFolder);
    return await applyWholeCollection(ctx, group, decision);
  }

  const localMeta = metaOf(group.local);
  const remoteMeta = metaOf(group.remote);
  let finalLocalMeta = localMeta, finalRemoteMeta = remoteMeta;
  const finalLocal = new Map(
    group.local.resources.map((r) => [r.resourceId, r]),
  );
  const finalRemote = new Map(
    group.remote.resources.map((r) => [r.resourceId, r]),
  );
  let localChanged = false, remoteChanged = false, wroteFiles = false;
  const pushedUnits = new Set<string>();
  const settled: [string, string][] = [];

  if (meta.status === "in-sync") settled.push([meta.key, meta.remoteHash!]);
  else {
    const decision = await decide(meta, ctx, chooseFolder);
    if (decision.action === "pull") {
      finalLocalMeta = remoteMeta;
      localChanged = true;
      settled.push([meta.key, meta.remoteHash!]);
    }
    if (decision.action === "push") {
      finalRemoteMeta = localMeta;
      remoteChanged = true;
      pushedUnits.add(meta.key);
    }
  }

  for (const child of children) {
    const info = group.childInfo.get(child.id.slice(id.length + 1))!;
    if (child.status === "in-sync") {
      settled.push([child.key, child.remoteHash!]);
      continue;
    }
    const decision: Decision = await decide(child, ctx);
    switch (decision.action) {
      case "pull":
      case "create-local": {
        const entry = info.remoteEntry!;
        const path = resourcePath(
          group.collectionDir!,
          entry.resourceAccessorPath,
        );
        writeLocalFile(ctx.root, path, decodeBase64(entry.resourceBytes));
        out.log(
          `${
            decision.action === "pull" ? "Updated" : "Saved new"
          } resource ${path}`,
        );
        finalLocal.set(info.resourceId, withoutBytes(entry));
        localChanged = wroteFiles = true;
        settled.push([child.key, child.remoteHash!]);
        break;
      }
      case "push":
        finalRemote.set(info.resourceId, child.local as ResourceObj);
        remoteChanged = true;
        pushedUnits.add(child.key);
        break;
      case "delete-local":
        finalLocal.delete(info.resourceId);
        localChanged = true;
        if (decision.deleteFile && info.filePath) {
          removeLocalFile(ctx.root, info.filePath);
          out.log(`Deleted ${info.filePath}`);
          wroteFiles = true;
        }
        if (!child.remoteHash) state.delete(child.key);
        break;
      case "delete-remote":
        finalRemote.delete(info.resourceId);
        remoteChanged = true;
        if (info.dangling) {
          finalLocal.delete(info.resourceId);
          localChanged = true;
        }
        pushedUnits.add(child.key);
        break;
    }
  }

  const localBody = assemble(
    finalLocalMeta,
    [...finalLocal.values()].map(withoutBytes),
    Object.keys(group.local),
  );
  if (localChanged) {
    writeLocalFile(ctx.root, meta.path!, toJsonText(localBody));
    out.log(`File "${meta.path}" Saved`);
  }
  let pushed: Outcome["pushed"];
  if (remoteChanged) {
    const body = assemble(
      finalRemoteMeta,
      [...finalRemote.values()],
      Object.keys(group.remote),
    );
    if (!deepEqual(body, group.remote)) {
      await client.request("POST", URL_PATH, body);
      out.log(`✔ pushed changes to remote for collection ${id}`);
      pushed = { body, units: pushedUnits };
    }
  }
  for (const [key, hash] of settled) state.set(key, hash);
  return { pushed, wroteFiles };
}

async function applyWholeCollection(
  ctx: SyncContext,
  group: CollectionGroup,
  decision: Decision,
): Promise<Outcome> {
  const { state, client, out } = ctx;
  const { plan: meta, children, id } = group;
  const allKeys = [meta.key, ...children.map((c) => c.key)];
  switch (decision.action) {
    case "create-local": {
      const remote = group.remote!;
      const dir = join(DIR, decision.location ?? ".", id).replaceAll(
        SEPARATOR,
        "/",
      );
      for (const entry of remote.resources) {
        const path = resourcePath(dir, entry.resourceAccessorPath);
        writeLocalFile(ctx.root, path, decodeBase64(entry.resourceBytes));
        out.log(`Saved new resource ${path}`);
      }
      const path = `${dir}/_collection.json`;
      writeLocalFile(
        ctx.root,
        path,
        toJsonText(
          assemble(
            metaOf(remote),
            remote.resources.map(withoutBytes),
            Object.keys(remote),
          ),
        ),
      );
      out.log(`File "${path}" Saved`);
      state.set(meta.key, meta.remoteHash!);
      for (const c of children) state.set(c.key, c.remoteHash!);
      return { wroteFiles: true };
    }
    case "delete-remote":
      await client.request("DELETE", `${URL_PATH}/${id}`);
      out.log(`✔ deleted remote collection ${id}`);
      for (const key of allKeys) state.delete(key);
      return { wroteFiles: false };
    case "push": {
      // Fill in each resource's bytes from its file.
      const local = group.local!;
      const body = assemble(
        metaOf(local),
        local.resources.map((entry) =>
          (children.find((c) => c.key === `resource:${id}/${entry.resourceId}`)
            ?.local as ResourceObj | undefined) ??
            { ...entry, resourceBytes: "" }
        ),
        Object.keys(local),
      );
      await client.request("POST", URL_PATH, body);
      out.log(`✔ pushed new collection ${id}`);
      return { pushed: { body, units: new Set(allKeys) }, wroteFiles: false };
    }
    case "delete-local":
      Deno.removeSync(join(ctx.root, group.collectionDir!), {
        recursive: true,
      });
      out.log(`Deleted directory ${group.collectionDir}`);
      for (const key of allKeys) state.delete(key);
      return { wroteFiles: true };
    default:
      return { wroteFiles: false };
  }
}

async function chooseCollectionFolder(ctx: SyncContext, index: ConfigIndex) {
  const { options, prompter } = ctx;
  if (options.preferServer && options.forceDefaultFolder) return ".";
  const folder = await prompter.select(
    "Choose a folder in " + DIR,
    [...index.folders, "<New Folder>"].map((f) => ({ name: f, value: f })),
  );
  return folder === "<New Folder>"
    ? await prompter.input("Enter new folder name:")
    : folder;
}

/**
 * Re-fetches after pushing and records what the server stored. Anything the
 * server normalized is written back locally.
 */
async function reconcile(
  ctx: SyncContext,
  pushed: { group: CollectionGroup; body: CollectionObj; units: Set<string> }[],
) {
  const { state, out } = ctx;
  const fresh = new Map(
    (await resources.fetch(ctx) as CollectionObj[]).map((
      c,
    ) => [c.collectionId, c]),
  );
  for (const { group, body, units } of pushed) {
    const id = group.id;
    const storedRaw = fresh.get(id);
    if (!storedRaw) {
      for (const key of units) {
        if (key.startsWith("resource:")) state.delete(key);
      }
      if (units.has(group.plan.key)) {
        out.warn(
          `collection ${id} was pushed, but the server doesn't list it afterwards`,
        );
      }
      continue;
    }
    const stored = assemble(
      metaOf(storedRaw),
      storedRaw.resources ?? [],
      Object.keys(storedRaw),
    );
    const collectionPath = group.plan.path!;
    const localFile = readLocalJson<CollectionObj>(ctx.root, collectionPath);
    let localMeta = metaOf(localFile);
    const localEntries = new Map(
      localFile.resources.map((r) => [r.resourceId, r]),
    );
    let rewrite = false;

    if (units.has(group.plan.key)) {
      const storedMeta = metaOf(stored);
      if (!deepEqual(storedMeta, metaOf(body))) {
        out.log(
          `The server normalized collection ${id}; updating the local _collection.json`,
        );
        localMeta = storedMeta;
        rewrite = true;
      }
      state.set(group.plan.key, await hashConfig(storedMeta));
    }
    for (const key of units) {
      if (!key.startsWith("resource:")) continue;
      const resourceId = key.slice(`resource:${id}/`.length);
      const storedEntry = stored.resources.find((r) =>
        r.resourceId === resourceId
      );
      const pushedEntry = body.resources.find((r) =>
        r.resourceId === resourceId
      );
      if (!storedEntry) {
        state.delete(key);
        continue;
      }
      if (pushedEntry && !deepEqual(storedEntry, pushedEntry)) {
        out.log(
          `The server normalized resource ${id}/${resourceId}; updating the local copy`,
        );
        const path = resourcePath(
          dirname(collectionPath),
          storedEntry.resourceAccessorPath,
        );
        writeLocalFile(ctx.root, path, decodeBase64(storedEntry.resourceBytes));
        localEntries.set(resourceId, withoutBytes(storedEntry));
        rewrite = true;
      }
      state.set(key, await hashConfig(storedEntry));
    }
    if (rewrite) {
      writeLocalFile(
        ctx.root,
        collectionPath,
        toJsonText(
          assemble(
            localMeta,
            [...localEntries.values()].map(withoutBytes),
            Object.keys(localFile),
          ),
        ),
      );
    }
  }
  state.save();
}
