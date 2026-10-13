-- Multi-Agent Onboarding Case Reviewer — SQLite schema
-- All data is fictional. Timestamps are ISO-8601 UTC text.
-- Safe to re-run: uses IF NOT EXISTS and never drops data.
-- SQLite enforces foreign keys only when PRAGMA foreign_keys = ON is set on
-- each connection; the backend must do this too.

PRAGMA foreign_keys = ON;

-- Customer profile as declared on the onboarding application.
CREATE TABLE IF NOT EXISTS onboarding_cases (
  id                           TEXT PRIMARY KEY,                -- e.g. 'CASE-1001'
  customer_full_name           TEXT NOT NULL,
  date_of_birth                TEXT NOT NULL,                   -- YYYY-MM-DD
  nationality                  TEXT NOT NULL,
  residential_address          TEXT NOT NULL,
  occupation                   TEXT,
  declared_annual_income       INTEGER CHECK (declared_annual_income IS NULL OR declared_annual_income >= 0),
  product_type                 TEXT NOT NULL CHECK (product_type IN ('current_account', 'savings_account', 'credit_card')),
  -- Status reported by a (simulated) identity verification step.
  identity_verification_status TEXT NOT NULL DEFAULT 'pending'
                               CHECK (identity_verification_status IN ('verified', 'pending', 'failed')),
  -- Where the case is in the review process (not a banking action).
  case_status                  TEXT NOT NULL DEFAULT 'new'
                               CHECK (case_status IN ('new', 'in_review', 'needs_human_approval',
                                                      'needs_manual_review', 'approved', 'rejected')),
  created_at                   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at                   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TRIGGER IF NOT EXISTS trg_onboarding_cases_updated_at
AFTER UPDATE ON onboarding_cases
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE onboarding_cases
     SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE id = NEW.id;
END;

-- Document METADATA only. 'provided' means the metadata was submitted;
-- 'pending_verification' means a (simulated) verification step is outstanding.
-- Neither means the document is authentic. A required document that was never
-- submitted has no row; the Document Completeness Agent detects the gap.
CREATE TABLE IF NOT EXISTS supporting_documents (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id             TEXT NOT NULL REFERENCES onboarding_cases(id) ON DELETE CASCADE,
  document_type       TEXT NOT NULL CHECK (document_type IN ('identity_proof', 'address_proof', 'income_proof')),
  document_subtype    TEXT NOT NULL,                            -- e.g. 'passport', 'utility_bill', 'payslip'
  document_reference  TEXT NOT NULL,                            -- fictional reference number
  name_on_document    TEXT NOT NULL,
  address_on_document TEXT,
  date_of_birth_on_document TEXT,                              -- YYYY-MM-DD, identity documents only
  issue_date          TEXT,
  expiry_date         TEXT,
  status              TEXT NOT NULL DEFAULT 'provided'
                      CHECK (status IN ('provided', 'pending_verification', 'expired', 'unreadable')),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (case_id, document_type),
  CHECK (expiry_date IS NULL OR issue_date IS NULL OR expiry_date > issue_date)
);

CREATE INDEX IF NOT EXISTS idx_supporting_documents_case ON supporting_documents(case_id);

-- Predefined, synthetic risk flags raised against a case.
CREATE TABLE IF NOT EXISTS risk_indicators (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id        TEXT NOT NULL REFERENCES onboarding_cases(id) ON DELETE CASCADE,
  indicator_code TEXT NOT NULL CHECK (indicator_code IN (
                   'WATCHLIST_NAME_SIMILARITY',
                   'HIGH_RISK_JURISDICTION',
                   'INCOME_OCCUPATION_MISMATCH',
                   'ADVERSE_MEDIA_MENTION',
                   'ADDRESS_RECENTLY_CHANGED')),
  severity       TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  description    TEXT NOT NULL,
  raised_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resolved_at    TEXT,
  UNIQUE (case_id, indicator_code),
  -- An open indicator has no resolution time; a closed one must have one.
  CHECK ((status = 'open' AND resolved_at IS NULL) OR (status <> 'open' AND resolved_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_risk_indicators_case_status ON risk_indicators(case_id, status);

-- One row per run of the review workflow on a case.
-- recommendation (agent output), status (workflow state) and final_outcome
-- (what was decided, and by whom) are deliberately separate columns.
CREATE TABLE IF NOT EXISTS workflow_executions (
  id                    TEXT PRIMARY KEY,                       -- UUID
  case_id               TEXT NOT NULL REFERENCES onboarding_cases(id),
  autonomy_mode         TEXT NOT NULL CHECK (autonomy_mode IN ('human_approval_required', 'exception_only')),
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'running', 'completed',
                                          'needs_human_approval', 'needs_manual_review', 'failed')),
  recommendation        TEXT CHECK (recommendation IS NULL OR
                                    recommendation IN ('approve', 'reject', 'refer_for_manual_review')),
  recommendation_reason TEXT,
  final_outcome         TEXT CHECK (final_outcome IS NULL OR final_outcome IN ('approved', 'rejected')),
  outcome_source        TEXT CHECK (outcome_source IS NULL OR outcome_source IN ('human', 'auto_policy')),
  error_message         TEXT,
  started_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at          TEXT,
  CHECK (status NOT IN ('completed', 'failed') OR completed_at IS NOT NULL),
  -- An outcome always records who produced it.
  CHECK ((final_outcome IS NULL) = (outcome_source IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_workflow_executions_case ON workflow_executions(case_id, started_at);

-- Output of each agent attempt; a retry produces an additional row.
CREATE TABLE IF NOT EXISTS agent_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id  TEXT NOT NULL REFERENCES workflow_executions(id),
  agent_name    TEXT NOT NULL CHECK (agent_name IN (
                  'document_completeness', 'identity_consistency', 'risk_indicator', 'recommendation')),
  attempt       INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  status        TEXT NOT NULL CHECK (status IN ('success', 'error', 'invalid_input', 'invalid_output')),
  output_json   TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
  error_message TEXT,
  started_at    TEXT NOT NULL,
  completed_at  TEXT NOT NULL,
  UNIQUE (execution_id, agent_name, attempt)
);

CREATE INDEX IF NOT EXISTS idx_agent_results_execution ON agent_results(execution_id);

-- Append-only audit trail; update and delete are blocked by triggers.
CREATE TABLE IF NOT EXISTS audit_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id      TEXT NOT NULL REFERENCES onboarding_cases(id),
  execution_id TEXT REFERENCES workflow_executions(id),
  event_type   TEXT NOT NULL,                                   -- e.g. 'WORKFLOW_STARTED', 'AGENT_RETRY'
  actor        TEXT NOT NULL,                                   -- 'supervisor', agent name, or reviewer
  details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_events_case ON audit_events(case_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_execution ON audit_events(execution_id);

CREATE TRIGGER IF NOT EXISTS trg_audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

-- An explicit reviewer decision on an execution (at most one per execution).
CREATE TABLE IF NOT EXISTS human_decisions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id  TEXT NOT NULL UNIQUE REFERENCES workflow_executions(id),
  decision      TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reviewer_name TEXT NOT NULL CHECK (length(trim(reviewer_name)) > 0),
  comment       TEXT,
  decided_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
