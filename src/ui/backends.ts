// A rule's backends, drawn the same way on the resolver and the route panel:
// a bar split by weight, and a row per backend with its share, where it is,
// and whether it can take traffic.
//
// Each healthy backend gets one of the app's chart colours, in order, so the
// bar and the rows under it can be matched by eye; a backend that cannot
// take traffic is drawn in the error colour instead, whatever its place.

import type { BackendView } from '../model/topology.js';
import { el } from './dom.js';
import { openName, percent, pill, readyWords } from './parts.js';

/** The fill class for a backend: its chart colour, or what is wrong with it. */
export function backendFill(b: BackendView, index: number): string {
    if (b.weight === 0) return 'fill-none';
    if (b.tone === 'error') return 'fill-error';
    if (b.tone === 'warn') return 'fill-warn';
    return `fill-chart-${(index % 8) + 1}`;
}

/** The bar a split is drawn as. Only worth drawing for more than one backend. */
export function backendSplit(backends: BackendView[]): HTMLElement {
    const bar = el('div', { class: 'split', role: 'img', 'aria-label': backends.map((b) => `${b.name} ${percent(b.share)}`).join(', ') });
    backends.forEach((b, i) => {
        if (b.share <= 0) return;
        const piece = el('span', { class: `split-part ${backendFill(b, i)}`, title: `${b.name}: ${percent(b.share)}` });
        piece.style.width = `${b.share * 100}%`;
        bar.append(piece);
    });
    return bar;
}

export function backendRow(b: BackendView, index: number): HTMLElement {
    const state =
        b.exists === false
            ? pill('missing', 'error')
            : !b.granted
              ? pill('no ReferenceGrant', 'error')
              : b.external
                ? pill(`ExternalName ${b.external}`, 'info')
                : b.ready !== null
                  ? pill(readyWords(b.ready, b.total), b.ready === 0 ? 'error' : b.ready < (b.total ?? 0) ? 'warn' : 'ok')
                  : pill(b.kind, '');
    return el(
        'div',
        { class: 'backend-row', title: b.problem || undefined },
        el('span', { class: `swatch ${backendFill(b, index)}`, 'aria-hidden': 'true' }),
        el('span', { class: 'backend-share' }, percent(b.share)),
        openName(b.name, b.exists === false ? null : b.ref),
        el('span', { class: 'faint' }, `${b.namespace}${b.port !== null ? ':' + b.port : ''}${b.crossNamespace ? ' · other namespace' : ''}`),
        el('span', { class: 'spacer' }),
        b.tlsPolicy ? pill('TLS', 'info', `BackendTLSPolicy ${b.tlsPolicy}: the Gateway speaks TLS to it`) : null,
        state,
    );
}
