// Draws a traffic-map graph as SVG.
//
// Colour comes from classes only -- `tone-ok`, `edge-error`, `broken` -- so
// the stylesheet maps them onto the app's tokens and a theme switch needs no
// redraw. Text is set with textContent, like everywhere else: a route name is
// cluster data, and SVG <text> is no safer than HTML for it.
//
// Hovering a node lights up every chain through it and dims the rest, which
// is what makes a busy map readable; clicking opens the object in the app, or
// opens a folded group of routes.

import { GAP_X, lineage, NODE_H, NODE_W, TOP, type GEdge, type GNode, type Graph, type Layout } from '../model/graph.js';
import { el } from './dom.js';
import { clickable, open, svgEl } from './parts.js';

export interface MapOptions {
    /** Called for a group node: open the listener's routes. */
    onExpand?: (listenerId: string) => void;
    /** Leaves out the column headings, for a panel. */
    compact?: boolean;
}

const PAD_X = 14;

function truncate(text: string, n: number): string {
    return text.length > n ? text.slice(0, Math.max(1, n - 1)) + '…' : text;
}

function text(x: number, y: number, cls: string, value: string, extra: Record<string, string | number> = {}): SVGTextElement {
    const t = svgEl('text', { x, y, class: cls, ...extra });
    t.textContent = value;
    return t;
}

function title(value: string): SVGTitleElement {
    const t = svgEl('title');
    t.textContent = value;
    return t;
}

/** A point on the cubic an edge is drawn as, at `t`. */
function bezier(x1: number, y1: number, x2: number, y2: number, t: number): [number, number] {
    const dx = Math.max(40, (x2 - x1) / 2);
    const [c1x, c1y, c2x, c2y] = [x1 + dx, y1, x2 - dx, y2];
    const u = 1 - t;
    return [u * u * u * x1 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x2, u * u * u * y1 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y2];
}

export function drawMap(graph: Graph, layout: Layout, options: MapOptions = {}): SVGSVGElement {
    const top = options.compact ? TOP - 26 : 0;
    const width = layout.width + PAD_X * 2;
    const height = layout.height - top + 6;
    const svg = svgEl('svg', {
        class: options.compact ? 'map compact' : 'map',
        viewBox: `${-PAD_X} ${top} ${width} ${height}`,
        width,
        height,
        role: 'img',
        'aria-label': `Traffic map: ${graph.counts.gateways} gateways, ${graph.counts.listeners} listeners, ${graph.counts.routes} routes, ${graph.counts.backends} backends`,
    });
    svg.style.maxWidth = `${width}px`;

    // Lanes and their headings.
    const lanes = svgEl('g', { class: 'lanes' });
    for (const c of layout.columns) {
        lanes.append(svgEl('rect', { class: 'lane', x: c.x - 8, y: TOP - 10, width: NODE_W + 16, height: Math.max(NODE_H + 20, layout.height - TOP + 12), rx: 14 }));
        if (!options.compact) lanes.append(text(c.x + 4, 16, 'lane-label', c.label.toUpperCase()));
    }
    svg.append(lanes);

    const edgeLayer = svgEl('g', { class: 'edges' });
    const labelLayer = svgEl('g', { class: 'edge-labels' });
    const nodeLayer = svgEl('g', { class: 'nodes' });
    const edgeEls = new Map<string, SVGElement[]>();
    const nodeEls = new Map<string, SVGGElement>();

    for (const e of graph.edges) {
        const a = layout.boxes.get(e.from);
        const b = layout.boxes.get(e.to);
        if (!a || !b) continue;
        const drawn = drawEdge(e, a.x + a.w, a.y + a.h / 2, b.x, b.y + b.h / 2);
        edgeLayer.append(drawn.path);
        if (drawn.label) labelLayer.append(drawn.label);
        edgeEls.set(e.id, [drawn.path, ...(drawn.label ? [drawn.label] : [])]);
    }

    for (const n of graph.nodes) {
        const box = layout.boxes.get(n.id);
        if (!box) continue;
        const g = drawNode(n, box.x, box.y);
        nodeLayer.append(g);
        nodeEls.set(n.id, g);

        const pick = () => {
            if (n.type === 'group') options.onExpand?.(n.groupOf);
            else open(n.ref);
        };
        if (n.type === 'group' || n.ref) clickable(g as unknown as HTMLElement, pick);

        const light = () => {
            const l = lineage(graph, n.id);
            svg.classList.add('focusing');
            for (const [id, node] of nodeEls) node.classList.toggle('lit', l.nodes.has(id));
            for (const [id, parts] of edgeEls) for (const p of parts) p.classList.toggle('lit', l.edges.has(id));
        };
        const dark = () => svg.classList.remove('focusing');
        g.addEventListener('mouseenter', light);
        g.addEventListener('mouseleave', dark);
        g.addEventListener('focus', light);
        g.addEventListener('blur', dark);
    }

    svg.append(edgeLayer, nodeLayer, labelLayer);
    return svg;
}

