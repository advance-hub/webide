#!/usr/bin/env bash
# 验收控制面只能访问本轮隔离的 DinD 服务。
set -euo pipefail
cd "$(dirname "$0")/.."
workspace_image=${WEBIDE_ACCEPTANCE_IMAGE:-opensumi-webide-workspace:dev}
docker image inspect "$workspace_image" >/dev/null
runtime_platform=${WEBIDE_ACCEPTANCE_PLATFORM:-$(docker image inspect "$workspace_image" --format '{{.Os}}/{{.Architecture}}')}
case "$runtime_platform" in
  linux/amd64|linux/arm64) ;;
  *) printf '验收镜像必须使用 linux/amd64 或 linux/arm64\n' >&2; exit 1 ;;
esac
docker image inspect --platform "$runtime_platform" "$workspace_image" >/dev/null
export WEBIDE_ACCEPTANCE_PLATFORM="$runtime_platform"
test -f node_modules/tsx/dist/cli.mjs
run_id=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("hex"))')
run_name="webide-acceptance-$run_id"
data_volume="$run_name-data"
private_dir=$(mktemp -d "${TMPDIR:-/tmp}/webide-sandbox.XXXXXX")
upgrade_image="opensumi-webide-workspace:acceptance-$run_id"
cleanup() {
  local status=$?
  local evidence="output/runtime-profiles/node-control-plane-20261002/$run_name"
  mkdir -p "$evidence"
  docker logs "$run_name" > "$evidence/dind.log" 2>&1 || true
  docker --context "$run_name" logs opensandbox-server > "$evidence/server.log" 2>&1 || true
  docker rm -f "$run_name" >/dev/null 2>&1 || true
  docker context rm -f "$run_name" >/dev/null 2>&1 || true
  docker volume rm "$data_volume" >/dev/null 2>&1 || true
  docker network rm "$run_name" >/dev/null 2>&1 || true
  docker image rm "$upgrade_image" >/dev/null 2>&1 || true
  rm -rf "$private_dir"
  exit "$status"
}
trap cleanup EXIT
umask 077
export WEBIDE_ACCEPTANCE_KEY
WEBIDE_ACCEPTANCE_KEY=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
server_image=sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/server:v0.2.3
execd_image=sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/execd:v1.1.0
ensure_image() {
  # 固定版本且架构匹配的本机镜像可以复用，避免验收依赖无必要的注册表请求。
  if [ "$(docker image inspect --platform "$runtime_platform" "$1" --format '{{.Os}}/{{.Architecture}}' 2>/dev/null || true)" = "$runtime_platform" ]; then
    return
  fi
  docker pull --platform "$runtime_platform" "$1"
}
ensure_image "$server_image"
ensure_image "$execd_image"
# 使用不同的测试指纹验证运行时替换与数据保留。
# 该测试不代表已完成两个正式发布版本之间的升级验收。
docker build --platform "$runtime_platform" --build-arg "BASE=$workspace_image" -t "$upgrade_image" -f - . <<'DOCKERFILE'
ARG BASE
FROM ${BASE}
RUN printf 'runtime-upgrade-acceptance-fixture\n' > /app/.runtime-fingerprint
DOCKERFILE
docker network create "$run_name" >/dev/null
docker volume create "$data_volume" >/dev/null
docker run -d --privileged --name "$run_name" --network "$run_name" \
  -e DOCKER_TLS_CERTDIR= -v "$data_volume:/var/lib/docker" \
  -p 127.0.0.1::2375 -p 127.0.0.1::30040 \
  public.ecr.aws/docker/library/docker:29.3.0-dind --tls=false >/dev/null
docker_endpoint=$(docker port "$run_name" 2375/tcp)
sandbox_endpoint=$(docker port "$run_name" 30040/tcp)
docker context create "$run_name" --docker "host=tcp://$docker_endpoint" >/dev/null
ready=0
for _attempt in $(seq 1 120); do
  if docker --context "$run_name" info >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
test "$ready" = 1
docker image save --platform "$runtime_platform" "$workspace_image" "$upgrade_image" "$server_image" "$execd_image" \
  | docker --context "$run_name" image load
cat > "$private_dir/config.toml" <<CONFIG
[server]
host="0.0.0.0"
port=30040
api_key="$WEBIDE_ACCEPTANCE_KEY"
[runtime]
type="docker"
execd_image="$execd_image"
[docker]
network_mode="bridge"
host_ip="127.0.0.1"
CONFIG
docker exec -i "$run_name" sh -c 'cat > /var/lib/docker/webide-config.toml' < "$private_dir/config.toml"
docker --context "$run_name" run -d --name opensandbox-server -p 30040:30040 \
  --platform "$runtime_platform" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /var/lib/docker/webide-config.toml:/etc/opensandbox/config.toml:ro \
  "$server_image" --config /etc/opensandbox/config.toml >/dev/null
export WEBIDE_ACCEPTANCE_URL="http://$sandbox_endpoint"
export WEBIDE_ACCEPTANCE_IMAGE="$workspace_image"
export WEBIDE_ACCEPTANCE_UPGRADE_IMAGE="$upgrade_image"
export WEBIDE_ACCEPTANCE_DOCKER_CONTEXT="$run_name"
case "${WEBIDE_ACCEPTANCE_SUITE:-control-plane}" in
  control-plane) node node_modules/tsx/dist/cli.mjs application/acceptance/opensandbox.ts ;;
  collaboration) node node_modules/tsx/dist/cli.mjs application/acceptance/collaboration.ts ;;
  *) printf '未知验收套件\n' >&2; exit 1 ;;
esac
