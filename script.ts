import { parse } from "https://deno.land/std@0.184.0/flags/mod.ts";
import syncFlows from "./syncFlows.ts";
import syncSharedConfigs from "./syncSharedConfigs.ts";
import syncTriggers from "./syncTriggers.ts";
import syncResources from "./syncResources.ts";

const args = parse(Deno.args);

switch (args._[0]) {
  case "all":
    await syncFlows();
    await syncSharedConfigs();
    await syncTriggers();
    await syncResources();
    break;
  default:
    console.error("Invalid command.");
    Deno.exit(1);
}
