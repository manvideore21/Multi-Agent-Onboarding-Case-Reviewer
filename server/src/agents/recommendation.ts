// Recommendation Agent — combines the three check results into ONE
// recommendation. It recommends only; it never approves, rejects or takes any
// action on the case.
//
// Rules, evaluated in order (first match wins):
//   R1  Any upstream agent failed / produced invalid output   -> refer_for_manual_review
//   R2  Explicit rejection rule met on completed checks:
//         - recorded identity verification status is 'failed'
//         - an unresolved CRITICAL-severity risk flag exists   -> reject
//   R3  Any check failed or risk escalation required          -> refer_for_manual_review
//   R4  All three checks passed and risk level is low         -> approve
// Missing information alone never leads to rejection (it is R1 or R3).
import { RecommendationInputSchema, RecommendationOutputSchema } from '../schemas/agents';
import type {
  AttributedFinding,
  CheckAgentName,
  CheckSummary,
  RecommendationInput,
  RecommendationOutput,
} from '../types';
import type { Agent } from './types';

const LABELS: Record<CheckAgentName, string> = {
  document_completeness: 'Document Completeness',
  identity_consistency: 'Identity Consistency',
  risk_indicator: 'Risk Indicator',
};
const CHECK_ORDER: CheckAgentName[] = ['document_completeness', 'identity_consistency', 'risk_indicator'];
const NOTE = 'This is a recommendation only; no approval, rejection or account action has been taken.';

const isBlocking = (f: { severity: string }) => f.severity === 'medium' || f.severity === 'high' || f.severity === 'critical';

function evaluate(input: RecommendationInput): RecommendationOutput {
  const { checks } = input;

  const checkSummary: CheckSummary[] = CHECK_ORDER.map((agent) => {
    const r = checks[agent];
    return { agent, result: r.outcome === 'failed' ? 'unavailable' : r.output.status };
  });

  // Findings from completed checks. Risk findings that merely restate document /
  // identity problems are skipped to avoid duplicates; its own flags are kept.
  const allFindings: AttributedFinding[] = [];
  for (const agent of CHECK_ORDER) {
    const r = checks[agent];
    if (r.outcome !== 'success') continue;
    for (const f of r.output.findings) {
      if (agent === 'risk_indicator' && f.code !== 'RISK_FLAG_UNRESOLVED') continue;
      allFindings.push({ ...f, agent });
    }
  }
  const blockingFindings = allFindings.filter(isBlocking);
  const outstandingIssues = blockingFindings.map((f) => `${LABELS[f.agent]}: ${f.message}`);

  const result = (
    recommendation: RecommendationOutput['recommendation'],
    ruleApplied: RecommendationOutput['ruleApplied'],
    reasons: string[],
    escalationReasons: string[],
    issues: string[],
  ): RecommendationOutput => ({
    recommendation,
    ruleApplied,
    explanation: `${headline(recommendation)} ${reasons.join(' ')} ${NOTE}`,
    reasons,
    checkSummary,
    supportingFindings: blockingFindings.length > 0 ? blockingFindings : allFindings,
    outstandingIssues: issues,
    escalationReasons,
  });

  // R1 — incomplete checks.
  const unavailable = CHECK_ORDER.filter((a) => checks[a].outcome === 'failed');
  if (unavailable.length > 0) {
    const reasons = unavailable.map((a) => {
      const r = checks[a];
      const why = r.outcome === 'failed' ? r.failureReason : 'unknown';
      return `The ${LABELS[a]} check did not complete (${why}), so it cannot count as passed.`;
    });
    const incompleteIssues = unavailable.map((a) => `${LABELS[a]}: check must be completed or performed manually.`);
    return result('refer_for_manual_review', 'R1_INCOMPLETE_CHECKS_REFER', reasons, reasons, [...incompleteIssues, ...outstandingIssues]);
  }

  // From here every check completed (narrowed explicitly for the type checker).
  const doc = checks.document_completeness;
  const identity = checks.identity_consistency;
  const risk = checks.risk_indicator;
  if (doc.outcome !== 'success' || identity.outcome !== 'success' || risk.outcome !== 'success') {
    throw new Error('Unreachable: incomplete checks are handled by R1');
  }

  // R2 — explicit rejection rules.
  const rejectionReasons: string[] = [];
  if (identity.output.identityVerificationStatus === 'failed') {
    rejectionReasons.push('Rejection rule: the recorded identity verification status is failed.');
  }
  const criticalFlags = risk.output.findings.filter((f) => f.code === 'RISK_FLAG_UNRESOLVED' && f.severity === 'critical');
  if (criticalFlags.length > 0) {
    rejectionReasons.push(`Rejection rule: ${criticalFlags.length} unresolved critical-severity risk flag(s) present.`);
  }
  if (rejectionReasons.length > 0) {
    return result('reject', 'R2_EXPLICIT_REJECTION', rejectionReasons, rejectionReasons, outstandingIssues);
  }

  // R3 — unresolved issues.
  const escalation: string[] = [];
  if (doc.output.status === 'fail') escalation.push('Document requirements are not met.');
  if (identity.output.status === 'fail') escalation.push('Identity consistency is not established.');
  if (risk.output.escalationRequired || risk.output.status === 'fail') {
    escalation.push(`Risk level is ${risk.output.riskLevel} and requires manual review.`);
  }
  if (escalation.length > 0 || blockingFindings.length > 0) {
    if (escalation.length === 0) escalation.push('Blocking findings remain unresolved.');
    return result('refer_for_manual_review', 'R3_UNRESOLVED_ISSUES_REFER', escalation, escalation, outstandingIssues);
  }

  // R4 — approve.
  return result(
    'approve',
    'R4_ALL_CHECKS_PASSED_APPROVE',
    [`All three checks passed for ${input.caseReference.id} and the assessed risk level is low.`],
    [],
    [],
  );
}

function headline(r: RecommendationOutput['recommendation']): string {
  if (r === 'approve') return 'Recommendation: APPROVE.';
  if (r === 'reject') return 'Recommendation: REJECT (requires human confirmation).';
  return 'Recommendation: REFER FOR MANUAL REVIEW.';
}

export const recommendationAgent: Agent<'recommendation', RecommendationInput, RecommendationOutput> = {
  name: 'recommendation',
  version: '1.0.0',
  inputSchema: RecommendationInputSchema,
  outputSchema: RecommendationOutputSchema,
  run: async (input) => evaluate(input),
};
