// Everything that stops traffic, or will, written for a person.
//
// Each problem says three things: what is wrong, in words rather than as a
// condition reason; what that does to traffic; and what to change. The
// condition the controller wrote is kept too, verbatim, because the person
// fixing it will want to search for it.
//
// Where the plugin can see the cause itself -- the Service is not there, the
// ReferenceGrant is missing -- it says so from what it read, and the
// controller's matching ResolvedRefs condition is not repeated as a second
// problem about the same thing.

import { listenerLine, type GatewayView, type ListenerView, type ParentView, type Ref, type RouteView, type Topology } from './topology.js';
import { condition, toneRank, type Tone } from './tone.js';

export type Area = 'class' | 'gateway' | 'listener' | 'route' | 'backend';

export interface Problem {
    id: string;
    tone: 'error' | 'warn';
    area: Area;
    /** A few words: "Backend Service is missing". */
    title: string;
    /** The object, as `HTTPRoute shop/billing`. */
    subject: string;
    ref: Ref;
    namespace: string;
    /** What is wrong and what it does to traffic, in plain words. */
    explain: string;
    /** What to change. */
    fix: string;
    /** The controller's own words, when it gave any: `Reason: message`. */
    detail: string;
}

const AREA_ORDER: Area[] = ['class', 'gateway', 'listener', 'route', 'backend'];

/** What the API's condition reasons mean, and what usually fixes them. */
const REASONS: Record<string, { explain: string; fix: string }> = {
    NotAllowedByListeners: {
        explain: 'The Gateway exists, but none of the listeners it asked for lets this route in: they take routes from other namespaces, or of other kinds.',
        fix: "Widen the listener's allowedRoutes (namespaces.from: All, or a Selector that matches this namespace), or attach the route to a listener meant for it.",
    },
    NoMatchingListenerHostname: {
        explain: "The route's hostnames and the listener's hostname have nothing in common, so the route can never receive a request there.",
        fix: "Give the route a hostname under the listener's (or none at all), or point it at the listener for its hostname with sectionName.",
    },
    NoMatchingParent: {
        explain: 'The parentRef names a Gateway, or a listener on it, that is not there.',
        fix: 'Check the Gateway name and namespace in parentRefs, and that sectionName is the name of one of its listeners.',
    },
    UnsupportedValue: {
        explain: 'The controller does not support something the route asks for.',
        fix: "Read the message for which field; check the implementation's supported features.",
    },
    IncompatibleFilters: {
        explain: 'The route combines filters that cannot be used together, such as a redirect and a rewrite in one rule.',
        fix: 'Split the filters over separate rules.',
    },
    RefNotPermitted: {
        explain: 'Something is referenced in another namespace, and no ReferenceGrant there allows it. The API refuses cross-namespace references unless the owner of the target namespace agrees.',
        fix: 'Create a ReferenceGrant in the target namespace, from this kind and namespace, to the kind referenced.',
    },
    BackendNotFound: {
        explain: 'A backend the route sends traffic to does not exist. Requests that would have gone to it get a 500.',
        fix: 'Create the Service, or correct the backendRef name, namespace or port.',
    },
    InvalidKind: {
        explain: 'A backend is of a kind the controller does not know how to send traffic to.',
        fix: 'Point the backendRef at a Service, or at a kind your implementation supports.',
    },
    UnsupportedProtocol: {
        explain: "The backend's appProtocol is one the controller cannot speak.",
        fix: "Change the Service port's appProtocol, or use a route type that fits it.",
    },
    HostnameConflict: {
        explain: 'Two listeners share a port, protocol and hostname, so a request could belong to either. The API requires every listener to be distinct; the conflicting ones are not used.',
        fix: 'Give each listener on the port its own hostname, or remove one of them.',
    },
    ProtocolConflict: {
        explain: 'Two listeners on the same port want different protocols. Only one protocol can own a port.',
        fix: 'Move one of the listeners to another port.',
    },
    InvalidCertificateRef: {
        explain: "The listener's TLS certificate cannot be used: the Secret is missing, malformed, or in a namespace it may not read.",
        fix: 'Check that the Secret exists and is a kubernetes.io/tls Secret; across namespaces, add a ReferenceGrant for it.',
    },
    InvalidRouteKinds: {
        explain: 'The listener lists a route kind in allowedRoutes that the controller does not support on that protocol.',
        fix: 'Remove the kind from allowedRoutes.kinds, or use a protocol that takes it.',
    },
    PortUnavailable: {
        explain: 'The listener asks for a port the implementation cannot open.',
        fix: 'Use another port, or check what else is bound to it.',
    },
    AddressNotAssigned: {
        explain: 'The Gateway has no address yet. Usually its Service of type LoadBalancer is still waiting for an external IP.',
        fix: 'Check the load balancer (MetalLB, the cloud provider, cloud-provider-kind) or ask for a ClusterIP or NodePort Service instead.',
    },
    AddressNotUsable: {
        explain: 'The address asked for in spec.addresses cannot be used.',
        fix: 'Pick an address the implementation can assign, or leave spec.addresses empty.',
    },
    NoResources: {
        explain: 'The implementation ran out of something it needs to program the Gateway.',
        fix: "Read the message and the controller's logs.",
    },
    Pending: {
        explain: 'The controller has seen it but has not finished with it yet.',
        fix: 'Wait a moment. If it stays Pending, check the controller is running.',
    },
    InvalidParameters: {
        explain: "The GatewayClass's parametersRef points at something missing or invalid.",
        fix: 'Check the object named in spec.parametersRef.',
    },
    Invalid: {
        explain: 'The controller found the object invalid.',
        fix: 'Read the message for what it objects to.',
    },
    ListenersNotValid: {
        explain: 'One or more of the Gateway’s listeners is invalid.',
        fix: 'See the listener problems for this Gateway.',
    },
    UnsupportedAddress: {
        explain: 'The Gateway asks for a type of address the implementation does not support.',
        fix: 'Remove or change spec.addresses.',
    },
};

