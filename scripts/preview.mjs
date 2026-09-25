// Renders every page of the plugin to standalone HTML, with no cluster and no
// app: the same fixtures the render test uses, the plugin's real stylesheet,
// and the app's real theme tokens written onto :root the way the SDK does.
//
//   node preview.mjs <out-dir>
//
// It is a way to look at the pages, not a test -- the test is
// `npm run test`, which asserts on what this draws.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] ?? path.join(ROOT, 'preview');
const APP = path.resolve(ROOT, '../k8sdockside');

const PAGE = '<div id="page"><div id="head"></div><p id="first"></p><div id="body"></div></div>';
const PANEL = '<div id="panel"></div>';

// [output name, page module, title, 'page' | 'panel', the object a panel is for, what storage holds]
const PAGES = [
    ['overview', 'overview', 'Dashboard', 'page', null, {}],
    ['map', 'map', 'Traffic map', 'page', null, {}],
    ['map-problems', 'map', 'Traffic map, only problems', 'page', null, { 'map.filters': { namespace: '', gatewayId: '', search: '', problemsOnly: true } }],
    ['resolve', 'resolve', 'Where does this URL go? (the canary split)', 'page', null, { 'resolve.form': { url: 'https://shop.example.com/api/v1/items', method: 'GET', headers: '', gatewayId: '' } }],
    ['resolve-redirect', 'resolve', 'Where does this URL go? (a redirect)', 'page', null, { 'resolve.form': { url: 'http://shop.example.com/basket', method: 'GET', headers: '', gatewayId: '' } }],
    ['resolve-fail', 'resolve', 'Where does this URL go? (a refused backend)', 'page', null, { 'resolve.form': { url: 'https://shop.example.com/billing/invoices', method: 'GET', headers: '', gatewayId: '' } }],
    ['problems', 'problems', 'Problems', 'page', null, {}],
    ['gateway', 'gateway', 'Panel: Gateway', 'panel', { kind: 'gateways', namespace: 'infra', name: 'public' }, {}],
    ['route', 'route', 'Panel: HTTPRoute', 'panel', { kind: 'httproutes', namespace: 'shop', name: 'storefront' }, {}],
    ['route-refused', 'route', 'Panel: HTTPRoute that is refused', 'panel', { kind: 'httproutes', namespace: 'shop', name: 'legacy' }, {}],
    ['service', 'service', 'Panel: Service', 'panel', { kind: 'services', namespace: 'shop', name: 'storefront-canary' }, {}],
];

/**
 * Bundles a TypeScript entry point and imports what it exports.
 *
 * The fragment on the end is not decoration: Node caches an ES module by its
 * URL, and a page is imported once per theme with byte-identical code. Import
 * it twice at the same URL and the second import returns the cached module
 * without running it again -- which draws the first theme and leaves every
 * page of the second blank.
 */
let imports = 0;
async function load(entry) {
    const built = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'browser', target: ['es2022'] });
    return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}#${imports++}`);
}

const themes = ['k8sdockside-light', 'k8sdockside-dark'].map((id) => JSON.parse(readFileSync(path.join(APP, 'internal/themes/builtin', `${id}.json`), 'utf8')));

// The same fixtures the render test asserts on, bundled to a module this
// script can import.
const fixtures = await load(path.join(ROOT, 'src/fixtures.ts'));

const css = readFileSync(path.join(ROOT, 'ui/gatewayapi.css'), 'utf8');
const logo = readFileSync(path.join(ROOT, 'ui/logo.svg'), 'utf8');

function stub(theme, object, storage) {
    return {
        ready: async () => ({
            pluginId: 'gatewayapi', viewId: '', sectionId: object ? 'panel' : '', object,
            contextId: 'preview', contextName: 'kind-gatewayapi-demo', readable: [], write: false,
            actions: [], theme,
        }),
        object: async () => null,
        list: async ({ kind }) => {
            if (!(kind in fixtures.LISTS)) throw new Error(`the cluster does not serve ${kind}`);
            return fixtures.LISTS[kind];
        },
        get: async () => null,
        open: async () => null, openView: async () => null, openUrl: async () => null,
        summary: async () => ({ pluginId: 'gatewayapi', installed: true, checked: true, requirements: [], cards: [], error: '' }),
        storage: { get: async (key) => storage[key] ?? null, set: async () => null, remove: async () => null, keys: async () => Object.keys(storage) },
        actions: async () => [], run: async () => ({ created: '' }), resize: async () => null,
        watch: () => () => {}, namespaces: async () => [],
        charts: async () => ({ attached: false, source: {}, charts: [], range: 60 }),
        patch: async () => null, create: async () => ({ name: '' }),
        edit: async () => null, logs: async () => null, on: () => () => {},
    };
}

