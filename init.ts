import {
  ensureDirSync,
  existsSync,
} from "https://deno.land/std@0.184.0/fs/mod.ts";
import { join } from "https://deno.land/std@0.184.0/path/mod.ts";
import { parse } from "https://deno.land/std@0.184.0/flags/mod.ts";
import { env, gitignore, readme, script } from "./fileConstants.ts";

// Get commandline arguments
const args = parse(Deno.args);
const projectName = args._[0].toString() ?? "pathisync";
const projectPath = join(Deno.cwd(), projectName);

if (existsSync(projectPath)) {
  console.error(`The folder ${projectName} already exists.`);
  Deno.exit(1);
}
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
Deno.writeTextFileSync(
  join(projectPath, "script.ts"),
  script,
);

console.log("Pathisync configuration complete!");