function reason(r: string | undefined): { explain: string; fix: string } | undefined {
    return r ? REASONS[r] : undefined;
}

function detail(c: { reason?: string; message?: string } | undefined): string {
    if (!c) return '';
    return [c.reason, c.message].filter(Boolean).join(': ');
}

export function problems(topo: Topology): Problem[] {
    const out: Problem[] = [];
    const add = (p: Omit<Problem, 'namespace'>) => out.push({ ...p, namespace: p.ref.namespace });

    // GatewayClasses.
    for (const c of topo.classes) {
        if (c.accepted === true) continue;
        const subject = `GatewayClass ${c.name}`;
        if (c.accepted === false) {
            add({
                id: `class-accepted:${c.name}`,
                tone: 'error',
                area: 'class',
                title: 'GatewayClass not accepted',
                subject,
                ref: c.ref,
                explain: `The controller ${c.controller || '(none named)'} refused this class, so none of the ${c.gateways.length} Gateway${c.gateways.length === 1 ? '' : 's'} using it will be programmed. ${reason(c.condition?.reason)?.explain ?? ''}`.trim(),
                fix: reason(c.condition?.reason)?.fix ?? 'Read the condition message, and check the controller for this class is installed and running.',
                detail: detail(c.condition),
            });
        } else if (c.gateways.length > 0) {
            add({
                id: `class-unclaimed:${c.name}`,
                tone: 'warn',
                area: 'class',
                title: 'No controller has claimed this class',
                subject,
                ref: c.ref,
                explain: `Nothing has written a status on it, which usually means no controller named ${c.controller || '(none)'} is running. Gateways of this class are not being served.`,
                fix: 'Install or start the controller whose name is in spec.controllerName, or correct the name.',
                detail: '',
            });
        }
    }

    // Gateways.
    for (const g of topo.gateways) gatewayProblems(g, add);

    // Listeners.
    for (const l of topo.listeners) listenerProblems(l, add);

    // ListenerSets.
    for (const s of topo.listenerSets) {
        const subject = `ListenerSet ${s.namespace}/${s.name}`;
        if (!s.parent) {
            add({ id: `ls-parent:${s.id}`, tone: 'error', area: 'listener', title: 'ListenerSet has no Gateway', subject, ref: s.ref, explain: 'The Gateway its parentRef names is not there, so its listeners exist nowhere.', fix: 'Correct spec.parentRef, or create the Gateway.', detail: '' });
        } else if (s.accepted === false) {
            const c = condition(s.conditions, 'Accepted');
            add({
                id: `ls-accepted:${s.id}`,
                tone: 'error',
                area: 'listener',
                title: 'ListenerSet not accepted',
                subject,
                ref: s.ref,
                explain: `The Gateway ${s.parent.namespace}/${s.parent.name} did not take its listeners. A Gateway only takes ListenerSets its spec.allowedListeners lets in. ${reason(c?.reason)?.explain ?? ''}`.trim(),
                fix: reason(c?.reason)?.fix ?? `Allow it in ${s.parent.name}'s spec.allowedListeners, or read the condition message.`,
                detail: detail(c),
            });
        }
    }

    // Routes and their backends.
    for (const r of topo.routes) routeProblems(r, add);

    return out.sort((a, b) => toneRank(b.tone) - toneRank(a.tone) || AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area) || a.subject.localeCompare(b.subject) || a.title.localeCompare(b.title));
}

