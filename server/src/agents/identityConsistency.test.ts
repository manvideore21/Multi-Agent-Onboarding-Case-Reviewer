import { describe, expect, it } from 'vitest';
import { IdentityConsistencyResultSchema } from '../schemas/agents';
import type { IdentityConsistencyInput, SupportingDocument } from '../types';
import { identityConsistencyAgent } from './identityConsistency';
import { executeAgent } from './types';

// Fixtures mirror CASE-1001 in database/seed.sql.
const profile = {
  customerFullName: 'Amelia Hart',
  dateOfBirth: '1988-04-12',
  residentialAddress: '12 Example Street, Sampletown, ZZ1 1AA',
};
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

const baseInput: IdentityConsistencyInput = {
  caseId: 'CASE-TEST',
  profile,
  identityVerificationStatus: 'verified',
  documents: [identityProof, addressProof],
};

async function runSuccess(overrides: Partial<IdentityConsistencyInput> = {}) {
  const result = await executeAgent(identityConsistencyAgent, { ...baseInput, ...overrides });
  if (result.outcome !== 'success') throw new Error(`Expected success, got: ${result.errorMessage}`);
  return result.output;
}

const resultFor = (output: Awaited<ReturnType<typeof runSuccess>>, field: string) =>
  output.comparisons.find((c) => c.field === field)?.result;

describe('Identity Consistency Agent', () => {
  it('passes when name, date of birth and address all match (ignoring case/punctuation)', async () => {
    const result = await executeAgent(identityConsistencyAgent, {
      ...baseInput,
      documents: [
        { ...identityProof, nameOnDocument: '  AMELIA   hart ' },
        { ...addressProof, addressOnDocument: '12 Example Street Sampletown ZZ1 1AA' },
      ],
    });

    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;
    expect(result.output.status).toBe('pass');
    expect(result.output.comparisons.map((c) => c.result)).toEqual(['match', 'match', 'match']);
    expect(result.output.findings.map((f) => f.code)).toEqual(['IDENTITY_FIELDS_CONSISTENT']);
    expect(result.output.explanation).toContain('does not verify the customer\'s identity');
    expect(IdentityConsistencyResultSchema.safeParse(result).success).toBe(true);
  });

  it('fails on a name mismatch with evidence of both values (CASE-1002 scenario)', async () => {
    const output = await runSuccess({
      profile: { ...profile, customerFullName: 'Ravi Menon' },
      documents: [{ ...identityProof, nameOnDocument: 'Ravi Menen' }, { ...addressProof, nameOnDocument: 'Ravi Menon' }],
    });

    expect(output.status).toBe('fail');
    expect(resultFor(output, 'full_name')).toBe('mismatch');
    const finding = output.findings.find((f) => f.code === 'IDENTITY_FIELD_MISMATCH');
    expect(finding?.severity).toBe('high');
    expect(finding?.evidence).toEqual([
      { source: 'case', field: 'profile.full_name', observed: 'Ravi Menon' },
      { source: 'document', field: 'identity_proof.full_name', observed: 'Ravi Menen', expected: 'Ravi Menon' },
    ]);
  });

  it('fails on a date-of-birth mismatch', async () => {
    const output = await runSuccess({ documents: [{ ...identityProof, dateOfBirthOnDocument: '1988-12-04' }, addressProof] });

    expect(output.status).toBe('fail');
    expect(resultFor(output, 'date_of_birth')).toBe('mismatch');
    expect(resultFor(output, 'full_name')).toBe('match');
    expect(output.explanation).toContain('mismatched: date of birth');
  });

  it('treats missing identity information as unavailable, never as a match', async () => {
    const noIdentityDoc = await runSuccess({ documents: [addressProof] });
    expect(noIdentityDoc.status).toBe('fail');
    expect(resultFor(noIdentityDoc, 'full_name')).toBe('unavailable');
    expect(resultFor(noIdentityDoc, 'date_of_birth')).toBe('unavailable');
    expect(noIdentityDoc.findings.filter((f) => f.code === 'IDENTITY_DATA_UNAVAILABLE')).toHaveLength(2);

    const noDobOnDoc = await runSuccess({ documents: [{ ...identityProof, dateOfBirthOnDocument: null }, addressProof] });
    expect(noDobOnDoc.status).toBe('fail');
    expect(resultFor(noDobOnDoc, 'date_of_birth')).toBe('unavailable');

    // Structurally invalid input is an explicit failure, not a check result.
    const invalid = await executeAgent(identityConsistencyAgent, { ...baseInput, profile: { customerFullName: 'Amelia Hart' } });
    expect(invalid).toMatchObject({ outcome: 'failed', failureReason: 'invalid_input' });
  });

  it('reports every inconsistency when several occur together', async () => {
    const output = await runSuccess({
      identityVerificationStatus: 'pending',
      documents: [
        { ...identityProof, nameOnDocument: 'Amelia Harte', dateOfBirthOnDocument: '1989-04-12' },
        { ...addressProof, addressOnDocument: '99 Other Road, Elsewhere, ZZ9 9ZZ' },
      ],
    });

    expect(output.status).toBe('fail');
    expect(output.comparisons.map((c) => c.result)).toEqual(['mismatch', 'mismatch', 'mismatch']);
    expect(output.findings.map((f) => [f.code, f.severity])).toEqual([
      ['IDENTITY_FIELD_MISMATCH', 'high'],
      ['IDENTITY_FIELD_MISMATCH', 'high'],
      ['IDENTITY_FIELD_MISMATCH', 'medium'],
      ['IDENTITY_VERIFICATION_PENDING', 'medium'],
    ]);
    expect(output.explanation).toContain('mismatched: full name, date of birth, residential address');
    expect(output.explanation).toContain('recorded verification status: pending');
  });

  it('fails when the recorded verification status is pending or failed, even if all fields match', async () => {
    const pending = await runSuccess({ identityVerificationStatus: 'pending' });
    const failed = await runSuccess({ identityVerificationStatus: 'failed' });

    expect(pending.status).toBe('fail');
    expect(failed.status).toBe('fail');
    expect(failed.findings.find((f) => f.code === 'IDENTITY_VERIFICATION_FAILED')?.severity).toBe('critical');
  });
});
