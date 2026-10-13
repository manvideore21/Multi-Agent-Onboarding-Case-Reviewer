import { describe, expect, it } from 'vitest';
import { RiskIndicatorOutputSchema, RiskIndicatorResultSchema } from '../schemas/agents';
import type { RiskIndicator, RiskIndicatorInput, SupportingDocument } from '../types';
import { documentCompletenessAgent } from './documentCompleteness';
import { identityConsistencyAgent } from './identityConsistency';
import { riskIndicatorAgent } from './riskIndicator';
import { executeAgent } from './types';

// ---------- Fixtures (mirror CASE-1001 in database/seed.sql) ----------

const profile = {
  customerFullName: 'Amelia Hart',
  dateOfBirth: '1988-04-12',
  residentialAddress: '12 Example Street, Sampletown, ZZ1 1AA',
};
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

const flag = (code: RiskIndicator['code'], severity: RiskIndicator['severity'], status: RiskIndicator['status'] = 'open'): RiskIndicator => ({
  id: 1,
  code,
  severity,
  status,
  description: `Synthetic ${code} flag`,
  raisedAt: '2026-10-01T09:00:00.000Z',
  resolvedAt: status === 'open' ? null : '2026-10-01T10:00:00.000Z',
});

// Runs the REAL upstream agents so the hand-off is exercised end to end.
async function upstreamFrom(documents: SupportingDocument[], identityVerificationStatus: 'verified' | 'pending' | 'failed' = 'verified') {
  const document_completeness = await executeAgent(documentCompletenessAgent, {
    caseId: 'CASE-TEST',
    referenceDate: '2026-10-12',
    documents,
  });
  const identity_consistency = await executeAgent(identityConsistencyAgent, {
    caseId: 'CASE-TEST',
    profile,
    identityVerificationStatus,
    documents,
  });
  return { document_completeness, identity_consistency };
}

const failedUpstream = <N extends 'document_completeness' | 'identity_consistency'>(agentName: N) => ({
  outcome: 'failed' as const,
  agentName,
  agentVersion: '1.0.0',
  attempts: 2,
  startedAt: '2026-10-12T00:00:00.000Z',
  completedAt: '2026-10-12T00:00:01.000Z',
  durationMs: 1000,
  failureReason: 'error' as const,
  errorMessage: 'Simulated outage',
});

async function assess(riskIndicators: RiskIndicator[], upstream: RiskIndicatorInput['upstream']) {
  const result = await executeAgent(riskIndicatorAgent, { caseId: 'CASE-TEST', riskIndicators, upstream });
  if (result.outcome !== 'success') throw new Error(`Expected success, got: ${result.errorMessage}`);
  expect(RiskIndicatorResultSchema.safeParse(result).success).toBe(true);
  return result.output;
}

const codes = (output: { findings: { code: string }[] }) => output.findings.map((f) => f.code);

// ---------- Tests ----------

