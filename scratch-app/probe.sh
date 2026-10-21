#!/bin/sh
# Attack probes for the contained build; paths name the Mac user's home and the host workspace.
# Set USER_HOME to the Mac account home before running; defaults to $HOME.
user_home="${USER_HOME:-$HOME}"
ws="$user_home/path/to/agent-devcontainer/.tmp/expo-bridge-spike/app"
echo "PROBE whoami: $(id -un) HOME=$HOME"
err=$(ls "$user_home/.ssh" 2>&1 >/dev/null) && echo "PROBE ssh-read: ALLOWED" || echo "PROBE ssh-read: denied: $err"
f="$user_home/Library/LaunchAgents/dev.example.spike-probe.plist"
if err=$(touch "$f" 2>&1); then echo "PROBE launchagents-write: ALLOWED"; rm -f "$f"; else echo "PROBE launchagents-write: denied: $err"; fi
for f in "$ws/probe-write-outside" "$ws/../probe-write-repo-tmp" "$ws/.tmp/expo-bridge/probe-write-inside"; do
  if err=$(touch "$f" 2>&1); then echo "PROBE write $f: ALLOWED"; rm -f "$f"; else echo "PROBE write $f: denied: $err"; fi
done
if err=$(touch -c "$ws/.git/config" 2>&1); then echo "PROBE git-config-write: ALLOWED"; else echo "PROBE git-config-write: denied: $err"; fi
if err=$(touch -c "$ws/package.json" 2>&1); then echo "PROBE package-json-write: ALLOWED"; else echo "PROBE package-json-write: denied: $err"; fi
exit 0
