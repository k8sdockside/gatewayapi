// "Where does this URL go?"
//
// Type an address; the page runs it through the Gateway API's own matching
// rules (src/model/match.ts) against the routes in the cluster, and lays out
// the answer as the path the request takes: the Gateway, the listener, the
// route and rule, what the filters do to it, and where it ends up -- split
// by weight, redirected, or failing with the status it would get.
//
// Under the path it says why: what decided the listener and the rule, what
// else matched and lost, and -- the part people ask for -- which more
// specific rule the request only just missed, with a button that adds the
// header it needed and asks again.

import { exampleUrls, parseRequest, resolve, type Hit, type NearMiss, type Resolution } from '../model/match.js';
import { problems } from '../model/problems.js';
import { topology, type Topology } from '../model/topology.js';
import type { Tone } from '../model/tone.js';
import { ROUTE_WORD } from '../model/types.js';
import { filterWords, modifierWords, ruleMatches } from '../model/words.js';
import { byId, el, replace } from '../ui/dom.js';
import { every, fingerprint, load, remember, start } from '../ui/page.js';
import { backendRow, backendSplit } from '../ui/backends.js';
import { block, clickable, code, dot, heading, nothing, open, openName, percent, pill } from '../ui/parts.js';

const REFRESH = 15_000;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

interface Form {
    url: string;
    method: string;
    headers: string;
    gatewayId: string;
}

start('page', async (ctx) => {
    const head = byId('head');
    const body = byId('body');
    const failure = el('p', { class: 'refresh-failure' });
    const note = `Follow a request through the Gateways in ${ctx.contextName}, by the Gateway API's own matching rules.`;
    replace(head, heading('resolve', 'Where does this URL go?', note));

    const saved = (await remember.get<Form>('resolve.form')) ?? { url: '', method: 'GET', headers: '', gatewayId: '' };
    // The dashboard's URL box hands its address over this way.
    const handed = await remember.get<string>('resolve.url');
    if (handed) {
        saved.url = handed;
        await remember.set('resolve.url', null);
    }

    const url = el('input', { type: 'search', class: 'url-input big', placeholder: 'https://shop.example.com/api/v1', 'aria-label': 'URL', value: saved.url, spellcheck: 'false', autocomplete: 'off' });
    const method = el('select', { 'aria-label': 'Method', class: 'method' }, ...METHODS.map((m) => el('option', { value: m, selected: m === saved.method }, m)));
    const gateway = el('select', { 'aria-label': 'Gateway' });
    const headers = el('textarea', { class: 'headers mono', rows: 3, placeholder: 'x-canary: true\nuser-agent: Mobile', 'aria-label': 'Request headers, one per line', spellcheck: 'false' });
    headers.value = saved.headers;
    const headerToggle = el('button', { type: 'button', class: 'link-button' });
    const headerRow = el('div', { class: 'header-row' }, el('label', { class: 'field-label' }, 'Request headers, one per line'), headers);
    const go = el('button', { type: 'button', class: 'primary' }, 'Follow it');
    const chips = el('div', { class: 'chips' });
    const result = el('div', { class: 'result' });

    const showHeaders = (show: boolean) => {
        headerRow.hidden = !show;
        headerToggle.textContent = show ? 'Hide headers' : saved.headers.trim() ? `Headers (${saved.headers.trim().split('\n').length})` : '+ Headers';
    };
    showHeaders(!!saved.headers.trim());
    headerToggle.addEventListener('click', () => showHeaders(headerRow.hidden !== false));

    const form = el(
        'section',
        { class: 'block ask' },
        el('div', { class: 'url-row' }, method, url, go),
        el('div', { class: 'ask-row' }, el('span', { class: 'field-label' }, 'Through'), gateway, headerToggle, el('span', { class: 'spacer' }), el('span', { class: 'faint small' }, 'No scheme means https. tcp://, udp:// and tls:// reach the other listeners.')),
        headerRow,
        chips,
    );

    let topo: Topology | null = null;
    let last = '';

    const run = () => {
        if (!topo) return;
        const state: Form = { url: url.value, method: method.value, headers: headers.value, gatewayId: gateway.value };
        saved.headers = state.headers;
        void remember.set('resolve.form', state);
        if (!state.url.trim()) {
            replace(result, block('Try an address', 'Type a URL above, or pick one of the hostnames this cluster serves. The answer is worked out from the objects in the cluster; no request is sent.'));
            return;
        }
        const req = parseRequest(state.url, state.method, state.headers);
        if ('error' in req) {
            replace(result, el('div', { class: 'failure' }, req.error));
            return;
        }
        replace(result, answer(resolve(topo, req, state.gatewayId), (h) => {
            headers.value = [headers.value.trim(), h].filter(Boolean).join('\n');
            saved.headers = headers.value;
            showHeaders(true);
            run();
        }));
    };
    go.addEventListener('click', run);
    url.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') run();
    });
    method.addEventListener('change', run);
    gateway.addEventListener('change', run);
    headers.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run();
    });

    const stop = every(
        REFRESH,
        async () => {
            const { snap, installed } = await load();
            failure.textContent = '';
            document.getElementById('first')?.remove();
            const print = fingerprint(snap);
            if (print === last) return;
            last = print;
            if (!installed) {
                replace(body, failure, nothing(`${ctx.contextName} does not serve the Gateway API, so no address leads anywhere.`));
                return;
            }
            topo = topology(snap);
            replace(head, heading('resolve', 'Where does this URL go?', note, problems(topo).length));
            const current = gateway.value || saved.gatewayId;
            replace(gateway, el('option', { value: '' }, 'any Gateway'), ...topo.gateways.map((g) => el('option', { value: g.id, selected: g.id === current }, `${g.namespace}/${g.name}`)));
            gateway.value = topo.gateways.some((g) => g.id === current) ? current : '';
            replace(chips, ...exampleUrls(topo).map((u) => {
                const chip = el('button', { type: 'button', class: 'chip' }, u);
                chip.addEventListener('click', () => {
                    url.value = u;
                    run();
                });
                return chip;
            }));
            if (!body.contains(form)) replace(body, failure, form, result);
            run();
        },
        (err) => {
            failure.textContent = err instanceof Error ? err.message : String(err);
        },
    );
    addEventListener('pagehide', stop);
});

