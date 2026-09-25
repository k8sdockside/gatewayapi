import { describe, expect, it } from 'vitest';
import { bySpecificity, effectiveHostnames, hostMatches, hostsIntersect, normalHost, specificity } from './hostnames.js';

describe('hostnames', () => {
    it('normalises a Host header the way it is compared', () => {
        expect(normalHost('Shop.Example.COM:8443')).toBe('shop.example.com');
        expect(normalHost('shop.example.com.')).toBe('shop.example.com');
        expect(normalHost('[::1]')).toBe('[::1]');
    });

    it('matches a wildcard over one or more labels, never the bare domain', () => {
        expect(hostMatches('*.example.com', 'a.example.com')).toBe(true);
        expect(hostMatches('*.example.com', 'a.b.example.com')).toBe(true);
        expect(hostMatches('*.example.com', 'example.com')).toBe(false);
        expect(hostMatches('*.example.com', 'aexample.com')).toBe(false);
        expect(hostMatches('*.example.com', 'a.example.net')).toBe(false);
    });

    it('matches an exact hostname case-insensitively, and an empty one against anything', () => {
        expect(hostMatches('shop.example.com', 'SHOP.example.com')).toBe(true);
        expect(hostMatches('shop.example.com', 'www.shop.example.com')).toBe(false);
        expect(hostMatches('', 'anything.at.all')).toBe(true);
        expect(hostMatches(undefined, 'anything.at.all')).toBe(true);
    });

    it('intersects route and listener hostnames the way the HTTPRoute docs describe', () => {
        // A listener for test.example.com takes routes for it, or for *.example.com.
        expect(hostsIntersect('test.example.com', 'test.example.com')).toBe(true);
        expect(hostsIntersect('*.example.com', 'test.example.com')).toBe(true);
        // A listener for *.example.com takes *.example.com, test and foo.test, not example.com or .net.
        expect(hostsIntersect('*.example.com', '*.example.com')).toBe(true);
        expect(hostsIntersect('foo.test.example.com', '*.example.com')).toBe(true);
        expect(hostsIntersect('example.com', '*.example.com')).toBe(false);
        expect(hostsIntersect('test.example.net', '*.example.com')).toBe(false);
        // Two wildcards meet when one is under the other.
        expect(hostsIntersect('*.a.example.com', '*.example.com')).toBe(true);
        expect(hostsIntersect('*.a.example.com', '*.b.example.com')).toBe(false);
        // Nothing on either side is "any".
        expect(hostsIntersect(undefined, 'x.example.com')).toBe(true);
    });

    it('ignores the route hostnames that do not fit the listener', () => {
        expect(effectiveHostnames(['test.example.com', 'test.example.net'], '*.example.com')).toEqual(['test.example.com']);
        expect(effectiveHostnames(['a.example.com'], '')).toEqual(['a.example.com']);
    });

    it('orders exact before the longer wildcard before the shorter one before none', () => {
        const order = ['', '*.example.com', 'foo.example.com', '*.foo.example.com'].sort((a, b) => bySpecificity(specificity(a), specificity(b)));
        expect(order).toEqual(['foo.example.com', '*.foo.example.com', '*.example.com', '']);
    });
});
