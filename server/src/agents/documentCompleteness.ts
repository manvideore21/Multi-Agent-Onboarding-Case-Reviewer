// Document Completeness Agent — deterministic rules over document METADATA.
// It never asserts that a document is authentic; it only reports what metadata
// was submitted and whether it is complete, current and readable.
import { DocumentCompletenessInputSchema, DocumentCompletenessOutputSchema } from '../schemas/agents';
import { REQUIRED_DOCUMENT_TYPES } from '../schemas/domain';
import type {
  AgentFinding,
  DocumentCompletenessInput,
  DocumentCompletenessOutput,
  DocumentType,
  SupportingDocument,
} from '../types';
import type { Agent } from './types';

const LABELS: Record<DocumentType, string> = {
  identity_proof: 'identity proof',
  address_proof: 'address proof',
  income_proof: 'income proof',
};

// Metadata fields that must be present for each document type.
const REQUIRED_FIELDS: Record<DocumentType, (keyof SupportingDocument)[]> = {
  identity_proof: ['issueDate', 'expiryDate'],
  address_proof: ['issueDate', 'addressOnDocument'],
  income_proof: ['issueDate'],
};

const AUTHENTICITY_NOTE = 'This check reviews metadata only; document authenticity has not been verified.';

function evaluate(input: DocumentCompletenessInput): DocumentCompletenessOutput {
  const findings: AgentFinding[] = [];
  const missing: DocumentType[] = [];
  const pending: DocumentType[] = [];
  const unusable: DocumentType[] = [];
  const metadataIssues: DocumentType[] = [];

  for (const type of REQUIRED_DOCUMENT_TYPES) {
    const doc = input.documents.find((d) => d.documentType === type);

    if (!doc) {
      missing.push(type);
      findings.push({
        code: 'DOCUMENT_MISSING',
        severity: 'high',
        message: `Required ${LABELS[type]} has not been submitted.`,
        evidence: [{ source: 'document', field: type, observed: null, expected: 'submitted document metadata' }],
      });
      continue;
    }

    const issuesBefore = findings.length;
    const field = (name: string) => `${type}.${name}`;

    if (doc.status === 'unreadable') {
      unusable.push(type);
      findings.push({
        code: 'DOCUMENT_UNREADABLE',
        severity: 'high',
        message: `The ${LABELS[type]} (${doc.documentReference}) is marked unreadable.`,
        evidence: [{ source: 'document', field: field('status'), observed: doc.status, expected: 'provided' }],
      });
    } else if (doc.status === 'expired' || (doc.expiryDate !== null && doc.expiryDate < input.referenceDate)) {
      unusable.push(type);
      findings.push({
        code: 'DOCUMENT_EXPIRED',
        severity: 'high',
        message: `The ${LABELS[type]} (${doc.documentReference}) has expired.`,
        evidence: [
          { source: 'document', field: field('status'), observed: doc.status },
          { source: 'document', field: field('expiryDate'), observed: doc.expiryDate, expected: `on or after ${input.referenceDate}` },
        ],
      });
    }

    if (doc.status === 'pending_verification') {
      pending.push(type);
      findings.push({
        code: 'DOCUMENT_VERIFICATION_PENDING',
        severity: 'medium',
        message: `The ${LABELS[type]} (${doc.documentReference}) is present but its verification is still pending.`,
        evidence: [{ source: 'document', field: field('status'), observed: doc.status, expected: 'provided' }],
      });
    }

    const absentFields = REQUIRED_FIELDS[type].filter((f) => doc[f] === null);
    if (absentFields.length > 0) {
      findings.push({
        code: 'DOCUMENT_METADATA_INCOMPLETE',
        severity: 'medium',
        message: `The ${LABELS[type]} is missing required metadata: ${absentFields.join(', ')}.`,
        evidence: absentFields.map((f) => ({ source: 'document' as const, field: field(f), observed: null, expected: 'a value' })),
      });
    }

    if (doc.issueDate !== null && doc.issueDate > input.referenceDate) {
      findings.push({
        code: 'DOCUMENT_METADATA_INVALID',
        severity: 'medium',
        message: `The ${LABELS[type]} has an issue date in the future.`,
        evidence: [{ source: 'document', field: field('issueDate'), observed: doc.issueDate, expected: `on or before ${input.referenceDate}` }],
      });
    }

    if (findings.slice(issuesBefore).some((f) => f.code.startsWith('DOCUMENT_METADATA_'))) {
      metadataIssues.push(type);
    }

    if (findings.length === issuesBefore) {
      findings.push({
        code: 'DOCUMENT_METADATA_PROVIDED',
        severity: 'info',
        message: `The ${LABELS[type]} metadata is present and complete. Authenticity has not been verified.`,
        evidence: [{ source: 'document', field: field('documentReference'), observed: doc.documentReference }],
      });
    }
  }

  const problems: string[] = [];
  const list = (types: DocumentType[]) => types.map((t) => LABELS[t]).join(', ');
  if (missing.length) problems.push(`missing: ${list(missing)}`);
  if (pending.length) problems.push(`verification pending: ${list(pending)}`);
  if (unusable.length) problems.push(`expired or unreadable: ${list(unusable)}`);
  if (metadataIssues.length) problems.push(`incomplete or invalid metadata: ${list(metadataIssues)}`);

  const status = problems.length === 0 ? 'pass' : 'fail';
  const explanation =
    status === 'pass'
      ? `All ${REQUIRED_DOCUMENT_TYPES.length} required documents were submitted with complete metadata. ${AUTHENTICITY_NOTE}`
      : `Document requirements not met (${problems.join('; ')}). ${AUTHENTICITY_NOTE}`;

  return {
    status,
    explanation,
    findings,
    missingDocumentTypes: missing,
    pendingVerificationDocumentTypes: pending,
    unusableDocumentTypes: unusable,
    metadataIssueDocumentTypes: metadataIssues,
  };
}

export const documentCompletenessAgent: Agent<
  'document_completeness',
  DocumentCompletenessInput,
  DocumentCompletenessOutput
> = {
  name: 'document_completeness',
  version: '1.0.0',
  inputSchema: DocumentCompletenessInputSchema,
  outputSchema: DocumentCompletenessOutputSchema,
  run: async (input) => evaluate(input),
};
