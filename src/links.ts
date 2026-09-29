// What a widget depends on: the HTTP triggers its resource files call (found
// by their `path` appearing in the files' text), the flow each trigger runs,
// and the sub-flows those flows run through `flowOrchestrator` processors.
// Reads local files only. URLs built at runtime can't be detected.

import { decodeBase64 } from "@std/encoding/base64";
import { dirname, join, relative, resolve } from "@std/path";
import { isTextResource } from "./diff.ts";
import { ConfigError } from "./errors.ts";
import { indexFlows, indexTriggers } from "./flowLayout.ts";
import { indexCollections } from "./fsIndex.ts";
import { exists, readLocalBytes, readLocalJson } from "./localFiles.ts";
import type { CollectionObj, FlowObj, TriggerObj } from "./types.ts";

export type FlowLink = {
  name: string;
  /** The flow's folder, or undefined when it isn't local. */
  dir?: string;
  subFlows: FlowLink[];
  /** Already listed higher up the same branch (a flow that runs itself). */
  cycle?: boolean;
};

export type TriggerLink = {
  name: string;
  path: string;
  file: string;
  /** Resource files the trigger's path appears in. */
  calledFrom: string[];
  flow?: FlowLink;
};

export type WidgetLinks = {
  collectionId: string;
  dir: string;
  triggers: TriggerLink[];
};

/** Finds the collection for a path inside it, or for a collection id. */
function findCollection(root: string, target: string): string {
  const rel = relative(root, resolve(root, target)).replaceAll("\\", "/");
  if (exists(join(root, rel))) {
    let dir = Deno.statSync(join(root, rel)).isDirectory ? rel : dirname(rel);
    while (dir.startsWith("resources")) {
      if (exists(join(root, dir, "_collection.json"))) {
        return `${dir}/_collection.json`;
      }
      dir = dirname(dir);
    }
  }
  const byId = indexCollections(root, "resources").files.get(target);
  if (byId) return byId;
  throw new ConfigError(
    `${target} is not a resource collection folder, a file in one, or a collection id`,
  );
}

export function widgetLinks(root: string, target: string): WidgetLinks {
  const collectionPath = findCollection(root, target);
  const dir = dirname(collectionPath);
  const collection = readLocalJson<CollectionObj>(root, collectionPath);

  // The text of every resource the collection serves.
  const texts: { file: string; text: string }[] = [];
  for (const resource of collection.resources ?? []) {
    const file = join(dir, resource.resourceAccessorPath).replaceAll("\\", "/");
    const bytes = readLocalBytes(root, file) ??
      (resource.resourceBytes ? decodeBase64(resource.resourceBytes) : null);
    if (bytes && isTextResource(resource.resourceHeaders, bytes)) {
      texts.push({ file, text: new TextDecoder().decode(bytes) });
    }
  }

  const flows = indexFlows(root).files;
  const flowLink = (name: string, branch: Set<string>): FlowLink => {
    const path = flows.get(name);
    if (!path) return { name, subFlows: [] };
    if (branch.has(name)) {
      return { name, dir: dirname(path), subFlows: [], cycle: true };
    }
    let flow: FlowObj | undefined;
    try {
      flow = readLocalJson<FlowObj>(root, path);
    } catch (_) { /* unreadable: list it without sub-flows */ }
    const subs = new Set<string>();
    for (const processor of Object.values(flow?.processors ?? {})) {
      const sub = processor.config?.flowOrchestrator;
      if (typeof sub === "string" && sub) subs.add(sub);
    }
    const next = new Set([...branch, name]);
    return {
      name,
      dir: dirname(path),
      subFlows: [...subs].sort().map((s) => flowLink(s, next)),
    };
  };

  const triggers: TriggerLink[] = [];
  for (const [name, file] of [...indexTriggers(root).files].sort()) {
    let trigger: TriggerObj;
    try {
      trigger = readLocalJson<TriggerObj>(root, file);
    } catch (_) {
      continue;
    }
    const path = trigger.config?.path;
    if (trigger.classPath !== "http" || typeof path !== "string") continue;
    const trimmed = path.replace(/\/+$/, "");
    if (!trimmed) continue;
    // The path, not followed by more path characters (so /a doesn't match /ab).
    const pattern = new RegExp(
      trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w-])",
    );
    const calledFrom = texts.filter((t) => pattern.test(t.text)).map((t) =>
      relative(dir, t.file).replaceAll("\\", "/")
    );
    if (!calledFrom.length) continue;
    const orchestrator = trigger.config?.orchestratorName;
    triggers.push({
      name,
      path,
      file,
      calledFrom,
      flow: orchestrator ? flowLink(orchestrator, new Set()) : undefined,
    });
  }
  return { collectionId: collection.collectionId, dir, triggers };
}

export function formatLinks(links: WidgetLinks): string {
  const lines = [`${links.collectionId} (${links.dir})`];
  if (!links.triggers.length) {
    lines.push(
      "  No trigger paths found in its resources. URLs built at runtime can't be detected.",
    );
    return lines.join("\n");
  }
  const flowLines = (flow: FlowLink, prefix: string, last: boolean) => {
    const where = flow.cycle
      ? "(runs itself, see above)"
      : flow.dir
      ? `${flow.dir}/`
      : "(not local)";
    lines.push(`${prefix}${last ? "└─" : "├─"} flow ${flow.name}  ${where}`);
    const inner = prefix + (last ? "   " : "│  ");
    flow.subFlows.forEach((sub, i) =>
      flowLines(sub, inner, i === flow.subFlows.length - 1)
    );
  };
  links.triggers.forEach((trigger, i) => {
    const last = i === links.triggers.length - 1;
    lines.push(
      `${
        last ? "└─" : "├─"
      } trigger ${trigger.name}  ${trigger.path}  (called from ${
        trigger.calledFrom.join(", ")
      })`,
    );
    const prefix = last ? "   " : "│  ";
    if (trigger.flow) flowLines(trigger.flow, prefix, true);
    else lines.push(`${prefix}└─ (runs no flow)`);
  });
  return lines.join("\n");
}
