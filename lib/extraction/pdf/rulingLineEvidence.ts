import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
/** Raster evidence only. Never OCR cleanup, semantic authority or observation identity. */
export const RULING_LINE_DETECTOR_VERSION = 'axis_ink_runs_v2';
export const RULING_LINE_EVIDENCE_VERSION = 'ruling_line_evidence_v1';
export const RULING_LINE_METHOD = Object.freeze({ version: RULING_LINE_DETECTOR_VERSION, luminanceThreshold: 160, maxWhiteGapPixels: 2, minRunFraction: 0.06, minRunFloorPixels: 64,
    minLineFraction: 0.15, minLineFloorPixels: 100, joinPerpendicularPixels: 3, minRunOverlapFraction: 0.5, minRunInkDensity: 0.8,
    maxFitResidualPixels: 3.5, minAxisRatio: 20, gridJunctionTolerancePixels: 5, minFittedInkContinuity: 0.9 });
type Run = {
    s: number;
    e: number;
    p: number;
    ink: number;
};
export type RulingLineRule = {
    id: string;
    axis: 'h' | 'v';
    start: number;
    end: number;
    slope: number;
    intercept: number;
    thickness: number;
    residual: number;
    runCount: number;
    runInkDensity: number;
    fittedInkContinuity: number;
    grid: boolean;
    junctionIds: string[];
};
export function detect(ink: Uint8Array, width: number, height: number, axis: 'h' | 'v'): RulingLineRule[] {
    const n = axis === 'h' ? width : height, m = axis === 'h' ? height : width;
    const minRun = Math.max(RULING_LINE_METHOD.minRunFloorPixels, Math.floor(n * RULING_LINE_METHOD.minRunFraction));
    const runs: Run[] = [];
    for (let p = 0; p < m; p++) {
        let start = -1, last = -1, dark = 0;
        const flush = () => { if (start >= 0 && last - start + 1 >= minRun && dark / (last - start + 1) >= RULING_LINE_METHOD.minRunInkDensity)
            runs.push({ s: start, e: last, p, ink: dark }); start = -1; last = -1; dark = 0; };
        for (let s = 0; s < n; s++) {
            const on = ink[axis === 'h' ? p * width + s : s * width + p];
            if (on) {
                if (start < 0)
                    start = s;
                last = s;
                dark++;
            }
            else if (start >= 0 && s - last > RULING_LINE_METHOD.maxWhiteGapPixels)
                flush();
        }
        flush();
    }
    const parent = runs.map((_, i) => i);
    const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]!));
    const unite = (a: number, b: number) => { a = find(a); b = find(b); if (a !== b)
        parent[Math.max(a, b)] = Math.min(a, b); };
    let first = 0;
    for (let i = 0; i < runs.length; i++) {
        const r = runs[i]!;
        while (first < i && r.p - runs[first]!.p > RULING_LINE_METHOD.joinPerpendicularPixels)
            first++;
        for (let j = first; j < i; j++) {
            const q = runs[j]!;
            const overlap = Math.min(r.e, q.e) - Math.max(r.s, q.s) + 1;
            if (overlap >= RULING_LINE_METHOD.minRunOverlapFraction * Math.min(r.e - r.s + 1, q.e - q.s + 1))
                unite(i, j);
        }
    }
    const groups = new Map<number, Run[]>();
    runs.forEach((r, i) => { const root = find(i); groups.set(root, [...(groups.get(root) ?? []), r]); });
    const rules: RulingLineRule[] = [];
    for (const group of groups.values()) {
        const start = Math.min(...group.map(r => r.s)), end = Math.max(...group.map(r => r.e));
        const low = Math.min(...group.map(r => r.p)), high = Math.max(...group.map(r => r.p));
        if (end - start + 1 < Math.max(RULING_LINE_METHOD.minLineFloorPixels, n * RULING_LINE_METHOD.minLineFraction) || (end - start + 1) / (high - low + 1) < RULING_LINE_METHOD.minAxisRatio)
            continue;
        // Fit all positions of every source run, including within-run variance.
        let weight = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (const r of group) {
            const x = (r.s + r.e) / 2, w = r.e - r.s + 1;
            weight += w;
            sx += w * x;
            sy += w * r.p;
            sxx += w * (x * x + (w * w - 1) / 12);
            sxy += w * x * r.p;
        }
        const variance = sxx - sx * sx / weight;
        const slope = variance > 1e-9 ? (sxy - sx * sy / weight) / variance : 0;
        const intercept = (sy - slope * sx) / weight;
        const residual = Math.max(...group.flatMap(r => [Math.abs(r.p - (slope * r.s + intercept)), Math.abs(r.p - (slope * r.e + intercept))]));
        if (residual > RULING_LINE_METHOD.maxFitResidualPixels || Math.abs(slope) > 0.05)
            continue;
        let supported = 0;
        const radius = Math.max(1, Math.ceil(residual));
        for (let s = start; s <= end; s++) {
            let on = false;
            const center = Math.round(slope * s + intercept);
            for (let p = Math.max(0, center - radius); p <= Math.min(m - 1, center + radius); p++)
                if (ink[axis === 'h' ? p * width + s : s * width + p]) {
                    on = true;
                    break;
                }
            if (on)
                supported++;
        }
        const fittedInkContinuity = supported / (end - start + 1);
        if (fittedInkContinuity < RULING_LINE_METHOD.minFittedInkContinuity)
            continue;
        const round = (v: number) => Math.round(v * 1e6) / 1e6;
        rules.push({ id: '', axis, start, end, slope: round(slope), intercept: round(intercept), thickness: round(2 * residual + 1), residual: round(residual),
            runCount: group.length, runInkDensity: round(group.reduce((sum, r) => sum + r.ink, 0) / group.reduce((sum, r) => sum + r.e - r.s + 1, 0)), fittedInkContinuity: round(fittedInkContinuity), grid: false, junctionIds: [] });
    }
    return rules.sort((a, b) => a.intercept - b.intercept || a.start - b.start || a.end - b.end).map((rule, i) => ({ ...rule, id: `${axis}${i + 1}` }));
}
const ordinate = (r: RulingLineRule, x: number) => r.slope * x + r.intercept;
export function establishGrids(rules: RulingLineRule[]) {
    for (const h of rules.filter(r => r.axis === 'h'))
        for (const v of rules.filter(r => r.axis === 'v')) {
            const y = (h.slope * v.intercept + h.intercept) / (1 - h.slope * v.slope), x = ordinate(v, y), t = RULING_LINE_METHOD.gridJunctionTolerancePixels;
            if (x >= h.start - t && x <= h.end + t && y >= v.start - t && y <= v.end + t) {
                h.junctionIds.push(v.id);
                v.junctionIds.push(h.id);
            }
        }
    const seen = new Set<string>();
    const components: RulingLineRule[][] = [];
    for (const rule of rules) {
        if (seen.has(rule.id))
            continue;
        const pending = [rule], component: RulingLineRule[] = [];
        while (pending.length) {
            const r = pending.pop()!;
            if (seen.has(r.id))
                continue;
            seen.add(r.id);
            component.push(r);
            for (const id of r.junctionIds) {
                const other = rules.find(r => r.id === id)!;
                if (!seen.has(id))
                    pending.push(other);
            }
        }
        if (component.filter(r => r.axis === 'h').length >= 2 && component.filter(r => r.axis === 'v').length >= 2) {
            component.forEach(r => r.grid = true);
            components.push(component);
        }
    }
    return components.map(component => ({ ruleIds: component.map(r => r.id).sort(), horizontal: component.filter(r => r.axis === 'h').length, vertical: component.filter(r => r.axis === 'v').length }));
}
export type RulingLineEvidence = {
    readonly evidence_version: typeof RULING_LINE_EVIDENCE_VERSION;
    readonly authority: 'non_authoritative_structure';
    readonly source_sha256: string;
    readonly render_sha256: string;
    readonly physical_page_number: number;
    readonly width: number;
    readonly height: number;
    readonly detector_version: typeof RULING_LINE_DETECTOR_VERSION;
    readonly rules: readonly RulingLineRule[];
    readonly grids: readonly {
        ruleIds: string[];
        horizontal: number;
        vertical: number;
    }[];
    readonly geometry_digest: string;
    readonly ink_digest: string;
    readonly token_geometry_digest: string | null;
    readonly evidence_digest: string;
};
export type RulingLineInput = {
    readonly evidence: RulingLineEvidence;
    readonly ink: Uint8Array;
};
/** Binding check only; matches the existing OCR layout's whitespace handling. */
export function rulingTokenGeometryDigest(words: readonly {
    text: string;
    bbox: {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
    };
}[]): string {
    return hashCanonical(words.map((word) => ({ text: word.text.replace(/\s+/g, ' ').trim(), bbox: word.bbox }))
        .filter((word) => word.text && Object.values(word.bbox).every(Number.isFinite)
        && (word.bbox.x1 > word.bbox.x0 || word.bbox.y1 > word.bbox.y0))
        .sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0 || a.text.localeCompare(b.text)
        || a.bbox.x1 - b.bbox.x1 || a.bbox.y1 - b.bbox.y1));
}
export function buildRulingLineInput(input: {
    sourceSha256: string;
    renderSha256: string;
    physicalPageNumber: number;
    width: number;
    height: number;
    rgba: Uint8Array | Uint8ClampedArray;
    tokenGeometry?: Parameters<typeof rulingTokenGeometryDigest>[0];
}): RulingLineInput {
    if (!/^[a-f0-9]{64}$/.test(input.sourceSha256) || !/^[a-f0-9]{64}$/.test(input.renderSha256)
        || !Number.isInteger(input.physicalPageNumber) || input.physicalPageNumber < 1
        || !Number.isInteger(input.width) || !Number.isInteger(input.height)
        || input.width <= 0 || input.height <= 0 || input.rgba.length !== input.width * input.height * 4) {
        throw new Error('Invalid ruling raster binding');
    }
    const ink = new Uint8Array(input.width * input.height);
    for (let i = 0; i < ink.length; i++) {
        const p = 4 * i;
        ink[i] = input.rgba[p + 3]! > 0
            && (299 * input.rgba[p]! + 587 * input.rgba[p + 1]! + 114 * input.rgba[p + 2]!) / 1000
                < RULING_LINE_METHOD.luminanceThreshold ? 1 : 0;
    }
    const rules = [...detect(ink, input.width, input.height, 'h'), ...detect(ink, input.width, input.height, 'v')];
    const grids = establishGrids(rules);
    const geometry = { detector_version: RULING_LINE_DETECTOR_VERSION as typeof RULING_LINE_DETECTOR_VERSION, width: input.width, height: input.height, rules, grids };
    const bound = {
        evidence_version: RULING_LINE_EVIDENCE_VERSION as typeof RULING_LINE_EVIDENCE_VERSION,
        authority: 'non_authoritative_structure' as const,
        source_sha256: input.sourceSha256, render_sha256: input.renderSha256,
        physical_page_number: input.physicalPageNumber, ...geometry,
        geometry_digest: hashCanonical(geometry), ink_digest: sha256Hex(ink),
        token_geometry_digest: input.tokenGeometry ? rulingTokenGeometryDigest(input.tokenGeometry) : null,
    };
    return { evidence: { ...bound, evidence_digest: hashCanonical(bound) }, ink };
}
export function rulingLineInputIsIntact(input: RulingLineInput): boolean {
    const { evidence_digest, ...bound } = input.evidence;
    const e = input.evidence;
    return e.evidence_version === RULING_LINE_EVIDENCE_VERSION && e.authority === 'non_authoritative_structure' && e.detector_version === RULING_LINE_DETECTOR_VERSION
        && hashCanonical(bound) === evidence_digest && sha256Hex(input.ink) === e.ink_digest
        && input.ink.length === e.width * e.height
        && hashCanonical({ detector_version: e.detector_version, width: e.width, height: e.height, rules: e.rules, grids: e.grids }) === e.geometry_digest;
}
