# Pathisync

Description: Deno library that allows you to sync a repository with your flow
server

# Setup

- Ensure you have Deno installed on your machine
- In an empty folder (your project), run
  ```
  deno run -A jsr:@usu/pathisync
  ```
- The first run in a folder without a `.env` sets up the project: `.env`,
  `README.md`, `.gitignore`, the config folders and editor settings. Files that
  already exist are never overwritten; missing `.gitignore` lines are added
- Fill in `PATHIFY_TOKEN` and `FLOW_SERVER_URL` in `.env`, then run the same
  command again to do your first sync
- Initialize git in the folder to track changes. A fresh clone has no `.env`
  (it's gitignored), so the first run there just creates it

# Commands

All commands are `deno run -A jsr:@usu/pathisync [command]`:

| Command           | What it does                                                                    |
| ----------------- | ------------------------------------------------------------------------------- |
| (none)            | Sync flows, shared configs, triggers and resources, and update the editor types |
| `check [paths]`   | Report what differs; never prompt, write or push. Exit 0/1/2                    |
| `watch <paths>`   | Push saved changes for a flow folder, config, file or folder                    |
| `links <widgets>` | Print the triggers a widget calls, their flows and sub-flows                    |
| `types`           | Regenerate `types/pathify.d.ts` from the flow server's docs                     |

Flags: `-d` (offer deletes), `-l` (resolve conflicts in favor of the server),
`-f` (with `-l`, create new files in the default folder), `--no-diff`, `--diff`
(with `check`), `--allow-bundled`.

# What's in a project

```
flows/
  @widgets/                          flows grouped by the namespace after "@"
    grades/                          the flow grades@widgets
      flow.json
      processors.js                  its JavaScript
      http_get_grades.trigger.json   a trigger that runs it
  @campus/+accounts/…                "+" folders for each ":" level (@campus:accounts)
triggers/                            triggers that run no local flow
sharedConfigs/
resources/<collection>/_collection.json + the collection's files
types/                               editor types for flow JavaScript
.pathisync/state.json                per-machine record of the last sync (gitignored)
```

- A flow's name comes from its folders, and must match `name` in `flow.json`. If
  they disagree, the flow isn't synced until they match
- Each JavaScript field in `flow.json` is a pointer,
  `"jsFunc": { "$fn": "comprehendResults_jsFunc" }`, to an
  `export function comprehendResults_jsFunc() { … }` in `processors.js`.
  Pathisync puts the code back inline before pushing, so the server receives
  exactly what it stores. Don't rename a function without renaming its pointer,
  or the other way round
- A trigger lives in the folder of the flow it runs, as
  `<trigger name>.trigger.json`. If its flow changes, pathisync offers to move
  it; it never moves files on its own
- `flows/jsconfig.json` and `types/` give editors completion and checking for
  flow JavaScript. `types/pathify.d.ts` is regenerated from the server's public
  docs on every sync; `types/globals.d.ts` is yours
- Deleting `.pathisync/state.json` is safe; the next sync just asks more
  questions

Pathisync never pushes or deletes secure shared configs, and treats bundled
configs as read-only unless `--allow-bundled` is given. Watch mode only pushes
when the server hasn't changed since the last sync.

# Development

- `deno task test` runs the tests (a fake flow server and temp projects; no
  network)
- `deno task check` runs fmt, lint and type checks
- `deno task roundtrip <project-dir>` checks that every flow in a real project
  survives the `flow.json` + `processors.js` split unchanged. It only reads
  local files