type Add = (p: Omit<Problem, 'namespace'>) => void;

function gatewayProblems(g: GatewayView, add: Add): void {
    const subject = `Gateway ${g.namespace}/${g.name}`;
    if (!g.cls) {
        add({
            id: `gw-class:${g.id}`,
            tone: 'error',
            area: 'gateway',
            title: 'Its GatewayClass does not exist',
            subject,
            ref: g.ref,
            explain: `It asks for the class ${g.className || '(none)'}, which is not in the cluster, so no controller will ever program it.`,
            fix: 'Set spec.gatewayClassName to one of the classes that exists, or create the class.',
            detail: '',
        });
        return;
    }
    if (g.conditions.length === 0) {
        add({
            id: `gw-status:${g.id}`,
            tone: 'warn',
            area: 'gateway',
            title: 'No controller has reported on it',
            subject,
            ref: g.ref,
            explain: `The Gateway has no status at all. The controller for ${g.className} (${g.cls.controller}) has not picked it up.`,
            fix: 'Check that the controller is running and watching this namespace.',
            detail: '',
        });
        return;
    }
    for (const type of ['Accepted', 'Programmed']) {
        const c = condition(g.conditions, type);
        if (c?.status !== 'False') continue;
        const words = reason(c.reason);
        add({
            id: `gw-${type}:${g.id}`,
            tone: c.reason === 'Pending' ? 'warn' : 'error',
            area: 'gateway',
            title: type === 'Accepted' ? 'Gateway not accepted' : 'Gateway not programmed',
            subject,
            ref: g.ref,
            explain:
                (type === 'Accepted'
                    ? 'The controller refused the Gateway as written, so none of its listeners are served. '
                    : 'The controller accepted the Gateway but the data plane is not serving it yet. ') + (words?.explain ?? ''),
            fix: words?.fix ?? 'Read the condition message and the controller logs.',
            detail: detail(c),
        });
    }
}

function listenerProblems(l: ListenerView, add: Add): void {
    const subject = `Listener ${l.name} (${listenerLine(l)}) on ${l.gateway.namespace}/${l.gateway.name}`;
    const ref = l.owner;
    const conflicted = condition(l.conditions, 'Conflicted');
    if (conflicted?.status === 'True') {
        const words = reason(conflicted.reason) ?? REASONS.HostnameConflict!;
        add({ id: `l-conflict:${l.id}`, tone: 'error', area: 'listener', title: 'Listener conflicts with another', subject, ref, explain: words.explain, fix: words.fix, detail: detail(conflicted) });
    }
    for (const type of ['Accepted', 'ResolvedRefs', 'Programmed']) {
        const c = condition(l.conditions, type);
        if (c?.status !== 'False') continue;
        // A conflicted listener is also not Accepted/Programmed: one problem is enough.
        if (conflicted?.status === 'True' && type !== 'ResolvedRefs') continue;
        const words = reason(c.reason);
        add({
            id: `l-${type}:${l.id}`,
            tone: 'error',
            area: 'listener',
            title: type === 'ResolvedRefs' ? "Listener can't resolve a reference" : `Listener not ${type.toLowerCase()}`,
            subject,
            ref,
            explain: words?.explain ?? `The controller reports ${type} False on this listener; requests to it are not served.`,
            fix: words?.fix ?? 'Read the condition message.',
            detail: detail(c),
        });
    }
    for (const c of l.certs) {
        if (c.granted) continue;
        add({
            id: `l-cert:${l.id}:${c.namespace}/${c.name}`,
            tone: 'error',
            area: 'listener',
            title: 'Certificate in another namespace, no ReferenceGrant',
            subject,
            ref,
            explain: `The listener uses the Secret ${c.namespace}/${c.name}, which is outside ${l.owner.namespace}, and no ReferenceGrant in ${c.namespace} allows that. The controller will not load the certificate, so HTTPS on this listener fails.`,
            fix: `Add a ReferenceGrant in ${c.namespace} from Gateways in ${l.owner.namespace} to Secrets (optionally just ${c.name}).`,
            detail: '',
        });
    }
}

