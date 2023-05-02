import { ensureDirSync } from "https://deno.land/std@0.184.0/fs/mod.ts";
import { join } from "https://deno.land/std@0.184.0/path/mod.ts";
import fetch from "./client.ts";
// @deno-types="npm:@types/inquirer"
import inquirer from "npm:inquirer@^9.2.0";
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
import { optionType } from "./types.ts";

const decoder = new TextDecoder("utf-8");

// TODO Fix relative file paths so that they look good in logging and stuff
export default async function singleSync(
  topPath: string,
  urlPath: string,
  resourceType: string,
  getName: (obj: any) => string,
) {
  const resp = await fetch(urlPath);
  const body: optionType[] = await resp.json();
  let files = getFiles(topPath).map((file) => join(Deno.cwd(), file));

  for (const flow of body) {
    const file = findFile(topPath, getName(flow));
    if (file) {
      const localFlow = JSON.parse(
        decoder.decode(Deno.readFileSync(file)),
      ) as optionType;
      files = files.filter((f) => f !== file);
      delete flow.metadata;
      if (!_.isEqual(flow, localFlow)) {
        console.log(
          `\nThere is a difference with the ${resourceType} ${
            getName(flow)
          }\nlocated at ${file}`,
        );
        const { option } = await inquirer.prompt([
          {
            name: "option",
            type: "list",
            message: "What do you want to do?",
            choices: [
              "Nothing",
              `Overwrite local ${resourceType}`,
              `Push local ${resourceType} to remote prod`,
            ],
          },
        ]);
        if (option === `Overwrite local ${resourceType}`) writeFile(flow, file);
        if (option === `Push local ${resourceType} to remote prod`) {
          const resp = await pushConfig(urlPath, localFlow);
          if (resp.status === 200) {
            console.log(`Successfully pushed ${getName(localFlow)}`);
          } else console.log(`Failed pushing ${getName(localFlow)}`);
        }
      }
    } else {
      console.log(
        `\nThe ${resourceType} ${getName(flow)} does not exist locally`,
      );
      const { option } = await inquirer.prompt([
        {
          name: "option",
          type: "list",
          message: "What do you want to do?",
          choices: [
            "Nothing",
            `Create new local ${resourceType}`,
            `Delete remote prod ${resourceType}`,
          ],
        },
      ]);
      if (option === `Create new local ${resourceType}`) {
        let folderOptions = getDirs(topPath);
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
        if (folder === "<New Folder>") {
          folder = await promtNewFolder();
          ensureDirSync(`${topPath}/${folder}`);
        }
        writeFile(flow, `${topPath}/${folder}/${getName(flow)}.json`);
      }
      if (option === `Delete remote prod ${resourceType}`) {
        const resp = await deleteRemoteConfig(`${urlPath}/${getName(flow)}`);
        if (resp.status === 200) {
          console.log(`Successfully deleted ${getName(flow)}`);
        } else console.log(`Failed deleting ${getName(flow)}`);
      }
    }
  }
  for (const file of files) {
    const localFlow = JSON.parse(
      decoder.decode(Deno.readFileSync(file)),
    ) as optionType;
    console.log(
      `\nThe remote prod doesn't have the ${resourceType} ${
        getName(localFlow)
      }\nlocated at ${file}`,
    );
    const { option } = await inquirer.prompt([
      {
        name: "option",
        type: "list",
        message: "What do you want to do?",
        choices: [
          "Nothing",
          `Push new ${resourceType} to prod`,
          `Delete local ${resourceType}`,
        ],
      },
    ]);
    if (option === `Push new ${resourceType} to prod`) {
      const resp = await pushConfig(urlPath, localFlow);
      if (resp.status === 200) {
        console.log(`Successfully pushed ${getName(localFlow)}`);
      } else console.log(`Failed pushing ${getName(localFlow)}`);
    }
    if (option === `Delete local ${resourceType}`) {
      Deno.removeSync(file);
      console.log(`Deleted ${file}`);
    }
  }
}
