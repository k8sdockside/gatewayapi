#!/usr/bin/env bash
# A kind cluster with the Gateway API, Envoy Gateway and a demo that puts every
# state the plugin draws on screen. See dev/README.md.
#
#   dev/up.sh            create (or reuse) the cluster and apply everything
#   dev/down.sh          delete it again
#
# Every kubectl and helm call names the kind context explicitly, so whatever
# cluster your kubeconfig was pointing at is never touched -- and kind's habit
# of switching the current context to the new cluster is undone at the end.

set -euo pipefail

CLUSTER="${CLUSTER:-gatewayapi-demo}"
CTX="kind-${CLUSTER}"
# Envoy Gateway v1.9.1 is built against Gateway API v1.6.1 (see its
# compatibility matrix), and its CRD chart installs exactly that bundle.
EG_VERSION="${EG_VERSION:-v1.9.1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "needs $1 on the PATH" >&2; exit 1; }; }
k() { kubectl --context "$CTX" "$@"; }

for tool in kind kubectl helm openssl docker; do need "$tool"; done

previous="$(kubectl config current-context 2>/dev/null || true)"

say "kind cluster ${CLUSTER}"
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
    echo "already there, reusing it"
else
    kind create cluster --name "$CLUSTER" --wait 120s
fi
if [ -n "$previous" ] && [ "$previous" != "$CTX" ]; then
    kubectl config use-context "$previous" >/dev/null
    echo "current context left at ${previous}; the demo is ${CTX}"
fi

say "Gateway API CRDs (experimental channel, which includes the standard one) and Envoy Gateway's own CRDs"
# helm template piped into a server-side apply is how Envoy Gateway's docs
# install the CRDs on their own: the CRDs are too large for a client-side
# apply's last-applied annotation.
helm template eg-crds oci://docker.io/envoyproxy/gateway-crds-helm \
    --version "$EG_VERSION" \
    --set crds.gatewayAPI.enabled=true \
    --set crds.gatewayAPI.channel=experimental \
    --set crds.envoyGateway.enabled=true \
    | k apply --server-side --force-conflicts -f -

say "Envoy Gateway ${EG_VERSION}"
helm upgrade --install eg oci://docker.io/envoyproxy/gateway-helm \
    --kube-context "$CTX" \
    --version "$EG_VERSION" \
    -n envoy-gateway-system --create-namespace \
    --set crds.enabled=false
k wait --timeout=5m -n envoy-gateway-system deployment/envoy-gateway --for=condition=Available

say "Gateways"
k apply -f "$HERE/manifests/00-gateways.yaml"

say "Self-signed certificates for the HTTPS listeners"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cert() {
    local name="$1" host="$2"
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
        -keyout "$tmp/$name.key" -out "$tmp/$name.crt" \
        -subj "/CN=${host}" -addext "subjectAltName=DNS:${host}" 2>/dev/null
    k -n infra create secret tls "$name" --cert "$tmp/$name.crt" --key "$tmp/$name.key" \
        --dry-run=client -o yaml | k apply -f -
}
cert shop-tls shop.example.com
cert apps-tls '*.apps.example.com'

say "Workloads, routes and the ListenerSet"
k apply -f "$HERE/manifests/10-apps.yaml"
k apply -f "$HERE/manifests/20-routes.yaml"
k apply -f "$HERE/manifests/30-listenerset.yaml" || echo "the ListenerSet was refused; everything else is in place"

say "Waiting for the workloads"
for ns in shop payments billing team-blog infra; do
    k -n "$ns" wait --timeout=3m deployment --all --for=condition=Available >/dev/null
done
k -n infra wait --timeout=3m gateway/public --for=condition=Programmed >/dev/null || true

say "Done"
cat <<EOF
The demo is in context ${CTX}. In K8s Dockside, open that context and then
Plugins -> Gateway API.

To send real requests through the public Gateway:

  svc=\$(kubectl --context ${CTX} -n envoy-gateway-system get svc \\
      -l gateway.envoyproxy.io/owning-gateway-name=public,gateway.envoyproxy.io/owning-gateway-namespace=infra \\
      -o jsonpath='{.items[0].metadata.name}')
  kubectl --context ${CTX} -n envoy-gateway-system port-forward svc/\$svc 9443:443 9080:80

  curl -sk --resolve shop.example.com:9443:127.0.0.1 https://shop.example.com:9443/api/v1/items
  curl -s  -H 'Host: shop.example.com' http://127.0.0.1:9080/        # 301 to https

Delete it all with dev/down.sh.
EOF
