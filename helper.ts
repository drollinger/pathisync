import { walkSync } from "https://deno.land/std@0.184.0/fs/mod.ts";
import { parse } from "https://deno.land/std@0.184.0/path/mod.ts";
import inquirer from "npm:inquirer@^9.2.0";
import fetch from "./client.ts";

export const getFiles = (dir: string): string[] => {
  const paths: string[] = [];
  for (const entry of walkSync(dir, { includeDirs: false })) {
    paths.push(entry.path);
  }
  return paths;
};

export const findFile = (dir: string, filename: string) => {
  const files = getFiles(dir);
  const filteredList = files
    .filter((file) => parse(file).name === filename);
  if (filteredList.length > 1) {
    throw new Error(`Duplicate Filenames Found!\n${filteredList.join("\n")}`);
  }
  return filteredList[0] ?? null;
};

export const writeFile = (flow: any, filePath: string) => {
  Deno.writeTextFileSync(
    filePath,
    JSON.stringify(flow, null, 2),
  );
  console.log('File "' + filePath + '" Saved');
};

export const promtFolder = async (folders: string[]) => {
  return await inquirer.prompt([
    {
      name: "folder",
      type: "list",
      message: "Choose a folder",
      choices: folders,
    },
  ]);
};

export const promtNewFolder = async () => {
  const response = await inquirer
    .prompt([
      {
        name: "new_folder",
        type: "input",
        message: "Enter new folder name:",
      },
    ]);
  return response.new_folder;
};

export const getDirs = (
  srcpath: string,
  filterCollections = false,
): string[] => {
  const paths: string[] = [];
  const collectionPaths: string[] = [];
  for (const dirEntry of walkSync(srcpath, { includeFiles: false })) {
    if (filterCollections) {
      for (
        const fileEntry of walkSync(dirEntry.path, {
          includeDirs: false,
          maxDepth: 1,
        })
      ) {
        if (fileEntry.name === "_collection.json") {
          collectionPaths.push(dirEntry.path);
          break;
        }
      }
    }
    if (dirEntry.path === srcpath) paths.push(dirEntry.path + "/.");
    else if (
      !(filterCollections &&
        collectionPaths.filter((path) => dirEntry.path.startsWith(path))
            .length > 0)
    ) paths.push(dirEntry.path);
  }
  return paths;
};

export async function pushConfig(url: string, data: any) {
  console.log("bad");
  return await fetch(url, {
    //method: "POST",
    method: "GET",
    body: JSON.stringify(data),
  });
}

export async function deleteRemoteConfig(url: string) {
  //return await fetch(url, { method: "DELETE" });
  console.log("bad");
  return await fetch(url, { method: "GET" });
}
