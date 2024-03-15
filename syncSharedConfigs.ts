import { Args } from "https://deno.land/std@0.220.1/cli/parse_args.ts";
import { configObj } from "./types.ts";
import singleSync from "./singleSync.ts";

export default async function main(args: Args, specificFileName?: string) {
  await singleSync({
    topPath: "sharedConfigs",
    urlPath: "/repository/sharedConfig",
    resourceType: "shared config",
    getName: (obj: configObj) => obj.referenceId,
    args,
    specificFileName,
  });
}
