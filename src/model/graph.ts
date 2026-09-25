// The traffic map as a graph, left to right in the order a request travels:
//
//   Gateway -> Listener -> Route -> Backend (with its ready endpoints)
//
// Every path a request can take is one chain through those columns, and the
// graph is the union of the chains. Filtering works on chains, not nodes, so
// searching for a Service keeps the Gateway and listener in front of it --
// a backend on its own answers nothing about how traffic reaches it.
//
// Two things keep a big cluster readable. A listener with more routes than
// `collapseAt` draws them as one group node until it is opened. And a broken
// link is drawn where it breaks: a route its Gateway refused hangs off the
// Gateway itself (it reached no listener), a route whose Gateway does not
// exist hangs off a ghost of it, and a Service that is not there is a ghost
// too -- each joined by a dashed red edge that says why.

import { listenerLine, type BackendView, type GatewayView, type ListenerView, type Ref, type RouteView, type Topology } from './topology.js';
import { toneRank, worst, type Tone } from './tone.js';
import { ROUTE_WORD } from './types.js';

export type NodeType = 'gateway' | 'listener' | 'route' | 'group' | 'backend';

export const COLUMNS = ['Gateways', 'Listeners', 'Routes', 'Backends'] as const;

const COLUMN_OF: Record<NodeType, number> = { gateway: 0, listener: 1, route: 2, group: 2, backend: 3 };

export interface GNode {
    id: string;
    type: NodeType;
    col: number;
    /** A small word above the name: the kind, or the protocol. */
    kicker: string;
    label: string;
    sub: string;
    tone: Tone;
    /** What opens in the app; `null` for a ghost or a group. */
    ref: Ref | null;
    /** Drawn dashed: something that is referred to but not there. */
    ghost: boolean;
    /** Ready and total endpoints, for a Service. */
    ready: { ready: number; total: number } | null;
    /** For a group: how many routes it stands for, and the listener it belongs to. */
    count: number;
    groupOf: string;
    /** What the search box matches, lower-case. */
    text: string;
    /** A longer description for the tooltip. */
    title: string;
}

export interface GEdge {
    id: string;
    from: string;
    to: string;
    tone: Tone;
    /** Drawn dashed and red: the link is broken. */
    broken: boolean;
    /** A short word on the edge: a weight, or why it is broken. */
    label: string;
    title: string;
}

export interface Graph {
    nodes: GNode[];
    edges: GEdge[];
    byId: Map<string, GNode>;
    /** Every chain, as node ids left to right, after filtering and grouping. */
    paths: string[][];
    /** Listeners drawn with their routes folded into a group. */
    collapsed: string[];
    counts: { gateways: number; listeners: number; routes: number; backends: number };
}

export interface GraphOptions {
    namespace: string;
    /** A GatewayView id, or '' for all. */
    gatewayId: string;
    search: string;
    problemsOnly: boolean;
    /** Listener ids opened by hand. */
    expanded: ReadonlySet<string>;
    /** A listener with more routes than this is drawn folded. */
    collapseAt: number;
}

export const DEFAULT_OPTIONS: GraphOptions = { namespace: '', gatewayId: '', search: '', problemsOnly: false, expanded: new Set(), collapseAt: 8 };

export function edgeId(from: string, to: string): string {
    return `${from}->${to}`;
}

function pct(share: number): string {
    const p = share * 100;
    return p >= 10 || p === 0 ? `${Math.round(p)}%` : `${p.toFixed(1).replace(/\.0$/, '')}%`;
}

interface EdgeMeta {
    tones: Tone[];
    broken: boolean;
    labels: Set<string>;
    titles: Set<string>;
}

