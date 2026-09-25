import { describe, expect, it } from 'vitest';
import { snapshot } from '../fixtures.js';
import { grpcPath, parseRequest, pathMatches, resolve, rewritePath, type Request, type Resolution } from './match.js';
import { topology } from './topology.js';
import type { Route, RouteRule, Snapshot } from './types.js';

const demo = topology(snapshot());

function req(url: string, method = 'GET', headers = ''): Request {
    const r = parseRequest(url, method, headers);
    if ('error' in r) throw new Error(r.error);
    return r;
}

function go(url: string, opts: { method?: string; headers?: string; topo?: ReturnType<typeof topology>; gateway?: string } = {}): Resolution {
    return resolve(opts.topo ?? demo, req(url, opts.method, opts.headers), opts.gateway ?? '');
}

/** Which route and rule won, as `namespace/name#rule`. */
function won(res: Resolution): string {
    return res.hit ? `${res.hit.route.namespace}/${res.hit.route.name}#${res.hit.rule.index}` : 'nothing';
}

// ----- a small cluster of our own, for precedence ---------------------------------------------

let clock = 0;
function httpRoute(name: string, rules: RouteRule[], hostnames: string[] = [], created?: string, namespace = 'a'): Route {
    clock++;
    return {
        metadata: { name, namespace, creationTimestamp: created ?? `2026-01-01T00:${String(clock).padStart(2, '0')}:00Z` },
        spec: { parentRefs: [{ name: 'gw', namespace: 'a' }], hostnames, rules },
        status: { parents: [{ parentRef: { name: 'gw', namespace: 'a' }, conditions: [{ type: 'Accepted', status: 'True' }] }] },
    };
}

function cluster(routes: Route[], listenerHost?: string): ReturnType<typeof topology> {
    const snap: Snapshot = {
        classes: [{ metadata: { name: 'c' }, spec: { controllerName: 'x' }, status: { conditions: [{ type: 'Accepted', status: 'True' }] } }],
        gateways: [
            {
                metadata: { name: 'gw', namespace: 'a' },
                spec: { gatewayClassName: 'c', listeners: [{ name: 'web', port: 80, protocol: 'HTTP', ...(listenerHost ? { hostname: listenerHost } : {}), allowedRoutes: { namespaces: { from: 'All' } } }] },
                status: { conditions: [{ type: 'Accepted', status: 'True' }, { type: 'Programmed', status: 'True' }], listeners: [{ name: 'web', conditions: [{ type: 'Programmed', status: 'True' }] }] },
            },
        ],
        listenerSets: [],
        routes: [{ type: 'HTTPRoute', items: routes }],
        grants: [],
        backendTLS: [],
        services: ['one', 'two', 'three'].map((name) => ({ metadata: { name, namespace: 'a' } })),
        slices: ['one', 'two', 'three'].map((name) => ({ metadata: { name: name + '-x', namespace: 'a', labels: { 'kubernetes.io/service-name': name } }, endpoints: [{ addresses: ['10.0.0.1'] }] })),
        namespaces: [{ metadata: { name: 'a' } }],
    };
    return topology(snap);
}

const to = (name: string) => [{ name, port: 80 }];

// ----- reading what was typed -------------------------------------------------------------------

describe('parseRequest', () => {
    it('takes a URL without a scheme as https', () => {
        const r = req('shop.example.com/api?x=1');
        expect(r.scheme).toBe('https');
        expect(r.host).toBe('shop.example.com');
        expect(r.port).toBe(null);
        expect(r.defaultPort).toBe(443);
        expect(r.path).toBe('/api');
        expect(r.query).toEqual([['x', '1']]);
    });

    it('reads the port, the method and the headers', () => {
        const r = req('http://Shop.Example.com:8080/', 'post', 'X-Canary: true\nnot a header\nAccept: */*');
        expect(r.host).toBe('shop.example.com');
        expect(r.port).toBe(8080);
        expect(r.method).toBe('POST');
        expect(r.headers).toEqual([
            ['x-canary', 'true'],
            ['accept', '*/*'],
        ]);
    });

    it('refuses what a Gateway does not listen for, in words', () => {
        expect(parseRequest('ftp://x.example.com')).toEqual({ error: expect.stringContaining('ftp://') });
        expect(parseRequest('   ')).toEqual({ error: expect.stringContaining('Type a URL') });
    });

    it('understands tcp, udp and tls addresses', () => {
        expect(req('tcp://cache.example.com:6379').scheme).toBe('tcp');
        expect(req('tls://db.example.com:8443').defaultPort).toBe(null);
    });
});

