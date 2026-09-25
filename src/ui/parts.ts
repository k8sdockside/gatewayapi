// The pieces the Gateway API pages are drawn from: tiles, pills, blocks.
//
// They are built from CSS classes rather than colour values, so the app's
// theme tokens colour them and a switch from light to dark needs no
// JavaScript at all.

import type { Ref } from '../model/topology.js';
import type { Tone } from '../model/tone.js';
import { el, replace } from './dom.js';

/** An SVG element, with attributes. SVG needs its own namespace. */
export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...children: (Node | null)[]): SVGElementTagNameMap[K] {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    for (const child of children) if (child) node.append(child);
    return node;
}

/** The plugin's four views, in the order the heading offers them. */
const VIEWS: [string, string][] = [
    ['overview', 'Dashboard'],
    ['map', 'Traffic map'],
    ['resolve', 'Where does this URL go?'],
    ['problems', 'Problems'],
];

/**
 * A page's own heading: the mark, the title, a line under it, and the other
 * views as tabs -- so the map is one click from the URL resolver and neither
 * needs the sidebar.
 */
export function heading(current: string, title: string, note: string, problems: number | null = null): HTMLElement {
    const nav = el('nav', { class: 'tabs', 'aria-label': 'Gateway API views' });
    for (const [id, label] of VIEWS) {
        const here = id === current;
        const tab = el(
            'button',
            { type: 'button', class: here ? 'tab here' : 'tab', 'aria-current': here ? 'page' : undefined },
            label,
            id === 'problems' && problems ? el('span', { class: 'tab-count' }, String(problems)) : null,
        );
        if (!here) tab.addEventListener('click', () => void k8sdockside.openView(id));
        nav.append(tab);
    }
    return el(
        'header',
        { class: 'page-head' },
        el(
            'div',
            { class: 'page-title' },
            el('img', { class: 'mark', src: 'logo.svg', alt: '', width: 28, height: 28 }),
            el('div', {}, el('h1', {}, title), note ? el('p', { class: 'note' }, note) : null),
        ),
        nav,
    );
}

/** A labelled number, the tile the dashboard's top row is built from. */
export function tile(opts: { label: string; value: string; tone?: Tone; parts?: [string, number, Tone][]; note?: string; onPick?: () => void }): HTMLElement {
    const node = el(
        'div',
        { class: `tile tone-edge-${opts.tone || 'none'}` },
        el('div', { class: 'tile-label' }, opts.label),
        el('div', { class: `tile-value tone-${opts.tone || 'none'}` }, opts.value),
        opts.parts?.length
            ? el(
                  'div',
                  { class: 'tile-parts' },
                  ...opts.parts.map(([label, n, tone]) => el('span', { class: `tile-part${n === 0 ? ' zero' : ''}` }, dot(tone), el('strong', {}, String(n)), ` ${label}`)),
              )
            : null,
        opts.note ? el('div', { class: 'tile-note' }, opts.note) : null,
    );
    if (opts.onPick) clickable(node, opts.onPick);
    return node;
}

/** A small coloured label: a status word, a protocol, a count. */
export function pill(text: string, tone: Tone = '', title = ''): HTMLElement {
    return el('span', { class: `pill pill-${tone || 'none'}`, ...(title ? { title } : {}) }, text);
}

/** A coloured dot for a tone. */
export function dot(tone: Tone): HTMLElement {
    return el('span', { class: `dot dot-${tone || 'none'}`, 'aria-hidden': 'true' });
}

/** A section with a heading, an optional sentence, and whatever follows. */
export function block(title: string, note: string, ...children: (Node | null | false)[]): HTMLElement {
    return el(
        'section',
        { class: 'block' },
        el('h2', {}, title),
        note ? el('p', { class: 'note' }, note) : null,
        ...children.filter((c): c is Node => !!c),
    );
}

/** An empty state that says what would have been here. */
export function nothing(message: string): HTMLElement {
    return el('p', { class: 'empty' }, message);
}

/** Replaces a host's contents with a single "still reading" line. */
export function loading(host: HTMLElement, message: string): void {
    replace(host, el('p', { class: 'loading' }, message));
}

/**
 * Makes a row behave like a button: clickable, focusable, and answering the
 * keys a button answers. A <div> that opens something and cannot be reached
 * with a keyboard is a page half the people cannot use.
 */
export function clickable<T extends HTMLElement>(node: T, onPick: () => void): T {
    node.classList.add('pick');
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    node.addEventListener('click', onPick);
    node.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onPick();
        }
    });
    return node;
}

/** Opens an object in the app. */
export function open(ref: Ref | null): void {
    if (ref) void k8sdockside.open({ kind: ref.kind, namespace: ref.namespace || undefined, name: ref.name });
}

/** A button that opens an object in the app, drawn as the name of the thing. */
export function openName(label: string, ref: Ref | null, className = 'name-link'): HTMLElement {
    if (!ref) return el('span', { class: `${className} gone` }, label);
    const node = el('button', { type: 'button', class: className, title: `Open ${label}` }, label);
    node.addEventListener('click', (event) => {
        event.stopPropagation();
        open(ref);
    });
    return node;
}

/** A row of facts: a term and a value each, in two columns. */
export function facts(pairs: [string, Node | string][]): HTMLElement {
    const list = el('dl', { class: 'facts' });
    for (const [term, value] of pairs) list.append(el('dt', {}, term), el('dd', {}, typeof value === 'string' ? value || '—' : value));
    return list;
}

/** Monospace text: a path, a hostname, a header. */
export function code(text: string, className = ''): HTMLElement {
    return el('code', { class: className ? `mono ${className}` : 'mono' }, text);
}

/** How a share is written: 90%, 12.5%, 0%. */
export function percent(share: number): string {
    const p = share * 100;
    return p >= 10 || p === 0 || Number.isInteger(p) ? `${Math.round(p)}%` : `${p.toFixed(1)}%`;
}

/** Ready endpoints as a person reads them: "2 of 2 ready", "no pods ready". */
export function readyWords(ready: number | null, total: number | null): string {
    if (ready === null || total === null) return '';
    if (total === 0) return 'no endpoints';
    if (ready === total) return `${ready} ready`;
    return `${ready} of ${total} ready`;
}

export { el, replace };
