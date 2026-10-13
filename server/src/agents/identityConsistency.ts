// Identity Consistency Agent — deterministic comparison of the customer profile
// with the details recorded on submitted documents. It checks CONSISTENCY only;
// it does not verify identity. The verification status is reported as recorded
// on the case by a (simulated) upstream step.
import { IdentityConsistencyInputSchema, IdentityConsistencyOutputSchema } from '../schemas/agents';
import type {
  AgentFinding,
  DocumentType,
  FieldComparison,
  IdentityConsistencyInput,
  IdentityConsistencyOutput,
  IdentityField,
} from '../types';
import type { Agent } from './types';

const LABELS: Record<IdentityField, string> = {
  full_name: 'Full name',
  date_of_birth: 'Date of birth',
  residential_address: 'Residential address',
};

const MISMATCH_SEVERITY: Record<IdentityField, AgentFinding['severity']> = {
  full_name: 'high',
  date_of_birth: 'high',
  residential_address: 'medium',
};

const CONSISTENCY_NOTE = 'This is a data-consistency check only; it does not verify the customer\'s identity.';

// Case-, accent-, punctuation- and whitespace-insensitive comparison.
function normalise(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compare(
  field: IdentityField,
  documentType: DocumentType,
  profileValue: string,
  documentValue: string | null,
): FieldComparison {
  const result =
    documentValue === null || documentValue.trim() === ''
      ? 'unavailable'
      : normalise(profileValue) === normalise(documentValue)
        ? 'match'
        : 'mismatch';
  return { field, result, profileValue, documentValue, documentType };
}

function toFinding(c: FieldComparison): AgentFinding | null {
  const evidence = [
    { source: 'case' as const, field: `profile.${c.field}`, observed: c.profileValue },
    { source: 'document' as const, field: `${c.documentType}.${c.field}`, observed: c.documentValue, expected: c.profileValue },
  ];
  if (c.result === 'mismatch') {
    return {
      code: 'IDENTITY_FIELD_MISMATCH',
      severity: MISMATCH_SEVERITY[c.field],
      message: `${LABELS[c.field]} on the ${c.documentType.replace('_', ' ')} ("${c.documentValue}") does not match the profile ("${c.profileValue}").`,
      evidence,
    };
  }
  if (c.result === 'unavailable') {
    return {
      code: 'IDENTITY_DATA_UNAVAILABLE',
      severity: 'medium',
      message: `${LABELS[c.field]} could not be compared: no value available from a ${c.documentType.replace('_', ' ')}.`,
      evidence,
    };
  }
  return null;
}

function evaluate(input: IdentityConsistencyInput): IdentityConsistencyOutput {
  const identityDoc = input.documents.find((d) => d.documentType === 'identity_proof');
  const addressDoc = input.documents.find((d) => d.documentType === 'address_proof');
  const { profile } = input;

  const comparisons: FieldComparison[] = [
    compare('full_name', 'identity_proof', profile.customerFullName, identityDoc?.nameOnDocument ?? null),
    compare('date_of_birth', 'identity_proof', profile.dateOfBirth, identityDoc?.dateOfBirthOnDocument ?? null),
    compare('residential_address', 'address_proof', profile.residentialAddress, addressDoc?.addressOnDocument ?? null),
  ];

  const findings: AgentFinding[] = comparisons.map(toFinding).filter((f): f is AgentFinding => f !== null);

  const status = input.identityVerificationStatus;
  const statusEvidence = [
    { source: 'case' as const, field: 'identityVerificationStatus', observed: status, expected: 'verified' },
  ];
  if (status === 'pending') {
    findings.push({
      code: 'IDENTITY_VERIFICATION_PENDING',
      severity: 'medium',
      message: 'The recorded identity verification status is still pending.',
      evidence: statusEvidence,
    });
  } else if (status === 'failed') {
    findings.push({
      code: 'IDENTITY_VERIFICATION_FAILED',
      severity: 'critical',
      message: 'The recorded identity verification status is failed.',
      evidence: statusEvidence,
    });
  }

  const matched = comparisons.filter((c) => c.result === 'match').map((c) => LABELS[c.field].toLowerCase());
  if (matched.length > 0) {
    findings.unshift({
      code: 'IDENTITY_FIELDS_CONSISTENT',
      severity: 'info',
      message: `Consistent with submitted documents: ${matched.join(', ')}.`,
      evidence: [],
    });
  }

  const mismatched = comparisons.filter((c) => c.result === 'mismatch').map((c) => LABELS[c.field].toLowerCase());
  const unavailable = comparisons.filter((c) => c.result === 'unavailable').map((c) => LABELS[c.field].toLowerCase());
  const problems: string[] = [];
  if (mismatched.length) problems.push(`mismatched: ${mismatched.join(', ')}`);
  if (unavailable.length) problems.push(`could not be compared: ${unavailable.join(', ')}`);
  if (status !== 'verified') problems.push(`recorded verification status: ${status}`);

  const passed = problems.length === 0;
  return {
    status: passed ? 'pass' : 'fail',
    explanation: passed
      ? `Name, date of birth and address are consistent with the submitted documents, and the recorded verification status is verified. ${CONSISTENCY_NOTE}`
      : `Identity consistency not established (${problems.join('; ')}). ${CONSISTENCY_NOTE}`,
    findings,
    comparisons,
    identityVerificationStatus: status,
  };
}

export const identityConsistencyAgent: Agent<
  'identity_consistency',
  IdentityConsistencyInput,
  IdentityConsistencyOutput
> = {
  name: 'identity_consistency',
  version: '1.0.0',
  inputSchema: IdentityConsistencyInputSchema,
  outputSchema: IdentityConsistencyOutputSchema,
  run: async (input) => evaluate(input),
};
