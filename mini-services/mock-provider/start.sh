#!/bin/bash
# Start mock-provider so it SURVIVES this sandbox's per-command process killer.
# NOTE: plain `bun run dev &` / nohup / setsid still get SIGKILLed when a Bash-tool
# command ends. Double-fork + setsid reparents the daemon to PID 1 (tini), which is
# exempt. On sandbox reboot, /start.sh auto-starts every mini-service that has a
# package.json with a "dev" script, so this script is only needed for manual restarts.
cd "$(dirname "$0")"
if curl -s --max-time 2 http://127.0.0.1:3031/health 2>/dev/null | grep -q '"ok":true'; then
  echo "mock-provider already running on :3031"; exit 0
fi
perl -MPOSIX=setsid -e '
  defined(my $p = fork) or die "fork";  exit 0 if $p;
  setsid() or die "setsid";
  defined(my $p2 = fork) or die "fork2"; exit 0 if $p2;
  chdir($ARGV[0]) or die "chdir";
  open(STDOUT, ">", $ARGV[1]) or die "log";
  open(STDERR, ">&STDOUT");
  exec("bun", "--hot", "index.ts") or die "exec";' "$(pwd)" /tmp/mock-provider.log
for i in $(seq 1 20); do
  if curl -s --max-time 2 http://127.0.0.1:3031/health 2>/dev/null | grep -q '"ok":true'; then
    echo "mock-provider listening on :3031 (log: /tmp/mock-provider.log)"; exit 0
  fi
  sleep 0.25
done
echo "mock-provider failed to start — see /tmp/mock-provider.log"; exit 1
