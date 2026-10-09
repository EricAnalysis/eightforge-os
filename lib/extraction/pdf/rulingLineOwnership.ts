import type { PdfLayoutPage, PdfToken } from '@/lib/extraction/pdf/extractText';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import type { PricedSchedulePage, PricedScheduleColumnBand, PricedScheduleCellSourceRef, PricedScheduleCell, PricedScheduleUnresolvedRoleCell } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import { pricedScheduleAssemblyRole } from '@/lib/extraction/pdf/pricedScheduleRoles';
import { rulingLineInputIsIntact, rulingTokenGeometryDigest, type RulingLineInput, type RulingLineRule } from '@/lib/extraction/pdf/rulingLineEvidence';
const ordinate = (rule: RulingLineRule, coordinate: number) => rule.slope * coordinate + rule.intercept;
const refKey = (ref: PricedScheduleCellSourceRef) => `${ref.observation_id ?? ''}|${ref.text}|${ref.x_min}|${ref.y_min}`;
function refFor(token: PdfToken): PricedScheduleCellSourceRef {
    const box = token.source === 'ocr_fallback' ? token.ocr_source_geometry?.bbox : undefined;
    return { ...(token.observation_id ? { observation_id: token.observation_id } : {}), text: token.text,
        x_min: box?.x0 ?? token.x, x_max: box?.x1 ?? token.x + token.width,
        y_min: box?.y0 ?? token.y, y_max: box?.y1 ?? token.y + token.height,
        ...(token.source ? { source: token.source } : {}), ...(token.confidence == null ? {} : { confidence: token.confidence }) };
}
function groups(rules: readonly RulingLineRule[], coordinate: number): RulingLineRule[][] {
    const result: RulingLineRule[][] = [];
    for (const rule of [...rules].sort((a, b) => ordinate(a, coordinate) - ordinate(b, coordinate))) {
        const last = result.at(-1);
        if (last && Math.abs(ordinate(rule, coordinate) - last.reduce((sum, r) => sum + ordinate(r, coordinate), 0) / last.length) <= 4)
            last.push(rule);
        else
            result.push([rule]);
    }
    return result;
}
function boundary(group: readonly RulingLineRule[], coordinate: number): number | null {
    const active = group.filter((r) => coordinate >= r.start - 5 && coordinate <= r.end + 5);
    return active.length ? active.reduce((sum, r) => sum + ordinate(r, coordinate), 0) / active.length : null;
}
function covered(group: readonly RulingLineRule[], start: number, end: number): boolean {
    let reached = start;
    for (const rule of [...group].sort((a, b) => a.start - b.start)) {
        if (rule.end < reached)
            continue;
        if (rule.start > reached + 5)
            return false;
        reached = Math.max(reached, rule.end);
        if (reached >= end - 5)
            return true;
    }
    return false;
}
type Region = {
    row: number;
    col: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
    anchors: number[];
    ruleIds: string[];
};
type Located = {
    token: PdfToken;
    ref: PricedScheduleCellSourceRef;
    box: {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
    };
    region?: Region;
    intersects: boolean;
    uniqueInk: boolean;
};
/** Initial ownership only: physical separators never infer a header's semantic role. */
export function initialRulingColumnOwnership(
    layout: PdfLayoutPage,
    columns: readonly PricedScheduleColumnBand[],
    input: RulingLineInput,
): ReadonlyMap<PdfToken, number> | null {
    const e = input.evidence;
    const tokens = layout.lines.flatMap(line => line.tokens);
    if (layout.page_number !== e.physical_page_number || !rulingLineInputIsIntact(input)
        || !tokens.length || tokens.some(token => token.source !== 'ocr_fallback'
            || token.ocr_source_geometry?.pixel_width !== e.width
            || token.ocr_source_geometry.pixel_height !== e.height)
        || e.token_geometry_digest !== rulingTokenGeometryDigest(tokens.map(token => ({
            text: token.text, bbox: token.ocr_source_geometry!.bbox,
        })))) return null;
    const refs = columns.flatMap(column => column.header_source_refs ?? []);
    if (!refs.length || columns.some(column => !column.header_source_refs?.length)) return null;
    const keys = tokens.map(token => refKey(refFor(token)));
    if (new Set(keys).size !== keys.length) return null;
    const observed = new Map(tokens.map(token => [refKey(refFor(token)), refFor(token)]));
    if (refs.some(ref => {
        const actual = observed.get(refKey(ref));
        return !actual || actual.x_max !== ref.x_max || actual.y_max !== ref.y_max || actual.source !== ref.source;
    })) return null;
    const headerY = refs.reduce((sum, ref) => sum + (ref.y_min + ref.y_max) / 2, 0) / refs.length;
    const qualifying = e.grids.flatMap(grid => {
        const rules = e.rules.filter(rule => grid.ruleIds.includes(rule.id));
        const h = groups(rules.filter(rule => rule.axis === 'h'), e.width / 2);
        const v = groups(rules.filter(rule => rule.axis === 'v'), headerY);
        const xs = v.map(group => boundary(group, headerY));
        if (h.length < 2 || v.length !== columns.length + 1 || xs.some(x => x == null)
            || headerY <= ordinate(h[0]![0]!, e.width / 2)
            || headerY >= ordinate(h.at(-1)![0]!, e.width / 2)) return [];
        const physical = columns.map(column => {
            const source = column.header_source_refs!;
            const left = Math.min(...source.map(ref => ref.x_min));
            const right = Math.max(...source.map(ref => ref.x_max));
            return xs.findIndex((x, index) => index < xs.length - 1 && left > x! && right < xs[index + 1]!);
        });
        // Each observed header cell maps to exactly one physical cell. Neither
        // recognized roles nor text similarity can reconcile conflicting labels.
        if (physical.some(index => index < 0) || new Set(physical).size !== columns.length) return [];
        const top = ordinate(h[0]![0]!, e.width / 2), bottom = ordinate(h.at(-1)![0]!, e.width / 2);
        if (v.some(group => !covered(group, top, bottom))
            || !covered(h[0]!, xs[0]!, xs.at(-1)!) || !covered(h.at(-1)!, xs[0]!, xs.at(-1)!)) return [];
        return [{ rules, h, v, physical, top, bottom }];
    });
    if (qualifying.length !== 1) return null;
    const { rules, v, physical, top, bottom } = qualifying[0]!;
    const result = new Map<PdfToken, number>();
    for (const token of tokens) {
        const box = token.ocr_source_geometry!.bbox;
        if (box.y0 <= headerY || box.y0 <= top || box.y1 >= bottom) continue;
        const edges = v.map(group => {
            const first = boundary(group, box.y0), last = boundary(group, box.y1);
            if (first == null || last == null || !covered(group, box.y0, box.y1)) return null;
            const radius = Math.max(...group.map(rule => rule.thickness / 2 + 1));
            return { low: Math.min(first, last) - radius, high: Math.max(first, last) + radius };
        });
        if (edges.some(edge => !edge)) continue;
        const left = edges[0]!, right = edges.at(-1)!;
        if (box.x1 < left.low || box.x0 > right.high) continue;
        const hits = edges.slice(0, -1).flatMap((edge, index) =>
            box.x0 > edge!.high && box.x1 < edges[index + 1]!.low ? [index] : []);
        // Crossing / separator ink is withheld through the existing ambiguous
        // column diagnostics, never returned to midpoint or cluster assignment.
        let owner = hits.length === 1 ? hits[0]! : -1;
        if (owner < 0) {
            // OCR word boxes can contain a neighbouring printed rule. Reuse
            // the supported residual-ink proof: subtract only observed ruling
            // ink, then require all remaining ink inside one physical column.
            // Never crop source boxes, discard source text, or infer a role.
            const inkColumns = new Set<number>();
            let outside = false;
            for (let y = Math.max(0, Math.floor(box.y0)); y < Math.min(e.height, box.y1); y++) {
                const xs = v.map(group => boundary(group, y));
                for (let x = Math.max(0, Math.floor(box.x0)); x < Math.min(e.width, box.x1); x++) {
                    if (!input.ink[y * e.width + x] || rules.some(rule => {
                        const s = rule.axis === 'h' ? x : y, p = rule.axis === 'h' ? y : x;
                        return s >= rule.start && s <= rule.end && Math.abs(p - ordinate(rule, s)) <= rule.thickness / 2 + 1;
                    })) continue;
                    const col = xs.findIndex((left, index) => left != null && index < xs.length - 1
                        && xs[index + 1] != null && x > left + 1 && x < xs[index + 1]! - 1);
                    if (col < 0) outside = true;
                    else inkColumns.add(col);
                }
            }
            if (!outside && inkColumns.size === 1) owner = [...inkColumns][0]!;
        }
        result.set(token, owner >= 0 ? physical.indexOf(owner) : -1);
    }
    return result;
}
/** Resolve only after ordinary admission. Never create rows, rates, units or semantic roles. */
export function resolveRulingLineOwnership(page: PricedSchedulePage, layout: PdfLayoutPage, input: RulingLineInput): PricedSchedulePage {
    const e = input.evidence;
    if (page.status === 'failed_closed' || !page.rows.length || e.physical_page_number !== page.physical_page_number
        || layout.page_number !== page.physical_page_number || !rulingLineInputIsIntact(input))
        return page;
    // This render adapter currently binds OCR geometry. Native-only pages stay unchanged.
    const tokens = layout.lines.flatMap((line) => line.tokens);
    if (!tokens.some((token) => token.source === 'ocr_fallback'))
        return page;
    const usable = tokens.filter((token) => token.source === 'ocr_fallback'
        && token.ocr_source_geometry?.pixel_width === e.width && token.ocr_source_geometry.pixel_height === e.height);
    const headerRefs = page.columns.flatMap((column) => column.header_source_refs ?? []);
    if (!headerRefs.length || usable.length !== tokens.length)
        return page;
    if (e.token_geometry_digest !== rulingTokenGeometryDigest(usable.map((token) => ({ text: token.text, bbox: token.ocr_source_geometry!.bbox }))))
        return page;
    const headerY = headerRefs.reduce((sum, r) => sum + (r.y_min + r.y_max) / 2, 0) / headerRefs.length;
    const qualifying = e.grids.flatMap((grid) => {
        const rules = e.rules.filter((r) => grid.ruleIds.includes(r.id)), h = groups(rules.filter((r) => r.axis === 'h'), e.width / 2), v = groups(rules.filter((r) => r.axis === 'v'), e.height / 2);
        if (h.length < 2 || v.length < 4 || headerY <= ordinate(h[0]![0]!, e.width / 2)
            || headerY >= ordinate(h.at(-1)![0]!, e.width / 2))
            return [];
        const xs = v.map((group) => group.reduce((sum, r) => sum + ordinate(r, headerY), 0) / group.length);
        const headerColumns = page.columns.map((column, index) => {
            const refs = column.header_source_refs ?? [];
            const x = (Math.min(...refs.map((r) => r.x_min)) + Math.max(...refs.map((r) => r.x_max))) / 2;
            return { index, column, physical: xs.findIndex((left, i) => i < xs.length - 1 && x > left && x < xs[i + 1]!) };
        });
        if (headerColumns.some((c) => c.physical < 0))
            return [];
        const map = xs.slice(1).map((_, col) => {
            const headers = headerColumns.filter((c) => c.physical === col), resolved = headers.filter((c) => c.column.role != null);
            return resolved.length === 1 ? resolved[0]! : resolved.length === 0 && headers.length === 1 ? headers[0]! : null;
        });
        if (map.some((column) => !column))
            return [];
        // Multiple role-less labels may share one physical cell, but two recognized
        // roles may not. The latter is disagreement, never permission to override.
        if (map.filter((column) => column!.column.role != null).length !== headerColumns.filter((column) => column.column.role != null).length)
            return [];
        return [{ rules, h, v, map }];
    });
    if (qualifying.length !== 1)
        return page;
    const { rules, h, v, map } = qualifying[0]!;
    const regions: Region[] = [];
    for (let row = 0; row < h.length - 1; row++)
        for (let col = 0; col < v.length - 1; col++) {
            const y = (ordinate(h[row]![0]!, e.width / 2) + ordinate(h[row + 1]![0]!, e.width / 2)) / 2;
            const left = boundary(v[col]!, y), right = boundary(v[col + 1]!, y);
            if (left == null || right == null || right - left < 10)
                continue;
            const x = (left + right) / 2, top = boundary(h[row]!, x), bottom = boundary(h[row + 1]!, x);
            if (top == null || bottom == null || bottom - top < 10 || !covered(h[row]!, left, right)
                || !covered(h[row + 1]!, left, right) || !covered(v[col]!, top, bottom) || !covered(v[col + 1]!, top, bottom))
                continue;
            regions.push({ row, col, left, right, top, bottom, anchors: [], ruleIds: [...h[row]!, ...h[row + 1]!, ...v[col]!, ...v[col + 1]!].map((r) => r.id) });
        }
    const located: Located[] = usable.map((token) => {
        const box = token.ocr_source_geometry!.bbox;
        const near = rules.filter((rule) => {
            const start = Math.max(rule.start, rule.axis === 'h' ? box.x0 : box.y0);
            const end = Math.min(rule.end, rule.axis === 'h' ? box.x1 : box.y1);
            if (start > end) return false;
            // The whole overlap interval matters: a slanted rule can cross a
            // corner while its ordinate at the word's midpoint misses the box.
            const low = Math.min(ordinate(rule, start), ordinate(rule, end));
            const high = Math.max(ordinate(rule, start), ordinate(rule, end));
            const radius = rule.thickness / 2 + 1;
            return high + radius >= (rule.axis === 'h' ? box.y0 : box.x0)
                && low - radius <= (rule.axis === 'h' ? box.y1 : box.x1);
        });
        const hits = regions.filter((r) => (box.x0 + box.x1) / 2 > r.left && (box.x0 + box.x1) / 2 < r.right && (box.y0 + box.y1) / 2 > r.top && (box.y0 + box.y1) / 2 < r.bottom);
        const region = hits.length === 1 ? hits[0] : undefined;
        let residual = 0, outside = false;
        if (region)
            for (let y = Math.max(0, Math.floor(box.y0)); y < Math.min(e.height, box.y1); y++)
                for (let x = Math.max(0, Math.floor(box.x0)); x < Math.min(e.width, box.x1); x++) {
                    if (!input.ink[y * e.width + x] || near.some((r) => { const s = r.axis === 'h' ? x : y, p = r.axis === 'h' ? y : x; return s >= r.start && s <= r.end && Math.abs(p - ordinate(r, s)) <= r.thickness / 2 + 1; }))
                        continue;
                    residual++;
                    if (x < region.left - 1 || x > region.right + 1 || y < region.top - 1 || y > region.bottom + 1)
                        outside = true;
                }
        return { token, ref: refFor(token), box, region, intersects: near.length > 0, uniqueInk: residual > 0 && !outside };
    });
    const byRef = new Map(located.map((t) => [refKey(t.ref), t]));
    if (byRef.size !== located.length)
        return page; // Ambiguous primitive identity is not transferable.
    const resolvedOwners = new Map<string, {
        row: number;
        role: PricedScheduleCell['role'];
    }[]>();
    page.rows.forEach((row, index) => row.cells.forEach((cell) => cell.source_refs.forEach((ref) => {
        resolvedOwners.set(refKey(ref), [...(resolvedOwners.get(refKey(ref)) ?? []), { row: index, role: cell.role }]);
        if (cell.role !== 'rate')
            return;
        const token = byRef.get(refKey(ref));
        // Only an existing authored rate primitive anchors a grid row. Artifacts
        // in its union and unresolved rates cannot admit a row through this layer.
        if (!token?.region || !/^[$£€¥]\s*\d[\d,.]*$/.test(ref.text.trim()))
            return;
        for (const region of regions.filter((region) => region.row === token.region!.row))
            if (!region.anchors.includes(index))
                region.anchors.push(index);
    })));
    const allowed = new Set([
        ...page.rows.flatMap((row) => row.unresolved_role_cells?.flatMap((cell) => cell.source_refs) ?? []),
        ...(page.unattached_role_less_tokens ?? []),
        ...page.unassigned_lines.filter((line) => line.reason !== 'unpriced_row').flatMap((line) => line.source_refs),
    ].map(refKey));
    const protectedRefs = new Set([
        ...headerRefs, ...page.rejected_spines.flatMap((line) => line.source_refs),
        ...(page.table_edge_lines?.flatMap((line) => line.source_refs) ?? []),
        ...page.unassigned_lines.filter((line) => line.reason === 'unpriced_row').flatMap((line) => line.source_refs),
    ].map(refKey));
    // A ruled band proves one row only when it holds no evidence of another: no
    // protected structure (rejected or unpriced lines, edge lines), and no
    // unowned ink in a priced-role column on a line outside the anchor row's own
    // extent. An unadmitted row sharing the band would otherwise donate its text
    // to the admitted one. Ink on the anchor row's own line is not a second row.
    const contestedBands = new Set<number>();
    for (const token of located) {
        const region = token.region;
        if (!region || !token.uniqueInk || region.anchors.length !== 1)
            continue;
        const key = refKey(token.ref), role = pricedScheduleAssemblyRole(map[region.col]!.column.role);
        const anchor = page.rows[region.anchors[0]!]!, middle = (token.box.y0 + token.box.y1) / 2;
        if (protectedRefs.has(key) || (role !== null && role !== 'description' && !resolvedOwners.has(key)
            && (middle < anchor.y_min || middle > anchor.y_max)))
            contestedBands.add(region.row);
    }
    const plan = new Map<string, {
        row: number;
        col: number;
        ruleIds: string[];
    }>();
    for (const token of located) {
        const key = refKey(token.ref), region = token.region;
        if (!allowed.has(key) || protectedRefs.has(key) || resolvedOwners.has(key) || !region || !token.uniqueInk || token.intersects || region.anchors.length !== 1
            || contestedBands.has(region.row))
            continue;
        // Whole primitive containment is required for NEW ownership. Existing
        // crossing refs are retained verbatim, not cropped or classified as noise.
        if (token.box.x0 <= region.left || token.box.x1 >= region.right || token.box.y0 <= region.top || token.box.y1 >= region.bottom)
            continue;
        const target = map[region.col]!, row = region.anchors[0]!, role = pricedScheduleAssemblyRole(target.column.role);
        if (role !== null && role !== 'description')
            continue;
        if (located.some((other) => other.region === region && other.uniqueInk && (resolvedOwners.get(refKey(other.ref)) ?? []).some((owner) => owner.row !== row || owner.role !== role)))
            continue;
        const cells = page.rows[row]!;
        if (!(role === null ? cells.unresolved_role_cells?.some((cell) => cell.column_index === target.index) : cells.cells.some((cell) => cell.role === role)))
            continue;
        plan.set(key, { row, col: target.index, ruleIds: region.ruleIds });
    }
    if (!plan.size)
        return page;
    const changes: {
        source_ref: PricedScheduleCellSourceRef;
        row_index: number;
        column_index: number;
        rule_ids: string[];
    }[] = [];
    const rebuild = <T extends PricedScheduleCell | PricedScheduleUnresolvedRoleCell>(cell: T, refs: readonly PricedScheduleCellSourceRef[]): T => {
        const ordered = [...refs].sort((a, b) => (byRef.get(refKey(b))!.token.y - byRef.get(refKey(a))!.token.y) || a.x_min - b.x_min);
        return { ...cell, source_refs: ordered, raw_text: ordered.map((ref) => ref.text.trim()).filter(Boolean).join(' '),
            x_min: Math.min(...refs.map((r) => r.x_min)), x_max: Math.max(...refs.map((r) => r.x_max)), y_min: Math.min(...refs.map((r) => r.y_min)), y_max: Math.max(...refs.map((r) => r.y_max)) };
    };
    const rows = page.rows.map((row, index) => {
        const update = <T extends PricedScheduleCell | PricedScheduleUnresolvedRoleCell>(cell: T, col: number): T[] => {
            const kept = cell.source_refs.filter((ref) => { const destination = plan.get(refKey(ref)); return cell.role != null || !destination || (destination.row === index && destination.col === col); });
            const additions = located.filter((t) => { const destination = plan.get(refKey(t.ref)); return destination?.row === index && destination.col === col && !kept.some((r) => refKey(r) === refKey(t.ref)); });
            if (!additions.length && kept.length === cell.source_refs.length)
                return [cell];
            for (const token of additions)
                changes.push({ source_ref: token.ref, row_index: row.row_index, column_index: col, rule_ids: plan.get(refKey(token.ref))!.ruleIds });
            return kept.length + additions.length > 0 ? [rebuild(cell, [...kept, ...additions.map((t) => t.ref)])] : [];
        };
        const cells = row.cells.flatMap((cell) => update(cell, page.columns.findIndex((column) => column.role === cell.role)));
        const unresolved = row.unresolved_role_cells?.flatMap((cell) => update(cell, cell.column_index));
        if (cells.every((cell, i) => cell === row.cells[i]) && cells.length === row.cells.length && unresolved?.length === row.unresolved_role_cells?.length && unresolved?.every((cell, i) => cell === row.unresolved_role_cells![i]))
            return row;
        const ordered = [...cells.map((cell) => ({ cell, col: page.columns.findIndex((column) => column.role === cell.role) })), ...(unresolved ?? []).map((cell) => ({ cell, col: cell.column_index }))].sort((a, b) => a.col - b.col);
        const refs = ordered.flatMap(({ cell }) => cell.source_refs);
        const { unresolved_role_cells: _old, ...base } = row;
        return { ...base, cells, ...(unresolved?.length ? { unresolved_role_cells: unresolved } : {}), raw_text: ordered.map(({ cell }) => cell.raw_text).join(' | '),
            x_min: Math.min(...refs.map((r) => r.x_min)), x_max: Math.max(...refs.map((r) => r.x_max)), y_min: Math.min(...refs.map((r) => r.y_min)), y_max: Math.max(...refs.map((r) => r.y_max)) };
    });
    if (!changes.length)
        return page;
    const unattached = page.unattached_role_less_tokens?.filter((ref) => !plan.has(refKey(ref)));
    const unassigned = page.unassigned_lines.flatMap((line) => {
        const refs = line.source_refs.filter((ref) => !plan.has(refKey(ref)));
        return refs.length === line.source_refs.length ? [line] : refs.length ? [{ ...line, source_refs: refs, raw_text: refs.map((ref) => ref.text).join(' ') }] : [];
    });
    const { unattached_role_less_tokens: _old, ...base } = page;
    return { ...base, rows, unassigned_lines: unassigned, ...(unattached?.length ? { unattached_role_less_tokens: unattached } : {}),
        ruling_line_evidence: e, ruling_line_resolutions: changes,
        ruling_line_resolution_digest: hashCanonical({ evidence_digest: e.evidence_digest, resolutions: changes }) };
}
