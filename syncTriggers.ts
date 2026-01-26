import type { Args } from "@std/cli";
import type { triggerObj } from "./types.ts";
import singleSync from "./singleSync.ts";

export default async function main(args: Args, specificFileName?: string) {
  await singleSync({
    topPath: "triggers",
    urlPath: "/repository/flowTriggerers",
    resourceType: "trigger",
    getName: (obj: triggerObj) => {
      if (!("config" in obj)) {
        return (obj as any).invalidConfig.name;
      }
      return obj.config.name;
    },
    args,
    specificFileName,
  });
}