// ----- the answer ------------------------------------------------------------------------------

function answer(res: Resolution, addHeader: (line: string) => void): HTMLElement {
    const req = res.request;
    const stops: HTMLElement[] = [];

    stops.push(
        stop(
            'Request',
            '',
            req.host,
            [`${req.method} ${req.path}${req.query.length ? '?' + new URLSearchParams(req.query).toString() : ''}`, `${req.scheme}${req.port ? ' :' + req.port : ''}`, ...req.headers.map(([n, v]) => `${n}: ${v}`)],
            null,
        ),
    );

    if (res.pick) {
        const g = res.pick.gateway;
        const l = res.pick.listener;
        stops.push(stop('Gateway', g.tone, g.name, [g.namespace + (g.addresses.length ? ` · ${g.addresses[0]}` : ''), `class ${g.className}`], g.ref));
        const why = l.hostname ? (l.hostname.startsWith('*') ? `wildcard ${l.hostname}` : `exact host ${l.hostname}`) : 'takes any host';
        stops.push(stop('Listener', l.tone, l.name, [`${l.protocol} :${l.port}`, why, ...(l.viaSet ? [`from ListenerSet ${l.viaSet}`] : [])], l.owner));
    }
    if (res.hit) {
        const r = res.hit.route;
        stops.push(
            stop(r.type, r.tone, r.name, [r.namespace, `rule ${res.hit.rule.index + 1} of ${r.rules.length}${res.hit.matchIndex >= 0 && (r.obj.spec?.rules?.[res.hit.rule.index]?.matches?.length ?? 0) > 1 ? `, match ${res.hit.matchIndex + 1}` : ''}`, ruleMatches(res.hit.rule, r.type)[Math.max(0, res.hit.matchIndex)] ?? ''], r.ref),
        );
        const f = filterStop(res);
        if (f) stops.push(f);
    }
    stops.push(outcomeStop(res));

    const path = el('div', { class: 'path' });
    stops.forEach((s, i) => {
        if (i) path.append(el('div', { class: `path-arrow${i === stops.length - 1 ? ' last' : ''}`, 'aria-hidden': 'true' }));
        path.append(s);
    });

    return el('div', {}, path, ...details(res, addHeader));
}

