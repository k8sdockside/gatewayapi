// Built by scripts/build.mjs from src/ -- edit the TypeScript there, not this file.
"use strict";
(() => {
  // src/model/hostnames.ts
  function normalHost(host) {
    let h = host.trim().toLowerCase();
    if (!h.startsWith("[")) h = h.replace(/:\d+$/, "");
    return h.replace(/\.$/, "");
  }
  function isWildcard(pattern) {
    return pattern.startsWith("*.");
  }
  function hostMatches(pattern, host) {
    if (!pattern) return true;
    const p = normalHost(pattern);
    const h = normalHost(host);
    if (isWildcard(p)) {
      const suffix = p.slice(1);
      return h.length > suffix.length && h.endsWith(suffix);
    }
    return p === h;
  }
  function hostsIntersect(a, b) {
    if (!a || !b) return true;
    const x = normalHost(a);
    const y = normalHost(b);
    if (x === y) return true;
    if (isWildcard(x) && isWildcard(y)) {
      return x.endsWith(y.slice(1)) || y.endsWith(x.slice(1));
    }
    if (isWildcard(x)) return hostMatches(x, y);
    if (isWildcard(y)) return hostMatches(y, x);
    return false;
  }
  function effectiveHostnames(routeHosts, listenerHost) {
    if (!listenerHost) return [...routeHosts];
    return routeHosts.filter((h) => hostsIntersect(h, listenerHost));
  }

  // src/model/tone.ts
  var RANK = { error: 4, warn: 3, "": 2, info: 1, ok: 0 };
  function toneRank(tone) {
    return RANK[tone] ?? 2;
  }
  function worst(tones) {
    let out = "ok";
    for (const t of tones) if (toneRank(t) > toneRank(out)) out = t;
    return out;
  }
  function condition(conditions, type) {
    return conditions?.find((c) => c.type === type);
  }
  function isTrue(conditions, type) {
    const c = condition(conditions, type);
    if (!c) return null;
    if (c.status === "True") return true;
    if (c.status === "False") return false;
    return null;
  }
  function positiveTone(conditions, type) {
    const v = isTrue(conditions, type);
    return v === true ? "ok" : v === false ? "error" : "warn";
  }
  function plural(n, one, many = `${one}s`) {
    return `${n} ${n === 1 ? one : many}`;
  }

  // src/model/types.ts
  var KIND = {
    classes: "gatewayclasses",
    gateways: "gateways",
    listenerSets: "listenersets",
    httpRoutes: "httproutes",
    grpcRoutes: "grpcroutes",
    tlsRoutes: "tlsroutes",
    tcpRoutes: "tcproutes",
    udpRoutes: "udproutes",
    backendTLS: "backendtlspolicies",
    grants: "referencegrants",
    services: "services",
    slices: "endpointslices",
    namespaces: "namespaces"
  };
  var GROUP = "gateway.networking.k8s.io";
  var ROUTE_TYPES = ["HTTPRoute", "GRPCRoute", "TLSRoute", "TCPRoute", "UDPRoute"];
  var ROUTE_KIND = {
    HTTPRoute: KIND.httpRoutes,
    GRPCRoute: KIND.grpcRoutes,
    TLSRoute: KIND.tlsRoutes,
    TCPRoute: KIND.tcpRoutes,
    UDPRoute: KIND.udpRoutes
  };
  var ROUTE_WORD = {
    HTTPRoute: "HTTP",
    GRPCRoute: "gRPC",
    TLSRoute: "TLS",
    TCPRoute: "TCP",
    UDPRoute: "UDP"
  };

  // src/model/topology.ts
  function key(namespace, name) {
    return `${namespace ?? ""}/${name}`;
  }
  function refOf(kind, obj) {
    return { kind, namespace: obj.metadata.namespace ?? "", name: obj.metadata.name };
  }
  function defaultKinds(protocol) {
    switch (protocol.toUpperCase()) {
      case "HTTP":
      case "HTTPS":
        return ["HTTPRoute", "GRPCRoute"];
      case "TLS":
        return ["TLSRoute"];
      case "TCP":
        return ["TCPRoute"];
      case "UDP":
        return ["UDPRoute"];
      default:
        return [];
    }
  }
  var ROUTE_TYPE_SET = /* @__PURE__ */ new Set(["HTTPRoute", "GRPCRoute", "TLSRoute", "TCPRoute", "UDPRoute"]);
  function listenerKinds(listener, status) {
    const declared = listener.allowedRoutes?.kinds?.filter((k) => (k.group ?? GROUP) === GROUP && ROUTE_TYPE_SET.has(k.kind)).map((k) => k.kind);
    if (declared && declared.length) return declared;
    const supported = status?.supportedKinds?.filter((k) => ROUTE_TYPE_SET.has(k.kind)).map((k) => k.kind);
    if (supported && supported.length) return supported;
    return defaultKinds(listener.protocol ?? "");
  }
  function selectorMatches(selector, labels) {
    if (!selector) return true;
    for (const [k, v] of Object.entries(selector.matchLabels ?? {})) if (labels[k] !== v) return false;
    for (const e of selector.matchExpressions ?? []) {
      const has = Object.prototype.hasOwnProperty.call(labels, e.key);
      const value = labels[e.key];
      switch (e.operator) {
        case "In":
          if (!has || !(e.values ?? []).includes(value ?? "")) return false;
          break;
        case "NotIn":
          if (has && (e.values ?? []).includes(value ?? "")) return false;
          break;
        case "Exists":
          if (!has) return false;
          break;
        case "DoesNotExist":
          if (has) return false;
          break;
        default:
          return false;
      }
    }
    return true;
  }
  function granted(grants, from, to) {
    if (from.namespace === to.namespace) return true;
    return grants.some(
      (g) => (g.metadata.namespace ?? "") === to.namespace && (g.spec?.from ?? []).some((f) => (f.group ?? "") === from.group && f.kind === from.kind && f.namespace === from.namespace) && (g.spec?.to ?? []).some((t) => (t.group ?? "") === to.group && t.kind === to.kind && (!t.name || t.name === to.name))
    );
  }
  function sameParent(a, b, routeNamespace) {
    return (a.group ?? GROUP) === b.group && (a.kind ?? "Gateway") === b.kind && (a.namespace ?? routeNamespace) === b.namespace && a.name === b.name && (a.sectionName ?? "") === b.sectionName && (a.port ?? null) === b.port;
  }
  function topology(snap) {
    const nsLabels = /* @__PURE__ */ new Map();
    for (const ns of snap.namespaces ?? []) nsLabels.set(ns.metadata.name, ns.metadata.labels ?? {});
    const namespacesKnown = snap.namespaces !== null;
    const classes = /* @__PURE__ */ new Map();
    for (const c of snap.classes) {
      const accepted = isTrue(c.status?.conditions, "Accepted");
      classes.set(c.metadata.name, {
        id: "class:" + c.metadata.name,
        ref: refOf(KIND.classes, c),
        name: c.metadata.name,
        controller: c.spec?.controllerName ?? "",
        description: c.spec?.description ?? "",
        accepted,
        condition: condition(c.status?.conditions, "Accepted"),
        tone: positiveTone(c.status?.conditions, "Accepted"),
        gateways: []
      });
    }
    const services = /* @__PURE__ */ new Map();
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
        external: s.spec?.type === "ExternalName" ? s.spec.externalName ?? "" : "",
        uses: []
      });
    }
    const tlsPolicies = /* @__PURE__ */ new Map();
    for (const p of snap.backendTLS) {
      for (const t of p.spec?.targetRefs ?? []) {
        if ((t.group ?? "") === "" && (t.kind ?? "Service") === "Service" && t.name) tlsPolicies.set(key(p.metadata.namespace, t.name), p.metadata.name);
      }
    }
    const gateways = [];
    const gatewayByKey = /* @__PURE__ */ new Map();
    const listeners = [];
    for (const g of sortByName(snap.gateways)) {
      const conditions = g.status?.conditions ?? [];
      const className = g.spec?.gatewayClassName ?? "";
      const cls = classes.get(className) ?? null;
      const view = {
        id: "gw:" + key(g.metadata.namespace, g.metadata.name),
        ref: refOf(KIND.gateways, g),
        name: g.metadata.name,
        namespace: g.metadata.namespace ?? "",
        className,
        cls,
        addresses: (g.status?.addresses ?? []).map((a) => a.value ?? "").filter(Boolean),
        conditions,
        accepted: isTrue(conditions, "Accepted"),
        programmed: isTrue(conditions, "Programmed"),
        tone: "ok",
        listeners: [],
        sets: [],
        obj: g
      };
      view.tone = !cls ? "error" : worst([positiveTone(conditions, "Accepted"), positiveTone(conditions, "Programmed")]);
      cls?.gateways.push(view);
      for (const l of g.spec?.listeners ?? []) {
        const lv = listenerView(view, l, g.status?.listeners, view.ref, "", snap.grants, "Gateway", conditions.length > 0);
        view.listeners.push(lv);
        listeners.push(lv);
      }
      gateways.push(view);
      gatewayByKey.set(key(view.namespace, view.name), view);
    }
    const listenerSets = [];
    const setByKey = /* @__PURE__ */ new Map();
    for (const s of sortByName(snap.listenerSets)) {
      const ns = s.metadata.namespace ?? "";
      const p = s.spec?.parentRef;
      const parent = p ? gatewayByKey.get(key(p.namespace ?? ns, p.name)) ?? null : null;
      const conditions = s.status?.conditions ?? [];
      const view = {
        id: "ls:" + key(ns, s.metadata.name),
        ref: refOf(KIND.listenerSets, s),
        name: s.metadata.name,
        namespace: ns,
        parent,
        accepted: isTrue(conditions, "Accepted"),
        conditions,
        tone: parent ? positiveTone(conditions, "Accepted") : "error",
        listeners: []
      };
      if (parent) {
        for (const l of s.spec?.listeners ?? []) {
          const lv = listenerView(parent, l, s.status?.listeners, view.ref, key(ns, s.metadata.name), snap.grants, "ListenerSet", conditions.length > 0);
          if (view.accepted === false) {
            lv.tone = "error";
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
    const routes = [];
    for (const group of snap.routes) {
      for (const r of group.items) routes.push(routeView(group.type, r));
    }
    routes.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
    function routeView(type, r) {
      const ns = r.metadata.namespace ?? "";
      const hostnames = type === "TCPRoute" || type === "UDPRoute" ? [] : r.spec?.hostnames ?? [];
      const view = {
        id: `route:${type}:${key(ns, r.metadata.name)}`,
        type,
        ref: refOf(ROUTE_KIND[type], r),
        name: r.metadata.name,
        namespace: ns,
        created: r.metadata.creationTimestamp ?? "",
        hostnames,
        parents: [],
        rules: [],
        attached: false,
        orphan: false,
        unresolved: null,
        partiallyInvalid: null,
        tone: "ok",
        obj: r
      };
      (r.spec?.parentRefs ?? []).forEach((p, index) => {
        view.parents.push(parentView(view, p, index));
      });
      for (const s of r.status?.parents ?? []) {
        const rr = condition(s.conditions, "ResolvedRefs");
        if (rr?.status === "False" && !view.unresolved) view.unresolved = rr;
        const pi = condition(s.conditions, "PartiallyInvalid");
        if (pi?.status === "True" && !view.partiallyInvalid) view.partiallyInvalid = pi;
      }
      (r.spec?.rules ?? []).forEach((rule, index) => {
        view.rules.push(ruleView(view, rule, index));
      });
      view.attached = view.parents.some((p) => p.listeners.length > 0 && p.accepted !== false);
      view.orphan = !view.attached;
      view.tone = worst([
        ...view.parents.map((p) => p.tone),
        ...view.rules.map((rule) => rule.tone),
        view.unresolved ? "error" : "ok",
        view.partiallyInvalid ? "warn" : "ok",
        view.parents.length === 0 ? "error" : "ok"
      ]);
      for (const p of view.parents) {
        if (p.accepted === false) continue;
        for (const l of p.listeners) l.attachments.push({ route: view, parent: p, listener: l });
      }
      return view;
    }
    function parentView(route, p, index) {
      const ref = {
        group: p.group ?? GROUP,
        kind: p.kind ?? "Gateway",
        namespace: p.namespace ?? route.namespace,
        name: p.name,
        sectionName: p.sectionName ?? "",
        port: p.port ?? null
      };
      const view = {
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
        reason: "",
        message: "",
        specWhy: "",
        tone: "ok"
      };
      view.accepted = isTrue(view.status?.conditions, "Accepted");
      view.resolvedRefs = isTrue(view.status?.conditions, "ResolvedRefs");
      let pool = [];
      let ownerNamespace = "";
      if (ref.group === GROUP && ref.kind === "Gateway") {
        view.gateway = gatewayByKey.get(key(ref.namespace, ref.name)) ?? null;
        pool = view.gateway?.listeners.filter((l) => !l.viaSet) ?? [];
        ownerNamespace = view.gateway?.namespace ?? "";
      } else if (ref.group === GROUP && ref.kind === "ListenerSet") {
        view.listenerSet = setByKey.get(key(ref.namespace, ref.name)) ?? null;
        view.gateway = view.listenerSet?.parent ?? null;
        pool = view.listenerSet?.listeners ?? [];
        ownerNamespace = view.listenerSet?.namespace ?? "";
      } else {
        view.reason = "UnsupportedParent";
        view.message = `${ref.kind} is not a parent this plugin can follow.`;
        view.tone = view.accepted === true ? "ok" : "";
        return view;
      }
      if (!view.gateway || ref.kind === "ListenerSet" && !view.listenerSet) {
        view.missing = true;
        view.reason = view.status ? condition(view.status.conditions, "Accepted")?.reason ?? "NoMatchingParent" : "NoMatchingParent";
        view.message = `There is no ${ref.kind} ${ref.namespace}/${ref.name}.`;
        view.tone = "error";
        return view;
      }
      let asked = pool;
      if (ref.sectionName) asked = asked.filter((l) => l.name === ref.sectionName);
      if (ref.port !== null) asked = asked.filter((l) => l.port === ref.port);
      view.candidates = asked;
      let why = "";
      const refusals = /* @__PURE__ */ new Map();
      const refuse = (reason, l, sentence) => {
        why = reason;
        const key2 = sentence("\0");
        refusals.set(key2, [...refusals.get(key2) ?? [], l.name]);
      };
      const landed = asked.filter((l) => {
        if (!l.kinds.includes(route.type)) {
          refuse("NotAllowedByListeners", l, (n) => `${n} ${l.kinds.join(", ") || "no routes"}, not ${route.type}.`);
          return false;
        }
        const nsOwner = l.viaSet ? setByKey.get(l.viaSet)?.namespace ?? ownerNamespace : ownerNamespace;
        if (!namespaceAllowed(l, route.namespace, nsOwner)) {
          refuse(
            "NotAllowedByListeners",
            l,
            (n) => l.allowedFrom === "Selector" ? `${n} routes only from namespaces matching a selector, and ${route.namespace} does not match.` : `${n} routes only from ${nsOwner}, their own namespace; this route is in ${route.namespace}.`
          );
          return false;
        }
        if (route.hostnames.length && l.hostname && (route.type === "HTTPRoute" || route.type === "GRPCRoute" || route.type === "TLSRoute")) {
          if (effectiveHostnames(route.hostnames, l.hostname).length === 0) {
            refuse("NoMatchingListenerHostname", l, (n) => `${n} ${l.hostname}, and none of the route's hostnames (${route.hostnames.join(", ")}) fall under it.`);
            return false;
          }
        }
        return true;
      });
      const verb = {
        NoMatchingListenerHostname: ["is for", "are for"],
        NotAllowedByListeners: ["takes", "take"]
      };
      let whyMessage = [...refusals.entries()].map(([sentence, names]) => {
        const [one, many] = verb[why] ?? ["takes", "take"];
        const subject = names.length === 1 ? `The listener ${names[0]} ${one}` : `The listeners ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} ${many}`;
        return sentence.replace("\0", subject).replace(" their own namespace", names.length === 1 ? " its own namespace" : " their own namespace");
      }).join(" ");
      if (asked.length === 0) {
        why = "NoMatchingParent";
        whyMessage = ref.sectionName ? `${view.gateway.namespace}/${view.gateway.name} has no listener named ${ref.sectionName}${ref.port !== null ? ` on port ${ref.port}` : ""}.` : ref.port !== null ? `${view.gateway.namespace}/${view.gateway.name} has no listener on port ${ref.port}.` : `${view.gateway.namespace}/${view.gateway.name} has no listeners.`;
      }
      view.listeners = landed;
      if (landed.length === 0) view.specWhy = whyMessage;
      const acceptedCond = condition(view.status?.conditions, "Accepted");
      if (view.accepted === false) {
        view.listeners = [];
        view.reason = acceptedCond?.reason ?? why;
        view.message = acceptedCond?.message || whyMessage;
        view.tone = "error";
      } else if (view.accepted === true) {
        if (view.listeners.length === 0) view.listeners = asked.filter((l) => l.kinds.includes(route.type));
        view.tone = view.resolvedRefs === false ? "error" : "ok";
        if (view.resolvedRefs === false) {
          const rr = condition(view.status?.conditions, "ResolvedRefs");
          view.reason = rr?.reason ?? "";
          view.message = rr?.message ?? "";
        }
      } else if (landed.length === 0) {
        view.reason = why || "NoMatchingParent";
        view.message = whyMessage;
        view.tone = "error";
      } else {
        view.reason = "Pending";
        view.message = view.status ? "The controller has not decided whether to accept it yet." : `No controller has written a status for ${view.gateway.namespace}/${view.gateway.name} on this route yet.`;
        view.tone = "warn";
      }
      if (!namespacesKnown && !view.status && view.listeners.some((l) => l.allowedFrom === "Selector")) {
        view.message += " (The namespaces could not be read, so a Selector could not be checked.)";
      }
      return view;
    }
    function namespaceAllowed(l, routeNamespace, ownerNamespace) {
      switch (l.allowedFrom) {
        case "All":
          return true;
        case "Selector":
          if (!namespacesKnown) return true;
          return selectorMatches(l.selector, nsLabels.get(routeNamespace) ?? {});
        default:
          return routeNamespace === ownerNamespace;
      }
    }
    function ruleView(route, rule, index) {
      const refs = rule.backendRefs ?? [];
      const total = refs.reduce((n, b) => n + weightOf(b), 0);
      const backends = refs.map((b) => backendView(route, b, total));
      for (const b of backends) {
        if (b.exists && b.isService && !b.external && b.ready === 0 && b.weight > 0) {
          b.tone = b.share >= 1 ? "error" : "warn";
        }
      }
      const filters = rule.filters ?? [];
      const answersItself = filters.some((f) => f.type === "RequestRedirect");
      const view = {
        index,
        name: rule.name ?? "",
        rule,
        filters,
        backends,
        tone: backends.length === 0 && !answersItself ? "warn" : worst(backends.filter((b) => b.weight > 0).map((b) => b.tone))
      };
      for (const b of backends) {
        const s = services.get(key(b.namespace, b.name));
        if (b.isService && s) s.uses.push({ route, rule: view, backend: b });
      }
      return view;
    }
    function backendView(route, b, total) {
      const group = b.group ?? "";
      const kind = b.kind ?? "Service";
      const namespace = b.namespace ?? route.namespace;
      const isService = group === "" && kind === "Service";
      const weight = weightOf(b);
      const svc = isService ? services.get(key(namespace, b.name)) : void 0;
      const cross = namespace !== route.namespace;
      const ok = granted(snap.grants, { group: GROUP, kind: route.type, namespace: route.namespace }, { group, kind, namespace, name: b.name });
      const view = {
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
        external: svc?.external ?? "",
        tlsPolicy: isService ? tlsPolicies.get(key(namespace, b.name)) ?? "" : "",
        tone: "ok",
        problem: ""
      };
      if (isService && !svc) {
        view.tone = "error";
        view.problem = `There is no Service ${namespace}/${b.name}.`;
      } else if (!ok) {
        view.tone = "error";
        view.problem = `No ReferenceGrant in ${namespace} lets ${route.type}s from ${route.namespace} send traffic to ${kind} ${b.name}.`;
      } else if (!isService) {
        view.tone = "";
        view.problem = `A ${kind}${group ? ` (${group})` : ""}: the plugin cannot see whether it is healthy.`;
      } else if (weight === 0) {
        view.tone = "";
      }
      return view;
    }
    const namespaces = /* @__PURE__ */ new Set();
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
      namespaces: [...namespaces].filter(Boolean).sort()
    };
  }
  function weightOf(b) {
    return typeof b.weight === "number" && b.weight >= 0 ? b.weight : 1;
  }
  function sortByName(list) {
    return [...list].sort((a, b) => (a.metadata.namespace ?? "").localeCompare(b.metadata.namespace ?? "") || a.metadata.name.localeCompare(b.metadata.name));
  }
  function listenerView(gateway, l, statuses, owner, viaSet, grants, ownerKind, ownerHasStatus) {
    const status = statuses?.find((s) => s.name === l.name) ?? null;
    const conditions = status?.conditions ?? [];
    const certs = (l.tls?.certificateRefs ?? []).map((c) => {
      const ns = c.namespace ?? owner.namespace;
      return {
        namespace: ns,
        name: c.name,
        granted: granted(grants, { group: GROUP, kind: ownerKind, namespace: owner.namespace }, { group: c.group ?? "", kind: c.kind ?? "Secret", namespace: ns, name: c.name })
      };
    });
    const view = {
      id: `listener:${gateway.id}:${viaSet ? viaSet + ":" : ""}${l.name}`,
      gateway,
      owner,
      viaSet,
      name: l.name,
      port: l.port,
      protocol: l.protocol ?? "",
      hostname: l.hostname ?? "",
      tlsMode: l.tls?.mode ?? (l.tls ? "Terminate" : ""),
      certs,
      allowedFrom: l.allowedRoutes?.namespaces?.from ?? "Same",
      selector: l.allowedRoutes?.namespaces?.selector,
      kinds: listenerKinds(l, status),
      status,
      conditions,
      tone: "ok",
      notes: [],
      attachments: []
    };
    const tones = [];
    const conflicted = condition(conditions, "Conflicted");
    if (conflicted?.status === "True") {
      tones.push("error");
      view.notes.push(conflicted.message || `It conflicts with another listener (${conflicted.reason ?? "Conflicted"}).`);
    }
    for (const type of ["Accepted", "ResolvedRefs", "Programmed"]) {
      const c = condition(conditions, type);
      if (c?.status === "False") {
        tones.push("error");
        view.notes.push(`${type} is False${c.reason ? ` (${c.reason})` : ""}${c.message ? `: ${c.message}` : ""}`);
      }
    }
    for (const c of certs) {
      if (!c.granted) {
        tones.push("error");
        view.notes.push(`Its certificate ${c.namespace}/${c.name} is in another namespace, and no ReferenceGrant there lets the ${ownerKind} use it.`);
      }
    }
    if (!status && ownerHasStatus) {
      tones.push("warn");
      view.notes.push("The controller has not reported on this listener.");
    } else if (!status) {
      tones.push("warn");
    }
    view.tone = worst(tones);
    return view;
  }
  function countEndpoints(slices) {
    const seen = /* @__PURE__ */ new Map();
    for (const s of slices) {
      const svc = s.metadata.labels?.["kubernetes.io/service-name"];
      if (!svc) continue;
      const k = key(s.metadata.namespace, svc);
      const mine = seen.get(k) ?? /* @__PURE__ */ new Map();
      for (const e of s.endpoints ?? []) {
        const id = e.targetRef?.name ? `pod:${e.targetRef.name}` : e.addresses?.[0] ?? "";
        if (!id) continue;
        const ready = e.conditions?.ready !== false;
        mine.set(id, (mine.get(id) ?? false) || ready);
      }
      seen.set(k, mine);
    }
    const out = /* @__PURE__ */ new Map();
    for (const [k, eps] of seen) out.set(k, { ready: [...eps.values()].filter(Boolean).length, total: eps.size });
    return out;
  }
  function listenerLine(l) {
    return `${l.protocol} :${l.port}${l.hostname ? " " + l.hostname : ""}`;
  }

  // src/model/graph.ts
  var COLUMNS = ["Gateways", "Listeners", "Routes", "Backends"];
  var COLUMN_OF = { gateway: 0, listener: 1, route: 2, group: 2, backend: 3 };
  var DEFAULT_OPTIONS = { namespace: "", gatewayId: "", search: "", problemsOnly: false, expanded: /* @__PURE__ */ new Set(), collapseAt: 8 };
  function edgeId(from, to) {
    return `${from}->${to}`;
  }
  function pct(share) {
    const p = share * 100;
    return p >= 10 || p === 0 ? `${Math.round(p)}%` : `${p.toFixed(1).replace(/\.0$/, "")}%`;
  }
  function buildGraph(topo, options = {}) {
    const opt = { ...DEFAULT_OPTIONS, ...options };
    const nodes = /* @__PURE__ */ new Map();
    const meta = /* @__PURE__ */ new Map();
    const chains = [];
    const chainListener = /* @__PURE__ */ new Map();
    const node = (n) => {
      if (!nodes.has(n.id)) {
        nodes.set(n.id, {
          ghost: false,
          ready: null,
          count: 0,
          groupOf: "",
          title: "",
          ...n,
          col: COLUMN_OF[n.type],
          text: (n.text ?? `${n.label} ${n.sub} ${n.kicker}`).toLowerCase()
        });
      }
      return n.id;
    };
    const edge = (from, to, tone, broken = false, label = "", title2 = "") => {
      const id = edgeId(from, to);
      const m = meta.get(id) ?? { tones: [], broken: false, labels: /* @__PURE__ */ new Set(), titles: /* @__PURE__ */ new Set() };
      m.tones.push(tone);
      m.broken ||= broken;
      if (label) m.labels.add(label);
      if (title2) m.titles.add(title2);
      meta.set(id, m);
    };
    const gatewayNode = (g) => node({
      id: g.id,
      type: "gateway",
      kicker: g.className ? `Gateway · ${g.className}` : "Gateway",
      label: g.name,
      sub: [g.namespace, g.addresses[0] ?? (g.programmed ? "" : "no address")].filter(Boolean).join(" · "),
      tone: g.tone,
      ref: g.ref,
      title: `Gateway ${g.namespace}/${g.name}
class ${g.className || "—"}
${g.addresses.length ? "address " + g.addresses.join(", ") : "no address yet"}
Accepted ${word(g.accepted)} · Programmed ${word(g.programmed)}`,
      text: `${g.name} ${g.namespace} ${g.className} ${g.addresses.join(" ")}`
    });
    const listenerNode = (l) => node({
      id: l.id,
      type: "listener",
      kicker: `${l.protocol} :${l.port}`,
      label: l.hostname || "any host",
      sub: [l.name, l.tlsMode === "Passthrough" ? "passthrough" : "", l.viaSet ? `from ${l.viaSet}` : ""].filter(Boolean).join(" · "),
      tone: l.tone,
      ref: l.owner,
      title: `Listener ${l.name} on ${l.gateway.namespace}/${l.gateway.name}
${listenerLine(l)}
routes from: ${l.allowedFrom} namespaces · kinds: ${l.kinds.join(", ") || "—"}${l.status?.attachedRoutes !== void 0 ? `
attached routes (reported): ${l.status.attachedRoutes}` : ""}${l.notes.length ? "\n\n" + l.notes.join("\n") : ""}`,
      text: `${l.name} ${l.hostname} ${l.protocol} ${l.port} ${l.viaSet}`
    });
    const routeNode = (r) => node({
      id: r.id,
      type: "route",
      kicker: r.type,
      label: r.name,
      sub: [r.namespace, r.hostnames.length ? r.hostnames[0] + (r.hostnames.length > 1 ? ` +${r.hostnames.length - 1}` : "") : r.rules.length ? `${r.rules.length} rule${r.rules.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · "),
      tone: r.tone,
      ref: r.ref,
      title: `${r.type} ${r.namespace}/${r.name}
${r.hostnames.length ? "hosts " + r.hostnames.join(", ") : "any host on its listener"}
${r.rules.length} rule${r.rules.length === 1 ? "" : "s"}`,
      text: `${r.name} ${r.namespace} ${r.type} ${ROUTE_WORD[r.type]} ${r.hostnames.join(" ")}`
    });
    const backendNode = (b) => node({
      id: `backend:${b.key}`,
      type: "backend",
      kicker: b.isService ? b.external ? "Service · ExternalName" : "Service" : b.kind,
      label: b.name,
      sub: b.exists === false ? `${b.namespace} · does not exist` : b.external ? `${b.namespace} · ${b.external}` : `${b.namespace}${b.port !== null ? ` · :${b.port}` : ""}`,
      tone: b.exists === false ? "error" : b.isService && !b.external && b.ready === 0 ? "error" : b.isService ? "ok" : "",
      ref: b.exists === false ? null : b.ref,
      ghost: b.exists === false,
      ready: b.ready !== null && b.total !== null ? { ready: b.ready, total: b.total } : null,
      title: `${b.kind} ${b.namespace}/${b.name}${b.exists === false ? " — does not exist" : ""}${b.ready !== null ? `
${b.ready} of ${b.total} endpoints ready` : ""}${b.tlsPolicy ? `
TLS to the backend: BackendTLSPolicy ${b.tlsPolicy}` : ""}`,
      text: `${b.name} ${b.namespace} ${b.kind}`
    });
    const inGateway = (g) => !opt.gatewayId || g.id === opt.gatewayId;
    const refusedBy = /* @__PURE__ */ new Map();
    const loose = [];
    for (const r of topo.routes) {
      if (r.attached) continue;
      let placed = false;
      for (const p of r.parents) {
        if (p.gateway && !p.missing) {
          const list = refusedBy.get(p.gateway.id) ?? [];
          list.push({ route: r, reason: p.reason, message: p.message || p.reason });
          refusedBy.set(p.gateway.id, list);
          placed = true;
        }
      }
      if (!placed) loose.push(r);
    }
    for (const g of topo.gateways) {
      if (!inGateway(g)) continue;
      const gid = gatewayNode(g);
      if (g.listeners.length === 0) chains.push([gid]);
      for (const l of g.listeners) {
        const lid = listenerNode(l);
        edge(gid, lid, l.tone);
        if (l.attachments.length === 0) chains.push([gid, lid]);
        for (const a of l.attachments) {
          const rid = routeNode(a.route);
          edge(lid, rid, a.parent.tone, false, "", a.parent.tone === "ok" ? "Accepted" : a.parent.message);
          const tails = backendTails(a.route);
          for (const tail of tails.length ? tails : [[]]) {
            const chain = [gid, lid, rid, ...tail];
            chains.push(chain);
            chainListener.set(chain, lid);
          }
        }
      }
      for (const { route, reason, message } of refusedBy.get(g.id) ?? []) {
        const rid = routeNode(route);
        edge(gid, rid, "error", true, shortReason(reason), message);
        const tails = backendTails(route);
        for (const tail of tails.length ? tails : [[]]) chains.push([gid, rid, ...tail]);
      }
    }
    for (const r of loose) {
      if (opt.gatewayId) continue;
      const rid = routeNode(r);
      const tails = backendTails(r);
      const heads = [];
      for (const p of r.parents) {
        if (!p.missing) continue;
        const gid = node({
          id: `ghost:${p.ref.kind}:${p.ref.namespace}/${p.ref.name}`,
          type: "gateway",
          kicker: p.ref.kind,
          label: p.ref.name,
          sub: `${p.ref.namespace} · does not exist`,
          tone: "error",
          ref: null,
          ghost: true,
          title: `${p.ref.kind} ${p.ref.namespace}/${p.ref.name} is not in the cluster`
        });
        edge(gid, rid, "error", true, "missing", p.message);
        heads.push(gid);
      }
      for (const head of heads.length ? heads : [null]) {
        for (const tail of tails.length ? tails : [[]]) chains.push([...head ? [head] : [], rid, ...tail]);
      }
    }
    function backendTails(r) {
      const rid = r.id;
      const out = [];
      const seen2 = /* @__PURE__ */ new Set();
      for (const rule of r.rules) {
        const live = rule.backends.filter((b) => b.weight > 0);
        const split = live.length > 1;
        for (const b of rule.backends) {
          const bid = backendNode(b);
          const broken = b.exists === false || !b.granted;
          edge(
            rid,
            bid,
            b.weight === 0 || !r.attached && !broken ? "" : b.tone,
            broken,
            broken ? b.exists === false ? "missing" : "no grant" : split || b.weight === 0 ? pct(b.share) : "",
            `rule ${rule.index + 1}: ${pct(b.share)} of its traffic${b.problem ? "\n" + b.problem : ""}`
          );
          if (!seen2.has(bid)) {
            seen2.add(bid);
            out.push([bid]);
          }
        }
      }
      return out;
    }
    let kept = chains;
    if (opt.namespace) {
      const ns = opt.namespace;
      kept = kept.filter((c) => c.some((id) => nodeNamespace(nodes.get(id)) === ns));
    }
    if (opt.search.trim()) {
      const words = opt.search.trim().toLowerCase().split(/\s+/);
      kept = kept.filter((c) => words.every((w) => c.some((id) => nodes.get(id).text.includes(w))));
    }
    if (opt.problemsOnly) {
      const bad = (c) => c.some((id) => toneRank(nodes.get(id).tone) >= toneRank("warn")) || c.some((id, i) => i > 0 && (meta.get(edgeId(c[i - 1], id))?.broken || meta.get(edgeId(c[i - 1], id))?.tones.some((t) => toneRank(t) >= toneRank("warn"))));
      kept = kept.filter(bad);
    }
    const routesPer = /* @__PURE__ */ new Map();
    for (const c of kept) {
      const lid = chainListener.get(c);
      if (!lid) continue;
      const set = routesPer.get(lid) ?? /* @__PURE__ */ new Set();
      set.add(c[2]);
      routesPer.set(lid, set);
    }
    const collapsed = [];
    for (const [lid, set] of routesPer) {
      if (set.size > opt.collapseAt && !opt.expanded.has(lid)) collapsed.push(lid);
    }
    const folded = new Set(collapsed);
    if (folded.size) {
      kept = kept.map((c) => {
        const lid = chainListener.get(c);
        if (!lid || !folded.has(lid)) return c;
        const members = routesPer.get(lid);
        const gid = `group:${lid}`;
        if (!nodes.has(gid)) {
          const tones = [...members].map((id) => nodes.get(id).tone);
          const bad = tones.filter((t) => toneRank(t) >= toneRank("warn")).length;
          const types = /* @__PURE__ */ new Map();
          for (const id of members) {
            const k = nodes.get(id).kicker;
            types.set(k, (types.get(k) ?? 0) + 1);
          }
          node({
            id: gid,
            type: "group",
            kicker: [...types.entries()].map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`).join(" · "),
            label: `${members.size} routes`,
            sub: bad ? `${bad} need${bad === 1 ? "s" : ""} attention · open` : "all healthy · open",
            tone: worst(tones),
            ref: null,
            count: members.size,
            groupOf: lid,
            title: [...members].map((id) => nodes.get(id).label).join("\n"),
            text: [...members].map((id) => nodes.get(id).text).join(" ")
          });
        }
        const rid = c[2];
        const into = (from, to, gfrom, gto) => {
          const m = meta.get(edgeId(from, to));
          if (!m) return;
          const g = meta.get(edgeId(gfrom, gto)) ?? { tones: [], broken: false, labels: /* @__PURE__ */ new Set(), titles: /* @__PURE__ */ new Set() };
          g.tones.push(...m.tones);
          g.broken ||= m.broken;
          meta.set(edgeId(gfrom, gto), g);
        };
        into(c[1], rid, c[1], gid);
        if (c[3]) into(rid, c[3], gid, c[3]);
        return [c[0], c[1], gid, ...c.slice(3)];
      });
    }
    const seen = /* @__PURE__ */ new Set();
    kept = kept.filter((c) => {
      const k = c.join("|");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const used = new Set(kept.flat());
    const finalNodes = [...nodes.values()].filter((n) => used.has(n.id));
    const byId2 = new Map(finalNodes.map((n) => [n.id, n]));
    const edges = /* @__PURE__ */ new Map();
    for (const c of kept) {
      for (let i = 1; i < c.length; i++) {
        const id = edgeId(c[i - 1], c[i]);
        if (edges.has(id)) continue;
        const m = meta.get(id);
        const tone = m ? worst(m.tones.filter((t) => t !== "")) : "ok";
        edges.set(id, {
          id,
          from: c[i - 1],
          to: c[i],
          tone: m && m.tones.every((t) => t === "") ? "" : tone,
          broken: m?.broken ?? false,
          label: m ? [...m.labels].join(" · ") : "",
          title: m ? [...m.titles].join("\n") : ""
        });
      }
    }
    return {
      nodes: finalNodes,
      edges: [...edges.values()],
      byId: byId2,
      paths: kept,
      collapsed,
      counts: {
        gateways: finalNodes.filter((n) => n.type === "gateway" && !n.ghost).length,
        listeners: finalNodes.filter((n) => n.type === "listener").length,
        routes: finalNodes.reduce((sum, n) => sum + (n.type === "route" ? 1 : n.type === "group" ? n.count : 0), 0),
        backends: finalNodes.filter((n) => n.type === "backend").length
      }
    };
  }
  function nodeNamespace(n) {
    if (!n) return "";
    if (n.ref) return n.ref.namespace;
    const m = /:([^/:]+)\/[^/]+$/.exec(n.id);
    return m?.[1] ?? "";
  }
  function word(v) {
    return v === true ? "yes" : v === false ? "no" : "—";
  }
  function shortReason(reason) {
    switch (reason) {
      case "NotAllowedByListeners":
        return "not allowed";
      case "NoMatchingListenerHostname":
        return "hostname mismatch";
      case "NoMatchingParent":
        return "no such listener";
      case "Pending":
        return "pending";
      default:
        return reason ? "refused" : "";
    }
  }
  function lineage(graph, id) {
    const out = { nodes: /* @__PURE__ */ new Set(), edges: /* @__PURE__ */ new Set() };
    for (const p of graph.paths) {
      if (!p.includes(id)) continue;
      p.forEach((n, i) => {
        out.nodes.add(n);
        if (i) out.edges.add(edgeId(p[i - 1], n));
      });
    }
    if (!out.nodes.size && graph.byId.has(id)) out.nodes.add(id);
    return out;
  }
  var NODE_W = 216;
  var NODE_H = 54;
  var GAP_X = 104;
  var GAP_Y = 12;
  var GROUP_GAP = 14;
  var TOP = 34;
  function layoutGraph(graph, options = {}) {
    const from = options.from ?? 0;
    const cols = [[], [], [], []];
    const seen = /* @__PURE__ */ new Set();
    const ordered = [...graph.paths].sort((a, b) => {
      const ga = graph.byId.get(a[0]);
      const gb = graph.byId.get(b[0]);
      return Number(ga.ghost) - Number(gb.ghost) || Number(ga.col !== 0) - Number(gb.col !== 0);
    });
    for (const p of ordered) {
      for (const id of p) {
        if (seen.has(id)) continue;
        seen.add(id);
        cols[graph.byId.get(id).col].push(id);
      }
    }
    const parents = /* @__PURE__ */ new Map();
    const children = /* @__PURE__ */ new Map();
    for (const e of graph.edges) {
      (parents.get(e.to) ?? parents.set(e.to, []).get(e.to)).push(e.from);
      (children.get(e.from) ?? children.set(e.from, []).get(e.from)).push(e.to);
    }
    const boxes = /* @__PURE__ */ new Map();
    const x = (col) => (col - from) * (NODE_W + GAP_X);
    const centre = (id) => {
      const b = boxes.get(id);
      return b ? b.y + b.h / 2 : null;
    };
    const place = (col, order, want, groupOf) => {
      let bottom = TOP - GAP_Y;
      let lastGroup = "";
      for (const id of order) {
        const h = NODE_H;
        const g = groupOf?.(id) ?? "";
        const gap = GAP_Y + (lastGroup && g !== lastGroup ? GROUP_GAP : 0);
        lastGroup = g;
        const w = want(id);
        const y = Math.max(w === null ? -Infinity : w - h / 2, bottom + gap);
        boxes.set(id, { x: x(col), y, w: NODE_W, h });
        bottom = y + h;
      }
    };
    const mean = (ids) => {
      const ys = (ids ?? []).map(centre).filter((v) => v !== null);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
    };
    place(2, cols[2], () => null, (id) => (parents.get(id) ?? [])[0] ?? "");
    place(1, cols[1], (id) => mean(children.get(id)));
    if (from === 0) place(0, cols[0], (id) => mean(children.get(id)));
    const broken = new Set(graph.edges.filter((e) => e.broken).map((e) => e.id));
    const refused = (id) => {
      const into = parents.get(id) ?? [];
      return into.length > 0 && into.every((p) => broken.has(`${p}->${id}`));
    };
    const anchor = (id) => {
      const from2 = parents.get(id) ?? [];
      const good = from2.filter((p) => !broken.has(`${p}->${id}`) && !refused(p));
      const ys = (good.length ? good : from2).map(centre).filter((v) => v !== null);
      return ys.length ? Math.min(...ys) : null;
    };
    const backends = [...cols[3]].sort((a, b) => (anchor(a) ?? 0) - (anchor(b) ?? 0));
    place(3, backends, anchor);
    let height = 0;
    for (const b of boxes.values()) height = Math.max(height, b.y + b.h);
    return {
      boxes,
      columns: COLUMNS.map((label, i) => ({ x: x(i), label })).slice(from),
      width: x(3) + NODE_W,
      height: height + 8
    };
  }

  // src/ui/dom.ts
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (value === void 0 || value === false) continue;
      if (name === "class") node.className = String(value);
      else if (name === "text") node.textContent = String(value);
      else node.setAttribute(name, String(value));
    }
    for (const child of children) {
      if (child === null || child === void 0 || child === false) continue;
      node.append(child);
    }
    return node;
  }
  function replace(parent, ...children) {
    parent.replaceChildren();
    for (const child of children) {
      if (child === null || child === void 0 || child === false) continue;
      parent.append(child);
    }
  }
  function byId(id) {
    const node = document.getElementById(id);
    if (!node) throw new Error(`the page has no #${id}`);
    return node;
  }

  // src/ui/parts.ts
  function svgEl(tag, attrs = {}, ...children) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    for (const child of children) if (child) node.append(child);
    return node;
  }
  function pill(text2, tone = "", title2 = "") {
    return el("span", { class: `pill pill-${tone || "none"}`, ...title2 ? { title: title2 } : {} }, text2);
  }
  function dot(tone) {
    return el("span", { class: `dot dot-${tone || "none"}`, "aria-hidden": "true" });
  }
  function nothing(message) {
    return el("p", { class: "empty" }, message);
  }
  function clickable(node, onPick) {
    node.classList.add("pick");
    node.setAttribute("role", "button");
    node.setAttribute("tabindex", "0");
    node.addEventListener("click", onPick);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onPick();
      }
    });
    return node;
  }
  function open(ref) {
    if (ref) void k8sdockside.open({ kind: ref.kind, namespace: ref.namespace || void 0, name: ref.name });
  }

  // src/ui/map.ts
  var PAD_X = 14;
  function truncate(text2, n) {
    return text2.length > n ? text2.slice(0, Math.max(1, n - 1)) + "…" : text2;
  }
  function text(x, y, cls, value, extra = {}) {
    const t = svgEl("text", { x, y, class: cls, ...extra });
    t.textContent = value;
    return t;
  }
  function title(value) {
    const t = svgEl("title");
    t.textContent = value;
    return t;
  }
  function bezier(x1, y1, x2, y2, t) {
    const dx = Math.max(40, (x2 - x1) / 2);
    const [c1x, c1y, c2x, c2y] = [x1 + dx, y1, x2 - dx, y2];
    const u = 1 - t;
    return [u * u * u * x1 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x2, u * u * u * y1 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y2];
  }
  function drawMap(graph, layout, options = {}) {
    const top = options.compact ? TOP - 26 : 0;
    const width = layout.width + PAD_X * 2;
    const height = layout.height - top + 6;
    const svg = svgEl("svg", {
      class: options.compact ? "map compact" : "map",
      viewBox: `${-PAD_X} ${top} ${width} ${height}`,
      width,
      height,
      role: "img",
      "aria-label": `Traffic map: ${graph.counts.gateways} gateways, ${graph.counts.listeners} listeners, ${graph.counts.routes} routes, ${graph.counts.backends} backends`
    });
    svg.style.maxWidth = `${width}px`;
    const lanes = svgEl("g", { class: "lanes" });
    for (const c of layout.columns) {
      lanes.append(svgEl("rect", { class: "lane", x: c.x - 8, y: TOP - 10, width: NODE_W + 16, height: Math.max(NODE_H + 20, layout.height - TOP + 12), rx: 14 }));
      if (!options.compact) lanes.append(text(c.x + 4, 16, "lane-label", c.label.toUpperCase()));
    }
    svg.append(lanes);
    const edgeLayer = svgEl("g", { class: "edges" });
    const labelLayer = svgEl("g", { class: "edge-labels" });
    const nodeLayer = svgEl("g", { class: "nodes" });
    const edgeEls = /* @__PURE__ */ new Map();
    const nodeEls = /* @__PURE__ */ new Map();
    for (const e of graph.edges) {
      const a = layout.boxes.get(e.from);
      const b = layout.boxes.get(e.to);
      if (!a || !b) continue;
      const drawn = drawEdge(e, a.x + a.w, a.y + a.h / 2, b.x, b.y + b.h / 2);
      edgeLayer.append(drawn.path);
      if (drawn.label) labelLayer.append(drawn.label);
      edgeEls.set(e.id, [drawn.path, ...drawn.label ? [drawn.label] : []]);
    }
    for (const n of graph.nodes) {
      const box = layout.boxes.get(n.id);
      if (!box) continue;
      const g = drawNode(n, box.x, box.y);
      nodeLayer.append(g);
      nodeEls.set(n.id, g);
      const pick = () => {
        if (n.type === "group") options.onExpand?.(n.groupOf);
        else open(n.ref);
      };
      if (n.type === "group" || n.ref) clickable(g, pick);
      const light = () => {
        const l = lineage(graph, n.id);
        svg.classList.add("focusing");
        for (const [id, node] of nodeEls) node.classList.toggle("lit", l.nodes.has(id));
        for (const [id, parts] of edgeEls) for (const p of parts) p.classList.toggle("lit", l.edges.has(id));
      };
      const dark = () => svg.classList.remove("focusing");
      g.addEventListener("mouseenter", light);
      g.addEventListener("mouseleave", dark);
      g.addEventListener("focus", light);
      g.addEventListener("blur", dark);
    }
    svg.append(edgeLayer, nodeLayer, labelLayer);
    return svg;
  }
  function drawEdge(e, x1, y1, x2, y2) {
    const dx = Math.max(40, (x2 - x1) / 2);
    const cls = ["edge", `edge-${e.broken ? "error" : e.tone || "none"}`];
    if (e.broken) cls.push("broken");
    const path = svgEl("path", { d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, class: cls.join(" ") });
    if (e.title) path.append(title(e.title));
    let label = null;
    if (e.label) {
      const want = x2 - GAP_X / 2;
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (bezier(x1, y1, x2, y2, mid)[0] < want) lo = mid;
        else hi = mid;
      }
      const [lx, ly] = bezier(x1, y1, x2, y2, lo);
      const w = e.label.length * 6.4 + 14;
      label = svgEl(
        "g",
        { class: `edge-label ${e.broken ? "edge-label-error" : ""}`, transform: `translate(${lx.toFixed(1)},${ly.toFixed(1)})` },
        svgEl("rect", { x: -w / 2, y: -9, width: w, height: 18, rx: 9 }),
        text(0, 4, "", e.label, { "text-anchor": "middle" })
      );
      if (e.title) label.append(title(e.title));
    }
    return { path, label };
  }
  function drawNode(n, x, y) {
    const cls = ["node", `node-${n.type}`, `tone-${n.tone || "none"}`];
    if (n.ghost) cls.push("ghost");
    const g = svgEl("g", { class: cls.join(" "), transform: `translate(${x},${y})` });
    g.append(svgEl("rect", { class: "node-box", width: NODE_W, height: NODE_H, rx: 10 }));
    g.append(svgEl("rect", { class: "node-bar", x: 5, y: 9, width: 3, height: NODE_H - 18, rx: 1.5 }));
    const right = n.ready ? 64 : 22;
    g.append(text(16, 18, "node-kicker", truncate(n.kicker.toUpperCase(), Math.floor((NODE_W - 16 - right) / 6.6))));
    g.append(text(16, 35, "node-label", truncate(n.label, 24)));
    g.append(text(16, 48.5, "node-sub", truncate(n.sub, n.ready ? 24 : 31)));
    if (n.ready) {
      const tone = n.ready.total === 0 || n.ready.ready === 0 ? "error" : n.ready.ready < n.ready.total ? "warn" : "ok";
      const words = n.ready.total === 0 ? "no pods" : `${n.ready.ready}/${n.ready.total} ready`;
      const w = words.length * 6 + 16;
      g.append(
        svgEl(
          "g",
          { class: `ready ready-${tone}`, transform: `translate(${NODE_W - w - 8},${NODE_H - 22})` },
          svgEl("rect", { width: w, height: 15, rx: 7.5 }),
          text(w / 2, 11, "", words, { "text-anchor": "middle" })
        )
      );
      g.append(svgEl("circle", { class: "node-dot", cx: NODE_W - 13, cy: 14, r: 4 }));
    } else if (n.type === "group") {
      g.append(text(NODE_W - 14, 36, "node-open", "+", { "text-anchor": "middle" }));
    } else {
      g.append(svgEl("circle", { class: "node-dot", cx: NODE_W - 13, cy: 14, r: 4 }));
    }
    const tip = n.title || `${n.kicker} ${n.label}`;
    g.append(title(n.ref ? `${tip}

Click to open it.` : n.type === "group" ? `${tip}

Click to show them one by one.` : tip));
    return g;
  }

  // src/ui/page.ts
  function fail(host, err) {
    const message = err instanceof Error ? err.message : String(err);
    replace(host, el("div", { class: "failure" }, el("strong", {}, "That did not work. "), el("span", {}, message)));
  }
  function start(hostId, body) {
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
  async function maybe(kind) {
    try {
      return await k8sdockside.list({ kind });
    } catch {
      return null;
    }
  }
  async function load() {
    const [classes, gateways, listenerSets, grants, backendTLS, services, slices, namespaces, routes] = await Promise.all([
      maybe(KIND.classes),
      maybe(KIND.gateways),
      maybe(KIND.listenerSets),
      maybe(KIND.grants),
      maybe(KIND.backendTLS),
      maybe(KIND.services),
      maybe(KIND.slices),
      maybe(KIND.namespaces),
      Promise.all(ROUTE_TYPES.map((t) => maybe(ROUTE_KIND[t])))
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
        namespaces
      }
    };
  }
  var remember = {
    async get(key2) {
      try {
        return await k8sdockside.storage?.get(key2) ?? null;
      } catch {
        return null;
      }
    },
    async set(key2, value) {
      try {
        await k8sdockside.storage?.set(key2, value);
      } catch {
      }
    }
  };

  // src/pages/gateway.ts
  start("panel", async (ctx) => {
    const host = byId("panel");
    const me = ctx.object;
    if (!me) throw new Error("This panel is drawn for a Gateway, and there is none.");
    const { snap } = await load();
    const topo = topology(snap);
    const g = topo.gateways.find((x) => x.namespace === me.namespace && x.name === me.name);
    if (!g) {
      replace(host, nothing("This Gateway is not in the list the cluster returned. It may have just been deleted."));
      return;
    }
    const routes = new Set(g.listeners.flatMap((l) => l.attachments.map((a) => a.route.id)));
    const refused = topo.routes.filter((r) => !r.attached && r.parents.some((p) => p.gateway === g));
    const state = g.conditions.length === 0 ? pill("no status yet", "warn") : pill(g.programmed ? "Programmed" : "not programmed", g.programmed ? "ok" : "error");
    const summary = el(
      "div",
      { class: "panel-head" },
      state,
      g.accepted === false ? pill("not accepted", "error") : null,
      el("span", {}, `class ${g.className || "—"}`),
      el("span", { class: "faint" }, g.addresses.length ? g.addresses.join(", ") : "no address yet"),
      el("span", { class: "spacer" }),
      el("span", { class: "faint" }, `${plural(g.listeners.length, "listener")} · ${plural(routes.size, "route")} attached${refused.length ? ` · ${refused.length} refused` : ""}`)
    );
    const graph = buildGraph(topo, { gatewayId: g.id, collapseAt: 6 });
    const map = graph.nodes.length ? el("div", { class: "map-scroll panel-map" }, drawMap(graph, layoutGraph(graph, { from: 1 }), { compact: true })) : null;
    const table = el(
      "table",
      { class: "listeners" },
      el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", {}, "Listener"), el("th", {}, "Port"), el("th", {}, "Hostname"), el("th", {}, "Routes from"), el("th", {}, "Attached"), el("th", {}, ""))),
      el(
        "tbody",
        {},
        ...g.listeners.map(
          (l) => el(
            "tr",
            {},
            el("td", {}, dot(l.tone)),
            el("td", {}, el("strong", {}, l.name), l.viaSet ? el("span", { class: "faint" }, ` · ${l.viaSet}`) : null),
            el("td", {}, `${l.protocol} :${l.port}${l.tlsMode === "Passthrough" ? " (passthrough)" : ""}`),
            el("td", { class: "mono" }, l.hostname || "any"),
            el("td", {}, l.allowedFrom === "Selector" ? "selected namespaces" : l.allowedFrom === "All" ? "all namespaces" : "this namespace"),
            el("td", {}, String(l.status?.attachedRoutes ?? l.attachments.length)),
            el("td", { class: "wrap tone-error" }, l.notes.filter((n) => n !== "The controller has not reported on this listener.").join(" "))
          )
        )
      )
    );
    const more = el("button", { type: "button", class: "link-button" }, "Open it on the traffic map →");
    more.addEventListener("click", async () => {
      await remember.set("map.filters", { namespace: "", gatewayId: g.id, search: "", problemsOnly: false });
      await k8sdockside.openView("map");
    });
    replace(host, summary, map, table, el("div", { class: "panel-foot" }, more));
  });
})();
