// Risk Indicator Agent — transparent, rule-based assessment of PREDEFINED,
// synthetic risk flags plus the outcomes of the Document and Identity checks.
// It receives no customer demographics. It does not perform real fraud
// detection, sanctions screening or any regulatory compliance check.
//
// Rules (each produces a finding; risk level = highest level implied):
//   Open risk flag                    -> finding with the flag's own severity
//   Resolved / dismissed flag         -> info only, not counted
//   Upstream check failed/unavailable -> high   (never treated as passed)
//   Document requirement unmet        -> medium (manual review required)
//   Identity inconsistency            -> high for high/critical upstream findings, else medium
//   Severity -> level: info/low = low, medium = medium, high/critical = high
//   Escalation (manual review) is required for medium or high risk.
import { RiskIndicatorInputSchema, RiskIndicatorOutputSchema, severityToRiskLevel } from '../schemas/agents';
import type { z } from 'zod';
import type { RiskIndicatorCodeSchema } from '../schemas/domain';
import type { AgentFinding, RiskIndicatorInput, RiskIndicatorOutput, RiskLevel, RiskSeverity } from '../types';
import type { Agent } from './types';

const SIGNIFICANCE: Record<z.infer<typeof RiskIndicatorCodeSchema>, string> = {
  WATCHLIST_NAME_SIMILARITY:
    'the name resembles an entry on a fictional watchlist and must be investigated before onboarding can proceed',
  HIGH_RISK_JURISDICTION: 'the case is linked to a jurisdiction on a predefined fictional high-risk list',
  INCOME_OCCUPATION_MISMATCH: 'declared income is inconsistent with the declared occupation under a predefined rule',
  ADVERSE_MEDIA_MENTION: 'a fictional adverse media record is linked to the case',
  ADDRESS_RECENTLY_CHANGED: 'the address changed recently; usually minor when address proof is consistent',
};

const AGENT_LABELS = { document_completeness: 'Document Completeness', identity_consistency: 'Identity Consistency' };

const DISCLAIMER =
  'Synthetic, rule-based assessment of predefined flags only; no real fraud detection, sanctions screening or compliance check is performed.';

const LEVEL_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
const SEVERITY_ORDER: Record<RiskSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const isBlocking = (f: AgentFinding) => f.severity === 'medium' || f.severity === 'high' || f.severity === 'critical';

