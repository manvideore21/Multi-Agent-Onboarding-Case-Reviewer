import { describe, expect, it } from 'vitest';
import { DocumentCompletenessResultSchema } from '../schemas/agents';
import type { SupportingDocument } from '../types';
import { documentCompletenessAgent } from './documentCompleteness';
import { executeAgent } from './types';

const REFERENCE_DATE = '2026-10-12';

// Fixtures mirror CASE-1001 in database/seed.sql.
const identityProof: SupportingDocument = {
  id: 1,
  documentType: 'identity_proof',
  documentSubtype: 'passport',
  documentReference: 'FIC-PP-100101',
  nameOnDocument: 'Amelia Hart',
  addressOnDocument: null,
  dateOfBirthOnDocument: '1988-04-12',
  issueDate: '2021-05-10',
  expiryDate: '2031-05-09',
  status: 'provided',
};
const addressProof: SupportingDocument = {
  id: 2,
  documentType: 'address_proof',
  documentSubtype: 'utility_bill',
  documentReference: 'FIC-UB-100102',
  nameOnDocument: 'Amelia Hart',
  addressOnDocument: '12 Example Street, Sampletown, ZZ1 1AA',
  dateOfBirthOnDocument: null,
  issueDate: '2026-09-15',
  expiryDate: null,
  status: 'provided',
};
const incomeProof: SupportingDocument = {
  id: 3,
  documentType: 'income_proof',
  documentSubtype: 'payslip',
  documentReference: 'FIC-PS-100103',
  nameOnDocument: 'Amelia Hart',
  addressOnDocument: null,
  dateOfBirthOnDocument: null,
  issueDate: '2026-09-30',
  expiryDate: null,
  status: 'provided',
};

const run = (documents: SupportingDocument[]) =>
  executeAgent(documentCompletenessAgent, { caseId: 'CASE-TEST', referenceDate: REFERENCE_DATE, documents });

async function runSuccess(documents: SupportingDocument[]) {
  const result = await run(documents);
  if (result.outcome !== 'success') throw new Error(`Expected success, got: ${result.errorMessage}`);
  return result.output;
}

describe('Document Completeness Agent', () => {
  it('passes when all required documents are present with complete metadata', async () => {
    const result = await run([identityProof, addressProof, incomeProof]);

    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;
    expect(result.output.status).toBe('pass');
    expect(result.output.missingDocumentTypes).toEqual([]);
    expect(result.output.findings.map((f) => f.code)).toEqual(Array(3).fill('DOCUMENT_METADATA_PROVIDED'));
    expect(result.output.findings.every((f) => f.severity === 'info')).toBe(true);
    // Never claims authenticity from metadata alone.
    expect(result.output.explanation).toContain('authenticity has not been verified');

    // Full result, including execution metadata, satisfies the shared contract.
    expect(DocumentCompletenessResultSchema.safeParse(result).success).toBe(true);
    expect(result.agentName).toBe('document_completeness');
    expect(result.attempts).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('fails and reports a missing required document with evidence (CASE-1002 scenario)', async () => {
    const output = await runSuccess([{ ...identityProof, nameOnDocument: 'Ravi Menen' }, addressProof]);

    expect(output.status).toBe('fail');
    expect(output.missingDocumentTypes).toEqual(['income_proof']);
    expect(output.pendingVerificationDocumentTypes).toEqual([]);
    const missing = output.findings.find((f) => f.code === 'DOCUMENT_MISSING');
    expect(missing?.severity).toBe('high');
    expect(missing?.evidence[0]).toMatchObject({ source: 'document', field: 'income_proof', observed: null });
    expect(output.explanation).toContain('missing: income proof');
  });

  it('distinguishes a present document with pending verification from a missing one', async () => {
    const output = await runSuccess([{ ...identityProof, status: 'pending_verification' }, addressProof, incomeProof]);

    expect(output.status).toBe('fail');
    expect(output.missingDocumentTypes).toEqual([]);
    expect(output.pendingVerificationDocumentTypes).toEqual(['identity_proof']);
    expect(output.findings.find((f) => f.code === 'DOCUMENT_VERIFICATION_PENDING')?.evidence[0]).toMatchObject({
      field: 'identity_proof.status',
      observed: 'pending_verification',
    });
    expect(output.findings.some((f) => f.code === 'DOCUMENT_MISSING')).toBe(false);
  });

  it('fails on expired documents and on incomplete or invalid metadata', async () => {
    const output = await runSuccess([
      { ...identityProof, expiryDate: '2026-01-01' }, // expired by date although status says 'provided'
      { ...addressProof, addressOnDocument: null }, // incomplete metadata
      { ...incomeProof, issueDate: '2027-01-01' }, // issue date in the future
    ]);

    expect(output.status).toBe('fail');
    expect(output.unusableDocumentTypes).toEqual(['identity_proof']);
    expect(output.metadataIssueDocumentTypes).toEqual(['address_proof', 'income_proof']);
    expect(output.findings.map((f) => f.code)).toEqual([
      'DOCUMENT_EXPIRED',
      'DOCUMENT_METADATA_INCOMPLETE',
      'DOCUMENT_METADATA_INVALID',
    ]);
  });

  it('returns an explicit invalid_input failure for malformed input instead of a check result', async () => {
    const badType = await executeAgent(documentCompletenessAgent, {
      caseId: 'CASE-TEST',
      referenceDate: REFERENCE_DATE,
      documents: [{ ...identityProof, documentType: 'selfie' }],
    });
    const noDate = await executeAgent(documentCompletenessAgent, { caseId: 'CASE-TEST', documents: [] });
    const duplicate = await run([identityProof, { ...identityProof, id: 9 }]);

    for (const result of [badType, noDate, duplicate]) {
      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') expect(result.failureReason).toBe('invalid_input');
      expect('output' in result).toBe(false);
    }
  });
});

describe('executeAgent failure handling', () => {
  it('captures a thrown error and an invalid output as explicit failures', async () => {
    const throwing = { ...documentCompletenessAgent, run: async () => { throw new Error('Simulated outage'); } };
    const lying = {
      ...documentCompletenessAgent,
      // Claims 'pass' while reporting a missing document — must be rejected.
      run: async () => ({
        status: 'pass' as const,
        explanation: 'Looks fine',
        findings: [],
        missingDocumentTypes: ['income_proof' as const],
        pendingVerificationDocumentTypes: [],
        unusableDocumentTypes: [],
        metadataIssueDocumentTypes: [],
      }),
    };
    const input = { caseId: 'CASE-TEST', referenceDate: REFERENCE_DATE, documents: [identityProof] };

    const thrown = await executeAgent(throwing, input);
    const invalid = await executeAgent(lying, input);

    expect(thrown).toMatchObject({ outcome: 'failed', failureReason: 'error', errorMessage: 'Simulated outage' });
    expect(invalid).toMatchObject({ outcome: 'failed', failureReason: 'invalid_output' });
  });
});