describe('path matching', () => {
    it('matches a prefix element by element', () => {
        expect(pathMatches({ type: 'PathPrefix', value: '/abc' }, '/abc').ok).toBe(true);
        expect(pathMatches({ type: 'PathPrefix', value: '/abc' }, '/abc/').ok).toBe(true);
        expect(pathMatches({ type: 'PathPrefix', value: '/abc' }, '/abc/def').ok).toBe(true);
        expect(pathMatches({ type: 'PathPrefix', value: '/abc' }, '/abcd').ok).toBe(false);
        // A trailing slash on the prefix is ignored.
        expect(pathMatches({ type: 'PathPrefix', value: '/abc/' }, '/abc').ok).toBe(true);
    });

    it('defaults to a prefix of /, which matches everything', () => {
        expect(pathMatches(undefined, '/anything/at/all').ok).toBe(true);
    });

    it('matches exact paths exactly, and regular expressions whole', () => {
        expect(pathMatches({ type: 'Exact', value: '/search' }, '/search').ok).toBe(true);
        expect(pathMatches({ type: 'Exact', value: '/search' }, '/search/').ok).toBe(false);
        expect(pathMatches({ type: 'RegularExpression', value: '/v[0-9]+/.*' }, '/v2/items').ok).toBe(true);
        expect(pathMatches({ type: 'RegularExpression', value: '/v[0-9]+' }, '/v2/items').ok).toBe(false);
        expect(pathMatches({ type: 'RegularExpression', value: '([' }, '/x').ok).toBe(false);
    });

    it('rewrites a prefix the way the API’s examples do', () => {
        expect(rewritePath({ type: 'ReplacePrefixMatch', replacePrefixMatch: '/xyz' }, '/foo/bar', '/foo')).toBe('/xyz/bar');
        expect(rewritePath({ type: 'ReplacePrefixMatch', replacePrefixMatch: '/xyz' }, '/foo', '/foo')).toBe('/xyz');
        expect(rewritePath({ type: 'ReplacePrefixMatch', replacePrefixMatch: '/xyz/' }, '/foo/bar', '/foo')).toBe('/xyz/bar');
        expect(rewritePath({ type: 'ReplacePrefixMatch', replacePrefixMatch: '/' }, '/foo/bar', '/foo')).toBe('/bar');
        expect(rewritePath({ type: 'ReplacePrefixMatch', replacePrefixMatch: '/' }, '/foo', '/foo')).toBe('/');
        expect(rewritePath({ type: 'ReplaceFullPath', replaceFullPath: '/new' }, '/foo/bar', '/foo')).toBe('/new');
    });

    it('reads a gRPC call out of its path', () => {
        expect(grpcPath('/checkout.v1.Checkout/Pay')).toEqual({ service: 'checkout.v1.Checkout', method: 'Pay' });
        expect(grpcPath('/api/v1/items')).toBe(null);
    });
});

// ----- the demo, end to end ---------------------------------------------------------------------

