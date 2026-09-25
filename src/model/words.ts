// Route matches and filters in words, for the resolver and the panels.
//
// "PathPrefix /api, header x-canary: true" reads faster than the YAML it came
// from, and it is the same sentence everywhere the plugin shows a rule.

import type { RuleView } from './topology.js';
import type { Filter, GRPCMatch, HTTPMatch, HeaderModifier, RouteType } from './types.js';

export function httpMatchWords(m: HTTPMatch): string {
    const parts: string[] = [];
    const type = m.path?.type ?? 'PathPrefix';
    const value = m.path?.value ?? '/';
    if (type === 'Exact') parts.push(`path = ${value}`);
    else if (type === 'RegularExpression') parts.push(`path ~ /${value}/`);
    else parts.push(value === '/' ? 'any path' : `prefix ${value}`);
    if (m.method) parts.push(m.method.toUpperCase());
    for (const h of m.headers ?? []) parts.push(`${h.name}: ${h.type === 'RegularExpression' ? `/${h.value}/` : h.value}`);
    for (const q of m.queryParams ?? []) parts.push(`?${q.name}=${q.type === 'RegularExpression' ? `/${q.value}/` : q.value}`);
    return parts.join(' · ');
}

export function grpcMatchWords(m: GRPCMatch): string {
    const parts: string[] = [];
    const svc = m.method?.service;
    const method = m.method?.method;
    if (svc || method) parts.push(`${svc ?? '*'}/${method ?? '*'}${m.method?.type === 'RegularExpression' ? ' (regex)' : ''}`);
    else parts.push('any call');
    for (const h of m.headers ?? []) parts.push(`${h.name}: ${h.value}`);
    return parts.join(' · ');
}

/** Every match of a rule, one line each. A rule with none matches everything. */
export function ruleMatches(rule: RuleView, type: RouteType): string[] {
    const matches = rule.rule.matches ?? [];
    if (type === 'HTTPRoute') return matches.length ? (matches as HTTPMatch[]).map(httpMatchWords) : ['any path'];
    if (type === 'GRPCRoute') return matches.length ? (matches as GRPCMatch[]).map(grpcMatchWords) : ['any call'];
    return ['every connection'];
}

export function modifierWords(m: HeaderModifier): string[] {
    return [...(m.set ?? []).map((h) => `set ${h.name}: ${h.value}`), ...(m.add ?? []).map((h) => `add ${h.name}: ${h.value}`), ...(m.remove ?? []).map((h) => `remove ${h}`)];
}

/** What a filter does, in a few words. */
export function filterWords(f: Filter): { kind: string; text: string } {
    switch (f.type) {
        case 'RequestRedirect': {
            const r = f.requestRedirect ?? {};
            const bits: string[] = [];
            if (r.scheme) bits.push(`to ${r.scheme}`);
            if (r.hostname) bits.push(`host ${r.hostname}`);
            if (r.port) bits.push(`port ${r.port}`);
            if (r.path?.type === 'ReplaceFullPath') bits.push(`path ${r.path.replaceFullPath}`);
            if (r.path?.type === 'ReplacePrefixMatch') bits.push(`prefix → ${r.path.replacePrefixMatch}`);
            return { kind: `Redirect ${r.statusCode ?? 302}`, text: bits.join(', ') || 'to the same address' };
        }
        case 'URLRewrite': {
            const r = f.urlRewrite ?? {};
            const bits: string[] = [];
            if (r.hostname) bits.push(`host → ${r.hostname}`);
            if (r.path?.type === 'ReplaceFullPath') bits.push(`path → ${r.path.replaceFullPath}`);
            if (r.path?.type === 'ReplacePrefixMatch') bits.push(`prefix → ${r.path.replacePrefixMatch}`);
            return { kind: 'Rewrite', text: bits.join(', ') };
        }
        case 'RequestHeaderModifier':
            return { kind: 'Request headers', text: modifierWords(f.requestHeaderModifier ?? {}).join(', ') };
        case 'ResponseHeaderModifier':
            return { kind: 'Response headers', text: modifierWords(f.responseHeaderModifier ?? {}).join(', ') };
        case 'RequestMirror': {
            const b = f.requestMirror?.backendRef;
            const pct = f.requestMirror?.percent ?? (f.requestMirror?.fraction ? Math.round((f.requestMirror.fraction.numerator / (f.requestMirror.fraction.denominator ?? 100)) * 100) : 100);
            return { kind: 'Mirror', text: b ? `${pct}% copied to ${b.namespace ? b.namespace + '/' : ''}${b.name}` : '' };
        }
        case 'ExtensionRef': {
            const e = f.extensionRef ?? {};
            return { kind: 'Extension', text: `${e.kind ?? ''} ${e.name ?? ''}`.trim() };
        }
        default:
            return { kind: f.type, text: '' };
    }
}

