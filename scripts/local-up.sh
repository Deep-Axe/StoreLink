#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .data
export KUBECONFIG="$PWD/.data/kubeconfig"
URUMI_KUBECTL="$(node scripts/resolve-kubectl.ts)"
export URUMI_KUBECTL
command -v "$URUMI_KUBECTL" >/dev/null || { echo "kubectl is unavailable: $URUMI_KUBECTL" >&2; exit 1; }
if ! k3d cluster list -o json | python3 -c 'import json,sys;sys.exit(not any(c["name"]=="urumi" for c in json.load(sys.stdin)))'; then
  k3d cluster create urumi --servers 1 --agents 0 --servers-memory 4096m \
    --api-port 127.0.0.1:6550 --port '127.0.0.1:80:80@loadbalancer' --port '127.0.0.1:443:443@loadbalancer' \
    --kubeconfig-update-default=false --kubeconfig-switch-context=false --wait --timeout 180s
fi
k3d kubeconfig get urumi > "$KUBECONFIG"
chmod 600 "$KUBECONFIG"
node scripts/prepare-cluster-secrets.ts
image_tag="dev-$(date +%s)"
app_image="urumi-app:$image_tag"
store_image="urumi-wordpress:$image_tag"
docker build -f images/app/Dockerfile -t "$app_image" .
docker build -f images/store/Dockerfile --build-arg WOOCOMMERCE_SHA256=5317434cb381b5fdc7c1dd6ee258324f08c390976aaf8d1199f2a0e9a3ab8586 -t "$store_image" .
k3d image import "$app_image" "$store_image" -c urumi
helm lint charts/urumi -f charts/urumi/values-local.yaml
chat_enabled="$(node -e 'const data=JSON.parse(require("fs").readFileSync(".data/cluster-secrets.json","utf8"));process.stdout.write(data["openai-api-key"]?"true":"false")')"
helm upgrade --install urumi charts/urumi -n urumi -f charts/urumi/values-local.yaml --set "chat.enabled=$chat_enabled" --set-string "images.app=$app_image" --set-string "images.store=$store_image" --wait --timeout 10m
"$URUMI_KUBECTL" -n urumi wait --for=condition=complete jobs -l urumi/component=store-bootstrap --timeout=120s
echo 'Store: http://store.urumi.localhost  MCP gateway: http://dashboard.urumi.localhost/mcp'
