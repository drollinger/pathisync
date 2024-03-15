import { ensureDirSync } from "https://deno.land/std@0.220.1/fs/mod.ts";
import { join } from "https://deno.land/std@0.220.1/path/mod.ts";
import { parseArgs } from "https://deno.land/std@0.220.1/cli/parse_args.ts";
import { env, gitignore, readme, script } from "./fileConstants.ts";

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
Deno.writeTextFileSync(
  join(projectPath, "sync"),
  script,
);
Deno.chmodSync(join(projectPath, "sync"), 0o755);

console.log("Pathisync configuration complete!");
