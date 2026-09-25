// "Where does this URL go?" -- the Gateway API's own matching rules, run
// against the routes in the cluster rather than inside a proxy.
//
// The order everything is decided in is the order the API documents:
//
//  1. The listener. Its protocol has to fit the scheme and its port the URL's
//     port; among those, the most specific hostname wins -- exact, then the
//     longer wildcard, then the shorter one, then a listener with none.
//     (Gateway.spec.listeners, "Listeners that are distinct only by Hostname")
//  2. The route. Among the routes attached to that listener, precedence goes
//     to the one whose matching hostname has the most characters when exact,
//     then the most characters at all. (HTTPRoute.spec.hostnames)
//  3. The match. Across every rule of those routes: an Exact path, then the
//     longest PathPrefix, then a method match, then the most header matches,
//     then the most query matches; then the oldest route, then
//     {namespace}/{name} in alphabetical order, then the first rule and match
//     in list order. (HTTPRoute.spec.rules.matches)
//
// GRPCRoutes use their own list: hostname, then characters in the matched
// service, then in the method, then header matches. TLS routes match on the
// hostname alone, and TCP and UDP routes on the port.
//
// A RegularExpression path's precedence is implementation-specific; it is
// ranked below every Exact and PathPrefix match here, and the page says so
// when that decided anything.

import { bySpecificity, effectiveHostnames, hostMatches, isWildcard, normalHost, specificity } from './hostnames.js';
import type { BackendView, GatewayView, ListenerView, RouteView, RuleView, Topology } from './topology.js';
import type { BackendRef, Filter, GRPCMatch, HTTPMatch, HeaderModifier, RouteType } from './types.js';

// ----- the request -------------------------------------------------------------

export type Mode = 'http' | 'grpc' | 'tls' | 'tcp' | 'udp';

export interface Request {
    scheme: string;
    host: string;
    /** The port written in the URL, or `null` when it said none. */
    port: number | null;
    /** The port the scheme implies when none is written. */
    defaultPort: number | null;
    path: string;
    query: [string, string][];
    method: string;
    /** Lower-case names, in the order given. */
    headers: [string, string][];
}

const SCHEMES: Record<string, { protocols: string[]; port: number | null }> = {
    http: { protocols: ['HTTP'], port: 80 },
    https: { protocols: ['HTTPS', 'TLS'], port: 443 },
    grpc: { protocols: ['HTTP'], port: 80 },
    grpcs: { protocols: ['HTTPS'], port: 443 },
    tls: { protocols: ['TLS'], port: null },
    tcp: { protocols: ['TCP'], port: null },
    udp: { protocols: ['UDP'], port: null },
};

/**
 * Reads what the user typed. A URL without a scheme is taken as https,
 * because that is what a browser would try first; `tcp://`, `udp://` and
 * `tls://` reach the other listener types.
 */
export function parseRequest(input: string, method = 'GET', headerText = ''): Request | { error: string } {
    let text = input.trim();
    if (!text) return { error: 'Type a URL, such as https://shop.example.com/api.' };
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'https://' + text;
    const scheme = text.slice(0, text.indexOf(':')).toLowerCase();
    const known = SCHEMES[scheme];
    if (!known) return { error: `${scheme}:// is not something a Gateway listens for. Use http, https, grpc, grpcs, tls, tcp or udp.` };
    // URL only parses the special schemes' hosts the way a browser does, so
    // parse everything as http and put the scheme back.
    let url: URL;
    try {
        url = new URL('http' + text.slice(scheme.length));
    } catch {
        return { error: `That is not a URL: ${input.trim()}` };
    }
    if (!url.hostname) return { error: 'The URL needs a host name.' };
    const headers: [string, string][] = [];
    for (const line of headerText.split('\n')) {
        const at = line.indexOf(':');
        if (at <= 0) continue;
        headers.push([line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()]);
    }
    return {
        scheme,
        host: normalHost(url.hostname),
        port: url.port ? Number(url.port) : null,
        defaultPort: known.port,
        path: url.pathname || '/',
        query: [...url.searchParams.entries()],
        method: (method || 'GET').toUpperCase(),
        headers,
    };
}

