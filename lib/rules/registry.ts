// lib/rules/registry.ts
// EightForge Rule System v1.0 — compact rule pack.
// ~30 deterministic rules across ticket, invoice, contract, payment rec families.
// Tower log, ROE, truck cert, monitor roster: deferred (weak extraction inputs).

import type {
  RuleDefinition,
  RuleContext,
  RuleOutput,
  RelatedDocFacts,
  ExtractedFacts,
} from './types.ts';

export const RULE_PACK_VERSION = 'v1.0.0';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[$,\s]/g, ''));
    return isNaN(n) ? null : n;
  }
  return null;
}

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  return null;
}

function normName(name: string | null | undefined): string {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/\binc\.?\b/g, '')
    .replace(/\bllc\.?\b/g, '')
    .replace(/\bcorp\.?\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

function findRelated(ctx: RuleContext, ...types: string[]): RelatedDocFacts | null {
  return ctx.relatedDocs.find(d => {
    const dt = (d.documentType ?? '').toLowerCase();
    const name = d.name.toLowerCase();
    return types.some(t => dt === t || name.includes(t));
  }) ?? null;
}

function fact(facts: ExtractedFacts, ...keys: string[]): unknown {
  for (const k of keys) {
    if (facts[k] !== undefined && facts[k] !== null && facts[k] !== '') return facts[k];
  }
  return null;
}

function scanAmount(text: string, ...patterns: RegExp[]): number | null {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const n = parseFloat((m[1] ?? '').replace(/,/g, ''));
      if (!isNaN(n)) return n;
    }
  }
  return null;
}

// ─── Rule definitions ────────────────────────────────────────────────────────

const rules: RuleDefinition[] = [];

