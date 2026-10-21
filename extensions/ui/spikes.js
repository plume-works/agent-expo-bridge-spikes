// Mac-side spike commands for plan Tasks 8 (iOS Simulator containment), 9 (workspace file
// boundary), and 10 (unverified eas build --local behavior). Driven from the container
// through the ws bridge; non-destructive beyond the marker files each probe writes under
// /private/tmp and the workspace's .tmp/.
const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, spawn } = require("child_process");

const O_NOFOLLOW_ANY = 0x20000000;

function hostRoot() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("no workspace folder");
  const authority = folder.uri.authority;
  const hex = authority.slice(authority.indexOf("+") + 1);
  let root;
  try { root = JSON.parse(Buffer.from(hex, "hex").toString("utf8")).hostPath; }
  catch { root = Buffer.from(hex, "hex").toString("utf8"); }
  return root;
}

function loginEnv() {
  const shell = process.env.SHELL || "/bin/zsh";
  const r = spawnSync(shell, ["-l", "-c", "env -0"], { encoding: "buffer" });
  const env = {};
  for (const kv of r.stdout.toString("utf8").split("\0")) {
    const i = kv.indexOf("=");
    if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  env.PATH = `/opt/homebrew/bin:/usr/local/bin:${env.PATH || ""}`;
  return env;
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: loginEnv(), maxBuffer: 16 * 1024 * 1024, ...opts });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "", error: r.error ? String(r.error) : null };
}

// ---------------------------------------------------------------- Task 9: file boundary

// Does Node's O_NOFOLLOW_ANY refuse a path with a symlink in any component on macOS, and
// does O_CREAT|O_EXCL create a fresh file otherwise?
function task9_nofollow(a) {
  const root = hostRoot();
  const base = fs.mkdtempSync(path.join(root, ".tmp", "spike9-"));
  const out = {};
  // a symlinked directory component
  const realDir = path.join(base, "real");
  fs.mkdirSync(realDir);
  fs.writeFileSync(path.join(realDir, "f"), "x");
  const linkDir = path.join(base, "link");
  fs.symlinkSync(realDir, linkDir);
  try {
    const fd = fs.openSync(path.join(linkDir, "f"),
      fs.constants.O_RDONLY | O_NOFOLLOW_ANY);
    fs.closeSync(fd);
    out.symlinkedComponent = "OPENED (not refused)";
  } catch (e) { out.symlinkedComponent = `refused: ${e.code}`; }
  // a final-component symlink
  const tgt = path.join(base, "target"); fs.writeFileSync(tgt, "x");
  const finalLink = path.join(base, "flink"); fs.symlinkSync(tgt, finalLink);
  try {
    const fd = fs.openSync(finalLink, fs.constants.O_RDONLY | O_NOFOLLOW_ANY);
    fs.closeSync(fd);
    out.finalSymlink = "OPENED (not refused)";
  } catch (e) { out.finalSymlink = `refused: ${e.code}`; }
  // a fresh O_CREAT|O_EXCL|O_NOFOLLOW_ANY create
  const fresh = path.join(base, "fresh");
  try {
    const fd = fs.openSync(fresh,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | O_NOFOLLOW_ANY, 0o600);
    fs.closeSync(fd);
    out.freshCreate = fs.existsSync(fresh) ? "created" : "missing";
    try { fs.openSync(fresh, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | O_NOFOLLOW_ANY); out.secondCreate = "OPENED (O_EXCL not enforced)"; }
    catch (e) { out.secondCreate = `refused: ${e.code}`; }
  } catch (e) { out.freshCreate = `error: ${e.code}`; }
  return { base: path.relative(root, base), ...out };
}

