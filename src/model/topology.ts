// Who is attached to what: the one model every page draws from.
//
// The Gateway API spreads a single path through the cluster over four kinds
// of object in as many namespaces -- a Gateway's listener, a route's
// parentRef, the rule's backendRef, the Service and its endpoints -- and the
// tables the app already has show each of them on its own. This joins them.
//
// Two sources of truth are combined on purpose:
//
//  - What the controller *reported*, in each route's status.parents and each
//    Gateway's status.listeners. That is authoritative: it is what the data
//    plane was actually told.
//  - What the spec *says should happen*: which listeners a parentRef can land
//    on (sectionName, port, allowedRoutes, hostnames), whether a Service a
//    rule sends traffic to exists, whether a ReferenceGrant lets it cross a
//    namespace. That is what explains a status in words, and what still
//    works for a route no controller has looked at.
//
// Where the two disagree the controller wins, and the spec only explains.

import { effectiveHostnames } from './hostnames.js';
import { condition, isTrue, positiveTone, worst, type Tone } from './tone.js';
import {
    GROUP,
    KIND,
    ROUTE_KIND,
    type BackendRef,
    type Condition,
    type EndpointSlice,
    type Filter,
    type Gateway,
    type LabelSelector,
    type Listener,
    type ListenerStatus,
    type ParentRef,
    type ReferenceGrant,
    type Route,
    type RouteParentStatus,
    type RouteRule,
    type RouteType,
    type Service,
    type Snapshot,
} from './types.js';

export interface Ref {
    kind: string;
    namespace: string;
    name: string;
}

export interface ClassView {
    id: string;
    ref: Ref;
    name: string;
    controller: string;
    description: string;
    accepted: boolean | null;
    condition: Condition | undefined;
    tone: Tone;
    gateways: GatewayView[];
}

export interface CertView {
    namespace: string;
    name: string;
    /** Same namespace, or a ReferenceGrant allows it. */
    granted: boolean;
}

export interface ListenerView {
    id: string;
    gateway: GatewayView;
    /** The object the listener is written in: its Gateway, or a ListenerSet. */
    owner: Ref;
    /** `namespace/name` of the ListenerSet it came from; `''` for the Gateway's own. */
    viaSet: string;
    name: string;
    port: number;
    protocol: string;
    /** `''` when it takes every host. */
    hostname: string;
    tlsMode: string;
    certs: CertView[];
    allowedFrom: string;
    selector: LabelSelector | undefined;
    /** The route types it takes: allowedRoutes.kinds, or what the protocol implies. */
    kinds: RouteType[];
    status: ListenerStatus | null;
    conditions: Condition[];
    tone: Tone;
    /** Short sentences on what is wrong with it; empty when nothing is. */
    notes: string[];
    attachments: Attachment[];
}

export interface Attachment {
    route: RouteView;
    parent: ParentView;
    listener: ListenerView;
}

export interface ParentView {
    index: number;
    /** With the API's defaults filled in: group, kind and namespace are never empty. */
    ref: Required<Pick<ParentRef, 'group' | 'kind' | 'namespace' | 'name'>> & { sectionName: string; port: number | null };
    gateway: GatewayView | null;
    listenerSet: ListenerSetView | null;
    /** The Gateway or ListenerSet it names is not in the cluster. */
    missing: boolean;
    /** The listeners it lands on. Empty when it lands nowhere. */
    listeners: ListenerView[];
    /** Listeners it asked for by section and port, before allowedRoutes and hostnames were applied. */
    candidates: ListenerView[];
    status: RouteParentStatus | null;
    accepted: boolean | null;
    resolvedRefs: boolean | null;
    /** The controller's reason when it said no, or the spec's when no controller has spoken. */
    reason: string;
    message: string;
    /** Why, by the spec's reading, it lands nowhere -- concrete where a controller's message is generic. */
    specWhy: string;
    tone: Tone;
}