function drawEdge(e: GEdge, x1: number, y1: number, x2: number, y2: number): { path: SVGPathElement; label: SVGGElement | null } {
    const dx = Math.max(40, (x2 - x1) / 2);
    const cls = ['edge', `edge-${e.broken ? 'error' : e.tone || 'none'}`];
    if (e.broken) cls.push('broken');
    const path = svgEl('path', { d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, class: cls.join(' ') });
    if (e.title) path.append(title(e.title));

    let label: SVGGElement | null = null;
    if (e.label) {
        // In the middle of the gap before the box the edge ends at: never on
        // top of a box it passes, and the labels of a split each sit on
        // their own edge, level with the backend they are for.
        const want = x2 - GAP_X / 2;
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 24; i++) {
            const mid = (lo + hi) / 2;
            if (bezier(x1, y1, x2, y2, mid)[0] < want) lo = mid;
            else hi = mid;
        }
        const [lx, ly] = bezier(x1, y1, x2, y2, lo);
        const w = e.label.length * 6.4 + 14;
        label = svgEl(
            'g',
            { class: `edge-label ${e.broken ? 'edge-label-error' : ''}`, transform: `translate(${lx.toFixed(1)},${ly.toFixed(1)})` },
            svgEl('rect', { x: -w / 2, y: -9, width: w, height: 18, rx: 9 }),
            text(0, 4, '', e.label, { 'text-anchor': 'middle' }),
        );
        if (e.title) label.append(title(e.title));
    }
    return { path, label };
}

function drawNode(n: GNode, x: number, y: number): SVGGElement {
    const cls = ['node', `node-${n.type}`, `tone-${n.tone || 'none'}`];
    if (n.ghost) cls.push('ghost');
    const g = svgEl('g', { class: cls.join(' '), transform: `translate(${x},${y})` });
    g.append(svgEl('rect', { class: 'node-box', width: NODE_W, height: NODE_H, rx: 10 }));
    g.append(svgEl('rect', { class: 'node-bar', x: 5, y: 9, width: 3, height: NODE_H - 18, rx: 1.5 }));

    const right = n.ready ? 64 : 22;
    g.append(text(16, 18, 'node-kicker', truncate(n.kicker.toUpperCase(), Math.floor((NODE_W - 16 - right) / 6.6))));
    g.append(text(16, 35, 'node-label', truncate(n.label, 24)));
    g.append(text(16, 48.5, 'node-sub', truncate(n.sub, n.ready ? 24 : 31)));

    if (n.ready) {
        const tone = n.ready.total === 0 || n.ready.ready === 0 ? 'error' : n.ready.ready < n.ready.total ? 'warn' : 'ok';
        const words = n.ready.total === 0 ? 'no pods' : `${n.ready.ready}/${n.ready.total} ready`;
        const w = words.length * 6 + 16;
        g.append(
            svgEl(
                'g',
                { class: `ready ready-${tone}`, transform: `translate(${NODE_W - w - 8},${NODE_H - 22})` },
                svgEl('rect', { width: w, height: 15, rx: 7.5 }),
                text(w / 2, 11, '', words, { 'text-anchor': 'middle' }),
            ),
        );
        g.append(svgEl('circle', { class: 'node-dot', cx: NODE_W - 13, cy: 14, r: 4 }));
    } else if (n.type === 'group') {
        g.append(text(NODE_W - 14, 36, 'node-open', '+', { 'text-anchor': 'middle' }));
    } else {
        g.append(svgEl('circle', { class: 'node-dot', cx: NODE_W - 13, cy: 14, r: 4 }));
    }

    const tip = n.title || `${n.kicker} ${n.label}`;
    g.append(title(n.ref ? `${tip}\n\nClick to open it.` : n.type === 'group' ? `${tip}\n\nClick to show them one by one.` : tip));
    return g;
}

/** The key under the map: what the line styles mean. */
export function legend(): HTMLElement {
    const sample = (cls: string) => {
        const s = svgEl('svg', { width: 34, height: 10, viewBox: '0 0 34 10', 'aria-hidden': 'true' });
        s.append(svgEl('path', { d: 'M1,5 L33,5', class: `edge ${cls}` }));
        return s;
    };
    const item = (cls: string, words: string) => el('span', { class: 'legend-item' }, sample(cls), words);
    const pillSample = el('span', { class: 'legend-pill' }, '90%');
    return el(
        'div',
        { class: 'map-legend' },
        item('edge-ok', 'healthy'),
        item('edge-warn', 'pending or degraded'),
        item('edge-error broken', 'broken — hover it for why'),
        el('span', { class: 'legend-item' }, pillSample, 'share of a weighted split'),
        el('span', { class: 'legend-item faint' }, 'Hover a box to follow its traffic; click it to open the object.'),
    );
}
