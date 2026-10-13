import { describe, expect, it } from 'vitest';
import { RecommendationOutputSchema, RecommendationResultSchema } from '../schemas/agents';
import type { RecommendationInput, RiskIndicator, SupportingDocument } from '../types';
import { documentCompletenessAgent } from './documentCompleteness';
import { identityConsistencyAgent } from './identityConsistency';
import { recommendationAgent } from './recommendation';
import { riskIndicatorAgent } from './riskIndicator';
import { executeAgent } from './types';

// ---------- Fixtures (mirror CASE-1001 in database/seed.sql) ----------

const profile = {
  customerFullName: 'Amelia Hart',
  dateOfBirth: '1988-04-12',
  residentialAddress: '12 Example Street, Sampletown, ZZ1 1AA',
};
const caseReference = { id: 'CASE-TEST', customerFullName: profile.customerFullName, productType: 'current_account' as const };

const doc = (documentType: SupportingDocument['documentType'], extra: Partial<SupportingDocument> = {}): SupportingDocument => ({
  id: 1,
  documentType,
  documentSubtype: 'fictional',
  documentReference: `FIC-${documentType}`,
  nameOnDocument: profile.customerFullName,
  addressOnDocument: documentType === 'address_proof' ? profile.residentialAddress : null,
  dateOfBirthOnDocument: documentType === 'identity_proof' ? profile.dateOfBirth : null,
  issueDate: '2026-01-01',
  expiryDate: documentType === 'identity_proof' ? '2031-01-01' : null,
  status: 'provided',
  ...extra,
});
const allDocs = [doc('identity_proof'), doc('address_proof'), doc('income_proof')];

const flag = (code: RiskIndicator['code'], severity: RiskIndicator['severity']): RiskIndicator => ({
  id: 1,
  code,
  severity,
  status: 'open',
  description: `Synthetic ${code} flag`,
  raisedAt: '2026-10-01T09:00:00.000Z',
  resolvedAt: null,
});

const failed = <N extends 'document_completeness' | 'identity_consistency' | 'risk_indicator'>(
  agentName: N,
  failureReason: 'error' | 'invalid_output' = 'error',
) => ({
  outcome: 'failed' as const,
  agentName,
  agentVersion: '1.0.0',
  attempts: 2,
  startedAt: '2026-10-12T00:00:00.000Z',
  completedAt: '2026-10-12T00:00:01.000Z',
  durationMs: 1000,
  failureReason,
  errorMessage: 'Simulated failure',
});

interface Scenario {
  documents?: SupportingDocument[];
  identityVerificationStatus?: 'verified' | 'pending' | 'failed';
  riskIndicators?: RiskIndicator[];
  fail?: 'document_completeness' | 'identity_consistency' | 'risk_indicator';
  failureReason?: 'error' | 'invalid_output';
}

// Runs the REAL agent chain (document -> identity -> risk -> recommendation),
// optionally replacing one upstream agent's result with an explicit failure.
async function recommend(s: Scenario = {}) {
  const documents = s.documents ?? allDocs;
  const document_completeness =
    s.fail === 'document_completeness'
      ? failed('document_completeness', s.failureReason)
      : await executeAgent(documentCompletenessAgent, { caseId: 'CASE-TEST', referenceDate: '2026-10-12', documents });
  const identity_consistency =
    s.fail === 'identity_consistency'
      ? failed('identity_consistency', s.failureReason)
      : await executeAgent(identityConsistencyAgent, {
          caseId: 'CASE-TEST',
          profile,
          identityVerificationStatus: s.identityVerificationStatus ?? 'verified',
          documents,
        });
  const risk_indicator =
    s.fail === 'risk_indicator'
      ? failed('risk_indicator', s.failureReason)
      : await executeAgent(riskIndicatorAgent, {
          caseId: 'CASE-TEST',
          riskIndicators: s.riskIndicators ?? [],
          upstream: { document_completeness, identity_consistency },
        });

  const input: RecommendationInput = {
    caseId: 'CASE-TEST',
    caseReference,
    checks: { document_completeness, identity_consistency, risk_indicator },
  };
  const result = await executeAgent(recommendationAgent, input);
  if (result.outcome !== 'success') throw new Error(`Expected success, got: ${result.errorMessage}`);
  expect(RecommendationResultSchema.safeParse(result).success).toBe(true);
  return result.output;
}

const summary = (o: { checkSummary: { agent: string; result: string }[] }) =>
  Object.fromEntries(o.checkSummary.map((c) => [c.agent, c.result]));

// ---------- Tests ----------

