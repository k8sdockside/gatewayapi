// The Gateway API objects, as far as the plugin reads them.
//
// Field names are the JSON tags of the v1 API types in
// sigs.k8s.io/gateway-api/apis/v1 (checked against the v1.6.1 CRDs). Every
// field is optional here because a cluster hands back whatever was written,
// and a page that trusts `spec.listeners` to be there is a page that throws on
// the first half-written Gateway.

/** The app's names for the kinds the plugin reads. Plain kinds, not `crd:`. */
export const KIND = {
    classes: 'gatewayclasses',
    gateways: 'gateways',
    listenerSets: 'listenersets',
    httpRoutes: 'httproutes',
    grpcRoutes: 'grpcroutes',
    tlsRoutes: 'tlsroutes',
    tcpRoutes: 'tcproutes',
    udpRoutes: 'udproutes',
    backendTLS: 'backendtlspolicies',
    grants: 'referencegrants',
    services: 'services',
    slices: 'endpointslices',
    namespaces: 'namespaces',
} as const;

export const GROUP = 'gateway.networking.k8s.io';

export type RouteType = 'HTTPRoute' | 'GRPCRoute' | 'TLSRoute' | 'TCPRoute' | 'UDPRoute';

export const ROUTE_TYPES: readonly RouteType[] = ['HTTPRoute', 'GRPCRoute', 'TLSRoute', 'TCPRoute', 'UDPRoute'];

/** The app kind each route type is listed and opened as. */
export const ROUTE_KIND: Record<RouteType, string> = {
    HTTPRoute: KIND.httpRoutes,
    GRPCRoute: KIND.grpcRoutes,
    TLSRoute: KIND.tlsRoutes,
    TCPRoute: KIND.tcpRoutes,
    UDPRoute: KIND.udpRoutes,
};

/** How a route type is written for a person: short, for chips and node labels. */
export const ROUTE_WORD: Record<RouteType, string> = {
    HTTPRoute: 'HTTP',
    GRPCRoute: 'gRPC',
    TLSRoute: 'TLS',
    TCPRoute: 'TCP',
    UDPRoute: 'UDP',
};

export interface Condition {
    type: string;
    status: 'True' | 'False' | 'Unknown' | string;
    reason?: string;
    message?: string;
    lastTransitionTime?: string;
    observedGeneration?: number;
}

type Obj = K8sDockside.KubeObject;

export interface LabelSelector {
    matchLabels?: Record<string, string>;
    matchExpressions?: { key: string; operator: string; values?: string[] }[];
}

export interface AllowedRoutes {
    namespaces?: { from?: 'All' | 'Same' | 'Selector' | string; selector?: LabelSelector };
    kinds?: { group?: string; kind: string }[];
}

export interface SecretRef {
    group?: string;
    kind?: string;
    name: string;
    namespace?: string;
}

export interface Listener {
    name: string;
    hostname?: string;
    port: number;
    protocol: string;
    tls?: { mode?: 'Terminate' | 'Passthrough' | string; certificateRefs?: SecretRef[] };
    allowedRoutes?: AllowedRoutes;
}

export interface ListenerStatus {
    name: string;
    attachedRoutes?: number;
    supportedKinds?: { group?: string; kind: string }[];
    conditions?: Condition[];
}

export interface GatewayClass extends Obj {
    spec?: { controllerName?: string; description?: string; parametersRef?: { group?: string; kind?: string; name?: string; namespace?: string } };
    status?: { conditions?: Condition[] };
}

export interface Gateway extends Obj {
    spec?: {
        gatewayClassName?: string;
        listeners?: Listener[];
        addresses?: { type?: string; value?: string }[];
        allowedListeners?: { namespaces?: { from?: string; selector?: LabelSelector } };
    };
    status?: {
        addresses?: { type?: string; value?: string }[];
        conditions?: Condition[];
        listeners?: ListenerStatus[];
        attachedListenerSets?: number;
    };
}

export interface ParentRef {
    group?: string;
    kind?: string;
    namespace?: string;
    name: string;
    sectionName?: string;
    port?: number;
}