// ----- step 1: the listener -------------------------------------------------------

export interface ListenerPick {
    gateway: GatewayView;
    listener: ListenerView;
    /** Whether the listener's port is the one the URL means. */
    portExact: boolean;
    /** Said when the port did not line up, for the page to show. */
    portNote: string;
}

export function pickListener(gateway: GatewayView, req: Request): ListenerPick | { gateway: GatewayView; why: string } {
    const protocols = SCHEMES[req.scheme]?.protocols ?? [];
    let cands = gateway.listeners.filter((l) => protocols.includes(l.protocol.toUpperCase()));
    if (cands.length === 0) return { gateway, why: `It has no ${protocols.join(' or ')} listener.` };

    const hostless = req.scheme === 'tcp' || req.scheme === 'udp';
    if (!hostless) {
        const byHost = cands.filter((l) => hostMatches(l.hostname, req.host));
        if (byHost.length === 0) {
            const names = [...new Set(cands.map((l) => l.hostname).filter(Boolean))];
            return { gateway, why: `None of its ${protocols.join('/')} listeners takes ${req.host}: they are for ${names.join(', ')}.` };
        }
        cands = byHost;
    }

    const want = req.port ?? req.defaultPort;
    let portExact = true;
    let portNote = '';
    const onPort = want === null ? cands : cands.filter((l) => l.port === want);
    if (onPort.length) {
        cands = onPort;
    } else {
        portExact = false;
        const ports = [...new Set(cands.map((l) => l.port))].sort((a, b) => a - b);
        portNote = `The Gateway listens on ${ports.map((p) => ':' + p).join(', ')}, not :${want}. A load balancer or a port-forward in front of it can map one to the other, so this is the listener that would answer.`;
    }

    // The most specific hostname first; HTTPS before TLS passthrough on a
    // tie, and the listener written first after that.
    const order = (l: ListenerView) => protocols.indexOf(l.protocol.toUpperCase());
    const best = [...cands].sort((a, b) => bySpecificity(specificity(a.hostname), specificity(b.hostname)) || order(a) - order(b))[0]!;
    return { gateway, listener: best, portExact, portNote };
}

// ----- step 2 and 3: the route and the rule -----------------------------------------

export interface Hit {
    route: RouteView;
    rule: RuleView;
    /** Which of the rule's matches, or -1 for a rule with none (which matches everything). */
    matchIndex: number;
    /** The route hostname that matched, `''` for a route with none. */
    hostname: string;
    /** Why this one, in words, most important first. */
    reasons: string[];
    /** The prefix a PathPrefix match took, for a rewrite to replace. */
    prefix: string | null;
    score: number[];
    regex: boolean;
}

export interface NearMiss {
    route: RouteView;
    rule: RuleView;
    matchIndex: number;
    /** What the request would also need. */
    needs: string[];
}

export type Outcome =
    | { kind: 'redirect'; status: number; location: string }
    | { kind: 'forward'; backends: BackendView[]; failing: number; rewrite: { host: string; path: string } | null }
    | { kind: 'fail'; status: number; why: string };

export interface Resolution {
    request: Request;
    mode: Mode;
    pick: ListenerPick | null;
    /** Other gateways that would also take the URL -- other addresses, same name. */
    others: ListenerPick[];
    /** Gateways that would not, and why. */
    refused: { gateway: GatewayView; why: string }[];
    hit: Hit | null;
    /** Matches that lost to the hit on precedence. */
    lower: Hit[];
    /** More specific rules the request only just missed. */
    near: NearMiss[];
    outcome: Outcome;
    requestHeaders: HeaderModifier[];
    responseHeaders: HeaderModifier[];
    mirrors: BackendRef[];
    otherFilters: Filter[];
    notes: string[];
}

/**
 * Runs a request through the cluster's Gateways. `gatewayId` narrows it to
 * one Gateway; otherwise every Gateway is tried and the best listener wins,
 * with the rest reported as the other ways in.
 */
