// A cluster's worth of Gateway API objects: the dev/ demo, with the statuses a
// controller writes on it.
//
// Used by the tests and by scripts/preview.mjs, so what the tests assert on
// and what the preview draws are the same cluster and cannot drift apart. It
// is the same set of objects dev/manifests applies to a kind cluster, so the
// preview and a real cluster can be compared side by side.
//
// It is deliberately not a healthy cluster. Next to a working shop with a
// 90/10 canary split it has: a cross-namespace backend with a ReferenceGrant
// and one without, a backend Service that does not exist, one scaled to zero,
// a route its Gateway refuses, a route whose Gateway does not exist, two
// listeners that conflict, a wildcard listener with an exact host and a
// catch-all under it, a GRPCRoute, a TLS passthrough route, a TCP route and a
// ListenerSet.
//
// It lives in src/ rather than src/pages/ because scripts/build.mjs turns
// every non-test .ts under src/pages into a page of its own.

import type { BackendTLSPolicy, Condition, EndpointSlice, Gateway, GatewayClass, ListenerSet, Namespace, ParentRef, ReferenceGrant, Route, RouteRule, Service, Snapshot } from './model/types.js';

const G = 'gateway.networking.k8s.io/v1';
const CONTROLLER = 'gateway.envoyproxy.io/gatewayclass-controller';
const T0 = '2026-09-01T10:00:00Z';

function cond(type: string, status: 'True' | 'False' | 'Unknown', reason: string, message = ''): Condition {
    return { type, status, reason, message, lastTransitionTime: T0, observedGeneration: 1 };
}

function meta(namespace: string, name: string, created = T0, labels?: Record<string, string>) {
    return { namespace, name, creationTimestamp: created, uid: `${namespace}-${name}`, ...(labels ? { labels } : {}) };
}

const ok = (...extra: Condition[]) => [cond('Accepted', 'True', 'Accepted', 'Route is accepted'), cond('ResolvedRefs', 'True', 'ResolvedRefs', 'Resolved all the Object references for the Route'), ...extra];

function parentStatus(name: string, namespace: string, sectionName: string | undefined, conditions: Condition[], kind?: string) {
    return {
        parentRef: { group: 'gateway.networking.k8s.io', kind: kind ?? 'Gateway', name, namespace, ...(sectionName ? { sectionName } : {}) },
        controllerName: CONTROLLER,
        conditions,
    };
}

// ----- classes and gateways --------------------------------------------------------

export const classes: GatewayClass[] = [
    {
        apiVersion: G,
        kind: 'GatewayClass',
        metadata: { name: 'demo', creationTimestamp: T0 },
        spec: { controllerName: CONTROLLER, description: 'Envoy Gateway, for the K8s Dockside Gateway API plugin demo.' },
        status: { conditions: [cond('Accepted', 'True', 'Accepted', 'Valid GatewayClass')] },
    },
];

const listenerOk = (name: string, attachedRoutes: number, kinds: string[]) => ({
    name,
    attachedRoutes,
    supportedKinds: kinds.map((kind) => ({ group: 'gateway.networking.k8s.io', kind })),
    conditions: [cond('Programmed', 'True', 'Programmed', 'Sending translated listener configuration to the data plane'), cond('Accepted', 'True', 'Accepted', 'Listener has been successfully translated'), cond('ResolvedRefs', 'True', 'ResolvedRefs', 'Listener has been successfully translated')],
});

