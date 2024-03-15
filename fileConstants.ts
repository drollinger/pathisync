export const readme = `# Pathify Flow Local Integration Sync

Description: Library of all config files for Pathify flow server.


## Setting up local environment

1. Generate a token from Pathify by visiting https://<your.flow.server>/auth/s2s/token/create
    - Ensure you are logged in before visiting the page
    - By default, these tokens have a 30-day expiry
2. Insert your token into the .env file
3. Add the path of
3. Make sure you have Deno installed on your machine


## Running the sync

1. To sync flows, resources, shared configs, and triggers, use the command \`./sync\`
    Note: The sync script has the permissions \`--allow-env\`, \`--allow-read\`, \`--allow-write\`, \`--allow-net\`. You can edit this file and remove these permissions and approve them at runtime if you want
2. If there is anything out of sync with the server, a prompt will appear explaining differences and possible solutions
3. By default, the sync will block the option to overwrite remote files and delete local files. To include deletion options, use the \`-d\` flag
4. You can specify a specific config that you are working on to have the sync script watch the file and push any changes. To do this, use the command \`./sync --watch=path/to/_collection.json\`
5. If you want the sync to default to updating local files you can use the \`-l\` flag.
6. To force syncing and creating local files in the default directory you can use the \`-lf\` flag.


## Notes about syncing

- The sync command uses a remote script that deno caches. To update this script to the latest version you can use the command \`deno cache --reload https://deno.land/x/pathisync/script.ts\`
- Config files are located in the Pathify folder under their respective folder names.
- Flows, shared configs, and triggers only consist of a single widget file. These files must have the same name as the ID/name specified in the file and have a .json extension.
- Resources consist of a folder with the same name as the collection id and inside of that folder, a \`\\_collection.json\` widget file
- Each resource must be located in the same location and under the same file name listed in the resourceAccessorPath. This location is relative to the base folder for that collection
- Single widget files and collection folders can be sorted into nesting folders within there respective folders
- A new resource that isn't listed on prod nor in \`\\_collection.json\` will not show up while syncing. To sync a new local resource, add it to the \`\\_collection.json\` resources list with appropriate configuration fields


## Dictionary

- config file: All inclusive term for any flow, shared config, trigger, or resource used by Pathify's system
- collection: A grouping of resources bound under the same \`\\_collection.json\` file
- prod/server: Refers to the flow server where widget files are used in the live production environment


Pathify Documentation:
- https://<your.flow.server>/static/swagger/index.html#/
- https://docs.flow.campus.app/
`;

export const gitignore = `.DS_Store
.env
`;

export const env = `# Add your environment variables here
# Generate a token from Pathify by visiting https://<your.flow.server>/auth/s2s/token/create
# Ensure you are logged in before visiting the page
# By default, these tokens have a 30-day expiry
PATHIFY_TOKEN=
FLOW_SERVER_URL=https://<your.flow.server>
`;

export const script =
  `#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write --allow-net

import main from "https://deno.land/x/pathisync/script.ts";
import { parse } from "https://deno.land/std@0.220.1/flags/mod.ts";
main(parse(Deno.args));
`;