function routeProblems(r: RouteView, add: Add): void {
    const subject = `${r.type} ${r.namespace}/${r.name}`;
    const ref = r.ref;

    if (r.parents.length === 0) {
        add({
            id: `r-noparent:${r.id}`,
            tone: 'error',
            area: 'route',
            title: 'Route names no Gateway',
            subject,
            ref,
            explain: 'It has no parentRefs, so it is attached to nothing and never receives traffic.',
            fix: 'Add a parentRef to the Gateway (and listener) it is meant for.',
            detail: '',
        });
    }

    for (const p of r.parents) parentProblem(r, p, subject, add);

    // Backends: what the plugin can see for itself.
    const seen = new Set<string>();
    let sawMissing = false;
    let sawGrant = false;
    for (const rule of r.rules) {
        for (const b of rule.backends) {
            if (seen.has(b.key)) continue;
            seen.add(b.key);
            const bsubject = `${subject} → ${b.kind} ${b.namespace}/${b.name}`;
            if (b.exists === false) {
                sawMissing = true;
                add({
                    id: `b-missing:${r.id}:${b.key}`,
                    tone: 'error',
                    area: 'backend',
                    title: 'Backend Service is missing',
                    subject: bsubject,
                    ref,
                    explain: `The route sends traffic to the Service ${b.namespace}/${b.name}, which does not exist. ${b.share >= 1 ? 'Every request this rule matches' : `${Math.round(b.share * 100)}% of the requests this rule matches`} gets a 500.`,
                    fix: `Create the Service ${b.name} in ${b.namespace}, or correct the backendRef.`,
                    detail: '',
                });
            } else if (!b.granted) {
                sawGrant = true;
                add({
                    id: `b-grant:${r.id}:${b.key}`,
                    tone: 'error',
                    area: 'backend',
                    title: 'Cross-namespace backend without a ReferenceGrant',
                    subject: bsubject,
                    ref,
                    explain: `The route is in ${r.namespace} and its backend is in ${b.namespace}. The API only allows that when a ReferenceGrant in ${b.namespace} says so, and there is none. The controller refuses the reference and requests to it get a 500.`,
                    fix: `Create a ReferenceGrant in ${b.namespace} from ${r.type} in ${r.namespace} to Service${b.name ? ` ${b.name}` : 's'}.`,
                    detail: '',
                });
            } else if (b.exists && b.ready === 0 && b.weight > 0) {
                add({
                    id: `b-ready:${r.id}:${b.key}`,
                    tone: b.tone === 'error' ? 'error' : 'warn',
                    area: 'backend',
                    title: 'Backend has no ready endpoints',
                    subject: bsubject,
                    ref: b.ref ?? ref,
                    explain: `The Service ${b.namespace}/${b.name} exists but no pod behind it is ready${b.total ? ` (${b.total} not ready)` : ''}. ${b.share >= 1 ? 'Every request this rule matches fails, usually with a 503.' : `About ${Math.round(b.share * 100)}% of this rule's requests fail, usually with a 503.`}`,
                    fix: "Check the Service's selector matches running pods, that they pass their readiness probes, and that the workload is not scaled to zero.",
                    detail: '',
                });
            }
        }
        if (rule.backends.length === 0 && !rule.filters.some((f) => f.type === 'RequestRedirect')) {
            add({
                id: `r-nobackend:${r.id}:${rule.index}`,
                tone: 'warn',
                area: 'route',
                title: 'Rule with nowhere to send traffic',
                subject: `${subject}, rule ${rule.index + 1}`,
                ref,
                explain: 'The rule has no backendRefs and no redirect, so every request it matches fails.',
                fix: 'Add a backendRef, or a RequestRedirect filter.',
                detail: '',
            });
        }
    }

    // What the controller reported that the plugin did not already explain.
    if (r.unresolved && !((r.unresolved.reason === 'BackendNotFound' && sawMissing) || (r.unresolved.reason === 'RefNotPermitted' && sawGrant))) {
        const words = reason(r.unresolved.reason);
        add({
            id: `r-resolved:${r.id}`,
            tone: 'error',
            area: 'route',
            title: "Route can't resolve a reference",
            subject,
            ref,
            explain: words?.explain ?? 'The controller could not resolve one of the route’s references.',
            fix: words?.fix ?? 'Read the condition message.',
            detail: detail(r.unresolved),
        });
    }
    if (r.partiallyInvalid) {
        add({
            id: `r-partial:${r.id}`,
            tone: 'warn',
            area: 'route',
            title: 'Some rules were dropped',
            subject,
            ref,
            explain: 'The controller found some of the rules invalid and serves only the rest.',
            fix: 'Read the condition message for which rules, and fix or remove them.',
            detail: detail(r.partiallyInvalid),
        });
    }
}

