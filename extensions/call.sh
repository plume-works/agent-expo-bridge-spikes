#!/usr/bin/env bash
# Usage: call.sh '<json request>'  — one request over the spike socket.
set -euo pipefail
printf '%s\n' "$1" | bun -e '
const net = require("net");
const req = await Bun.stdin.text();
const c = net.createConnection("/tmp/expo-bridge-spike.sock", () => c.write(req));
c.on("data", (d) => process.stdout.write(d));
c.on("error", (e) => { console.error(e.message); process.exit(2); });
'
