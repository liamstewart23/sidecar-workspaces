<p align="center">
  <img src="assets/sidecar-workspaces-cli-logo.png" alt="Sidecar Workspaces CLI logo: a terminal-equipped motorcycle sidecar" width="620">
</p>

# Sidecar Workspaces

Sidecar creates a separate workspace for your project, so you or a coding agent can try an idea or work on a task without editing your main checkout.

Each workspace starts with a snapshot of your project, including existing dependencies and other local files. Open it in your editor, run the project, and change files as usual. When you’re ready, review your changes and apply them to your main checkout.

The snapshot includes ignored files, such as `.env` files and dependencies. Existing symbolic links can still point outside the workspace, and project commands can affect shared resources such as databases.

## Why use Sidecar?

- **Keep work separate:** experiment, run parallel tasks, or give an agent its own workspace without changing your main checkout's files.
- **Save setup time and disk space:** on macOS with APFS, Sidecar can create a workspace efficiently using copy-on-write. The workspace starts with the same files, but unchanged data shares disk space with the original. Existing dependencies are included, so you may not need to reinstall them. If cloning is unavailable, Sidecar makes a regular copy.
- **Run your usual tools:** each workspace works with your editor, Git, coding agents, and project commands. Sidecar can also manage configured processes, tasks, and local URLs.

A workspace is a **snapshot**, not a live copy: later changes in the main checkout do not appear in an existing workspace. Copy-on-write can improve workspace creation time and disk usage; it does not make the project itself run faster.

## Requirements

- Node.js 14.17 or newer to run Sidecar.
- Git for `diff` and `apply`.
- A standalone Git checkout. Linked worktrees, submodules, and checkouts with linked `.git` metadata are not supported because their Git state is shared outside the project directory.
- In a Git checkout, place `.sidecar.json` at the Git root. A config in a subdirectory cannot create new workspaces because the copy would not include Git metadata.
- macOS APFS for copy-on-write storage savings. Other filesystems use a regular isolated copy.

## Install

```bash
git clone https://github.com/liamstewart23/sidecar-workspaces.git
cd sidecar-workspaces
npm link
```

Or run the CLI directly:

```bash
node /path/to/sidecar-workspaces/bin/sidecar.js --help
```

## Quick start

From a clean Git checkout with at least one commit, create a workspace:

```bash
cd /path/to/project
sidecar up preview-42
```

`up` prints the workspace’s `View` path when startup is complete. Open that directory in your editor, or point your coding agent to it. Changes you make to workspace files stay there until you apply them. Wait for startup to finish before running commands that modify or stop the workspace.

Use `sidecar status preview-42` to check the workspace, `sidecar diff preview-42` to review its changes, and `sidecar apply preview-42` to apply them to your main checkout.

Inside a workspace, you can leave out its name. For example, `sidecar status`, `sidecar diff`, and `sidecar exec -- npm test` use the current workspace. You can still include the name, as in `sidecar status preview-42`.

## Optional configuration

You don't need a config file for a Git project. To customize Sidecar, run `sidecar init` in the project root to create `.sidecar.json`, then edit it. For example, to start a Node development server automatically, use:

```json
{
  "version": 1,
  "processes": {
    "dev": {
      "command": "npm run dev",
      "autostart": true
    }
  }
}
```

Commit the config before creating a workspace: Sidecar requires a clean Git checkout. For a project without Git, run `sidecar init` to identify the project; `diff` and `apply` require Git.

## Optional integrations

You only need `{ "version": 1 }` to get started. Add integrations if your project needs them:

- [PHP + Valet](examples/php-valet.json): secure `https://<name>.test` URLs and PHP isolation. The project’s own `.valetrc` chooses the PHP version.
- [Node dev server](examples/node-dev-server.json): NVM setup plus `npm run dev`, without a URL integration.
- [Docker Compose](examples/docker-compose.json): a long-running Compose process and a one-off test task.

Copy an example into `.sidecar.json` and adjust it for your project. Put settings for your own machine in `.sidecar.local.json`; they override the shared config. Add `.sidecar.local.json` to your project's `.gitignore` if you don't want to commit it.

By default, Sidecar stores sessions under `~/.sidecar`. To put a project's sessions in another external directory, set `storage.root`. Relative paths are resolved from the project root:

```json
{
  "version": 1,
  "storage": {
    "root": "../.sidecar-workspaces"
  }
}
```

Sidecar stores each workspace, its state, and its logs under `<storage.root>/projects/<project-id>/sessions/<name>`. Choose a storage directory outside the project so Sidecar does not copy its own workspaces. You can also set `SIDECAR_HOME` to override the storage location, for example in CI.

Sidecar keeps an index under `~/.sidecar/registry` so existing workspaces remain accessible if you change `storage.root`. `SIDECAR_HOME` also selects a separate index. To choose an index location independently of workspace storage, set `SIDECAR_REGISTRY_HOME`; Sidecar stores the index under its `registry` subdirectory. Keep the same index location to find existing workspaces after changing `storage.root`.

For workspaces created before this index existed, use their original storage setting to access them by name, or run commands from inside their view.
If an older workspace belongs to a configured parent project, commands from a nested Git project can still find it by name when no local workspace has that name. New workspaces use the nested Git project.

The index must also be outside the project. If your project contains `~/.sidecar`, set `SIDECAR_REGISTRY_HOME` to an external directory, or set `SIDECAR_HOME` to change both the index and workspace locations.

## Everyday workflow

