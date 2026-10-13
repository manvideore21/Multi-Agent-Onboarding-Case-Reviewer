// Pure supervisor policies: an independent safety guard over the
// recommendation, and the autonomy-mode rules that set the workflow status.
import { RecommendationOutputSchema } from '../schemas/agents';
import type {
  AutonomyMode,
  CheckAgentName,
  CheckSummary,
  FinalOutcome,
  OutcomeSource,
  RecommendationInput,
  RecommendationOutput,
  WorkflowState,
} from '../types';

const CHECKS: CheckAgentName[] = ['document_completeness', 'identity_consistency', 'risk_indicator'];

export interface SafetyGuardResult {
  recommendation: RecommendationOutput;
  overridden: boolean;
  problems: string[];
}

// Re-checks an 'approve' against the ACTUAL check results, independently of the
// Recommendation Agent. Any incomplete or failing check downgrades it to a referral.
export function safetyGuard(rec: RecommendationOutput, checks: RecommendationInput['checks']): SafetyGuardResult {
  if (rec.recommendation !== 'approve') return { recommendation: rec, overridden: false, problems: [] };

  const problems: string[] = [];
  const checkSummary: CheckSummary[] = CHECKS.map((agent) => {
    const r = checks[agent];
    if (r.outcome !== 'success') {
      problems.push(`${agent} check is unavailable (${r.failureReason}).`);
      return { agent, result: 'unavailable' };
    }
    if (r.output.status !== 'pass') problems.push(`${agent} check did not pass.`);
    return { agent, result: r.output.status };
  });
  const risk = checks.risk_indicator;
  if (risk.outcome === 'success' && risk.output.escalationRequired) {
    problems.push(`risk level ${risk.output.riskLevel} requires escalation.`);
  }
  if (problems.length === 0) return { recommendation: rec, overridden: false, problems };

  const reasons = problems.map((p) => `Supervisor safety guard: ${p}`);
  const overridden = RecommendationOutputSchema.parse({
    ...rec,
    recommendation: 'refer_for_manual_review',
    ruleApplied: 'SUPERVISOR_SAFETY_OVERRIDE',
    explanation: `Recommendation: REFER FOR MANUAL REVIEW. The supervisor overrode an 'approve' recommendation that was inconsistent with the check results. ${reasons.join(' ')} This is a recommendation only; no approval, rejection or account action has been taken.`,
    reasons,
    checkSummary,
    outstandingIssues: [...reasons, ...rec.outstandingIssues],
    escalationReasons: reasons,
  });
  return { recommendation: overridden, overridden: true, problems };
}

export interface AutonomyDecision {
  status: WorkflowState;
  finalOutcome: FinalOutcome | null;
  outcomeSource: OutcomeSource | null;
  reason: string;
}

// Sets the workflow status from the (guarded) recommendation. Never records a
// human decision. Only a clean R4 'approve' in exception-only mode progresses
// automatically.
export function applyAutonomy(mode: AutonomyMode, rec: RecommendationOutput): AutonomyDecision {
  if (mode === 'human_approval_required') {
    return {
      status: 'needs_human_approval',
      finalOutcome: null,
      outcomeSource: null,
      reason: 'Human approval mode: a reviewer must record a decision before the case can progress.',
    };
  }
  if (rec.recommendation === 'approve' && rec.ruleApplied === 'R4_ALL_CHECKS_PASSED_APPROVE') {
    return {
      status: 'completed',
      finalOutcome: 'approved',
      outcomeSource: 'auto_policy',
      reason: 'Exception-only mode: all checks passed with low risk, so the case progressed automatically under policy.',
    };
  }
  return {
    status: 'needs_manual_review',
    finalOutcome: null,
    outcomeSource: null,
    reason: `Exception-only mode: '${rec.recommendation}' is an exception and requires manual review.`,
  };
}