export function resolve(topo: Topology, req: Request, gatewayId = ''): Resolution {
    const picks: ListenerPick[] = [];
    const refused: { gateway: GatewayView; why: string }[] = [];
    for (const g of topo.gateways) {
        if (gatewayId && g.id !== gatewayId) continue;
        const p = pickListener(g, req);
        if ('listener' in p) picks.push(p);
        else refused.push(p);
    }
    picks.sort(
        (a, b) =>
            Number(b.portExact) - Number(a.portExact) ||
            bySpecificity(specificity(a.listener.hostname), specificity(b.listener.hostname)) ||
            Number(b.gateway.programmed === true) - Number(a.gateway.programmed === true) ||
            b.listener.attachments.length - a.listener.attachments.length,
    );

    const empty = {
        request: req,
        others: picks.slice(1),
        refused,
        lower: [],
        near: [],
        requestHeaders: [],
        responseHeaders: [],
        mirrors: [],
        otherFilters: [],
        notes: [],
    };
    const pick = picks[0] ?? null;
    if (!pick) {
        return {
            ...empty,
            mode: 'http',
            pick: null,
            hit: null,
            outcome: {
                kind: 'fail',
                status: 0,
                why: topo.gateways.length === 0 ? 'There are no Gateways in this cluster.' : `No Gateway has a listener for ${req.scheme}://${req.host}${req.port ? ':' + req.port : ''}.`,
            },
        };
    }

    const l = pick.listener;
    const protocol = l.protocol.toUpperCase();
    const notes: string[] = [];
    if (pick.portNote) notes.push(pick.portNote);
    if (pick.gateway.programmed === false) notes.push(`The Gateway ${pick.gateway.name} is not Programmed: the data plane may not be serving any of this.`);
    if (l.tone === 'error') notes.push(`The listener ${l.name} has a problem: ${l.notes[0] ?? 'see Problems'}.`);

    let mode: Mode = protocol === 'TLS' ? 'tls' : protocol === 'TCP' ? 'tcp' : protocol === 'UDP' ? 'udp' : 'http';
    const attached = l.attachments.map((a) => a.route);
    let found: { hit: Hit | null; lower: Hit[]; near: NearMiss[] };

    if (mode === 'http') {
        const grpc = grpcPath(req.path);
        const httpFound = matchHTTP(attached.filter((r) => r.type === 'HTTPRoute'), l, req);
        const grpcFound = grpc ? matchGRPC(attached.filter((r) => r.type === 'GRPCRoute'), l, req, grpc) : null;
        // A request shaped like a gRPC call goes to a GRPCRoute when one
        // takes it; anything else is an HTTPRoute's. The API forbids merging
        // the two, so this is a choice between them, not a blend.
        if (grpcFound?.hit && (req.scheme.startsWith('grpc') || !httpFound.hit)) {
            mode = 'grpc';
            found = grpcFound;
        } else {
            found = httpFound;
            if (req.scheme.startsWith('grpc') && !httpFound.hit) mode = 'grpc';
        }
    } else if (mode === 'tls') {
        found = matchHostOnly(attached.filter((r) => r.type === 'TLSRoute'), l, req);
    } else {
        found = matchHostOnly(attached.filter((r) => r.type === (mode === 'tcp' ? 'TCPRoute' : 'UDPRoute')), l, req, true);
    }

    const base: Resolution = {
        ...empty,
        mode,
        pick,
        hit: found.hit,
        lower: found.lower,
        near: found.near,
        notes,
        outcome: { kind: 'fail', status: 404, why: '' },
    };

    if (!found.hit) {
        const routes = attached.length;
        base.outcome = {
            kind: 'fail',
            status: mode === 'http' || mode === 'grpc' ? 404 : 0,
            why:
                routes === 0
                    ? `Nothing is attached to the listener ${l.name}, so it has nowhere to send this.`
                    : `None of the ${routes} route${routes === 1 ? '' : 's'} on the listener ${l.name} matches this request.`,
        };
        return base;
    }

    if (found.hit.regex && found.lower.length) notes.push('A regular-expression path decided this. How those rank against other matches differs between implementations.');
    base.outcome = outcome(found.hit, req, pick, base);
    return base;
}

