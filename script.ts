import { Args } from "https://deno.land/std@0.184.0/flags/mod.ts";
import {
  parse,
  relative,
  SEP,
} from "https://deno.land/std@0.184.0/path/mod.ts";
import syncFlows from "./syncFlows.ts";
import syncSharedConfigs from "./syncSharedConfigs.ts";
import syncTriggers from "./syncTriggers.ts";
import syncResources from "./syncResources.ts";
import { debounceFileEvents } from "./helper.ts";

export default async (args: Args) => {
  if (args.watch) {
    console.log(`Watching ${args.watch} for changes...`);
    const watcher = Deno.watchFs(args.watch);
    try {
      const debounceSync = debounceFileEvents(async (modifiedFiles) => {
        modifiedFiles.sort((a, _) =>
          a.endsWith(SEP + "_collection.json") ? -1 : 1
        );
        for (const filePath of modifiedFiles) {
          switch (relative(Deno.cwd(), filePath).split(SEP)[0]) {
            case "flows":
              await syncFlows(args, parse(filePath).name);
              break;
            case "resources":
              await syncResources(args, filePath);
              break;
            case "sharedConfigs":
              await syncSharedConfigs(args, parse(filePath).name);
              break;
            case "triggers":
              await syncTriggers(args, parse(filePath).name);
              break;
            default:
              console.log(
                `Ignoring ${filePath} because it is not in a recognized resource collection`,
              );
          }
        }
      });
      for await (const event of watcher) {
        if (event.kind === "modify") debounceSync(event);
      }
    } finally {
      watcher.close();
    }
  } else {
    await syncFlows(args);
    await syncSharedConfigs(args);
    await syncTriggers(args);
    await syncResources(args);
  }
};
