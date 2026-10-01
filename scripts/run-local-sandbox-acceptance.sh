#!/usr/bin/env bash
# Only the private DinD daemon is available to the acceptance control plane.
set -euo pipefail
cd "$(dirname "$0")/.."
workspace_image=${WEBIDE_ACCEPTANCE_IMAGE:-opensumi-webide-workspace:dev}
docker image inspect "$workspace_image" >/dev/null
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
docker pull --platform linux/amd64 "$server_image"
docker pull --platform linux/amd64 "$execd_image"
# A distinguishable fixture fingerprint verifies replacement and retained data.
# It is not a claim that two released application versions were tested.
docker build --platform linux/amd64 --build-arg "BASE=$workspace_image" -t "$upgrade_image" -f - . <<'DOCKERFILE'
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
docker image save "$workspace_image" "$upgrade_image" "$server_image" "$execd_image" \
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
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /var/lib/docker/webide-config.toml:/etc/opensandbox/config.toml:ro \
  "$server_image" --config /etc/opensandbox/config.toml >/dev/null
export WEBIDE_ACCEPTANCE_URL="http://$sandbox_endpoint"
export WEBIDE_ACCEPTANCE_IMAGE="$workspace_image"
export WEBIDE_ACCEPTANCE_UPGRADE_IMAGE="$upgrade_image"
export WEBIDE_ACCEPTANCE_DOCKER_CONTEXT="$run_name"
node node_modules/tsx/dist/cli.mjs application/server/remote.acceptance.ts
