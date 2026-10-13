// Agent contracts: distinct input and output schemas for each agent.
// Check agents only ever report 'pass' or 'fail'. An agent that crashes or
// returns invalid output is represented by a separate 'failed' AgentResult,
// which the Recommendation Agent sees as an incomplete check.
import { z } from 'zod';
import {
  DocumentTypeSchema,
  IdentityVerificationStatusSchema,
  OnboardingCaseSchema,
  RiskIndicatorSchema,
  RiskSeveritySchema,
  SupportingDocumentSchema,
} from './domain';

export const AgentNameSchema = z.enum([
  'document_completeness',
  'identity_consistency',
  'risk_indicator',
  'recommendation',
]);
export const CheckAgentNameSchema = AgentNameSchema.exclude(['recommendation']);

// ---------- Findings and evidence ----------

export const FindingSeveritySchema = z.enum(['info', 'low', 'medium', 'high', 'critical']);
const BLOCKING_SEVERITIES = ['medium', 'high', 'critical'] as const;

export const EvidenceSchema = z.object({
  source: z.enum(['case', 'document', 'risk_indicator', 'agent_result']),
  field: z.string().min(1),
  observed: z.string().nullable(),
  expected: z.string().nullable().optional(),
});

export const AgentFindingSchema = z.object({
  code: z.string().min(1),
  severity: FindingSeveritySchema,
  message: z.string().min(1),
  evidence: z.array(EvidenceSchema),
});

const isBlocking = (f: z.infer<typeof AgentFindingSchema>) =>
  (BLOCKING_SEVERITIES as readonly string[]).includes(f.severity);

// Common shape for the three check agents.
const checkOutputBase = {
  status: z.enum(['pass', 'fail']),
  explanation: z.string().min(1),
  findings: z.array(AgentFindingSchema),
};

// A 'pass' that carries blocking findings is contradictory and treated as invalid output.
const passHasNoBlockingFindings = (o: { status: string; findings: z.infer<typeof AgentFindingSchema>[] }) =>
  o.status === 'fail' || !o.findings.some(isBlocking);
const passMessage = { message: "A 'pass' result cannot contain medium/high/critical findings" };

// ---------- Document Completeness Agent ----------

export const DocumentCompletenessInputSchema = z
  .object({
    caseId: z.string().min(1),
    referenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'), // "today" for expiry checks
    documents: z.array(SupportingDocumentSchema),
  })
  .refine((i) => new Set(i.documents.map((d) => d.documentType)).size === i.documents.length, {
    message: 'Each document type may appear at most once',
  });

export const DocumentCompletenessOutputSchema = z
  .object({
    ...checkOutputBase,
    missingDocumentTypes: z.array(DocumentTypeSchema), // no document submitted
    pendingVerificationDocumentTypes: z.array(DocumentTypeSchema), // present, verification outstanding
    unusableDocumentTypes: z.array(DocumentTypeSchema), // expired or unreadable
    metadataIssueDocumentTypes: z.array(DocumentTypeSchema), // incomplete or invalid metadata
  })
  .refine(passHasNoBlockingFindings, passMessage)
  .refine(
    (o) =>
      o.status === 'fail' ||
      [o.missingDocumentTypes, o.pendingVerificationDocumentTypes, o.unusableDocumentTypes, o.metadataIssueDocumentTypes]
        .every((list) => list.length === 0),
    { message: "Cannot 'pass' with missing, pending, unusable or incomplete documents" },
  );

// ---------- Identity Consistency Agent ----------

export const IdentityConsistencyInputSchema = z
  .object({
    caseId: z.string().min(1),
    profile: OnboardingCaseSchema.pick({ customerFullName: true, dateOfBirth: true, residentialAddress: true }),
    identityVerificationStatus: IdentityVerificationStatusSchema,
    documents: z.array(SupportingDocumentSchema),
  })
  .refine((i) => new Set(i.documents.map((d) => d.documentType)).size === i.documents.length, {
    message: 'Each document type may appear at most once',
  });

