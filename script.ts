import { Args } from "https://deno.land/std@0.184.0/flags/mod.ts";
import syncFlows from "./syncFlows.ts";
import syncSharedConfigs from "./syncSharedConfigs.ts";
import syncTriggers from "./syncTriggers.ts";
import syncResources from "./syncResources.ts";

export default async (args: Args) => {
  // Handle watch flag
  if (args.watch) {
    console.log("Watch flag not yet implemented");
  } else {
    await syncFlows(args);
    await syncSharedConfigs(args);
    await syncTriggers(args);
    await syncResources(args);
  }
};
