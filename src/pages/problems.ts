// Problems: everything that stops traffic, or will, grouped by where it is.
//
// Each card says what is wrong in words, what to change, and -- when the
// controller said something -- its own reason and message verbatim, so there
// is something exact to search for. The subject opens the object.

import { problems, tally, type Area, type Problem } from '../model/problems.js';
import { topology } from '../model/topology.js';
import { plural } from '../model/tone.js';
import { byId, el, replace } from '../ui/dom.js';
import { every, fingerprint, load, remember, start } from '../ui/page.js';
import { dot, heading, nothing, openName, pill } from '../ui/parts.js';

const REFRESH = 15_000;

const AREAS: [Area, string, string][] = [
    ['class', 'Gateway classes', 'Whether a controller is serving each class.'],
    ['gateway', 'Gateways', 'Whether each Gateway is accepted and programmed.'],
    ['listener', 'Listeners', 'Conflicts, certificates and ListenerSets.'],
    ['route', 'Routes', 'Routes that are not attached, or that the controller could not fully resolve.'],
    ['backend', 'Backends', 'Services that are missing, not allowed, or have no ready endpoints.'],
];

type Severity = 'all' | 'error' | 'warn';

start('page', async (ctx) => {
    const head = byId('head');
    const body = byId('body');
    const failure = el('p', { class: 'refresh-failure' });
    const note = `What stops traffic in ${ctx.contextName}, in plain words, with what to change.`;
    replace(head, heading('problems', 'Problems', note));

    const state = { severity: 'all' as Severity, namespace: '', search: '', ...((await remember.get<{ severity: Severity; namespace: string }>('problems.filters')) ?? {}) };
    let list: Problem[] = [];
    let namespaces: string[] = [];
    let last = '';

    const sev = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Severity' });
    const ns = el('select', { 'aria-label': 'Namespace' });
    const search = el('input', { type: 'search', placeholder: 'Search problems…', 'aria-label': 'Search', spellcheck: 'false' });
    const bar = el('div', { class: 'bar' }, sev, ns, search);
    const out = el('div', {});

    ns.addEventListener('change', () => {
        state.namespace = ns.value;
        void remember.set('problems.filters', { severity: state.severity, namespace: state.namespace });
        draw();
    });
    search.addEventListener('input', () => {
        state.search = search.value;
        draw();
    });

    function draw() {
        const t = tally(list);
        replace(
            sev,
            ...([
                ['all', `All ${list.length}`],
                ['error', `Errors ${t.error}`],
                ['warn', `Warnings ${t.warn}`],
            ] as [Severity, string][]).map(([id, label]) => {
                const b = el('button', { type: 'button', class: state.severity === id ? 'seg here' : 'seg', 'aria-pressed': String(state.severity === id) }, label);
                b.addEventListener('click', () => {
                    state.severity = id;
                    void remember.set('problems.filters', { severity: state.severity, namespace: state.namespace });
                    draw();
                });
                return b;
            }),
        );
        replace(ns, el('option', { value: '' }, 'All namespaces'), ...namespaces.map((n) => el('option', { value: n, selected: n === state.namespace }, n)));
        ns.value = namespaces.includes(state.namespace) ? state.namespace : '';

        const words = state.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const shown = list.filter(
            (p) =>
                (state.severity === 'all' || p.tone === state.severity) &&
                (!ns.value || p.namespace === ns.value || p.subject.includes(` ${ns.value}/`)) &&
                words.every((w) => `${p.title} ${p.subject} ${p.explain} ${p.detail}`.toLowerCase().includes(w)),
        );

        if (list.length === 0) {
            replace(out, el('div', { class: 'all-clear' }, el('span', { class: 'verdict-mark fill-ok' }), el('div', {}, el('div', { class: 'verdict-head tone-ok' }, 'No problems'), el('div', { class: 'verdict-line' }, 'Every Gateway is programmed, every route is attached, and every backend has ready endpoints.'))));
            return;
        }
        if (shown.length === 0) {
            replace(out, nothing('No problem matches the filters.'));
            return;
        }
        const sections: HTMLElement[] = [];
        for (const [area, label, blurb] of AREAS) {
            const mine = shown.filter((p) => p.area === area);
            if (!mine.length) continue;
            sections.push(
                el(
                    'section',
                    { class: 'area' },
                    el('div', { class: 'area-head' }, el('h2', {}, label), el('span', { class: 'count' }, plural(mine.length, 'problem')), el('span', { class: 'faint small' }, blurb)),
                    el('div', { class: 'problem-list' }, ...mine.map(card)),
                ),
            );
        }
        replace(out, ...sections);
    }

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
                replace(body, failure, nothing(`${ctx.contextName} does not serve the Gateway API, so there is nothing here to go wrong.`));
                return;
            }
            const topo = topology(snap);
            list = problems(topo);
            namespaces = [...new Set(list.map((p) => p.namespace).filter(Boolean))].sort();
            replace(head, heading('problems', 'Problems', note, list.length));
            if (!body.contains(out)) replace(body, failure, bar, out);
            draw();
        },
        (err) => {
            failure.textContent = err instanceof Error ? err.message : String(err);
        },
    );
    addEventListener('pagehide', stop);
});

function card(p: Problem): HTMLElement {
    return el(
        'article',
        { class: `problem tone-edge-${p.tone}` },
        el('div', { class: 'problem-head' }, dot(p.tone), el('span', { class: 'problem-title' }, p.title), el('span', { class: 'spacer' }), pill(p.tone === 'error' ? 'error' : 'warning', p.tone)),
        el('div', { class: 'problem-subject' }, openName(p.subject, p.ref)),
        el('p', { class: 'problem-explain' }, p.explain),
        el('p', { class: 'problem-fix' }, el('span', { class: 'fix-label' }, 'Fix'), p.fix),
        p.detail ? el('p', { class: 'problem-detail mono' }, `Controller: ${p.detail}`) : null,
    );
}