describe('Recommendation Agent', () => {
  it('approves a routine case where every check passes (CASE-1001 scenario)', async () => {
    const o = await recommend();

    expect(o.recommendation).toBe('approve');
    expect(o.ruleApplied).toBe('R4_ALL_CHECKS_PASSED_APPROVE');
    expect(summary(o)).toEqual({ document_completeness: 'pass', identity_consistency: 'pass', risk_indicator: 'pass' });
    expect(o.outstandingIssues).toEqual([]);
    expect(o.escalationReasons).toEqual([]);
    expect(o.explanation).toContain('no approval, rejection or account action has been taken');
  });

  it('refers (does not reject) when a required document is missing', async () => {
    const o = await recommend({ documents: [doc('identity_proof'), doc('address_proof')] });

    expect(o.recommendation).toBe('refer_for_manual_review');
    expect(o.ruleApplied).toBe('R3_UNRESOLVED_ISSUES_REFER');
    expect(o.escalationReasons).toContain('Document requirements are not met.');
    expect(o.outstandingIssues).toContain('Document Completeness: Required income proof has not been submitted.');
    expect(o.supportingFindings).toContainEqual(expect.objectContaining({ agent: 'document_completeness', code: 'DOCUMENT_MISSING' }));
  });

  it('refers on an identity inconsistency, citing the mismatched field (CASE-1002 scenario)', async () => {
    const o = await recommend({
      documents: [doc('identity_proof', { nameOnDocument: 'Amelia Harte' }), doc('address_proof'), doc('income_proof')],
    });

    expect(o.recommendation).toBe('refer_for_manual_review');
    expect(o.escalationReasons).toEqual([
      'Identity consistency is not established.',
      'Risk level is high and requires manual review.',
    ]);
    const mismatch = o.supportingFindings.find((f) => f.code === 'IDENTITY_FIELD_MISMATCH');
    expect(mismatch).toMatchObject({ agent: 'identity_consistency', severity: 'high' });
  });

  it('refers a high-risk case with an unresolved high flag and pending verification (CASE-1003 scenario)', async () => {
    const o = await recommend({
      identityVerificationStatus: 'pending',
      riskIndicators: [flag('WATCHLIST_NAME_SIMILARITY', 'high')],
    });

    expect(o.recommendation).toBe('refer_for_manual_review');
    expect(o.ruleApplied).toBe('R3_UNRESOLVED_ISSUES_REFER');
    expect(summary(o).risk_indicator).toBe('fail');
    expect(o.supportingFindings).toContainEqual(expect.objectContaining({ agent: 'risk_indicator', code: 'RISK_FLAG_UNRESOLVED' }));
    // Risk findings that only restate identity problems are not duplicated.
    expect(o.supportingFindings.some((f) => f.code === 'IDENTITY_INCONSISTENCY')).toBe(false);
  });

  it('rejects only under an explicit rule: failed identity verification or an unresolved critical flag', async () => {
    const failedVerification = await recommend({ identityVerificationStatus: 'failed' });
    const criticalFlag = await recommend({ riskIndicators: [flag('ADVERSE_MEDIA_MENTION', 'critical')] });

    for (const o of [failedVerification, criticalFlag]) {
      expect(o.recommendation).toBe('reject');
      expect(o.ruleApplied).toBe('R2_EXPLICIT_REJECTION');
      expect(o.escalationReasons[0]).toMatch(/^Rejection rule:/);
    }
  });

  it.each(['document_completeness', 'identity_consistency', 'risk_indicator'] as const)(
    'refers, never approves, when the %s agent failed',
    async (agent) => {
      const o = await recommend({ fail: agent });

      expect(o.recommendation).toBe('refer_for_manual_review');
      expect(o.ruleApplied).toBe('R1_INCOMPLETE_CHECKS_REFER');
      expect(summary(o)[agent]).toBe('unavailable');
      expect(o.escalationReasons[0]).toContain('cannot count as passed');
    },
  );

  it('treats invalid upstream output as incomplete, and incompleteness takes precedence over rejection', async () => {
    const invalid = await recommend({ fail: 'identity_consistency', failureReason: 'invalid_output' });
    expect(invalid.ruleApplied).toBe('R1_INCOMPLETE_CHECKS_REFER');
    expect(invalid.reasons[0]).toContain('(invalid_output)');

    const failedPlusCritical = await recommend({
      fail: 'document_completeness',
      riskIndicators: [flag('ADVERSE_MEDIA_MENTION', 'critical')],
    });
    expect(failedPlusCritical.recommendation).toBe('refer_for_manual_review');
    expect(failedPlusCritical.outstandingIssues).toContainEqual(expect.stringContaining('ADVERSE_MEDIA_MENTION'));
  });

  it('rejects input whose caseId does not match the case reference', async () => {
    const result = await executeAgent(recommendationAgent, {
      caseId: 'CASE-OTHER',
      caseReference,
      checks: { document_completeness: failed('document_completeness'), identity_consistency: failed('identity_consistency'), risk_indicator: failed('risk_indicator') },
    });
    expect(result).toMatchObject({ outcome: 'failed', failureReason: 'invalid_input' });
  });
});

describe('Recommendation output contract', () => {
  const base = {
    explanation: 'x',
    reasons: ['x'],
    supportingFindings: [],
    outstandingIssues: [],
    escalationReasons: [],
    checkSummary: [
      { agent: 'document_completeness', result: 'pass' },
      { agent: 'identity_consistency', result: 'pass' },
      { agent: 'risk_indicator', result: 'pass' },
    ],
  };

  it('accepts a consistent approve', () => {
    expect(RecommendationOutputSchema.safeParse({ ...base, recommendation: 'approve', ruleApplied: 'R4_ALL_CHECKS_PASSED_APPROVE' }).success).toBe(true);
  });

  it('rejects an approve while a check is unavailable', () => {
    const checkSummary = [...base.checkSummary.slice(0, 2), { agent: 'risk_indicator', result: 'unavailable' }];
    expect(
      RecommendationOutputSchema.safeParse({ ...base, checkSummary, recommendation: 'approve', ruleApplied: 'R4_ALL_CHECKS_PASSED_APPROVE' }).success,
    ).toBe(false);
  });

  it('rejects a reject that is not backed by an explicit rule', () => {
    expect(
      RecommendationOutputSchema.safeParse({ ...base, recommendation: 'reject', ruleApplied: 'R3_UNRESOLVED_ISSUES_REFER', escalationReasons: ['x'] }).success,
    ).toBe(false);
  });
});
