# agent-expo-bridge-spikes

Throwaway spike code from a security investigation into a **VS Code Expo
bridge**: a proposed pair of VS Code extensions that would let an agent working
inside a Mac-hosted dev container build, install, launch, and screenshot an Expo
iOS app on the Mac host through a fixed, Expo-only action set.

Before committing to that design, we needed to know what a dev container can
already reach on its Mac host through VS Code, and whether the iOS Simulator and
the macOS file primitives behave the way the design assumed. This repo holds the
disposable extensions and the scratch Expo app used to answer those questions,
plus the findings.

**This is not production code and not the bridge itself.** It is instrumentation
built to probe specific questions, kept so the measurements are reproducible.
The publisher ids, bundle id, and EAS project id have been replaced with
`example` placeholders; set `USER_HOME` before running `scratch-app/probe.sh`.

## Layout

```
extensions/
  ui/          a ui-kind (Mac-local) extension exposing probe commands; spikes.js
               holds the Task 8/9/10 probes. call.sh drives it over a unix socket.
  ws/          a workspace-kind (container) extension that forwards socket
               requests to the ui side — the test harness bridge.
  attacker/    a workspace-kind extension that probes what a NON-bridge container
               extension can reach through VS Code's own commands (Task 6/7).
scratch-app/   a minimal Expo SDK 58 app (dev-client) used as the build/install
               target; probe.sh runs as a postinstall attack probe.
docs/
  findings.md              what the spikes established, as durable facts.
  host-reach.md            the dev-container → Mac-host reach finding (Task 6/7).
```

## Findings in one line

The dev-container boundary and the iOS Simulator are **consent surfaces, not
security boundaries**: a container-side VS Code extension already reaches the
Mac host, and code the Simulator runs has the Mac user's full file access. The
bridge adds no new reach — so it is designed as a consent surface with
per-workspace trust and a per-build confirmation, not as a sandbox. See
[docs/findings.md](docs/findings.md) and [docs/host-reach.md](docs/host-reach.md).

## Running a probe

The `ws` extension listens on a unix socket and forwards `{action, args}` to the
matching `ui` command. With both extensions installed in a Mac-hosted dev
container window:

```bash
extensions/call.sh '{"action":"task8_ensureSimulator"}'
extensions/call.sh '{"action":"task9_nofollow"}'
```

Everything the probes write is confined to `/private/tmp` markers and the
workspace's `.tmp/`, and is cleaned up.