export const IdentityFieldSchema = z.enum(['full_name', 'date_of_birth', 'residential_address']);

// One profile-vs-document comparison. 'unavailable' means the value could not
// be compared (no document or no value) — it is never treated as a match.
export const FieldComparisonSchema = z.object({
  field: IdentityFieldSchema,
  result: z.enum(['match', 'mismatch', 'unavailable']),
  profileValue: z.string().nullable(),
  documentValue: z.string().nullable(),
  documentType: DocumentTypeSchema,
});

export const IdentityConsistencyOutputSchema = z
  .object({
    ...checkOutputBase,
    comparisons: z.array(FieldComparisonSchema),
    identityVerificationStatus: IdentityVerificationStatusSchema, // as recorded on the case, not determined here
  })
  .refine(passHasNoBlockingFindings, passMessage)
  .refine(
    (o) =>
      o.status === 'fail' ||
      (IdentityFieldSchema.options.every((f) => o.comparisons.some((c) => c.field === f)) &&
        o.comparisons.every((c) => c.result === 'match') &&
        o.identityVerificationStatus === 'verified'),
    { message: "Cannot 'pass' unless every identity field matches and recorded verification is 'verified'" },
  );

// ---------- Agent result (success vs explicit failure) ----------

export const AgentFailureReasonSchema = z.enum(['error', 'invalid_input', 'invalid_output']);

// Builds the success|failed union for one agent's output schema.
export function agentResultSchema<N extends z.ZodType, O extends z.ZodType>(agentName: N, output: O) {
  const executionMetadata = {
    agentName,
    agentVersion: z.string().min(1),
    attempts: z.number().int().min(1),
    startedAt: z.string().min(1),
    completedAt: z.string().min(1),
    durationMs: z.number().nonnegative(),
  };
  return z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('success'), ...executionMetadata, output }),
    z.object({
      outcome: z.literal('failed'),
      ...executionMetadata,
      failureReason: AgentFailureReasonSchema,
      errorMessage: z.string().min(1),
    }),
  ]);
}

export const DocumentCompletenessResultSchema = agentResultSchema(
  z.literal('document_completeness'),
  DocumentCompletenessOutputSchema,
);
export const IdentityConsistencyResultSchema = agentResultSchema(
  z.literal('identity_consistency'),
  IdentityConsistencyOutputSchema,
);
// ---------- Risk Indicator Agent ----------
// Depends on the Document and Identity results (success OR failure). It receives
// no customer profile data, so demographics cannot influence the risk level.

export const RiskLevelSchema = z.enum(['low', 'medium', 'high']);

export const RiskIndicatorInputSchema = z.object({
  caseId: z.string().min(1),
  riskIndicators: z.array(RiskIndicatorSchema),
  upstream: z.object({
    document_completeness: DocumentCompletenessResultSchema,
    identity_consistency: IdentityConsistencyResultSchema,
  }),
});

// Risk level is derived from finding severities: info/low -> low,
// medium -> medium, high/critical -> high (highest wins).
export const severityToRiskLevel = (s: z.infer<typeof FindingSeveritySchema>): z.infer<typeof RiskLevelSchema> =>
  s === 'high' || s === 'critical' ? 'high' : s === 'medium' ? 'medium' : 'low';
const RISK_ORDER = { low: 0, medium: 1, high: 2 } as const;

export const RiskIndicatorOutputSchema = z
  .object({
    ...checkOutputBase,
    riskLevel: RiskLevelSchema,
    escalationRequired: z.boolean(), // true = manual review required
    openIndicatorCount: z.number().int().nonnegative(),
    highestOpenSeverity: RiskSeveritySchema.nullable(),
  })
  .refine(passHasNoBlockingFindings, passMessage)
  .refine(
    (o) =>
      o.riskLevel ===
      o.findings.reduce<z.infer<typeof RiskLevelSchema>>((max, f) => {
        const level = severityToRiskLevel(f.severity);
        return RISK_ORDER[level] > RISK_ORDER[max] ? level : max;
      }, 'low'),
    { message: 'riskLevel must equal the highest level implied by the findings' },
  )
  .refine((o) => o.escalationRequired === (o.riskLevel !== 'low'), {
    message: 'Medium or high risk must require escalation; low risk must not',
  })
  .refine((o) => (o.status === 'pass') === (o.riskLevel === 'low'), {
    message: "Status must be 'pass' exactly when riskLevel is low",
  });

