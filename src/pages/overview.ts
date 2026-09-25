// The dashboard: is traffic getting where it should, and if not, where not.
//
//   A verdict       one sentence, coloured by the worst thing in the cluster
//   Four tiles      classes, gateways, routes and problems, each divided by state
//   Needs attention the worst problems, each opening its object
//   A URL box       the quickest way into "Where does this URL go?"
//   The Gateways    each with its addresses and listeners, and a way onto the map
//
// Before any of that: whether the cluster serves the Gateway API at all. A
// dashboard of zeros for a cluster without the CRDs would say "nothing is
// wrong" when the truth is "nothing is here".

import { exampleUrls } from '../model/match.js';
import { problems, tally, type Problem } from '../model/problems.js';
import { topology, type GatewayView, type Topology } from '../model/topology.js';
import { plural, worst, type Tone } from '../model/tone.js';
import { KIND, ROUTE_TYPES, ROUTE_WORD } from '../model/types.js';
import { byId, el, replace } from '../ui/dom.js';
import { every, fingerprint, load, remember, start } from '../ui/page.js';
import { block, clickable, dot, heading, nothing, open, openName, pill, tile } from '../ui/parts.js';

const REFRESH = 15_000;

start('page', async (ctx) => {
    const head = byId('head');
    const body = byId('body');
    const failure = el('p', { class: 'refresh-failure' });
    let last = '';

    replace(head, heading('overview', 'Gateway API', `Gateways, routes and where their traffic goes, in ${ctx.contextName}.`));

    const stop = every(
        REFRESH,
        async () => {
            const { snap, installed } = await load();
            failure.textContent = '';
            document.getElementById('first')?.remove();
            const topo = topology(snap);
            const list = problems(topo);
            const print = fingerprint([installed, snap]);
            if (print === last) return;
            last = print;
            replace(head, heading('overview', 'Gateway API', `Gateways, routes and where their traffic goes, in ${ctx.contextName}.`, list.length));
            if (!installed) {
                replace(body, failure, notInstalled(ctx));
                return;
            }
            replace(body, failure, verdict(topo, list), tiles(topo, list), el('div', { class: 'columns' }, attention(list), urlBox(topo)), gatewayCards(topo));
        },
        (err) => {
            failure.textContent = err instanceof Error ? err.message : String(err);
        },
    );
    addEventListener('pagehide', stop);
});

function notInstalled(ctx: K8sDockside.Context): HTMLElement {
    return block(
        'The Gateway API is not installed here',
        `${ctx.contextName} does not serve gateway.networking.k8s.io, so there are no Gateways or routes to draw. The API is a set of CRDs installed on their own, usually together with an implementation such as Envoy Gateway, Istio, Cilium, NGINX Gateway Fabric or Traefik.`,
        el(
            'div',
            { class: 'links' },
            button('How to install the Gateway API', () => void k8sdockside.openUrl('https://gateway-api.sigs.k8s.io/guides/getting-started/')),
            button('Implementations', () => void k8sdockside.openUrl('https://gateway-api.sigs.k8s.io/implementations/')),
        ),
    );
}

function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
    const b = el('button', { type: 'button', class: cls || undefined }, label);
    b.addEventListener('click', onClick);
    return b;
}

function verdict(topo: Topology, list: Problem[]): HTMLElement {
    const t = tally(list);
    const tone: Tone = t.error ? 'error' : t.warn ? 'warn' : 'ok';
    const routes = topo.routes.length;
    const attached = topo.routes.filter((r) => r.attached).length;
    let headline: string;
    if (topo.gateways.length === 0) headline = 'No Gateways yet';
    else if (t.error) headline = `${plural(t.error, 'problem')} stopping traffic`;
    else if (t.warn) headline = `Traffic is flowing, with ${plural(t.warn, 'thing')} to look at`;
    else headline = 'Every route is attached and every backend is ready';
    const line =
        topo.gateways.length === 0
            ? topo.classes.length
                ? `There ${topo.classes.length === 1 ? 'is a GatewayClass' : `are ${topo.classes.length} GatewayClasses`}, but no Gateway uses one yet.`
                : 'The API is installed, but there is no GatewayClass or Gateway yet.'
            : `${plural(topo.gateways.length, 'Gateway')} with ${plural(topo.listeners.length, 'listener')}; ${attached} of ${plural(routes, 'route')} attached, sending traffic to ${plural(countBackends(topo), 'backend')}.`;
    return el(
        'div',
        { class: `verdict tone-edge-${tone}` },
        el('span', { class: `verdict-mark fill-${tone}`, 'aria-hidden': 'true' }),
        el('div', {}, el('div', { class: `verdict-head tone-${tone}` }, headline), el('div', { class: 'verdict-line' }, line)),
        el('div', { class: 'spacer' }),
        button('Open the traffic map', () => void k8sdockside.openView('map'), 'primary'),
    );
}

