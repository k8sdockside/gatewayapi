// Hostnames, the way the Gateway API reads them.
//
// Three rules, all from the API's own field documentation:
//
//  - `*.example.com` is a suffix match over one or more labels: it matches
//    `a.example.com` and `a.b.example.com`, never `example.com` itself.
//  - A listener with no hostname matches every host.
//  - When several things could match, exact beats wildcard, a longer wildcard
//    beats a shorter one, and anything beats no hostname at all.

/** Lower-case, no trailing dot, no port: how a Host header is compared. */
export function normalHost(host: string): string {
    let h = host.trim().toLowerCase();
    // An IPv6 literal keeps its brackets; anything else loses a :port.
    if (!h.startsWith('[')) h = h.replace(/:\d+$/, '');
    return h.replace(/\.$/, '');
}

export function isWildcard(pattern: string): boolean {
    return pattern.startsWith('*.');
}

/**
 * Whether a concrete host matches a hostname pattern. An empty pattern
 * matches everything -- a listener or route that names no hostname.
 */
export function hostMatches(pattern: string | undefined, host: string): boolean {
    if (!pattern) return true;
    const p = normalHost(pattern);
    const h = normalHost(host);
    if (isWildcard(p)) {
        const suffix = p.slice(1); // ".example.com"
        return h.length > suffix.length && h.endsWith(suffix);
    }
    return p === h;
}

/**
 * Whether a route hostname and a listener hostname have any host in common --
 * the test for a route being allowed to attach to a listener. Either side may
 * be a wildcard; empty on either side means "any".
 */
export function hostsIntersect(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) return true;
    const x = normalHost(a);
    const y = normalHost(b);
    if (x === y) return true;
    if (isWildcard(x) && isWildcard(y)) {
        // *.a.example.com and *.example.com share a.b.a.example.com.
        return x.endsWith(y.slice(1)) || y.endsWith(x.slice(1));
    }
    if (isWildcard(x)) return hostMatches(x, y);
    if (isWildcard(y)) return hostMatches(y, x);
    return false;
}

/**
 * How specific a hostname is, as a pair to compare left to right: characters
 * in it when it is exact (0 for a wildcard), then characters in it at all.
 * That is the order the HTTPRoute docs give for choosing between routes, and
 * it also puts listeners in the order their docs give -- exact, then the
 * longer wildcard, then the shorter one, then none.
 */
export function specificity(pattern: string | undefined): [number, number] {
    if (!pattern) return [0, 0];
    const p = normalHost(pattern);
    return [isWildcard(p) ? 0 : p.length, p.length];
}

/** Compares two specificities: negative when `a` is more specific. */
export function bySpecificity(a: [number, number], b: [number, number]): number {
    return b[0] - a[0] || b[1] - a[1];
}

/**
 * The route hostnames that count on a listener: the ones that intersect the
 * listener's own. The API says the rest "MUST be ignored". An empty result
 * with a non-empty input means the route cannot attach there at all.
 */
export function effectiveHostnames(routeHosts: readonly string[], listenerHost: string | undefined): string[] {
    if (!listenerHost) return [...routeHosts];
    return routeHosts.filter((h) => hostsIntersect(h, listenerHost));
}
