export const readme = `# Pathify Flow Local Integration Sync

Description: Library of all config files for Pathify flow server.


## Setting up local environment

1. Make sure you have Deno installed on your machine
2. Generate a token from Pathify by visiting https://<your.flow.server>/auth/s2s/token/create
    - Ensure you are logged in before visiting the page
    - By default, these tokens have a 30-day expiry
3. Insert your token and your flow server URL into the .env file
4. Run \`deno run -A jsr:@usu/pathisync\`. If this folder was cloned from git, the first run creates the \`.env\` for you to fill in


## Running the sync

1. To sync flows, resources, shared configs, and triggers, use the command \`deno run -A jsr:@usu/pathisync\`. Every sync also updates the editor types for flow JavaScript (see "Editing flow JavaScript")
2. If there is anything out of sync with the server, a diff and a prompt will appear explaining differences and possible solutions
    - \`+\` lines in a diff are what pushing would add to the server, \`-\` lines are what it would remove
    - Pick "Show full diff" to page through a long diff, or use \`--no-diff\` to hide diffs
3. By default, the sync will block the options to delete files. To include deletion options, use the \`-d\` flag
4. You can specify a config that you are working on to have pathisync watch it and push any changes. To do this, use the command \`deno run -A jsr:@usu/pathisync watch path/to/_collection.json\`
    - A flow's folder (\`watch flows/@widgets/grades\`, covering its \`flow.json\`, \`processors.js\` and triggers), a namespace folder (\`watch flows/@widgets\`), a trigger, a shared config, a \`_collection.json\`, a resource file or any other folder can be watched
    - Watch mode only pushes a config when the server hasn't changed it since the last sync. Otherwise it prints a warning and a diff, and pushes nothing
    - Deleting a watched file never deletes anything on the server
5. If you want the sync to resolve conflicts and unclear differences in favor of the server, use the \`-l\` flag
6. To force syncing and creating local files in the default directory you can use the \`-lf\` flag
7. To sync only what you're working on, give paths to \`sync\`: \`deno run -A jsr:@usu/pathisync sync flows/@widgets/grades\` syncs that flow and the triggers in its folder, with the usual prompts. Any path \`watch\` takes works
8. To sync with another server, such as a testing instance, copy \`.env\` to \`.<name>.env\` (for example \`.testing.env\`), fill in that server's token and URL, and add \`--env-file=.testing.env\` to any command, after \`jsr:@usu/pathisync\`. Each server keeps its own record of the last sync. Keep \`*.env\` in \`.gitignore\`; pathisync warns about an env file git doesn't ignore
9. To only see what is out of sync, use \`deno run -A jsr:@usu/pathisync check\`. It never prompts, writes or pushes. Add \`--diff\` to include diffs, and paths (\`check flows/@widgets\`) to limit it. It exits with 0 when everything is in sync, 1 when something differs and 2 on errors
10. To see what a widget depends on, use \`deno run -A jsr:@usu/pathisync links resources/path/to/collection\`. It prints the triggers the widget's files call, the flow each trigger runs, and those flows' sub-flows. It only reads local files, and can't see URLs built at runtime


## How the sync decides

- pathisync records a hash of every config at the last successful sync in \`.pathisync/state.json\`, separately for each server. This file is per machine and must not be committed (\`.pathisync/\` is in \`.gitignore\`)
- With that record, pathisync knows which side changed:
    - only the server changed: the local copy is updated without asking
    - only the local copy changed: you're offered a push
    - both changed: it's reported as a conflict, with a diff
- Without a record (first run, fresh clone, new config), every difference is shown with a diff and a prompt. One full sync fills in the record
- Deleting \`.pathisync/state.json\` is always safe; the next sync just asks more questions
- After a push, pathisync re-reads the config from the server. If the server added defaults or new fields, the local copy is updated to match


## Protected configs

- **Bundled configs** (a \`bundle\` field on a flow, shared config or collection, or \`config.bundle\` on a trigger) are owned by Pathify and treated as read-only: pathisync won't push or delete them. Use \`--allow-bundled\` to be offered those options, with a confirmation per config. Watch mode never pushes them
- **Secure shared configs** (\`secure: true\`) are never pushed or deleted by pathisync, because the server only returns them redacted. Manage secrets in the Pathify UI
- Pulling bundled or secure configs works as normal


## How flows and triggers are laid out

- Each flow is a folder. The Pathify UI groups flows by the namespace after the \`@\` in their name, and the folders follow it: an \`@namespace\` folder, one \`+sub\` folder for each \`:\` level, then the flow's own folder
    \`\`\`
    flows/
      @widgets/
        grades/                          the flow grades@widgets
          flow.json
          processors.js
          http_get_grades.trigger.json
      @campus/
        +accounts/
          sync_users/                    the flow sync_users@campus:accounts
      login_redirect/                    a flow without a namespace
    triggers/
      dns_override.json                  a trigger that runs no local flow
    \`\`\`
- **A flow's name comes from its folders.** \`flow.json\` must hold the same name. If they disagree (a folder renamed or moved by mistake), that flow isn't synced until they match, since a different name would be a new flow on the server
- Flows can't be sorted into other folders, and flow folders can't be nested. New flows from the server are put in the right folder automatically
- **Triggers** sit in the folder of the flow they run (\`config.orchestratorName\`), as \`<trigger name>.trigger.json\`. A flow can have several. Triggers that run no flow, or a flow that isn't local, live in \`triggers/\` as \`<trigger name>.json\`
- If a trigger's flow changes, pathisync says where the trigger now belongs and offers to move it. It never moves files on its own
- Shared configs and resources aren't grouped by namespace; they keep their own folders


## Editing flow JavaScript

- Every JavaScript field of a flow's processors (\`jsFunc\`, \`keyFunc\`, …) lives in the flow's \`processors.js\`, next to its \`flow.json\`
- In \`flow.json\`, each of those fields points to a function: \`"jsFunc": { "$fn": "comprehendResults_jsFunc" }\`
- In \`processors.js\`, each function looks like this, and its body is exactly what the server runs:
    \`\`\`js
    export function comprehendResults_jsFunc() {
      return [new code_data_SimpleData(item)];
    }
    \`\`\`
- Keep the \`export function <name>() {\` line and the closing \`}\` at the start of their lines. The body is indented by two spaces, which is removed before pushing
- **Don't rename a function without renaming its \`"$fn"\` pointer, or the other way round.** A pointer without a function stops the flow from syncing, and a function without a pointer is never pushed
- Anything outside a function other than comments would never reach the server, so it's reported as an error
- An inline JavaScript string in \`flow.json\` still works; the next pull moves it into \`processors.js\`
- \`flows/jsconfig.json\` makes editors that use the TypeScript language server (VS Code, Neovim with ts_ls or vtsls) check flow JavaScript against the server's globals:
    - \`types/pathify.d.ts\` is generated from your flow server's docs, including globals added by installed plugins. Every sync regenerates it (the docs are public, so no token is used), and \`deno run -A jsr:@usu/pathisync types\` regenerates it on demand. Commit it; don't edit it by hand
    - \`types/globals.d.ts\` declares variables the runtime injects that the docs don't list (\`item\`, \`payload\`, \`_\`, …). It's yours to edit; pathisync never overwrites it


## Notes about syncing

- The sync command uses a remote script that deno caches. To update this script to the latest version you can use the command \`deno cache --reload jsr:@usu/pathisync\`
- Config files are located in the project root under their respective folder names (\`flows\`, \`resources\`, \`sharedConfigs\`, \`triggers\`)
- Shared configs and triggers each consist of a single JSON file. These files must have the same name as the ID/name specified in the file and have a .json extension
- Resources consist of a folder with the same name as the collection id and inside of that folder, a \`\\_collection.json\` file
- Each resource must be located in the same location and under the same file name listed in the resourceAccessorPath. This location is relative to the base folder for that collection
- Shared configs, triggers in \`triggers/\`, and collection folders can be sorted into nesting folders within their respective folders
- A new resource that isn't listed on prod nor in \`\\_collection.json\` will not show up while syncing. To sync a new local resource, add it to the \`\\_collection.json\` resources list with appropriate configuration fields


## Dictionary

- config file: All inclusive term for any flow, shared config, trigger, or resource used by Pathify's system
- collection: A grouping of resources bound under the same \`\\_collection.json\` file
- prod/server: Refers to the flow server where config files are used in the live production environment. Prompts name the server by its host, from \`FLOW_SERVER_URL\` in \`.env\` (or the file given with \`--env-file\`)


Pathify Documentation:
- https://<your.flow.server>/static/swagger/index.html#/
- https://docs.flow.campus.app/
`;