function defineRule(rule: RuleDefinition): void {
  rules.push(rule);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TICKET RULES (single document)
// ═══════════════════════════════════════════════════════════════════════════════

defineRule({
  id: 'TKT-001',
  name: 'Ticket ID present',
  family: 'extraction',
  scope: 'single_document',
  appliesTo: ['ticket'],
  evaluate(ctx): RuleOutput | null {
    const ticketId = str(fact(ctx.facts, 'ticket_number', 'ticketNumber', 'ticketId'));
    if (!ticketId) {
      return {
        ruleId: 'TKT-001',
        ruleFamily: 'extraction',
        scope: 'single_document',
        finding: 'Ticket ID is missing from extracted fields.',
        decision: 'MISSING',
        severity: 'HIGH',
        taskType: 'verify_ticket_fields',
        priority: 'P1',
        ownerSuggestion: 'Field monitor',
        reason: 'Ticket ID is required for tracking and payment submission.',
        reference: 'Ticket must have a unique identifier for payment reconciliation.',
        evidenceFields: ['ticket_number'],
      };
    }
    return null;
  },
});

defineRule({
  id: 'TKT-002',
  name: 'Load exceeds truck capacity',
  family: 'single_document',
  scope: 'single_document',
  appliesTo: ['ticket'],
  evaluate(ctx): RuleOutput | null {
    const load = num(fact(ctx.facts, 'load_cy', 'loadCY', 'load', 'quantityCY'));
    const capacity = num(fact(ctx.facts, 'truck_capacity_cy', 'truckCapacityCY', 'truck_capacity'));
    if (load === null || capacity === null) {
      return {
        ruleId: 'TKT-002',
        ruleFamily: 'single_document',
        scope: 'single_document',
        finding: 'Load quantity and/or truck capacity could not be extracted.',
        decision: 'MISSING',
        severity: 'MEDIUM',
        taskType: 'verify_ticket_fields',
        priority: 'P2',
        ownerSuggestion: 'Project manager',
        reason: 'Both values are required to validate quantity support.',
        reference: 'Load CY must be within truck capacity for quantity support validation.',
        evidenceFields: ['load_cy', 'truck_capacity_cy'],
      };
    }
    const tolerance = capacity * 1.05;
    if (load > tolerance) {
      return {
        ruleId: 'TKT-002',
        ruleFamily: 'single_document',
        scope: 'single_document',
        finding: `Load ${load} CY exceeds truck capacity ${capacity} CY by ${Math.round(load - capacity)} CY.`,
        decision: 'WARN',
        severity: 'HIGH',
        taskType: 'verify_load_capacity',
        priority: 'P2',
        ownerSuggestion: 'Field monitor',
        reason: 'Over-capacity loads require verification before payment submission.',
        reference: 'Ticket load must not exceed truck capacity by more than 5%.',
        evidence: [`Load: ${load} CY`, `Capacity: ${capacity} CY`, `Overage: ${Math.round(load - capacity)} CY`],
        evidenceFields: ['load_cy', 'truck_capacity_cy'],
      };
    }
    return null;
  },
});

defineRule({
  id: 'TKT-003',
  name: 'Dumpsite field present',
  family: 'extraction',
  scope: 'single_document',
  appliesTo: ['ticket'],
  evaluate(ctx): RuleOutput | null {
    const dumpsite = str(fact(ctx.facts, 'dumpsite', 'dump_site', 'disposalSite'));
    if (!dumpsite) {
      return {
        ruleId: 'TKT-003',
        ruleFamily: 'extraction',
        scope: 'single_document',
        finding: 'Dumpsite/disposal site is missing from ticket extraction.',
        decision: 'MISSING',
        severity: 'HIGH',
        taskType: 'verify_ticket_fields',
        priority: 'P1',
        ownerSuggestion: 'Field monitor',
        reason: 'Disposal site is required for TDEC permit validation.',
        reference: 'Every ticket must identify the disposal site used.',
        evidenceFields: ['dumpsite'],
      };
    }
    return null;
  },
});

defineRule({
  id: 'TKT-004',
  name: 'Material type present',
  family: 'extraction',
  scope: 'single_document',
  appliesTo: ['ticket'],
  evaluate(ctx): RuleOutput | null {
    const material = str(fact(ctx.facts, 'material_type', 'materialType', 'material'));
    if (!material) {
      return {
        ruleId: 'TKT-004',
        ruleFamily: 'extraction',
        scope: 'single_document',
        finding: 'Material type is missing from ticket extraction.',
        decision: 'MISSING',
        severity: 'MEDIUM',
        taskType: 'verify_ticket_fields',
        priority: 'P2',
        ownerSuggestion: 'Field monitor',
        reason: 'Material type is needed to confirm the load is covered by the TDEC permit.',
        reference: 'Ticket material must match permit-approved materials.',
        evidenceFields: ['material_type'],
      };
    }
    return null;
  },
});

defineRule({
  id: 'TKT-005',
  name: 'Contractor name present',
  family: 'extraction',
  scope: 'single_document',
  appliesTo: ['ticket'],
  evaluate(ctx): RuleOutput | null {
    const contractor = str(fact(ctx.facts, 'contractor_name', 'contractorName', 'contractor'));
    if (!contractor) {
      return {
        ruleId: 'TKT-005',
        ruleFamily: 'extraction',
        scope: 'single_document',
        finding: 'Contractor name is missing from ticket.',
        decision: 'MISSING',
        severity: 'MEDIUM',
        taskType: 'verify_contractor_match',
        priority: 'P2',
        ownerSuggestion: 'Project manager',
        reason: 'Contractor name is needed for billing authorization verification.',
        reference: 'Ticket contractor must match the authorized project contractor.',
        evidenceFields: ['contractor_name'],
      };
    }
    return null;
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// TICKET RULES (cross document)
// ═══════════════════════════════════════════════════════════════════════════════

defineRule({
  id: 'TKT-X01',
  name: 'Dumpsite matches TDEC permit site',
  family: 'cross_document',
  scope: 'cross_document',
  appliesTo: ['ticket'],
  evaluate(ctx): RuleOutput | null {
    const dumpsite = str(fact(ctx.facts, 'dumpsite', 'dump_site', 'disposalSite'));
    const permit = findRelated(ctx, 'permit', 'tdec');
    if (!permit) {
      return {
        ruleId: 'TKT-X01',
        ruleFamily: 'cross_document',
        scope: 'cross_document',
        finding: 'No TDEC permit available for dumpsite validation.',
        decision: 'MISSING',
        severity: 'HIGH',
        taskType: 'upload_permit',
        priority: 'P1',
        ownerSuggestion: 'Project manager',
        reason: 'A TDEC permit is required to validate dumpsite and approved materials.',
        reference: 'Dumpsite must be validated against an active TDEC permit.',
      };
    }
    const permitSite = str(fact(permit.facts, 'site_name', 'siteName'));
    if (!dumpsite || !permitSite) return null;
    const tokensA = dumpsite.toLowerCase().split(/[\s,\-]+/).filter(t => t.length >= 4);
    const tokensB = permitSite.toLowerCase().split(/[\s,\-]+/).filter(t => t.length >= 4);
    const overlap = tokensA.some(t => tokensB.includes(t));
    if (!overlap) {
      return {
        ruleId: 'TKT-X01',
        ruleFamily: 'cross_document',
        scope: 'cross_document',
        finding: `Dumpsite "${dumpsite}" does not match permit site "${permitSite}".`,
        decision: 'WARN',
        severity: 'HIGH',
        taskType: 'verify_dumpsite_permit',
        priority: 'P1',
        ownerSuggestion: 'Environmental monitor',
        reason: 'Disposal at a non-permitted site is a compliance violation.',
        reference: 'Ticket dumpsite must match the TDEC permit-approved site.',
        evidence: [`Ticket dumpsite: ${dumpsite}`, `Permit site: ${permitSite}`],
      };
    }
    return null;
  },
});

defineRule({
  id: 'TKT-X02',
  name: 'Material covered by TDEC permit',
  family: 'cross_document',
  scope: 'cross_document',
  appliesTo: ['ticket'],
  evaluate(ctx): RuleOutput | null {
    const material = str(fact(ctx.facts, 'material_type', 'materialType', 'material'));
    const permit = findRelated(ctx, 'permit', 'tdec');
    if (!permit || !material) return null;
    const permitMaterials = str(fact(permit.facts, 'approved_materials', 'approvedMaterials'));
    if (!permitMaterials) return null;
    const matLower = material.toLowerCase();
    const permLower = permitMaterials.toLowerCase();
    const compatible =
      permLower.includes(matLower) ||
      (matLower.includes('veg') && permLower.includes('wood')) ||
      (matLower.includes('wood') && permLower.includes('veg')) ||
      (matLower.includes('debris') && permLower.includes('storm'));
    if (!compatible) {
      return {
        ruleId: 'TKT-X02',
        ruleFamily: 'cross_document',
        scope: 'cross_document',
        finding: `Material "${material}" may not be covered by permit-approved "${permitMaterials}".`,
        decision: 'WARN',
        severity: 'HIGH',
        taskType: 'verify_material_permit',
        priority: 'P1',
        ownerSuggestion: 'Environmental monitor',
        reason: 'Disposing unpermitted materials is a TDEC compliance violation.',
        reference: 'Ticket material must be within permit-approved material categories.',
        evidence: [`Ticket material: ${material}`, `Permit materials: ${permitMaterials}`],
      };
    }
    return null;
  },
});

defineRule({
  id: 'TKT-X03',
  name: 'Ticket contractor matches project contract',
  family: 'cross_document',
  scope: 'cross_document',
  appliesTo: ['ticket'],
  evaluate(ctx): RuleOutput | null {
    const ticketContractor = str(fact(ctx.facts, 'contractor_name', 'contractorName', 'contractor'));
    const contract = findRelated(ctx, 'contract');
    if (!contract || !ticketContractor) return null;
    const contractContractor = str(fact(contract.facts, 'vendor_name', 'contractorName', 'contractor'));
    if (!contractContractor) return null;
    if (!namesMatch(ticketContractor, contractContractor)) {
      return {
        ruleId: 'TKT-X03',
        ruleFamily: 'cross_document',
        scope: 'cross_document',
        finding: `Ticket contractor "${ticketContractor}" differs from contract contractor "${contractContractor}".`,
        decision: 'WARN',
        severity: 'MEDIUM',
        taskType: 'verify_contractor_match',
        priority: 'P2',
        ownerSuggestion: 'Project manager',
        reason: 'Contractor mismatch may indicate unauthorized billing.',
        reference: 'Ticket contractor should match the project contract.',
        evidence: [`Ticket: ${ticketContractor}`, `Contract: ${contractContractor}`],
      };
    }
    return null;
  },
});

defineRule({
  id: 'TKT-X04',
  name: 'Duplicate ticket detection',
  family: 'cross_document',
  scope: 'cross_document',
  appliesTo: ['ticket'],
  evaluate(ctx): RuleOutput | null {
    const ticketId = str(fact(ctx.facts, 'ticket_number', 'ticketNumber', 'ticketId'));
    if (!ticketId) return null;
    for (const doc of ctx.relatedDocs) {
      const dt = (doc.documentType ?? '').toLowerCase();
      if (dt !== 'ticket' && dt !== 'debris_ticket') continue;
      const otherId = str(fact(doc.facts, 'ticket_number', 'ticketNumber', 'ticketId'));
      if (otherId && otherId === ticketId) {
        return {
          ruleId: 'TKT-X04',
          ruleFamily: 'cross_document',
          scope: 'cross_document',
          finding: `Duplicate ticket number "${ticketId}" found in project.`,
          decision: 'BLOCK',
          severity: 'CRITICAL',
          taskType: 'verify_duplicate_ticket',
          priority: 'P1',
          ownerSuggestion: 'Project manager',
          reason: 'Duplicate tickets can result in double payment.',
          reference: 'Each ticket number must be unique within a project.',
          blockProcessing: true,
          evidence: [`Ticket ID: ${ticketId}`, `Duplicate in: ${doc.name}`],
        };
      }
    }
    return null;
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// INVOICE RULES (single document)
// ═══════════════════════════════════════════════════════════════════════════════

defineRule({
  id: 'INV-001',
  name: 'Invoice number present',
  family: 'extraction',
  scope: 'single_document',
  appliesTo: ['invoice'],
  evaluate(ctx): RuleOutput | null {
    const invNum = str(fact(ctx.facts, 'invoice_number', 'invoiceNumber'));
    if (!invNum) {
      return {
        ruleId: 'INV-001',
        ruleFamily: 'extraction',
        scope: 'single_document',
        finding: 'Invoice number is missing from extracted fields.',
        decision: 'MISSING',
        severity: 'MEDIUM',
        taskType: 'verify_ticket_fields',
        priority: 'P2',
        ownerSuggestion: 'Finance reviewer',
        reason: 'Invoice number is required for tracking and reconciliation.',
        reference: 'Every invoice must have a unique identifier.',
        evidenceFields: ['invoice_number'],
      };
    }
    return null;
  },
});

defineRule({
  id: 'INV-002',
  name: 'Current payment due present',
  family: 'extraction',
  scope: 'single_document',
  appliesTo: ['invoice'],
  evaluate(ctx): RuleOutput | null {
    const amount = num(fact(ctx.facts, 'current_amount_due', 'currentPaymentDue', 'total_amount'));
    if (amount === null) {
      const scanned = scanAmount(ctx.textPreview,
        /current\s+payment\s+due[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
        /current\s+amount\s+due[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
      );
      if (scanned === null) {
        return {
          ruleId: 'INV-002',
          ruleFamily: 'extraction',
          scope: 'single_document',
          finding: 'Current payment due amount could not be extracted.',
          decision: 'MISSING',
          severity: 'HIGH',
          taskType: 'verify_invoice_amount',
          priority: 'P1',
          ownerSuggestion: 'Finance reviewer',
          reason: 'Payment due amount is critical for invoice validation.',
          reference: 'Invoice must show a current payment due amount.',
          evidenceFields: ['current_amount_due'],
        };
      }
    }
    return null;
  },
});

defineRule({
  id: 'INV-003',
  name: 'Invoice date present',
  family: 'extraction',
  scope: 'single_document',
  appliesTo: ['invoice'],
  evaluate(ctx): RuleOutput | null {
    const date = str(fact(ctx.facts, 'invoice_date', 'invoiceDate'));
    if (!date) {
      return {
        ruleId: 'INV-003',
        ruleFamily: 'extraction',
        scope: 'single_document',
        finding: 'Invoice date is missing from extracted fields.',
        decision: 'MISSING',
        severity: 'MEDIUM',
        taskType: 'verify_invoice_dates',
        priority: 'P2',
        ownerSuggestion: 'Finance reviewer',
        reason: 'Invoice date is part of the audit trail.',
        reference: 'Every invoice must include a date for proper accounting.',
        evidenceFields: ['invoice_date'],
      };
    }
    return null;
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// INVOICE RULES (cross document)
// ═══════════════════════════════════════════════════════════════════════════════

defineRule({
  id: 'INV-X01',
  name: 'Invoice amount matches payment recommendation',
  family: 'cross_document',
  scope: 'cross_document',
  appliesTo: ['invoice'],
  evaluate(ctx): RuleOutput | null {
    const payRec = findRelated(ctx, 'payment_rec', 'payment rec', 'pay rec');
    if (!payRec) {
      return {
        ruleId: 'INV-X01',
        ruleFamily: 'cross_document',
        scope: 'cross_document',
        finding: 'No payment recommendation found for invoice validation.',
        decision: 'MISSING',
        severity: 'HIGH',
        taskType: 'upload_payment_rec',
        priority: 'P1',
        ownerSuggestion: 'Finance reviewer',
        reason: 'Payment recommendation is required to validate the approved amount.',
        reference: 'Invoice amount must be validated against an approved payment recommendation.',
      };
    }
    const currentDue = num(fact(ctx.facts, 'current_amount_due', 'currentPaymentDue', 'total_amount'))
      ?? scanAmount(ctx.textPreview,
        /current\s+payment\s+due[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
        /current\s+amount\s+due[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
      );
    const recAmount = num(fact(payRec.facts, 'approved_amount', 'net_recommended_amount',
      'netRecommendedAmount', 'amountRecommendedForPayment'))
      ?? scanAmount(payRec.textPreview,
        /amount\s+recommended\s+for\s+payment[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
        /net\s+recommended[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
      );
    if (currentDue === null || recAmount === null) return null;
    if (Math.abs(currentDue - recAmount) < 0.02) return null;
    const delta = Math.abs(currentDue - recAmount);
    return {
      ruleId: 'INV-X01',
      ruleFamily: 'cross_document',
      scope: 'cross_document',
      finding: `Invoice due $${currentDue.toFixed(2)} differs from recommended $${recAmount.toFixed(2)} by $${delta.toFixed(2)}.`,
      decision: 'WARN',
      severity: 'CRITICAL',
      taskType: 'verify_invoice_amount',
      priority: 'P1',
      ownerSuggestion: 'Finance reviewer',
      reason: 'Amount variance may indicate a data entry error or unapproved change.',
      reference: 'Invoice current due must match the approved recommendation amount.',
      evidence: [`Invoice due: $${currentDue.toFixed(2)}`, `Recommended: $${recAmount.toFixed(2)}`, `Variance: $${delta.toFixed(2)}`],
    };
  },
});

defineRule({
  id: 'INV-X02',
  name: 'Contract ceiling check (NTE vs G702)',
  family: 'cross_document',
  scope: 'cross_document',
  appliesTo: ['invoice'],
  evaluate(ctx): RuleOutput | null {
    const contract = findRelated(ctx, 'contract');
    if (!contract) {
      return {
        ruleId: 'INV-X02',
        ruleFamily: 'cross_document',
        scope: 'cross_document',
        finding: 'No contract found for ceiling validation.',
        decision: 'MISSING',
        severity: 'HIGH',
        taskType: 'upload_contract',
        priority: 'P1',
        ownerSuggestion: 'Project manager',
        reason: 'Contract is required to validate NTE ceiling against G702.',
        reference: 'Invoice G702 contract sum must be checked against contract NTE.',
      };
    }
    const nte = num(fact(contract.facts, 'nte_amount', 'notToExceedAmount'))
      ?? scanAmount(contract.textPreview,
        /not\s+to\s+exceed[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
        /NTE[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
      );
    const g702 = num(fact(ctx.facts, 'g702_contract_sum', 'g702ContractSum'))
      ?? scanAmount(ctx.textPreview,
        /original\s+contract\s+sum[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
      );
    if (nte === null || g702 === null) {
      return {
        ruleId: 'INV-X02',
        ruleFamily: 'cross_document',
        scope: 'cross_document',
        finding: 'NTE and/or G702 contract sum could not be extracted for ceiling check.',
        decision: 'MISSING',
        severity: 'HIGH',
        taskType: 'verify_contract_ceiling',
        priority: 'P2',
        ownerSuggestion: 'Project manager',
        reason: 'Both values are required to validate contract ceiling.',
        reference: 'NTE vs G702 ceiling check requires both extracted values.',
        evidenceFields: ['nte_amount', 'g702_contract_sum'],
      };
    }
    const delta = Math.abs(nte - g702);
    if (delta > 100) {
      return {
        ruleId: 'INV-X02',
        ruleFamily: 'cross_document',
        scope: 'cross_document',
        finding: `Contract NTE $${nte.toLocaleString()} differs from G702 sum $${g702.toLocaleString()} by $${delta.toLocaleString()}.`,
        decision: 'BLOCK',
        severity: 'CRITICAL',
        taskType: 'verify_contract_ceiling',
        priority: 'P1',
        ownerSuggestion: 'Finance reviewer',
        reason: 'NTE/G702 mismatch may indicate an unapplied amendment or data error.',
        reference: 'G702 original contract sum must be consistent with contract NTE.',
        blockProcessing: true,
        evidence: [`NTE: $${nte.toLocaleString()}`, `G702: $${g702.toLocaleString()}`, `Delta: $${delta.toLocaleString()}`],
      };
    }
    return null;
  },
});

defineRule({
  id: 'INV-X03',
  name: 'Invoice date matches payment recommendation date',
  family: 'cross_document',
  scope: 'cross_document',
  appliesTo: ['invoice'],
  evaluate(ctx): RuleOutput | null {
    const payRec = findRelated(ctx, 'payment_rec', 'payment rec', 'pay rec');
    if (!payRec) return null;
    const invDate = str(fact(ctx.facts, 'invoice_date', 'invoiceDate'));
    const recDate = str(fact(payRec.facts, 'date_of_invoice', 'recommendationDate', 'invoice_date'));
    if (!invDate || !recDate) return null;
    if (invDate !== recDate) {
      return {
        ruleId: 'INV-X03',
        ruleFamily: 'cross_document',
        scope: 'cross_document',
        finding: `Invoice date "${invDate}" differs from payment rec date "${recDate}".`,
        decision: 'INFO',
        severity: 'HIGH',
        taskType: 'verify_invoice_dates',
        priority: 'P2',
        ownerSuggestion: 'Project manager',
        reason: 'Date inconsistency creates audit trail risk.',
        reference: 'G702 invoice date should match the payment recommendation invoice date.',
        evidence: [`Invoice: ${invDate}`, `Payment rec: ${recDate}`],
      };
    }
    return null;
  },
});

defineRule({
  id: 'INV-X04',
  name: 'Contractor name consistency across invoice package',
  family: 'cross_document',
  scope: 'cross_document',
  appliesTo: ['invoice'],
  evaluate(ctx): RuleOutput | null {
    const invContractor = str(fact(ctx.facts, 'vendor_name', 'contractorName'));
    const payRec = findRelated(ctx, 'payment_rec', 'payment rec', 'pay rec');
    const contract = findRelated(ctx, 'contract');
    if (!invContractor) return null;
    const compareTo = payRec
      ? str(fact(payRec.facts, 'vendor_name', 'contractor', 'contractorName'))
      : contract
        ? str(fact(contract.facts, 'vendor_name', 'contractorName', 'contractor'))
        : null;
    if (!compareTo) return null;
    if (!namesMatch(invContractor, compareTo)) {
      return {
        ruleId: 'INV-X04',
        ruleFamily: 'cross_document',
        scope: 'cross_document',
        finding: `Invoice contractor "${invContractor}" differs from related doc contractor "${compareTo}".`,
        decision: 'WARN',
        severity: 'MEDIUM',
        taskType: 'verify_contractor_match',
        priority: 'P2',
        ownerSuggestion: 'Project manager',
        reason: 'Contractor name mismatch across package documents is an audit risk.',
        reference: 'All documents in a finance package should reference the same contractor.',
        evidence: [`Invoice: ${invContractor}`, `Related: ${compareTo}`],
      };
    }
    return null;
  },
});

defineRule({
  id: 'INV-X05',
  name: 'Spreadsheet backup requires manual reconciliation',
  family: 'cross_document',
  scope: 'cross_document',
  appliesTo: ['invoice'],
  evaluate(ctx): RuleOutput | null {
    const spreadsheet = ctx.relatedDocs.find(d => {
      const dt = (d.documentType ?? '').toLowerCase();
      const name = d.name.toLowerCase();
      return dt === 'spreadsheet' || name.endsWith('.xlsx') || name.endsWith('.xls');
    });
    if (!spreadsheet) return null;
    return {
      ruleId: 'INV-X05',
      ruleFamily: 'cross_document',
      scope: 'cross_document',
      finding: 'Spreadsheet backup present; automated CLIN reconciliation unavailable.',
      decision: 'INFO',
      severity: 'MEDIUM',
      taskType: 'reconcile_spreadsheet',
      priority: 'P2',
      ownerSuggestion: 'Finance reviewer',
      reason: 'Manual reconciliation is required for spreadsheet-backed CLINs.',
      reference: 'Spreadsheet CLIN totals must be reconciled against G703 amounts.',
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONTRACT RULES (single document)
// ═══════════════════════════════════════════════════════════════════════════════

defineRule({
  id: 'CTR-001',
  name: 'NTE amount present',
  family: 'extraction',
  scope: 'single_document',
  appliesTo: ['contract'],
  evaluate(ctx): RuleOutput | null {
    const nte = num(fact(ctx.facts, 'nte_amount', 'notToExceedAmount'));
    const scanned = nte ?? scanAmount(ctx.textPreview,
      /not\s+to\s+exceed[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
      /not\s+to\s+exceed[^0-9]{0,80}([\d,]+(?:\.\d{1,2})?)/i,
      /NTE[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
      /NTE[^0-9]{0,80}([\d,]+(?:\.\d{1,2})?)/i,
      /maximum\s+contract[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
      /maximum\s+contract[^0-9]{0,120}([\d,]+(?:\.\d{1,2})?)/i,
    );
    if (scanned === null) {
      return {
        ruleId: 'CTR-001',
        ruleFamily: 'extraction',
        scope: 'single_document',
        finding: 'Contract NTE (not-to-exceed) amount is not present.',
        decision: 'MISSING',
        severity: 'HIGH',
        taskType: 'verify_nte_amount',
        priority: 'P1',
        ownerSuggestion: 'Project manager',
        reason: 'NTE is required for ceiling validation on linked invoices.',
        reference: 'Contract must contain a not-to-exceed amount.',
        evidenceFields: ['nte_amount'],
      };
    }
    return null;
  },
});

defineRule({
  id: 'CTR-002',
  name: 'Rate schedule / Exhibit A present',
  family: 'single_document',
  scope: 'single_document',
  appliesTo: ['contract'],
  evaluate(ctx): RuleOutput | null {
    const t = ctx.textPreview.toLowerCase();
    const hasRateSchedule = t.includes('exhibit a') || t.includes('rate schedule') ||
      t.includes('unit price') || t.includes('unit rates') || t.includes('schedule of rates');
    if (!hasRateSchedule) {
      return {
        ruleId: 'CTR-002',
        ruleFamily: 'single_document',
        scope: 'single_document',
        finding: 'Rate schedule / Exhibit A not detected in contract text.',
        decision: 'WARN',
        severity: 'MEDIUM',
        taskType: 'verify_rate_schedule',
        priority: 'P2',
        ownerSuggestion: 'Project manager',
        reason: 'Rate schedule is needed for invoice line item validation.',
        reference: 'Contract should contain Exhibit A or equivalent rate schedule.',
      };
    }
    return null;
  },
});

defineRule({
  id: 'CTR-003',
  name: 'Contractor name present in contract',
  family: 'extraction',
  scope: 'single_document',
  appliesTo: ['contract'],
  evaluate(ctx): RuleOutput | null {
    const vendor = str(fact(ctx.facts, 'vendor_name', 'contractorName'));
    if (!vendor) {
      return {
        ruleId: 'CTR-003',
        ruleFamily: 'extraction',
        scope: 'single_document',
        finding: 'Contractor/vendor name missing from contract extraction.',
        decision: 'MISSING',
        severity: 'MEDIUM',
        taskType: 'review_document',
        priority: 'P2',
        ownerSuggestion: 'Project manager',
        reason: 'Contractor name is needed for cross-document validation.',
        reference: 'Contract must identify the contracting party.',
        evidenceFields: ['vendor_name'],
      };
    }
    return null;
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENT RECOMMENDATION RULES (single document)
// ═══════════════════════════════════════════════════════════════════════════════

defineRule({
  id: 'PAY-001',
  name: 'Recommended amount present',
  family: 'extraction',
  scope: 'single_document',
  appliesTo: ['payment_rec'],
  evaluate(ctx): RuleOutput | null {
    const amount = num(fact(ctx.facts, 'approved_amount', 'net_recommended_amount',
      'netRecommendedAmount', 'amountRecommendedForPayment'));
    const scanned = amount ?? scanAmount(ctx.textPreview,
      /amount\s+recommended\s+for\s+payment[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
      /net\s+recommended[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
    );
    if (scanned === null) {
      return {
        ruleId: 'PAY-001',
        ruleFamily: 'extraction',
        scope: 'single_document',
        finding: 'Recommended payment amount could not be extracted.',
        decision: 'MISSING',
        severity: 'HIGH',
        taskType: 'verify_payment_rec_amount',
        priority: 'P1',
        ownerSuggestion: 'Finance reviewer',
        reason: 'The approved amount is the primary output of a payment recommendation.',
        reference: 'Payment recommendation must specify the amount recommended for payment.',
        evidenceFields: ['approved_amount'],
      };
    }
    return null;
  },
});

defineRule({
  id: 'PAY-002',
  name: 'Contractor name present in payment recommendation',
  family: 'extraction',
  scope: 'single_document',
  appliesTo: ['payment_rec'],
  evaluate(ctx): RuleOutput | null {
    const name = str(fact(ctx.facts, 'vendor_name', 'contractor', 'contractorName', 'applicantName'));
    if (!name) {
      return {
        ruleId: 'PAY-002',
        ruleFamily: 'extraction',
        scope: 'single_document',
        finding: 'Contractor/applicant name missing from payment recommendation.',
        decision: 'MISSING',
        severity: 'MEDIUM',
        taskType: 'verify_contractor_match',
        priority: 'P2',
        ownerSuggestion: 'Finance reviewer',
        reason: 'Contractor name is needed for cross-validation against invoice.',
        reference: 'Payment recommendation must identify the payee.',
        evidenceFields: ['vendor_name'],
      };
    }
    return null;
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENT RECOMMENDATION RULES (cross document)
// ═══════════════════════════════════════════════════════════════════════════════

defineRule({
  id: 'PAY-X01',
  name: 'Payment rec amount matches linked invoice',
  family: 'cross_document',
  scope: 'cross_document',
  appliesTo: ['payment_rec'],
  evaluate(ctx): RuleOutput | null {
    const invoice = findRelated(ctx, 'invoice');
    if (!invoice) return null;
    const recAmount = num(fact(ctx.facts, 'approved_amount', 'net_recommended_amount',
      'netRecommendedAmount', 'amountRecommendedForPayment'))
      ?? scanAmount(ctx.textPreview,
        /amount\s+recommended\s+for\s+payment[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
      );
    const invAmount = num(fact(invoice.facts, 'current_amount_due', 'currentPaymentDue', 'total_amount'))
      ?? scanAmount(invoice.textPreview,
        /current\s+payment\s+due[^$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
      );
    if (recAmount === null || invAmount === null) return null;
    if (Math.abs(recAmount - invAmount) < 0.02) return null;
    const delta = Math.abs(recAmount - invAmount);
    return {
      ruleId: 'PAY-X01',
      ruleFamily: 'cross_document',
      scope: 'cross_document',
      finding: `Recommended $${recAmount.toFixed(2)} differs from invoice due $${invAmount.toFixed(2)} by $${delta.toFixed(2)}.`,
      decision: 'WARN',
      severity: 'CRITICAL',
      taskType: 'verify_payment_rec_amount',
      priority: 'P1',
      ownerSuggestion: 'Finance reviewer',
      reason: 'Amount variance between recommendation and invoice must be resolved.',
      reference: 'Payment recommendation amount must match invoice current due.',
      evidence: [`Recommended: $${recAmount.toFixed(2)}`, `Invoice due: $${invAmount.toFixed(2)}`, `Variance: $${delta.toFixed(2)}`],
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// PERMIT / DISPOSAL RULES (single document — light support)
// ═══════════════════════════════════════════════════════════════════════════════

defineRule({
  id: 'PRM-001',
  name: 'Permit expiration check',
  family: 'single_document',
  scope: 'single_document',
  appliesTo: ['permit'],
  evaluate(ctx): RuleOutput | null {
    const expiry = str(fact(ctx.facts, 'expirationDate', 'expiration_date'));
    if (!expiry) return null;
    const expDate = new Date(expiry);
    if (isNaN(expDate.getTime())) return null;
    const now = new Date();
    const daysLeft = Math.floor((expDate.getTime() - now.getTime()) / 86400000);
    if (daysLeft < 0) {
      return {
        ruleId: 'PRM-001',
        ruleFamily: 'single_document',
        scope: 'single_document',
        finding: `Permit expired ${Math.abs(daysLeft)} days ago (${expiry}).`,
        decision: 'BLOCK',
        severity: 'CRITICAL',
        taskType: 'verify_permit_expiry',
        priority: 'P1',
        ownerSuggestion: 'Project manager',
        reason: 'Expired permits invalidate all disposal operations at this site.',
        reference: 'TDEC permit must be current for disposal operations.',
        blockProcessing: true,
        evidence: [`Expiry: ${expiry}`, `Days past: ${Math.abs(daysLeft)}`],
      };
    }
    if (daysLeft <= 30) {
      return {
        ruleId: 'PRM-001',
        ruleFamily: 'single_document',
        scope: 'single_document',
        finding: `Permit expires in ${daysLeft} days (${expiry}).`,
        decision: 'WARN',
        severity: 'HIGH',
        taskType: 'verify_permit_expiry',
        priority: 'P2',
        ownerSuggestion: 'Project manager',
        reason: 'Permit renewal should be initiated before expiration.',
        reference: 'Permits expiring within 30 days require renewal action.',
        evidence: [`Expiry: ${expiry}`, `Days remaining: ${daysLeft}`],
      };
    }
    return null;
  },
});

defineRule({
  id: 'PRM-002',
  name: 'GPS coordinates present on permit',
  family: 'extraction',
  scope: 'single_document',
  appliesTo: ['permit', 'disposal_checklist'],
  evaluate(ctx): RuleOutput | null {
    const lat = num(fact(ctx.facts, 'gpsLat', 'gps_lat'));
    const lng = num(fact(ctx.facts, 'gpsLng', 'gps_lng'));
    if (lat === null || lng === null) {
      return {
        ruleId: 'PRM-002',
        ruleFamily: 'extraction',
        scope: 'single_document',
        finding: 'GPS coordinates missing from permit/disposal document.',
        decision: 'MISSING',
        severity: 'MEDIUM',
        taskType: 'verify_gps_coordinates',
        priority: 'P3',
        ownerSuggestion: 'Environmental monitor',
        reason: 'GPS coordinates are needed for waterway debris and site verification.',
        reference: 'Disposal site documents should include GPS coordinates.',
        evidenceFields: ['gpsLat', 'gpsLng'],
      };
    }
    return null;
  },
});

// ─── Registry export ─────────────────────────────────────────────────────────

export function getRulePack(): readonly RuleDefinition[] {
  return rules;
}

export function getRuleById(id: string): RuleDefinition | undefined {
  return rules.find(r => r.id === id);
}

export function getRulesForDocumentType(docType: string): RuleDefinition[] {
  const normalized = docType.toLowerCase().replace('debris_', '');
  return rules.filter(r =>
    r.appliesTo.includes(normalized as never) || r.appliesTo.includes('any'),
  );
}

export function getRuleCount(): number {
  return rules.length;
}