export interface BackendView {
    key: string;
    /** What opens in the app; `null` for a kind the plugin cannot open. */
    ref: Ref | null;
    group: string;
    kind: string;
    name: string;
    namespace: string;
    port: number | null;
    weight: number;
    /** Its part of the rule's traffic, 0..1. */
    share: number;
    isService: boolean;
    exists: boolean | null;
    crossNamespace: boolean;
    granted: boolean;
    ready: number | null;
    total: number | null;
    external: string;
    /** The BackendTLSPolicy that makes the gateway speak TLS to it, if any. */
    tlsPolicy: string;
    tone: Tone;
    problem: string;
}

export interface RuleView {
    index: number;
    name: string;
    rule: RouteRule;
    filters: Filter[];
    backends: BackendView[];
    tone: Tone;
}

export interface RouteView {
    id: string;
    type: RouteType;
    ref: Ref;
    name: string;
    namespace: string;
    created: string;
    hostnames: string[];
    parents: ParentView[];
    rules: RuleView[];
    /** Whether any parent took it. */
    attached: boolean;
    /** Attached nowhere, whatever the reason. */
    orphan: boolean;
    /** The worst ResolvedRefs=False any controller reported, if any. */
    unresolved: Condition | null;
    partiallyInvalid: Condition | null;
    tone: Tone;
    obj: Route;
}

export interface ListenerSetView {
    id: string;
    ref: Ref;
    name: string;
    namespace: string;
    parent: GatewayView | null;
    accepted: boolean | null;
    conditions: Condition[];
    tone: Tone;
    listeners: ListenerView[];
}

export interface GatewayView {
    id: string;
    ref: Ref;
    name: string;
    namespace: string;
    className: string;
    cls: ClassView | null;
    addresses: string[];
    conditions: Condition[];
    accepted: boolean | null;
    programmed: boolean | null;
    tone: Tone;
    listeners: ListenerView[];
    sets: ListenerSetView[];
    obj: Gateway;
}

export interface ServiceView {
    key: string;
    ref: Ref;
    service: Service;
    ready: number;
    total: number;
    external: string;
    /** Every rule that sends it traffic. */
    uses: { route: RouteView; rule: RuleView; backend: BackendView }[];
}

export interface Topology {
    classes: ClassView[];
    gateways: GatewayView[];
    listenerSets: ListenerSetView[];
    listeners: ListenerView[];
    routes: RouteView[];
    services: Map<string, ServiceView>;
    grants: ReferenceGrant[];
    namespaces: string[];
}

// ----- small helpers ---------------------------------------------------------

export function key(namespace: string | undefined, name: string): string {
    return `${namespace ?? ''}/${name}`;
}

function refOf(kind: string, obj: { metadata: { namespace?: string; name: string } }): Ref {
    return { kind, namespace: obj.metadata.namespace ?? '', name: obj.metadata.name };
}

/** The route types a protocol takes when allowedRoutes.kinds does not say. */
export function defaultKinds(protocol: string): RouteType[] {
    switch (protocol.toUpperCase()) {
        case 'HTTP':
        case 'HTTPS':
            return ['HTTPRoute', 'GRPCRoute'];
        case 'TLS':
            return ['TLSRoute'];
        case 'TCP':
            return ['TCPRoute'];
        case 'UDP':
            return ['UDPRoute'];
        default:
            return [];
    }
}

const ROUTE_TYPE_SET = new Set<string>(['HTTPRoute', 'GRPCRoute', 'TLSRoute', 'TCPRoute', 'UDPRoute']);

function listenerKinds(listener: Listener, status: ListenerStatus | null): RouteType[] {
    const declared = listener.allowedRoutes?.kinds?.filter((k) => (k.group ?? GROUP) === GROUP && ROUTE_TYPE_SET.has(k.kind)).map((k) => k.kind as RouteType);
    if (declared && declared.length) return declared;
    const supported = status?.supportedKinds?.filter((k) => ROUTE_TYPE_SET.has(k.kind)).map((k) => k.kind as RouteType);
    if (supported && supported.length) return supported;
    return defaultKinds(listener.protocol ?? '');
}

