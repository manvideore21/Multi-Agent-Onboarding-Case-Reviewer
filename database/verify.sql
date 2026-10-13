-- Verification queries. Run with: sqlite3 database/onboarding.db < database/verify.sql
.headers on
.mode column

.print '== Integrity and foreign key checks (expect "ok" and no FK rows) =='
PRAGMA integrity_check;
PRAGMA foreign_key_check;

.print ''
.print '== Row counts per table =='
SELECT 'onboarding_cases' AS tbl, COUNT(*) AS n FROM onboarding_cases
UNION ALL SELECT 'supporting_documents', COUNT(*) FROM supporting_documents
UNION ALL SELECT 'risk_indicators',      COUNT(*) FROM risk_indicators
UNION ALL SELECT 'workflow_executions',  COUNT(*) FROM workflow_executions
UNION ALL SELECT 'agent_results',        COUNT(*) FROM agent_results
UNION ALL SELECT 'audit_events',         COUNT(*) FROM audit_events
UNION ALL SELECT 'human_decisions',      COUNT(*) FROM human_decisions;

.print ''
.print '== Cases =='
SELECT id, customer_full_name, identity_verification_status AS id_status, case_status
FROM onboarding_cases
ORDER BY id;

.print ''
.print '== Documents =='
SELECT case_id, document_type, document_subtype, name_on_document, status
FROM supporting_documents
ORDER BY case_id, document_type;

.print ''
.print '== Missing required documents (expect CASE-1002 income_proof) =='
WITH required(document_type) AS (VALUES ('identity_proof'), ('address_proof'), ('income_proof'))
SELECT c.id AS case_id, r.document_type AS missing_document
FROM onboarding_cases c
CROSS JOIN required r
LEFT JOIN supporting_documents d ON d.case_id = c.id AND d.document_type = r.document_type
WHERE d.id IS NULL;

.print ''
.print '== Identity name mismatches (expect CASE-1002) =='
SELECT c.id AS case_id, c.customer_full_name AS profile_name, d.name_on_document AS id_document_name
FROM onboarding_cases c
JOIN supporting_documents d ON d.case_id = c.id AND d.document_type = 'identity_proof'
WHERE lower(trim(c.customer_full_name)) <> lower(trim(d.name_on_document));

.print ''
.print '== Unresolved risk indicators (expect CASE-1003 high) =='
SELECT case_id, indicator_code, severity, status
FROM risk_indicators
WHERE status = 'open';
