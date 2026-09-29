// Keeps `types/pathify.d.ts` in step with the flow server: every sync
// regenerates it from the server's docs and rewrites it only if it changed.

import { createClient, type FetchFn } from "../client.ts";
import { readLocalText, writeLocalFile } from "../localFiles.ts";
import { fetchDocs } from "./docs.ts";
import { emitDeclarations, type EmitResult } from "./emit.ts";

export const TYPES_FILE = "types/pathify.d.ts";

export type TypesResult = EmitResult & { version?: string; changed: boolean };

export async function updateTypes(
  root: string,
  serverUrl: string,
  fetch?: FetchFn,
): Promise<TypesResult> {
  // The docs are public, so no token is sent.
  const docs = await fetchDocs(createClient({ serverUrl, token: "", fetch }));
  const result = emitDeclarations(docs);
  const changed = readLocalText(root, TYPES_FILE) !== result.text;
  if (changed) writeLocalFile(root, TYPES_FILE, result.text);
  return { ...result, version: docs.version, changed };
}
