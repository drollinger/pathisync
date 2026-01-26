import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { parseArgs } from "@std/cli";
import { env, gitignore, readme } from "./fileConstants.ts";

// Get commandline arguments
const args = parseArgs(Deno.args);
const projectName = args._[0]?.toString();
const projectPath = projectName ? join(Deno.cwd(), projectName) : Deno.cwd();
ensureDirSync(projectPath);

for (
  const folder of [
    "flows",
    "resources",
    "sharedConfigs",
    "triggers",
  ]
) ensureDirSync(join(projectPath, folder));

Deno.writeTextFileSync(
  join(projectPath, ".env"),
  env,
);
Deno.writeTextFileSync(
  join(projectPath, "README.md"),
  readme,
);
Deno.writeTextFileSync(
  join(projectPath, ".gitignore"),
  gitignore,
);

console.log("Pathisync configuration complete!");