function countBackends(topo: Topology): number {
    const set = new Set<string>();
    for (const r of topo.routes) for (const rule of r.rules) for (const b of rule.backends) set.add(b.key);
    return set.size;
}

function tiles(topo: Topology, list: Problem[]): HTMLElement {
    const classesOk = topo.classes.filter((c) => c.accepted === true).length;
    const gwOk = topo.gateways.filter((g) => g.tone === 'ok').length;
    const gwBad = topo.gateways.filter((g) => g.tone === 'error').length;
    const attached = topo.routes.filter((r) => r.attached && r.tone === 'ok').length;
    const degraded = topo.routes.filter((r) => r.attached && r.tone !== 'ok').length;
    const orphans = topo.routes.filter((r) => r.orphan).length;
    const byType = ROUTE_TYPES.map((t) => [t, topo.routes.filter((r) => r.type === t).length] as const).filter(([, n]) => n > 0);
    const t = tally(list);

    return el(
        'div',
        { class: 'tiles' },
        tile({
            label: 'Gateway classes',
            value: String(topo.classes.length),
            tone: topo.classes.some((c) => c.accepted === false) ? 'error' : classesOk < topo.classes.length ? 'warn' : topo.classes.length ? 'ok' : '',
            parts: [
                ['accepted', classesOk, 'ok'],
                ['not accepted', topo.classes.length - classesOk, 'error'],
            ],
            note: [...new Set(topo.classes.map((c) => c.controller))].join(', '),
            onPick: () => void k8sdockside.open({ kind: KIND.classes }),
        }),
        tile({
            label: 'Gateways',
            value: String(topo.gateways.length),
            tone: gwBad ? 'error' : gwOk < topo.gateways.length ? 'warn' : topo.gateways.length ? 'ok' : '',
            parts: [
                ['programmed', gwOk, 'ok'],
                ['pending', topo.gateways.length - gwOk - gwBad, 'warn'],
                ['failing', gwBad, 'error'],
            ],
            note: `${plural(topo.listeners.length, 'listener')}${topo.listenerSets.length ? `, ${plural(topo.listenerSets.length, 'ListenerSet')}` : ''}`,
            onPick: () => void k8sdockside.open({ kind: KIND.gateways }),
        }),
        tile({
            label: 'Routes',
            value: String(topo.routes.length),
            tone: orphans || degraded ? worst(topo.routes.map((r) => r.tone)) : topo.routes.length ? 'ok' : '',
            parts: [
                ['healthy', attached, 'ok'],
                ['degraded', degraded, 'warn'],
                ['not attached', orphans, 'error'],
            ],
            note: byType.map(([type, n]) => `${n} ${ROUTE_WORD[type]}`).join(' · '),
            onPick: () => void k8sdockside.openView('map'),
        }),
        tile({
            label: 'Problems',
            value: String(list.length),
            tone: t.error ? 'error' : t.warn ? 'warn' : 'ok',
            parts: [
                ['errors', t.error, 'error'],
                ['warnings', t.warn, 'warn'],
            ],
            note: list.length ? 'Each one says what to change.' : 'Nothing to fix.',
            onPick: () => void k8sdockside.openView('problems'),
        }),
    );
}

