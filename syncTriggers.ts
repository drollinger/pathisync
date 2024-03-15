import { Args } from "https://deno.land/std@0.220.1/cli/parse_args.ts";
import { triggerObj } from "./types.ts";
import singleSync from "./singleSync.ts";

export default async function main(args: Args, specificFileName?: string) {
  await singleSync({
    topPath: "triggers",
    urlPath: "/repository/flowTriggerers",
    resourceType: "trigger",
    getName: (obj: triggerObj) => obj.config.name,
    args,
    specificFileName,
  });
}