export const publicGateway: Gateway = {
    apiVersion: G,
    kind: 'Gateway',
    metadata: meta('infra', 'public'),
    spec: {
        gatewayClassName: 'demo',
        allowedListeners: { namespaces: { from: 'All' } },
        listeners: [
            { name: 'http', port: 80, protocol: 'HTTP', allowedRoutes: { namespaces: { from: 'All' } } },
            {
                name: 'https-shop',
                port: 443,
                protocol: 'HTTPS',
                hostname: 'shop.example.com',
                tls: { mode: 'Terminate', certificateRefs: [{ name: 'shop-tls' }] },
                allowedRoutes: { namespaces: { from: 'Selector', selector: { matchLabels: { 'gateway-access': 'public' } } } },
            },
            { name: 'https-apps', port: 443, protocol: 'HTTPS', hostname: '*.apps.example.com', tls: { mode: 'Terminate', certificateRefs: [{ name: 'apps-tls' }] }, allowedRoutes: { namespaces: { from: 'All' } } },
            { name: 'grpc', port: 8080, protocol: 'HTTP', hostname: 'grpc.example.com', allowedRoutes: { namespaces: { from: 'All' }, kinds: [{ kind: 'GRPCRoute' }] } },
            { name: 'tls-db', port: 8443, protocol: 'TLS', hostname: 'db.example.com', tls: { mode: 'Passthrough' }, allowedRoutes: { namespaces: { from: 'All' }, kinds: [{ kind: 'TLSRoute' }] } },
            { name: 'tcp-cache', port: 6379, protocol: 'TCP', allowedRoutes: { namespaces: { from: 'All' }, kinds: [{ kind: 'TCPRoute' }] } },
        ],
    },
    status: {
        addresses: [{ type: 'IPAddress', value: '10.96.41.17' }],
        attachedListenerSets: 1,
        conditions: [cond('Accepted', 'True', 'Accepted', 'The Gateway has been scheduled by Envoy Gateway'), cond('Programmed', 'True', 'Programmed', 'Address assigned to the Gateway, 1/1 envoy replicas available')],
        listeners: [
            listenerOk('http', 1, ['HTTPRoute', 'GRPCRoute']),
            listenerOk('https-shop', 5, ['HTTPRoute', 'GRPCRoute']),
            listenerOk('https-apps', 2, ['HTTPRoute', 'GRPCRoute']),
            listenerOk('grpc', 1, ['GRPCRoute']),
            listenerOk('tls-db', 1, ['TLSRoute']),
            listenerOk('tcp-cache', 1, ['TCPRoute']),
        ],
    },
};

const conflicted = (name: string, kind: string) => ({
    name,
    attachedRoutes: 0,
    supportedKinds: [{ group: 'gateway.networking.k8s.io', kind }],
    conditions: [
        cond('Conflicted', 'True', 'ProtocolConflict', 'All listener protocols for a given port must be compatible'),
        cond('Programmed', 'False', 'Invalid', 'Listener is invalid, see other Conditions for details.'),
    ],
});

export const internalGateway: Gateway = {
    apiVersion: G,
    kind: 'Gateway',
    metadata: meta('infra', 'internal'),
    spec: {
        gatewayClassName: 'demo',
        listeners: [
            { name: 'http', port: 80, protocol: 'HTTP', hostname: '*.internal.example.com', allowedRoutes: { namespaces: { from: 'Same' } } },
            { name: 'tcp-80', port: 80, protocol: 'TCP', allowedRoutes: { namespaces: { from: 'Same' } } },
        ],
    },
    status: {
        addresses: [{ type: 'IPAddress', value: '10.96.88.3' }],
        conditions: [cond('Accepted', 'True', 'Accepted', 'The Gateway has been scheduled by Envoy Gateway'), cond('Programmed', 'True', 'Programmed', 'Address assigned to the Gateway, 1/1 envoy replicas available')],
        listeners: [conflicted('http', 'HTTPRoute'), conflicted('tcp-80', 'TCPRoute')],
    },
};

export const gateways: Gateway[] = [internalGateway, publicGateway];

