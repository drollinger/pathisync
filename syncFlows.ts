import { flowObj } from "./types.ts";
import singleSync from "./singleSync.ts";

export default async function main() {
  await singleSync(
    "flows",
    "/repository/flows",
    "flow",
    (obj: flowObj) => obj.name,
  );
}
