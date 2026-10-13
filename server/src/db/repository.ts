// Persistence layer: all SQL lives here. Maps snake_case rows to domain types
// and validates them with the shared Zod schemas on the way out.
import { OnboardingCaseSchema } from '../schemas/domain';
import type { CreateCaseRequest } from '../schemas/api';
import { WorkflowExecutionSchema } from '../schemas/workflow';
import type {
  AgentResultRow,
  AuditEventRow,
  HumanDecisionRow,
  OnboardingCaseRow,
  RiskIndicatorRow,
  SupportingDocumentRow,
  WorkflowExecutionRow,
} from '../types/dbRecords';
import type {
  AuditEventType,
  CaseStatus,
  HumanDecisionRequest,
  CaseSummary,
  ExecutionSummary,
  OnboardingCase,
  RiskLevel,
  WorkflowExecution,
  WorkflowState,
} from '../types';
import type { Db } from './connection';

const parseJson = (text: string | null): unknown => (text === null ? null : JSON.parse(text));

export class Repository {
  constructor(private readonly db: Db) {}

  // Runs fn atomically; better-sqlite3 transactions are synchronous.
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  ping(): boolean {
    return (this.db.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
  }

  // ---------- Cases ----------

  listCases(): CaseSummary[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.customer_full_name, c.product_type, c.case_status, c.identity_verification_status, c.created_at,
                (SELECT COUNT(*) FROM supporting_documents d WHERE d.case_id = c.id) AS document_count,
                (SELECT COUNT(*) FROM risk_indicators r WHERE r.case_id = c.id AND r.status = 'open') AS open_risk_count,
                (SELECT w.id FROM workflow_executions w WHERE w.case_id = c.id ORDER BY w.started_at DESC, w.rowid DESC LIMIT 1) AS latest_id
           FROM onboarding_cases c
          ORDER BY c.id`,
      )
      .all() as (OnboardingCaseRow & { document_count: number; open_risk_count: number; latest_id: string | null })[];

    const latest = this.db.prepare(
      `SELECT w.id, w.status, w.recommendation,
              (SELECT json_extract(a.output_json, '$.riskLevel') FROM agent_results a
                WHERE a.execution_id = w.id AND a.agent_name = 'risk_indicator' AND a.status = 'success'
                ORDER BY a.attempt DESC LIMIT 1) AS riskLevel
         FROM workflow_executions w WHERE w.id = ?`,
    );
    return rows.map((r) => ({
      id: r.id,
      customerFullName: r.customer_full_name,
      productType: r.product_type,
      caseStatus: r.case_status,
      identityVerificationStatus: r.identity_verification_status,
      documentCount: r.document_count,
      openRiskCount: r.open_risk_count,
      latestExecution: r.latest_id
        ? (latest.get(r.latest_id) as { id: string; status: string; recommendation: string | null; riskLevel: RiskLevel | null })
        : null,
      createdAt: r.created_at,
    }));
  }

  getCase(id: string): OnboardingCase | null {
    const c = this.db.prepare('SELECT * FROM onboarding_cases WHERE id = ?').get(id) as OnboardingCaseRow | undefined;
    if (!c) return null;
    const docs = this.db
      .prepare('SELECT * FROM supporting_documents WHERE case_id = ? ORDER BY document_type')
      .all(id) as SupportingDocumentRow[];
    const risks = this.db
      .prepare('SELECT * FROM risk_indicators WHERE case_id = ? ORDER BY id')
      .all(id) as RiskIndicatorRow[];

    return OnboardingCaseSchema.parse({
      id: c.id,
      customerFullName: c.customer_full_name,
      dateOfBirth: c.date_of_birth,
      nationality: c.nationality,
      residentialAddress: c.residential_address,
      occupation: c.occupation,
      declaredAnnualIncome: c.declared_annual_income,
      productType: c.product_type,
      identityVerificationStatus: c.identity_verification_status,
      caseStatus: c.case_status,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      documents: docs.map((d) => ({
        id: d.id,
        documentType: d.document_type,
        documentSubtype: d.document_subtype,
        documentReference: d.document_reference,
        nameOnDocument: d.name_on_document,
        addressOnDocument: d.address_on_document,
        dateOfBirthOnDocument: d.date_of_birth_on_document,
        issueDate: d.issue_date,
        expiryDate: d.expiry_date,
        status: d.status,
      })),
      riskIndicators: risks.map((r) => ({
        id: r.id,
        code: r.indicator_code,
        severity: r.severity,
        status: r.status,
        description: r.description,
        raisedAt: r.raised_at,
        resolvedAt: r.resolved_at,
      })),
    });
  }

  createCase(input: CreateCaseRequest, now: string): OnboardingCase {
    const id = this.transaction(() => {
      const ids = this.db.prepare("SELECT id FROM onboarding_cases WHERE id LIKE 'CASE-%'").all() as { id: string }[];
      const next = Math.max(1000, ...ids.map((r) => Number(r.id.slice(5)) || 0)) + 1;
      const caseId = `CASE-${next}`;

      this.db
        .prepare(
          `INSERT INTO onboarding_cases (id, customer_full_name, date_of_birth, nationality, residential_address,
             occupation, declared_annual_income, product_type, identity_verification_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(caseId, input.customerFullName, input.dateOfBirth, input.nationality, input.residentialAddress,
          input.occupation, input.declaredAnnualIncome, input.productType, input.identityVerificationStatus, now, now);

      const insertDoc = this.db.prepare(
        `INSERT INTO supporting_documents (case_id, document_type, document_subtype, document_reference, name_on_document,
           address_on_document, date_of_birth_on_document, issue_date, expiry_date, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const d of input.documents) {
        insertDoc.run(caseId, d.documentType, d.documentSubtype, d.documentReference, d.nameOnDocument,
          d.addressOnDocument, d.dateOfBirthOnDocument, d.issueDate, d.expiryDate, d.status, now);
      }

      const insertRisk = this.db.prepare(
        `INSERT INTO risk_indicators (case_id, indicator_code, severity, status, description, raised_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of input.riskIndicators) {
        insertRisk.run(caseId, r.code, r.severity, r.status, r.description, now, r.status === 'open' ? null : now);
      }

      this.appendAuditEvent({ caseId, executionId: null, eventType: 'CASE_CREATED', actor: 'api', details: { synthetic: true }, createdAt: now });
      return caseId;
    });
    return this.getCase(id)!;
  }

  updateCaseStatus(caseId: string, status: CaseStatus): void {
    this.db.prepare('UPDATE onboarding_cases SET case_status = ? WHERE id = ?').run(status, caseId);
  }

  // ---------- Executions ----------

  // Executions still waiting for a person (at most one should exist per case).
  findOpenExecution(caseId: string): ExecutionSummary | null {
    const row = this.db
      .prepare(
        `SELECT * FROM workflow_executions
          WHERE case_id = ? AND status IN ('needs_human_approval', 'needs_manual_review')
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(caseId) as WorkflowExecutionRow | undefined;
    return row ? toSummary(row) : null;
  }

  saveExecution(execution: WorkflowExecution): void {
    this.db
      .prepare(
        `INSERT INTO workflow_executions (id, case_id, autonomy_mode, status, recommendation, recommendation_reason,
           final_outcome, outcome_source, error_message, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        execution.id,
        execution.caseId,
        execution.autonomyMode,
        execution.status,
        execution.recommendation?.recommendation ?? null,
        execution.recommendation ? JSON.stringify(execution.recommendation) : null,
        execution.finalOutcome,
        execution.outcomeSource,
        execution.errorMessage,
        execution.startedAt,
        execution.completedAt,
      );

    const insertAttempt = this.db.prepare(
      `INSERT INTO agent_results (execution_id, agent_name, attempt, status, output_json, error_message, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const a of execution.agentAttempts) {
      insertAttempt.run(execution.id, a.agentName, a.attempt, a.status,
        a.output === null ? null : JSON.stringify(a.output), a.errorMessage, a.startedAt, a.completedAt);
    }

    for (const e of execution.auditEvents) {
      this.appendAuditEvent({ ...e, executionId: execution.id });
    }
  }

  updateExecutionOutcome(
    executionId: string,
    fields: { status: WorkflowState; finalOutcome: 'approved' | 'rejected'; outcomeSource: 'human'; completedAt: string },
  ): void {
    this.db
      .prepare('UPDATE workflow_executions SET status = ?, final_outcome = ?, outcome_source = ?, completed_at = ? WHERE id = ?')
      .run(fields.status, fields.finalOutcome, fields.outcomeSource, fields.completedAt, executionId);
  }

  listExecutions(caseId: string): ExecutionSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM workflow_executions WHERE case_id = ? ORDER BY started_at DESC, rowid DESC')
      .all(caseId) as WorkflowExecutionRow[];
    return rows.map(toSummary);
  }

  getExecution(id: string): WorkflowExecution | null {
    const row = this.db.prepare('SELECT * FROM workflow_executions WHERE id = ?').get(id) as WorkflowExecutionRow | undefined;
    if (!row) return null;
    const attempts = this.db
      .prepare('SELECT * FROM agent_results WHERE execution_id = ? ORDER BY id')
      .all(id) as AgentResultRow[];
    const events = this.db
      .prepare('SELECT * FROM audit_events WHERE execution_id = ? ORDER BY id')
      .all(id) as AuditEventRow[];
    const decision = this.db
      .prepare('SELECT * FROM human_decisions WHERE execution_id = ?')
      .get(id) as HumanDecisionRow | undefined;

    return WorkflowExecutionSchema.parse({
      id: row.id,
      caseId: row.case_id,
      autonomyMode: row.autonomy_mode,
      status: row.status,
      recommendation: parseJson(row.recommendation_reason),
      finalOutcome: row.final_outcome,
      outcomeSource: row.outcome_source,
      errorMessage: row.error_message,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      agentAttempts: attempts.map((a) => ({
        id: a.id,
        agentName: a.agent_name,
        attempt: a.attempt,
        status: a.status,
        output: parseJson(a.output_json),
        errorMessage: a.error_message,
        startedAt: a.started_at,
        completedAt: a.completed_at,
      })),
      auditEvents: events.map((e) => ({
        id: e.id,
        caseId: e.case_id,
        executionId: e.execution_id,
        eventType: e.event_type,
        actor: e.actor,
        details: parseJson(e.details_json),
        createdAt: e.created_at,
      })),
      humanDecision: decision
        ? {
            id: decision.id,
            executionId: decision.execution_id,
            decision: decision.decision,
            reviewerName: decision.reviewer_name,
            comment: decision.comment,
            decidedAt: decision.decided_at,
          }
        : null,
    });
  }

  // ---------- Human decisions and audit ----------

  insertHumanDecision(executionId: string, request: HumanDecisionRequest, decidedAt: string): void {
    this.db
      .prepare('INSERT INTO human_decisions (execution_id, decision, reviewer_name, comment, decided_at) VALUES (?, ?, ?, ?, ?)')
      .run(executionId, request.decision, request.reviewerName, request.comment ?? null, decidedAt);
  }

  appendAuditEvent(e: {
    caseId: string;
    executionId: string | null;
    eventType: AuditEventType;
    actor: string;
    details: Record<string, unknown> | null;
    createdAt: string;
  }): void {
    this.db
      .prepare('INSERT INTO audit_events (case_id, execution_id, event_type, actor, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.caseId, e.executionId, e.eventType, e.actor, e.details === null ? null : JSON.stringify(e.details), e.createdAt);
  }
}

function toSummary(r: WorkflowExecutionRow): ExecutionSummary {
  return {
    id: r.id,
    autonomyMode: r.autonomy_mode,
    status: r.status,
    recommendation: r.recommendation,
    finalOutcome: r.final_outcome,
    outcomeSource: r.outcome_source,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  };
}