function parentProblem(r: RouteView, p: ParentView, subject: string, add: Add): void {
    const target = `${p.ref.kind} ${p.ref.namespace}/${p.ref.name}${p.ref.sectionName ? ` (listener ${p.ref.sectionName})` : ''}`;
    if (p.missing) {
        add({
            id: `r-missing:${r.id}:${p.index}`,
            tone: 'error',
            area: 'route',
            title: 'Orphaned: its Gateway does not exist',
            subject,
            ref: r.ref,
            explain: `The route asks to attach to ${target}, which is not in the cluster. Nothing will ever send it traffic${r.parents.length > 1 ? ' through that parent' : ''}.`,
            fix: `Point parentRefs at a Gateway that exists, or create ${p.ref.namespace}/${p.ref.name}. Delete the route if it is left over.`,
            detail: detail(condition(p.status?.conditions, 'Accepted')),
        });
        return;
    }
    if (p.accepted === false || (p.accepted === null && p.listeners.length === 0)) {
        const words = reason(p.reason);
        add({
            id: `r-accepted:${r.id}:${p.index}`,
            tone: 'error',
            area: 'route',
            title: p.accepted === false ? 'Not accepted by its Gateway' : 'Would not attach to its Gateway',
            subject,
            ref: r.ref,
            explain: p.specWhy ? `${p.specWhy} Until that changes, the route gets no traffic through ${target}.` : `${p.message || `It is not attached to ${target}.`} ${words?.explain ?? ''}`.trim(),
            fix: words?.fix ?? 'Read the condition message.',
            detail: detail(condition(p.status?.conditions, 'Accepted')),
        });
        return;
    }
    if (p.accepted === null) {
        add({
            id: `r-pending:${r.id}:${p.index}`,
            tone: 'warn',
            area: 'route',
            title: 'No status from the controller yet',
            subject,
            ref: r.ref,
            explain: `By the spec it lands on ${p.listeners.map((l) => l.name).join(', ')} of ${target}, but no controller has confirmed it. Until one does, it may not be serving.`,
            fix: "Check the Gateway's controller is running. If the Gateway itself is fine, look at the controller's logs for this route.",
            detail: '',
        });
    }
}

/** Counts by tone, for tiles. */
export function tally(list: readonly Problem[]): Record<Tone, number> {
    const out: Record<Tone, number> = { error: 0, warn: 0, ok: 0, info: 0, '': 0 };
    for (const p of list) out[p.tone]++;
    return out;
}
