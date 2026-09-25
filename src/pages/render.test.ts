// @vitest-environment happy-dom
//
// Does each page actually draw?
//
// The model tests say the Gateway API knowledge is right; this says the pages
// that use it put it on the screen, against objects shaped the way a
// controller really writes them. It runs each page module against a stub of
// the bridge, with no cluster and no app, and reads the text that comes out.
//
// It is here rather than in a browser because the thing worth catching is a
// page that throws on a shape the cluster produces and this machine does not:
// a cluster without the Gateway API, one with no ListenerSet kind, a route no
// controller has looked at.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LISTS } from '../fixtures.js';

type Lists = Record<string, unknown[]>;

let opened: unknown[] = [];
let views: string[] = [];

function bridge(lists: Lists, object: K8sDockside.SectionObject | null = null, storage: Record<string, unknown> = {}) {
    return {
        ready: async () => ({
            pluginId: 'gatewayapi',
            viewId: '',
            sectionId: object ? 'panel' : '',
            object,
            contextId: 'test',
            contextName: 'test-cluster',
            readable: [],
            write: false,
            actions: [],
            theme: { id: 'k8sdockside-dark', base: 'dark' as const, tokens: {} },
        }),
        object: async () => null,
        list: async ({ kind }: { kind: string }) => {
            if (!(kind in lists)) throw new Error(`the cluster does not serve ${kind}`);
            return lists[kind];
        },
        get: async () => null,
        open: async (ref: unknown) => void opened.push(ref),
        openView: async (id: string) => void views.push(id),
        openUrl: async () => null,
        summary: async () => ({ pluginId: 'gatewayapi', installed: true, checked: true, requirements: [], cards: [], error: '' }),
        storage: { get: async (key: string) => storage[key] ?? null, set: async () => null, remove: async () => null, keys: async () => [] },
        actions: async () => [],
        run: async () => ({ created: '' }),
        resize: async () => null,
        watch: () => () => {},
        namespaces: async () => [],
        charts: async () => ({ attached: false, source: {}, charts: [], range: 60 }),
        patch: async () => null,
        create: async () => ({ name: '' }),
        edit: async () => null,
        logs: async () => null,
        on: () => () => {},
    };
}

const PAGE = '<div id="page"><div id="head"></div><p id="first"></p><div id="body"></div></div>';
const PANEL = '<div id="panel"></div>';

/** Runs a page module fresh, then lets its promises settle. */
async function run(module: string, html: string): Promise<string> {
    document.body.innerHTML = html;
    vi.resetModules();
    await import(module);
    for (let i = 0; i < 40; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    return document.body.textContent ?? '';
}

beforeEach(() => {
    opened = [];
    views = [];
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('the dashboard', () => {
    it('gives the verdict, the tiles, what needs attention and the Gateways', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS));
        const text = await run('./overview.js', PAGE);
        expect(text).toContain('7 problems stopping traffic');
        expect(text).toContain('Gateway classes');
        expect(text).toContain('12 HTTP · 1 gRPC · 1 TLS · 1 TCP');
        expect(text).toContain('Orphaned: its Gateway does not exist');
        expect(text).toContain('Where does this URL go?');
        expect(text).toContain('https://shop.example.com/');
        expect(text).toContain('*.apps.example.com');
    });

    it('says plainly when the Gateway API is not installed', async () => {
        vi.stubGlobal('k8sdockside', bridge({ services: [], namespaces: [] }));
        const text = await run('./overview.js', PAGE);
        expect(text).toContain('The Gateway API is not installed here');
        expect(text).not.toContain('problems stopping traffic');
    });

    it('works on an older Gateway API without ListenerSets or the TLS, TCP and UDP routes', async () => {
        const standard = { ...LISTS };
        delete standard.listenersets;
        delete standard.tcproutes;
        delete standard.tlsroutes;
        delete standard.udproutes;
        vi.stubGlobal('k8sdockside', bridge(standard));
        const text = await run('./overview.js', PAGE);
        expect(text).toContain('Gateways');
        expect(text).not.toContain('That did not work');
    });
});