/** Whether a label selector matches a set of labels. An empty selector matches everything. */
export function selectorMatches(selector: LabelSelector | undefined, labels: Record<string, string>): boolean {
    if (!selector) return true;
    for (const [k, v] of Object.entries(selector.matchLabels ?? {})) if (labels[k] !== v) return false;
    for (const e of selector.matchExpressions ?? []) {
        const has = Object.prototype.hasOwnProperty.call(labels, e.key);
        const value = labels[e.key];
        switch (e.operator) {
            case 'In':
                if (!has || !(e.values ?? []).includes(value ?? '')) return false;
                break;
            case 'NotIn':
                if (has && (e.values ?? []).includes(value ?? '')) return false;
                break;
            case 'Exists':
                if (!has) return false;
                break;
            case 'DoesNotExist':
                if (has) return false;
                break;
            default:
                return false;
        }
    }
    return true;
}

/**
 * Whether a ReferenceGrant in `toNamespace` lets an object of `fromKind` in
 * `fromNamespace` refer to `toKind`/`toName` there.
 */
export function granted(
    grants: readonly ReferenceGrant[],
    from: { group: string; kind: string; namespace: string },
    to: { group: string; kind: string; namespace: string; name: string },
): boolean {
    if (from.namespace === to.namespace) return true;
    return grants.some(
        (g) =>
            (g.metadata.namespace ?? '') === to.namespace &&
            (g.spec?.from ?? []).some((f) => (f.group ?? '') === from.group && f.kind === from.kind && f.namespace === from.namespace) &&
            (g.spec?.to ?? []).some((t) => (t.group ?? '') === to.group && t.kind === to.kind && (!t.name || t.name === to.name)),
    );
}

function sameParent(a: ParentRef, b: ParentView['ref'], routeNamespace: string): boolean {
    return (
        (a.group ?? GROUP) === b.group &&
        (a.kind ?? 'Gateway') === b.kind &&
        (a.namespace ?? routeNamespace) === b.namespace &&
        a.name === b.name &&
        (a.sectionName ?? '') === b.sectionName &&
        (a.port ?? null) === b.port
    );
}

// ----- the build --------------------------------------------------------------

