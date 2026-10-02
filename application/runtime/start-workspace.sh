#!/bin/sh
set -eu
root=${WORKSPACE_ROOT:-/workspace}
port=${PORT:-4317}
mkdir -p "${root}/home/.m2" "${root}/.platform" /workspace/home/.m2/repository
if [ "$root" != /workspace ] && [ ! -e "$root/home/.m2/repository" ]; then
  ln -s /workspace/home/.m2/repository "$root/home/.m2/repository"
fi

# flock 串行处理并发启动和重连请求；进程结束后内核自动
# 释放文件锁，陈旧 PID 不会阻塞恢复。
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
# IDE 服务目录由运行环境确定，服务端向客户端声明
# WORKSPACE_DIR，防止伪造的 workspaceDir 查询参数
# 将运行时指向其他目录；WORKSPACE_ID 在创建开发机时
# 由控制面提供，用于拒绝代理到错误工作区的请求。
export MY_WORKSPACE=${root}/project
export WORKSPACE_DIR=${root}/project
if [ -z "${WORKSPACE_ID:-}" ] && [ -r "${root}/.platform/workspace-id" ]; then
  WORKSPACE_ID=$(cat "${root}/.platform/workspace-id")
  export WORKSPACE_ID
fi
export JAVA_HOME=/opt/java/openjdk
if [ -f /opt/opensumi/bin/toolchain.cjs ]; then JAVA_HOME=$(node /opt/opensumi/bin/toolchain.cjs "$root"); export JAVA_HOME; fi
export MAVEN_HOME=/opt/maven
export PATH="/opt/opensumi/bin:$JAVA_HOME/bin:$MAVEN_HOME/bin:$PATH"
export MAVEN_OPTS="${MAVEN_OPTS:--Xmx256m}"
export NODE_ENV=production
export OPENSUMI_RUNTIME_MODE=${OPENSUMI_RUNTIME_MODE:-node}
export OPENSUMI_EXTENSION_DIR=${root}/.sumi/extensions
# 预先生成内置扩展清单，扫描器只需读取一个 JSON，避免为
# 每个扩展目录分别读取状态和配置，尤其是多语言配置。
export OPENSUMI_BUILTIN_EXTENSION_DIR=/app/tools/extensions
export OPENSUMI_BUILTIN_EXTENSION_MANIFEST=/app/builtin-extensions.manifest.json
test -s "$OPENSUMI_BUILTIN_EXTENSION_MANIFEST"
export MAX_EXTENSION_HOSTS=5
export MAX_MANAGED_EXTENSION_PROCESSES=5
# 本机模拟镜像中，扩展宿主冷启动可能超过 15 秒。
# 保留有上限的启动时限，避免连续重连和重启。
export EXTENSION_HOST_STARTUP_TIMEOUT="${EXTENSION_HOST_STARTUP_TIMEOUT:-60000}"
export ENABLE_COLLABORATION=1
export COLLABORATION_TRANSPORT=shared
export ENABLE_AI=1
export PORT="$port"
# 文件锁防止重复启动；关闭后仍驻留的进程不能作为健康 IDE 使用，
# 先停止确认归属的子进程，再启动替代进程。
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
