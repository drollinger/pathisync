import { encodeHex } from "@std/encoding/hex";

/** JSON with object keys sorted, so equal values always serialize equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.keys(v).sort().map((
          k,
        ) => [k, (v as Record<string, unknown>)[k]]),
      );
    }
    return v;
  }) ?? "null";
}

export async function sha256(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : data;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return encodeHex(new Uint8Array(digest));
}

/** The hash recorded in the state file for a config in server form. */
export async function hashConfig(value: unknown): Promise<string> {
  return "sha256:" + await sha256(canonicalJson(value));
}

export const deepEqual = (a: unknown, b: unknown) =>
  canonicalJson(a) === canonicalJson(b);