async function render(page, theme) {
    const [, module, , type, object, storage] = page;
    const win = new Window({ url: 'https://preview.local/' });
    const { document } = win;
    document.body.innerHTML = type === 'panel' ? PANEL : PAGE;
    document.body.className = type === 'panel' ? 'panel' : '';

    // What the SDK does before a page runs: the tokens on :root, and the base
    // recorded so anything keyed on it applies.
    const root = document.documentElement;
    for (const [name, value] of Object.entries(theme.tokens)) root.style.setProperty(`--${name}`, value);
    root.setAttribute('data-theme-base', theme.base);

    // The page expects a browser's globals. Node defines some of these as
    // getters with no setter, so each is defined rather than assigned.
    const globals = ['window', 'document', 'navigator', 'location', 'DOMParser', 'URL', 'URLSearchParams', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'Event', 'KeyboardEvent', 'addEventListener', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'];
    for (const key of globals) {
        if (win[key] === undefined) continue;
        if (key === 'URL' || key === 'URLSearchParams') continue; // Node's own are the real thing
        const value = typeof win[key] === 'function' && key.endsWith('EventListener') ? win[key].bind(win) : win[key];
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
    Object.defineProperty(globalThis, 'k8sdockside', { value: stub(theme, object, storage), configurable: true, writable: true });

    await load(path.join(ROOT, 'src/pages', `${module}.ts`));
    for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 1));

    const html = document.body.innerHTML;
    // Every view polls on an interval, so the window has live timers on it
    // and nothing would ever exit until they are stopped.
    await win.happyDOM.close();
    return html;
}

mkdirSync(OUT, { recursive: true });
const index = [];

for (const page of PAGES) {
    for (const theme of themes) {
        const html = await render(page, theme);
        const file = `${page[0]}.${theme.base}.html`;
        writeFileSync(
            path.join(OUT, file),
            `<!doctype html><html lang="en" data-theme-base="${theme.base}" style="color-scheme:${theme.base};${Object.entries(theme.tokens).map(([k, v]) => `--${k}:${v}`).join(';')}">
<head><meta charset="utf-8"><title>${page[2]} — ${theme.base}</title><style>${css}</style></head>
<body class="${page[3] === 'panel' ? 'panel' : ''}">${html}</body></html>`,
        );
        if (theme.base === 'light') index.push([page[2], page[0]]);
    }
}

writeFileSync(path.join(OUT, 'logo.svg'), logo);
writeFileSync(
    path.join(OUT, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Gateway API plugin preview</title>
<style>body{font:14px/1.6 system-ui;margin:40px auto;max-width:640px;color:#1a1d21}h1{font-size:20px}li{margin:4px 0}a{color:#0b6bcb}</style></head>
<body><h1>Gateway API plugin — page preview</h1>
<p>Every page, drawn against the dev/ demo's objects: a shop with a 90/10 canary split, a cross-namespace backend with and without a ReferenceGrant, a missing Service, one scaled to zero, a refused route, an orphaned one, conflicting listeners, a wildcard listener, a GRPCRoute, a TLSRoute, a TCPRoute and a ListenerSet.</p>
<ul>${index.map(([label, id]) => `<li>${label} — <a href="${id}.light.html">light</a> · <a href="${id}.dark.html">dark</a></li>`).join('')}</ul>
<p style="color:#5c636b">Static HTML. Buttons and links do nothing: there is no app behind them. Hovering the map does, though only in the app.</p></body></html>`,
);
console.log(`wrote ${PAGES.length * 2 + 2} files to ${OUT}`);
console.log(`open ${path.join(OUT, 'index.html')}`);
// Anything the pages left running is irrelevant now that the files are out.
process.exit(0);