export const RiskIndicatorResultSchema = agentResultSchema(z.literal('risk_indicator'), RiskIndicatorOutputSchema);

// ---------- Recommendation Agent ----------

export const RecommendationSchema = z.enum(['approve', 'reject', 'refer_for_manual_review']);

// Receives every check result (including failed ones) plus a minimal case
// reference. Demographic fields are deliberately not passed in.
export const RecommendationInputSchema = z.object({
  caseId: z.string().min(1),
  caseReference: OnboardingCaseSchema.pick({ id: true, customerFullName: true, productType: true }),
  checks: z.object({
    document_completeness: DocumentCompletenessResultSchema,
    identity_consistency: IdentityConsistencyResultSchema,
    risk_indicator: RiskIndicatorResultSchema,
  }),
}).refine((i) => i.caseId === i.caseReference.id, { message: 'caseId must match caseReference.id' });

// Which rule produced the recommendation (evaluated in this order).
export const RecommendationRuleSchema = z.enum([
  'R1_INCOMPLETE_CHECKS_REFER', // any upstream agent failed -> refer
  'R2_EXPLICIT_REJECTION', // defined business rule met -> reject
  'R3_UNRESOLVED_ISSUES_REFER', // any check failed or risk escalated -> refer
  'R4_ALL_CHECKS_PASSED_APPROVE', // everything passed, low risk -> approve
  'SUPERVISOR_SAFETY_OVERRIDE', // supervisor downgraded an unsafe 'approve' -> refer
]);

export const CheckSummarySchema = z.object({
  agent: CheckAgentNameSchema,
  result: z.enum(['pass', 'fail', 'unavailable']), // 'unavailable' = agent failed; never a pass
});

export const AttributedFindingSchema = AgentFindingSchema.extend({ agent: CheckAgentNameSchema });

export const RecommendationOutputSchema = z
  .object({
    recommendation: RecommendationSchema,
    ruleApplied: RecommendationRuleSchema,
    explanation: z.string().min(1),
    reasons: z.array(z.string().min(1)).min(1),
    checkSummary: z.array(CheckSummarySchema).length(3),
    supportingFindings: z.array(AttributedFindingSchema),
    outstandingIssues: z.array(z.string().min(1)),
    escalationReasons: z.array(z.string().min(1)),
  })
  .refine((o) => new Set(o.checkSummary.map((c) => c.agent)).size === 3, {
    message: 'checkSummary must cover all three checks',
  })
  .refine(
    (o) =>
      o.recommendation !== 'approve' ||
      (o.ruleApplied === 'R4_ALL_CHECKS_PASSED_APPROVE' &&
        o.checkSummary.every((c) => c.result === 'pass') &&
        o.outstandingIssues.length === 0 &&
        o.escalationReasons.length === 0 &&
        !o.supportingFindings.some(isBlocking)),
    { message: "'approve' requires every check to pass with no outstanding issues or blocking findings" },
  )
  .refine((o) => o.recommendation === 'approve' || o.escalationReasons.length > 0, {
    message: 'A non-approve recommendation must state its escalation reasons',
  })
  .refine((o) => o.recommendation !== 'reject' || o.ruleApplied === 'R2_EXPLICIT_REJECTION', {
    message: "'reject' requires an explicit rejection rule",
  });

export const RecommendationResultSchema = agentResultSchema(
  z.literal('recommendation'),
  RecommendationOutputSchema,
);
