const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

function hostPath() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("no workspace folder");
  const authority = folder.uri.authority;
  const hex = authority.slice(authority.indexOf("+") + 1);
  const decoded = Buffer.from(hex, "hex").toString("utf8");
  let root;
  try { root = JSON.parse(decoded).hostPath; } catch { root = decoded; }
  return { folderUri: folder.uri.toString(), authority, decoded, root };
}

function resolveUnder(root, rel) {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`path escapes workspace: ${rel}`);
  return abs;
}

async function hostInfo(args) {
  const hp = hostPath();
  const info = {
    platform: process.platform, arch: process.arch, hostname: os.hostname(),
    remoteName: vscode.env.remoteName, ...hp, rootExists: !!hp.root && fs.existsSync(hp.root),
  };
  if (args.nonceRel) {
    const p = resolveUnder(hp.root, args.nonceRel);
    info.nonceRead = fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : null;
  }
  return info;
}

// The login shell may be fish, so it only reports the environment; scripts run under /bin/sh.
function loginEnv() {
  const shell = process.env.SHELL || "/bin/zsh";
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ["-l", "-c", "env -0"], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${shell} -l exited ${code}`));
      const env = {};
      for (const kv of out.split("\0")) {
        const i = kv.indexOf("=");
        if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
      }
      resolve(env);
    });
  });
}

async function runScript(cwd, script, logPath, extraEnv = {}, sandbox = null) {
  const log = fs.openSync(logPath, "w");
  const argv = sandbox ? ["/usr/bin/sandbox-exec", ...sandbox, "/bin/sh", "-c", script] : ["/bin/sh", "-c", script];
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env: { ...(await loginEnv()), ...extraEnv },
    stdio: ["ignore", log, log],
  });
  const exitCode = await new Promise((res) => child.on("close", res));
  fs.closeSync(log);
  return exitCode;
}

async function envSetup() {
  const { root } = hostPath();
  const project = resolveUnder(root, ".tmp/expo-bridge-spike/app");
  const outDir = resolveUnder(root, ".tmp/expo-bridge");
  fs.mkdirSync(outDir, { recursive: true });
  const create = (name, value, visibility) =>
    `npx --yes eas-cli@latest env:create --name ${name} --value ${value} --visibility ${visibility} --environment development --scope project --non-interactive --force`;
  const script = [
    "set -x",
    create("SPIKE_PLAIN", "plain-ok", "plaintext"),
    create("SPIKE_SECRET_A", "from-eas", "secret"),
    create("SPIKE_SECRET_B", "from-eas", "secret"),
  ].join(" && ");
  const logPath = path.join(outDir, "env-setup.log");
  return { exitCode: await runScript(project, script, logPath), log: path.relative(root, logPath) };
}

async function build(args) {
  const { root } = hostPath();
  const project = resolveUnder(root, args.projectRel);
  const outDir = resolveUnder(root, args.outRel);
  fs.mkdirSync(outDir, { recursive: true });
  const logPath = path.join(outDir, "build.log");
  const profile = String(args.profile);
  if (!/^[A-Za-z0-9_-]+$/.test(profile)) throw new Error(`bad profile: ${profile}`);
  const script = [
    "set -x",
    "command -v bun node npx xcodebuild pod fastlane || true",
    "bun --version || true",
    `EAS="npx --yes eas-cli@latest"`,
    `if ! grep -q projectId app.json; then $EAS init --non-interactive --force; fi`,
    `exec $EAS build --local --non-interactive -p ios --profile ${profile}`,
  ].join("\n");
  const varFolders = path.dirname(fs.realpathSync(os.tmpdir()));
  const sandbox = args.sandbox
    ? ["-f", path.join(extensionPath, "sandbox.sb"), "-D", `HOME=${os.homedir()}`,
       "-D", `VAR_FOLDERS=${varFolders}`, "-D", `OUT_DIR=${fs.realpathSync(outDir)}`]
    : null;
  const xcodeDefaultsHash = () => {
    const r = require("child_process").spawnSync("/usr/bin/defaults", ["read", "com.apple.dt.Xcode"]);
    return require("crypto").createHash("sha256").update(r.stdout || "").digest("hex");
  };
  const defaultsBefore = xcodeDefaultsHash();
  let shimEnv = {};
  if (args.innerSandboxOff) {
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "expo-bridge-shim-"));
    const shimLog = path.join(outDir, "xcodebuild-shim.log");
    fs.writeFileSync(shimLog, "");
    fs.writeFileSync(path.join(shimDir, "xcodebuild"),
      `#!/bin/sh\necho "$(date +%T) $*" >> '${shimLog}'\nexec /usr/bin/xcodebuild -IDEPackageSupportDisableManifestSandbox=YES "$@"\n`,
      { mode: 0o755 });
    const xcconfig = path.join(shimDir, "bridge.xcconfig");
    fs.writeFileSync(xcconfig, `PATH = ${shimDir}:$(inherited)\n`);
    shimEnv = { PATH: `${shimDir}:${(await loginEnv()).PATH}`, XCODE_XCCONFIG_FILE: xcconfig };
  }
  const exitCode = await runScript(project, script, logPath, {
    ...shimEnv,
    EAS_LOCAL_BUILD_ARTIFACTS_DIR: outDir,
    CI: "1",
    SPIKE_SECRET_B: "from-host",
    ...(args.noVcs ? { EAS_NO_VCS: "1" } : {}),
    ...(args.keepWorkdir
      ? { EAS_LOCAL_BUILD_WORKINGDIR: path.join(outDir, "work"), EAS_LOCAL_BUILD_SKIP_CLEANUP: "1" }
      : {}),
  }, sandbox);
  return {
    exitCode,
    xcodeDefaultsUnchanged: xcodeDefaultsHash() === defaultsBefore,
    log: path.relative(root, logPath),
    artifacts: fs.readdirSync(outDir).filter((f) => f !== "build.log").map((f) => path.relative(root, path.join(outDir, f))),
  };
}

async function readMacTmp(a) {
  const f = "/tmp/" + String(a.name).replace(/[^A-Za-z0-9._-]/g, "");
  return { path: f, exists: fs.existsSync(f), content: fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null };
}

let extensionPath;

const spikes = require("./spikes");

exports.activate = (ctx) => {
  extensionPath = ctx.extensionPath;
  ctx.subscriptions.push(
    vscode.commands.registerCommand("expoBridgeSpike.ui.hostInfo", (a) => hostInfo(a ?? {})),
    vscode.commands.registerCommand("expoBridgeSpike.ui.readMacTmp", (a) => readMacTmp(a ?? {})),
    vscode.commands.registerCommand("expoBridgeSpike.ui.build", (a) => build(a ?? {})),
    vscode.commands.registerCommand("expoBridgeSpike.ui.envSetup", () => envSetup()),
  );
  for (const [name, fn] of Object.entries(spikes)) {
    ctx.subscriptions.push(
      vscode.commands.registerCommand(`expoBridgeSpike.ui.${name}`, (a) => fn(a ?? {})),
    );
  }
};
exports.deactivate = () => {};
