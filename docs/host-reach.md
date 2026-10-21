# The dev-container window already grants the container host reach

A VS Code workspace (container) extension that is **not** the bridge reaches the
Mac host through VS Code's own commands, with no consent prompt. This is the
central finding: the bridge cannot be the boundary, because the boundary is
already open to any container-side extension.

## What a container-side extension reaches

On a macOS Dev Containers window, the `attacker/` extension — an ordinary
workspace-kind extension — established:

- **Command execution on the Mac.** It ran `workbench.action.terminal.newLocal`
  then `workbench.action.terminal.sendSequence` and a marker command executed on
  the Mac: a file with its nonce appeared under the Mac's `/tmp` and was absent
  in the container's. No prompt was shown.
- **Mac clipboard read and write.** It read and overwrote the Mac clipboard
  (restoring the prior contents afterward).
- **Forwarded agents.** `VSCODE_IPC_HOOK_CLI` is present in the container and the
  remote `code` CLI answers, so a detached container process reaches it. The SSH
  agent (`SSH_AUTH_SOCK`) and the GPG agent are forwarded into the container;
  listing SSH identities from the container returned the user's keys. This is a
  dev-container-wide exposure, independent of any Expo bridge.
- **`openExternal` was gated.** Opening a URL went through a Mac consent prompt
  rather than opening silently — one of the few actions that is prompted.

## A command invocation carries no caller identity

A non-bridge extension invoked a bridge command and received the full host path
back; the handler saw only its own arguments, nothing naming the caller. After
the non-bridge extension injected a workspace folder with
`updateWorkspaceFolders`, the bridge side still resolved the window's original
`dev-container+…` authority and host path, so folder injection does not redirect
the bridge. A workspace extension holds no handle to another extension's
`SecretStorage` or `globalState`.

## Why this shapes the design

The bridge installs nothing that changes the reach above. A container-side
extension can already run code on the Mac. So the bridge is designed as a
**consent surface, not a security boundary**: it adds no reach beyond what the
window already grants, and it gates its own build action behind per-workspace
trust and a per-build confirmation. Treating it as a sandbox would be a false
assurance.

The forwarded SSH and GPG agents are the sharpest edge here, and they are not
this feature's to fix — they are a property of how the dev container is
configured. Narrowing them without breaking the workflows that rely on them is a
separate open question.
