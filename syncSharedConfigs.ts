import { configObj } from "./types.ts";
import singleSync from "./singleSync.ts";

export default async function main() {
  await singleSync(
    "sharedConfigs",
    "/repository/sharedConfig",
    "shared config",
    (obj: configObj) => obj.referenceId,
  );
}