describe('the demo shop', () => {
    it('sends /api through the canary split, and says what the header would change', () => {
        const res = go('https://shop.example.com/api/v1/items');
        expect(res.pick!.listener.name).toBe('https-shop');
        expect(won(res)).toBe('shop/storefront#1');
        expect(res.outcome.kind).toBe('forward');
        if (res.outcome.kind !== 'forward') return;
        expect(res.outcome.backends.map((b) => `${b.name} ${Math.round(b.share * 100)}%`)).toEqual(['storefront 90%', 'storefront-canary 10%']);
        expect(res.outcome.failing).toBe(0);
        expect(res.requestHeaders[0]!.set![0]!.name).toBe('x-shop-tier');
        // The rule with the header match would have won, had the header been sent.
        expect(res.near[0]!.rule.index).toBe(0);
        expect(res.near[0]!.needs).toEqual(['header x-canary: true']);
    });

    it('sends testers with x-canary: true to the canary only', () => {
        const res = go('https://shop.example.com/api/v1/items', { headers: 'X-Canary: true' });
        expect(won(res)).toBe('shop/storefront#0');
        expect(res.near).toEqual([]);
        // The split rule matched too, and lost on the header count.
        expect(res.lower.map((h) => h.rule.index)).toContain(1);
    });

    it('prefers the longer prefix in another route over / in the older one', () => {
        expect(won(go('https://shop.example.com/pay/checkout'))).toBe('shop/payments#0');
        // Element-wise: /payment is not under /pay.
        expect(won(go('https://shop.example.com/payment'))).toBe('shop/storefront#4');
    });

    it('rewrites /cart before it reaches the cart', () => {
        const res = go('https://shop.example.com/cart/items/3');
        expect(won(res)).toBe('shop/storefront#2');
        expect(res.outcome.kind === 'forward' && res.outcome.rewrite).toEqual({ host: 'shop.example.com', path: '/items/3' });
    });

    it('answers /old-shop with the redirect, and plain http with the move to https', () => {
        const old = go('https://shop.example.com/old-shop/x?y=1');
        expect(old.outcome).toEqual({ kind: 'redirect', status: 301, location: 'https://shop.example.com/?y=1' });
        const plain = go('http://shop.example.com/basket');
        expect(plain.pick!.listener.name).toBe('http');
        expect(plain.outcome).toEqual({ kind: 'redirect', status: 301, location: 'https://shop.example.com/basket' });
    });

    it('prefers the exact path to the prefix beside it', () => {
        const exact = go('https://shop.example.com/search');
        expect(exact.hit!.matchIndex).toBe(0);
        expect(exact.hit!.reasons).toContain('exact path /search');
        const prefix = go('https://shop.example.com/search/shoes');
        expect(prefix.hit!.matchIndex).toBe(1);
    });

    it('says a backend with no ready endpoints fails with a 503', () => {
        const res = go('https://shop.example.com/search');
        expect(res.outcome).toMatchObject({ kind: 'fail', status: 503 });
    });

    it('says a refused cross-namespace backend and a missing one fail with a 500', () => {
        expect(go('https://shop.example.com/billing').outcome).toMatchObject({ kind: 'fail', status: 500, why: expect.stringContaining('ReferenceGrant') });
        expect(go('https://shop.example.com/recommendations').outcome).toMatchObject({ kind: 'fail', status: 500, why: expect.stringContaining('no Service') });
    });

    it('lands an exact host and anything else under the wildcard listener', () => {
        expect(go('https://blog.apps.example.com/').pick!.listener.hostname).toBe('*.apps.example.com');
        expect(won(go('https://blog.apps.example.com/'))).toBe('team-blog/blog#0');
        expect(won(go('https://wiki.apps.example.com/'))).toBe('team-blog/catch-all#0');
        expect(won(go('https://a.b.apps.example.com/'))).toBe('team-blog/catch-all#0');
    });

    it('finds no listener for the bare domain under a wildcard', () => {
        const res = go('https://apps.example.com/');
        expect(res.pick).toBe(null);
        expect(res.outcome).toMatchObject({ kind: 'fail' });
        expect(res.refused.map((r) => r.gateway.name)).toEqual(['internal', 'public']);
    });

    it('prefers a ListenerSet’s exact hostname to the Gateway’s catch-all listener', () => {
        const res = go('http://docs.example.com/guide');
        expect(res.pick!.listener.name).toBe('docs-http');
        expect(won(res)).toBe('team-blog/docs#0');
    });

    it('picks the more specific wildcard on another Gateway over a catch-all listener', () => {
        const res = go('http://legacy.internal.example.com/');
        expect(res.pick!.gateway.name).toBe('internal');
        expect(res.others.map((o) => o.gateway.name)).toEqual(['public']);
        // The route asking for that host was refused, so nothing matches -- and the conflicted listener is said.
        expect(res.hit).toBe(null);
        expect(res.outcome).toMatchObject({ kind: 'fail', status: 404 });
        expect(res.notes.join(' ')).toContain('must be compatible');
    });

    it('can be narrowed to one Gateway', () => {
        const res = go('http://legacy.internal.example.com/', { gateway: demo.gateways.find((g) => g.name === 'public')!.id });
        expect(res.pick!.gateway.name).toBe('public');
        expect(res.others).toEqual([]);
    });

    it('says when the port had to be mapped', () => {
        const res = go('https://shop.example.com:9443/');
        expect(res.pick!.listener.name).toBe('https-shop');
        expect(res.pick!.portExact).toBe(false);
        expect(res.notes[0]).toContain(':443');
    });
});

