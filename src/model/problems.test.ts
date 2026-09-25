import { describe, expect, it } from 'vitest';
import { snapshot } from '../fixtures.js';
import { problems, tally } from './problems.js';
import { topology } from './topology.js';

const list = problems(topology(snapshot()));
const about = (text: string) => list.filter((p) => p.subject.includes(text));

describe('problems', () => {
    it('finds every broken thing in the demo, and nothing about the healthy ones', () => {
        const titles = list.map((p) => `${p.title} | ${p.subject}`);
        expect(titles).toEqual(
            expect.arrayContaining([
                expect.stringContaining('Listener conflicts with another | Listener http '),
                expect.stringContaining('Listener conflicts with another | Listener tcp-80 '),
                expect.stringContaining('Not accepted by its Gateway | HTTPRoute shop/legacy'),
                expect.stringContaining('Orphaned: its Gateway does not exist | HTTPRoute shop/ghost'),
                expect.stringContaining('Backend Service is missing | HTTPRoute shop/recommendations'),
                expect.stringContaining('Cross-namespace backend without a ReferenceGrant | HTTPRoute shop/billing'),
                expect.stringContaining('Backend has no ready endpoints | HTTPRoute shop/search'),
            ]),
        );
        for (const healthy of ['storefront', 'payments', 'blog', 'catch-all', 'checkout', 'shop/db', 'shop/cache', 'docs']) {
            expect(about(`/${healthy.replace(/^shop\//, '')}`).filter((p) => !p.subject.includes('→') || p.subject.includes(healthy + ' →'))).toEqual([]);
        }
    });

    it('does not repeat the controller’s ResolvedRefs when it already said why', () => {
        expect(about('shop/recommendations').map((p) => p.title)).toEqual(['Backend Service is missing']);
        expect(about('shop/billing').map((p) => p.title)).toEqual(['Cross-namespace backend without a ReferenceGrant']);
    });

    it('explains each one in words and says what to do', () => {
        const legacy = about('shop/legacy')[0]!;
        expect(legacy.explain).toContain('its own namespace');
        expect(legacy.fix).toContain('allowedRoutes');
        expect(legacy.detail).toContain('NotAllowedByListeners');
        const grant = about('shop/billing')[0]!;
        expect(grant.fix).toContain('ReferenceGrant in billing');
    });

    it('puts errors first', () => {
        const tones = list.map((p) => p.tone);
        expect(tones.indexOf('warn') === -1 || tones.lastIndexOf('error') < tones.indexOf('warn')).toBe(true);
        expect(tally(list).error).toBeGreaterThanOrEqual(7);
    });

    it('notices a Gateway whose class is missing, and a class no controller claimed', () => {
        const snap = snapshot();
        const g = structuredClone(snap.gateways[1]!);
        g.spec!.gatewayClassName = 'nope';
        const cls = { metadata: { name: 'idle' }, spec: { controllerName: 'example.com/none' } };
        const g2 = structuredClone(snap.gateways[0]!);
        g2.spec!.gatewayClassName = 'idle';
        const out = problems(topology({ ...snap, classes: [...snap.classes, cls], gateways: [g2, g] }));
        expect(out.map((p) => p.title)).toContain('Its GatewayClass does not exist');
        expect(out.map((p) => p.title)).toContain('No controller has claimed this class');
    });

    it('calls a Gateway that is not programmed an error, with what AddressNotAssigned means', () => {
        const snap = snapshot();
        const g = structuredClone(snap.gateways[1]!);
        g.status!.conditions = [
            { type: 'Accepted', status: 'True', reason: 'Accepted' },
            { type: 'Programmed', status: 'False', reason: 'AddressNotAssigned', message: 'No addresses have been assigned to the Gateway' },
        ];
        const out = problems(topology({ ...snap, gateways: [snap.gateways[0]!, g] }));
        const p = out.find((x) => x.title === 'Gateway not programmed')!;
        expect(p.tone).toBe('error');
        expect(p.explain).toContain('LoadBalancer');
    });
});