function attention(list: Problem[]): HTMLElement {
    if (list.length === 0) {
        return block('Needs attention', '', nothing('Nothing. Every Gateway is programmed, every route attached, and every backend has ready endpoints.'));
    }
    const rows = el('ul', { class: 'issues' });
    for (const p of list.slice(0, 8)) {
        rows.append(
            clickable(
                el('li', { class: 'issue', title: `${p.explain}\n\nFix: ${p.fix}` }, dot(p.tone), el('span', { class: 'issue-title' }, p.title), el('span', { class: 'issue-detail' }, p.subject)),
                () => open(p.ref),
            ),
        );
    }
    const more = list.length > 8 ? el('button', { type: 'button', class: 'link-button' }, `All ${list.length} problems, with how to fix each →`) : el('button', { type: 'button', class: 'link-button' }, 'How to fix each of them →');
    more.addEventListener('click', () => void k8sdockside.openView('problems'));
    return block('Needs attention', 'Worst first. Each row opens the object it is about.', rows, more);
}

function urlBox(topo: Topology): HTMLElement {
    const input = el('input', { type: 'search', class: 'url-input', placeholder: 'https://shop.example.com/api/v1', 'aria-label': 'URL', spellcheck: 'false' });
    const go = async () => {
        const url = input.value.trim();
        if (!url) return input.focus();
        await remember.set('resolve.url', url);
        await k8sdockside.openView('resolve');
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void go();
    });
    const chips = el('div', { class: 'chips' });
    for (const url of exampleUrls(topo, 4)) {
        const chip = el('button', { type: 'button', class: 'chip' }, url);
        chip.addEventListener('click', () => {
            input.value = url;
            input.focus();
        });
        chips.append(chip);
    }
    return block(
        'Where does this URL go?',
        'Type an address and see which listener takes it, which rule matches, and where the request ends up.',
        el('div', { class: 'url-row' }, input, button('Follow it', () => void go(), 'primary')),
        chips.childElementCount ? chips : null,
    );
}

function gatewayCards(topo: Topology): HTMLElement {
    if (topo.gateways.length === 0) {
        return block('Gateways', '', nothing('No Gateway in this cluster yet. A Gateway is what gives the routes an address to be reached on.'));
    }
    return block('Gateways', 'Each listener with the routes attached to it. Open one on the map to follow its traffic.', el('div', { class: 'grid' }, ...topo.gateways.map(gatewayCard)));
}

function gatewayCard(g: GatewayView): HTMLElement {
    const state = g.conditions.length === 0 ? pill('no status', 'warn') : g.programmed ? pill('Programmed', 'ok') : pill('not programmed', g.tone === 'error' ? 'error' : 'warn');
    const listeners = el('ul', { class: 'listener-list' });
    for (const l of g.listeners) {
        const n = l.status?.attachedRoutes ?? l.attachments.length;
        listeners.append(
            el(
                'li',
                { class: 'listener-row', title: l.notes.join('\n') || undefined },
                dot(l.tone),
                el('span', { class: 'listener-proto' }, `${l.protocol} :${l.port}`),
                el('span', { class: 'listener-host mono' }, l.hostname || 'any host'),
                l.viaSet ? el('span', { class: 'tag', title: `From the ListenerSet ${l.viaSet}` }, 'set') : null,
                el('span', { class: 'listener-count' }, plural(n, 'route')),
            ),
        );
    }
    const onMap = el('button', { type: 'button', class: 'link-button' }, 'Show on the traffic map →');
    onMap.addEventListener('click', async () => {
        await remember.set('map.filters', { namespace: '', gatewayId: g.id, search: '', problemsOnly: false });
        await k8sdockside.openView('map');
    });
    const tone = worst([g.tone, ...g.listeners.map((l) => l.tone)]);
    return el(
        'article',
        { class: `card tone-edge-${tone || 'none'}` },
        el('div', { class: 'card-head' }, openName(g.name, g.ref, 'card-name'), el('span', { class: 'faint' }, g.namespace), el('span', { class: 'spacer' }), state),
        el('p', { class: 'card-sub' }, `class ${g.className || '—'}`, g.addresses.length ? ` · ${g.addresses.join(', ')}` : ' · no address yet'),
        listeners,
        g.listeners.length === 0 ? nothing('No listeners.') : null,
        el('div', { class: 'card-foot' }, onMap),
    );
}