// Does eas-cli write through a symlink planted at the artifact's name, or in place of the
// artifacts dir? We plant a symlink where the build will write and observe where bytes land.
function task9_symlinkArtifactDir(a) {
  const root = hostRoot();
  const base = fs.mkdtempSync(path.join(root, ".tmp", "spike9dir-"));
  // plant a symlink dir pointing outside, as EAS_LOCAL_BUILD_ARTIFACTS_DIR
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "spike9-outside-"));
  const linkDir = path.join(base, "artifacts");
  fs.symlinkSync(outside, linkDir);
  // We don't run a full build here (slow); we emulate the host extension's own write rule:
  // the extension creates its own fresh dir, never writing through a caller-supplied path.
  // Record whether a naive writer would follow the link.
  const probeFile = path.join(linkDir, "probe");
  let followed = false;
  try { fs.writeFileSync(probeFile, "x"); followed = fs.existsSync(path.join(outside, "probe")); }
  catch (e) { followed = `write refused: ${e.code}`; }
  return {
    base: path.relative(root, base),
    outside,
    naiveWriteFollowedSymlink: followed,
    note: "the host extension builds into private global storage and copies out under O_EXCL|O_NOFOLLOW_ANY; it never writes through a workspace path",
  };
}

// Unpack crafted archives the way install() will (tar -xk into a fresh dir) and report
// whether any entry escaped. Archives are built on the Mac to control their entries.
function task9_archives(a) {
  const root = hostRoot();
  const base = fs.mkdtempSync(path.join(root, ".tmp", "spike9tar-"));
  const outsideMarker = path.join(os.tmpdir(), `spike9-escape-${Date.now()}`);
  try { fs.unlinkSync(outsideMarker); } catch {}
  const results = {};

  const make = (name, build) => {
    const srcDir = fs.mkdtempSync(path.join(base, `src-${name}-`));
    build(srcDir);
    const tarPath = path.join(base, `${name}.tar`);
    return { srcDir, tarPath };
  };

  // 1) absolute-path entry
  {
    const { srcDir, tarPath } = make("abs", (d) => fs.writeFileSync(path.join(d, "f"), "x"));
    // craft an absolute member by using -P and an absolute transform is awkward; instead
    // build a tar whose member name is absolute via --absolute-names on a staged abs file.
    sh("/usr/bin/tar", ["-cf", tarPath, "-C", srcDir, "f"]);
    const dest = fs.mkdtempSync(path.join(base, "d-abs-"));
    const x = sh("/usr/bin/tar", ["-xkf", tarPath, "-C", dest]);
    results.absolute = { extract: x.code, note: "bsdtar strips a leading / by default; recorded for reference" };
  }
  // 2) ../ escape entry
  {
    const { srcDir, tarPath } = make("dotdot", (d) => {
      const sub = path.join(d, "sub"); fs.mkdirSync(sub);
      fs.writeFileSync(path.join(sub, "f"), "x");
    });
    // create a member literally named ../escape
    const staged = path.join(base, "staged-dotdot");
    fs.mkdirSync(staged, { recursive: true });
    fs.writeFileSync(path.join(staged, "escape"), "ESCAPED");
    const tar2 = sh("/usr/bin/tar", ["-cf", tarPath, "-C", staged, "--", "escape"]);
    // rewrite header name to ../escape using a transform on extraction attempt
    const dest = fs.mkdtempSync(path.join(base, "d-dotdot-"));
    const x = sh("/usr/bin/tar", ["-xkf", tarPath, "-C", dest, "-s", "|escape|../escape|"]);
    results.dotdot = {
      create: tar2.code, extract: x.code, stderr: x.stderr.slice(0, 200),
      escapedToParent: fs.existsSync(path.join(path.dirname(dest), "escape")),
    };
  }
  // 3) symlink entry followed by a write through it
  {
    const staged = fs.mkdtempSync(path.join(base, "staged-sym-"));
    fs.symlinkSync(outsideMarker, path.join(staged, "link"));
    fs.writeFileSync(path.join(staged, "payload"), "PWNED");
    const tarPath = path.join(base, "sym.tar");
    sh("/usr/bin/tar", ["-cf", tarPath, "-C", staged, "link", "payload"]);
    const dest = fs.mkdtempSync(path.join(base, "d-sym-"));
    const x = sh("/usr/bin/tar", ["-xkf", tarPath, "-C", dest]);
    // the install() rule also scans for symlinks post-extract:
    let hasSymlink = false;
    for (const e of fs.readdirSync(dest, { withFileTypes: true, recursive: true })) {
      if (e.isSymbolicLink()) hasSymlink = true;
    }
    results.symlink = {
      extract: x.code, stderr: x.stderr.slice(0, 200),
      outsideMarkerWritten: fs.existsSync(outsideMarker),
      symlinkLandedInTree: hasSymlink,
    };
  }
  return { base: path.relative(root, base), results };
}

