import { ensureDirSync } from "@std/fs";
import { dirname, join } from "@std/path";
import {
  env,
  gitignoreLines,
  globalsDts,
  jsconfig,
  readme,
} from "../fileConstants.ts";
import { exists } from "./localFiles.ts";

export const CONFIG_DIRS = ["flows", "resources", "sharedConfigs", "triggers"];

/** Writes `content` only if the file doesn't exist. Returns a status line. */
export function createIfMissing(
  root: string,
  relPath: string,
  content: string,
): string {
  const path = join(root, relPath);
  if (exists(path)) return `skipped ${relPath} (exists)`;
  ensureDirSync(dirname(path));
  Deno.writeTextFileSync(path, content);
  return `created ${relPath}`;
}

/** Adds any missing lines to `.gitignore`, keeping what's already there. */
export function mergeGitignore(root: string): string {
  const path = join(root, ".gitignore");
  const current = exists(path) ? Deno.readTextFileSync(path) : null;
  const have = new Set((current ?? "").split(/\r?\n/).map((l) => l.trim()));
  const missing = gitignoreLines.filter((line) => !have.has(line));
  if (current !== null && !missing.length) {
    return "skipped .gitignore (up to date)";
  }
  const prefix = current === null || current === "" || current.endsWith("\n")
    ? current ?? ""
    : current + "\n";
  Deno.writeTextFileSync(path, prefix + missing.map((l) => l + "\n").join(""));
  return current === null
    ? "created .gitignore"
    : `updated .gitignore (added ${missing.join(", ")})`;
}

/** Everything `init` sets up. Existing files are left alone. */
export function initProject(root: string): string[] {
  ensureDirSync(root);
  for (const dir of CONFIG_DIRS) ensureDirSync(join(root, dir));
  return [
    createIfMissing(root, ".env", env),
    createIfMissing(root, "README.md", readme),
    mergeGitignore(root),
    // Editor support for flow JavaScript (issue 10).
    createIfMissing(root, "flows/jsconfig.json", jsconfig),
    createIfMissing(root, "types/globals.d.ts", globalsDts),
  ];
}
