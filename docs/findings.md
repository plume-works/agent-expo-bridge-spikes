# Findings

What the spikes established, as durable facts. Each is reproducible with the
probe commands in `extensions/` against a Mac host with Xcode and a dev
container window open on it.

## The iOS Simulator is not a containment boundary

A process the booted iOS Simulator runs (`xcrun simctl spawn booted /bin/sh`)
runs as the Mac user with the Mac user's file access. It can list the user's
`~/.ssh`, read files there, and create files under `~/Library/LaunchAgents`
(where a file can make a program start at every login). The Simulator's own data
directory serves as the positive control: when access to it succeeds and access
to a home-directory path is what's in question, an "allowed" result is real, not
a missing-tool artifact. The Simulator runtime's shell carries no standard
command-line tools, so a probe must use shell built-ins only.

**Consequence for the bridge:** whatever native code gets installed and launched
on the Simulator runs with the Mac user's full file access, including
persistence through LaunchAgents. Installing and launching an app on the
Simulator is therefore as trusted as running that code on the Mac directly.

## Installing an app on the Simulator needs a booted device, and trusts the app

An `.app` placed under the workspace by the container — not necessarily produced
by a build — installs on a booted Simulator through `xcrun simctl install` and
launches through `xcrun simctl launch`, with its bundle id read from its
`Info.plist`. Nothing in the Simulator path verifies that an `.app` came from a
trusted build.

`install`, `launch`, and `screenshot` all require a booted Simulator; with none
booted, `simctl` fails with `No devices are booted`. A bridge must therefore be
able to provision one itself: pick the newest available iOS runtime and an
iPhone device type, reuse an already-booted or shutdown device before creating a
new one (`simctl create`), boot it (`simctl boot`), and wait for boot to finish
(`simctl bootstatus -b`).

## The macOS file primitives behave as the write/read rules assume

- `O_NOFOLLOW_ANY` (`0x20000000`) in Node's `fs.open` refuses a path with a
  symlink in **any** component — both a symlinked directory component and a
  final-component symlink fail with `ELOOP`.
  `O_CREAT | O_EXCL | O_NOFOLLOW_ANY` creates a fresh file, and a second create
  of the same path fails with `EEXIST`. This is the behavior a safe host-side
  write rule relies on.
- Unpacking a crafted archive with `tar -xk` into a fresh directory: a `../`
  entry is rejected (`Path contains '..'`), an absolute entry has its leading
  `/` stripped by bsdtar, and a symlink entry lands in the tree but a write
  through it does not reach outside. A post-extract symlink scan catches the
  planted symlink, so an installer can reject the artifact.
- Reading a config file presented as a symlink, a FIFO, or an oversized file:
  each is refused (symlink, not-regular, too-large) without blocking and without
  returning file bytes. An `O_NONBLOCK` open is what keeps the FIFO read from
  hanging.

## `eas build --local` does not pin tool versions through `eas.json`

eas-cli 25.3.0 rejects `cocoapods`, `fastlane`, and `image` as
`build.<profile>` keys at schema validation. `node` is accepted but not honored:
a build with `"node"` pinned warns that the `eas.json` Node.js version does not
match the installed one and builds with the Mac's own Node. A bridge that needs
tool versions must probe `node`, `pod`, and `fastlane` on the Mac directly.

Each `eas build --local` runs in a fresh working directory under the system
temporary directory and reinstalls everything — two builds of the unchanged app
each installed all 443 packages and all 103 pods. The only reuse is from the
Mac's shared caches (bun's package cache, CocoaPods' cache), which makes the
repeat install faster but not skipped.

## A sandboxed build fails on nested sandboxing

Running the Expo SDK 58 simulator build under `sandbox-exec` fails in the
`ExpoModulesJSI` pod's xcframework script phase: that phase runs `xcodebuild`,
which resolves Swift packages, and SwiftPM itself sandboxes manifest evaluation
with `sandbox-exec`. macOS does not apply a sandbox inside another, so the
nested call fails with `sandbox_apply: Operation not permitted`. No profile
change fixes it, and the override that disables the inner sandbox cannot be
scoped to one build: the nested `xcodebuild` is launched with a scrubbed
environment, and Xcode puts its own tool directories ahead of the script
phase's `PATH`, so neither an environment variable nor a `PATH` shim reaches it.
