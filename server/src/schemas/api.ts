// HTTP-boundary schemas: path parameters and request bodies not covered elsewhere.
// (RunWorkflowRequestSchema and HumanDecisionRequestSchema live in workflow.ts.)
import { z } from 'zod';
import {
  IdentityVerificationStatusSchema,
  OnboardingCaseSchema,
  RiskIndicatorCodeSchema,
  RiskIndicatorStatusSchema,
  RiskSeveritySchema,
  SupportingDocumentSchema,
} from './domain';

export const CaseIdParamSchema = z.object({ id: z.string().regex(/^CASE-\d{4,}$/, 'Expected a case id like CASE-1001') });
export const ExecutionIdParamSchema = z.object({ id: z.uuid('Expected an execution UUID') });

export const CreateCaseRequestSchema = OnboardingCaseSchema.pick({
  customerFullName: true,
  dateOfBirth: true,
  nationality: true,
  residentialAddress: true,
  occupation: true,
  declaredAnnualIncome: true,
  productType: true,
})
  .extend({
    // Explicit acknowledgement that no real customer data is being entered.
    syntheticDataConfirmed: z.literal(true, 'Only fictional data may be entered; set syntheticDataConfirmed to true'),
    identityVerificationStatus: IdentityVerificationStatusSchema.default('pending'),
    documents: z.array(SupportingDocumentSchema.omit({ id: true })).max(3).default([]),
    riskIndicators: z
      .array(
        z.object({
          code: RiskIndicatorCodeSchema,
          severity: RiskSeveritySchema,
          status: RiskIndicatorStatusSchema.default('open'),
          description: z.string().min(1),
        }),
      )
      .default([]),
  })
  .refine((c) => new Set(c.documents.map((d) => d.documentType)).size === c.documents.length, {
    message: 'Each document type may appear at most once',
    path: ['documents'],
  })
  .refine((c) => new Set(c.riskIndicators.map((r) => r.code)).size === c.riskIndicators.length, {
    message: 'Each risk indicator code may appear at most once',
    path: ['riskIndicators'],
  });

export type CreateCaseRequest = z.infer<typeof CreateCaseRequestSchema>;