function stop(kicker: string, tone: Tone, title: string, lines: string[], ref: Parameters<typeof open>[0]): HTMLElement {
    const node = el(
        'div',
        { class: `stop tone-edge-${tone || 'none'}` },
        el('div', { class: 'stop-kicker' }, dot(tone), kicker),
        el('div', { class: 'stop-title' }, title),
        ...lines.filter(Boolean).map((line) => el('div', { class: 'stop-line' }, line)),
    );
    if (ref) {
        node.title = `Open ${title}`;
        clickable(node, () => open(ref));
    }
    return node;
}

function filterStop(res: Resolution): HTMLElement | null {
    const lines: string[] = [];
    if (res.outcome.kind === 'forward' && res.outcome.rewrite) {
        const rw = res.outcome.rewrite;
        if (rw.host !== res.request.host) lines.push(`host → ${rw.host}`);
        if (rw.path !== res.request.path) lines.push(`path → ${rw.path}`);
    }
    for (const m of res.requestHeaders) lines.push(...modifierWords(m).map((w) => `request: ${w}`));
    for (const m of res.responseHeaders) lines.push(...modifierWords(m).map((w) => `response: ${w}`));
    for (const m of res.mirrors) lines.push(`mirrored to ${m.name}`);
    for (const f of res.otherFilters) {
        const w = filterWords(f);
        lines.push(`${w.kind}${w.text ? ': ' + w.text : ''}`);
    }
    if (!lines.length) return null;
    return stop('Filters', 'info', `${lines.length} change${lines.length === 1 ? '' : 's'}`, lines, null);
}

function outcomeStop(res: Resolution): HTMLElement {
    const o = res.outcome;
    if (o.kind === 'redirect') {
        return el('div', { class: 'stop end tone-edge-info' }, el('div', { class: 'stop-kicker' }, dot('info'), 'Redirect'), el('div', { class: 'stop-title big' }, String(o.status)), el('div', { class: 'stop-line mono' }, o.location));
    }
    if (o.kind === 'fail') {
        return el(
            'div',
            { class: 'stop end tone-edge-error' },
            el('div', { class: 'stop-kicker' }, dot('error'), 'Answer'),
            el('div', { class: 'stop-title big tone-error' }, o.status ? String(o.status) : 'No route'),
            el('div', { class: 'stop-line wrap' }, o.why),
        );
    }
    const list = el('div', { class: 'backends' });
    o.backends.forEach((b, i) => list.append(backendRow(b, i)));
    return el(
        'div',
        { class: `stop end tone-edge-${o.failing > 0 ? 'warn' : 'ok'}` },
        el('div', { class: 'stop-kicker' }, dot(o.failing > 0 ? 'warn' : 'ok'), o.backends.length > 1 ? 'Split between' : 'Sent to'),
        o.backends.length > 1 ? backendSplit(o.backends) : null,
        list,
        o.failing > 0 ? el('div', { class: 'stop-line tone-warn wrap' }, `${percent(o.failing)} of these requests fail: see the backends marked red.`) : null,
    );
}

