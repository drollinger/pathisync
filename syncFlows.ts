import type { Args } from "@std/cli";
import type { flowObj } from "./types.ts";
import singleSync from "./singleSync.ts";

export default async function main(args: Args, specificFileName?: string) {
  await singleSync({
    topPath: "flows",
    urlPath: "/repository/flows",
    resourceType: "flow",
    getName: (obj: flowObj) => obj.name,
    args,
    removeAttributes: (obj: flowObj) => {
      // This id constantly changes and does not need to be tracked
      for (const [key, value] of Object.entries(obj.processors)) {
        if (value?.config?.userFetchProviderWhenUsingClaims?.id) {
          delete obj.processors[key].config.userFetchProviderWhenUsingClaims.id;
        }
        const tc = obj.processors[key]?.config?.testConfig;
        if (Array.isArray(tc)) {
          for (const item of tc) {
            if (item?.id) {
              delete item.id;
            }
          }
        }
      }
    },
    specificFileName,
  });
}