describe('gRPC, TLS and TCP', () => {
    it('routes a gRPC call by service, and by service and method', () => {
        const pay = go('grpc://grpc.example.com:8080/checkout.v1.Checkout/Pay');
        expect(pay.mode).toBe('grpc');
        expect(won(pay)).toBe('shop/checkout#0');
        const health = go('grpc://grpc.example.com:8080/grpc.health.v1.Health/Check');
        expect(won(health)).toBe('shop/checkout#1');
        expect(health.hit!.reasons).toContain('method Check');
        const watch = go('grpc://grpc.example.com:8080/grpc.health.v1.Health/Watch');
        expect(watch.hit).toBe(null);
        expect(watch.outcome).toMatchObject({ kind: 'fail', status: 404 });
    });

    it('takes an https URL on a passthrough port to the TLSRoute, by SNI', () => {
        const res = go('https://db.example.com:8443/');
        expect(res.mode).toBe('tls');
        expect(won(res)).toBe('shop/db#0');
        expect(res.hit!.reasons[0]).toContain('SNI');
    });

    it('takes a TCP address to the TCPRoute on its port', () => {
        const res = go('tcp://anything.example.com:6379');
        expect(res.mode).toBe('tcp');
        expect(won(res)).toBe('shop/cache#0');
    });
});

// ----- precedence, one rule at a time -------------------------------------------------------------

