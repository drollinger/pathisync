import * as base64 from "https://deno.land/std@0.220.1/encoding/base64.ts";
import { ensureDirSync } from "https://deno.land/std@0.220.1/fs/mod.ts";
import { parse, relative } from "https://deno.land/std@0.220.1/path/mod.ts";
import { Args } from "https://deno.land/std@0.220.1/cli/parse_args.ts";
// @deno-types="npm:@types/inquirer"
import inquirer from "npm:inquirer@^9.2.0";
// @deno-types="npm:@types/lodash"
import _ from "npm:lodash@^4.17.21";
import {
  deleteRemoteConfig,
  findCollectionPathId,
  findFile,
  getDirs,
  getFiles,
  promtNewFolder,
  pushConfig,
  writeFile,
} from "./helper.ts";
import { resourceObj } from "./types.ts";
import fetch from "./client.ts";

const topPath = "resources";
const utfDecoder = new TextDecoder("utf-8");

export default async function main(args: Args, specificFilePath?: string) {
  const resp = await fetch("/repository/resourceCollections");
  let body: resourceObj[];
  try {
    body = await resp.json();
  } catch (_) {
    console.log(
      "The Pathify request failed. Please ensure you have an updated token in your .env file.",
    );
    Deno.exit(1);
  }
  if (specificFilePath) {
    const specificCollectionId = findCollectionPathId(specificFilePath);
    body = body.filter((collection) =>
      specificCollectionId === collection.collectionId
    );
  }

  let files = getFiles(topPath)
    .filter((file) => parse(file).base === "_collection.json")
    .map((file) => relative(Deno.cwd(), file));

  for (const collection of body) {
    delete collection.metadata;
    let collectionResources = _.cloneDeep(collection.resources);
    collection.resources = [];
    const collectionPath = findFile(
      topPath,
      collection.collectionId + "/_collection.json",
    );
    files = files.filter((f) => f !== collectionPath);
    let finalRemoteCollection: resourceObj = _.cloneDeep(collection);
    let finalLocalCollection: resourceObj;
    let fullDir = topPath;
    let localCollection: resourceObj | null = null;
    let localCollectionHasChanges = false;
    let remoteCollectionHasChanges = false;
    const watchResourceIds: string[] = [];
    if (collectionPath) {
      // Collection Exists
      fullDir = parse(collectionPath).dir;
      localCollection = JSON.parse(
        utfDecoder.decode(Deno.readFileSync(collectionPath)),
      ) as resourceObj;
      // Get any resources that have changed meta data if watching specific file
      if (specificFilePath?.endsWith(collectionPath)) {
        localCollection.resources.forEach((localResource) => {
          const remoteResource = collectionResources.find((resource) =>
            resource.resourceId === localResource.resourceId
          );
          if (remoteResource && !_.isEqual(localResource, remoteResource)) {
            watchResourceIds.push(localResource.resourceId);
          }
        });
      }

      finalLocalCollection = _.cloneDeep(localCollection);
      finalLocalCollection.resources = [];
      if (
        (!specificFilePath ||
          specificFilePath.endsWith(collectionPath)) &&
        !_.isEqual(collection, finalLocalCollection)
      ) {
        console.log(
          `\nThere is a difference in _collection.json\nfor the collection ${collection.collectionId}`,
        );
        const { option } = args.l
          ? { option: "Overwrite local _collection.json" }
          : args.watch
          ? { option: "Push local _collection.json to remote prod" }
          : await inquirer.prompt([
            {
              name: "option",
              type: "list",
              message: "What do you want to do?",
              choices: [
                "Nothing",
                "Overwrite local _collection.json",
                "Push local _collection.json to remote prod",
              ],
            },
          ]);
        if (option === "Overwrite local _collection.json") {
          finalLocalCollection = _.cloneDeep(collection);
          localCollectionHasChanges = true;
        }
        if (option === "Push local _collection.json to remote prod") {
          finalRemoteCollection = _.cloneDeep(finalLocalCollection);
          remoteCollectionHasChanges = true;
        }
      }
    } else {
      console.log(
        `\nThe collection ${collection.collectionId} does not exist locally`,
      );
      const { option } = args.l
        ? { option: "Create new local collection" }
        : await inquirer.prompt([
          {
            name: "option",
            type: "list",
            message: "What do you want to do?",
            choices: [
              "Nothing",
              "Create new local collection",
              ...(args.d ? ["Delete remote prod collection"] : []),
            ],
          },
        ]);
      if (option === "Nothing") {
        collectionResources = [];
      }
      if (option === "Create new local collection") {
        let folderOptions = getDirs(topPath, true);
        folderOptions = folderOptions.map((folder) =>
          folder.split("/").slice(1).join("/")
        );
        folderOptions.push("<New Folder>");
        let { folder } = (args.l && args.f)
          ? { folder: folderOptions[0] }
          : await inquirer.prompt([
            {
              name: "folder",
              type: "list",
              message: "Choose a folder in " + topPath,
              choices: folderOptions,
            },
          ]);
        if (folder === "<New Folder>") folder = await promtNewFolder();
        fullDir += `/${folder}/${collection.collectionId}`;
        ensureDirSync(fullDir);
        finalLocalCollection = _.cloneDeep(collection);
        localCollectionHasChanges = true;
      }
      if (option === `Delete remote prod collection`) {
        const resp = await deleteRemoteConfig(
          `/repository/resourceCollections/${collection.collectionId}`,
        );
        if (resp.status === 200) {
          console.log(`Successfully deleted ${collection.collectionId}`);
        } else console.log(`Failed deleting ${collection.collectionId}`);
        collectionResources = [];
      }
    }
    // Go through resources
    for (const flow of collectionResources) {
      const resourcePath = findFile(
        fullDir,
        flow.resourceAccessorPath,
      );
      const isWatchResource = !specificFilePath ||
        specificFilePath.endsWith(resourcePath);
      const localConfig = localCollection?.resources?.find(
        (r) => r.resourceId === flow.resourceId,
      );
      if (localCollection) {
        localCollection.resources = localCollection.resources.filter(
          (r) => r.resourceId !== flow.resourceId,
        );
      }
      if (localCollection && resourcePath && isWatchResource) {
        // Resource already exists
        const localResource = base64.encodeBase64(
          Deno.readFileSync(resourcePath),
        );
        if (localConfig) localConfig.resourceBytes = localResource;
        if (!localConfig || !_.isEqual(flow, localConfig)) {
          console.log(
            `\nThere is a difference in the collection ${flow.resourceCollectionId}\nwith the resource ${flow.resourceAccessorPath}`,
          );
          const { option } = args.l
            ? { option: "Overwrite local resource" }
            : args.watch
            ? { option: "Push local resource to remote prod" }
            : await inquirer.prompt([
              {
                name: "option",
                type: "list",
                message: "What do you want to do?",
                choices: [
                  "Nothing",
                  "Overwrite local resource",
                  "Push local resource to remote prod",
                ],
              },
            ]);
          if (option === "Nothing") {
            if (localConfig) {
              localConfig.resourceBytes = "";
              finalLocalCollection!.resources.push(localConfig);
            }
            finalRemoteCollection.resources.push(flow);
          }
          if (option === "Overwrite local resource") {
            Deno.writeFileSync(
              resourcePath,
              base64.decodeBase64(flow.resourceBytes),
            );
            console.log(`Updated resource ${flow.resourceAccessorPath}`);
            const localVersion = _.cloneDeep(flow);
            localVersion.resourceBytes = "";
            finalLocalCollection!.resources.push(localVersion);
            finalRemoteCollection.resources.push(flow);
            localCollectionHasChanges = true;
          }
          if (option === "Push local resource to remote prod") {
            if (localConfig) {
              const localVersion = _.cloneDeep(localConfig);
              localVersion.resourceBytes = "";
              finalLocalCollection!.resources.push(localVersion);
              finalRemoteCollection.resources.push(localConfig);
            }
            remoteCollectionHasChanges = true;
          }
        } else {
          localConfig.resourceBytes = "";
          finalLocalCollection!.resources.push(localConfig);
          finalRemoteCollection.resources.push(flow);
        }
      } else if (!args.watch) {
        // Resource file doesn't exist
        let option = "Create new local resource";
        if (localCollection) {
          // Don't ask just auto save if there isn't a localCollection
          if (localConfig && !resourcePath) {
            console.log(
              `\nThe collection ${flow.resourceCollectionId} has the resource ${flow.resourceId}\nbut there is no local file saved to ${flow.resourceAccessorPath}`,
            );
            const { askedOption } = args.l
              ? {
                askedOption:
                  `Save prods resource to ${flow.resourceAccessorPath}`,
              }
              : await inquirer.prompt([
                {
                  name: "askedOption",
                  type: "list",
                  message: "What do you want to do?",
                  choices: [
                    "Remove resource listed in the local _collection.json file",
                    `Save prods resource to ${flow.resourceAccessorPath}`,
                    ...(args.d
                      ? [
                        "Delete remote prod resource (will also remove local _collection.json resource)",
                      ]
                      : []),
                  ],
                },
              ]);
            option = askedOption;
          } else {
            console.log(
              `\nThe collection ${flow.resourceCollectionId}\nhas a resource ${flow.resourceAccessorPath} that does not exist locally`,
            );
            const { askedOption } = args.l
              ? { askedOption: "Create new local resource" }
              : await inquirer.prompt([
                {
                  name: "askedOption",
                  type: "list",
                  message: "What do you want to do?",
                  choices: [
                    "Nothing",
                    "Create new local resource",
                    ...(args.d ? ["Delete remote prod resource"] : []),
                  ],
                },
              ]);
            option = askedOption;
          }
        }
        if (option === "Nothing") {
          finalRemoteCollection.resources.push(flow);
        }
        if (
          option ===
            "Remove resource listed in the local _collection.json file"
        ) {
          finalRemoteCollection.resources.push(flow);
          localCollectionHasChanges = true;
        }
        if (
          option === "Create new local resource" ||
          option === `Save prods resource to ${flow.resourceAccessorPath}`
        ) {
          const resourcePath = fullDir + flow.resourceAccessorPath;
          const resourceDir = parse(resourcePath).dir;
          ensureDirSync(resourceDir);
          Deno.writeFileSync(
            resourcePath,
            base64.decodeBase64(flow.resourceBytes),
          );
          console.log(`Saved new resource ${flow.resourceAccessorPath}`);
          const localVersion = _.cloneDeep(flow);
          localVersion.resourceBytes = "";
          finalLocalCollection!.resources.push(localVersion);
          finalRemoteCollection.resources.push(flow);
          localCollectionHasChanges = true;
        }
        if (option === "Delete remote prod resource") {
          remoteCollectionHasChanges = true;
        }
        if (
          option ===
            "Delete remote prod resource (will also remove local _collection.json resource)"
        ) {
          remoteCollectionHasChanges = true;
          localCollectionHasChanges = true;
        }
      } else if (watchResourceIds.includes(flow.resourceId)) {
        // Final case for watching the _collection resource that changed a resource
        console.log("\nResource data in _collection.json changed");
        const remoteVersion = _.cloneDeep(localConfig!);
        // Push remote resourceBytes since only _collection is watched in this case
        // If both are changed, there will be another event that will push the new local changes
        remoteVersion.resourceBytes = flow.resourceBytes;
        finalRemoteCollection.resources.push(remoteVersion);
        remoteCollectionHasChanges = true;
      }
    }
    //Go through the rest of the local resources
    if (localCollection?.resources && !args.watch) {
      for (const localFlow of localCollection.resources) {
        const resourcePath = findFile(
          fullDir,
          localFlow.resourceAccessorPath,
        );
        if (resourcePath) {
          // Local resource has a path
          const localResource = base64.encodeBase64(
            Deno.readFileSync(resourcePath),
          );
          console.log(
            `\nThe remote prod collection ${collection.collectionId}\ndoesn't have the resource ${localFlow.resourceAccessorPath}`,
          );
          const { option } = args.l
            ? { option: "Nothing" }
            : await inquirer.prompt([
              {
                name: "option",
                type: "list",
                message: "What do you want to do?",
                choices: [
                  "Nothing",
                  "Push new resource to prod",
                  ...(args.d ? ["Delete local resource"] : []),
                ],
              },
            ]);
          if (option === "Nothing") {
            finalLocalCollection!.resources.push(localFlow);
          }
          if (option === "Push new resource to prod") {
            const remoteVersion = _.cloneDeep(localFlow);
            remoteVersion.resourceBytes = localResource;
            finalLocalCollection!.resources.push(localFlow);
            finalRemoteCollection.resources.push(remoteVersion);
            remoteCollectionHasChanges = true;
          }
          if (option === "Delete local resource") {
            localCollectionHasChanges = true;
            const { toDelete } = await inquirer.prompt([
              {
                name: "toDelete",
                type: "confirm",
                message: "Do you also want to delete the local file?",
              },
            ]);
            if (toDelete) {
              Deno.removeSync(resourcePath);
              console.log(`Deleted ${resourcePath}`);
            }
          }
        } else {
          //There is no local file
          console.log(
            `\nThe remote prod collection ${collection.collectionId}\ndoesn't have the resource ${localFlow.resourceAccessorPath}`,
          );
          const { option } = args.l
            ? { option: "Nothing" }
            : await inquirer.prompt([
              {
                name: "option",
                type: "list",
                message: "What do you want to do?",
                choices: [
                  "Nothing",
                  "Push new resource to prod",
                  ...(args.d ? ["Delete local resource"] : []),
                ],
              },
            ]);
          if (option === "Nothing") {
            finalLocalCollection!.resources.push(localFlow);
          }
          if (option === "Push new resource to prod") {
            finalLocalCollection!.resources.push(localFlow);
            finalRemoteCollection.resources.push(localFlow);
            remoteCollectionHasChanges = true;
          }
          if (option === "Delete local resource") {
            localCollectionHasChanges = true;
          }
        }
      }
    }
    if (localCollectionHasChanges) {
      writeFile(finalLocalCollection!, `${fullDir}/_collection.json`);
    }
    if (
      remoteCollectionHasChanges &&
      !_.isEqual(finalRemoteCollection, collection)
    ) {
      const resp = await pushConfig(
        "/repository/resourceCollections",
        finalRemoteCollection,
      );
      if (resp.status === 200) {
        console.log(
          `Successfully pushed changes to remote for ${collection.collectionId}`,
        );
      } else {
        console.log(
          `Failed pushing changes to remote for ${collection.collectionId}`,
        );
      }
    }
  }
  //Go through the rest of the local collections
  if (!args.watch) {
    for (const localCollectionPath of files) {
      const fullDir = parse(localCollectionPath).dir;
      const localCollection = JSON.parse(
        utfDecoder.decode(Deno.readFileSync(localCollectionPath)),
      ) as resourceObj;
      console.log(
        `\nThe remote prod doesn't have the collection ${localCollection.collectionId}`,
      );
      const { option } = args.l
        ? { option: "Nothing" }
        : await inquirer.prompt([
          {
            name: "option",
            type: "list",
            message: "What do you want to do?",
            choices: [
              "Nothing",
              "Push new collection to prod",
              ...(args.d ? ["Delete local collection"] : []),
            ],
          },
        ]);
      if (option === "Push new collection to prod") {
        for (const localFlow of localCollection.resources) {
          const resourcePath = findFile(
            fullDir,
            localFlow.resourceAccessorPath,
          );
          if (resourcePath) {
            const localResource = base64.encodeBase64(
              Deno.readFileSync(resourcePath),
            );
            localFlow.resourceBytes = localResource;
          }
        }
        const resp = await pushConfig(
          "/repository/resourceCollections",
          localCollection,
        );
        if (resp.status === 200) {
          console.log(
            `Successfully pushed new collection ${localCollection.collectionId}`,
          );
        } else {
          console.log(
            `Failed pushing new collection ${localCollection.collectionId}`,
          );
        }
      }
      if (option === "Delete local collection") {
        Deno.removeSync(fullDir, { recursive: true });
        console.log(`Deleted directory ${fullDir}`);
      }
    }
  }
}
