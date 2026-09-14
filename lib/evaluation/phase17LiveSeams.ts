/**
 * Phase 17 trusted production seams.
 *
 * The two production functions the live behavioral evaluation must exercise
 * unchanged, referenced from exactly one audited module so the harness can prove
 * by identity that a live run used them:
 *
 *  - buildDurableRecoveryProposalV2: the pure durable proposal projection. Only
 *    the projection is referenced; its sibling persistence functions never are.
 *  - scheduleRecoveryCandidateV2Shadow: the Phase 16 scheduler and planner. The
 *    harness always supplies every IO dependency (register, run, persistProposal,
 *    persistOutcome, loadPriorState, budget) as an in-memory evaluation sink, and
 *    refuses to start while any database environment is configured.
 *
 * Importing this module creates no database or provider client. It lives beside
 * the other evaluation harnesses rather than inside the provider-evaluation
 * subtree, which may not import serving code, and the harness loads it only when
 * a live run or a seam override requires it.
 */
import { scheduleRecoveryCandidateV2Shadow } from '@/lib/extraction/persistence/complianceShadow';
import { buildDurableRecoveryProposalV2 } from '@/lib/server/forgewingRecoveryProposalPersistence';

export const PHASE17_TRUSTED_PROJECT_DURABLE_PROPOSAL = buildDurableRecoveryProposalV2;
export const PHASE17_TRUSTED_SCHEDULE_RECOVERY = scheduleRecoveryCandidateV2Shadow;
