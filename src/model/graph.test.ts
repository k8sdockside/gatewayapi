import { describe, expect, it } from 'vitest';
import { snapshot } from '../fixtures.js';
import { buildGraph, edgeId, layoutGraph, lineage, NODE_H } from './graph.js';
import { topology } from './topology.js';

const topo = topology(snapshot());
const id = {
    public: 'gw:infra/public',
    internal: 'gw:infra/internal',
    storefront: 'route:HTTPRoute:shop/storefront',
    legacy: 'route:HTTPRoute:shop/legacy',
    ghost: 'route:HTTPRoute:shop/ghost',
    billing: 'route:HTTPRoute:shop/billing',
    recommendations: 'route:HTTPRoute:shop/recommendations',
    svc: (ns: string, name: string) => `backend:/Service/${ns}/${name}`,
};

describe('the traffic map graph', () => {
    const g = buildGraph(topo);

    it('draws every chain: gateway, listener, route, backend', () => {
        expect(g.byId.get(id.public)!.type).toBe('gateway');
        expect(g.edges.find((e) => e.from === id.storefront && e.to === id.svc('shop', 'storefront'))).toBeTruthy();
        expect(g.counts.gateways).toBe(2);
        expect(g.counts.routes).toBe(15);
    });

    it('labels the weights of a split', () => {
        expect(g.edges.find((e) => e.id === edgeId(id.storefront, id.svc('shop', 'storefront')))!.label).toBe('90%');
        expect(g.edges.find((e) => e.id === edgeId(id.storefront, id.svc('shop', 'storefront-canary')))!.label).toBe('10%');
    });

    it('draws broken links dashed, and says why', () => {
        const refused = g.edges.find((e) => e.id === edgeId(id.internal, id.legacy))!;
        expect(refused.broken).toBe(true);
        expect(refused.label).toBe('not allowed');
        const ghost = g.nodes.find((n) => n.ghost && n.type === 'gateway')!;
        expect(ghost.label).toBe('old-gateway');
        expect(g.edges.find((e) => e.from === ghost.id && e.to === id.ghost)!.broken).toBe(true);
        const missing = g.byId.get(id.svc('shop', 'recommendations'))!;
        expect(missing.ghost).toBe(true);
        expect(g.edges.find((e) => e.to === missing.id)!.label).toBe('missing');
        expect(g.edges.find((e) => e.from === id.billing)!).toMatchObject({ broken: true, label: 'no grant' });
    });

    it('carries the ready endpoints on a Service', () => {
        expect(g.byId.get(id.svc('shop', 'storefront'))!.ready).toEqual({ ready: 2, total: 2 });
        expect(g.byId.get(id.svc('shop', 'search'))!.tone).toBe('error');
    });

    it('filters by namespace, gateway, search and problems, a whole chain at a time', () => {
        const blog = buildGraph(topo, { namespace: 'team-blog' });
        expect(blog.nodes.filter((n) => n.type === 'route').map((n) => n.label).sort()).toEqual(['blog', 'catch-all', 'docs']);
        // The Gateway in front of them stays, though it is in infra.
        expect(blog.byId.has(id.public)).toBe(true);

        const internal = buildGraph(topo, { gatewayId: id.internal });
        expect(internal.nodes.filter((n) => n.type === 'gateway').map((n) => n.label)).toEqual(['internal']);

        const canary = buildGraph(topo, { search: 'canary' });
        expect(canary.nodes.filter((n) => n.type === 'route').map((n) => n.label)).toEqual(['storefront']);

        const bad = buildGraph(topo, { problemsOnly: true });
        const routes = bad.nodes.filter((n) => n.type === 'route').map((n) => n.label);
        expect(routes).toEqual(expect.arrayContaining(['legacy', 'ghost', 'billing', 'recommendations', 'search']));
        expect(routes).not.toContain('blog');
    });

    it('folds a busy listener into a group until it is opened', () => {
        const folded = buildGraph(topo, { collapseAt: 3 });
        const group = folded.nodes.find((n) => n.type === 'group')!;
        expect(group.label).toBe('5 routes');
        expect(group.tone).toBe('error');
        expect(folded.byId.has(id.storefront)).toBe(false);
        expect(folded.counts.routes).toBe(15);
        const opened = buildGraph(topo, { collapseAt: 3, expanded: new Set([group.groupOf]) });
        expect(opened.byId.has(id.storefront)).toBe(true);
    });

    it('lights up the chains through a node', () => {
        const l = lineage(g, id.svc('payments', 'payments-api'));
        expect(l.nodes.has(id.public)).toBe(true);
        expect(l.nodes.has(id.storefront)).toBe(false);
    });
});

describe('layout', () => {
    it('puts columns left to right and never overlaps two nodes in one', () => {
        const g = buildGraph(topo);
        const layout = layoutGraph(g);
        const byCol = new Map<number, { y: number; h: number }[]>();
        for (const n of g.nodes) {
            const b = layout.boxes.get(n.id)!;
            expect(b.x).toBe(layout.columns[n.col]!.x);
            byCol.set(n.col, [...(byCol.get(n.col) ?? []), b]);
        }
        for (const boxes of byCol.values()) {
            boxes.sort((a, b) => a.y - b.y);
            for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.y).toBeGreaterThanOrEqual(boxes[i - 1]!.y + NODE_H);
        }
        expect(layout.height).toBeGreaterThan(0);
    });
});