| Command | Purpose |
| --- | --- |
| `sidecar up preview-42` | Creates the workspace, runs startup hooks, starts the default process if configured, and optionally creates a Valet link. |
| `sidecar status preview-42` | Shows the view, source branch, URL, process health, and log paths. |
| `sidecar exec preview-42 -- npm test` | Runs a command in the workspace using the configured runtime setup. |
| `sidecar task preview-42 seed-demo -- --fresh` | Runs a project task with an extra argument. |
| `sidecar guide preview-42` | Prints the project guide with values filled in for this workspace. |
| `sidecar diff preview-42` | Summarizes tracked changes and lists new files Git does not ignore. |
| `sidecar apply preview-42` | Applies workspace changes to the main checkout if it is safe to do so. |
| `sidecar down preview-42` | Runs shutdown hooks, stops managed processes, and removes its Valet link. Keeps the workspace and its files. |
| `sidecar remove preview-42 --force` | Permanently removes the Sidecar. |
| `sidecar recover preview-42 --force` | Preserves files from an interrupted startup and frees the name for reuse. |

`sidecar status` shows where to find the log for each managed process.

If startup is interrupted before Sidecar saves its state, run `sidecar recover <name> --force` from the project. Sidecar refuses recovery while the recorded startup process is running, moves any partial files to a separate directory, and prints its path. For a directory left by an older Sidecar version, first confirm no startup is still running; older versions do not record the startup process. If the workspace has state, use `status`, `down`, or `remove` instead.

If recovery itself is interrupted, run it again. If Sidecar reports a recovery lock from an older version, confirm no recovery is running, then run `sidecar recover <name> --force --clear-recovery-lock` and retry. Sidecar checks the recorded process when available. If an owner record is missing or incomplete, it asks for `--unverified`; only add that flag after checking that no startup or recovery for that name is running.

If a workspace's state is damaged, recovery may also ask for `--unverified`. First confirm that no startup or managed processes for that workspace are running. Recovery preserves the workspace files and tells you if the registry needs a separate cleanup.

If Sidecar reports an unreadable registry entry or a missing session, check the original storage and confirm no startup for that name is running. Then use `sidecar recover <name> --force --clear-registry --unverified`. Sidecar preserves the entry separately and refuses to clear a readable entry that still points to an existing session directory. You can then check or remove the workspace using its original storage settings.

## Custom steps and automation

Choose how you want to run a command:

| Need | Use |
| --- | --- |
| One-off debugging or setup | `sidecar exec <name> -- <command>` |
| A repeatable project command | `tasks` in `.sidecar.json` |
| A step that must happen automatically | `hooks` in `.sidecar.json` |
| Agent/human instructions and recipes | `SIDECAR.md` |

Tasks run shell commands you define in your project config:

```json
{
  "version": 1,
  "tasks": {
    "seed-demo": {
      "command": "./scripts/sidecar/seed-demo \"$SIDECAR_NAME\""
    }
  },
  "hooks": {
    "afterUp": ["seed-demo"]
  }
}
```

Run it manually with arguments when needed:

```bash
sidecar task preview-42 seed-demo -- --fresh --account=123
```

Supported hook names are `beforeUp`, `afterUp`, `beforeApply`, `afterApply`, `beforeDown`, and `afterDown`. Hooks run the named tasks in order.

## `SIDECAR.md`: the project guide

`SIDECAR.md` is a guide for people and coding agents. Use it to explain how to work on your project. Sidecar does not execute the guide.

```md
# Sidecar guide

Work only from `{view}` on branch `{branch}`.

Open `{url}` after startup.

Run `sidecar task {name} seed-demo -- --fresh` when a demo account is needed.
```

Run `sidecar guide preview-42` to print the guide with `{name}`, `{branch}`, `{domain}`, `{url}`, and `{view}` filled in for that workspace. Sidecar looks for `SIDECAR.md` in the project root by default. Set `agent.guide` in `.sidecar.json` to use a different path within the project.

Put commands in `.sidecar.json` or scripts it references, so you can review what each task runs.

## Configuration reference

If you create a `.sidecar.json`, it must include a version:

```json
{ "version": 1 }
```

- `valet` configures an optional local URL. Its `domain` can use `{name}` and `{branch}`; Sidecar makes the branch name safe for a domain. `secure` and `isolate` correspond to Valet flags. Sidecar reports a URL only when Valet is enabled and `--no-valet` is not used. The URL uses `http` unless `secure` is set.
- `runtime` configures the shell and setup commands. Sidecar runs the `bootstrap` commands in order before each managed process, task, and `exec`. Use them to set up NVM, mise, asdf, or a virtual environment.
- `storage.root` sets where Sidecar stores this project's workspaces, state, and logs. Relative paths start at the project root. The default is `~/.sidecar`; `SIDECAR_HOME` takes precedence.
- `processes` defines shell commands that Sidecar can manage. When you run `up`, Sidecar starts a process named `watch`, or the first process with `autostart: true`. `shutdownTimeoutMs` sets how long to wait for a process to stop before force-stopping it; the default is 5000 milliseconds.
- `tasks` defines shell commands you can run by name. Each task receives `SIDECAR_NAME`, `SIDECAR_BRANCH`, `SIDECAR_DOMAIN`, `SIDECAR_URL`, and `SIDECAR_VIEW`.
- `hooks` lists tasks to run at specific points in the workspace lifecycle. Sidecar runs each list in order.
- `agent.guide` is the path to your project guide, relative to the project root. It defaults to `SIDECAR.md`.

## Applying work safely

`sidecar apply` only runs if your main checkout is clean and still on the commit used to create the workspace. This helps prevent overwriting other work.

It applies changes to tracked files and adds new files that Git does not ignore. Ignored files, such as dependencies and build output, stay in the workspace. If the main checkout has moved on, bring the changes over manually.

## Working with coding agents

Sidecar works with people, coding agents, editors, and other local tools. To keep changes separate, work inside the printed `View` directory.
