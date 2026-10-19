#!/usr/bin/env bash
# Install user-local tools only. Docker Engine needs a host capable of running it.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .tools/bin .cache/tool-downloads
export PATH="$PWD/.tools/bin:$PATH"
case "$(uname -m)" in
  x86_64) tool_arch=amd64; node_arch=x64 ;;
  aarch64) tool_arch=arm64; node_arch=arm64 ;;
  *) echo 'Unsupported architecture' >&2; exit 1 ;;
esac
fetch_file() { curl --fail --location --silent --show-error --connect-timeout 10 --max-time 45 "$1" -o "$2"; }
verify_file() {
  local actual
  actual=$(sha256sum "$2")
  [[ ${actual%% *} == "$1" ]] || { echo "Checksum mismatch: $2" >&2; exit 1; }
}
if ! command -v node >/dev/null || [[ $(node -p 'Number(process.versions.node.split(".")[0])') -lt 24 ]]; then
  fetch_file https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt .cache/tool-downloads/node-shasums
  node_archive=$(awk -v suffix="linux-${node_arch}.tar.xz" '$2 ~ suffix "$" {print $2; exit}' .cache/tool-downloads/node-shasums)
  [[ -n "$node_archive" ]] || { echo 'No Node 24 archive found' >&2; exit 1; }
  fetch_file "https://nodejs.org/dist/latest-v24.x/$node_archive" ".cache/tool-downloads/$node_archive"
  node_checksum=$(awk -v archive="$node_archive" '$2 == archive {print $1}' .cache/tool-downloads/node-shasums)
  verify_file "$node_checksum" ".cache/tool-downloads/$node_archive"
  tar -xJf ".cache/tool-downloads/$node_archive" -C .tools
  cp -R ".tools/${node_archive%.tar.xz}/." .tools/
fi
fetch_file https://api.github.com/repos/helm/helm/releases/latest .cache/tool-downloads/helm-release.json
helm_version=$(python3 -c 'import json; print(json.load(open(".cache/tool-downloads/helm-release.json"))["tag_name"])')
helm_archive="helm-${helm_version}-linux-${tool_arch}.tar.gz"
fetch_file "https://get.helm.sh/$helm_archive" ".cache/tool-downloads/$helm_archive"
fetch_file "https://get.helm.sh/$helm_archive.sha256sum" .cache/tool-downloads/helm-sha256
verify_file "$(awk '{print $1}' .cache/tool-downloads/helm-sha256)" ".cache/tool-downloads/$helm_archive"
tar -xzf ".cache/tool-downloads/$helm_archive" -C .cache/tool-downloads
install -m 755 ".cache/tool-downloads/linux-${tool_arch}/helm" .tools/bin/helm
fetch_file https://api.github.com/repos/k3d-io/k3d/releases/latest .cache/tool-downloads/k3d-release.json
read -r k3d_url k3d_digest < <(python3 - "$tool_arch" <<'PY'
import json, sys
release = json.load(open('.cache/tool-downloads/k3d-release.json'))
asset = next(a for a in release['assets'] if a['name'] == 'k3d-linux-' + sys.argv[1])
digest = asset.get('digest') or ''
if not digest.startswith('sha256:'):
    raise SystemExit('Release asset has no SHA-256 digest; verify the official release before installing')
print(asset['browser_download_url'], digest.removeprefix('sha256:'))
PY
)
fetch_file "$k3d_url" .cache/tool-downloads/k3d
verify_file "$k3d_digest" .cache/tool-downloads/k3d
install -m 755 .cache/tool-downloads/k3d .tools/bin/k3d
# Match the default k3s minor instead of combining the newest kubectl with an
# older k3d default. Override when selecting a different cluster image.
kube_version=${URUMI_KUBECTL_VERSION:-}
if [[ -z "$kube_version" ]]; then
  kube_minor=$(k3d version | sed -n 's/^k3s version v\([0-9]*\.[0-9]*\).*/\1/p')
  [[ -n "$kube_minor" ]] || { echo 'Cannot determine k3d Kubernetes version' >&2; exit 1; }
  fetch_file "https://dl.k8s.io/release/stable-${kube_minor}.txt" .cache/tool-downloads/kubernetes-version
  kube_version=$(cat .cache/tool-downloads/kubernetes-version)
fi
[[ "$kube_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid kubectl version' >&2; exit 1; }
fetch_file "https://dl.k8s.io/release/${kube_version}/bin/linux/${tool_arch}/kubectl" .cache/tool-downloads/kubectl
fetch_file "https://dl.k8s.io/release/${kube_version}/bin/linux/${tool_arch}/kubectl.sha256" .cache/tool-downloads/kubectl.sha256
verify_file "$(tr -d '\n' < .cache/tool-downloads/kubectl.sha256)" .cache/tool-downloads/kubectl
install -m 755 .cache/tool-downloads/kubectl .tools/bin/kubectl
echo 'Installed local CLI tools. Add .tools/bin to PATH, then run scripts/install-dependencies.sh.'
if ! command -v docker >/dev/null; then
  echo 'Docker Engine is still required on a host that permits a container daemon. This script does not run sudo.'
fi