export const gitignoreLines = [".DS_Store", ".env", "*.env", ".pathisync/"];

export const env = `# Add your environment variables here
# Generate a token from Pathify by visiting https://<your.flow.server>/auth/s2s/token/create
# Ensure you are logged in before visiting the page
# By default, these tokens have a 30-day expiry
PATHIFY_TOKEN=
FLOW_SERVER_URL=https://<your.flow.server>
`;

export const jsconfig = `{
  // Flow JavaScript runs on the flow server (Rhino), not in a browser.
  // Created by pathisync; edit freely, it is never overwritten.
  "compilerOptions": {
    "checkJs": true,
    "noEmit": true,
    "lib": ["es2015"],
    "types": [],
    "strict": false,
    "noImplicitAny": false,
    "moduleDetection": "force"
  },
  "include": ["**/*.js", "../types/*.d.ts"]
}
`;

export const globalsDts =
  `// Variables injected by the Flow runtime that are not in the generated docs.
// Hand-maintained. Tighten types over time. pathisync never overwrites this file.

/** The current element in mapper-style processors (dataMapper, dataFlatMapper, …). */
declare var item: any;
/** The overall orchestration payload. */
declare var payload: any;
/** lodash (runtime version unknown). */
declare var _: any;
/** Java interop: \`Java.type('java.lang.String')\` returns a Java class. */
declare var Java: any;

/**
 * Rhino lets JavaScript strings call java.lang.String methods
 * (\`getBytes\`, \`equalsIgnoreCase\`, …).
 */
interface String {
  [key: string]: any;
}
`;
