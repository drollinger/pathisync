import { triggerObj } from "./types.ts";
import singleSync from "./singleSync.ts";

export default async function main() {
  await singleSync(
    "triggers",
    "/repository/flowTriggerers",
    "trigger",
    (obj: triggerObj) => obj.config.name,
  );
}
