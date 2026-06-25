// Server-only canonical context builder for Claude project ask.

import type { SupabaseClient } from '@supabase/supabase-js';
import { classifyQuestion } from '@/lib/ask/classifier';
import { retrieveProjectTruth } from '@/lib/ask/retrieval';
import type {
  AskDocument,
  AskProjectRecord,
  DecisionRecord,
  Source,
  StructuredFact,
  ValidatorFinding,
} from '@/lib/ask/types';

type ProjectRow = {
  id: string;
  name: string;
  validation_status: string | null;
  validation_summary_json: unknown;
};

export type AskProjectClaudeContext = {
  contextSource: 'canonical_project_truth_retrieval';
  project: AskProjectRecord;
  scope: {
    projectId: string;
  };
  retrieval: {
    matchedLayer: string | null;
    structuredFactsSource: string | null;
    facts: Array<Pick<StructuredFact, 'id' | 'label' | 'value' | 'unit' | 'extractedFrom' | 'documentName' | 'page' | 'confidence' | 'timestamp' | 'anchorId' | 'factId' | 'fieldKey' | 'sourceKind' | 'sourceLabel'>>;
    validatorFindings: Array<Pick<ValidatorFinding, 'id' | 'severity' | 'category' | 'description' | 'blocksProject' | 'status' | 'blockedReason' | 'documentId' | 'documentName' | 'page' | 'snippet' | 'linkedDecisionId' | 'linkedActionId' | 'factId' | 'timestamp'>>;
    decisions: Array<Pick<DecisionRecord, 'id' | 'title' | 'status' | 'severity' | 'summary' | 'documentId' | 'documentName' | 'confidence' | 'createdAt' | 'detectedAt' | 'dueAt'>>;
    documents: Array<Pick<AskDocument, 'id' | 'title' | 'documentName' | 'documentType' | 'processingStatus' | 'createdAt' | 'processedAt' | 'page' | 'snippet'>>;
    relationships: unknown[];
    rawData: {
      validatorContext: unknown;
      totalDocumentCount: unknown;
      processedDocumentCount: unknown;
      openDecisionCount: unknown;
      executionSummary: unknown;
      reasoningCase: unknown;
    };
  };
};

function limit<T>(rows: T[], max: number): T[] {
  return rows.slice(0, max);
}

function assertProjectScopedContext(context: AskProjectClaudeContext, projectId: string): void {
  if (context.project.id !== projectId || context.scope.projectId !== projectId) {
    throw new Error('Claude project context scope mismatch.');
  }
}

export async function buildAskProjectContext(params: {
  admin: SupabaseClient;
  projectId: string;
  orgId: string;
  question: string;
  project: ProjectRow;
}): Promise<AskProjectClaudeContext> {
  if (params.project.id !== params.projectId) {
    throw new Error('Project context source returned the wrong project.');
  }

  const project: AskProjectRecord = {
    id: params.project.id,
    name: params.project.name,
    validationStatus: params.project.validation_status,
    validationSummary: params.project.validation_summary_json,
  };
  const classified = classifyQuestion(params.question);
  const retrieval = await retrieveProjectTruth({
    admin: params.admin,
    question: classified,
    projectId: params.projectId,
    orgId: params.orgId,
    project,
  });

  const context: AskProjectClaudeContext = {
    contextSource: 'canonical_project_truth_retrieval',
    project,
    scope: {
      projectId: params.projectId,
    },
    retrieval: {
      matchedLayer: retrieval.rawData.matchedLayer ?? null,
      structuredFactsSource: retrieval.rawData.structuredFactsSource ?? null,
      facts: limit(retrieval.facts, 24).map((fact) => ({
        id: fact.id,
        label: fact.label,
        value: fact.value,
        unit: fact.unit,
        extractedFrom: fact.extractedFrom,
        documentName: fact.documentName,
        page: fact.page,
        confidence: fact.confidence,
        timestamp: fact.timestamp,
        anchorId: fact.anchorId,
        factId: fact.factId,
        fieldKey: fact.fieldKey,
        sourceKind: fact.sourceKind,
        sourceLabel: fact.sourceLabel,
      })),
      validatorFindings: limit(retrieval.validatorFindings, 12).map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        category: finding.category,
        description: finding.description,
        blocksProject: finding.blocksProject,
        status: finding.status,
        blockedReason: finding.blockedReason,
        documentId: finding.documentId,
        documentName: finding.documentName,
        page: finding.page,
        snippet: finding.snippet,
        linkedDecisionId: finding.linkedDecisionId,
        linkedActionId: finding.linkedActionId,
        factId: finding.factId,
        timestamp: finding.timestamp,
      })),
      decisions: limit(retrieval.decisions, 12).map((decision) => ({
        id: decision.id,
        title: decision.title,
        status: decision.status,
        severity: decision.severity,
        summary: decision.summary,
        documentId: decision.documentId,
        documentName: decision.documentName,
        confidence: decision.confidence,
        createdAt: decision.createdAt,
        detectedAt: decision.detectedAt,
        dueAt: decision.dueAt,
      })),
      documents: limit(retrieval.documents, 12).map((document) => ({
        id: document.id,
        title: document.title,
        documentName: document.documentName,
        documentType: document.documentType,
        processingStatus: document.processingStatus,
        createdAt: document.createdAt,
        processedAt: document.processedAt,
        page: document.page,
        snippet: document.snippet,
      })),
      relationships: retrieval.relationships,
      rawData: {
        validatorContext: retrieval.rawData.validatorContext ?? null,
        totalDocumentCount: retrieval.rawData.totalDocumentCount ?? null,
        processedDocumentCount: retrieval.rawData.processedDocumentCount ?? null,
        openDecisionCount: retrieval.rawData.openDecisionCount ?? null,
        executionSummary: retrieval.rawData.executionSummary ?? null,
        reasoningCase: retrieval.rawData.reasoningCase ?? null,
      },
    },
  };

  assertProjectScopedContext(context, params.projectId);
  return context;
}
