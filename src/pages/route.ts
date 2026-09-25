// The panel on a route -- HTTP, gRPC, TLS, TCP or UDP: where it is attached,
// what each rule matches and does, and whether the backends behind it can
// take traffic.

import { topology, type ParentView, type RouteView } from '../model/topology.js';
import type { Tone } from '../model/tone.js';
import { ROUTE_KIND, ROUTE_TYPES } from '../model/types.js';
import { filterWords, ruleMatches } from '../model/words.js';
import { byId, el, replace } from '../ui/dom.js';
import { load, remember, start } from '../ui/page.js';
import { backendRow, backendSplit } from '../ui/backends.js';
import { code, dot, nothing, openName, pill } from '../ui/parts.js';

start('panel', async (ctx) => {
    const host = byId('panel');
    const me = ctx.object;
    if (!me) throw new Error('This panel is drawn for a route, and there is none.');
    const type = ROUTE_TYPES.find((t) => ROUTE_KIND[t] === me.kind);
    const { snap } = await load();
    const topo = topology(snap);
    const r = topo.routes.find((x) => x.type === type && x.namespace === me.namespace && x.name === me.name);
    if (!r) {
        replace(host, nothing('This route is not in the list the cluster returned. It may have just been deleted.'));
        return;
    }
    replace(host, attachedTo(r), rules(r), foot(r));
});

function parentState(p: ParentView): [string, Tone] {
    if (p.missing) return ['does not exist', 'error'];
    if (p.accepted === false) return ['not accepted', 'error'];
    if (p.accepted === null) return [p.listeners.length ? 'no status yet' : 'would not attach', p.tone];
    if (p.resolvedRefs === false) return ['accepted, refs unresolved', 'error'];
    return ['accepted', 'ok'];
}

function attachedTo(r: RouteView): HTMLElement {
    const list = el('ul', { class: 'parents' });
    if (r.parents.length === 0) list.append(el('li', { class: 'parent' }, dot('error'), 'It names no parent, so it is attached to nothing.'));
    for (const p of r.parents) {
        const [word, tone] = parentState(p);
        const target = p.listenerSet ? p.listenerSet.ref : p.gateway ? p.gateway.ref : null;
        list.append(
            el(
                'li',
                { class: 'parent' },
                dot(tone),
                el('span', { class: 'faint' }, p.ref.kind),
                openName(`${p.ref.namespace}/${p.ref.name}`, target),
                ...p.listeners.map((l) => pill(`${l.name} · ${l.protocol} :${l.port}${l.hostname ? ' ' + l.hostname : ''}`, l.tone === 'ok' ? 'info' : l.tone)),
                p.listeners.length === 0 && p.ref.sectionName ? pill(p.ref.sectionName, '') : null,
                el('span', { class: 'spacer' }),
                pill(word, tone),
            ),
        );
        if (tone === 'error' || tone === 'warn') list.append(el('li', { class: 'parent-why' }, p.specWhy || p.message || p.reason));
    }
    return el('div', { class: 'panel-section' }, el('h3', {}, 'Attached to'), list);
}

function rules(r: RouteView): HTMLElement {
    const out = el('div', { class: 'panel-section' }, el('h3', {}, r.hostnames.length ? `Rules, for ${r.hostnames.join(', ')}` : 'Rules'));
    if (r.rules.length === 0) out.append(nothing('No rules.'));
    for (const rule of r.rules) {
        const live = rule.backends.filter((b) => b.weight > 0);
        out.append(
            el(
                'div',
                { class: `rule tone-edge-${rule.tone || 'none'}` },
                el('div', { class: 'rule-head' }, el('span', { class: 'rule-index' }, rule.name || `Rule ${rule.index + 1}`), ...ruleMatches(rule, r.type).map((m) => code(m, 'match'))),
                rule.filters.length ? el('div', { class: 'rule-filters' }, ...rule.filters.map((f) => filterPill(f))) : null,
                live.length > 1 ? backendSplit(rule.backends) : null,
                rule.backends.length ? el('div', { class: 'backends' }, ...rule.backends.map((b, i) => backendRow(b, i))) : rule.filters.some((f) => f.type === 'RequestRedirect') ? null : el('p', { class: 'tone-warn small' }, 'No backends and no redirect: every request this rule matches fails.'),
            ),
        );
    }
    return out;
}

function filterPill(f: Parameters<typeof filterWords>[0]): HTMLElement {
    const w = filterWords(f);
    return el('span', { class: 'filter' }, el('strong', {}, w.kind), w.text ? ` ${w.text}` : '');
}

function foot(r: RouteView): HTMLElement | null {
    if (r.type !== 'HTTPRoute' || !r.attached) return null;
    const l = r.parents.flatMap((p) => p.listeners)[0];
    if (!l) return null;
    const hostname = r.hostnames.find((h) => !h.startsWith('*')) ?? (l.hostname && !l.hostname.startsWith('*') ? l.hostname : r.hostnames[0]?.replace(/^\*\./, 'www.') ?? l.hostname?.replace(/^\*\./, 'www.'));
    if (!hostname) return null;
    const first = (r.rules[0]?.rule.matches?.[0] as { path?: { value?: string } } | undefined)?.path?.value ?? '/';
    const scheme = l.protocol === 'HTTPS' ? 'https' : 'http';
    const url = `${scheme}://${hostname}${first.startsWith('/') ? first : '/'}`;
    const b = el('button', { type: 'button', class: 'link-button' }, `Follow ${url} →`);
    b.addEventListener('click', async () => {
        await remember.set('resolve.url', url);
        await k8sdockside.openView('resolve');
    });
    return el('div', { class: 'panel-foot' }, b);
}
