# Using Sidecar with coding agents

Sidecar works with Codex, Claude Code, and other agents that can run local commands and access the workspace directory. There is no agent plugin or skill to install yet.

The most straightforward approach is to run `sidecar up my-idea` yourself, open the printed View folder in your agent, and give it a task. For example:

> Build a settings page in this workspace. Run the relevant tests and tell me what you changed.

You can also ask an agent working in your main checkout to create a workspace. For example:

> Create a Sidecar called `dark-mode` for my idea to add a dark mode, and build it there.

For more control over what happens afterward, try:

> Create a Sidecar workspace called `my-idea`. Wait for startup, work from the printed View directory, and build the settings page there. Run the relevant tests and show me the Sidecar diff when you're done. Don't apply the changes yet.

The agent needs access to the View directory, which is stored outside the project by default. Its execution environment and permissions may affect whether it can use that path. Start from a supported standalone checkout; for example, don't run `sidecar up` from a linked Codex Git worktree.

### More prompts to try

You can copy these prompts into Codex, Claude Code, or another coding agent. Replace `dark-mode` with your workspace name and describe your own idea. The agent needs Sidecar installed and access to your project and workspace.

### Set up a local URL and asset watcher

If your project uses Laravel Valet, you might want each workspace to have its own local address, such as `dark-mode.test`. An asset watcher is a command that keeps your frontend files up to date while you work.

> Look at this project's existing Valet, PHP, and frontend setup. Help me configure Sidecar so a new workspace gets its own Valet URL and starts the appropriate frontend asset watcher. Use the project's existing commands and PHP settings. Check for anything that could prevent multiple workspaces from running at once, such as ports or shared services. Explain what you changed, what's needed on my machine, and how I can try it. Don't guess if something is unclear.

The agent can create or update `.sidecar.json` with the right settings for your project. Valet and the project's frontend tooling need to be installed separately. Sidecar can start the configured watcher, but whether multiple copies work at the same time depends on the project's commands, ports, and shared services. Review the config and commit it before creating a workspace; Sidecar requires a clean Git checkout.

### Review an idea and bring it back

> Review the changes in my `dark-mode` Sidecar and explain them in plain language. Show me any new files and the test results, and tell me if anything needs attention. Don't apply the changes yet.

When you're happy with the result, you can ask:

> Apply the changes from my `dark-mode` Sidecar to my main checkout, if it's safe to do so. Tell me what you applied and whether I need to do anything next.

Sidecar checks that your main checkout is clean and still at the starting commit before applying. If it has moved on, the agent can help you bring the changes over manually. Applying doesn't delete the workspace.

### Stop a workspace but keep its files

> Check the status of my `dark-mode` Sidecar, then stop its managed processes and remove its Valet link. Keep the workspace and its files so I can come back later.

The agent can use `sidecar status dark-mode` and `sidecar down dark-mode` for this. `down` doesn't delete the workspace.

### Remove a workspace when you're finished

> Check my `dark-mode` Sidecar and explain what changes and files it contains. Tell me whether there might be work I haven't kept elsewhere. Wait for me to review it before removing anything.

Once you've saved anything you want to keep, you can say:

> Permanently remove my `dark-mode` Sidecar, including its workspace files. Stop its managed processes and clean up its Valet link too.

The agent can use `sidecar diff dark-mode` for a summary and `sidecar remove dark-mode --force` to remove it. Removing a workspace deletes its files, including changes that haven't been applied elsewhere. Review them before removal; the diff summary isn't a full patch. The removal also runs configured shutdown hooks.

Want project-specific instructions for agents? Add a [project guide](configuration.md#give-people-and-agents-a-guide) that Sidecar can print for each workspace.