describe('Risk Indicator Agent', () => {
  it('LOW: clean upstream checks and only a resolved flag (CASE-1001 scenario)', async () => {
    const output = await assess([flag('ADDRESS_RECENTLY_CHANGED', 'low', 'resolved')], await upstreamFrom(allDocs));

    expect(output).toMatchObject({ status: 'pass', riskLevel: 'low', escalationRequired: false, openIndicatorCount: 0 });
    expect(codes(output)).toEqual(['RISK_FLAGS_CLOSED', 'UPSTREAM_CHECK_PASSED', 'UPSTREAM_CHECK_PASSED']);
    expect(output.explanation).toContain('no real fraud detection, sanctions screening or compliance check');
  });

  it('LOW: an open low-severity flag is noted but does not escalate', async () => {
    const output = await assess([flag('ADDRESS_RECENTLY_CHANGED', 'low')], await upstreamFrom(allDocs));

    expect(output).toMatchObject({ riskLevel: 'low', escalationRequired: false, highestOpenSeverity: 'low' });
    expect(output.explanation).toContain('open low-severity flags noted: ADDRESS_RECENTLY_CHANGED');
  });

  it('MEDIUM: a missing required document requires manual review', async () => {
    const output = await assess([], await upstreamFrom([doc('identity_proof'), doc('address_proof')]));

    expect(output).toMatchObject({ status: 'fail', riskLevel: 'medium', escalationRequired: true });
    const finding = output.findings.find((f) => f.code === 'DOCUMENT_REQUIREMENT_UNMET');
    expect(finding?.severity).toBe('medium');
    expect(finding?.evidence[0]).toEqual({ source: 'agent_result', field: 'document_completeness.findings', observed: 'DOCUMENT_MISSING' });
  });

  it('MEDIUM: an unresolved medium-severity flag requires manual review', async () => {
    const output = await assess([flag('INCOME_OCCUPATION_MISMATCH', 'medium')], await upstreamFrom(allDocs));

    expect(output).toMatchObject({ riskLevel: 'medium', escalationRequired: true, highestOpenSeverity: 'medium' });
  });

  it('HIGH: unresolved high-severity flag plus pending identity verification (CASE-1003 scenario)', async () => {
    const output = await assess([flag('WATCHLIST_NAME_SIMILARITY', 'high')], await upstreamFrom(allDocs, 'pending'));

    expect(output).toMatchObject({ status: 'fail', riskLevel: 'high', escalationRequired: true, highestOpenSeverity: 'high' });
    expect(codes(output)).toEqual(['RISK_FLAG_UNRESOLVED', 'UPSTREAM_CHECK_PASSED', 'IDENTITY_INCONSISTENCY']);
    expect(output.findings[0]?.message).toContain('must be investigated');
    expect(output.explanation).toContain('unresolved high-severity flag WATCHLIST_NAME_SIMILARITY');
  });

  it('HIGH: an identity name mismatch is surfaced explicitly with upstream evidence (CASE-1002 scenario)', async () => {
    const docs = [doc('identity_proof', { nameOnDocument: 'Amelia Harte' }), doc('address_proof')];
    const output = await assess([], await upstreamFrom(docs));

    expect(output.riskLevel).toBe('high');
    const identity = output.findings.find((f) => f.code === 'IDENTITY_INCONSISTENCY');
    expect(identity?.severity).toBe('high');
    expect(identity?.evidence).toContainEqual({
      source: 'document',
      field: 'identity_proof.full_name',
      observed: 'Amelia Harte',
      expected: 'Amelia Hart',
    });
    expect(codes(output)).toContain('DOCUMENT_REQUIREMENT_UNMET'); // income proof also missing
  });

  it('INCOMPLETE: a failed upstream check is escalated as high, never treated as passed', async () => {
    const upstream = await upstreamFrom(allDocs);
    const output = await assess([], { ...upstream, document_completeness: failedUpstream('document_completeness') });

    expect(output).toMatchObject({ status: 'fail', riskLevel: 'high', escalationRequired: true });
    expect(codes(output)).toEqual(['UPSTREAM_CHECK_UNAVAILABLE', 'UPSTREAM_CHECK_PASSED']);
    expect(output.explanation).toContain('Document Completeness check unavailable');

    const bothFailed = await assess([], {
      document_completeness: failedUpstream('document_completeness'),
      identity_consistency: failedUpstream('identity_consistency'),
    });
    expect(bothFailed.riskLevel).toBe('high');
    expect(codes(bothFailed).filter((c) => c === 'UPSTREAM_CHECK_UNAVAILABLE')).toHaveLength(2);
  });

  it('INCOMPLETE: input without upstream results is rejected as invalid input', async () => {
    const result = await executeAgent(riskIndicatorAgent, { caseId: 'CASE-TEST', riskIndicators: [] });
    expect(result).toMatchObject({ outcome: 'failed', failureReason: 'invalid_input' });
  });

  it('ignores customer demographics even if they are passed in', async () => {
    const upstream = await upstreamFrom(allDocs);
    const base = { caseId: 'CASE-TEST', riskIndicators: [], upstream };
    const a = await executeAgent(riskIndicatorAgent, { ...base, nationality: 'Fictlandia', dateOfBirth: '1950-01-01' });
    const b = await executeAgent(riskIndicatorAgent, { ...base, nationality: 'Imaginaria', dateOfBirth: '2005-01-01' });

    expect(a.outcome === 'success' && b.outcome === 'success').toBe(true);
    if (a.outcome === 'success' && b.outcome === 'success') expect(a.output).toEqual(b.output);
  });
});

describe('Risk output contract', () => {
  const highFinding = { code: 'RISK_FLAG_UNRESOLVED', severity: 'high' as const, message: 'x', evidence: [] };
  const base = { explanation: 'x', openIndicatorCount: 1, highestOpenSeverity: 'high' as const };

  it('rejects a risk level lower than the findings imply', () => {
    const r = RiskIndicatorOutputSchema.safeParse({ ...base, status: 'fail', findings: [highFinding], riskLevel: 'medium', escalationRequired: true });
    expect(r.success).toBe(false);
  });

  it('rejects high risk without escalation', () => {
    const r = RiskIndicatorOutputSchema.safeParse({ ...base, status: 'fail', findings: [highFinding], riskLevel: 'high', escalationRequired: false });
    expect(r.success).toBe(false);
  });
});
