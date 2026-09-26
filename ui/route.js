// Built by k8sdockside-plugin from src/ -- edit the TypeScript there, not this file.
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

  // src/model/words.ts
  function httpMatchWords(m) {
    const parts = [];
    const type = m.path?.type ?? "PathPrefix";
    const value = m.path?.value ?? "/";
    if (type === "Exact") parts.push(`path = ${value}`);
    else if (type === "RegularExpression") parts.push(`path ~ /${value}/`);
    else parts.push(value === "/" ? "any path" : `prefix ${value}`);
    if (m.method) parts.push(m.method.toUpperCase());
    for (const h of m.headers ?? []) parts.push(`${h.name}: ${h.type === "RegularExpression" ? `/${h.value}/` : h.value}`);
    for (const q of m.queryParams ?? []) parts.push(`?${q.name}=${q.type === "RegularExpression" ? `/${q.value}/` : q.value}`);
    return parts.join(" · ");
  }
  function grpcMatchWords(m) {
    const parts = [];
    const svc = m.method?.service;
    const method = m.method?.method;
    if (svc || method) parts.push(`${svc ?? "*"}/${method ?? "*"}${m.method?.type === "RegularExpression" ? " (regex)" : ""}`);
    else parts.push("any call");
    for (const h of m.headers ?? []) parts.push(`${h.name}: ${h.value}`);
    return parts.join(" · ");
  }
  function ruleMatches(rule, type) {
    const matches = rule.rule.matches ?? [];
    if (type === "HTTPRoute") return matches.length ? matches.map(httpMatchWords) : ["any path"];
    if (type === "GRPCRoute") return matches.length ? matches.map(grpcMatchWords) : ["any call"];
    return ["every connection"];
  }
  function modifierWords(m) {
    return [...(m.set ?? []).map((h) => `set ${h.name}: ${h.value}`), ...(m.add ?? []).map((h) => `add ${h.name}: ${h.value}`), ...(m.remove ?? []).map((h) => `remove ${h}`)];
  }
  function filterWords(f) {
    switch (f.type) {
      case "RequestRedirect": {
        const r = f.requestRedirect ?? {};
        const bits = [];
        if (r.scheme) bits.push(`to ${r.scheme}`);
        if (r.hostname) bits.push(`host ${r.hostname}`);
        if (r.port) bits.push(`port ${r.port}`);
        if (r.path?.type === "ReplaceFullPath") bits.push(`path ${r.path.replaceFullPath}`);
        if (r.path?.type === "ReplacePrefixMatch") bits.push(`prefix → ${r.path.replacePrefixMatch}`);
        return { kind: `Redirect ${r.statusCode ?? 302}`, text: bits.join(", ") || "to the same address" };
      }
      case "URLRewrite": {
        const r = f.urlRewrite ?? {};
        const bits = [];
        if (r.hostname) bits.push(`host → ${r.hostname}`);
        if (r.path?.type === "ReplaceFullPath") bits.push(`path → ${r.path.replaceFullPath}`);
        if (r.path?.type === "ReplacePrefixMatch") bits.push(`prefix → ${r.path.replacePrefixMatch}`);
        return { kind: "Rewrite", text: bits.join(", ") };
      }
      case "RequestHeaderModifier":
        return { kind: "Request headers", text: modifierWords(f.requestHeaderModifier ?? {}).join(", ") };
      case "ResponseHeaderModifier":
        return { kind: "Response headers", text: modifierWords(f.responseHeaderModifier ?? {}).join(", ") };
      case "RequestMirror": {
        const b = f.requestMirror?.backendRef;
        const pct = f.requestMirror?.percent ?? (f.requestMirror?.fraction ? Math.round(f.requestMirror.fraction.numerator / (f.requestMirror.fraction.denominator ?? 100) * 100) : 100);
        return { kind: "Mirror", text: b ? `${pct}% copied to ${b.namespace ? b.namespace + "/" : ""}${b.name}` : "" };
      }
      case "ExtensionRef": {
        const e = f.extensionRef ?? {};
        return { kind: "Extension", text: `${e.kind ?? ""} ${e.name ?? ""}`.trim() };
      }
      default:
        return { kind: f.type, text: "" };
    }
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

  // src/ui/parts.ts
  function pill(text, tone = "", title = "") {
    return el("span", { class: `pill pill-${tone || "none"}`, ...title ? { title } : {} }, text);
  }
  function dot(tone) {
    return el("span", { class: `dot dot-${tone || "none"}`, "aria-hidden": "true" });
  }
  function nothing(message) {
    return el("p", { class: "empty" }, message);
  }
  function open(ref) {
    if (ref) void k8sdockside.open({ kind: ref.kind, namespace: ref.namespace || void 0, name: ref.name });
  }
  function openName(label, ref, className = "name-link") {
    if (!ref) return el("span", { class: `${className} gone` }, label);
    const node = el("button", { type: "button", class: className, title: `Open ${label}` }, label);
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      open(ref);
    });
    return node;
  }
  function code(text, className = "") {
    return el("code", { class: className ? `mono ${className}` : "mono" }, text);
  }
  function percent(share) {
    const p = share * 100;
    return p >= 10 || p === 0 || Number.isInteger(p) ? `${Math.round(p)}%` : `${p.toFixed(1)}%`;
  }
  function readyWords(ready, total) {
    if (ready === null || total === null) return "";
    if (total === 0) return "no endpoints";
    if (ready === total) return `${ready} ready`;
    return `${ready} of ${total} ready`;
  }

  // src/ui/backends.ts
  function backendFill(b, index) {
    if (b.weight === 0) return "fill-none";
    if (b.tone === "error") return "fill-error";
    if (b.tone === "warn") return "fill-warn";
    return `fill-chart-${index % 8 + 1}`;
  }
  function backendSplit(backends) {
    const bar = el("div", { class: "split", role: "img", "aria-label": backends.map((b) => `${b.name} ${percent(b.share)}`).join(", ") });
    backends.forEach((b, i) => {
      if (b.share <= 0) return;
      const piece = el("span", { class: `split-part ${backendFill(b, i)}`, title: `${b.name}: ${percent(b.share)}` });
      piece.style.width = `${b.share * 100}%`;
      bar.append(piece);
    });
    return bar;
  }
  function backendRow(b, index) {
    const state = b.exists === false ? pill("missing", "error") : !b.granted ? pill("no ReferenceGrant", "error") : b.external ? pill(`ExternalName ${b.external}`, "info") : b.ready !== null ? pill(readyWords(b.ready, b.total), b.ready === 0 ? "error" : b.ready < (b.total ?? 0) ? "warn" : "ok") : pill(b.kind, "");
    return el(
      "div",
      { class: "backend-row", title: b.problem || void 0 },
      el("span", { class: `swatch ${backendFill(b, index)}`, "aria-hidden": "true" }),
      el("span", { class: "backend-share" }, percent(b.share)),
      openName(b.name, b.exists === false ? null : b.ref),
      el("span", { class: "faint" }, `${b.namespace}${b.port !== null ? ":" + b.port : ""}${b.crossNamespace ? " · other namespace" : ""}`),
      el("span", { class: "spacer" }),
      b.tlsPolicy ? pill("TLS", "info", `BackendTLSPolicy ${b.tlsPolicy}: the Gateway speaks TLS to it`) : null,
      state
    );
  }

  // src/pages/route.ts
  start("panel", async (ctx) => {
    const host = byId("panel");
    const me = ctx.object;
    if (!me) throw new Error("This panel is drawn for a route, and there is none.");
    const type = ROUTE_TYPES.find((t) => ROUTE_KIND[t] === me.kind);
    const { snap } = await load();
    const topo = topology(snap);
    const r = topo.routes.find((x) => x.type === type && x.namespace === me.namespace && x.name === me.name);
    if (!r) {
      replace(host, nothing("This route is not in the list the cluster returned. It may have just been deleted."));
      return;
    }
    replace(host, attachedTo(r), rules(r), foot(r));
  });
  function parentState(p) {
    if (p.missing) return ["does not exist", "error"];
    if (p.accepted === false) return ["not accepted", "error"];
    if (p.accepted === null) return [p.listeners.length ? "no status yet" : "would not attach", p.tone];
    if (p.resolvedRefs === false) return ["accepted, refs unresolved", "error"];
    return ["accepted", "ok"];
  }
  function attachedTo(r) {
    const list = el("ul", { class: "parents" });
    if (r.parents.length === 0) list.append(el("li", { class: "parent" }, dot("error"), "It names no parent, so it is attached to nothing."));
    for (const p of r.parents) {
      const [word, tone] = parentState(p);
      const target = p.listenerSet ? p.listenerSet.ref : p.gateway ? p.gateway.ref : null;
      list.append(
        el(
          "li",
          { class: "parent" },
          dot(tone),
          el("span", { class: "faint" }, p.ref.kind),
          openName(`${p.ref.namespace}/${p.ref.name}`, target),
          ...p.listeners.map((l) => pill(`${l.name} · ${l.protocol} :${l.port}${l.hostname ? " " + l.hostname : ""}`, l.tone === "ok" ? "info" : l.tone)),
          p.listeners.length === 0 && p.ref.sectionName ? pill(p.ref.sectionName, "") : null,
          el("span", { class: "spacer" }),
          pill(word, tone)
        )
      );
      if (tone === "error" || tone === "warn") list.append(el("li", { class: "parent-why" }, p.specWhy || p.message || p.reason));
    }
    return el("div", { class: "panel-section" }, el("h3", {}, "Attached to"), list);
  }
  function rules(r) {
    const out = el("div", { class: "panel-section" }, el("h3", {}, r.hostnames.length ? `Rules, for ${r.hostnames.join(", ")}` : "Rules"));
    if (r.rules.length === 0) out.append(nothing("No rules."));
    for (const rule of r.rules) {
      const live = rule.backends.filter((b) => b.weight > 0);
      out.append(
        el(
          "div",
          { class: `rule tone-edge-${rule.tone || "none"}` },
          el("div", { class: "rule-head" }, el("span", { class: "rule-index" }, rule.name || `Rule ${rule.index + 1}`), ...ruleMatches(rule, r.type).map((m) => code(m, "match"))),
          rule.filters.length ? el("div", { class: "rule-filters" }, ...rule.filters.map((f) => filterPill(f))) : null,
          live.length > 1 ? backendSplit(rule.backends) : null,
          rule.backends.length ? el("div", { class: "backends" }, ...rule.backends.map((b, i) => backendRow(b, i))) : rule.filters.some((f) => f.type === "RequestRedirect") ? null : el("p", { class: "tone-warn small" }, "No backends and no redirect: every request this rule matches fails.")
        )
      );
    }
    return out;
  }
  function filterPill(f) {
    const w = filterWords(f);
    return el("span", { class: "filter" }, el("strong", {}, w.kind), w.text ? ` ${w.text}` : "");
  }
  function foot(r) {
    if (r.type !== "HTTPRoute" || !r.attached) return null;
    const l = r.parents.flatMap((p) => p.listeners)[0];
    if (!l) return null;
    const hostname = r.hostnames.find((h) => !h.startsWith("*")) ?? (l.hostname && !l.hostname.startsWith("*") ? l.hostname : r.hostnames[0]?.replace(/^\*\./, "www.") ?? l.hostname?.replace(/^\*\./, "www."));
    if (!hostname) return null;
    const first = r.rules[0]?.rule.matches?.[0]?.path?.value ?? "/";
    const scheme = l.protocol === "HTTPS" ? "https" : "http";
    const url = `${scheme}://${hostname}${first.startsWith("/") ? first : "/"}`;
    const b = el("button", { type: "button", class: "link-button" }, `Follow ${url} →`);
    b.addEventListener("click", async () => {
      await remember.set("resolve.url", url);
      await k8sdockside.openView("resolve");
    });
    return el("div", { class: "panel-foot" }, b);
  }
})();
