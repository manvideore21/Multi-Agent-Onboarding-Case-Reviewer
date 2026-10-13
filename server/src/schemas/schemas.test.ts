import { describe, expect, it } from 'vitest';
import {
  DocumentCompletenessOutputSchema,
  IdentityConsistencyOutputSchema,
  RecommendationInputSchema,
  RecommendationOutputSchema,
  RiskIndicatorOutputSchema,
} from './agents';
import { HumanDecisionRequestSchema, RunWorkflowRequestSchema, WorkflowExecutionSchema } from './workflow';

const blockingFinding = {
  code: 'MISSING_DOCUMENT',
  severity: 'high' as const,
  message: 'income_proof is missing',
  evidence: [{ source: 'document' as const, field: 'income_proof', observed: null, expected: 'provided' }],
};

describe('check agent outputs reject contradictory "pass" results', () => {
  it('rejects a document "pass" that still lists missing documents', () => {
    const result = DocumentCompletenessOutputSchema.safeParse({
      status: 'pass',
      explanation: 'All good',
      findings: [],
      missingDocumentTypes: ['income_proof'],
      pendingVerificationDocumentTypes: [],
      unusableDocumentTypes: [],
      metadataIssueDocumentTypes: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects any "pass" carrying a blocking finding', () => {
    const result = RiskIndicatorOutputSchema.safeParse({
      status: 'pass',
      explanation: 'No risk',
      findings: [blockingFinding],
      riskLevel: 'high',
      escalationRequired: true,
      openIndicatorCount: 0,
      highestOpenSeverity: null,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an identity "pass" while verification is pending', () => {
    const result = IdentityConsistencyOutputSchema.safeParse({
      status: 'pass',
      explanation: 'Consistent',
      findings: [],
      comparisons: [
        { field: 'full_name', result: 'match', profileValue: 'A', documentValue: 'A', documentType: 'identity_proof' },
        { field: 'date_of_birth', result: 'match', profileValue: '1988-04-12', documentValue: '1988-04-12', documentType: 'identity_proof' },
        { field: 'residential_address', result: 'match', profileValue: 'X', documentValue: 'X', documentType: 'address_proof' },
      ],
      identityVerificationStatus: 'pending',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a consistent "fail" result', () => {
    const result = DocumentCompletenessOutputSchema.safeParse({
      status: 'fail',
      explanation: 'Income proof missing',
      findings: [blockingFinding],
      missingDocumentTypes: ['income_proof'],
      pendingVerificationDocumentTypes: [],
      unusableDocumentTypes: [],
      metadataIssueDocumentTypes: [],
    });
    expect(result.success).toBe(true);
  });
});

describe('agent failures are explicit', () => {
  const executionMetadata = {
    agentVersion: '1.0.0',
    attempts: 1,
    startedAt: '2026-10-12T00:00:00.000Z',
    completedAt: '2026-10-12T00:00:00.005Z',
    durationMs: 5,
  };
  const passingRisk = {
    outcome: 'success',
    agentName: 'risk_indicator',
    ...executionMetadata,
    output: {
      status: 'pass',
      explanation: 'No open risks',
      findings: [],
      riskLevel: 'low',
      escalationRequired: false,
      openIndicatorCount: 0,
      highestOpenSeverity: null,
    },
  };
  const passingIdentity = {
    outcome: 'success',
    agentName: 'identity_consistency',
    ...executionMetadata,
    output: {
      status: 'pass',
      explanation: 'Consistent',
      findings: [],
      comparisons: [
        { field: 'full_name', result: 'match', profileValue: 'A', documentValue: 'A', documentType: 'identity_proof' },
        { field: 'date_of_birth', result: 'match', profileValue: '1988-04-12', documentValue: '1988-04-12', documentType: 'identity_proof' },
        { field: 'residential_address', result: 'match', profileValue: 'X', documentValue: 'X', documentType: 'address_proof' },
      ],
      identityVerificationStatus: 'verified',
    },
  };

  it('accepts a failed check as a distinct "failed" outcome without output', () => {
    const result = RecommendationInputSchema.safeParse({
      caseId: 'CASE-1001',
      caseReference: { id: 'CASE-1001', customerFullName: 'Amelia Hart', productType: 'current_account' },
      checks: {
        document_completeness: {
          outcome: 'failed',
          agentName: 'document_completeness',
          ...executionMetadata,
          failureReason: 'error',
          errorMessage: 'Simulated failure',
        },
        identity_consistency: passingIdentity,
        risk_indicator: passingRisk,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.checks.document_completeness.outcome).toBe('failed');
      expect('output' in result.data.checks.document_completeness).toBe(false);
    }
  });

  it('rejects recommendation input with a check missing entirely', () => {
    const result = RecommendationInputSchema.safeParse({
      caseId: 'CASE-1001',
      caseReference: { id: 'CASE-1001', customerFullName: 'Amelia Hart', productType: 'current_account' },
      checks: { identity_consistency: passingIdentity, risk_indicator: passingRisk },
    });
    expect(result.success).toBe(false);
  });
});

describe('recommendation and workflow safety invariants', () => {
  const allPass = [
    { agent: 'document_completeness', result: 'pass' },
    { agent: 'identity_consistency', result: 'pass' },
    { agent: 'risk_indicator', result: 'pass' },
  ];
  const approveRec = {
    recommendation: 'approve',
    ruleApplied: 'R4_ALL_CHECKS_PASSED_APPROVE',
    explanation: 'All checks passed',
    reasons: ['All checks passed'],
    checkSummary: allPass,
    supportingFindings: [],
    outstandingIssues: [],
    escalationReasons: [],
  };
  const referRec = {
    ...approveRec,
    recommendation: 'refer_for_manual_review',
    ruleApplied: 'R3_UNRESOLVED_ISSUES_REFER',
    reasons: ['Risk open'],
    escalationReasons: ['Risk open'],
  };

  it('rejects "approve" with blocking findings', () => {
    const result = RecommendationOutputSchema.safeParse({
      ...approveRec,
      supportingFindings: [{ ...blockingFinding, agent: 'document_completeness' }],
    });
    expect(result.success).toBe(false);
  });

  const baseExecution = {
    id: 'wf-1',
    caseId: 'CASE-1003',
    autonomyMode: 'exception_only',
    status: 'completed',
    recommendation: referRec,
    finalOutcome: 'approved',
    outcomeSource: 'auto_policy',
    errorMessage: null,
    startedAt: '2026-10-12T00:00:00Z',
    completedAt: '2026-10-12T00:00:01Z',
    agentAttempts: [],
    auditEvents: [],
    humanDecision: null,
  };

  it('rejects an automatic approval when the recommendation was not "approve"', () => {
    expect(WorkflowExecutionSchema.safeParse(baseExecution).success).toBe(false);
  });

  it('rejects an automatic approval in human_approval_required mode', () => {
    const execution = {
      ...baseExecution,
      autonomyMode: 'human_approval_required',
      recommendation: approveRec,
    };
    expect(WorkflowExecutionSchema.safeParse(execution).success).toBe(false);
  });

  it('accepts an automatic approval of a clean case in exception_only mode', () => {
    const execution = {
      ...baseExecution,
      recommendation: approveRec,
    };
    expect(WorkflowExecutionSchema.safeParse(execution).success).toBe(true);
  });

  it('rejects a human outcome without a recorded human decision', () => {
    const execution = { ...baseExecution, outcomeSource: 'human' };
    expect(WorkflowExecutionSchema.safeParse(execution).success).toBe(false);
  });
});

describe('API request bodies', () => {
  it('rejects an unknown autonomy mode', () => {
    expect(RunWorkflowRequestSchema.safeParse({ autonomyMode: 'fully_automatic' }).success).toBe(false);
  });

  it('rejects a blank reviewer name after trimming', () => {
    expect(HumanDecisionRequestSchema.safeParse({ decision: 'approved', reviewerName: '   ' }).success).toBe(false);
  });
});