describe('the traffic map', () => {
    it('draws every column, the weights and the broken links', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS));
        const text = await run('./map.js', PAGE);
        for (const word of ['GATEWAYS', 'LISTENERS', 'ROUTES', 'BACKENDS', 'storefront-canary', '90%', '10%', 'no grant', 'missing', 'not allowed', 'old-gateway']) {
            expect(text).toContain(word);
        }
        expect(document.querySelectorAll('.map .node').length).toBeGreaterThan(30);
        expect(document.querySelectorAll('.map .edge.broken').length).toBeGreaterThanOrEqual(4);
    });

    it('opens the object a box stands for', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS));
        await run('./map.js', PAGE);
        const route = [...document.querySelectorAll('.map .node-route')].find((n) => n.textContent?.includes('storefront'))!;
        route.dispatchEvent(new Event('click'));
        expect(opened).toContainEqual({ kind: 'httproutes', namespace: 'shop', name: 'storefront' });
    });

    it('keeps only the paths with problems when asked', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS, null, { 'map.filters': { namespace: '', gatewayId: '', search: '', problemsOnly: true } }));
        const text = await run('./map.js', PAGE);
        expect(text).toContain('billing');
        expect(text).not.toContain('catch-all');
    });
});

describe('where does this URL go', () => {
    it('follows the URL to the split, and offers the header it missed', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS, null, { 'resolve.form': { url: 'https://shop.example.com/api/v1/items', method: 'GET', headers: '', gatewayId: '' } }));
        const text = await run('./resolve.js', PAGE);
        expect(text).toContain('https-shop');
        expect(text).toContain('rule 2 of 5');
        expect(text).toContain('Split between');
        expect(text).toContain('90%');
        expect(text).toContain('storefront-canary');
        expect(text).toContain('set x-shop-tier: api');
        expect(text).toContain('It only just missed');
        expect(text).toContain('Try with x-canary: true');
    });

    it('takes the address the dashboard handed over', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS, null, { 'resolve.url': 'http://shop.example.com/basket' }));
        const text = await run('./resolve.js', PAGE);
        expect(text).toContain('301');
        expect(text).toContain('https://shop.example.com/basket');
    });

    it('says why a refused backend fails', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS, null, { 'resolve.form': { url: 'https://shop.example.com/billing', method: 'GET', headers: '', gatewayId: '' } }));
        const text = await run('./resolve.js', PAGE);
        expect(text).toContain('500');
        expect(text).toContain('No ReferenceGrant in billing');
    });
});

describe('problems', () => {
    it('lists each problem with what to change, grouped by where it is', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS));
        const text = await run('./problems.js', PAGE);
        expect(text).toContain('Listeners');
        expect(text).toContain('Backends');
        expect(text).toContain('Cross-namespace backend without a ReferenceGrant');
        expect(text).toContain('Fix');
        expect(text).toContain('Controller: NotAllowedByListeners');
    });
});

describe('the panels', () => {
    it('draws a Gateway’s listeners and what is attached to them', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS, { kind: 'gateways', namespace: 'infra', name: 'public' }));
        const text = await run('./gateway.js', PANEL);
        expect(text).toContain('Programmed');
        expect(text).toContain('7 listeners');
        expect(text).toContain('https-shop');
        expect(text).toContain('selected namespaces');
        expect(document.querySelector('.map')).not.toBe(null);
    });

    it('draws where a route is attached and each rule', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS, { kind: 'httproutes', namespace: 'shop', name: 'storefront' }));
        const text = await run('./route.js', PANEL);
        expect(text).toContain('Attached to');
        expect(text).toContain('accepted');
        expect(text).toContain('prefix /api · x-canary: true');
        expect(text).toContain('Rewrite');
        expect(text).toContain('Redirect 301');
        expect(text).toContain('2 ready');
    });

    it('says why a refused route is refused', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS, { kind: 'httproutes', namespace: 'shop', name: 'legacy' }));
        const text = await run('./route.js', PANEL);
        expect(text).toContain('not accepted');
        expect(text).toContain('The listener http takes routes only from infra');
        expect(text).toContain('The listener tcp-80 takes TCPRoute, not HTTPRoute.');
    });

    it('draws a GRPCRoute with the same panel', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS, { kind: 'grpcroutes', namespace: 'shop', name: 'checkout' }));
        const text = await run('./route.js', PANEL);
        expect(text).toContain('checkout.v1.Checkout/*');
        expect(text).toContain('grpc.health.v1.Health/Check');
    });

    it('lists the routes that send traffic to a Service', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS, { kind: 'services', namespace: 'shop', name: 'storefront-canary' }));
        const text = await run('./service.js', PANEL);
        expect(text).toContain('shop/storefront');
        expect(text).toContain('rule 2');
        expect(text).toContain('10%');
        expect(text).toContain('through public/https-shop');
    });

    it('says when no route sends traffic to a Service', async () => {
        vi.stubGlobal('k8sdockside', bridge(LISTS, { kind: 'services', namespace: 'kube-system', name: 'kube-dns' }));
        const text = await run('./service.js', PANEL);
        expect(text).toContain('No Gateway API route sends traffic to this Service.');
    });
});