export const listenerSets: ListenerSet[] = [
    {
        apiVersion: G,
        kind: 'ListenerSet',
        metadata: meta('team-blog', 'team-docs'),
        spec: {
            parentRef: { name: 'public', namespace: 'infra' },
            listeners: [{ name: 'docs-http', port: 80, protocol: 'HTTP', hostname: 'docs.example.com', allowedRoutes: { namespaces: { from: 'Same' } } }],
        },
        status: { conditions: [cond('Accepted', 'True', 'Accepted', 'ListenerSet accepted'), cond('Programmed', 'True', 'Programmed', 'ListenerSet programmed')], listeners: [listenerOk('docs-http', 1, ['HTTPRoute', 'GRPCRoute'])] },
    },
];

// ----- routes -----------------------------------------------------------------------------

const https = (sectionName: string) => ({ name: 'public', namespace: 'infra', sectionName });

export const storefront: Route = {
    apiVersion: G,
    kind: 'HTTPRoute',
    metadata: meta('shop', 'storefront', '2026-09-01T10:05:00Z'),
    spec: {
        parentRefs: [https('https-shop')],
        hostnames: ['shop.example.com'],
        rules: [
            {
                matches: [{ path: { type: 'PathPrefix', value: '/api' }, headers: [{ name: 'x-canary', value: 'true' }] }],
                backendRefs: [{ name: 'storefront-canary', port: 80 }],
            },
            {
                matches: [{ path: { type: 'PathPrefix', value: '/api' } }],
                filters: [{ type: 'RequestHeaderModifier', requestHeaderModifier: { set: [{ name: 'x-shop-tier', value: 'api' }] } }],
                backendRefs: [
                    { name: 'storefront', port: 80, weight: 90 },
                    { name: 'storefront-canary', port: 80, weight: 10 },
                ],
            },
            {
                matches: [{ path: { type: 'PathPrefix', value: '/cart' } }],
                filters: [{ type: 'URLRewrite', urlRewrite: { path: { type: 'ReplacePrefixMatch', replacePrefixMatch: '/' } } }],
                backendRefs: [{ name: 'cart', port: 80 }],
            },
            {
                matches: [{ path: { type: 'PathPrefix', value: '/old-shop' } }],
                filters: [{ type: 'RequestRedirect', requestRedirect: { path: { type: 'ReplaceFullPath', replaceFullPath: '/' }, statusCode: 301 } }],
            },
            {
                matches: [{ path: { type: 'PathPrefix', value: '/' } }],
                filters: [{ type: 'ResponseHeaderModifier', responseHeaderModifier: { add: [{ name: 'x-served-by', value: 'storefront' }] } }],
                backendRefs: [{ name: 'storefront', port: 80 }],
            },
        ],
    },
    status: { parents: [parentStatus('public', 'infra', 'https-shop', ok())] },
};

/** A route with one parent and one rule, which is most of them. `conditions: null` is a route no controller has written a status on. */
function simple(namespace: string, name: string, parent: ParentRef, hostnames: string[], rule: RouteRule, conditions: Condition[] | null, created = T0): Route {
    return {
        apiVersion: G,
        kind: 'HTTPRoute',
        metadata: meta(namespace, name, created),
        spec: { parentRefs: [parent], ...(hostnames.length ? { hostnames } : {}), rules: [rule] },
        status: conditions ? { parents: [parentStatus(parent.name, parent.namespace ?? namespace, parent.sectionName, conditions, parent.kind)] } : { parents: [] },
    };
}

