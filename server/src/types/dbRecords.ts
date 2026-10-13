// Raw SQLite row shapes (snake_case, JSON stored as text). These differ from
// the domain types and are mapped by the repository layer.

export interface OnboardingCaseRow {
  id: string;
  customer_full_name: string;
  date_of_birth: string;
  nationality: string;
  residential_address: string;
  occupation: string | null;
  declared_annual_income: number | null;
  product_type: string;
  identity_verification_status: string;
  case_status: string;
  created_at: string;
  updated_at: string;
}

export interface SupportingDocumentRow {
  id: number;
  case_id: string;
  document_type: string;
  document_subtype: string;
  document_reference: string;
  name_on_document: string;
  address_on_document: string | null;
  date_of_birth_on_document: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  status: string;
  created_at: string;
}

export interface RiskIndicatorRow {
  id: number;
  case_id: string;
  indicator_code: string;
  severity: string;
  status: string;
  description: string;
  raised_at: string;
  resolved_at: string | null;
}

export interface WorkflowExecutionRow {
  id: string;
  case_id: string;
  autonomy_mode: string;
  status: string;
  recommendation: string | null;
  recommendation_reason: string | null; // JSON-encoded RecommendationOutput
  final_outcome: string | null;
  outcome_source: string | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface AgentResultRow {
  id: number;
  execution_id: string;
  agent_name: string;
  attempt: number;
  status: string;
  output_json: string | null;
  error_message: string | null;
  started_at: string;
  completed_at: string;
}

export interface AuditEventRow {
  id: number;
  case_id: string;
  execution_id: string | null;
  event_type: string;
  actor: string;
  details_json: string | null;
  created_at: string;
}

export interface HumanDecisionRow {
  id: number;
  execution_id: string;
  decision: string;
  reviewer_name: string;
  comment: string | null;
  decided_at: string;
}