export interface ListenerSet extends Obj {
    spec?: { parentRef?: ParentRef; listeners?: Listener[] };
    status?: { conditions?: Condition[]; listeners?: ListenerStatus[] };
}

export interface BackendRef {
    group?: string;
    kind?: string;
    name: string;
    namespace?: string;
    port?: number;
    weight?: number;
    filters?: Filter[];
}

export interface PathMatch {
    type?: 'Exact' | 'PathPrefix' | 'RegularExpression' | string;
    value?: string;
}

export interface ValueMatch {
    type?: 'Exact' | 'RegularExpression' | string;
    name: string;
    value: string;
}

export interface HTTPMatch {
    path?: PathMatch;
    headers?: ValueMatch[];
    queryParams?: ValueMatch[];
    method?: string;
}

export interface GRPCMatch {
    method?: { type?: 'Exact' | 'RegularExpression' | string; service?: string; method?: string };
    headers?: ValueMatch[];
}

export interface HeaderModifier {
    set?: { name: string; value: string }[];
    add?: { name: string; value: string }[];
    remove?: string[];
}

export interface Filter {
    type: string;
    requestHeaderModifier?: HeaderModifier;
    responseHeaderModifier?: HeaderModifier;
    requestRedirect?: {
        scheme?: string;
        hostname?: string;
        path?: { type: string; replaceFullPath?: string; replacePrefixMatch?: string };
        port?: number;
        statusCode?: number;
    };
    urlRewrite?: {
        hostname?: string;
        path?: { type: string; replaceFullPath?: string; replacePrefixMatch?: string };
    };
    requestMirror?: { backendRef?: BackendRef; percent?: number; fraction?: { numerator: number; denominator?: number } };
    extensionRef?: { group?: string; kind?: string; name?: string };
    [other: string]: unknown;
}

export interface RouteRule {
    name?: string;
    /** HTTPMatch on an HTTPRoute, GRPCMatch on a GRPCRoute; TLS, TCP and UDP rules have none. */
    matches?: (HTTPMatch | GRPCMatch)[];
    filters?: Filter[];
    backendRefs?: BackendRef[];
}

export interface RouteParentStatus {
    parentRef: ParentRef;
    controllerName?: string;
    conditions?: Condition[];
}

/** Every route type, read through one shape: TCP and UDP simply have no hostnames or matches. */
export interface Route extends Obj {
    spec?: { parentRefs?: ParentRef[]; hostnames?: string[]; rules?: RouteRule[] };
    status?: { parents?: RouteParentStatus[] };
}

export interface ReferenceGrant extends Obj {
    spec?: {
        from?: { group?: string; kind?: string; namespace?: string }[];
        to?: { group?: string; kind?: string; name?: string }[];
    };
}

export interface BackendTLSPolicy extends Obj {
    spec?: {
        targetRefs?: { group?: string; kind?: string; name?: string; sectionName?: string }[];
        validation?: { hostname?: string; wellKnownCACertificates?: string; caCertificateRefs?: { name?: string }[] };
    };
    status?: { ancestors?: { ancestorRef?: ParentRef; conditions?: Condition[] }[] };
}

export interface Service extends Obj {
    spec?: {
        type?: string;
        externalName?: string;
        clusterIP?: string;
        ports?: { name?: string; port: number; targetPort?: number | string; protocol?: string; appProtocol?: string }[];
        selector?: Record<string, string>;
    };
}

export interface EndpointSlice extends Obj {
    endpoints?: { addresses?: string[]; conditions?: { ready?: boolean; serving?: boolean; terminating?: boolean }; targetRef?: { kind?: string; name?: string } }[];
    ports?: { name?: string; port?: number }[];
}

export interface Namespace extends Obj {
    status?: { phase?: string };
}

/** Everything the pages read, in one place: the input to `topology()`. */
export interface Snapshot {
    classes: GatewayClass[];
    gateways: Gateway[];
    listenerSets: ListenerSet[];
    routes: { type: RouteType; items: Route[] }[];
    grants: ReferenceGrant[];
    backendTLS: BackendTLSPolicy[];
    services: Service[];
    slices: EndpointSlice[];
    /** `null` when the namespaces could not be read: a Selector then cannot be judged. */
    namespaces: Namespace[] | null;
}
