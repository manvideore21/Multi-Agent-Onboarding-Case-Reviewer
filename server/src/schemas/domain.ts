// Domain schemas for onboarding cases and their related records.
// Values mirror the CHECK constraints in database/schema.sql.
import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const timestamp = z.string().min(1);

export const DocumentTypeSchema = z.enum(['identity_proof', 'address_proof', 'income_proof']);
export const REQUIRED_DOCUMENT_TYPES = DocumentTypeSchema.options;

// 'provided' means metadata was submitted — NOT that the document is authentic.
// 'pending_verification' means a (simulated) verification step is outstanding.
export const DocumentStatusSchema = z.enum(['provided', 'pending_verification', 'expired', 'unreadable']);
export const IdentityVerificationStatusSchema = z.enum(['verified', 'pending', 'failed']);
export const RiskSeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export const RiskIndicatorStatusSchema = z.enum(['open', 'resolved', 'dismissed']);
export const RiskIndicatorCodeSchema = z.enum([
  'WATCHLIST_NAME_SIMILARITY',
  'HIGH_RISK_JURISDICTION',
  'INCOME_OCCUPATION_MISMATCH',
  'ADVERSE_MEDIA_MENTION',
  'ADDRESS_RECENTLY_CHANGED',
]);
export const ProductTypeSchema = z.enum(['current_account', 'savings_account', 'credit_card']);
export const CaseStatusSchema = z.enum([
  'new',
  'in_review',
  'needs_human_approval',
  'needs_manual_review',
  'approved',
  'rejected',
]);

export const SupportingDocumentSchema = z.object({
  id: z.number().int(),
  documentType: DocumentTypeSchema,
  documentSubtype: z.string().min(1),
  documentReference: z.string().min(1),
  nameOnDocument: z.string().min(1),
  addressOnDocument: z.string().nullable(),
  dateOfBirthOnDocument: isoDate.nullable(), // identity documents only
  issueDate: isoDate.nullable(),
  expiryDate: isoDate.nullable(),
  status: DocumentStatusSchema,
});

export const RiskIndicatorSchema = z.object({
  id: z.number().int(),
  code: RiskIndicatorCodeSchema,
  severity: RiskSeveritySchema,
  status: RiskIndicatorStatusSchema,
  description: z.string().min(1),
  raisedAt: timestamp,
  resolvedAt: timestamp.nullable(),
});

// A full case snapshot: the profile plus its documents and risk indicators.
export const OnboardingCaseSchema = z.object({
  id: z.string().min(1),
  customerFullName: z.string().min(1),
  dateOfBirth: isoDate,
  nationality: z.string().min(1),
  residentialAddress: z.string().min(1),
  occupation: z.string().nullable(),
  declaredAnnualIncome: z.number().int().nonnegative().nullable(),
  productType: ProductTypeSchema,
  identityVerificationStatus: IdentityVerificationStatusSchema,
  caseStatus: CaseStatusSchema,
  documents: z.array(SupportingDocumentSchema),
  riskIndicators: z.array(RiskIndicatorSchema),
  createdAt: timestamp,
  updatedAt: timestamp,
});
