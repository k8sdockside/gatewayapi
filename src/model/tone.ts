// Tones and conditions.
//
// A tone is how bad something is, in the app's four words plus "nothing to
// say": the pages turn it into var(--ok), var(--warn), var(--error) or
// var(--accent) and never into a colour of their own.

import type { Condition } from './types.js';

export type Tone = 'ok' | 'warn' | 'error' | 'info' | '';

const RANK: Record<Tone, number> = { error: 4, warn: 3, '': 2, info: 1, ok: 0 };

export function toneRank(tone: Tone): number {
    return RANK[tone] ?? 2;
}

/** The worst of several tones. Nothing at all is `ok`. */
export function worst(tones: readonly Tone[]): Tone {
    let out: Tone = 'ok';
    for (const t of tones) if (toneRank(t) > toneRank(out)) out = t;
    return out;
}

export function condition(conditions: readonly Condition[] | undefined, type: string): Condition | undefined {
    return conditions?.find((c) => c.type === type);
}

/** `true`, `false`, or `null` when the condition is not there (yet). */
export function isTrue(conditions: readonly Condition[] | undefined, type: string): boolean | null {
    const c = condition(conditions, type);
    if (!c) return null;
    if (c.status === 'True') return true;
    if (c.status === 'False') return false;
    return null;
}

/**
 * The tone of a "positive" condition -- Accepted, Programmed, ResolvedRefs --
 * where True is good. Missing or Unknown is `warn`: the controller has not
 * said yet, which is worth seeing but is not a failure.
 */
export function positiveTone(conditions: readonly Condition[] | undefined, type: string): Tone {
    const v = isTrue(conditions, type);
    return v === true ? 'ok' : v === false ? 'error' : 'warn';
}

export function plural(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
}