export function topology(snap: Snapshot): Topology {
    const nsLabels = new Map<string, Record<string, string>>();
    for (const ns of snap.namespaces ?? []) nsLabels.set(ns.metadata.name, ns.metadata.labels ?? {});
    const namespacesKnown = snap.namespaces !== null;

    // Classes.
    const classes = new Map<string, ClassView>();
    for (const c of snap.classes) {
        const accepted = isTrue(c.status?.conditions, 'Accepted');
        classes.set(c.metadata.name, {
            id: 'class:' + c.metadata.name,
            ref: refOf(KIND.classes, c),
            name: c.metadata.name,
            controller: c.spec?.controllerName ?? '',
            description: c.spec?.description ?? '',
            accepted,
            condition: condition(c.status?.conditions, 'Accepted'),
            tone: positiveTone(c.status?.conditions, 'Accepted'),
            gateways: [],
        });
    }

    // Services and their endpoints.
    const services = new Map<string, ServiceView>();
    const endpoints = countEndpoints(snap.slices);
    for (const s of snap.services) {
        const k = key(s.metadata.namespace, s.metadata.name);
        const e = endpoints.get(k) ?? { ready: 0, total: 0 };
        services.set(k, {
            key: k,
            ref: refOf(KIND.services, s),
            service: s,
            ready: e.ready,
            total: e.total,
            external: s.spec?.type === 'ExternalName' ? (s.spec.externalName ?? '') : '',
            uses: [],
        });
    }

    // Which Services a BackendTLSPolicy covers.
    const tlsPolicies = new Map<string, string>();
    for (const p of snap.backendTLS) {
        for (const t of p.spec?.targetRefs ?? []) {
            if ((t.group ?? '') === '' && (t.kind ?? 'Service') === 'Service' && t.name) tlsPolicies.set(key(p.metadata.namespace, t.name), p.metadata.name);
        }
    }

    // Gateways and their listeners.
    const gateways: GatewayView[] = [];
    const gatewayByKey = new Map<string, GatewayView>();
    const listeners: ListenerView[] = [];
    for (const g of sortByName(snap.gateways)) {
        const conditions = g.status?.conditions ?? [];
        const className = g.spec?.gatewayClassName ?? '';
        const cls = classes.get(className) ?? null;
        const view: GatewayView = {
            id: 'gw:' + key(g.metadata.namespace, g.metadata.name),
            ref: refOf(KIND.gateways, g),
            name: g.metadata.name,
            namespace: g.metadata.namespace ?? '',
            className,
            cls,
            addresses: (g.status?.addresses ?? []).map((a) => a.value ?? '').filter(Boolean),
            conditions,
            accepted: isTrue(conditions, 'Accepted'),
            programmed: isTrue(conditions, 'Programmed'),
            tone: 'ok',
            listeners: [],
            sets: [],
            obj: g,
        };
        view.tone = !cls ? 'error' : worst([positiveTone(conditions, 'Accepted'), positiveTone(conditions, 'Programmed')]);
        cls?.gateways.push(view);
        for (const l of g.spec?.listeners ?? []) {
            const lv = listenerView(view, l, g.status?.listeners, view.ref, '', snap.grants, 'Gateway', conditions.length > 0);
            view.listeners.push(lv);
            listeners.push(lv);
        }
        gateways.push(view);
        gatewayByKey.set(key(view.namespace, view.name), view);
    }

    // ListenerSets: extra listeners on a Gateway, written somewhere else.
    const listenerSets: ListenerSetView[] = [];
    const setByKey = new Map<string, ListenerSetView>();
    for (const s of sortByName(snap.listenerSets)) {
        const ns = s.metadata.namespace ?? '';
        const p = s.spec?.parentRef;
        const parent = p ? (gatewayByKey.get(key(p.namespace ?? ns, p.name)) ?? null) : null;
        const conditions = s.status?.conditions ?? [];
        const view: ListenerSetView = {
            id: 'ls:' + key(ns, s.metadata.name),
            ref: refOf(KIND.listenerSets, s),
            name: s.metadata.name,
            namespace: ns,
            parent,
            accepted: isTrue(conditions, 'Accepted'),
            conditions,
            tone: parent ? positiveTone(conditions, 'Accepted') : 'error',
            listeners: [],
        };
        if (parent) {
            for (const l of s.spec?.listeners ?? []) {
                const lv = listenerView(parent, l, s.status?.listeners, view.ref, key(ns, s.metadata.name), snap.grants, 'ListenerSet', conditions.length > 0);
                if (view.accepted === false) {
                    lv.tone = 'error';
                    lv.notes.unshift(`The Gateway did not accept the ListenerSet ${s.metadata.name} this listener comes from.`);
                }
                view.listeners.push(lv);
                parent.listeners.push(lv);
                listeners.push(lv);
            }
            parent.sets.push(view);
        }
        listenerSets.push(view);
        setByKey.set(key(ns, s.metadata.name), view);
    }

    // Routes.
    const routes: RouteView[] = [];
    for (const group of snap.routes) {
        for (const r of group.items) routes.push(routeView(group.type, r));
    }
    routes.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name) || a.type.localeCompare(b.type));

    function routeView(type: RouteType, r: Route): RouteView {
        const ns = r.metadata.namespace ?? '';
        const hostnames = type === 'TCPRoute' || type === 'UDPRoute' ? [] : (r.spec?.hostnames ?? []);
        const view: RouteView = {
            id: `route:${type}:${key(ns, r.metadata.name)}`,
            type,
            ref: refOf(ROUTE_KIND[type], r),
            name: r.metadata.name,
            namespace: ns,
            created: r.metadata.creationTimestamp ?? '',
            hostnames,
            parents: [],
            rules: [],
            attached: false,
            orphan: false,
            unresolved: null,
            partiallyInvalid: null,
            tone: 'ok',
            obj: r,
        };

        (r.spec?.parentRefs ?? []).forEach((p, index) => {
            view.parents.push(parentView(view, p, index));
        });

        for (const s of r.status?.parents ?? []) {
            const rr = condition(s.conditions, 'ResolvedRefs');
            if (rr?.status === 'False' && !view.unresolved) view.unresolved = rr;
            const pi = condition(s.conditions, 'PartiallyInvalid');
            if (pi?.status === 'True' && !view.partiallyInvalid) view.partiallyInvalid = pi;
        }

        (r.spec?.rules ?? []).forEach((rule, index) => {
            view.rules.push(ruleView(view, rule, index));
        });

        view.attached = view.parents.some((p) => p.listeners.length > 0 && p.accepted !== false);
        view.orphan = !view.attached;
        view.tone = worst([
            ...view.parents.map((p) => p.tone),
            ...view.rules.map((rule) => rule.tone),
            view.unresolved ? 'error' : 'ok',
            view.partiallyInvalid ? 'warn' : 'ok',
            view.parents.length === 0 ? 'error' : 'ok',
        ]);

        for (const p of view.parents) {
            if (p.accepted === false) continue;
            for (const l of p.listeners) l.attachments.push({ route: view, parent: p, listener: l });
        }
        return view;
    }

    function parentView(route: RouteView, p: ParentRef, index: number): ParentView {
        const ref: ParentView['ref'] = {
            group: p.group ?? GROUP,
            kind: p.kind ?? 'Gateway',
            namespace: p.namespace ?? route.namespace,
            name: p.name,
            sectionName: p.sectionName ?? '',
            port: p.port ?? null,
        };
        const view: ParentView = {
            index,
            ref,
            gateway: null,
            listenerSet: null,
            missing: false,
            listeners: [],
            candidates: [],
            status: route.obj.status?.parents?.find((s) => sameParent(s.parentRef, ref, route.namespace)) ?? null,
            accepted: null,
            resolvedRefs: null,
            reason: '',
            message: '',
            specWhy: '',
            tone: 'ok',
        };
        view.accepted = isTrue(view.status?.conditions, 'Accepted');
        view.resolvedRefs = isTrue(view.status?.conditions, 'ResolvedRefs');

        let pool: ListenerView[] = [];
        let ownerNamespace = '';
        if (ref.group === GROUP && ref.kind === 'Gateway') {
            view.gateway = gatewayByKey.get(key(ref.namespace, ref.name)) ?? null;
            // Routes that name a Gateway attach to its own listeners, not to
            // those a ListenerSet adds: those are reached through the set.
            pool = view.gateway?.listeners.filter((l) => !l.viaSet) ?? [];
            ownerNamespace = view.gateway?.namespace ?? '';
        } else if (ref.group === GROUP && ref.kind === 'ListenerSet') {
            view.listenerSet = setByKey.get(key(ref.namespace, ref.name)) ?? null;
            view.gateway = view.listenerSet?.parent ?? null;
            pool = view.listenerSet?.listeners ?? [];
            ownerNamespace = view.listenerSet?.namespace ?? '';
        } else {
            view.reason = 'UnsupportedParent';
            view.message = `${ref.kind} is not a parent this plugin can follow.`;
            view.tone = view.accepted === true ? 'ok' : '';
            return view;
        }

        if (!view.gateway || (ref.kind === 'ListenerSet' && !view.listenerSet)) {
            view.missing = true;
            view.reason = view.status ? (condition(view.status.conditions, 'Accepted')?.reason ?? 'NoMatchingParent') : 'NoMatchingParent';
            view.message = `There is no ${ref.kind} ${ref.namespace}/${ref.name}.`;
            view.tone = 'error';
            return view;
        }

        // By section and port: which listeners the parentRef asked for.
        let asked = pool;
        if (ref.sectionName) asked = asked.filter((l) => l.name === ref.sectionName);
        if (ref.port !== null) asked = asked.filter((l) => l.port === ref.port);
        view.candidates = asked;

        // Then what each listener lets in.
        // Why each listener said no, as a sentence with the listener's name
        // left open, so two listeners refusing for the same reason read as
        // one sentence about both.
        let why = '';
        const refusals = new Map<string, string[]>();
        const refuse = (reason: string, l: ListenerView, sentence: (names: string) => string) => {
            why = reason;
            const key = sentence('\u0000');
            refusals.set(key, [...(refusals.get(key) ?? []), l.name]);
        };
        const landed = asked.filter((l) => {
            if (!l.kinds.includes(route.type)) {
                refuse('NotAllowedByListeners', l, (n) => `${n} ${l.kinds.join(', ') || 'no routes'}, not ${route.type}.`);
                return false;
            }
            const nsOwner = l.viaSet ? (setByKey.get(l.viaSet)?.namespace ?? ownerNamespace) : ownerNamespace;
            if (!namespaceAllowed(l, route.namespace, nsOwner)) {
                refuse('NotAllowedByListeners', l, (n) =>
                    l.allowedFrom === 'Selector'
                        ? `${n} routes only from namespaces matching a selector, and ${route.namespace} does not match.`
                        : `${n} routes only from ${nsOwner}, their own namespace; this route is in ${route.namespace}.`,
                );
                return false;
            }
            if (route.hostnames.length && l.hostname && (route.type === 'HTTPRoute' || route.type === 'GRPCRoute' || route.type === 'TLSRoute')) {
                if (effectiveHostnames(route.hostnames, l.hostname).length === 0) {
                    refuse('NoMatchingListenerHostname', l, (n) => `${n} ${l.hostname}, and none of the route's hostnames (${route.hostnames.join(', ')}) fall under it.`);
                    return false;
                }
            }
            return true;
        });
        const verb: Record<string, [string, string]> = {
            NoMatchingListenerHostname: ['is for', 'are for'],
            NotAllowedByListeners: ['takes', 'take'],
        };
        let whyMessage = [...refusals.entries()]
            .map(([sentence, names]) => {
                const [one, many] = verb[why] ?? ['takes', 'take'];
                const subject = names.length === 1 ? `The listener ${names[0]} ${one}` : `The listeners ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} ${many}`;
                return sentence.replace('\u0000', subject).replace(' their own namespace', names.length === 1 ? ' its own namespace' : ' their own namespace');
            })
            .join(' ');

        if (asked.length === 0) {
            why = 'NoMatchingParent';
            whyMessage = ref.sectionName
                ? `${view.gateway.namespace}/${view.gateway.name} has no listener named ${ref.sectionName}${ref.port !== null ? ` on port ${ref.port}` : ''}.`
                : ref.port !== null
                  ? `${view.gateway.namespace}/${view.gateway.name} has no listener on port ${ref.port}.`
                  : `${view.gateway.namespace}/${view.gateway.name} has no listeners.`;
        }

        view.listeners = landed;
        if (landed.length === 0) view.specWhy = whyMessage;
        const acceptedCond = condition(view.status?.conditions, 'Accepted');
        if (view.accepted === false) {
            view.listeners = [];
            view.reason = acceptedCond?.reason ?? why;
            view.message = acceptedCond?.message || whyMessage;
            view.tone = 'error';
        } else if (view.accepted === true) {
            // The controller took it. If the spec reading found nowhere for it
            // -- a Selector over namespaces we could not read, say -- trust
            // the controller and draw it on what it asked for.
            if (view.listeners.length === 0) view.listeners = asked.filter((l) => l.kinds.includes(route.type));
            view.tone = view.resolvedRefs === false ? 'error' : 'ok';
            if (view.resolvedRefs === false) {
                const rr = condition(view.status?.conditions, 'ResolvedRefs');
                view.reason = rr?.reason ?? '';
                view.message = rr?.message ?? '';
            }
        } else if (landed.length === 0) {
            view.reason = why || 'NoMatchingParent';
            view.message = whyMessage;
            view.tone = 'error';
        } else {
            view.reason = 'Pending';
            view.message = view.status ? 'The controller has not decided whether to accept it yet.' : `No controller has written a status for ${view.gateway.namespace}/${view.gateway.name} on this route yet.`;
            view.tone = 'warn';
        }
        if (!namespacesKnown && !view.status && view.listeners.some((l) => l.allowedFrom === 'Selector')) {
            view.message += ' (The namespaces could not be read, so a Selector could not be checked.)';
        }
        return view;
    }

    function namespaceAllowed(l: ListenerView, routeNamespace: string, ownerNamespace: string): boolean {
        switch (l.allowedFrom) {
            case 'All':
                return true;
            case 'Selector':
                // Without the namespaces there is nothing to judge by: let it
                // through and leave the verdict to the controller's status.
                if (!namespacesKnown) return true;
                return selectorMatches(l.selector, nsLabels.get(routeNamespace) ?? {});
            default:
                return routeNamespace === ownerNamespace;
        }
    }

    function ruleView(route: RouteView, rule: RouteRule, index: number): RuleView {
        const refs = rule.backendRefs ?? [];
        const total = refs.reduce((n, b) => n + weightOf(b), 0);
        const backends = refs.map((b) => backendView(route, b, total));
        // The only backend of a rule having no endpoints is every request
        // failing; one of several is a share of them failing.
        for (const b of backends) {
            if (b.exists && b.isService && !b.external && b.ready === 0 && b.weight > 0) {
                b.tone = b.share >= 1 ? 'error' : 'warn';
            }
        }
        const filters = rule.filters ?? [];
        const answersItself = filters.some((f) => f.type === 'RequestRedirect');
        const view: RuleView = {
            index,
            name: rule.name ?? '',
            rule,
            filters,
            backends,
            tone: backends.length === 0 && !answersItself ? 'warn' : worst(backends.filter((b) => b.weight > 0).map((b) => b.tone)),
        };
        for (const b of backends) {
            const s = services.get(key(b.namespace, b.name));
            if (b.isService && s) s.uses.push({ route, rule: view, backend: b });
        }
        return view;
    }

    function backendView(route: RouteView, b: BackendRef, total: number): BackendView {
        const group = b.group ?? '';
        const kind = b.kind ?? 'Service';
        const namespace = b.namespace ?? route.namespace;
        const isService = group === '' && kind === 'Service';
        const weight = weightOf(b);
        const svc = isService ? services.get(key(namespace, b.name)) : undefined;
        const cross = namespace !== route.namespace;
        const ok = granted(snap.grants, { group: GROUP, kind: route.type, namespace: route.namespace }, { group, kind, namespace, name: b.name });
        const view: BackendView = {
            key: `${group}/${kind}/${key(namespace, b.name)}`,
            ref: isService ? { kind: KIND.services, namespace, name: b.name } : null,
            group,
            kind,
            name: b.name,
            namespace,
            port: b.port ?? null,
            weight,
            share: total > 0 ? weight / total : 0,
            isService,
            exists: isService ? !!svc : null,
            crossNamespace: cross,
            granted: ok,
            ready: svc && !svc.external ? svc.ready : null,
            total: svc && !svc.external ? svc.total : null,
            external: svc?.external ?? '',
            tlsPolicy: isService ? (tlsPolicies.get(key(namespace, b.name)) ?? '') : '',
            tone: 'ok',
            problem: '',
        };
        if (isService && !svc) {
            view.tone = 'error';
            view.problem = `There is no Service ${namespace}/${b.name}.`;
        } else if (!ok) {
            view.tone = 'error';
            view.problem = `No ReferenceGrant in ${namespace} lets ${route.type}s from ${route.namespace} send traffic to ${kind} ${b.name}.`;
        } else if (!isService) {
            view.tone = '';
            view.problem = `A ${kind}${group ? ` (${group})` : ''}: the plugin cannot see whether it is healthy.`;
        } else if (weight === 0) {
            view.tone = '';
        }
        return view;
    }

    const namespaces = new Set<string>();
    for (const g of gateways) namespaces.add(g.namespace);
    for (const r of routes) namespaces.add(r.namespace);
    for (const s of listenerSets) namespaces.add(s.namespace);

    return {
        classes: [...classes.values()].sort((a, b) => a.name.localeCompare(b.name)),
        gateways,
        listenerSets,
        listeners,
        routes,
        services,
        grants: snap.grants,
        namespaces: [...namespaces].filter(Boolean).sort(),
    };
}