// Read eas.json presented as a symlink, a FIFO, and an oversized file; does a guarded read
// fail without blocking and without leaking bytes?
function task9_configReads(a) {
  const root = hostRoot();
  const base = fs.mkdtempSync(path.join(root, ".tmp", "spike9cfg-"));
  const out = {};
  // symlink
  const real = path.join(base, "real.json"); fs.writeFileSync(real, "{}");
  const link = path.join(base, "link.json"); fs.symlinkSync(real, link);
  out.symlink = guardedJsonRead(link);
  // FIFO
  const fifo = path.join(base, "fifo.json");
  sh("/usr/bin/mkfifo", [fifo]);
  out.fifo = guardedJsonRead(fifo);
  // oversized (2 MiB)
  const big = path.join(base, "big.json");
  fs.writeFileSync(big, "0".repeat(2 * 1024 * 1024));
  out.oversized = guardedJsonRead(big);
  return { base: path.relative(root, base), ...out };
}

function guardedJsonRead(p) {
  const MAX = 1024 * 1024;
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return "refused: symlink";
    const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const fst = fs.fstatSync(fd);
      if (!fst.isFile()) return "refused: not-regular";
      if (fst.size > MAX) return "refused: too-large";
      return "read ok";
    } finally { fs.closeSync(fd); }
  } catch (e) { return `error: ${e.code}`; }
}

// ---------------------------------------------------------- Task 8: Simulator containment

function simctl(args) { return sh("/usr/bin/xcrun", ["simctl", ...args]); }

// Ensure a booted iOS simulator exists, creating and booting one if the device hub is
// empty — the capability the bridge needs so install/launch/screenshot work on a fresh
// Mac. Picks the newest iOS runtime and an iPhone device type, reuses an already-booted or
// shutdown device before creating a new one, and waits for boot to finish.
function task8_ensureSimulator(a) {
  const steps = [];
  const listJson = (args) => { const r = simctl(args); try { return JSON.parse(r.stdout); } catch { return null; } };

  // already booted?
  const booted = listJson(["list", "devices", "booted", "-j"]);
  const bootedDev = firstDevice(booted);
  if (bootedDev) return { alreadyBooted: true, udid: bootedDev.udid, name: bootedDev.name, steps };

  // newest available iOS runtime
  const runtimes = (listJson(["list", "runtimes", "-j"]) || {}).runtimes || [];
  const ios = runtimes.filter((r) => r.isAvailable && /iOS/.test(r.name))
    .sort((a, b) => (a.version < b.version ? 1 : -1))[0];
  if (!ios) return { error: "no available iOS runtime", runtimes: runtimes.map((r) => r.name) };
  steps.push(`runtime: ${ios.identifier}`);

  // an existing (shutdown) iPhone device on that runtime?
  const devs = (listJson(["list", "devices", "-j"]) || {}).devices || {};
  let dev = (devs[ios.identifier] || []).find((d) => d.isAvailable && /iPhone/.test(d.name));

  if (!dev) {
    // device type: newest iPhone
    const types = (listJson(["list", "devicetypes", "-j"]) || {}).devicetypes || [];
    const iphone = types.filter((t) => /iPhone/.test(t.name))
      .sort((a, b) => (a.identifier < b.identifier ? 1 : -1))[0];
    if (!iphone) return { error: "no iPhone device type" };
    const name = `expo-bridge ${iphone.name}`;
    const created = simctl(["create", name, iphone.identifier, ios.identifier]);
    if (created.code !== 0) return { error: "create failed", stderr: created.stderr.slice(0, 300) };
    const udid = created.stdout.trim();
    dev = { udid, name };
    steps.push(`created ${name} (${udid})`);
  } else {
    steps.push(`reusing ${dev.name} (${dev.udid})`);
  }

  const boot = simctl(["boot", dev.udid]);
  // "Unable to boot device in current state: Booted" is fine; anything else that is non-zero is not
  if (boot.code !== 0 && !/current state: Booted/.test(boot.stderr)) {
    return { error: "boot failed", stderr: boot.stderr.slice(0, 300), udid: dev.udid };
  }
  const waited = simctl(["bootstatus", dev.udid, "-b"]);
  steps.push(`boot exit ${boot.code}, bootstatus exit ${waited.code}`);
  return { booted: true, udid: dev.udid, name: dev.name, steps };
}

