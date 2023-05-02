import fetch from "./client.ts";
import inquirer from "npm:inquirer@^9.2.0";
import * as base64 from "https://deno.land/std@0.184.0/encoding/base64.ts";
import { ensureDirSync } from "https://deno.land/std@0.184.0/fs/mod.ts";
import { parse, relative } from "https://deno.land/std@0.184.0/path/mod.ts";
// @deno-types="npm:@types/lodash"
import _ from "npm:lodash@^4.17.21";
import {
  deleteRemoteConfig,
  findFile,
  getDirs,
  getFiles,
  promtNewFolder,
  pushConfig,
  writeFile,
} from "./helper.ts";
import { resourceObj } from "./types.ts";

const topPath = "resources";
const utfDecoder = new TextDecoder("utf-8");

export default async function main() {
  const resp = await fetch("/repository/resourceCollections");
  const body: resourceObj[] = await resp.json();
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
    if (collectionPath) {
      // Collection Exists
      fullDir = parse(collectionPath).dir;
      localCollection = JSON.parse(
        utfDecoder.decode(Deno.readFileSync(collectionPath)),
      ) as resourceObj;
      finalLocalCollection = _.cloneDeep(localCollection);
      finalLocalCollection.resources = [];
      if (!_.isEqual(collection, finalLocalCollection)) {
        console.log(
          `\nThere is a difference in _collection.json\nfor the collection ${collection.collectionId}`,
        );
        const { option } = await inquirer.prompt([
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
      const { option } = await inquirer.prompt([
        {
          name: "option",
          type: "list",
          message: "What do you want to do?",
          choices: [
            "Nothing",
            "Create new local collection",
            "Delete remote prod collection",
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
        let { folder } = await inquirer.prompt([
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
      const localConfig = localCollection?.resources?.find(
        (r) => r.resourceId === flow.resourceId,
      );
      if (localCollection) {
        localCollection.resources = localCollection.resources.filter(
          (r) => r.resourceId !== flow.resourceId,
        );
      }
      if (localCollection && resourcePath) {
        // Resource already exists
        const localResource = base64.encode(
          Deno.readFileSync(resourcePath),
        );
        if (localConfig) localConfig.resourceBytes = localResource;
        if (!localConfig || !_.isEqual(flow, localConfig)) {
          console.log(
            `\nThere is a difference in the collection ${flow.resourceCollectionId}\nwith the resource ${flow.resourceAccessorPath}`,
          );
          const { option } = await inquirer.prompt([
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
            Deno.writeTextFileSync(
              resourcePath,
              utfDecoder.decode(base64.decode(flow.resourceBytes)),
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
      } else {
        // Resource file doesn't exist
        let option = "Create new local resource";
        if (localCollection) {
          // Don't ask just auto save if there isn't a localCollection
          if (localConfig && !resourcePath) {
            console.log(
              `\nThe collection ${flow.resourceCollectionId} has the resource ${flow.resourceId}\nbut there is no local file saved to ${flow.resourceAccessorPath}`,
            );
            const { askedOption } = await inquirer.prompt([
              {
                name: "askedOption",
                type: "list",
                message: "What do you want to do?",
                choices: [
                  "Remove local _collection.json resource",
                  `Save prods resource to ${flow.resourceAccessorPath}`,
                  "Delete remote prod resource (will also remove local _collection.json resource)",
                ],
              },
            ]);
            option = askedOption;
          } else {
            console.log(
              `\nThe collection ${flow.resourceCollectionId}\nhas a resource ${flow.resourceAccessorPath} that does not exist locally`,
            );
            const { askedOption } = await inquirer.prompt([
              {
                name: "askedOption",
                type: "list",
                message: "What do you want to do?",
                choices: [
                  "Nothing",
                  "Create new local resource",
                  "Delete remote prod resource",
                ],
              },
            ]);
            option = askedOption;
          }
        }
        if (option === "Nothing") {
          finalRemoteCollection.resources.push(flow);
        }
        if (option === "Remove local _collection.json resource") {
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
          Deno.writeTextFileSync(
            resourcePath,
            utfDecoder.decode(base64.decode(flow.resourceBytes)),
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
      }
    }
    //Go through the rest of the local resources
    if (localCollection?.resources) {
      for (const localFlow of localCollection.resources) {
        const resourcePath = findFile(
          fullDir,
          localFlow.resourceAccessorPath,
        );
        if (resourcePath) {
          // Local resource has a path
          const localResource = base64.encode(
            Deno.readFileSync(resourcePath),
          );
          console.log(
            `\nThe remote prod collection ${collection.collectionId}\ndoesn't have the resource ${localFlow.resourceAccessorPath}`,
          );
          const { option } = await inquirer.prompt([
            {
              name: "option",
              type: "list",
              message: "What do you want to do?",
              choices: [
                "Nothing",
                "Push new resource to prod",
                "Delete local resource",
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
          const { option } = await inquirer.prompt([
            {
              name: "option",
              type: "list",
              message: "What do you want to do?",
              choices: [
                "Nothing",
                "Push new resource to prod",
                "Delete local resource",
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
      await writeFile(finalLocalCollection!, `${fullDir}/_collection.json`);
    }
    if (remoteCollectionHasChanges) {
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
  for (const localCollectionPath of files) {
    const fullDir = parse(localCollectionPath).dir;
    const localCollection = JSON.parse(
      utfDecoder.decode(Deno.readFileSync(localCollectionPath)),
    ) as resourceObj;
    console.log(
      `\nThe remote prod doesn't have the collection ${localCollection.collectionId}`,
    );
    const { option } = await inquirer.prompt([
      {
        name: "option",
        type: "list",
        message: "What do you want to do?",
        choices: [
          "Nothing",
          "Push new collection to prod",
          "Delete local collection",
        ],
      },
    ]);
    if (option === "Push new collection to prod") {
      for (const localFlow of localCollection.resources) {
        const resourcePath = await findFile(
          fullDir,
          localFlow.resourceAccessorPath,
        );
        if (resourcePath) {
          const localResource = base64.encode(
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
