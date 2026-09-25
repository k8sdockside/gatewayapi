# Trying the plugin on a real cluster

`dev/up.sh` makes a local [kind](https://kind.sigs.k8s.io) cluster with the
Gateway API, an implementation of it, and a demo shop built so that every
state the plugin draws shows up at least once. It takes a few minutes, most
of it pulling images.

```sh
dev/up.sh      # create the cluster (or reuse it) and apply everything
dev/down.sh    # delete it
```

Needs `kind`, `kubectl`, `helm`, `openssl` and a running Docker. Every
`kubectl` and `helm` call in the script names the kind context
(`kind-gatewayapi-demo`) explicitly, and kind's habit of switching your
current context to the new cluster is undone at the end, so the cluster you
were pointing at is never touched. `CLUSTER=other dev/up.sh` picks another
name.

Then, in K8s Dockside: open the `kind-gatewayapi-demo` context, and
**Settings → Plugins → Watch another folder** on this checkout (or install
it), and open **Plugins → Gateway API**.

## What it installs

| | Version | How |
| --- | --- | --- |
| Gateway API CRDs | v1.6.1, experimental channel | Envoy Gateway's CRD chart, `oci://docker.io/envoyproxy/gateway-crds-helm`, rendered with `crds.gatewayAPI.channel=experimental` and applied server-side |
| [Envoy Gateway](https://gateway.envoyproxy.io) | v1.9.1 | `oci://docker.io/envoyproxy/gateway-helm`, with `crds.enabled=false` since the CRDs are already in |
| Demo workloads | `registry.k8s.io/gateway-api/echo-basic:v1.5.1` | `manifests/10-apps.yaml` |

The experimental channel is a superset of the standard one. In v1.6.1 the
standard channel already has every kind the plugin reads -- GatewayClass,
Gateway, ListenerSet, HTTPRoute, GRPCRoute, TLSRoute, TCPRoute, UDPRoute,
ReferenceGrant and BackendTLSPolicy -- and the experimental one adds
experimental fields and the `x-k8s.io` kinds (XBackend, XMesh and the like),
which the plugin does not read.

Where those versions come from, checked on 2026-09-25:

- Envoy Gateway's [compatibility matrix](https://gateway.envoyproxy.io/news/releases/matrix/)
  pairs v1.9 with Gateway API v1.6.1, and the CRD chart at v1.9.1 renders
  bundle version v1.6.1.
- The install commands are the ones in Envoy Gateway's
  [Helm install guide](https://gateway.envoyproxy.io/docs/install/install-helm/),
  including "helm template piped into kubectl apply --server-side" for the
  CRDs on their own.
- `echo-basic:v1.5.1` is the image Envoy Gateway's own v1.9.1 quickstart
  uses; `GRPC_ECHO_SERVER=1` turning it into a gRPC server is taken from the
  Gateway API conformance manifests.

Envoy Gateway is only the implementation the demo happens to use. The plugin
reads nothing of Envoy Gateway's: swap it for any other implementation and
the pages are the same.

A kind cluster has no load balancer, so `manifests/00-gateways.yaml` gives
the GatewayClass an `EnvoyProxy` asking for a ClusterIP Service. The Gateways
then get an address and report `Programmed` instead of waiting for an
external IP that never comes.

## What you should see

| Object | State | Where it shows |
| --- | --- | --- |
| `shop/storefront` | working: a 90/10 canary split on `/api`, `x-canary: true` sending testers to v2, a prefix rewrite on `/cart`, a redirect on `/old-shop` | the map's `90%` and `10%` edges; the URL resolver's split and "it only just missed" |
| `shop/shop-https-redirect` | plain HTTP for the shop, sent to HTTPS | `http://shop.example.com/` resolves to a 301 |
| `shop/payments` | crosses into `payments`, allowed by a ReferenceGrant | a healthy edge into another namespace |
| `shop/billing` | crosses into `billing` with no ReferenceGrant | dashed red "no grant" edge; a Problem; the resolver answers 500 |
| `shop/recommendations` | its Service does not exist | a dashed ghost backend; a Problem |
| `shop/search` | its Deployment is scaled to zero | "no pods" on the backend; a Problem; the resolver answers 503 |
| `shop/legacy` | asks for `infra/internal`, which only takes routes from `infra` | a dashed "not allowed" edge off the Gateway; not accepted |
| `shop/ghost` | asks for a Gateway that does not exist | an orphan hanging off a ghost Gateway |
| `infra/internal` | an HTTP and a TCP listener on port 80 | both listeners in conflict |
| `*.apps.example.com` | a wildcard listener with `blog` (exact host) and `catch-all` (no host) | `https://blog.apps.example.com/` vs `https://anything.apps.example.com/` |
| `shop/checkout` | a GRPCRoute | `grpc://grpc.example.com:8080/checkout.v1.Checkout/Pay` |
| `shop/db`, `shop/cache` | a TLSRoute (passthrough) and a TCPRoute | `https://db.example.com:8443/`, `tcp://cache:6379` |
| `team-blog/team-docs` | a ListenerSet adding `docs.example.com` to `infra/public` | a listener marked "set" on the dashboard |

`npm run preview` draws the same objects without a cluster: `src/fixtures.ts`
is this demo, with the statuses a controller writes on it.

## Sending real requests

The resolver works out where a request goes without sending one. To check it
against the data plane, port-forward the public Gateway's Envoy Service:

```sh
svc=$(kubectl --context kind-gatewayapi-demo -n envoy-gateway-system get svc \
    -l gateway.envoyproxy.io/owning-gateway-name=public,gateway.envoyproxy.io/owning-gateway-namespace=infra \
    -o jsonpath='{.items[0].metadata.name}')
kubectl --context kind-gatewayapi-demo -n envoy-gateway-system port-forward svc/$svc 9443:443 9080:80

curl -sk --resolve shop.example.com:9443:127.0.0.1 https://shop.example.com:9443/api/v1/items
curl -sk --resolve shop.example.com:9443:127.0.0.1 -H 'x-canary: true' https://shop.example.com:9443/api/v1/items
curl -s  -H 'Host: shop.example.com' -o /dev/null -w '%{http_code} %{redirect_url}\n' http://127.0.0.1:9080/
```

echo-basic answers with the pod that served the request, so the canary split
is visible by running the first line a few times. Type
`https://shop.example.com:9443/api` into the resolver and it says the port is
mapped, and answers the same.

## What was and was not tried

The manifests were checked against the v1.6.1 Gateway API CRDs and Envoy
Gateway v1.9.1's own CRDs: every field and type against the schemas, and the
CEL rules (listener uniqueness, redirect and rewrite rules, ports on Service
references) by reading them. That caught a first version of the conflicting
listeners that the API server would have refused.

The script itself could not be run end to end where it was written: that
machine's Docker could not create network interfaces (its kernel had been
upgraded without a reboot), so kind could not start a node. The commands and
versions are the documented ones above, but the exact condition reasons Envoy
Gateway writes -- for the port-80 protocol conflict in particular, and
whether v1.9.1 already serves ListenerSets -- have not been seen on a live
cluster. Where Envoy Gateway says something different from the fixtures, the
plugin shows what the controller said; that is the point of it.