// ----- HTTP ----------------------------------------------------------------------------

function routeHostname(route: RouteView, l: ListenerView, host: string): { ok: boolean; hostname: string; score: [number, number] } {
    if (route.hostnames.length === 0) return { ok: true, hostname: '', score: [0, 0] };
    const usable = effectiveHostnames(route.hostnames, l.hostname).filter((h) => hostMatches(h, host));
    if (usable.length === 0) return { ok: false, hostname: '', score: [0, 0] };
    const best = [...usable].sort((a, b) => bySpecificity(specificity(a), specificity(b)))[0]!;
    return { ok: true, hostname: best, score: specificity(best) };
}

/** A PathPrefix value the way it is compared: no trailing slash, except `/` itself. */
function prefixOf(value: string): string {
    return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

export function pathMatches(match: HTTPMatch['path'], path: string): { ok: boolean; kind: 'Exact' | 'PathPrefix' | 'RegularExpression'; value: string } {
    const type = match?.type ?? 'PathPrefix';
    const value = match?.value ?? '/';
    if (type === 'Exact') return { ok: path === value, kind: 'Exact', value };
    if (type === 'RegularExpression') {
        try {
            return { ok: new RegExp(`^(?:${value})$`).test(path), kind: 'RegularExpression', value };
        } catch {
            return { ok: false, kind: 'RegularExpression', value };
        }
    }
    // Element-wise: /abc matches /abc, /abc/ and /abc/def, never /abcd.
    const p = prefixOf(value);
    return { ok: p === '/' || path === p || path.startsWith(p + '/'), kind: 'PathPrefix', value: p };
}

function valueMatches(type: string | undefined, want: string, got: string | undefined): boolean {
    if (got === undefined) return false;
    if (type === 'RegularExpression') {
        try {
            return new RegExp(want).test(got);
        } catch {
            return false;
        }
    }
    return got === want;
}

/** Header matches, with only the first of several entries for one name counted, as the API says. */
function distinctHeaders(list: HTTPMatch['headers']): NonNullable<HTTPMatch['headers']> {
    const seen = new Set<string>();
    return (list ?? []).filter((h) => {
        const k = h.name.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

function headerValue(req: Request, name: string): string | undefined {
    const k = name.toLowerCase();
    return req.headers.find(([n]) => n === k)?.[1];
}

function queryValue(req: Request, name: string): string | undefined {
    return req.query.find(([n]) => n === name)?.[1];
}

/** Compares two scores left to right: negative when `a` should win. */
function byScore(a: number[], b: number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const d = (b[i] ?? 0) - (a[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
}

/** The tie-breakers after the score: oldest route, then namespace/name, then rule and match order. */
function byTies(a: Hit | NearMiss, b: Hit | NearMiss): number {
    const ta = Date.parse(a.route.created) || 0;
    const tb = Date.parse(b.route.created) || 0;
    return (
        ta - tb ||
        `${a.route.namespace}/${a.route.name}`.localeCompare(`${b.route.namespace}/${b.route.name}`) ||
        a.rule.index - b.rule.index ||
        a.matchIndex - b.matchIndex
    );
}

function matchHTTP(routes: RouteView[], l: ListenerView, req: Request): { hit: Hit | null; lower: Hit[]; near: NearMiss[] } {
    const hits: Hit[] = [];
    const near: (NearMiss & { score: number[] })[] = [];
    for (const route of routes) {
        const h = routeHostname(route, l, req.host);
        if (!h.ok) continue;
        for (const rule of route.rules) {
            const matches = (rule.rule.matches?.length ? rule.rule.matches : [{}]) as HTTPMatch[];
            matches.forEach((m, i) => {
                const path = pathMatches(m.path, req.path);
                if (!path.ok) return;
                const headers = distinctHeaders(m.headers);
                const query = m.queryParams ?? [];
                const needs: string[] = [];
                if (m.method && m.method.toUpperCase() !== req.method) needs.push(`method ${m.method.toUpperCase()}`);
                for (const hm of headers) {
                    if (!valueMatches(hm.type, hm.value, headerValue(req, hm.name))) needs.push(`header ${hm.name}: ${hm.type === 'RegularExpression' ? `/${hm.value}/` : hm.value}`);
                }
                for (const q of query) {
                    if (!valueMatches(q.type, q.value, queryValue(req, q.name))) needs.push(`query ${q.name}=${q.type === 'RegularExpression' ? `/${q.value}/` : q.value}`);
                }
                const pathClass = path.kind === 'Exact' ? 3 : path.kind === 'PathPrefix' ? 2 : 1;
                const score = [h.score[0], h.score[1], pathClass, path.kind === 'RegularExpression' ? 0 : path.value.length, m.method ? 1 : 0, headers.length, query.length];
                const matchIndex = rule.rule.matches?.length ? i : -1;
                if (needs.length) {
                    near.push({ route, rule, matchIndex, needs, score });
                    return;
                }
                const reasons: string[] = [];
                if (h.hostname) reasons.push(`${isWildcard(h.hostname) ? 'wildcard' : 'exact'} hostname ${h.hostname}`);
                if (path.kind === 'Exact') reasons.push(`exact path ${path.value}`);
                else if (path.kind === 'PathPrefix') reasons.push(path.value === '/' ? 'path prefix / (everything)' : `path prefix ${path.value}`);
                else reasons.push(`path matches /${path.value}/`);
                if (m.method) reasons.push(`method ${m.method.toUpperCase()}`);
                for (const hm of headers) reasons.push(`header ${hm.name}: ${hm.value}`);
                for (const q of query) reasons.push(`query ${q.name}=${q.value}`);
                hits.push({ route, rule, matchIndex, hostname: h.hostname, reasons, prefix: path.kind === 'PathPrefix' ? path.value : null, score, regex: path.kind === 'RegularExpression' });
            });
        }
    }
    return settle(hits, near);
}

function settle(hits: Hit[], near: (NearMiss & { score: number[] })[]): { hit: Hit | null; lower: Hit[]; near: NearMiss[] } {
    hits.sort((a, b) => byScore(a.score, b.score) || byTies(a, b));
    const hit = hits[0] ?? null;
    // Only the near misses that would have won: "send x-canary: true and you
    // get the canary" is useful, "a less specific rule also needs a header" is
    // noise.
    const better = near
        .filter((n) => !hit || byScore(n.score, hit.score) < 0 || (byScore(n.score, hit.score) === 0 && byTies(n, hit) < 0))
        .sort((a, b) => byScore(a.score, b.score) || byTies(a, b))
        .slice(0, 3)
        .map(({ route, rule, matchIndex, needs }) => ({ route, rule, matchIndex, needs }));
    return { hit, lower: hits.slice(1, 6), near: better };
}

// ----- gRPC ------------------------------------------------------------------------------

/** `/pkg.Service/Method` as a service and a method; `null` for a path that is not a gRPC call. */
export function grpcPath(path: string): { service: string; method: string } | null {
    const m = /^\/([^/]+)\/([^/]+)$/.exec(path);
    return m ? { service: m[1]!, method: m[2]! } : null;
}

function matchGRPC(routes: RouteView[], l: ListenerView, req: Request, call: { service: string; method: string }): { hit: Hit | null; lower: Hit[]; near: NearMiss[] } {
    const hits: Hit[] = [];
    const near: (NearMiss & { score: number[] })[] = [];
    for (const route of routes) {
        const h = routeHostname(route, l, req.host);
        if (!h.ok) continue;
        for (const rule of route.rules) {
            const matches = (rule.rule.matches?.length ? rule.rule.matches : [{}]) as GRPCMatch[];
            matches.forEach((m, i) => {
                const mm = m.method;
                const regex = mm?.type === 'RegularExpression';
                const svcOk = !mm?.service || (regex ? safeFull(mm.service, call.service) : mm.service === call.service);
                const methodOk = !mm?.method || (regex ? safeFull(mm.method, call.method) : mm.method === call.method);
                if (!svcOk || !methodOk) return;
                const headers = distinctHeaders(m.headers);
                const needs = headers.filter((hm) => !valueMatches(hm.type, hm.value, headerValue(req, hm.name))).map((hm) => `header ${hm.name}: ${hm.value}`);
                const score = [h.score[0], h.score[1], mm?.service?.length ?? 0, mm?.method?.length ?? 0, headers.length];
                const matchIndex = rule.rule.matches?.length ? i : -1;
                if (needs.length) {
                    near.push({ route, rule, matchIndex, needs, score });
                    return;
                }
                const reasons: string[] = [];
                if (h.hostname) reasons.push(`${isWildcard(h.hostname) ? 'wildcard' : 'exact'} hostname ${h.hostname}`);
                reasons.push(mm?.service ? `service ${mm.service}` : 'any service');
                if (mm?.method) reasons.push(`method ${mm.method}`);
                for (const hm of headers) reasons.push(`header ${hm.name}: ${hm.value}`);
                hits.push({ route, rule, matchIndex, hostname: h.hostname, reasons, prefix: null, score, regex });
            });
        }
    }
    return settle(hits, near);
}

function safeFull(pattern: string, value: string): boolean {
    try {
        return new RegExp(`^(?:${pattern})$`).test(value);
    } catch {
        return false;
    }
}

// ----- TLS, TCP, UDP -----------------------------------------------------------------------

function matchHostOnly(routes: RouteView[], l: ListenerView, req: Request, hostless = false): { hit: Hit | null; lower: Hit[]; near: NearMiss[] } {
    const hits: Hit[] = [];
    for (const route of routes) {
        const h = hostless ? { ok: true, hostname: '', score: [0, 0] as [number, number] } : routeHostname(route, l, req.host);
        if (!h.ok) continue;
        const rule = route.rules[0];
        if (!rule) continue;
        hits.push({ route, rule, matchIndex: -1, hostname: h.hostname, reasons: h.hostname ? [`hostname ${h.hostname} (SNI)`] : hostless ? [`port ${l.port}`] : ['any hostname'], prefix: null, score: [h.score[0], h.score[1]], regex: false });
    }
    return settle(hits, []);
}

// ----- what happens to it ---------------------------------------------------------------------

const WELL_KNOWN: Record<string, number> = { http: 80, https: 443 };

function outcome(hit: Hit, req: Request, pick: ListenerPick, into: Resolution): Outcome {
    const filters = hit.rule.filters;
    for (const f of filters) {
        if (f.type === 'RequestHeaderModifier' && f.requestHeaderModifier) into.requestHeaders.push(f.requestHeaderModifier);
        else if (f.type === 'ResponseHeaderModifier' && f.responseHeaderModifier) into.responseHeaders.push(f.responseHeaderModifier);
        else if (f.type === 'RequestMirror' && f.requestMirror?.backendRef) into.mirrors.push(f.requestMirror.backendRef);
        else if (f.type !== 'RequestRedirect' && f.type !== 'URLRewrite') into.otherFilters.push(f);
    }

    const redirect = filters.find((f) => f.type === 'RequestRedirect')?.requestRedirect;
    if (redirect) {
        const scheme = redirect.scheme ?? (req.scheme === 'grpcs' ? 'https' : req.scheme === 'grpc' ? 'http' : req.scheme);
        const host = redirect.hostname ?? req.host;
        // The API's rule: an explicit port; else the new scheme's well-known
        // port; else the listener's. Left out of the address when it is the
        // scheme's own.
        const port = redirect.port ?? (redirect.scheme ? (WELL_KNOWN[scheme] ?? pick.listener.port) : pick.listener.port);
        const path = rewritePath(redirect.path, req.path, hit.prefix);
        const query = req.query.length ? '?' + new URLSearchParams(req.query).toString() : '';
        const showPort = WELL_KNOWN[scheme] !== port;
        return { kind: 'redirect', status: redirect.statusCode ?? 302, location: `${scheme}://${host}${showPort ? ':' + port : ''}${path}${query}` };
    }

    const rewriteFilter = filters.find((f) => f.type === 'URLRewrite')?.urlRewrite;
    const rewrite = rewriteFilter ? { host: rewriteFilter.hostname ?? req.host, path: rewritePath(rewriteFilter.path, req.path, hit.prefix) } : null;

    const backends = hit.rule.backends;
    if (backends.length === 0) {
        return { kind: 'fail', status: 500, why: 'The rule has no backends and nothing that answers by itself, so the request fails. Implementations answer 500.' };
    }
    const live = backends.filter((b) => b.weight > 0);
    if (live.length === 0) return { kind: 'fail', status: 500, why: 'Every backend of the rule has weight 0, so none of them gets the request.' };
    const broken = live.filter((b) => b.exists === true && b.granted && b.ready === 0);
    const invalid = live.filter((b) => b.exists === false || !b.granted);
    const failing = [...invalid, ...broken].reduce((n, b) => n + b.share, 0);
    if (invalid.length === live.length) {
        return { kind: 'fail', status: 500, why: `The only backend${live.length === 1 ? '' : 's'} of the rule cannot be used: ${invalid[0]!.problem} The API says every request that matches gets a 500.` };
    }
    if (invalid.length + broken.length === live.length) {
        return {
            kind: 'fail',
            status: 503,
            why: `${live.length === 1 ? `The Service ${live[0]!.namespace}/${live[0]!.name} has` : 'None of the backends has'} no ready endpoints, so there is nothing to send the request to. Implementations answer 503.`,
        };
    }
    return { kind: 'forward', backends, failing, rewrite };
}

export function rewritePath(p: { type: string; replaceFullPath?: string; replacePrefixMatch?: string } | undefined, path: string, prefix: string | null): string {
    if (!p) return path;
    if (p.type === 'ReplaceFullPath') return p.replaceFullPath ?? path;
    if (p.type === 'ReplacePrefixMatch' && prefix !== null) {
        const replacement = p.replacePrefixMatch ?? '/';
        const rest = prefix === '/' ? path.slice(1) : path.slice(prefix.length);
        if (!rest) return replacement || '/';
        const joined = replacement.endsWith('/') && rest.startsWith('/') ? replacement + rest.slice(1) : !replacement.endsWith('/') && !rest.startsWith('/') ? `${replacement}/${rest}` : replacement + rest;
        return joined || '/';
    }
    return path;
}

/**
 * Addresses worth offering as examples: one per hostname the attached HTTP
 * routes serve, with the scheme and port of the listener they are on. A
 * wildcard becomes `www.` under it.
 */
export function exampleUrls(topo: Topology, limit = 6): string[] {
    const out: string[] = [];
    for (const l of topo.listeners) {
        const scheme = l.protocol === 'HTTPS' ? 'https' : l.protocol === 'HTTP' ? 'http' : '';
        if (!scheme || l.tone === 'error') continue;
        const port = (scheme === 'https' && l.port !== 443) || (scheme === 'http' && l.port !== 80) ? `:${l.port}` : '';
        for (const a of l.attachments) {
            if (a.route.type !== 'HTTPRoute' || a.parent.tone === 'error') continue;
            for (const h of a.route.hostnames.length ? a.route.hostnames : l.hostname ? [l.hostname] : []) {
                out.push(`${scheme}://${h.replace(/^\*\./, 'www.')}${port}/`);
            }
        }
    }
    return [...new Set(out)].slice(0, limit);
}

/** The route types a mode is about, for the page's wording. */
export const MODE_TYPES: Record<Mode, RouteType> = { http: 'HTTPRoute', grpc: 'GRPCRoute', tls: 'TLSRoute', tcp: 'TCPRoute', udp: 'UDPRoute' };