function evaluate(input: RiskIndicatorInput): RiskIndicatorOutput {
  const findings: AgentFinding[] = [];
  const factors: string[] = [];

  // 1. Predefined risk flags.
  const open = input.riskIndicators.filter((r) => r.status === 'open');
  const closed = input.riskIndicators.filter((r) => r.status !== 'open');

  for (const flag of open) {
    findings.push({
      code: 'RISK_FLAG_UNRESOLVED',
      severity: flag.severity,
      message: `Unresolved ${flag.severity}-severity flag ${flag.code}: ${SIGNIFICANCE[flag.code]}.`,
      evidence: [
        { source: 'risk_indicator', field: `${flag.code}.status`, observed: flag.status, expected: 'resolved or dismissed' },
        { source: 'risk_indicator', field: `${flag.code}.severity`, observed: flag.severity },
        { source: 'risk_indicator', field: `${flag.code}.description`, observed: flag.description },
      ],
    });
    factors.push(`unresolved ${flag.severity}-severity flag ${flag.code}`);
  }
  if (closed.length > 0) {
    findings.push({
      code: 'RISK_FLAGS_CLOSED',
      severity: 'info',
      message: `${closed.length} flag(s) already resolved or dismissed and not counted: ${closed.map((r) => r.code).join(', ')}.`,
      evidence: closed.map((r) => ({ source: 'risk_indicator' as const, field: `${r.code}.status`, observed: r.status })),
    });
  }

  // 2. Upstream checks. A failed agent is never treated as a passed check.
  for (const agent of ['document_completeness', 'identity_consistency'] as const) {
    const result = input.upstream[agent];
    const label = AGENT_LABELS[agent];

    if (result.outcome === 'failed') {
      findings.push({
        code: 'UPSTREAM_CHECK_UNAVAILABLE',
        severity: 'high',
        message: `The ${label} check did not complete (${result.failureReason}); it cannot be treated as passed, so risk cannot be assessed below high.`,
        evidence: [
          { source: 'agent_result', field: `${agent}.outcome`, observed: 'failed', expected: 'success' },
          { source: 'agent_result', field: `${agent}.errorMessage`, observed: result.errorMessage },
        ],
      });
      factors.push(`${label} check unavailable`);
      continue;
    }

    if (result.output.status === 'pass') {
      findings.push({
        code: 'UPSTREAM_CHECK_PASSED',
        severity: 'info',
        message: `The ${label} check passed.`,
        evidence: [{ source: 'agent_result', field: `${agent}.status`, observed: 'pass' }],
      });
      continue;
    }

    const blocking = result.output.findings.filter(isBlocking);
    if (blocking.length === 0) {
      // A 'fail' is never downgraded to a pass, even without detailed findings.
      findings.push({
        code: 'UPSTREAM_CHECK_FAILED',
        severity: 'medium',
        message: `The ${label} check failed: ${result.output.explanation} Manual review required.`,
        evidence: [{ source: 'agent_result', field: `${agent}.status`, observed: 'fail', expected: 'pass' }],
      });
      factors.push(`${label} check failed`);
      continue;
    }

    for (const f of blocking) {
      const isIdentity = agent === 'identity_consistency';
      const severity = isIdentity && (f.severity === 'high' || f.severity === 'critical') ? 'high' : 'medium';
      findings.push({
        code: isIdentity ? 'IDENTITY_INCONSISTENCY' : 'DOCUMENT_REQUIREMENT_UNMET',
        severity,
        message: `${label}: ${f.message} Manual review required.`,
        evidence: [{ source: 'agent_result', field: `${agent}.findings`, observed: f.code }, ...f.evidence],
      });
      factors.push(`${isIdentity ? 'identity inconsistency' : 'document issue'} (${f.code})`);
    }
  }

  // 3. Derive the level from the findings (the output schema re-checks this).
  const riskLevel = findings
    .map((f) => severityToRiskLevel(f.severity))
    .reduce<RiskLevel>((max, l) => (LEVEL_ORDER[l] > LEVEL_ORDER[max] ? l : max), 'low');
  const escalationRequired = riskLevel !== 'low';

  const highestOpenSeverity = open.reduce<RiskSeverity | null>(
    (max, r) => (max === null || SEVERITY_ORDER[r.severity] > SEVERITY_ORDER[max] ? r.severity : max),
    null,
  );

  const lowFlags = open.filter((r) => r.severity === 'low').map((r) => r.code);
  const explanation = escalationRequired
    ? `Risk level ${riskLevel.toUpperCase()}: manual review required. Factors: ${factors.join('; ')}. ${DISCLAIMER}`
    : `Risk level LOW: no unresolved medium or higher flags and both upstream checks passed${
        lowFlags.length ? ` (open low-severity flags noted: ${lowFlags.join(', ')})` : ''
      }. ${DISCLAIMER}`;

  return {
    status: escalationRequired ? 'fail' : 'pass',
    explanation,
    findings,
    riskLevel,
    escalationRequired,
    openIndicatorCount: open.length,
    highestOpenSeverity,
  };
}

export const riskIndicatorAgent: Agent<'risk_indicator', RiskIndicatorInput, RiskIndicatorOutput> = {
  name: 'risk_indicator',
  version: '1.0.0',
  inputSchema: RiskIndicatorInputSchema,
  outputSchema: RiskIndicatorOutputSchema,
  run: async (input) => evaluate(input),
};
