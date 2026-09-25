import { describe, expect, it } from 'vitest';
import { snapshot } from '../fixtures.js';
import { countEndpoints, granted, selectorMatches, topology } from './topology.js';
import type { Snapshot } from './types.js';

const topo = topology(snapshot());
const route = (ns: string, name: string, t = topo) => t.routes.find((r) => r.namespace === ns && r.name === name)!;
const gw = (name: string, t = topo) => t.gateways.find((g) => g.name === name)!;

describe('attachment', () => {
    it('lands a route on the listener it names, and only there', () => {
        const r = route('shop', 'storefront');
        expect(r.attached).toBe(true);
        expect(r.parents[0]!.listeners.map((l) => l.name)).toEqual(['https-shop']);
        expect(r.tone).toBe('ok');
        expect(gw('public').listeners.find((l) => l.name === 'https-shop')!.attachments.map((a) => a.route.name)).toContain('storefront');
    });

    it('reads a Selector over namespaces against their labels', () => {
        // shop carries gateway-access=public; team-blog does not.
        const snap = snapshot();
        const blog = snap.routes[0]!.items.find((r) => r.metadata.name === 'blog')!;
        const moved = structuredClone(blog);
        moved.spec!.parentRefs = [{ name: 'public', namespace: 'infra', sectionName: 'https-shop' }];
        moved.spec!.hostnames = ['shop.example.com'];
        moved.metadata.name = 'sneaky';
        delete moved.status;
        snap.routes[0]!.items = [...snap.routes[0]!.items, moved];
        const t = topology(snap);
        const p = route('team-blog', 'sneaky', t).parents[0]!;
        expect(p.listeners).toEqual([]);
        expect(p.reason).toBe('NotAllowedByListeners');
        expect(p.message).toContain('selector');
    });

    it('takes the controller at its word when it refused a route', () => {
        const r = route('shop', 'legacy');
        expect(r.attached).toBe(false);
        expect(r.orphan).toBe(true);
        expect(r.parents[0]!.accepted).toBe(false);
        expect(r.parents[0]!.reason).toBe('NotAllowedByListeners');
        // It asked for both listeners of the internal Gateway.
        expect(r.parents[0]!.candidates.map((l) => l.name)).toEqual(['http', 'tcp-80']);
        // Each listener's reason, in words.
        expect(r.parents[0]!.specWhy).toBe('The listener http takes routes only from infra, its own namespace; this route is in shop. The listener tcp-80 takes TCPRoute, not HTTPRoute.');
        expect(r.tone).toBe('error');
    });

    it('marks a route whose Gateway does not exist as orphaned', () => {
        const r = route('shop', 'ghost');
        expect(r.parents[0]!.missing).toBe(true);
        expect(r.parents[0]!.message).toContain('old-gateway');
        expect(r.orphan).toBe(true);
    });

    it('explains a route no controller has seen from the spec alone', () => {
        const snap = snapshot();
        const r = structuredClone(snap.routes[0]!.items.find((x) => x.metadata.name === 'blog')!);
        r.metadata.name = 'wrong-host';
        r.spec!.hostnames = ['blog.example.org'];
        delete r.status;
        snap.routes[0]!.items = [...snap.routes[0]!.items, r];
        const p = route('team-blog', 'wrong-host', topology(snap)).parents[0]!;
        expect(p.reason).toBe('NoMatchingListenerHostname');
        expect(p.tone).toBe('error');
    });

    it('says "pending" for a route that fits but has no status yet', () => {
        const snap = snapshot();
        const r = structuredClone(snap.routes[0]!.items.find((x) => x.metadata.name === 'blog')!);
        r.metadata.name = 'fresh';
        delete r.status;
        snap.routes[0]!.items = [...snap.routes[0]!.items, r];
        const view = route('team-blog', 'fresh', topology(snap));
        expect(view.parents[0]!.reason).toBe('Pending');
        expect(view.parents[0]!.tone).toBe('warn');
        expect(view.attached).toBe(true);
    });

    it('attaches a route that names a ListenerSet to that set’s listener, not the Gateway’s own', () => {
        const r = route('team-blog', 'docs');
        expect(r.parents[0]!.listeners.map((l) => l.name)).toEqual(['docs-http']);
        expect(r.parents[0]!.listeners[0]!.viaSet).toBe('team-blog/team-docs');
        expect(r.parents[0]!.gateway!.name).toBe('public');
    });

    it('lets a Selector through when the namespaces could not be read', () => {
        const t = topology({ ...snapshot(), namespaces: null });
        expect(route('shop', 'storefront', t).parents[0]!.listeners.map((l) => l.name)).toEqual(['https-shop']);
    });
});