export function buildGraph(topo: Topology, options: Partial<GraphOptions> = {}): Graph {
    const opt: GraphOptions = { ...DEFAULT_OPTIONS, ...options };
    const nodes = new Map<string, GNode>();
    const meta = new Map<string, EdgeMeta>();
    const chains: string[][] = [];
    /** The listener a route chain runs through, for grouping. */
    const chainListener = new Map<string[], string>();

    const node = (n: Omit<GNode, 'col' | 'text' | 'ghost' | 'ready' | 'count' | 'groupOf' | 'title'> & Partial<Pick<GNode, 'ghost' | 'ready' | 'count' | 'groupOf' | 'title' | 'text'>>): string => {
        if (!nodes.has(n.id)) {
            nodes.set(n.id, {
                ghost: false,
                ready: null,
                count: 0,
                groupOf: '',
                title: '',
                ...n,
                col: COLUMN_OF[n.type],
                text: (n.text ?? `${n.label} ${n.sub} ${n.kicker}`).toLowerCase(),
            });
        }
        return n.id;
    };
    const edge = (from: string, to: string, tone: Tone, broken = false, label = '', title = '') => {
        const id = edgeId(from, to);
        const m = meta.get(id) ?? { tones: [], broken: false, labels: new Set<string>(), titles: new Set<string>() };
        m.tones.push(tone);
        m.broken ||= broken;
        if (label) m.labels.add(label);
        if (title) m.titles.add(title);
        meta.set(id, m);
    };

    const gatewayNode = (g: GatewayView) =>
        node({
            id: g.id,
            type: 'gateway',
            kicker: g.className ? `Gateway · ${g.className}` : 'Gateway',
            label: g.name,
            sub: [g.namespace, g.addresses[0] ?? (g.programmed ? '' : 'no address')].filter(Boolean).join(' · '),
            tone: g.tone,
            ref: g.ref,
            title: `Gateway ${g.namespace}/${g.name}\nclass ${g.className || '—'}\n${g.addresses.length ? 'address ' + g.addresses.join(', ') : 'no address yet'}\nAccepted ${word(g.accepted)} · Programmed ${word(g.programmed)}`,
            text: `${g.name} ${g.namespace} ${g.className} ${g.addresses.join(' ')}`,
        });

    const listenerNode = (l: ListenerView) =>
        node({
            id: l.id,
            type: 'listener',
            kicker: `${l.protocol} :${l.port}`,
            label: l.hostname || 'any host',
            sub: [l.name, l.tlsMode === 'Passthrough' ? 'passthrough' : '', l.viaSet ? `from ${l.viaSet}` : ''].filter(Boolean).join(' · '),
            tone: l.tone,
            ref: l.owner,
            title: `Listener ${l.name} on ${l.gateway.namespace}/${l.gateway.name}\n${listenerLine(l)}\nroutes from: ${l.allowedFrom} namespaces · kinds: ${l.kinds.join(', ') || '—'}${l.status?.attachedRoutes !== undefined ? `\nattached routes (reported): ${l.status.attachedRoutes}` : ''}${l.notes.length ? '\n\n' + l.notes.join('\n') : ''}`,
            text: `${l.name} ${l.hostname} ${l.protocol} ${l.port} ${l.viaSet}`,
        });

    const routeNode = (r: RouteView) =>
        node({
            id: r.id,
            type: 'route',
            kicker: r.type,
            label: r.name,
            sub: [r.namespace, r.hostnames.length ? r.hostnames[0] + (r.hostnames.length > 1 ? ` +${r.hostnames.length - 1}` : '') : r.rules.length ? `${r.rules.length} rule${r.rules.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '),
            tone: r.tone,
            ref: r.ref,
            title: `${r.type} ${r.namespace}/${r.name}\n${r.hostnames.length ? 'hosts ' + r.hostnames.join(', ') : 'any host on its listener'}\n${r.rules.length} rule${r.rules.length === 1 ? '' : 's'}`,
            text: `${r.name} ${r.namespace} ${r.type} ${ROUTE_WORD[r.type]} ${r.hostnames.join(' ')}`,
        });

    const backendNode = (b: BackendView) =>
        node({
            id: `backend:${b.key}`,
            type: 'backend',
            kicker: b.isService ? (b.external ? 'Service · ExternalName' : 'Service') : b.kind,
            label: b.name,
            sub: b.exists === false ? `${b.namespace} · does not exist` : b.external ? `${b.namespace} · ${b.external}` : `${b.namespace}${b.port !== null ? ` · :${b.port}` : ''}`,
            tone: b.exists === false ? 'error' : b.isService && !b.external && b.ready === 0 ? 'error' : b.isService ? 'ok' : '',
            ref: b.exists === false ? null : b.ref,
            ghost: b.exists === false,
            ready: b.ready !== null && b.total !== null ? { ready: b.ready, total: b.total } : null,
            title: `${b.kind} ${b.namespace}/${b.name}${b.exists === false ? ' — does not exist' : ''}${b.ready !== null ? `\n${b.ready} of ${b.total} endpoints ready` : ''}${b.tlsPolicy ? `\nTLS to the backend: BackendTLSPolicy ${b.tlsPolicy}` : ''}`,
            text: `${b.name} ${b.namespace} ${b.kind}`,
        });

    const inGateway = (g: GatewayView) => !opt.gatewayId || g.id === opt.gatewayId;

    // Routes that landed nowhere hang off the Gateway that refused them --
    // drawn right after that Gateway's own routes, so the broken link is
    // short -- or off a ghost of the Gateway that does not exist, or on their
    // own.
    const refusedBy = new Map<string, { route: RouteView; reason: string; message: string }[]>();
    const loose: RouteView[] = [];
    for (const r of topo.routes) {
        if (r.attached) continue;
        let placed = false;
        for (const p of r.parents) {
            if (p.gateway && !p.missing) {
                const list = refusedBy.get(p.gateway.id) ?? [];
                list.push({ route: r, reason: p.reason, message: p.message || p.reason });
                refusedBy.set(p.gateway.id, list);
                placed = true;
            }
        }
        if (!placed) loose.push(r);
    }

    // Gateways and listeners, then the routes on each listener.
    for (const g of topo.gateways) {
        if (!inGateway(g)) continue;
        const gid = gatewayNode(g);
        if (g.listeners.length === 0) chains.push([gid]);
        for (const l of g.listeners) {
            const lid = listenerNode(l);
            edge(gid, lid, l.tone);
            if (l.attachments.length === 0) chains.push([gid, lid]);
            for (const a of l.attachments) {
                const rid = routeNode(a.route);
                edge(lid, rid, a.parent.tone, false, '', a.parent.tone === 'ok' ? 'Accepted' : a.parent.message);
                const tails = backendTails(a.route);
                for (const tail of tails.length ? tails : [[]]) {
                    const chain = [gid, lid, rid, ...tail];
                    chains.push(chain);
                    chainListener.set(chain, lid);
                }
            }
        }
        for (const { route, reason, message } of refusedBy.get(g.id) ?? []) {
            const rid = routeNode(route);
            edge(gid, rid, 'error', true, shortReason(reason), message);
            const tails = backendTails(route);
            for (const tail of tails.length ? tails : [[]]) chains.push([gid, rid, ...tail]);
        }
    }

    for (const r of loose) {
        if (opt.gatewayId) continue;
        const rid = routeNode(r);
        const tails = backendTails(r);
        const heads: string[] = [];
        for (const p of r.parents) {
            if (!p.missing) continue;
            const gid = node({
                id: `ghost:${p.ref.kind}:${p.ref.namespace}/${p.ref.name}`,
                type: 'gateway',
                kicker: p.ref.kind,
                label: p.ref.name,
                sub: `${p.ref.namespace} · does not exist`,
                tone: 'error',
                ref: null,
                ghost: true,
                title: `${p.ref.kind} ${p.ref.namespace}/${p.ref.name} is not in the cluster`,
            });
            edge(gid, rid, 'error', true, 'missing', p.message);
            heads.push(gid);
        }
        for (const head of heads.length ? heads : [null]) {
            for (const tail of tails.length ? tails : [[]]) chains.push([...(head ? [head] : []), rid, ...tail]);
        }
    }

    function backendTails(r: RouteView): string[][] {
        const rid = r.id;
        const out: string[][] = [];
        const seen = new Set<string>();
        for (const rule of r.rules) {
            const live = rule.backends.filter((b) => b.weight > 0);
            const split = live.length > 1;
            for (const b of rule.backends) {
                const bid = backendNode(b);
                const broken = b.exists === false || !b.granted;
                // A route nothing attaches sends nothing: its backend edges
                // are drawn faint, whatever the backend's own health.
                edge(
                    rid,
                    bid,
                    b.weight === 0 || (!r.attached && !broken) ? '' : b.tone,
                    broken,
                    broken ? (b.exists === false ? 'missing' : 'no grant') : split || b.weight === 0 ? pct(b.share) : '',
                    `rule ${rule.index + 1}: ${pct(b.share)} of its traffic${b.problem ? '\n' + b.problem : ''}`,
                );
                if (!seen.has(bid)) {
                    seen.add(bid);
                    out.push([bid]);
                }
            }
        }
        return out;
    }

    // ----- filters, on whole chains --------------------------------------------------

    let kept = chains;
    if (opt.namespace) {
        const ns = opt.namespace;
        kept = kept.filter((c) => c.some((id) => nodeNamespace(nodes.get(id)) === ns));
    }
    if (opt.search.trim()) {
        const words = opt.search.trim().toLowerCase().split(/\s+/);
        kept = kept.filter((c) => words.every((w) => c.some((id) => nodes.get(id)!.text.includes(w))));
    }
    if (opt.problemsOnly) {
        const bad = (c: string[]) =>
            c.some((id) => toneRank(nodes.get(id)!.tone) >= toneRank('warn')) ||
            c.some((id, i) => i > 0 && (meta.get(edgeId(c[i - 1]!, id))?.broken || meta.get(edgeId(c[i - 1]!, id))?.tones.some((t) => toneRank(t) >= toneRank('warn'))));
        kept = kept.filter(bad);
    }

    // ----- grouping ------------------------------------------------------------------------

    const routesPer = new Map<string, Set<string>>();
    for (const c of kept) {
        const lid = chainListener.get(c);
        if (!lid) continue;
        const set = routesPer.get(lid) ?? new Set<string>();
        set.add(c[2]!);
        routesPer.set(lid, set);
    }
    const collapsed: string[] = [];
    for (const [lid, set] of routesPer) {
        if (set.size > opt.collapseAt && !opt.expanded.has(lid)) collapsed.push(lid);
    }
    const folded = new Set(collapsed);
    if (folded.size) {
        kept = kept.map((c) => {
            const lid = chainListener.get(c);
            if (!lid || !folded.has(lid)) return c;
            const members = routesPer.get(lid)!;
            const gid = `group:${lid}`;
            if (!nodes.has(gid)) {
                const tones = [...members].map((id) => nodes.get(id)!.tone);
                const bad = tones.filter((t) => toneRank(t) >= toneRank('warn')).length;
                const types = new Map<string, number>();
                for (const id of members) {
                    const k = nodes.get(id)!.kicker;
                    types.set(k, (types.get(k) ?? 0) + 1);
                }
                node({
                    id: gid,
                    type: 'group',
                    kicker: [...types.entries()].map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(' · '),
                    label: `${members.size} routes`,
                    sub: bad ? `${bad} need${bad === 1 ? 's' : ''} attention · open` : 'all healthy · open',
                    tone: worst(tones),
                    ref: null,
                    count: members.size,
                    groupOf: lid,
                    title: [...members].map((id) => nodes.get(id)!.label).join('\n'),
                    text: [...members].map((id) => nodes.get(id)!.text).join(' '),
                });
            }
            const rid = c[2]!;
            // The route's edges move to the group, merged.
            const into = (from: string, to: string, gfrom: string, gto: string) => {
                const m = meta.get(edgeId(from, to));
                if (!m) return;
                const g = meta.get(edgeId(gfrom, gto)) ?? { tones: [], broken: false, labels: new Set<string>(), titles: new Set<string>() };
                g.tones.push(...m.tones);
                g.broken ||= m.broken;
                meta.set(edgeId(gfrom, gto), g);
            };
            into(c[1]!, rid, c[1]!, gid);
            if (c[3]) into(rid, c[3], gid, c[3]);
            return [c[0]!, c[1]!, gid, ...c.slice(3)];
        });
    }

    // De-duplicate what grouping made identical.
    const seen = new Set<string>();
    kept = kept.filter((c) => {
        const k = c.join('|');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });

    const used = new Set(kept.flat());
    const finalNodes = [...nodes.values()].filter((n) => used.has(n.id));
    const byId = new Map(finalNodes.map((n) => [n.id, n]));
    const edges = new Map<string, GEdge>();
    for (const c of kept) {
        for (let i = 1; i < c.length; i++) {
            const id = edgeId(c[i - 1]!, c[i]!);
            if (edges.has(id)) continue;
            const m = meta.get(id);
            const tone = m ? worst(m.tones.filter((t) => t !== '')) : 'ok';
            edges.set(id, {
                id,
                from: c[i - 1]!,
                to: c[i]!,
                tone: m && m.tones.every((t) => t === '') ? '' : tone,
                broken: m?.broken ?? false,
                label: m ? [...m.labels].join(' · ') : '',
                title: m ? [...m.titles].join('\n') : '',
            });
        }
    }

    return {
        nodes: finalNodes,
        edges: [...edges.values()],
        byId,
        paths: kept,
        collapsed,
        counts: {
            gateways: finalNodes.filter((n) => n.type === 'gateway' && !n.ghost).length,
            listeners: finalNodes.filter((n) => n.type === 'listener').length,
            routes: finalNodes.reduce((sum, n) => sum + (n.type === 'route' ? 1 : n.type === 'group' ? n.count : 0), 0),
            backends: finalNodes.filter((n) => n.type === 'backend').length,
        },
    };
}

function nodeNamespace(n: GNode | undefined): string {
    if (!n) return '';
    if (n.ref) return n.ref.namespace;
    const m = /:([^/:]+)\/[^/]+$/.exec(n.id);
    return m?.[1] ?? '';
}

function word(v: boolean | null): string {
    return v === true ? 'yes' : v === false ? 'no' : '—';
}

/** A condition reason as two or three words, for the edge it breaks. */
export function shortReason(reason: string): string {
    switch (reason) {
        case 'NotAllowedByListeners':
            return 'not allowed';
        case 'NoMatchingListenerHostname':
            return 'hostname mismatch';
        case 'NoMatchingParent':
            return 'no such listener';
        case 'Pending':
            return 'pending';
        default:
            return reason ? 'refused' : '';
    }
}

// ----- lineage ----------------------------------------------------------------------------

export interface Lineage {
    nodes: Set<string>;
    edges: Set<string>;
}

/** Every chain through `id`: the nodes on them and the edges between. */
export function lineage(graph: Graph, id: string): Lineage {
    const out: Lineage = { nodes: new Set(), edges: new Set() };
    for (const p of graph.paths) {
        if (!p.includes(id)) continue;
        p.forEach((n, i) => {
            out.nodes.add(n);
            if (i) out.edges.add(edgeId(p[i - 1]!, n));
        });
    }
    if (!out.nodes.size && graph.byId.has(id)) out.nodes.add(id);
    return out;
}

// ----- layout ------------------------------------------------------------------------------

export interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface Layout {
    boxes: Map<string, Box>;
    columns: { x: number; label: string }[];
    width: number;
    height: number;
}

export const NODE_W = 216;
export const NODE_H = 54;
export const GAP_X = 104;
const GAP_Y = 12;
/** Extra room between the routes of one listener and the next. */
const GROUP_GAP = 14;
export const TOP = 34;

/**
 * Columns left to right; within each, the order the chains come in, and each
 * node pulled level with what it connects to. Routes are the spine -- they
 * are usually the most numerous -- and everything else is centred on them.
 */
export function layoutGraph(graph: Graph, options: { from?: number } = {}): Layout {
    // `from: 1` leaves the Gateways column out -- for a Gateway's own panel,
    // where it would be one box repeating the page it is on.
    const from = options.from ?? 0;
    const cols: string[][] = [[], [], [], []];
    const seen = new Set<string>();
    // Chains in order: gateways as the topology listed them (the paths
    // already are), ghosts last.
    const ordered = [...graph.paths].sort((a, b) => {
        const ga = graph.byId.get(a[0]!)!;
        const gb = graph.byId.get(b[0]!)!;
        return Number(ga.ghost) - Number(gb.ghost) || Number(ga.col !== 0) - Number(gb.col !== 0);
    });
    for (const p of ordered) {
        for (const id of p) {
            if (seen.has(id)) continue;
            seen.add(id);
            cols[graph.byId.get(id)!.col]!.push(id);
        }
    }

    const parents = new Map<string, string[]>();
    const children = new Map<string, string[]>();
    for (const e of graph.edges) {
        (parents.get(e.to) ?? parents.set(e.to, []).get(e.to)!).push(e.from);
        (children.get(e.from) ?? children.set(e.from, []).get(e.from)!).push(e.to);
    }

    const boxes = new Map<string, Box>();
    const x = (col: number) => (col - from) * (NODE_W + GAP_X);
    const centre = (id: string) => {
        const b = boxes.get(id);
        return b ? b.y + b.h / 2 : null;
    };

    const place = (col: number, order: string[], want: (id: string) => number | null, groupOf?: (id: string) => string) => {
        let bottom = TOP - GAP_Y;
        let lastGroup = '';
        for (const id of order) {
            const h = NODE_H;
            const g = groupOf?.(id) ?? '';
            const gap = GAP_Y + (lastGroup && g !== lastGroup ? GROUP_GAP : 0);
            lastGroup = g;
            const w = want(id);
            const y = Math.max(w === null ? -Infinity : w - h / 2, bottom + gap);
            boxes.set(id, { x: x(col), y, w: NODE_W, h });
            bottom = y + h;
        }
    };
    const mean = (ids: string[] | undefined) => {
        const ys = (ids ?? []).map(centre).filter((v): v is number => v !== null);
        return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
    };

    // Routes first, in chain order, grouped by the listener they hang off.
    place(2, cols[2]!, () => null, (id) => (parents.get(id) ?? [])[0] ?? '');
    // Listeners centred on their routes; gateways on their listeners (or on
    // the routes they refused, which hang straight off them).
    place(1, cols[1]!, (id) => mean(children.get(id)));
    if (from === 0) place(0, cols[0]!, (id) => mean(children.get(id)));
    // Backends level with the first route that sends them traffic over a
    // working link, so the healthy paths run straight and a refused route's
    // broken edge is the one that bends.
    const broken = new Set(graph.edges.filter((e) => e.broken).map((e) => e.id));
    // A route every incoming edge of which is broken is one nothing sends
    // traffic through: it does not get to decide where its backends go.
    const refused = (id: string) => {
        const into = parents.get(id) ?? [];
        return into.length > 0 && into.every((p) => broken.has(`${p}->${id}`));
    };
    const anchor = (id: string) => {
        const from = parents.get(id) ?? [];
        const good = from.filter((p) => !broken.has(`${p}->${id}`) && !refused(p));
        const ys = (good.length ? good : from).map(centre).filter((v): v is number => v !== null);
        return ys.length ? Math.min(...ys) : null;
    };
    const backends = [...cols[3]!].sort((a, b) => (anchor(a) ?? 0) - (anchor(b) ?? 0));
    place(3, backends, anchor);

    let height = 0;
    for (const b of boxes.values()) height = Math.max(height, b.y + b.h);
    return {
        boxes,
        columns: COLUMNS.map((label, i) => ({ x: x(i), label })).slice(from),
        width: x(3) + NODE_W,
        height: height + 8,
    };
}
