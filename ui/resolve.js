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
  function specificity(pattern) {
    if (!pattern) return [0, 0];
    const p = normalHost(pattern);
    return [isWildcard(p) ? 0 : p.length, p.length];
  }
  function bySpecificity(a, b) {
    return b[0] - a[0] || b[1] - a[1];
  }
  function effectiveHostnames(routeHosts, listenerHost) {
    if (!listenerHost) return [...routeHosts];
    return routeHosts.filter((h) => hostsIntersect(h, listenerHost));
  }

  // src/model/match.ts
  var SCHEMES = {
    http: { protocols: ["HTTP"], port: 80 },
    https: { protocols: ["HTTPS", "TLS"], port: 443 },
    grpc: { protocols: ["HTTP"], port: 80 },
    grpcs: { protocols: ["HTTPS"], port: 443 },
    tls: { protocols: ["TLS"], port: null },
    tcp: { protocols: ["TCP"], port: null },
    udp: { protocols: ["UDP"], port: null }
  };
  function parseRequest(input, method = "GET", headerText = "") {
    let text = input.trim();
    if (!text) return { error: "Type a URL, such as https://shop.example.com/api." };
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = "https://" + text;
    const scheme = text.slice(0, text.indexOf(":")).toLowerCase();
    const known = SCHEMES[scheme];
    if (!known) return { error: `${scheme}:// is not something a Gateway listens for. Use http, https, grpc, grpcs, tls, tcp or udp.` };
    let url;
    try {
      url = new URL("http" + text.slice(scheme.length));
    } catch {
      return { error: `That is not a URL: ${input.trim()}` };
    }
    if (!url.hostname) return { error: "The URL needs a host name." };
    const headers = [];
    for (const line of headerText.split("\n")) {
      const at = line.indexOf(":");
      if (at <= 0) continue;
      headers.push([line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()]);
    }
    return {
      scheme,
      host: normalHost(url.hostname),
      port: url.port ? Number(url.port) : null,
      defaultPort: known.port,
      path: url.pathname || "/",
      query: [...url.searchParams.entries()],
      method: (method || "GET").toUpperCase(),
      headers
    };
  }
  function pickListener(gateway, req) {
    const protocols = SCHEMES[req.scheme]?.protocols ?? [];
    let cands = gateway.listeners.filter((l) => protocols.includes(l.protocol.toUpperCase()));
    if (cands.length === 0) return { gateway, why: `It has no ${protocols.join(" or ")} listener.` };
    const hostless = req.scheme === "tcp" || req.scheme === "udp";
    if (!hostless) {
      const byHost = cands.filter((l) => hostMatches(l.hostname, req.host));
      if (byHost.length === 0) {
        const names = [...new Set(cands.map((l) => l.hostname).filter(Boolean))];
        return { gateway, why: `None of its ${protocols.join("/")} listeners takes ${req.host}: they are for ${names.join(", ")}.` };
      }
      cands = byHost;
    }
    const want = req.port ?? req.defaultPort;
    let portExact = true;
    let portNote = "";
    const onPort = want === null ? cands : cands.filter((l) => l.port === want);
    if (onPort.length) {
      cands = onPort;
    } else {
      portExact = false;
      const ports = [...new Set(cands.map((l) => l.port))].sort((a, b) => a - b);
      portNote = `The Gateway listens on ${ports.map((p) => ":" + p).join(", ")}, not :${want}. A load balancer or a port-forward in front of it can map one to the other, so this is the listener that would answer.`;
    }
    const order = (l) => protocols.indexOf(l.protocol.toUpperCase());
    const best = [...cands].sort((a, b) => bySpecificity(specificity(a.hostname), specificity(b.hostname)) || order(a) - order(b))[0];
    return { gateway, listener: best, portExact, portNote };
  }
  function resolve(topo, req, gatewayId = "") {
    const picks = [];
    const refused = [];
    for (const g of topo.gateways) {
      if (gatewayId && g.id !== gatewayId) continue;
      const p = pickListener(g, req);
      if ("listener" in p) picks.push(p);
      else refused.push(p);
    }
    picks.sort(
      (a, b) => Number(b.portExact) - Number(a.portExact) || bySpecificity(specificity(a.listener.hostname), specificity(b.listener.hostname)) || Number(b.gateway.programmed === true) - Number(a.gateway.programmed === true) || b.listener.attachments.length - a.listener.attachments.length
    );
    const empty = {
      request: req,
      others: picks.slice(1),
      refused,
      lower: [],
      near: [],
      requestHeaders: [],
      responseHeaders: [],
      mirrors: [],
      otherFilters: [],
      notes: []
    };
    const pick = picks[0] ?? null;
    if (!pick) {
      return {
        ...empty,
        mode: "http",
        pick: null,
        hit: null,
        outcome: {
          kind: "fail",
          status: 0,
          why: topo.gateways.length === 0 ? "There are no Gateways in this cluster." : `No Gateway has a listener for ${req.scheme}://${req.host}${req.port ? ":" + req.port : ""}.`
        }
      };
    }
    const l = pick.listener;
    const protocol = l.protocol.toUpperCase();
    const notes = [];
    if (pick.portNote) notes.push(pick.portNote);
    if (pick.gateway.programmed === false) notes.push(`The Gateway ${pick.gateway.name} is not Programmed: the data plane may not be serving any of this.`);
    if (l.tone === "error") notes.push(`The listener ${l.name} has a problem: ${l.notes[0] ?? "see Problems"}.`);
    let mode = protocol === "TLS" ? "tls" : protocol === "TCP" ? "tcp" : protocol === "UDP" ? "udp" : "http";
    const attached = l.attachments.map((a) => a.route);
    let found;
    if (mode === "http") {
      const grpc = grpcPath(req.path);
      const httpFound = matchHTTP(attached.filter((r) => r.type === "HTTPRoute"), l, req);
      const grpcFound = grpc ? matchGRPC(attached.filter((r) => r.type === "GRPCRoute"), l, req, grpc) : null;
      if (grpcFound?.hit && (req.scheme.startsWith("grpc") || !httpFound.hit)) {
        mode = "grpc";
        found = grpcFound;
      } else {
        found = httpFound;
        if (req.scheme.startsWith("grpc") && !httpFound.hit) mode = "grpc";
      }
    } else if (mode === "tls") {
      found = matchHostOnly(attached.filter((r) => r.type === "TLSRoute"), l, req);
    } else {
      found = matchHostOnly(attached.filter((r) => r.type === (mode === "tcp" ? "TCPRoute" : "UDPRoute")), l, req, true);
    }
    const base = {
      ...empty,
      mode,
      pick,
      hit: found.hit,
      lower: found.lower,
      near: found.near,
      notes,
      outcome: { kind: "fail", status: 404, why: "" }
    };
    if (!found.hit) {
      const routes = attached.length;
      base.outcome = {
        kind: "fail",
        status: mode === "http" || mode === "grpc" ? 404 : 0,
        why: routes === 0 ? `Nothing is attached to the listener ${l.name}, so it has nowhere to send this.` : `None of the ${routes} route${routes === 1 ? "" : "s"} on the listener ${l.name} matches this request.`
      };
      return base;
    }
    if (found.hit.regex && found.lower.length) notes.push("A regular-expression path decided this. How those rank against other matches differs between implementations.");
    base.outcome = outcome(found.hit, req, pick, base);
    return base;
  }
  function routeHostname(route, l, host) {
    if (route.hostnames.length === 0) return { ok: true, hostname: "", score: [0, 0] };
    const usable = effectiveHostnames(route.hostnames, l.hostname).filter((h) => hostMatches(h, host));
    if (usable.length === 0) return { ok: false, hostname: "", score: [0, 0] };
    const best = [...usable].sort((a, b) => bySpecificity(specificity(a), specificity(b)))[0];
    return { ok: true, hostname: best, score: specificity(best) };
  }
  function prefixOf(value) {
    return value.length > 1 ? value.replace(/\/+$/, "") : value;
  }
  function pathMatches(match, path) {
    const type = match?.type ?? "PathPrefix";
    const value = match?.value ?? "/";
    if (type === "Exact") return { ok: path === value, kind: "Exact", value };
    if (type === "RegularExpression") {
      try {
        return { ok: new RegExp(`^(?:${value})$`).test(path), kind: "RegularExpression", value };
      } catch {
        return { ok: false, kind: "RegularExpression", value };
      }
    }
    const p = prefixOf(value);
    return { ok: p === "/" || path === p || path.startsWith(p + "/"), kind: "PathPrefix", value: p };
  }
  function valueMatches(type, want, got) {
    if (got === void 0) return false;
    if (type === "RegularExpression") {
      try {
        return new RegExp(want).test(got);
      } catch {
        return false;
      }
    }
    return got === want;
  }
  function distinctHeaders(list) {
    const seen = /* @__PURE__ */ new Set();
    return (list ?? []).filter((h) => {
      const k = h.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  function headerValue(req, name) {
    const k = name.toLowerCase();
    return req.headers.find(([n]) => n === k)?.[1];
  }
  function queryValue(req, name) {
    return req.query.find(([n]) => n === name)?.[1];
  }
  function byScore(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (b[i] ?? 0) - (a[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  }
  function byTies(a, b) {
    const ta = Date.parse(a.route.created) || 0;
    const tb = Date.parse(b.route.created) || 0;
    return ta - tb || `${a.route.namespace}/${a.route.name}`.localeCompare(`${b.route.namespace}/${b.route.name}`) || a.rule.index - b.rule.index || a.matchIndex - b.matchIndex;
  }
  function matchHTTP(routes, l, req) {
    const hits = [];
    const near = [];
    for (const route of routes) {
      const h = routeHostname(route, l, req.host);
      if (!h.ok) continue;
      for (const rule of route.rules) {
        const matches = rule.rule.matches?.length ? rule.rule.matches : [{}];
        matches.forEach((m, i) => {
          const path = pathMatches(m.path, req.path);
          if (!path.ok) return;
          const headers = distinctHeaders(m.headers);
          const query = m.queryParams ?? [];
          const needs = [];
          if (m.method && m.method.toUpperCase() !== req.method) needs.push(`method ${m.method.toUpperCase()}`);
          for (const hm of headers) {
            if (!valueMatches(hm.type, hm.value, headerValue(req, hm.name))) needs.push(`header ${hm.name}: ${hm.type === "RegularExpression" ? `/${hm.value}/` : hm.value}`);
          }
          for (const q of query) {
            if (!valueMatches(q.type, q.value, queryValue(req, q.name))) needs.push(`query ${q.name}=${q.type === "RegularExpression" ? `/${q.value}/` : q.value}`);
          }
          const pathClass = path.kind === "Exact" ? 3 : path.kind === "PathPrefix" ? 2 : 1;
          const score = [h.score[0], h.score[1], pathClass, path.kind === "RegularExpression" ? 0 : path.value.length, m.method ? 1 : 0, headers.length, query.length];
          const matchIndex = rule.rule.matches?.length ? i : -1;
          if (needs.length) {
            near.push({ route, rule, matchIndex, needs, score });
            return;
          }
          const reasons = [];
          if (h.hostname) reasons.push(`${isWildcard(h.hostname) ? "wildcard" : "exact"} hostname ${h.hostname}`);
          if (path.kind === "Exact") reasons.push(`exact path ${path.value}`);
          else if (path.kind === "PathPrefix") reasons.push(path.value === "/" ? "path prefix / (everything)" : `path prefix ${path.value}`);
          else reasons.push(`path matches /${path.value}/`);
          if (m.method) reasons.push(`method ${m.method.toUpperCase()}`);
          for (const hm of headers) reasons.push(`header ${hm.name}: ${hm.value}`);
          for (const q of query) reasons.push(`query ${q.name}=${q.value}`);
          hits.push({ route, rule, matchIndex, hostname: h.hostname, reasons, prefix: path.kind === "PathPrefix" ? path.value : null, score, regex: path.kind === "RegularExpression" });
        });
      }
    }
    return settle(hits, near);
  }
  function settle(hits, near) {
    hits.sort((a, b) => byScore(a.score, b.score) || byTies(a, b));
    const hit = hits[0] ?? null;
    const better = near.filter((n) => !hit || byScore(n.score, hit.score) < 0 || byScore(n.score, hit.score) === 0 && byTies(n, hit) < 0).sort((a, b) => byScore(a.score, b.score) || byTies(a, b)).slice(0, 3).map(({ route, rule, matchIndex, needs }) => ({ route, rule, matchIndex, needs }));
    return { hit, lower: hits.slice(1, 6), near: better };
  }
  function grpcPath(path) {
    const m = /^\/([^/]+)\/([^/]+)$/.exec(path);
    return m ? { service: m[1], method: m[2] } : null;
  }
  function matchGRPC(routes, l, req, call) {
    const hits = [];
    const near = [];
    for (const route of routes) {
      const h = routeHostname(route, l, req.host);
      if (!h.ok) continue;
      for (const rule of route.rules) {
        const matches = rule.rule.matches?.length ? rule.rule.matches : [{}];
        matches.forEach((m, i) => {
          const mm = m.method;
          const regex = mm?.type === "RegularExpression";
          const svcOk = !mm?.service || (regex ? safeFull(mm.service, call.service) : mm.service === call.service);
          const methodOk = !mm?.method || (regex ? safeFull(mm.method, call.method) : mm.method === call.method);
          if (!svcOk || !methodOk) return;
          const headers = distinctHeaders(m.headers);
          const needs = headers.filter((hm) => !valueMatches(hm.type, hm.value, headerValue(req, hm.name))).map((hm) => `header ${hm.name}: ${hm.value}`);
          const score = [h.score[0], h.score[1], mm?.service?.length ?? 0, mm?.method?.length ?? 0, headers.length];
          const matchIndex = rule.rule.matches?.length ? i : -1;
          if (needs.length) {
            near.push({ route, rule, matchIndex, needs, score });
            return;
          }
          const reasons = [];
          if (h.hostname) reasons.push(`${isWildcard(h.hostname) ? "wildcard" : "exact"} hostname ${h.hostname}`);
          reasons.push(mm?.service ? `service ${mm.service}` : "any service");
          if (mm?.method) reasons.push(`method ${mm.method}`);
          for (const hm of headers) reasons.push(`header ${hm.name}: ${hm.value}`);
          hits.push({ route, rule, matchIndex, hostname: h.hostname, reasons, prefix: null, score, regex });
        });
      }
    }
    return settle(hits, near);
  }
  function safeFull(pattern, value) {
    try {
      return new RegExp(`^(?:${pattern})$`).test(value);
    } catch {
      return false;
    }
  }
  function matchHostOnly(routes, l, req, hostless = false) {
    const hits = [];
    for (const route of routes) {
      const h = hostless ? { ok: true, hostname: "", score: [0, 0] } : routeHostname(route, l, req.host);
      if (!h.ok) continue;
      const rule = route.rules[0];
      if (!rule) continue;
      hits.push({ route, rule, matchIndex: -1, hostname: h.hostname, reasons: h.hostname ? [`hostname ${h.hostname} (SNI)`] : hostless ? [`port ${l.port}`] : ["any hostname"], prefix: null, score: [h.score[0], h.score[1]], regex: false });
    }
    return settle(hits, []);
  }
  var WELL_KNOWN = { http: 80, https: 443 };
  function outcome(hit, req, pick, into) {
    const filters = hit.rule.filters;
    for (const f of filters) {
      if (f.type === "RequestHeaderModifier" && f.requestHeaderModifier) into.requestHeaders.push(f.requestHeaderModifier);
      else if (f.type === "ResponseHeaderModifier" && f.responseHeaderModifier) into.responseHeaders.push(f.responseHeaderModifier);
      else if (f.type === "RequestMirror" && f.requestMirror?.backendRef) into.mirrors.push(f.requestMirror.backendRef);
      else if (f.type !== "RequestRedirect" && f.type !== "URLRewrite") into.otherFilters.push(f);
    }
    const redirect = filters.find((f) => f.type === "RequestRedirect")?.requestRedirect;
    if (redirect) {
      const scheme = redirect.scheme ?? (req.scheme === "grpcs" ? "https" : req.scheme === "grpc" ? "http" : req.scheme);
      const host = redirect.hostname ?? req.host;
      const port = redirect.port ?? (redirect.scheme ? WELL_KNOWN[scheme] ?? pick.listener.port : pick.listener.port);
      const path = rewritePath(redirect.path, req.path, hit.prefix);
      const query = req.query.length ? "?" + new URLSearchParams(req.query).toString() : "";
      const showPort = WELL_KNOWN[scheme] !== port;
      return { kind: "redirect", status: redirect.statusCode ?? 302, location: `${scheme}://${host}${showPort ? ":" + port : ""}${path}${query}` };
    }
    const rewriteFilter = filters.find((f) => f.type === "URLRewrite")?.urlRewrite;
    const rewrite = rewriteFilter ? { host: rewriteFilter.hostname ?? req.host, path: rewritePath(rewriteFilter.path, req.path, hit.prefix) } : null;
    const backends = hit.rule.backends;
    if (backends.length === 0) {
      return { kind: "fail", status: 500, why: "The rule has no backends and nothing that answers by itself, so the request fails. Implementations answer 500." };
    }
    const live = backends.filter((b) => b.weight > 0);
    if (live.length === 0) return { kind: "fail", status: 500, why: "Every backend of the rule has weight 0, so none of them gets the request." };
    const broken = live.filter((b) => b.exists === true && b.granted && b.ready === 0);
    const invalid = live.filter((b) => b.exists === false || !b.granted);
    const failing = [...invalid, ...broken].reduce((n, b) => n + b.share, 0);
    if (invalid.length === live.length) {
      return { kind: "fail", status: 500, why: `The only backend${live.length === 1 ? "" : "s"} of the rule cannot be used: ${invalid[0].problem} The API says every request that matches gets a 500.` };
    }
    if (invalid.length + broken.length === live.length) {
      return {
        kind: "fail",
        status: 503,
        why: `${live.length === 1 ? `The Service ${live[0].namespace}/${live[0].name} has` : "None of the backends has"} no ready endpoints, so there is nothing to send the request to. Implementations answer 503.`
      };
    }
    return { kind: "forward", backends, failing, rewrite };
  }
  function rewritePath(p, path, prefix) {
    if (!p) return path;
    if (p.type === "ReplaceFullPath") return p.replaceFullPath ?? path;
    if (p.type === "ReplacePrefixMatch" && prefix !== null) {
      const replacement = p.replacePrefixMatch ?? "/";
      const rest = prefix === "/" ? path.slice(1) : path.slice(prefix.length);
      if (!rest) return replacement || "/";
      const joined = replacement.endsWith("/") && rest.startsWith("/") ? replacement + rest.slice(1) : !replacement.endsWith("/") && !rest.startsWith("/") ? `${replacement}/${rest}` : replacement + rest;
      return joined || "/";
    }
    return path;
  }
  function exampleUrls(topo, limit = 6) {
    const out = [];
    for (const l of topo.listeners) {
      const scheme = l.protocol === "HTTPS" ? "https" : l.protocol === "HTTP" ? "http" : "";
      if (!scheme || l.tone === "error") continue;
      const port = scheme === "https" && l.port !== 443 || scheme === "http" && l.port !== 80 ? `:${l.port}` : "";
      for (const a of l.attachments) {
        if (a.route.type !== "HTTPRoute" || a.parent.tone === "error") continue;
        for (const h of a.route.hostnames.length ? a.route.hostnames : l.hostname ? [l.hostname] : []) {
          out.push(`${scheme}://${h.replace(/^\*\./, "www.")}${port}/`);
        }
      }
    }
    return [...new Set(out)].slice(0, limit);
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
      const refuse = (reason2, l, sentence) => {
        why = reason2;
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

  // src/model/problems.ts
  var AREA_ORDER = ["class", "gateway", "listener", "route", "backend"];
  var REASONS = {
    NotAllowedByListeners: {
      explain: "The Gateway exists, but none of the listeners it asked for lets this route in: they take routes from other namespaces, or of other kinds.",
      fix: "Widen the listener's allowedRoutes (namespaces.from: All, or a Selector that matches this namespace), or attach the route to a listener meant for it."
    },
    NoMatchingListenerHostname: {
      explain: "The route's hostnames and the listener's hostname have nothing in common, so the route can never receive a request there.",
      fix: "Give the route a hostname under the listener's (or none at all), or point it at the listener for its hostname with sectionName."
    },
    NoMatchingParent: {
      explain: "The parentRef names a Gateway, or a listener on it, that is not there.",
      fix: "Check the Gateway name and namespace in parentRefs, and that sectionName is the name of one of its listeners."
    },
    UnsupportedValue: {
      explain: "The controller does not support something the route asks for.",
      fix: "Read the message for which field; check the implementation's supported features."
    },
    IncompatibleFilters: {
      explain: "The route combines filters that cannot be used together, such as a redirect and a rewrite in one rule.",
      fix: "Split the filters over separate rules."
    },
    RefNotPermitted: {
      explain: "Something is referenced in another namespace, and no ReferenceGrant there allows it. The API refuses cross-namespace references unless the owner of the target namespace agrees.",
      fix: "Create a ReferenceGrant in the target namespace, from this kind and namespace, to the kind referenced."
    },
    BackendNotFound: {
      explain: "A backend the route sends traffic to does not exist. Requests that would have gone to it get a 500.",
      fix: "Create the Service, or correct the backendRef name, namespace or port."
    },
    InvalidKind: {
      explain: "A backend is of a kind the controller does not know how to send traffic to.",
      fix: "Point the backendRef at a Service, or at a kind your implementation supports."
    },
    UnsupportedProtocol: {
      explain: "The backend's appProtocol is one the controller cannot speak.",
      fix: "Change the Service port's appProtocol, or use a route type that fits it."
    },
    HostnameConflict: {
      explain: "Two listeners share a port, protocol and hostname, so a request could belong to either. The API requires every listener to be distinct; the conflicting ones are not used.",
      fix: "Give each listener on the port its own hostname, or remove one of them."
    },
    ProtocolConflict: {
      explain: "Two listeners on the same port want different protocols. Only one protocol can own a port.",
      fix: "Move one of the listeners to another port."
    },
    InvalidCertificateRef: {
      explain: "The listener's TLS certificate cannot be used: the Secret is missing, malformed, or in a namespace it may not read.",
      fix: "Check that the Secret exists and is a kubernetes.io/tls Secret; across namespaces, add a ReferenceGrant for it."
    },
    InvalidRouteKinds: {
      explain: "The listener lists a route kind in allowedRoutes that the controller does not support on that protocol.",
      fix: "Remove the kind from allowedRoutes.kinds, or use a protocol that takes it."
    },
    PortUnavailable: {
      explain: "The listener asks for a port the implementation cannot open.",
      fix: "Use another port, or check what else is bound to it."
    },
    AddressNotAssigned: {
      explain: "The Gateway has no address yet. Usually its Service of type LoadBalancer is still waiting for an external IP.",
      fix: "Check the load balancer (MetalLB, the cloud provider, cloud-provider-kind) or ask for a ClusterIP or NodePort Service instead."
    },
    AddressNotUsable: {
      explain: "The address asked for in spec.addresses cannot be used.",
      fix: "Pick an address the implementation can assign, or leave spec.addresses empty."
    },
    NoResources: {
      explain: "The implementation ran out of something it needs to program the Gateway.",
      fix: "Read the message and the controller's logs."
    },
    Pending: {
      explain: "The controller has seen it but has not finished with it yet.",
      fix: "Wait a moment. If it stays Pending, check the controller is running."
    },
    InvalidParameters: {
      explain: "The GatewayClass's parametersRef points at something missing or invalid.",
      fix: "Check the object named in spec.parametersRef."
    },
    Invalid: {
      explain: "The controller found the object invalid.",
      fix: "Read the message for what it objects to."
    },
    ListenersNotValid: {
      explain: "One or more of the Gateway’s listeners is invalid.",
      fix: "See the listener problems for this Gateway."
    },
    UnsupportedAddress: {
      explain: "The Gateway asks for a type of address the implementation does not support.",
      fix: "Remove or change spec.addresses."
    }
  };
  function reason(r) {
    return r ? REASONS[r] : void 0;
  }
  function detail(c) {
    if (!c) return "";
    return [c.reason, c.message].filter(Boolean).join(": ");
  }
  function problems(topo) {
    const out = [];
    const add = (p) => out.push({ ...p, namespace: p.ref.namespace });
    for (const c of topo.classes) {
      if (c.accepted === true) continue;
      const subject = `GatewayClass ${c.name}`;
      if (c.accepted === false) {
        add({
          id: `class-accepted:${c.name}`,
          tone: "error",
          area: "class",
          title: "GatewayClass not accepted",
          subject,
          ref: c.ref,
          explain: `The controller ${c.controller || "(none named)"} refused this class, so none of the ${c.gateways.length} Gateway${c.gateways.length === 1 ? "" : "s"} using it will be programmed. ${reason(c.condition?.reason)?.explain ?? ""}`.trim(),
          fix: reason(c.condition?.reason)?.fix ?? "Read the condition message, and check the controller for this class is installed and running.",
          detail: detail(c.condition)
        });
      } else if (c.gateways.length > 0) {
        add({
          id: `class-unclaimed:${c.name}`,
          tone: "warn",
          area: "class",
          title: "No controller has claimed this class",
          subject,
          ref: c.ref,
          explain: `Nothing has written a status on it, which usually means no controller named ${c.controller || "(none)"} is running. Gateways of this class are not being served.`,
          fix: "Install or start the controller whose name is in spec.controllerName, or correct the name.",
          detail: ""
        });
      }
    }
    for (const g of topo.gateways) gatewayProblems(g, add);
    for (const l of topo.listeners) listenerProblems(l, add);
    for (const s of topo.listenerSets) {
      const subject = `ListenerSet ${s.namespace}/${s.name}`;
      if (!s.parent) {
        add({ id: `ls-parent:${s.id}`, tone: "error", area: "listener", title: "ListenerSet has no Gateway", subject, ref: s.ref, explain: "The Gateway its parentRef names is not there, so its listeners exist nowhere.", fix: "Correct spec.parentRef, or create the Gateway.", detail: "" });
      } else if (s.accepted === false) {
        const c = condition(s.conditions, "Accepted");
        add({
          id: `ls-accepted:${s.id}`,
          tone: "error",
          area: "listener",
          title: "ListenerSet not accepted",
          subject,
          ref: s.ref,
          explain: `The Gateway ${s.parent.namespace}/${s.parent.name} did not take its listeners. A Gateway only takes ListenerSets its spec.allowedListeners lets in. ${reason(c?.reason)?.explain ?? ""}`.trim(),
          fix: reason(c?.reason)?.fix ?? `Allow it in ${s.parent.name}'s spec.allowedListeners, or read the condition message.`,
          detail: detail(c)
        });
      }
    }
    for (const r of topo.routes) routeProblems(r, add);
    return out.sort((a, b) => toneRank(b.tone) - toneRank(a.tone) || AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area) || a.subject.localeCompare(b.subject) || a.title.localeCompare(b.title));
  }
  function gatewayProblems(g, add) {
    const subject = `Gateway ${g.namespace}/${g.name}`;
    if (!g.cls) {
      add({
        id: `gw-class:${g.id}`,
        tone: "error",
        area: "gateway",
        title: "Its GatewayClass does not exist",
        subject,
        ref: g.ref,
        explain: `It asks for the class ${g.className || "(none)"}, which is not in the cluster, so no controller will ever program it.`,
        fix: "Set spec.gatewayClassName to one of the classes that exists, or create the class.",
        detail: ""
      });
      return;
    }
    if (g.conditions.length === 0) {
      add({
        id: `gw-status:${g.id}`,
        tone: "warn",
        area: "gateway",
        title: "No controller has reported on it",
        subject,
        ref: g.ref,
        explain: `The Gateway has no status at all. The controller for ${g.className} (${g.cls.controller}) has not picked it up.`,
        fix: "Check that the controller is running and watching this namespace.",
        detail: ""
      });
      return;
    }
    for (const type of ["Accepted", "Programmed"]) {
      const c = condition(g.conditions, type);
      if (c?.status !== "False") continue;
      const words = reason(c.reason);
      add({
        id: `gw-${type}:${g.id}`,
        tone: c.reason === "Pending" ? "warn" : "error",
        area: "gateway",
        title: type === "Accepted" ? "Gateway not accepted" : "Gateway not programmed",
        subject,
        ref: g.ref,
        explain: (type === "Accepted" ? "The controller refused the Gateway as written, so none of its listeners are served. " : "The controller accepted the Gateway but the data plane is not serving it yet. ") + (words?.explain ?? ""),
        fix: words?.fix ?? "Read the condition message and the controller logs.",
        detail: detail(c)
      });
    }
  }
  function listenerProblems(l, add) {
    const subject = `Listener ${l.name} (${listenerLine(l)}) on ${l.gateway.namespace}/${l.gateway.name}`;
    const ref = l.owner;
    const conflicted = condition(l.conditions, "Conflicted");
    if (conflicted?.status === "True") {
      const words = reason(conflicted.reason) ?? REASONS.HostnameConflict;
      add({ id: `l-conflict:${l.id}`, tone: "error", area: "listener", title: "Listener conflicts with another", subject, ref, explain: words.explain, fix: words.fix, detail: detail(conflicted) });
    }
    for (const type of ["Accepted", "ResolvedRefs", "Programmed"]) {
      const c = condition(l.conditions, type);
      if (c?.status !== "False") continue;
      if (conflicted?.status === "True" && type !== "ResolvedRefs") continue;
      const words = reason(c.reason);
      add({
        id: `l-${type}:${l.id}`,
        tone: "error",
        area: "listener",
        title: type === "ResolvedRefs" ? "Listener can't resolve a reference" : `Listener not ${type.toLowerCase()}`,
        subject,
        ref,
        explain: words?.explain ?? `The controller reports ${type} False on this listener; requests to it are not served.`,
        fix: words?.fix ?? "Read the condition message.",
        detail: detail(c)
      });
    }
    for (const c of l.certs) {
      if (c.granted) continue;
      add({
        id: `l-cert:${l.id}:${c.namespace}/${c.name}`,
        tone: "error",
        area: "listener",
        title: "Certificate in another namespace, no ReferenceGrant",
        subject,
        ref,
        explain: `The listener uses the Secret ${c.namespace}/${c.name}, which is outside ${l.owner.namespace}, and no ReferenceGrant in ${c.namespace} allows that. The controller will not load the certificate, so HTTPS on this listener fails.`,
        fix: `Add a ReferenceGrant in ${c.namespace} from Gateways in ${l.owner.namespace} to Secrets (optionally just ${c.name}).`,
        detail: ""
      });
    }
  }
  function routeProblems(r, add) {
    const subject = `${r.type} ${r.namespace}/${r.name}`;
    const ref = r.ref;
    if (r.parents.length === 0) {
      add({
        id: `r-noparent:${r.id}`,
        tone: "error",
        area: "route",
        title: "Route names no Gateway",
        subject,
        ref,
        explain: "It has no parentRefs, so it is attached to nothing and never receives traffic.",
        fix: "Add a parentRef to the Gateway (and listener) it is meant for.",
        detail: ""
      });
    }
    for (const p of r.parents) parentProblem(r, p, subject, add);
    const seen = /* @__PURE__ */ new Set();
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
            tone: "error",
            area: "backend",
            title: "Backend Service is missing",
            subject: bsubject,
            ref,
            explain: `The route sends traffic to the Service ${b.namespace}/${b.name}, which does not exist. ${b.share >= 1 ? "Every request this rule matches" : `${Math.round(b.share * 100)}% of the requests this rule matches`} gets a 500.`,
            fix: `Create the Service ${b.name} in ${b.namespace}, or correct the backendRef.`,
            detail: ""
          });
        } else if (!b.granted) {
          sawGrant = true;
          add({
            id: `b-grant:${r.id}:${b.key}`,
            tone: "error",
            area: "backend",
            title: "Cross-namespace backend without a ReferenceGrant",
            subject: bsubject,
            ref,
            explain: `The route is in ${r.namespace} and its backend is in ${b.namespace}. The API only allows that when a ReferenceGrant in ${b.namespace} says so, and there is none. The controller refuses the reference and requests to it get a 500.`,
            fix: `Create a ReferenceGrant in ${b.namespace} from ${r.type} in ${r.namespace} to Service${b.name ? ` ${b.name}` : "s"}.`,
            detail: ""
          });
        } else if (b.exists && b.ready === 0 && b.weight > 0) {
          add({
            id: `b-ready:${r.id}:${b.key}`,
            tone: b.tone === "error" ? "error" : "warn",
            area: "backend",
            title: "Backend has no ready endpoints",
            subject: bsubject,
            ref: b.ref ?? ref,
            explain: `The Service ${b.namespace}/${b.name} exists but no pod behind it is ready${b.total ? ` (${b.total} not ready)` : ""}. ${b.share >= 1 ? "Every request this rule matches fails, usually with a 503." : `About ${Math.round(b.share * 100)}% of this rule's requests fail, usually with a 503.`}`,
            fix: "Check the Service's selector matches running pods, that they pass their readiness probes, and that the workload is not scaled to zero.",
            detail: ""
          });
        }
      }
      if (rule.backends.length === 0 && !rule.filters.some((f) => f.type === "RequestRedirect")) {
        add({
          id: `r-nobackend:${r.id}:${rule.index}`,
          tone: "warn",
          area: "route",
          title: "Rule with nowhere to send traffic",
          subject: `${subject}, rule ${rule.index + 1}`,
          ref,
          explain: "The rule has no backendRefs and no redirect, so every request it matches fails.",
          fix: "Add a backendRef, or a RequestRedirect filter.",
          detail: ""
        });
      }
    }
    if (r.unresolved && !(r.unresolved.reason === "BackendNotFound" && sawMissing || r.unresolved.reason === "RefNotPermitted" && sawGrant)) {
      const words = reason(r.unresolved.reason);
      add({
        id: `r-resolved:${r.id}`,
        tone: "error",
        area: "route",
        title: "Route can't resolve a reference",
        subject,
        ref,
        explain: words?.explain ?? "The controller could not resolve one of the route’s references.",
        fix: words?.fix ?? "Read the condition message.",
        detail: detail(r.unresolved)
      });
    }
    if (r.partiallyInvalid) {
      add({
        id: `r-partial:${r.id}`,
        tone: "warn",
        area: "route",
        title: "Some rules were dropped",
        subject,
        ref,
        explain: "The controller found some of the rules invalid and serves only the rest.",
        fix: "Read the condition message for which rules, and fix or remove them.",
        detail: detail(r.partiallyInvalid)
      });
    }
  }
  function parentProblem(r, p, subject, add) {
    const target = `${p.ref.kind} ${p.ref.namespace}/${p.ref.name}${p.ref.sectionName ? ` (listener ${p.ref.sectionName})` : ""}`;
    if (p.missing) {
      add({
        id: `r-missing:${r.id}:${p.index}`,
        tone: "error",
        area: "route",
        title: "Orphaned: its Gateway does not exist",
        subject,
        ref: r.ref,
        explain: `The route asks to attach to ${target}, which is not in the cluster. Nothing will ever send it traffic${r.parents.length > 1 ? " through that parent" : ""}.`,
        fix: `Point parentRefs at a Gateway that exists, or create ${p.ref.namespace}/${p.ref.name}. Delete the route if it is left over.`,
        detail: detail(condition(p.status?.conditions, "Accepted"))
      });
      return;
    }
    if (p.accepted === false || p.accepted === null && p.listeners.length === 0) {
      const words = reason(p.reason);
      add({
        id: `r-accepted:${r.id}:${p.index}`,
        tone: "error",
        area: "route",
        title: p.accepted === false ? "Not accepted by its Gateway" : "Would not attach to its Gateway",
        subject,
        ref: r.ref,
        explain: p.specWhy ? `${p.specWhy} Until that changes, the route gets no traffic through ${target}.` : `${p.message || `It is not attached to ${target}.`} ${words?.explain ?? ""}`.trim(),
        fix: words?.fix ?? "Read the condition message.",
        detail: detail(condition(p.status?.conditions, "Accepted"))
      });
      return;
    }
    if (p.accepted === null) {
      add({
        id: `r-pending:${r.id}:${p.index}`,
        tone: "warn",
        area: "route",
        title: "No status from the controller yet",
        subject,
        ref: r.ref,
        explain: `By the spec it lands on ${p.listeners.map((l) => l.name).join(", ")} of ${target}, but no controller has confirmed it. Until one does, it may not be serving.`,
        fix: "Check the Gateway's controller is running. If the Gateway itself is fine, look at the controller's logs for this route.",
        detail: ""
      });
    }
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
  function every(ms, body, onError) {
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
  function fingerprint(value) {
    return JSON.stringify(value);
  }

  // src/ui/parts.ts
  var VIEWS = [
    ["overview", "Dashboard"],
    ["map", "Traffic map"],
    ["resolve", "Where does this URL go?"],
    ["problems", "Problems"]
  ];
  function heading(current, title, note, problems2 = null) {
    const nav = el("nav", { class: "tabs", "aria-label": "Gateway API views" });
    for (const [id, label] of VIEWS) {
      const here = id === current;
      const tab = el(
        "button",
        { type: "button", class: here ? "tab here" : "tab", "aria-current": here ? "page" : void 0 },
        label,
        id === "problems" && problems2 ? el("span", { class: "tab-count" }, String(problems2)) : null
      );
      if (!here) tab.addEventListener("click", () => void k8sdockside.openView(id));
      nav.append(tab);
    }
    return el(
      "header",
      { class: "page-head" },
      el(
        "div",
        { class: "page-title" },
        el("img", { class: "mark", src: "logo.svg", alt: "", width: 28, height: 28 }),
        el("div", {}, el("h1", {}, title), note ? el("p", { class: "note" }, note) : null)
      ),
      nav
    );
  }
  function pill(text, tone = "", title = "") {
    return el("span", { class: `pill pill-${tone || "none"}`, ...title ? { title } : {} }, text);
  }
  function dot(tone) {
    return el("span", { class: `dot dot-${tone || "none"}`, "aria-hidden": "true" });
  }
  function block(title, note, ...children) {
    return el(
      "section",
      { class: "block" },
      el("h2", {}, title),
      note ? el("p", { class: "note" }, note) : null,
      ...children.filter((c) => !!c)
    );
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

  // src/pages/resolve.ts
  var REFRESH = 15e3;
  var METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
  start("page", async (ctx) => {
    const head = byId("head");
    const body = byId("body");
    const failure = el("p", { class: "refresh-failure" });
    const note = `Follow a request through the Gateways in ${ctx.contextName}, by the Gateway API's own matching rules.`;
    replace(head, heading("resolve", "Where does this URL go?", note));
    const saved = await remember.get("resolve.form") ?? { url: "", method: "GET", headers: "", gatewayId: "" };
    const handed = await remember.get("resolve.url");
    if (handed) {
      saved.url = handed;
      await remember.set("resolve.url", null);
    }
    const url = el("input", { type: "search", class: "url-input big", placeholder: "https://shop.example.com/api/v1", "aria-label": "URL", value: saved.url, spellcheck: "false", autocomplete: "off" });
    const method = el("select", { "aria-label": "Method", class: "method" }, ...METHODS.map((m) => el("option", { value: m, selected: m === saved.method }, m)));
    const gateway = el("select", { "aria-label": "Gateway" });
    const headers = el("textarea", { class: "headers mono", rows: 3, placeholder: "x-canary: true\nuser-agent: Mobile", "aria-label": "Request headers, one per line", spellcheck: "false" });
    headers.value = saved.headers;
    const headerToggle = el("button", { type: "button", class: "link-button" });
    const headerRow = el("div", { class: "header-row" }, el("label", { class: "field-label" }, "Request headers, one per line"), headers);
    const go = el("button", { type: "button", class: "primary" }, "Follow it");
    const chips = el("div", { class: "chips" });
    const result = el("div", { class: "result" });
    const showHeaders = (show) => {
      headerRow.hidden = !show;
      headerToggle.textContent = show ? "Hide headers" : saved.headers.trim() ? `Headers (${saved.headers.trim().split("\n").length})` : "+ Headers";
    };
    showHeaders(!!saved.headers.trim());
    headerToggle.addEventListener("click", () => showHeaders(headerRow.hidden !== false));
    const form = el(
      "section",
      { class: "block ask" },
      el("div", { class: "url-row" }, method, url, go),
      el("div", { class: "ask-row" }, el("span", { class: "field-label" }, "Through"), gateway, headerToggle, el("span", { class: "spacer" }), el("span", { class: "faint small" }, "No scheme means https. tcp://, udp:// and tls:// reach the other listeners.")),
      headerRow,
      chips
    );
    let topo = null;
    let last = "";
    const run = () => {
      if (!topo) return;
      const state = { url: url.value, method: method.value, headers: headers.value, gatewayId: gateway.value };
      saved.headers = state.headers;
      void remember.set("resolve.form", state);
      if (!state.url.trim()) {
        replace(result, block("Try an address", "Type a URL above, or pick one of the hostnames this cluster serves. The answer is worked out from the objects in the cluster; no request is sent."));
        return;
      }
      const req = parseRequest(state.url, state.method, state.headers);
      if ("error" in req) {
        replace(result, el("div", { class: "failure" }, req.error));
        return;
      }
      replace(result, answer(resolve(topo, req, state.gatewayId), (h) => {
        headers.value = [headers.value.trim(), h].filter(Boolean).join("\n");
        saved.headers = headers.value;
        showHeaders(true);
        run();
      }));
    };
    go.addEventListener("click", run);
    url.addEventListener("keydown", (e) => {
      if (e.key === "Enter") run();
    });
    method.addEventListener("change", run);
    gateway.addEventListener("change", run);
    headers.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) run();
    });
    const stop2 = every(
      REFRESH,
      async () => {
        const { snap, installed } = await load();
        failure.textContent = "";
        document.getElementById("first")?.remove();
        const print = fingerprint(snap);
        if (print === last) return;
        last = print;
        if (!installed) {
          replace(body, failure, nothing(`${ctx.contextName} does not serve the Gateway API, so no address leads anywhere.`));
          return;
        }
        topo = topology(snap);
        replace(head, heading("resolve", "Where does this URL go?", note, problems(topo).length));
        const current = gateway.value || saved.gatewayId;
        replace(gateway, el("option", { value: "" }, "any Gateway"), ...topo.gateways.map((g) => el("option", { value: g.id, selected: g.id === current }, `${g.namespace}/${g.name}`)));
        gateway.value = topo.gateways.some((g) => g.id === current) ? current : "";
        replace(chips, ...exampleUrls(topo).map((u) => {
          const chip = el("button", { type: "button", class: "chip" }, u);
          chip.addEventListener("click", () => {
            url.value = u;
            run();
          });
          return chip;
        }));
        if (!body.contains(form)) replace(body, failure, form, result);
        run();
      },
      (err) => {
        failure.textContent = err instanceof Error ? err.message : String(err);
      }
    );
    addEventListener("pagehide", stop2);
  });
  function answer(res, addHeader) {
    const req = res.request;
    const stops = [];
    stops.push(
      stop(
        "Request",
        "",
        req.host,
        [`${req.method} ${req.path}${req.query.length ? "?" + new URLSearchParams(req.query).toString() : ""}`, `${req.scheme}${req.port ? " :" + req.port : ""}`, ...req.headers.map(([n, v]) => `${n}: ${v}`)],
        null
      )
    );
    if (res.pick) {
      const g = res.pick.gateway;
      const l = res.pick.listener;
      stops.push(stop("Gateway", g.tone, g.name, [g.namespace + (g.addresses.length ? ` · ${g.addresses[0]}` : ""), `class ${g.className}`], g.ref));
      const why = l.hostname ? l.hostname.startsWith("*") ? `wildcard ${l.hostname}` : `exact host ${l.hostname}` : "takes any host";
      stops.push(stop("Listener", l.tone, l.name, [`${l.protocol} :${l.port}`, why, ...l.viaSet ? [`from ListenerSet ${l.viaSet}`] : []], l.owner));
    }
    if (res.hit) {
      const r = res.hit.route;
      stops.push(
        stop(r.type, r.tone, r.name, [r.namespace, `rule ${res.hit.rule.index + 1} of ${r.rules.length}${res.hit.matchIndex >= 0 && (r.obj.spec?.rules?.[res.hit.rule.index]?.matches?.length ?? 0) > 1 ? `, match ${res.hit.matchIndex + 1}` : ""}`, ruleMatches(res.hit.rule, r.type)[Math.max(0, res.hit.matchIndex)] ?? ""], r.ref)
      );
      const f = filterStop(res);
      if (f) stops.push(f);
    }
    stops.push(outcomeStop(res));
    const path = el("div", { class: "path" });
    stops.forEach((s, i) => {
      if (i) path.append(el("div", { class: `path-arrow${i === stops.length - 1 ? " last" : ""}`, "aria-hidden": "true" }));
      path.append(s);
    });
    return el("div", {}, path, ...details(res, addHeader));
  }
  function stop(kicker, tone, title, lines, ref) {
    const node = el(
      "div",
      { class: `stop tone-edge-${tone || "none"}` },
      el("div", { class: "stop-kicker" }, dot(tone), kicker),
      el("div", { class: "stop-title" }, title),
      ...lines.filter(Boolean).map((line) => el("div", { class: "stop-line" }, line))
    );
    if (ref) {
      node.title = `Open ${title}`;
      clickable(node, () => open(ref));
    }
    return node;
  }
  function filterStop(res) {
    const lines = [];
    if (res.outcome.kind === "forward" && res.outcome.rewrite) {
      const rw = res.outcome.rewrite;
      if (rw.host !== res.request.host) lines.push(`host → ${rw.host}`);
      if (rw.path !== res.request.path) lines.push(`path → ${rw.path}`);
    }
    for (const m of res.requestHeaders) lines.push(...modifierWords(m).map((w) => `request: ${w}`));
    for (const m of res.responseHeaders) lines.push(...modifierWords(m).map((w) => `response: ${w}`));
    for (const m of res.mirrors) lines.push(`mirrored to ${m.name}`);
    for (const f of res.otherFilters) {
      const w = filterWords(f);
      lines.push(`${w.kind}${w.text ? ": " + w.text : ""}`);
    }
    if (!lines.length) return null;
    return stop("Filters", "info", `${lines.length} change${lines.length === 1 ? "" : "s"}`, lines, null);
  }
  function outcomeStop(res) {
    const o = res.outcome;
    if (o.kind === "redirect") {
      return el("div", { class: "stop end tone-edge-info" }, el("div", { class: "stop-kicker" }, dot("info"), "Redirect"), el("div", { class: "stop-title big" }, String(o.status)), el("div", { class: "stop-line mono" }, o.location));
    }
    if (o.kind === "fail") {
      return el(
        "div",
        { class: "stop end tone-edge-error" },
        el("div", { class: "stop-kicker" }, dot("error"), "Answer"),
        el("div", { class: "stop-title big tone-error" }, o.status ? String(o.status) : "No route"),
        el("div", { class: "stop-line wrap" }, o.why)
      );
    }
    const list = el("div", { class: "backends" });
    o.backends.forEach((b, i) => list.append(backendRow(b, i)));
    return el(
      "div",
      { class: `stop end tone-edge-${o.failing > 0 ? "warn" : "ok"}` },
      el("div", { class: "stop-kicker" }, dot(o.failing > 0 ? "warn" : "ok"), o.backends.length > 1 ? "Split between" : "Sent to"),
      o.backends.length > 1 ? backendSplit(o.backends) : null,
      list,
      o.failing > 0 ? el("div", { class: "stop-line tone-warn wrap" }, `${percent(o.failing)} of these requests fail: see the backends marked red.`) : null
    );
  }
  function details(res, addHeader) {
    const out = [];
    if (res.notes.length) out.push(el("div", { class: "notes" }, ...res.notes.map((n) => el("p", { class: "note-line" }, dot("warn"), n))));
    if (res.near.length) {
      out.push(
        block(
          "It only just missed",
          "More specific rules that would have taken this request, and what it would need.",
          el("ul", { class: "rules-list" }, ...res.near.map((n) => nearRow(n, addHeader)))
        )
      );
    }
    if (res.hit) {
      const why = el("div", { class: "why" }, ...res.hit.reasons.map((r) => pill(r, "info")));
      const lower = res.lower.length ? el("ul", { class: "rules-list" }, ...res.lower.map(hitRow)) : null;
      out.push(
        block(
          "Why this rule",
          res.lower.length ? `It matched on the things below. ${res.lower.length === 1 ? "One other rule matched too, and lost" : `${res.lower.length} other rules matched too, and lost`} on the Gateway API's precedence: hostname, then exact path, longest prefix, method, headers, query, then the oldest route.` : "It matched on the things below, and was the only rule that did.",
          why,
          lower ? el("h3", {}, "Also matched, lower precedence") : null,
          lower
        )
      );
    }
    if (res.pick && !res.hit && res.pick.listener.attachments.length) {
      const l = res.pick.listener;
      out.push(
        block(
          `What the listener ${l.name} does serve`,
          "None of these matched. Their hostnames and paths are what the request would have to fit.",
          el(
            "ul",
            { class: "rules-list" },
            ...l.attachments.map(
              (a) => clickable(
                el("li", { class: "rule-row" }, dot(a.route.tone), el("span", { class: "rule-route" }, `${ROUTE_WORD[a.route.type]} ${a.route.namespace}/${a.route.name}`), el("span", { class: "mono faint" }, a.route.hostnames.join(", ") || "any host"), el("span", { class: "faint" }, a.route.rules.flatMap((r) => ruleMatches(r, a.route.type)).slice(0, 3).join(" | "))),
                () => open(a.route.ref)
              )
            )
          )
        )
      );
    }
    if (res.others.length) {
      out.push(
        block(
          "Other ways in",
          "These Gateways would take the same address too, on their own addresses. Which one a client reaches is up to DNS.",
          el("ul", { class: "rules-list" }, ...res.others.map((o) => el("li", { class: "rule-row" }, dot(o.gateway.tone), openName(`${o.gateway.namespace}/${o.gateway.name}`, o.gateway.ref), el("span", { class: "faint" }, `listener ${o.listener.name} · ${o.listener.protocol} :${o.listener.port} ${o.listener.hostname || "any host"}`))))
        )
      );
    }
    if (!res.pick && res.refused.length) {
      out.push(
        block(
          "Why no Gateway takes it",
          "",
          el("ul", { class: "rules-list" }, ...res.refused.map((r) => el("li", { class: "rule-row" }, dot("error"), openName(`${r.gateway.namespace}/${r.gateway.name}`, r.gateway.ref), el("span", { class: "faint wrap" }, r.why))))
        )
      );
    }
    return out;
  }
  function hitRow(h) {
    return clickable(
      el("li", { class: "rule-row" }, dot(h.route.tone), el("span", { class: "rule-route" }, `${h.route.namespace}/${h.route.name}, rule ${h.rule.index + 1}`), el("span", { class: "faint" }, h.reasons.join(" · "))),
      () => open(h.route.ref)
    );
  }
  function nearRow(n, addHeader) {
    const target = n.rule.backends.map((b) => b.name).join(", ") || "a redirect";
    const headerNeeds = n.needs.filter((w) => w.startsWith("header ") && !w.includes(": /")).map((w) => w.slice("header ".length));
    const tryIt = headerNeeds.length ? el("button", { type: "button", class: "small-button" }, `Try with ${headerNeeds.join(", ")}`) : null;
    tryIt?.addEventListener("click", (e) => {
      e.stopPropagation();
      for (const h of headerNeeds) addHeader(h);
    });
    return el(
      "li",
      { class: "rule-row near" },
      dot("info"),
      el("span", { class: "rule-route" }, `${n.route.namespace}/${n.route.name}, rule ${n.rule.index + 1} → ${target}`),
      el("span", {}, "needs ", ...n.needs.flatMap((w, i) => [i ? " and " : "", code(w)])),
      el("span", { class: "spacer" }),
      tryIt
    );
  }
})();
