const vscode = require("vscode");
const net = require("net");
const fs = require("fs");

const SOCK = "/tmp/expo-bridge-spike.sock";

// One-shot setup helper: open a local (Mac) terminal and run a command string. Used only
// to install the ui spike VSIX onto the Mac host and reload, a step the user authorized.
async function runOnMac(text) {
  await vscode.commands.executeCommand("workbench.action.terminal.newLocal");
  await new Promise((r) => setTimeout(r, 1500));
  await vscode.commands.executeCommand("workbench.action.terminal.sendSequence", { text: text + "\r" });
}

exports.activate = (ctx) => {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("expoBridgeSpike.ws.installUiOnMac", async (a) => {
      await runOnMac(String(a?.cmd ?? ""));
      return { sent: true };
    }),
  );
  try { fs.unlinkSync(SOCK); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let req;
      try { req = JSON.parse(buf.slice(0, nl)); } catch (e) {
        conn.end(JSON.stringify({ ok: false, error: `bad request: ${e.message}` }) + "\n");
        return;
      }
      const cmd = req.action && req.action.startsWith("ws.")
        ? `expoBridgeSpike.${req.action}`
        : `expoBridgeSpike.ui.${req.action}`;
      vscode.commands.executeCommand(cmd, req.args ?? {}).then(
        (result) => conn.end(JSON.stringify({ ok: true, result }) + "\n"),
        (e) => conn.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }) + "\n"),
      );
    });
  });
  server.listen(SOCK);
  ctx.subscriptions.push({ dispose: () => server.close() });
};
exports.deactivate = () => {};