function details(res: Resolution, addHeader: (line: string) => void): HTMLElement[] {
    const out: HTMLElement[] = [];

    if (res.notes.length) out.push(el('div', { class: 'notes' }, ...res.notes.map((n) => el('p', { class: 'note-line' }, dot('warn'), n))));

    if (res.near.length) {
        out.push(
            block(
                'It only just missed',
                'More specific rules that would have taken this request, and what it would need.',
                el('ul', { class: 'rules-list' }, ...res.near.map((n) => nearRow(n, addHeader))),
            ),
        );
    }

    if (res.hit) {
        const why = el('div', { class: 'why' }, ...res.hit.reasons.map((r) => pill(r, 'info')));
        const lower = res.lower.length ? el('ul', { class: 'rules-list' }, ...res.lower.map(hitRow)) : null;
        out.push(
            block(
                'Why this rule',
                res.lower.length
                    ? `It matched on the things below. ${res.lower.length === 1 ? 'One other rule matched too, and lost' : `${res.lower.length} other rules matched too, and lost`} on the Gateway API's precedence: hostname, then exact path, longest prefix, method, headers, query, then the oldest route.`
                    : 'It matched on the things below, and was the only rule that did.',
                why,
                lower ? el('h3', {}, 'Also matched, lower precedence') : null,
                lower,
            ),
        );
    }

    if (res.pick && !res.hit && res.pick.listener.attachments.length) {
        const l = res.pick.listener;
        out.push(
            block(
                `What the listener ${l.name} does serve`,
                'None of these matched. Their hostnames and paths are what the request would have to fit.',
                el(
                    'ul',
                    { class: 'rules-list' },
                    ...l.attachments.map((a) =>
                        clickable(
                            el('li', { class: 'rule-row' }, dot(a.route.tone), el('span', { class: 'rule-route' }, `${ROUTE_WORD[a.route.type]} ${a.route.namespace}/${a.route.name}`), el('span', { class: 'mono faint' }, a.route.hostnames.join(', ') || 'any host'), el('span', { class: 'faint' }, a.route.rules.flatMap((r) => ruleMatches(r, a.route.type)).slice(0, 3).join(' | '))),
                            () => open(a.route.ref),
                        ),
                    ),
                ),
            ),
        );
    }

    if (res.others.length) {
        out.push(
            block(
                'Other ways in',
                'These Gateways would take the same address too, on their own addresses. Which one a client reaches is up to DNS.',
                el('ul', { class: 'rules-list' }, ...res.others.map((o) => el('li', { class: 'rule-row' }, dot(o.gateway.tone), openName(`${o.gateway.namespace}/${o.gateway.name}`, o.gateway.ref), el('span', { class: 'faint' }, `listener ${o.listener.name} · ${o.listener.protocol} :${o.listener.port} ${o.listener.hostname || 'any host'}`)))),
            ),
        );
    }

    if (!res.pick && res.refused.length) {
        out.push(
            block(
                'Why no Gateway takes it',
                '',
                el('ul', { class: 'rules-list' }, ...res.refused.map((r) => el('li', { class: 'rule-row' }, dot('error'), openName(`${r.gateway.namespace}/${r.gateway.name}`, r.gateway.ref), el('span', { class: 'faint wrap' }, r.why)))),
            ),
        );
    }
    return out;
}

function hitRow(h: Hit): HTMLElement {
    return clickable(
        el('li', { class: 'rule-row' }, dot(h.route.tone), el('span', { class: 'rule-route' }, `${h.route.namespace}/${h.route.name}, rule ${h.rule.index + 1}`), el('span', { class: 'faint' }, h.reasons.join(' · '))),
        () => open(h.route.ref),
    );
}

function nearRow(n: NearMiss, addHeader: (line: string) => void): HTMLElement {
    const target = n.rule.backends.map((b) => b.name).join(', ') || 'a redirect';
    const headerNeeds = n.needs.filter((w) => w.startsWith('header ') && !w.includes(': /')).map((w) => w.slice('header '.length));
    const tryIt = headerNeeds.length ? el('button', { type: 'button', class: 'small-button' }, `Try with ${headerNeeds.join(', ')}`) : null;
    tryIt?.addEventListener('click', (e) => {
        e.stopPropagation();
        for (const h of headerNeeds) addHeader(h);
    });
    return el(
        'li',
        { class: 'rule-row near' },
        dot('info'),
        el('span', { class: 'rule-route' }, `${n.route.namespace}/${n.route.name}, rule ${n.rule.index + 1} → ${target}`),
        el('span', {}, 'needs ', ...n.needs.flatMap((w, i) => [i ? ' and ' : '', code(w)])),
        el('span', { class: 'spacer' }),
        tryIt,
    );
}
