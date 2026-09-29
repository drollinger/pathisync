// Configs pathisync refuses to push or delete on the server:
// - bundled configs, which Pathify owns (override with --allow-bundled);
// - secure shared configs, whose value the server returns redacted (no override).

import type { Kind } from "./sync/types.ts";

type Obj = Record<string, unknown> | null | undefined;

/** The bundle a config belongs to, or null. The field's location differs per type. */
export function bundleOf(kind: Kind, obj: Obj): string | null {
  if (!obj) return null;
  const value = kind === "trigger" ? (obj.config as Obj)?.bundle : obj.bundle;
  return typeof value === "string" && value !== "" ? value : null;
}

export const isBundled = (kind: Kind, obj: Obj) => bundleOf(kind, obj) !== null;

export const isSecureSharedConfig = (kind: Kind, obj: Obj) =>
  kind === "sharedConfig" && obj?.secure === true;

/** A local secure shared config that holds its secret in plain text. */
export const hasPlainTextSecret = (kind: Kind, local: Obj) =>
  isSecureSharedConfig(kind, local) && local?.config !== undefined &&
  local.config !== null;

export type Guard =
  | { type: "secure"; reason: string }
  | { type: "bundled"; bundle: string; reason: string };

/**
 * Why pushing or deleting this config on the server is refused, if it is.
 * Both copies are checked, so removing `bundle` locally doesn't get around it.
 */
export function guardFor(
  kind: Kind,
  local: Obj,
  remote: Obj,
  allowBundled: boolean,
): Guard | null {
  if (isSecureSharedConfig(kind, local) || isSecureSharedConfig(kind, remote)) {
    return {
      type: "secure",
      reason:
        "secure shared config — pathisync never pushes or deletes secrets; manage it in the Pathify UI",
    };
  }
  const bundle = bundleOf(kind, remote) ?? bundleOf(kind, local);
  if (bundle) {
    return {
      type: "bundled",
      bundle,
      reason: allowBundled
        ? `bundled: ${bundle} — read-only unless confirmed`
        : `bundled: ${bundle} — read-only, use --allow-bundled`,
    };
  }
  return null;
}
