-- Fictional seed data. All names, addresses and references are invented.
--
-- Re-runnable: case rows are upserted and each seeded case's documents and
-- risk indicators are replaced, restoring the original scenarios. Workflow
-- history (executions, agent results, audit events, decisions) is kept,
-- because the audit trail is append-only. For a completely clean database
-- use database/reset.sh instead.

PRAGMA foreign_keys = ON;

BEGIN TRANSACTION;

INSERT INTO onboarding_cases
  (id, customer_full_name, date_of_birth, nationality, residential_address,
   occupation, declared_annual_income, product_type, identity_verification_status, case_status)
VALUES
  -- Routine: complete documents, consistent identity, no unresolved risk.
  ('CASE-1001', 'Amelia Hart', '1988-04-12', 'Fictlandia',
   '12 Example Street, Sampletown, ZZ1 1AA',
   'Software Engineer', 65000, 'current_account', 'verified', 'new'),

  -- Missing income proof + name on identity document differs from profile.
  ('CASE-1002', 'Ravi Menon', '1992-11-03', 'Fictlandia',
   '45 Placeholder Road, Mocksville, ZZ2 2BB',
   'Retail Manager', 42000, 'credit_card', 'verified', 'new'),

  -- Pending identity verification + high-severity unresolved risk indicator.
  ('CASE-1003', 'Sofia Marlow', '1979-07-21', 'Imaginaria',
   '8 Fabricated Lane, Testford, ZZ3 3CC',
   'Import/Export Consultant', 180000, 'savings_account', 'pending', 'new')
ON CONFLICT(id) DO UPDATE SET
  customer_full_name           = excluded.customer_full_name,
  date_of_birth                = excluded.date_of_birth,
  nationality                  = excluded.nationality,
  residential_address          = excluded.residential_address,
  occupation                   = excluded.occupation,
  declared_annual_income       = excluded.declared_annual_income,
  product_type                 = excluded.product_type,
  identity_verification_status = excluded.identity_verification_status,
  case_status                  = excluded.case_status;

DELETE FROM supporting_documents WHERE case_id IN ('CASE-1001', 'CASE-1002', 'CASE-1003');
DELETE FROM risk_indicators      WHERE case_id IN ('CASE-1001', 'CASE-1002', 'CASE-1003');

INSERT INTO supporting_documents
  (case_id, document_type, document_subtype, document_reference,
   name_on_document, address_on_document, date_of_birth_on_document, issue_date, expiry_date, status)
VALUES
  ('CASE-1001', 'identity_proof', 'passport',       'FIC-PP-100101', 'Amelia Hart',  NULL,                                       '1988-04-12', '2021-05-10', '2031-05-09', 'provided'),
  ('CASE-1001', 'address_proof',  'utility_bill',   'FIC-UB-100102', 'Amelia Hart',  '12 Example Street, Sampletown, ZZ1 1AA',   NULL,         '2026-09-15', NULL,         'provided'),
  ('CASE-1001', 'income_proof',   'payslip',        'FIC-PS-100103', 'Amelia Hart',  NULL,                                       NULL,         '2026-09-30', NULL,         'provided'),

  -- CASE-1002: no income_proof row (missing); identity name does not match profile.
  ('CASE-1002', 'identity_proof', 'national_id',    'FIC-ID-100201', 'Ravi Menen',   NULL,                                       '1992-11-03', '2020-02-01', '2030-01-31', 'provided'),
  ('CASE-1002', 'address_proof',  'bank_statement', 'FIC-BS-100202', 'Ravi Menon',   '45 Placeholder Road, Mocksville, ZZ2 2BB', NULL,         '2026-09-20', NULL,         'provided'),

  ('CASE-1003', 'identity_proof', 'passport',       'FIC-PP-100301', 'Sofia Marlow', NULL,                                       '1979-07-21', '2019-08-01', '2029-07-31', 'provided'),
  ('CASE-1003', 'address_proof',  'utility_bill',   'FIC-UB-100302', 'Sofia Marlow', '8 Fabricated Lane, Testford, ZZ3 3CC',     NULL,         '2026-09-10', NULL,         'provided'),
  ('CASE-1003', 'income_proof',   'tax_return',     'FIC-TR-100303', 'Sofia Marlow', NULL,                                       NULL,         '2026-04-30', NULL,         'provided');

INSERT INTO risk_indicators
  (case_id, indicator_code, severity, status, description, raised_at, resolved_at)
VALUES
  -- CASE-1001: a minor indicator that is already resolved (none unresolved).
  ('CASE-1001', 'ADDRESS_RECENTLY_CHANGED', 'low', 'resolved',
   'Synthetic flag: address changed within 6 months; consistent with address proof.',
   '2026-10-01T09:05:00.000Z', '2026-10-01T11:00:00.000Z'),

  -- CASE-1003: high-severity unresolved indicator.
  ('CASE-1003', 'WATCHLIST_NAME_SIMILARITY', 'high', 'open',
   'Synthetic flag: name resembles an entry on a fictional watchlist; not yet investigated.',
   '2026-10-03T14:20:00.000Z', NULL);

COMMIT;
