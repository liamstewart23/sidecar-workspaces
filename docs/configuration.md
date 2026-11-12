# Project configuration

**For most Git projects, you can skip this section.** Sidecar works without a config file. If you want to start a server, define tasks, or customize storage, run this in your project root:

```bash
sidecar init
```

This creates `.sidecar.json`. In a Git project, put it at the Git root and commit it before creating a workspace: Sidecar requires a clean checkout. For a project without Git, `sidecar init` identifies the project, but `diff` and `apply` require Git.

For example, to start a Node development server when the workspace starts:

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

Every config must include `"version": 1`. See the [configuration reference](#configuration-reference) below and these examples:

- [Node dev server](../examples/node-dev-server.json), including NVM setup.
- [PHP + Valet](../examples/php-valet.json), including secure local URLs and PHP isolation. The project's `.valetrc` chooses the PHP version.
- [Docker Compose](../examples/docker-compose.json), including a long-running process and a test task.

Copy an example into `.sidecar.json` and adjust it for your project. For settings specific to your machine, use `.sidecar.local.json`; it overrides the shared config. Add it to your project's `.gitignore` if you don't want to commit it.

### Tasks and automatic steps

Use `sidecar exec` for a one-off command, a **task** for a repeatable command, and a **hook** to run tasks automatically at a workspace lifecycle step.

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

This runs `seed-demo` after startup. You can also run it yourself, with extra arguments:

```bash
sidecar task my-idea seed-demo -- --fresh --account=123
```

Hooks are `beforeUp`, `afterUp`, `beforeApply`, `afterApply`, `beforeDown`, and `afterDown`. Each hook runs its listed tasks in order. Put commands in the config or scripts it references so you can review what they do.

### Give people and agents a guide

Add a `SIDECAR.md` file at your project root to explain how to work in a workspace. Sidecar prints the guide; it doesn't execute it.

```md
# Sidecar guide

Work only from `{view}` on branch `{branch}`.
Open `{url}` after startup.
Run `sidecar task {name} seed-demo -- --fresh` when a demo account is needed.
```

Run `sidecar guide my-idea` to print the guide with `{name}`, `{branch}`, `{domain}`, `{url}`, and `{view}` filled in. To use another path within the project, set `agent.guide` in `.sidecar.json`.

### Where workspaces are stored

By default, Sidecar stores workspace files, state, and logs under `~/.sidecar`. To choose a different location for a project:

```json
{
  "version": 1,
  "storage": {
    "root": "../.sidecar-workspaces"
  }
}
```

Relative paths start at the project root. Choose a directory **outside** the project so Sidecar doesn't copy its own workspaces. Each workspace lives under `<storage.root>/projects/<project-id>/sessions/<name>`.

You can set `SIDECAR_HOME` to override storage, for example in CI. Sidecar also keeps a registry index under `~/.sidecar/registry` so it can find workspaces after `storage.root` changes. `SIDECAR_HOME` selects a separate index too; `SIDECAR_REGISTRY_HOME` changes the index location independently, placing it in that directory's `registry` subdirectory. Keep the same index location to find existing workspaces after changing storage.

The index must also be outside the project. If your project contains `~/.sidecar`, set `SIDECAR_REGISTRY_HOME` to an external directory, or use `SIDECAR_HOME` to change both locations.

For workspaces created before the index existed, use their original storage setting to access them by name, or run commands from inside their View. An older workspace belonging to a configured parent project can also be found by name from a nested Git project if no local workspace has that name. New workspaces use the nested Git project.

## Configuration reference

- `version`: Required. Use `1`.
- `processes`: Shell commands Sidecar can manage. On `up`, Sidecar starts a process named `watch`, or the first process with `autostart: true`. `shutdownTimeoutMs` sets how long to wait before force-stopping a process; the default is 5000 milliseconds.
- `tasks`: Named shell commands. Tasks receive `SIDECAR_NAME`, `SIDECAR_BRANCH`, `SIDECAR_DOMAIN`, `SIDECAR_URL`, and `SIDECAR_VIEW`.
- `hooks`: Lists of task names to run at the supported lifecycle steps.
- `runtime`: The shell and bootstrap commands. Bootstrap commands run in order before each managed process, task, and `exec`; use them for tools such as NVM, mise, asdf, or a virtual environment.
- `valet`: An optional local URL through Valet. `domain` can use `{name}` and `{branch}`; Sidecar makes the branch name safe for a domain. `secure` and `isolate` correspond to Valet flags. Sidecar reports a URL only when Valet is enabled and `--no-valet` isn't used. The URL uses `http` unless `secure` is set.
- `storage.root`: Workspace storage directory. Relative paths start at the project root. `SIDECAR_HOME` takes precedence.
- `agent.guide`: Path to the project guide, relative to the project root. Defaults to `SIDECAR.md`.

