#!/bin/sh
set -eu
root=${WORKSPACE_ROOT:-/workspace}
port=${PORT:-4317}
mkdir -p "${root}/home/.m2" "${root}/.platform" /workspace/home/.m2/repository
if [ "$root" != /workspace ] && [ ! -e "$root/home/.m2/repository" ]; then
  ln -s /workspace/home/.m2/repository "$root/home/.m2/repository"
fi

# flock covers concurrent launch/reconnect requests. File locks are released
# by the kernel after termination, so a stale PID cannot block recovery.
exec 9>${root}/.platform/ide-start.lock
flock -x 9
if [ -f /opt/opensumi/bin/personal-settings.cjs ]; then node /opt/opensumi/bin/personal-settings.cjs "$root"; fi
if [ -f /opt/opensumi/default-settings.json ]; then
  node /opt/opensumi/bin/ensure-default-settings.cjs ${root}/home/.sumi/settings.json /opt/opensumi/default-settings.json
fi
if [ -f /opt/opensumi/opencode.json ]; then
  node /opt/opensumi/bin/ensure-default-settings.cjs ${root}/home/.config/opencode/opencode.json /opt/opensumi/opencode.json
fi
if [ -d /opt/opensumi/opencode-config/node_modules ] && [ ! -e ${root}/home/.config/opencode/package.json ]; then
  cp -a /opt/opensumi/opencode-config/. ${root}/home/.config/opencode/
fi
if [ -f /opt/opensumi/default-zshrc ] && [ ! -e ${root}/home/.zshrc ]; then
  cp /opt/opensumi/default-zshrc ${root}/home/.zshrc
fi
if curl --silent --fail http://127.0.0.1:${port}/health >/dev/null; then
  exit 0
fi

cd /app
export HOME=${root}/home
if command -v zsh >/dev/null; then export SHELL="$(command -v zsh)"; else export SHELL=/bin/bash; fi
# The workspace the IDE serves is decided here, not by the browser. The server
# declares WORKSPACE_DIR to the client, so a crafted ?workspaceDir= cannot point
# the runtime at another directory. WORKSPACE_ID comes from the control plane at
# provision time and lets the IDE reject a request proxied for another workspace.
export MY_WORKSPACE=${root}/project
export WORKSPACE_DIR=${root}/project
if [ -z "${WORKSPACE_ID:-}" ] && [ -r "${root}/.platform/workspace-id" ]; then
  WORKSPACE_ID=$(cat "${root}/.platform/workspace-id")
  export WORKSPACE_ID
fi
export JAVA_HOME=/opt/java/openjdk
if [ -f /opt/opensumi/bin/toolchain.cjs ]; then JAVA_HOME=$(node /opt/opensumi/bin/toolchain.cjs "$root"); export JAVA_HOME; fi
export MAVEN_HOME=/opt/maven
export PATH="/opt/opensumi/bin:$JAVA_HOME/bin:$MAVEN_HOME/bin:/usr/local/go/bin:/opt/go-tools/bin:$PATH"
export MAVEN_OPTS="${MAVEN_OPTS:--Xmx256m}"
export NODE_ENV=production
export OPENSUMI_RUNTIME_MODE=${OPENSUMI_RUNTIME_MODE:-node}
export OPENSUMI_EXTENSION_DIR=${root}/.sumi/extensions
# Pre-built manifest for tools/extensions: the scanner reads one JSON instead
# of stat+readJSON per extension directory (~75 packages x 18 locales).
export OPENSUMI_BUILTIN_EXTENSION_DIR=/app/tools/extensions
export OPENSUMI_BUILTIN_EXTENSION_MANIFEST=/app/builtin-extensions.manifest.json
test -s "$OPENSUMI_BUILTIN_EXTENSION_MANIFEST"
export MAX_EXTENSION_HOSTS=3
export MAX_MANAGED_EXTENSION_PROCESSES=3
# Cold extension-host imports on local emulated images can exceed 15 seconds.
# Keep a bounded startup deadline without triggering a reconnect/restart loop.
export EXTENSION_HOST_STARTUP_TIMEOUT="${EXTENSION_HOST_STARTUP_TIMEOUT:-60000}"
export ENABLE_COLLABORATION=0
export ENABLE_AI=1
export PORT="$port"
# The lock excludes another startup. A process left after shutdown is not a
# healthy IDE: stop its owned descendants before starting a replacement.
node /opt/opensumi/bin/stop-ide.cjs "$root"
nohup node --max-old-space-size=512 server/dist/main.js >> ${root}/.platform/ide.log 2>&1 < /dev/null 9>&- &
printf '%s\n' "$!" > ${root}/.platform/ide.pid

attempt=0
while [ "$attempt" -lt 60 ]; do
  if curl --silent --fail http://127.0.0.1:${port}/health >/dev/null; then exit 0; fi
  if ! kill -0 "$(cat ${root}/.platform/ide.pid)" 2>/dev/null; then exit 1; fi
  attempt=$((attempt + 1))
  sleep 1
done
exit 1
