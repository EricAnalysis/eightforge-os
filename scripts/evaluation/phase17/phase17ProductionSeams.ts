/**
 * Phase 17 production seams, wired at the script layer.
 *
 * The evaluation subtree (lib/evaluation/forgewing) may not import serving or
 * persistence modules, so the two production pieces Phase 17 must exercise
 * unchanged are supplied from here:
 *
 *  - buildDurableRecoveryProposalV2: the pure durable proposal projection. Only
 *    the projection is imported; its sibling persistence functions are never
 *    referenced.
 *  - scheduleRecoveryCandidateV2Shadow: the Phase 16 scheduler and planner. The
 *    harness always supplies every one of its IO dependencies (register, run,
 *    persistProposal, persistOutcome, loadPriorState, budget) as in-memory
 *    evaluation sinks, and refuses to start while any database environment is
 *    configured, so no default persistence path is reachable.
 *
 * Imported only for live execution.
 */
import { scheduleRecoveryCandidateV2Shadow } from '@/lib/extraction/persistence/complianceShadow';
import { buildDurableRecoveryProposalV2 } from '@/lib/server/forgewingRecoveryProposalPersistence';
import type { Phase17DurableProjection } from '@/lib/evaluation/forgewing/phase17/phase17Execution';
import type { Phase17RecoveryScheduler } from '@/lib/evaluation/forgewing/phase17/phase17Progression';

export const phase17ProjectDurableProposal: Phase17DurableProjection = buildDurableRecoveryProposalV2;

// Structural narrowing only: the evaluation type makes every IO dependency
// required where the production signature leaves them optional.
export const phase17ScheduleRecovery: Phase17RecoveryScheduler =
  scheduleRecoveryCandidateV2Shadow as unknown as Phase17RecoveryScheduler;