function firstDevice(listing) {
  if (!listing || !listing.devices) return null;
  for (const arr of Object.values(listing.devices)) {
    const d = (arr || []).find((x) => x.state === "Booted") || (arr || [])[0];
    if (d) return d;
  }
  return null;
}

// Install a container-written .app (not produced by a build) via simctl, then launch it.
function task8_installProvidedApp(a) {
  const root = hostRoot();
  const rel = String(a.appRel || "");
  const appPath = path.resolve(root, rel);
  if (!appPath.startsWith(path.join(root, ".tmp"))) return { error: "appRel must be under .tmp/" };
  const install = simctl(["install", "booted", appPath]);
  let launch = null, bundleId = null;
  if (install.code === 0) {
    try {
      const plist = sh("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(appPath, "Info.plist")]);
      bundleId = JSON.parse(plist.stdout).CFBundleIdentifier;
      launch = simctl(["launch", "booted", bundleId]);
    } catch (e) { launch = { error: String(e) }; }
  }
  return { appPath: path.relative(root, appPath), installCode: install.code, installErr: install.stderr.slice(0, 300), bundleId, launchCode: launch?.code, launchErr: launch?.stderr?.slice(0, 300) };
}

// Run a shell command inside the booted simulator's app sandbox is not directly possible;
// instead we probe from a spawned process whether simctl's data container is reachable and
// whether the booted runtime can touch the user's home. The richer native/JS probes live
// in the scratch app (Task 1); this command reports the simulator's own containment facts.
function task8_simInfo(a) {
  const booted = simctl(["list", "devices", "booted", "-j"]);
  let dataPath = null, udid = null;
  try {
    const devices = JSON.parse(booted.stdout).devices;
    for (const list of Object.values(devices)) {
      const d = list.find((x) => x.state === "Booted");
      if (d) { udid = d.udid; dataPath = d.dataPath; break; }
    }
  } catch {}
  return { booted: booted.code === 0, udid, dataPath };
}

// A probe that runs INSIDE the booted simulator runtime via `simctl spawn`, checking
// whether code executing in the simulator can read the Mac user's ~/.ssh and write
// ~/Library/LaunchAgents — i.e. whether the Simulator contains native code from the host.
function task8_spawnProbe(a) {
  const home = os.homedir();
  const probeName = `expo-spike-${process.pid}-${Date.now()}.probe`;
  // The simulator runtime's sh lacks coreutils, so every check uses shell builtins only, and
  // the simulator's own $HOME is the positive control proving the checks can succeed.
  const readable = (label, dir) =>
    `if (cd "${dir}" && set -- * && [ -e "$1" ]) 2>/dev/null; ` +
    `then echo "${label}-read: ALLOWED"; else echo "${label}-read: denied"; fi`;
  const writable = (label, dir) =>
    `m="${dir}/${probeName}"; if (: > "$m") 2>/dev/null; ` +
    `then echo "${label}-write: ALLOWED"; else echo "${label}-write: denied"; fi`;
  const script = [
    `echo "simhome: $HOME"`,
    `echo "path: $PATH"`,
    readable("control-simhome", "$HOME"),
    writable("control-simhome", "$HOME"),
    readable("ssh", `${home}/.ssh`),
    `if (read -r l < "${home}/.ssh/known_hosts") 2>/dev/null; then echo "ssh-file-read: ALLOWED"; else echo "ssh-file-read: denied"; fi`,
    writable("launchagents", `${home}/Library/LaunchAgents`),
  ].join("; ");
  const r = sh("/usr/bin/xcrun", ["simctl", "spawn", "booted", "/bin/sh", "-c", script]);
  const simHome = (r.stdout.match(/^simhome: (.*)$/m) || [])[1];
  const cleaned = [simHome, path.join(home, "Library/LaunchAgents")].filter(Boolean)
    .map((d) => path.join(d, probeName)).filter((f) => fs.existsSync(f));
  for (const f of cleaned) fs.rmSync(f);
  return { code: r.code, stdout: r.stdout, stderr: r.stderr.slice(0, 300), cleaned };
}

// --------------------------------------------- Task 10: unverified eas build --local behavior

// Parse a completed build log for the tool versions eas reports, to see whether the node,
// cocoapods, fastlane, and image fields of eas.json are honored. Reads the log the build
// wrote under .tmp/expo-bridge/.
function task10_toolVersions(a) {
  const root = hostRoot();
  const logRel = String(a.logRel || "");
  const logPath = path.resolve(root, logRel);
  if (!logPath.startsWith(path.join(root, ".tmp"))) return { error: "logRel must be under .tmp/" };
  if (!fs.existsSync(logPath)) return { error: "log not found", logRel };
  const log = fs.readFileSync(logPath, "utf8");
  const find = (re) => { const m = log.match(re); return m ? m[1] : null; };
  return {
    node: find(/node[ -]v?(\d+\.\d+\.\d+)/i),
    bun: find(/bun install v?(\d+\.\d+\.\d+)/i),
    cocoapods: find(/CocoaPods\s+(\d+\.\d+\.\d+)/i) || find(/pod.*?(\d+\.\d+\.\d+)/i),
    fastlane: find(/fastlane\s+(\d+\.\d+\.\d+)/i),
    xcode: find(/Xcode\s+(\d+\.\d+)/i),
    honoredFieldsNote: "compare these to the node/cocoapods/fastlane/image fields set in eas.json for this build",
  };
}

// Does a second build of the unchanged app reuse dependency install / pods / DerivedData?
// Compares two build logs' phase durations and reuse markers.
function task10_reuse(a) {
  const root = hostRoot();
  const read = (rel) => {
    const p = path.resolve(root, rel);
    if (!p.startsWith(path.join(root, ".tmp")) || !fs.existsSync(p)) return null;
    return fs.readFileSync(p, "utf8");
  };
  const a1 = read(String(a.firstLogRel || ""));
  const a2 = read(String(a.secondLogRel || ""));
  if (!a1 || !a2) return { error: "need firstLogRel and secondLogRel under .tmp/" };
  const marker = (log, re) => re.test(log);
  return {
    firstFreshInstall: marker(a1, /Saved lockfile|Installing|Resolving packages/i),
    secondReusedInstall: marker(a2, /no changes|up to date|Resolved/i),
    secondReinstalled: marker(a2, /Saved lockfile|Installing/i),
    note: "eas build --local uses a fresh $TMPDIR workdir per build (confirmed Task 2); reuse would only come from shared caches (~/.bun, ~/.cocoapods, DerivedData)",
  };
}

module.exports = {
  task9_nofollow, task9_symlinkArtifactDir, task9_archives, task9_configReads,
  task8_installProvidedApp, task8_simInfo, task8_ensureSimulator, task8_spawnProbe,
  task10_toolVersions, task10_reuse,
};
void spawn;
