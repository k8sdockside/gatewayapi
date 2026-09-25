// The panel on a Gateway: its listeners and what is attached to each, as a
// small traffic map, and the listeners as a table with what is wrong with
// each in words.

import { buildGraph, layoutGraph } from '../model/graph.js';
import { topology } from '../model/topology.js';
import { plural } from '../model/tone.js';
import { byId, el, replace } from '../ui/dom.js';
import { drawMap } from '../ui/map.js';
import { load, remember, start } from '../ui/page.js';
import { dot, nothing, pill } from '../ui/parts.js';

start('panel', async (ctx) => {
    const host = byId('panel');
    const me = ctx.object;
    if (!me) throw new Error('This panel is drawn for a Gateway, and there is none.');
    const { snap } = await load();
    const topo = topology(snap);
    const g = topo.gateways.find((x) => x.namespace === me.namespace && x.name === me.name);
    if (!g) {
        replace(host, nothing('This Gateway is not in the list the cluster returned. It may have just been deleted.'));
        return;
    }

    const routes = new Set(g.listeners.flatMap((l) => l.attachments.map((a) => a.route.id)));
    const refused = topo.routes.filter((r) => !r.attached && r.parents.some((p) => p.gateway === g));
    const state = g.conditions.length === 0 ? pill('no status yet', 'warn') : pill(g.programmed ? 'Programmed' : 'not programmed', g.programmed ? 'ok' : 'error');

    const summary = el(
        'div',
        { class: 'panel-head' },
        state,
        g.accepted === false ? pill('not accepted', 'error') : null,
        el('span', {}, `class ${g.className || '—'}`),
        el('span', { class: 'faint' }, g.addresses.length ? g.addresses.join(', ') : 'no address yet'),
        el('span', { class: 'spacer' }),
        el('span', { class: 'faint' }, `${plural(g.listeners.length, 'listener')} · ${plural(routes.size, 'route')} attached${refused.length ? ` · ${refused.length} refused` : ''}`),
    );

    const graph = buildGraph(topo, { gatewayId: g.id, collapseAt: 6 });
    const map = graph.nodes.length ? el('div', { class: 'map-scroll panel-map' }, drawMap(graph, layoutGraph(graph, { from: 1 }), { compact: true })) : null;

    const table = el(
        'table',
        { class: 'listeners' },
        el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', {}, 'Listener'), el('th', {}, 'Port'), el('th', {}, 'Hostname'), el('th', {}, 'Routes from'), el('th', {}, 'Attached'), el('th', {}, ''))),
        el(
            'tbody',
            {},
            ...g.listeners.map((l) =>
                el(
                    'tr',
                    {},
                    el('td', {}, dot(l.tone)),
                    el('td', {}, el('strong', {}, l.name), l.viaSet ? el('span', { class: 'faint' }, ` · ${l.viaSet}`) : null),
                    el('td', {}, `${l.protocol} :${l.port}${l.tlsMode === 'Passthrough' ? ' (passthrough)' : ''}`),
                    el('td', { class: 'mono' }, l.hostname || 'any'),
                    el('td', {}, l.allowedFrom === 'Selector' ? 'selected namespaces' : l.allowedFrom === 'All' ? 'all namespaces' : 'this namespace'),
                    el('td', {}, String(l.status?.attachedRoutes ?? l.attachments.length)),
                    el('td', { class: 'wrap tone-error' }, l.notes.filter((n) => n !== 'The controller has not reported on this listener.').join(' ')),
                ),
            ),
        ),
    );

    const more = el('button', { type: 'button', class: 'link-button' }, 'Open it on the traffic map →');
    more.addEventListener('click', async () => {
        await remember.set('map.filters', { namespace: '', gatewayId: g.id, search: '', problemsOnly: false });
        await k8sdockside.openView('map');
    });

    replace(host, summary, map, table, el('div', { class: 'panel-foot' }, more));
});
