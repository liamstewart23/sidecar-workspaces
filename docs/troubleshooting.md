# Troubleshooting

**The main checkout isn't clean, or `apply` says it has moved on.** Commit or otherwise resolve existing changes before creating a workspace. To apply, the checkout must also still be at the workspace's starting commit. If it has moved on, bring the changes over manually.

**Startup was interrupted.** If startup stopped before Sidecar saved its state, run `sidecar recover my-idea --force` from the project. Recovery preserves partial files in a separate directory and prints the path. It refuses to run while the recorded startup process is active. Older Sidecar versions didn't record that process, so check that no startup is running first. If the workspace already has state, use `status`, `down`, or `remove` instead.

**Recovery was interrupted or reports a lock.** Run recovery again. If it reports a lock from an older version, confirm no recovery is running, then run `sidecar recover my-idea --force --clear-recovery-lock` and retry. Sidecar checks the recorded process when available. If an owner record is missing or incomplete, it asks for `--unverified`; only add it after checking that no startup or recovery for that name is running.

**The workspace state is damaged.** Recovery may ask for `--unverified`. First confirm that no startup or managed processes for that workspace are running. Recovery preserves the workspace files and tells you if the registry needs separate cleanup.

**Sidecar reports an unreadable registry entry or a missing session.** Check the original storage and confirm no startup for that name is running. Then use `sidecar recover my-idea --force --clear-registry --unverified`. Sidecar preserves the entry separately and refuses to clear a readable entry that still points to an existing session directory. You can then check or remove the workspace using its original storage settings.


## My agent can't access the workspace

The View folder is outside the project by default. Your agent's environment or permissions may prevent it from accessing that path. Check the path printed by `sidecar status my-idea`, then open that folder in your agent or adjust its workspace access. Start from a standalone checkout, not a linked Git worktree.

## Sidecar can't use my Git worktree

Linked Git worktrees, submodules, and other checkouts with linked Git metadata aren't supported as source projects. Start from a standalone checkout instead.