describe('backends', () => {
    it('works out the canary split', () => {
        const rule = route('shop', 'storefront').rules[1]!;
        expect(rule.backends.map((b) => [b.name, b.share])).toEqual([
            ['storefront', 0.9],
            ['storefront-canary', 0.1],
        ]);
    });

    it('allows a cross-namespace backend only with a ReferenceGrant', () => {
        const pay = route('shop', 'payments').rules[0]!.backends[0]!;
        expect(pay.crossNamespace).toBe(true);
        expect(pay.granted).toBe(true);
        expect(pay.tone).toBe('ok');
        const bill = route('shop', 'billing').rules[0]!.backends[0]!;
        expect(bill.granted).toBe(false);
        expect(bill.tone).toBe('error');
        expect(bill.problem).toContain('ReferenceGrant');
    });

    it('notices a Service that is not there', () => {
        const b = route('shop', 'recommendations').rules[0]!.backends[0]!;
        expect(b.exists).toBe(false);
        expect(b.tone).toBe('error');
    });

    it('counts ready endpoints, and calls a sole backend with none an error', () => {
        const b = route('shop', 'search').rules[0]!.backends[0]!;
        expect(b.ready).toBe(0);
        expect(b.tone).toBe('error');
        expect(route('shop', 'storefront').rules[4]!.backends[0]!.ready).toBe(2);
    });

    it('records which rules send traffic to each Service', () => {
        const s = topo.services.get('shop/storefront-canary')!;
        expect(s.uses.map((u) => `${u.route.name}#${u.rule.index}`)).toEqual(['storefront#0', 'storefront#1']);
    });

    it('notes a BackendTLSPolicy on the Service', () => {
        expect(route('shop', 'payments').rules[0]!.backends[0]!.tlsPolicy).toBe('payments-api-tls');
    });
});

describe('listeners', () => {
    it('marks conflicting listeners as errors, with the controller’s words', () => {
        const internal = gw('internal');
        expect(internal.listeners.every((l) => l.tone === 'error')).toBe(true);
        expect(internal.listeners[0]!.notes[0]).toContain('must be compatible');
    });

    it('uses allowedRoutes.kinds, else what the protocol implies', () => {
        const pub = gw('public');
        expect(pub.listeners.find((l) => l.name === 'grpc')!.kinds).toEqual(['GRPCRoute']);
        expect(pub.listeners.find((l) => l.name === 'http')!.kinds).toEqual(['HTTPRoute', 'GRPCRoute']);
        expect(pub.listeners.find((l) => l.name === 'tcp-cache')!.kinds).toEqual(['TCPRoute']);
    });

    it('flags a certificate in another namespace without a ReferenceGrant', () => {
        const snap: Snapshot = snapshot();
        const g = structuredClone(snap.gateways[1]!);
        g.spec!.listeners![1]!.tls!.certificateRefs = [{ name: 'shop-tls', namespace: 'certs' }];
        const t = topology({ ...snap, gateways: [snap.gateways[0]!, g] });
        const l = gw('public', t).listeners.find((x) => x.name === 'https-shop')!;
        expect(l.tone).toBe('error');
        expect(l.notes.join(' ')).toContain('certs/shop-tls');
    });
});

describe('helpers', () => {
    it('counts pods, not addresses, across dual-stack slices', () => {
        const slice = (family: string, ready: boolean | undefined) => ({
            metadata: { name: `web-${family}`, namespace: 'a', labels: { 'kubernetes.io/service-name': 'web' } },
            endpoints: [{ addresses: [family], conditions: ready === undefined ? {} : { ready }, targetRef: { kind: 'Pod', name: 'web-0' } }],
        });
        expect(countEndpoints([slice('10.0.0.1', true), slice('fd00::1', true)]).get('a/web')).toEqual({ ready: 1, total: 1 });
        // An absent `ready` means ready.
        expect(countEndpoints([slice('10.0.0.1', undefined)]).get('a/web')).toEqual({ ready: 1, total: 1 });
        expect(countEndpoints([slice('10.0.0.1', false)]).get('a/web')).toEqual({ ready: 0, total: 1 });
    });

    it('evaluates label selectors, expressions included', () => {
        expect(selectorMatches({ matchLabels: { a: '1' } }, { a: '1', b: '2' })).toBe(true);
        expect(selectorMatches({ matchExpressions: [{ key: 'env', operator: 'In', values: ['prod'] }] }, { env: 'dev' })).toBe(false);
        expect(selectorMatches({ matchExpressions: [{ key: 'env', operator: 'DoesNotExist' }] }, {})).toBe(true);
        expect(selectorMatches(undefined, {})).toBe(true);
    });

    it('reads a ReferenceGrant with and without a name', () => {
        const grants = [{ metadata: { name: 'g', namespace: 'b' }, spec: { from: [{ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', namespace: 'a' }], to: [{ group: '', kind: 'Service' }] } }];
        const from = { group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', namespace: 'a' };
        expect(granted(grants, from, { group: '', kind: 'Service', namespace: 'b', name: 'any' })).toBe(true);
        expect(granted(grants, { ...from, kind: 'GRPCRoute' }, { group: '', kind: 'Service', namespace: 'b', name: 'any' })).toBe(false);
        expect(granted(grants, from, { group: '', kind: 'Service', namespace: 'c', name: 'any' })).toBe(false);
    });
});