export const httpRoutes: Route[] = [
    storefront,
    simple('shop', 'shop-https-redirect', https('http'), ['shop.example.com'], { filters: [{ type: 'RequestRedirect', requestRedirect: { scheme: 'https', statusCode: 301 } }] }, ok()),
    simple('shop', 'payments', https('https-shop'), ['shop.example.com'], { matches: [{ path: { type: 'PathPrefix', value: '/pay' } }], backendRefs: [{ name: 'payments-api', namespace: 'payments', port: 80 }] }, ok()),
    simple(
        'shop',
        'billing',
        https('https-shop'),
        ['shop.example.com'],
        { matches: [{ path: { type: 'PathPrefix', value: '/billing' } }], backendRefs: [{ name: 'billing-api', namespace: 'billing', port: 80 }] },
        [cond('Accepted', 'True', 'Accepted', 'Route is accepted'), cond('ResolvedRefs', 'False', 'RefNotPermitted', 'Backend ref to Service billing/billing-api not permitted by any ReferenceGrant.')],
    ),
    simple(
        'shop',
        'recommendations',
        https('https-shop'),
        ['shop.example.com'],
        { matches: [{ path: { type: 'PathPrefix', value: '/recommendations' } }], backendRefs: [{ name: 'recommendations', port: 80 }] },
        [cond('Accepted', 'True', 'Accepted', 'Route is accepted'), cond('ResolvedRefs', 'False', 'BackendNotFound', 'Failed to process route rule 0 backendRef 0: service shop/recommendations not found.')],
    ),
    simple(
        'shop',
        'search',
        https('https-shop'),
        ['shop.example.com'],
        { matches: [{ path: { type: 'Exact', value: '/search' } }, { path: { type: 'PathPrefix', value: '/search/' } }], backendRefs: [{ name: 'search', port: 80 }] },
        ok(),
    ),
    simple(
        'shop',
        'legacy',
        { name: 'internal', namespace: 'infra' },
        ['legacy.internal.example.com'],
        { backendRefs: [{ name: 'storefront', port: 80 }] },
        [cond('Accepted', 'False', 'NotAllowedByListeners', 'No listeners included by this parent ref allowed this attachment.'), cond('ResolvedRefs', 'True', 'ResolvedRefs', 'Resolved all the Object references for the Route')],
    ),
    simple('shop', 'ghost', { name: 'old-gateway', namespace: 'infra' }, ['old.example.com'], { backendRefs: [{ name: 'storefront', port: 80 }] }, null),
    simple('team-blog', 'blog', https('https-apps'), ['blog.apps.example.com'], { backendRefs: [{ name: 'blog', port: 80 }] }, ok()),
    simple('team-blog', 'catch-all', https('https-apps'), [], { backendRefs: [{ name: 'apps-landing', port: 80 }] }, ok()),
    simple('team-blog', 'docs', { group: 'gateway.networking.k8s.io', kind: 'ListenerSet', name: 'team-docs', namespace: 'team-blog' }, ['docs.example.com'], { backendRefs: [{ name: 'docs', port: 80 }] }, ok()),
    simple('infra', 'status', { name: 'internal', namespace: 'infra' }, ['status.internal.example.com'], { backendRefs: [{ name: 'status-page', port: 80 }] }, ok()),
];

export const grpcRoutes: Route[] = [
    {
        apiVersion: G,
        kind: 'GRPCRoute',
        metadata: meta('shop', 'checkout'),
        spec: {
            parentRefs: [https('grpc')],
            hostnames: ['grpc.example.com'],
            rules: [
                { matches: [{ method: { service: 'checkout.v1.Checkout' } }], backendRefs: [{ name: 'checkout', port: 8080 }] },
                { matches: [{ method: { service: 'grpc.health.v1.Health', method: 'Check' } }], backendRefs: [{ name: 'checkout', port: 8080 }] },
            ],
        },
        status: { parents: [parentStatus('public', 'infra', 'grpc', ok())] },
    },
];

export const tlsRoutes: Route[] = [
    {
        apiVersion: G,
        kind: 'TLSRoute',
        metadata: meta('shop', 'db'),
        spec: { parentRefs: [https('tls-db')], hostnames: ['db.example.com'], rules: [{ backendRefs: [{ name: 'db', port: 5432 }] }] },
        status: { parents: [parentStatus('public', 'infra', 'tls-db', ok())] },
    },
];

export const tcpRoutes: Route[] = [
    {
        apiVersion: G,
        kind: 'TCPRoute',
        metadata: meta('shop', 'cache'),
        spec: { parentRefs: [https('tcp-cache')], rules: [{ backendRefs: [{ name: 'cache', port: 6379 }] }] },
        status: { parents: [parentStatus('public', 'infra', 'tcp-cache', ok())] },
    },
];

