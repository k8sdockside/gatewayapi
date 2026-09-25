// The panel on a Service: the routes that send traffic to it, through which
// Gateways, for which hosts and paths, and for what share -- the question
// "if I change this Service, who notices?" answered from the other end.

import { topology } from '../model/topology.js';
import { plural } from '../model/tone.js';
import { ROUTE_WORD } from '../model/types.js';
import { ruleMatches } from '../model/words.js';
import { byId, el, replace } from '../ui/dom.js';
import { load, start } from '../ui/page.js';
import { code, dot, nothing, openName, percent, pill, readyWords } from '../ui/parts.js';

start('panel', async (ctx) => {
    const host = byId('panel');
    const me = ctx.object;
    if (!me) throw new Error('This panel is drawn for a Service, and there is none.');
    const { snap, installed } = await load();
    if (!installed) {
        replace(host, nothing('This cluster does not serve the Gateway API, so no route sends traffic here.'));
        return;
    }
    const topo = topology(snap);
    const svc = topo.services.get(`${me.namespace}/${me.name}`);
    const uses = svc?.uses ?? [];
    if (uses.length === 0) {
        replace(host, nothing('No Gateway API route sends traffic to this Service.'));
        return;
    }

    const routes = new Set(uses.map((u) => u.route.id));
    const readyTone = !svc ? '' : svc.external ? 'info' : svc.ready === 0 ? 'error' : svc.ready < svc.total ? 'warn' : 'ok';
    const summary = el(
        'div',
        { class: 'panel-head' },
        svc?.external ? pill(`ExternalName ${svc.external}`, 'info') : pill(readyWords(svc?.ready ?? 0, svc?.total ?? 0), readyTone),
        el('span', { class: 'faint' }, `${plural(routes.size, 'route')} send${routes.size === 1 ? 's' : ''} traffic here`),
    );

    const list = el('div', { class: 'uses' });
    for (const u of uses) {
        const via = u.route.parents.flatMap((p) => p.listeners.map((l) => `${l.gateway.name}/${l.name}`));
        const blocked = !u.backend.granted;
        list.append(
            el(
                'div',
                { class: `use tone-edge-${blocked ? 'error' : u.route.attached ? 'ok' : 'warn'}` },
                el(
                    'div',
                    { class: 'use-head' },
                    dot(blocked ? 'error' : u.route.tone),
                    el('span', { class: 'faint' }, ROUTE_WORD[u.route.type]),
                    openName(`${u.route.namespace}/${u.route.name}`, u.route.ref),
                    el('span', { class: 'faint' }, `rule ${u.rule.index + 1}`),
                    el('span', { class: 'spacer' }),
                    el('span', { class: 'backend-share' }, percent(u.backend.share)),
                ),
                el('div', { class: 'use-line' }, ...(u.route.hostnames.length ? u.route.hostnames : ['any host']).map((h) => code(h)), ...ruleMatches(u.rule, u.route.type).map((m) => code(m, 'match'))),
                el(
                    'div',
                    { class: 'use-line faint' },
                    blocked
                        ? el('span', { class: 'tone-error' }, `Refused: no ReferenceGrant in ${me.namespace} lets ${u.route.type}s from ${u.route.namespace} use this Service.`)
                        : u.route.attached
                          ? `through ${via.join(', ')}`
                          : 'The route is not attached to any Gateway, so none of this reaches the Service.',
                ),
            ),
        );
    }
    replace(host, summary, list);
});