describe('precedence', () => {
    it('puts the route with the exact hostname ahead of a longer path under a wildcard', () => {
        const t = cluster([
            httpRoute('wild', [{ matches: [{ path: { value: '/very/long/prefix' } }], backendRefs: to('one') }], ['*.example.com'], '2020-01-01T00:00:00Z'),
            httpRoute('exact', [{ backendRefs: to('two') }], ['blog.example.com']),
        ]);
        expect(won(go('http://blog.example.com/very/long/prefix/x', { topo: t }))).toBe('a/exact#0');
        expect(won(go('http://news.example.com/very/long/prefix/x', { topo: t }))).toBe('a/wild#0');
    });

    it('puts a longer wildcard ahead of a shorter one', () => {
        const t = cluster([httpRoute('short', [{ backendRefs: to('one') }], ['*.example.com']), httpRoute('long', [{ backendRefs: to('two') }], ['*.eu.example.com'])]);
        expect(won(go('http://shop.eu.example.com/', { topo: t }))).toBe('a/long#0');
    });

    it('puts Exact ahead of any prefix, and a longer prefix ahead of a shorter', () => {
        const t = cluster([
            httpRoute('r', [
                { matches: [{ path: { type: 'PathPrefix', value: '/a/b/c/d' } }], backendRefs: to('one') },
                { matches: [{ path: { type: 'Exact', value: '/a' } }], backendRefs: to('two') },
                { matches: [{ path: { type: 'PathPrefix', value: '/a/b' } }], backendRefs: to('three') },
            ]),
        ]);
        expect(won(go('http://x/a', { topo: t }))).toBe('a/r#1');
        expect(won(go('http://x/a/b/c/d/e', { topo: t }))).toBe('a/r#0');
        expect(won(go('http://x/a/b/z', { topo: t }))).toBe('a/r#2');
    });

    it('puts a method match ahead of header matches, and more headers ahead of fewer, and headers ahead of query', () => {
        const t = cluster([
            httpRoute('r', [
                { matches: [{ path: { value: '/' }, headers: [{ name: 'a', value: '1' }, { name: 'b', value: '2' }] }], backendRefs: to('one') },
                { matches: [{ path: { value: '/' }, method: 'POST' }], backendRefs: to('two') },
                { matches: [{ path: { value: '/' }, headers: [{ name: 'a', value: '1' }] }], backendRefs: to('three') },
                { matches: [{ path: { value: '/' }, queryParams: [{ name: 'q', value: '1' }, { name: 'r', value: '2' }] }], backendRefs: to('one') },
            ]),
        ]);
        expect(won(go('http://x/', { topo: t, method: 'POST', headers: 'a: 1\nb: 2' }))).toBe('a/r#1');
        expect(won(go('http://x/', { topo: t, headers: 'a: 1\nb: 2' }))).toBe('a/r#0');
        expect(won(go('http://x/', { topo: t, headers: 'A: 1' }))).toBe('a/r#2');
        expect(won(go('http://x/?q=1&r=2', { topo: t, headers: 'a: 1' }))).toBe('a/r#2');
        expect(won(go('http://x/?q=1&r=2', { topo: t }))).toBe('a/r#3');
    });

    it('counts only the first of two header matches with the same name', () => {
        const t = cluster([
            httpRoute('r', [
                { matches: [{ headers: [{ name: 'x', value: '1' }, { name: 'X', value: '2' }] }], backendRefs: to('one') },
                { matches: [{ headers: [{ name: 'y', value: '1' }] }], backendRefs: to('two') },
            ]),
        ]);
        // x: 1 is all the first match needs; its second entry is ignored.
        expect(won(go('http://x/', { topo: t, headers: 'x: 1' }))).toBe('a/r#0');
    });

    it('matches header values exactly or by regular expression', () => {
        const t = cluster([httpRoute('r', [{ matches: [{ headers: [{ type: 'RegularExpression', name: 'user-agent', value: 'Mobile' }] }], backendRefs: to('one') }])]);
        expect(won(go('http://x/', { topo: t, headers: 'User-Agent: Something Mobile Safari' }))).toBe('a/r#0');
        expect(go('http://x/', { topo: t, headers: 'User-Agent: Desktop' }).hit).toBe(null);
    });

    it('breaks ties by the oldest route, then by namespace/name, then by rule order', () => {
        const older = cluster([httpRoute('zeta', [{ backendRefs: to('one') }], [], '2020-01-01T00:00:00Z'), httpRoute('alpha', [{ backendRefs: to('two') }], [], '2021-01-01T00:00:00Z')]);
        expect(won(go('http://x/', { topo: older }))).toBe('a/zeta#0');
        const same = '2022-01-01T00:00:00Z';
        const named = cluster([httpRoute('zeta', [{ backendRefs: to('one') }], [], same), httpRoute('alpha', [{ backendRefs: to('two') }], [], same)]);
        expect(won(go('http://x/', { topo: named }))).toBe('a/alpha#0');
        const rules = cluster([httpRoute('r', [{ backendRefs: to('one') }, { backendRefs: to('two') }])]);
        expect(won(go('http://x/', { topo: rules }))).toBe('a/r#0');
    });

    it('ranks a regular-expression path below exact and prefix matches, and says it decided nothing more', () => {
        const t = cluster([
            httpRoute('r', [
                { matches: [{ path: { type: 'RegularExpression', value: '/v[0-9]+/.*' } }], backendRefs: to('one') },
                { matches: [{ path: { type: 'PathPrefix', value: '/' } }], backendRefs: to('two') },
            ]),
        ]);
        const res = go('http://x/v2/items', { topo: t });
        expect(won(res)).toBe('a/r#1');
        expect(res.lower[0]!.regex).toBe(true);
    });

    it('ignores route hostnames outside the listener’s', () => {
        const t = cluster([httpRoute('r', [{ backendRefs: to('one') }], ['test.example.com', 'test.example.net'])], '*.example.com');
        expect(won(go('http://test.example.com/', { topo: t }))).toBe('a/r#0');
        expect(go('http://test.example.net/', { topo: t }).pick).toBe(null);
    });

    it('splits by weight, and counts the share a broken backend fails', () => {
        const t = cluster([
            httpRoute('r', [
                {
                    backendRefs: [
                        { name: 'one', port: 80, weight: 3 },
                        { name: 'gone', port: 80, weight: 1 },
                    ],
                },
            ]),
        ]);
        const res = go('http://x/', { topo: t });
        expect(res.outcome.kind).toBe('forward');
        if (res.outcome.kind === 'forward') expect(res.outcome.failing).toBe(0.25);
    });

    it('says 404 when nothing matches and 500 when the rule has nowhere to send it', () => {
        const t = cluster([httpRoute('r', [{ matches: [{ path: { type: 'Exact', value: '/only' } }] }])]);
        expect(go('http://x/other', { topo: t }).outcome).toMatchObject({ kind: 'fail', status: 404 });
        expect(go('http://x/only', { topo: t }).outcome).toMatchObject({ kind: 'fail', status: 500 });
    });

    it('works out a redirect’s port from its scheme, or the listener', () => {
        const t = cluster([
            httpRoute('r', [
                { matches: [{ path: { value: '/a' } }], filters: [{ type: 'RequestRedirect', requestRedirect: { scheme: 'https' } }] },
                { matches: [{ path: { value: '/b' } }], filters: [{ type: 'RequestRedirect', requestRedirect: { hostname: 'new.example.com', path: { type: 'ReplacePrefixMatch', replacePrefixMatch: '/c' } } }] },
                { matches: [{ path: { value: '/d' } }], filters: [{ type: 'RequestRedirect', requestRedirect: { scheme: 'https', port: 8443, statusCode: 308 } }] },
            ]),
        ]);
        expect(go('http://x.example.com/a/1', { topo: t }).outcome).toEqual({ kind: 'redirect', status: 302, location: 'https://x.example.com/a/1' });
        expect(go('http://x.example.com/b/1', { topo: t }).outcome).toEqual({ kind: 'redirect', status: 302, location: 'http://new.example.com/c/1' });
        expect(go('http://x.example.com/d', { topo: t }).outcome).toEqual({ kind: 'redirect', status: 308, location: 'https://x.example.com:8443/d' });
    });
});
