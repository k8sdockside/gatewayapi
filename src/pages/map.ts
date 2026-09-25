// The traffic map: every path a request can take through the cluster's
// Gateways, drawn left to right.
//
// The filters narrow whole paths, never single boxes, so "search for the
// payments Service" still shows the Gateway, listener and route in front of
// it. They are remembered per cluster, and the dashboard's "Show on the
// traffic map" sets the Gateway filter before opening this view.

import { buildGraph, layoutGraph, type GraphOptions } from '../model/graph.js';
import { problems } from '../model/problems.js';
import { topology, type Topology } from '../model/topology.js';
import { plural } from '../model/tone.js';
import { byId, el, replace } from '../ui/dom.js';
import { drawMap, legend } from '../ui/map.js';
import { every, fingerprint, load, remember, start } from '../ui/page.js';
import { heading, nothing } from '../ui/parts.js';

const REFRESH = 15_000;

type Filters = Pick<GraphOptions, 'namespace' | 'gatewayId' | 'search' | 'problemsOnly'>;

start('page', async (ctx) => {
    const head = byId('head');
    const body = byId('body');
    const failure = el('p', { class: 'refresh-failure' });
    const note = `Every path from a Gateway's listeners through the routes to the Services behind them, in ${ctx.contextName}.`;
    replace(head, heading('map', 'Traffic map', note));

    const filters: Filters = { namespace: '', gatewayId: '', search: '', problemsOnly: false, ...((await remember.get<Filters>('map.filters')) ?? {}) };
    const expanded = new Set<string>();
    let expandAll = false;
    let topo: Topology | null = null;
    let lastData = '';

    // The toolbar. Built once, so typing in the search box keeps its focus
    // across redraws.
    const nsSelect = el('select', { 'aria-label': 'Namespace' });
    const gwSelect = el('select', { 'aria-label': 'Gateway' });
    const search = el('input', { type: 'search', placeholder: 'Search hosts, routes, Services…', 'aria-label': 'Search', value: filters.search, spellcheck: 'false' });
    const onlyProblems = el('input', { type: 'checkbox', id: 'only-problems', checked: filters.problemsOnly });
    const counts = el('span', { class: 'count' });
    const unfold = el('button', { type: 'button' });
    const bar = el('div', { class: 'bar' }, nsSelect, gwSelect, search, el('label', { class: 'check', for: 'only-problems' }, onlyProblems, 'Only problems'), el('span', { class: 'spacer' }), counts, unfold);
    const canvas = el('div', { class: 'map-scroll' });
    const key = legend();

    const save = () => void remember.set('map.filters', filters);
    nsSelect.addEventListener('change', () => {
        filters.namespace = nsSelect.value;
        save();
        draw();
    });
    gwSelect.addEventListener('change', () => {
        filters.gatewayId = gwSelect.value;
        save();
        draw();
    });
    let typing: ReturnType<typeof setTimeout> | undefined;
    search.addEventListener('input', () => {
        clearTimeout(typing);
        typing = setTimeout(() => {
            filters.search = search.value;
            save();
            draw();
        }, 150);
    });
    onlyProblems.addEventListener('change', () => {
        filters.problemsOnly = onlyProblems.checked;
        save();
        draw();
    });
    unfold.addEventListener('click', () => {
        expandAll = !expandAll;
        if (!expandAll) expanded.clear();
        draw();
    });

    function options(sel: HTMLSelectElement, values: [string, string][], current: string) {
        replace(sel, ...values.map(([v, label]) => el('option', { value: v, selected: v === current }, label)));
        sel.value = values.some(([v]) => v === current) ? current : '';
    }

    function draw() {
        if (!topo) return;
        options(nsSelect, [['', 'All namespaces'], ...topo.namespaces.map((n): [string, string] => [n, n])], filters.namespace);
        options(gwSelect, [['', 'All Gateways'], ...topo.gateways.map((g): [string, string] => [g.id, `${g.namespace}/${g.name}`])], filters.gatewayId);
        filters.namespace = nsSelect.value;
        filters.gatewayId = gwSelect.value;

        const graph = buildGraph(topo, { ...filters, expanded: expandAll ? new Set(topo.listeners.map((l) => l.id)) : expanded });
        const c = graph.counts;
        counts.textContent = `${plural(c.gateways, 'Gateway')} · ${plural(c.listeners, 'listener')} · ${plural(c.routes, 'route')} · ${plural(c.backends, 'backend')}`;
        unfold.textContent = expandAll ? 'Fold busy listeners' : `Show all routes (${graph.collapsed.length} folded)`;
        unfold.hidden = !expandAll && graph.collapsed.length === 0;

        if (graph.nodes.length === 0) {
            const filtered = filters.namespace || filters.gatewayId || filters.search || filters.problemsOnly;
            const reset = el('button', { type: 'button' }, 'Clear the filters');
            reset.addEventListener('click', () => {
                Object.assign(filters, { namespace: '', gatewayId: '', search: '', problemsOnly: false });
                search.value = '';
                onlyProblems.checked = false;
                save();
                draw();
            });
            replace(
                canvas,
                filtered
                    ? el('div', { class: 'empty-state' }, nothing(filters.problemsOnly && !filters.search ? 'No problems on any path. Everything that is drawn is healthy.' : 'Nothing on the map matches the filters.'), reset)
                    : nothing('There are no Gateways or routes in this cluster yet.'),
            );
            return;
        }
        replace(
            canvas,
            drawMap(graph, layoutGraph(graph), {
                onExpand: (id) => {
                    expanded.add(id);
                    draw();
                },
            }),
        );
    }

    const stop = every(
        REFRESH,
        async () => {
            const { snap, installed } = await load();
            failure.textContent = '';
            document.getElementById('first')?.remove();
            const print = fingerprint(snap);
            if (print === lastData) return;
            lastData = print;
            if (!installed) {
                replace(body, failure, nothing(`${ctx.contextName} does not serve the Gateway API, so there is no traffic to map.`));
                return;
            }
            topo = topology(snap);
            replace(head, heading('map', 'Traffic map', note, problems(topo).length));
            if (!body.contains(canvas)) replace(body, failure, bar, canvas, key);
            draw();
        },
        (err) => {
            failure.textContent = err instanceof Error ? err.message : String(err);
        },
    );
    addEventListener('pagehide', stop);
});
