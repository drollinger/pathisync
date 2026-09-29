import { structuredPatch } from "diff";
import { bold, cyan, green, red } from "@std/fmt/colors";
import { sha256 } from "./hash.ts";

/** A file as it would look on disk. Exactly one of `text` or `bytes` is set. */
export type DiskFile = { name: string; text?: string; bytes?: Uint8Array };

export const DIFF_CAP = 200;

/**
 * Unified diff from the server's copy to the local copy (`+` lines are what
 * a push would add to the server), one section per file.
 */
export async function diffFiles(
  remote: DiskFile[],
  local: DiskFile[],
): Promise<string> {
  const names = [...new Set([...remote, ...local].map((f) => f.name))];
  const sections: string[] = [];
  for (const name of names) {
    const r = remote.find((f) => f.name === name);
    const l = local.find((f) => f.name === name);
    if (r?.bytes || l?.bytes) {
      const line = await binarySummary(name, r, l);
      if (line) sections.push(line);
      continue;
    }
    const before = r?.text ?? "", after = l?.text ?? "";
    if (before === after && !!r === !!l) continue;
    const patch = structuredPatch(name, name, before, after, "", "", {
      context: 3,
    });
    const lines = [
      `--- remote (server)  ${name}${r ? "" : " (missing)"}`,
      `+++ local  ${name}${l ? "" : " (missing)"}`,
    ];
    for (const hunk of patch.hunks) {
      lines.push(
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        ...hunk.lines,
      );
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n");
}

async function binarySummary(name: string, r?: DiskFile, l?: DiskFile) {
  const describe = async (f?: DiskFile) => {
    if (!f) return "missing";
    const bytes = f.bytes ?? new TextEncoder().encode(f.text ?? "");
    return `${bytes.length} bytes, sha256 ${
      (await sha256(bytes)).slice(0, 12)
    }`;
  };
  const [rd, ld] = [await describe(r), await describe(l)];
  if (rd === ld) return "";
  return `binary ${name}\n  remote (server): ${rd}\n  local:           ${ld}`;
}

export function colorize(diff: string): string {
  return diff.split("\n").map((line) => {
    if (line.startsWith("+++") || line.startsWith("---")) return bold(line);
    if (line.startsWith("@@")) return cyan(line);
    if (line.startsWith("+")) return green(line);
    if (line.startsWith("-")) return red(line);
    return line;
  }).join("\n");
}

/** Keeps the first `max` lines, then says how many were left out. */
export function capLines(text: string, max = DIFF_CAP): string {
  const lines = text.split("\n");
  if (lines.length <= max) return text;
  return [...lines.slice(0, max), `… ${lines.length - max} more lines`].join(
    "\n",
  );
}

const TEXT_TYPES = /^(text\/|application\/(json|javascript|xml))/i;

/** Whether a resource should be diffed as text: by content type, or valid UTF-8. */
export function isTextResource(
  headers: [string, string][] | undefined,
  bytes: Uint8Array,
): boolean {
  const type = headers?.find(([k]) => k.toLowerCase() === "content-type")?.[1];
  if (type && TEXT_TYPES.test(type)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return !bytes.includes(0);
  } catch (_) {
    return false;
  }
}
