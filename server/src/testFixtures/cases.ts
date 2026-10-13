// In-memory copies of the three seeded cases (database/seed.sql) for tests.
import type { OnboardingCase, SupportingDocument } from '../types';

const doc = (
  id: number,
  documentType: SupportingDocument['documentType'],
  fields: Omit<SupportingDocument, 'id' | 'documentType' | 'status'>,
): SupportingDocument => ({ id, documentType, status: 'provided', ...fields });

const timestamps = { createdAt: '2026-10-01T09:00:00.000Z', updatedAt: '2026-10-01T09:00:00.000Z' };

export const CASE_1001: OnboardingCase = {
  id: 'CASE-1001',
  customerFullName: 'Amelia Hart',
  dateOfBirth: '1988-04-12',
  nationality: 'Fictlandia',
  residentialAddress: '12 Example Street, Sampletown, ZZ1 1AA',
  occupation: 'Software Engineer',
  declaredAnnualIncome: 65000,
  productType: 'current_account',
  identityVerificationStatus: 'verified',
  caseStatus: 'new',
  documents: [
    doc(1, 'identity_proof', { documentSubtype: 'passport', documentReference: 'FIC-PP-100101', nameOnDocument: 'Amelia Hart', addressOnDocument: null, dateOfBirthOnDocument: '1988-04-12', issueDate: '2021-05-10', expiryDate: '2031-05-09' }),
    doc(2, 'address_proof', { documentSubtype: 'utility_bill', documentReference: 'FIC-UB-100102', nameOnDocument: 'Amelia Hart', addressOnDocument: '12 Example Street, Sampletown, ZZ1 1AA', dateOfBirthOnDocument: null, issueDate: '2026-09-15', expiryDate: null }),
    doc(3, 'income_proof', { documentSubtype: 'payslip', documentReference: 'FIC-PS-100103', nameOnDocument: 'Amelia Hart', addressOnDocument: null, dateOfBirthOnDocument: null, issueDate: '2026-09-30', expiryDate: null }),
  ],
  riskIndicators: [
    { id: 1, code: 'ADDRESS_RECENTLY_CHANGED', severity: 'low', status: 'resolved', description: 'Synthetic flag: address changed within 6 months; consistent with address proof.', raisedAt: '2026-10-01T09:05:00.000Z', resolvedAt: '2026-10-01T11:00:00.000Z' },
  ],
  ...timestamps,
};

export const CASE_1002: OnboardingCase = {
  id: 'CASE-1002',
  customerFullName: 'Ravi Menon',
  dateOfBirth: '1992-11-03',
  nationality: 'Fictlandia',
  residentialAddress: '45 Placeholder Road, Mocksville, ZZ2 2BB',
  occupation: 'Retail Manager',
  declaredAnnualIncome: 42000,
  productType: 'credit_card',
  identityVerificationStatus: 'verified',
  caseStatus: 'new',
  documents: [
    doc(4, 'identity_proof', { documentSubtype: 'national_id', documentReference: 'FIC-ID-100201', nameOnDocument: 'Ravi Menen', addressOnDocument: null, dateOfBirthOnDocument: '1992-11-03', issueDate: '2020-02-01', expiryDate: '2030-01-31' }),
    doc(5, 'address_proof', { documentSubtype: 'bank_statement', documentReference: 'FIC-BS-100202', nameOnDocument: 'Ravi Menon', addressOnDocument: '45 Placeholder Road, Mocksville, ZZ2 2BB', dateOfBirthOnDocument: null, issueDate: '2026-09-20', expiryDate: null }),
  ],
  riskIndicators: [],
  ...timestamps,
};

export const CASE_1003: OnboardingCase = {
  id: 'CASE-1003',
  customerFullName: 'Sofia Marlow',
  dateOfBirth: '1979-07-21',
  nationality: 'Imaginaria',
  residentialAddress: '8 Fabricated Lane, Testford, ZZ3 3CC',
  occupation: 'Import/Export Consultant',
  declaredAnnualIncome: 180000,
  productType: 'savings_account',
  identityVerificationStatus: 'pending',
  caseStatus: 'new',
  documents: [
    doc(6, 'identity_proof', { documentSubtype: 'passport', documentReference: 'FIC-PP-100301', nameOnDocument: 'Sofia Marlow', addressOnDocument: null, dateOfBirthOnDocument: '1979-07-21', issueDate: '2019-08-01', expiryDate: '2029-07-31' }),
    doc(7, 'address_proof', { documentSubtype: 'utility_bill', documentReference: 'FIC-UB-100302', nameOnDocument: 'Sofia Marlow', addressOnDocument: '8 Fabricated Lane, Testford, ZZ3 3CC', dateOfBirthOnDocument: null, issueDate: '2026-09-10', expiryDate: null }),
    doc(8, 'income_proof', { documentSubtype: 'tax_return', documentReference: 'FIC-TR-100303', nameOnDocument: 'Sofia Marlow', addressOnDocument: null, dateOfBirthOnDocument: null, issueDate: '2026-04-30', expiryDate: null }),
  ],
  riskIndicators: [
    { id: 2, code: 'WATCHLIST_NAME_SIMILARITY', severity: 'high', status: 'open', description: 'Synthetic flag: name resembles an entry on a fictional watchlist; not yet investigated.', raisedAt: '2026-10-03T14:20:00.000Z', resolvedAt: null },
  ],
  ...timestamps,
};