export const grants: ReferenceGrant[] = [
    {
        apiVersion: G,
        kind: 'ReferenceGrant',
        metadata: meta('payments', 'shop-routes'),
        spec: { from: [{ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', namespace: 'shop' }], to: [{ group: '', kind: 'Service', name: 'payments-api' }] },
    },
];

export const backendTLS: BackendTLSPolicy[] = [
    {
        apiVersion: G,
        kind: 'BackendTLSPolicy',
        metadata: meta('payments', 'payments-api-tls'),
        spec: { targetRefs: [{ group: '', kind: 'Service', name: 'payments-api' }], validation: { hostname: 'payments-api.payments.svc', wellKnownCACertificates: 'System' } },
    },
];

// ----- services and endpoints ----------------------------------------------------------------

const SERVICES: [string, string, number, number][] = [
    // namespace, name, port, ready pods
    ['shop', 'storefront', 80, 2],
    ['shop', 'storefront-canary', 80, 1],
    ['shop', 'cart', 80, 1],
    ['shop', 'checkout', 8080, 1],
    ['shop', 'search', 80, 0],
    ['shop', 'db', 5432, 1],
    ['shop', 'cache', 6379, 1],
    ['payments', 'payments-api', 80, 1],
    ['billing', 'billing-api', 80, 1],
    ['team-blog', 'blog', 80, 1],
    ['team-blog', 'apps-landing', 80, 1],
    ['team-blog', 'docs', 80, 1],
    ['infra', 'status-page', 80, 1],
];

export const services: Service[] = SERVICES.map(([namespace, name, port]) => ({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: meta(namespace, name),
    spec: { type: 'ClusterIP', clusterIP: '10.96.0.10', selector: { app: name }, ports: [{ name: 'http', port, targetPort: 3000, protocol: 'TCP' }] },
}));

export const slices: EndpointSlice[] = SERVICES.filter(([, , , ready]) => ready > 0).map(([namespace, name, , ready]) => ({
    apiVersion: 'discovery.k8s.io/v1',
    kind: 'EndpointSlice',
    metadata: meta(namespace, `${name}-abcde`, T0, { 'kubernetes.io/service-name': name }),
    endpoints: Array.from({ length: ready }, (_, i) => ({ addresses: [`10.244.0.${10 + i}`], conditions: { ready: true, serving: true, terminating: false }, targetRef: { kind: 'Pod', name: `${name}-${i}` } })),
    ports: [{ name: 'http', port: 3000 }],
}));

export const namespaces: Namespace[] = ['infra', 'shop', 'payments', 'billing', 'team-blog'].map((name) => ({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name, labels: { 'kubernetes.io/metadata.name': name, ...(name === 'shop' ? { 'gateway-access': 'public' } : {}) } },
}));

/** The whole demo, as the pages read it. */
export function snapshot(): Snapshot {
    return {
        classes,
        gateways,
        listenerSets,
        routes: [
            { type: 'HTTPRoute', items: httpRoutes },
            { type: 'GRPCRoute', items: grpcRoutes },
            { type: 'TLSRoute', items: tlsRoutes },
            { type: 'TCPRoute', items: tcpRoutes },
            { type: 'UDPRoute', items: [] },
        ],
        grants,
        backendTLS,
        services,
        slices,
        namespaces,
    };
}

/** The same, as the bridge's `list` answers it: by app kind. */
export const LISTS: Record<string, unknown[]> = {
    gatewayclasses: classes,
    gateways,
    listenersets: listenerSets,
    httproutes: httpRoutes,
    grpcroutes: grpcRoutes,
    tlsroutes: tlsRoutes,
    tcproutes: tcpRoutes,
    udproutes: [],
    referencegrants: grants,
    backendtlspolicies: backendTLS,
    services,
    endpointslices: slices,
    namespaces,
};