function weightOf(b: BackendRef): number {
    return typeof b.weight === 'number' && b.weight >= 0 ? b.weight : 1;
}

function sortByName<T extends { metadata: { namespace?: string; name: string } }>(list: readonly T[]): T[] {
    return [...list].sort((a, b) => (a.metadata.namespace ?? '').localeCompare(b.metadata.namespace ?? '') || a.metadata.name.localeCompare(b.metadata.name));
}

function listenerView(
    gateway: GatewayView,
    l: Listener,
    statuses: ListenerStatus[] | undefined,
    owner: Ref,
    viaSet: string,
    grants: readonly ReferenceGrant[],
    ownerKind: 'Gateway' | 'ListenerSet',
    ownerHasStatus: boolean,
): ListenerView {
    const status = statuses?.find((s) => s.name === l.name) ?? null;
    const conditions = status?.conditions ?? [];
    const certs: CertView[] = (l.tls?.certificateRefs ?? []).map((c) => {
        const ns = c.namespace ?? owner.namespace;
        return {
            namespace: ns,
            name: c.name,
            granted: granted(grants, { group: GROUP, kind: ownerKind, namespace: owner.namespace }, { group: c.group ?? '', kind: c.kind ?? 'Secret', namespace: ns, name: c.name }),
        };
    });
    const view: ListenerView = {
        id: `listener:${gateway.id}:${viaSet ? viaSet + ':' : ''}${l.name}`,
        gateway,
        owner,
        viaSet,
        name: l.name,
        port: l.port,
        protocol: l.protocol ?? '',
        hostname: l.hostname ?? '',
        tlsMode: l.tls?.mode ?? (l.tls ? 'Terminate' : ''),
        certs,
        allowedFrom: l.allowedRoutes?.namespaces?.from ?? 'Same',
        selector: l.allowedRoutes?.namespaces?.selector,
        kinds: listenerKinds(l, status),
        status,
        conditions,
        tone: 'ok',
        notes: [],
        attachments: [],
    };

    const tones: Tone[] = [];
    const conflicted = condition(conditions, 'Conflicted');
    if (conflicted?.status === 'True') {
        tones.push('error');
        view.notes.push(conflicted.message || `It conflicts with another listener (${conflicted.reason ?? 'Conflicted'}).`);
    }
    for (const type of ['Accepted', 'ResolvedRefs', 'Programmed']) {
        const c = condition(conditions, type);
        if (c?.status === 'False') {
            tones.push('error');
            view.notes.push(`${type} is False${c.reason ? ` (${c.reason})` : ''}${c.message ? `: ${c.message}` : ''}`);
        }
    }
    for (const c of certs) {
        if (!c.granted) {
            tones.push('error');
            view.notes.push(`Its certificate ${c.namespace}/${c.name} is in another namespace, and no ReferenceGrant there lets the ${ownerKind} use it.`);
        }
    }
    if (!status && ownerHasStatus) {
        tones.push('warn');
        view.notes.push('The controller has not reported on this listener.');
    } else if (!status) {
        tones.push('warn');
    }
    view.tone = worst(tones);
    return view;
}

