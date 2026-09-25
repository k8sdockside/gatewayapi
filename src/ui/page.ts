// The things every page in this plugin does the same way.
//
//  1. `start` wraps the page in one try/catch. Every bridge call rejects with
//     an Error carrying a sentence written for a person, so the honest thing
//     to do with a failure is show that sentence -- not a blank page and a
//     console nobody can open, because the page is in a sandboxed frame.
//  2. `load` reads everything the model needs in one go. The Gateway API is
//     optional in a cluster, and so is each of its kinds: an older standard
//     channel has no TCPRoutes, and nothing before v1.5 has ListenerSets. A
//     kind the cluster does not serve is an empty list, not a failure.
//  3. Nothing subscribes to the theme: the SDK writes the app's tokens onto
//     :root before `ready()` resolves and rewrites them when the user
//     switches, so a stylesheet in var(--text) follows along on its own. The
//     map is SVG coloured by class for the same reason.

import {
    KIND,
    ROUTE_KIND,
    ROUTE_TYPES,
    type BackendTLSPolicy,
    type EndpointSlice,
    type Gateway,
    type GatewayClass,
    type ListenerSet,
    type Namespace,
    type ReferenceGrant,
    type Route,
    type Service,
    type Snapshot,
} from '../model/types.js';
import { el, replace } from './dom.js';

/** Shows a failure where the user is looking, as a sentence. */
export function fail(host: HTMLElement, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    replace(host, el('div', { class: 'failure' }, el('strong', {}, 'That did not work. '), el('span', {}, message)));
}

/**
 * Runs a page's body once the bridge is ready, and shows anything that goes
 * wrong instead of dying silently.
 */
export function start(hostId: string, body: (ctx: K8sDockside.Context) => Promise<void>): void {
    const run = async () => {
        const host = document.getElementById(hostId);
        try {
            const ctx = await k8sdockside.ready();
            await body(ctx);
        } catch (err) {
            if (host) fail(host, err);
        }
    };
    void run();
}

/**
 * Runs `body` now and every `ms` milliseconds after it, and hands anything it
 * throws to `onError`. The page has no network of its own, so this is how a
 * view stays live: it re-reads the handful of lists it needs together.
 */
export function every(ms: number, body: () => Promise<void>, onError: (err: unknown) => void): () => void {
    let stopped = false;
    let running = false;
    const tick = async () => {
        if (stopped || running) return;
        running = true;
        try {
            await body();
        } catch (err) {
            onError(err);
        } finally {
            running = false;
        }
    };
    void tick();
    const timer = setInterval(() => void tick(), ms);
    return () => {
        stopped = true;
        clearInterval(timer);
    };
}

/** A list of a kind the cluster may not serve: `null` rather than a failure. */
async function maybe<T extends K8sDockside.KubeObject>(kind: string): Promise<T[] | null> {
    try {
        return await k8sdockside.list<T>({ kind });
    } catch {
        return null;
    }
}

export interface Loaded {
    snap: Snapshot;
    /** Whether the cluster serves Gateways at all. */
    installed: boolean;
}

/** Everything the model is built from, read at once. */
export async function load(): Promise<Loaded> {
    const [classes, gateways, listenerSets, grants, backendTLS, services, slices, namespaces, routes] = await Promise.all([
        maybe<GatewayClass>(KIND.classes),
        maybe<Gateway>(KIND.gateways),
        maybe<ListenerSet>(KIND.listenerSets),
        maybe<ReferenceGrant>(KIND.grants),
        maybe<BackendTLSPolicy>(KIND.backendTLS),
        maybe<Service>(KIND.services),
        maybe<EndpointSlice>(KIND.slices),
        maybe<Namespace>(KIND.namespaces),
        Promise.all(ROUTE_TYPES.map((t) => maybe<Route>(ROUTE_KIND[t]))),
    ]);
    return {
        installed: gateways !== null,
        snap: {
            classes: classes ?? [],
            gateways: gateways ?? [],
            listenerSets: listenerSets ?? [],
            routes: ROUTE_TYPES.map((type, i) => ({ type, items: routes[i] ?? [] })),
            grants: grants ?? [],
            backendTLS: backendTLS ?? [],
            services: services ?? [],
            slices: slices ?? [],
            namespaces,
        },
    };
}

/** `namespace/name`, or just the name when there is no namespace. */
export function where(namespace: string, name: string): string {
    return namespace ? `${namespace}/${name}` : name;
}

/** Remembered per plugin and cluster, where the app can (0.0.19 and newer); forgotten otherwise. */
export const remember = {
    async get<T>(key: string): Promise<T | null> {
        try {
            return ((await k8sdockside.storage?.get(key)) as T | null) ?? null;
        } catch {
            return null;
        }
    },
    async set(key: string, value: unknown): Promise<void> {
        try {
            await k8sdockside.storage?.set(key, value);
        } catch {
            // Nothing to do: the page works the same without it.
        }
    },
};

/** A stable fingerprint of what is drawn, so a refresh that changed nothing redraws nothing. */
export function fingerprint(value: unknown): string {
    return JSON.stringify(value);
}