/** Ready and total endpoints per Service, from its EndpointSlices. */
export function countEndpoints(slices: readonly EndpointSlice[]): Map<string, { ready: number; total: number }> {
    const seen = new Map<string, Map<string, boolean>>();
    for (const s of slices) {
        const svc = s.metadata.labels?.['kubernetes.io/service-name'];
        if (!svc) continue;
        const k = key(s.metadata.namespace, svc);
        const mine = seen.get(k) ?? new Map<string, boolean>();
        for (const e of s.endpoints ?? []) {
            // A dual-stack Service has one slice per address family with the
            // same pods in both: count pods, not addresses.
            const id = e.targetRef?.name ? `pod:${e.targetRef.name}` : (e.addresses?.[0] ?? '');
            if (!id) continue;
            // `ready` absent means ready: "nil should be interpreted as true".
            const ready = e.conditions?.ready !== false;
            mine.set(id, (mine.get(id) ?? false) || ready);
        }
        seen.set(k, mine);
    }
    const out = new Map<string, { ready: number; total: number }>();
    for (const [k, eps] of seen) out.set(k, { ready: [...eps.values()].filter(Boolean).length, total: eps.size });
    return out;
}

/** How a listener is written in one line: `HTTPS :443 shop.example.com`. */
export function listenerLine(l: Pick<ListenerView, 'protocol' | 'port' | 'hostname'>): string {
    return `${l.protocol} :${l.port}${l.hostname ? ' ' + l.hostname : ''}`;
}
