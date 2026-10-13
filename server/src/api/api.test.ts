// End-to-end API tests: real Express app + real schema/seed in an in-memory
// SQLite database, exercised over HTTP. Each test gets a fresh database.
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { config } from '../config';
import { type Db, openDatabase } from '../db/connection';
import type { WorkflowExecution } from '../types';

let db: Db;
let server: Server;
let base: string;

beforeEach(async () => {
  db = openDatabase(':memory:', { schemaPath: config.schemaPath, seedPath: config.seedPath });
  server = createApp(db, { maxAgentAttempts: 2 }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

async function api(method: string, path: string, body?: unknown, rawBody?: string) {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined || rawBody !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function review(caseId: string, autonomyMode: string, extra: object = {}) {
  const res = await api('POST', `/cases/${caseId}/review`, { autonomyMode, ...extra });
  expect(res.status).toBe(201);
  return res.body.execution as WorkflowExecution;
}

const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;

describe('health and case retrieval', () => {
  it('reports healthy and lists the three seeded cases', async () => {
    expect(await api('GET', '/health')).toEqual({ status: 200, body: { status: 'ok', database: 'ok' } });

    const { status, body } = await api('GET', '/cases');
    expect(status).toBe(200);
    expect(body.cases.map((c: any) => [c.id, c.caseStatus, c.documentCount, c.openRiskCount])).toEqual([
      ['CASE-1001', 'new', 3, 0],
      ['CASE-1002', 'new', 2, 0],
      ['CASE-1003', 'new', 3, 1],
    ]);

    const one = await api('GET', '/cases/CASE-1003');
    expect(one.status).toBe(200);
    expect(one.body.case.identityVerificationStatus).toBe('pending');
    expect(one.body.case.riskIndicators[0]).toMatchObject({ code: 'WATCHLIST_NAME_SIMILARITY', severity: 'high', status: 'open' });
  });
});

describe('workflow outcomes for the seeded cases', () => {
  it.each([
    ['CASE-1001', 'exception_only', 'approve', 'completed', 'approved', 'auto_policy', 'approved'],
    ['CASE-1001', 'human_approval_required', 'approve', 'needs_human_approval', null, null, 'needs_human_approval'],
    ['CASE-1002', 'exception_only', 'refer_for_manual_review', 'needs_manual_review', null, null, 'needs_manual_review'],
    ['CASE-1002', 'human_approval_required', 'refer_for_manual_review', 'needs_human_approval', null, null, 'needs_human_approval'],
    ['CASE-1003', 'exception_only', 'refer_for_manual_review', 'needs_manual_review', null, null, 'needs_manual_review'],
    ['CASE-1003', 'human_approval_required', 'refer_for_manual_review', 'needs_human_approval', null, null, 'needs_human_approval'],
  ])('%s in %s -> %s / %s', async (caseId, mode, recommendation, status, finalOutcome, outcomeSource, caseStatus) => {
    const e = await review(caseId, mode);

    expect(e.recommendation?.recommendation).toBe(recommendation);
    expect(e).toMatchObject({ status, finalOutcome, outcomeSource, humanDecision: null });
    expect((await api('GET', `/cases/${caseId}`)).body.case.caseStatus).toBe(caseStatus);
  });

  it('persists the ordered trace and every agent result', async () => {
    const created = await review('CASE-1003', 'exception_only');
    const { status, body } = await api('GET', `/executions/${created.id}`);
    const e = body.execution as WorkflowExecution;

    expect(status).toBe(200);
    expect(e.agentAttempts.map((a) => `${a.agentName}:${a.status}`)).toEqual([
      'document_completeness:success',
      'identity_consistency:success',
      'risk_indicator:success',
      'recommendation:success',
    ]);
    const risk = e.agentAttempts.find((a) => a.agentName === 'risk_indicator')?.output as any;
    expect(risk).toMatchObject({ riskLevel: 'high', escalationRequired: true });
    expect(e.auditEvents.map((a) => a.eventType)).toEqual([
      'WORKFLOW_STARTED', 'STATUS_CHANGED',
      'AGENT_STARTED', 'AGENT_SUCCEEDED', 'AGENT_STARTED', 'AGENT_SUCCEEDED',
      'AGENT_STARTED', 'AGENT_SUCCEEDED', 'AGENT_STARTED', 'AGENT_SUCCEEDED',
      'RECOMMENDATION_MADE', 'STATUS_CHANGED', 'WORKFLOW_FINISHED',
    ]);
    // Database rows, not just the response.
    expect(count('SELECT COUNT(*) AS n FROM agent_results WHERE execution_id = ?', e.id)).toBe(4);
    expect(count('SELECT COUNT(*) AS n FROM audit_events WHERE execution_id = ?', e.id)).toBe(13);

    const list = await api('GET', '/cases/CASE-1003/executions');
    expect(list.body.executions.map((x: any) => x.id)).toEqual([e.id]);
  });
});

describe('human decisions', () => {
  it('waits for a decision in human-approval mode, then records it exactly once', async () => {
    const e = await review('CASE-1001', 'human_approval_required');
    expect(count('SELECT COUNT(*) AS n FROM human_decisions')).toBe(0);

    const decided = await api('POST', `/executions/${e.id}/decision`, { decision: 'approved', reviewerName: 'Reviewer A' });
    expect(decided.status).toBe(201);
    expect(decided.body.execution).toMatchObject({
      status: 'completed',
      finalOutcome: 'approved',
      outcomeSource: 'human',
      humanDecision: { decision: 'approved', reviewerName: 'Reviewer A' },
    });
    expect(decided.body.execution.recommendation.recommendation).toBe('approve'); // unchanged
    expect(decided.body.execution.auditEvents.slice(-3).map((a: any) => a.eventType)).toEqual([
      'HUMAN_DECISION_RECORDED', 'STATUS_CHANGED', 'WORKFLOW_FINISHED',
    ]);
    expect((await api('GET', '/cases/CASE-1001')).body.case.caseStatus).toBe('approved');

    const again = await api('POST', `/executions/${e.id}/decision`, { decision: 'rejected', reviewerName: 'Reviewer B', comment: 'x' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DECISION_ALREADY_RECORDED');
    expect(count('SELECT COUNT(*) AS n FROM human_decisions')).toBe(1);
  });

  it('accepts only one of several concurrent conflicting decisions', async () => {
    const e = await review('CASE-1002', 'human_approval_required');
    const results = await Promise.all(
      ['approved', 'rejected', 'approved', 'rejected'].map((decision) =>
        api('POST', `/executions/${e.id}/decision`, { decision, reviewerName: 'R', comment: 'c' }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect(count('SELECT COUNT(*) AS n FROM human_decisions')).toBe(1);
  });

  it('requires a comment when overriding a referral, and refuses decisions on non-pending executions', async () => {
    const referred = await review('CASE-1003', 'exception_only');
    const noComment = await api('POST', `/executions/${referred.id}/decision`, { decision: 'approved', reviewerName: 'R' });
    expect(noComment.status).toBe(422);
    expect(noComment.body.error.code).toBe('COMMENT_REQUIRED');

    const auto = await review('CASE-1001', 'exception_only');
    const late = await api('POST', `/executions/${auto.id}/decision`, { decision: 'rejected', reviewerName: 'R', comment: 'x' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('EXECUTION_NOT_AWAITING_DECISION');
  });

  it('refuses a second review while a decision is pending', async () => {
    await review('CASE-1002', 'human_approval_required');
    const second = await api('POST', '/cases/CASE-1002/review', { autonomyMode: 'exception_only' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('DECISION_PENDING');
  });
});

describe('failed agents never produce automatic approval', () => {
  it.each(['document_completeness', 'identity_consistency', 'risk_indicator'])(
    'routine CASE-1001 with a failing %s agent is escalated, not auto-approved',
    async (agent) => {
      const e = await review('CASE-1001', 'exception_only', { simulateFailure: agent });

      expect(e.status).toBe('needs_manual_review');
      expect(e.recommendation?.ruleApplied).toBe('R1_INCOMPLETE_CHECKS_REFER');
      expect(e.finalOutcome).toBeNull();
      expect(e.agentAttempts.filter((a) => a.agentName === agent).map((a) => a.status)).toEqual(['error', 'error']);
      expect((await api('GET', '/cases/CASE-1001')).body.case.caseStatus).toBe('needs_manual_review');
      expect(count("SELECT COUNT(*) AS n FROM workflow_executions WHERE final_outcome IS NOT NULL")).toBe(0);
    },
  );

  it('a failed Recommendation agent ends the workflow as failed, without a recommendation or decision', async () => {
    const e = await review('CASE-1001', 'exception_only', { simulateFailure: 'recommendation' });

    expect(e).toMatchObject({ status: 'failed', recommendation: null, finalOutcome: null });
    expect(e.errorMessage).toContain('Recommendation agent failed');
    const decision = await api('POST', `/executions/${e.id}/decision`, { decision: 'approved', reviewerName: 'R', comment: 'x' });
    expect(decision.status).toBe(409);
    // A failed run can be retried.
    expect((await review('CASE-1001', 'exception_only')).status).toBe('completed');
  });
});

describe('invalid input', () => {
  it.each([
    ['GET', '/cases/bad-id', undefined, 400, 'VALIDATION_ERROR'],
    ['GET', '/cases/CASE-9999', undefined, 404, 'NOT_FOUND'],
    ['POST', '/cases/CASE-9999/review', { autonomyMode: 'exception_only' }, 404, 'NOT_FOUND'],
    ['GET', '/executions/not-a-uuid', undefined, 400, 'VALIDATION_ERROR'],
    ['GET', '/executions/00000000-0000-4000-8000-000000000000', undefined, 404, 'NOT_FOUND'],
    ['POST', '/cases/CASE-1001/review', {}, 400, 'VALIDATION_ERROR'],
    ['POST', '/cases/CASE-1001/review', { autonomyMode: 'fully_automatic' }, 400, 'VALIDATION_ERROR'],
    ['POST', '/cases/CASE-1001/review', { autonomyMode: 'exception_only', simulateFailure: 'nope' }, 400, 'VALIDATION_ERROR'],
    ['POST', '/executions/00000000-0000-4000-8000-000000000000/decision', { decision: 'maybe', reviewerName: 'R' }, 400, 'VALIDATION_ERROR'],
    ['POST', '/cases', { customerFullName: 'No Confirmation' }, 400, 'VALIDATION_ERROR'],
    ['GET', '/does-not-exist', undefined, 404, 'NOT_FOUND'],
  ])('%s %s -> %i %s', async (method, path, body, status, code) => {
    const res = await api(method, path, body);
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
  });

  it('rejects malformed JSON', async () => {
    const res = await api('POST', '/cases/CASE-1001/review', undefined, '{not json');
    expect(res).toMatchObject({ status: 400, body: { error: { code: 'INVALID_JSON' } } });
  });

  it('creates a valid synthetic case and reviews it', async () => {
    const created = await api('POST', '/cases', {
      syntheticDataConfirmed: true,
      customerFullName: 'Nadia Quill',
      dateOfBirth: '1985-03-14',
      nationality: 'Fictlandia',
      residentialAddress: '3 Demo Close, Sampletown, ZZ5 5EE',
      occupation: null,
      declaredAnnualIncome: null,
      productType: 'current_account',
    });
    expect(created.status).toBe(201);
    expect(created.body.case.id).toBe('CASE-1004');

    // No documents and identity pending: must be escalated, never approved.
    const e = await review('CASE-1004', 'exception_only');
    expect(e.recommendation?.recommendation).toBe('refer_for_manual_review');
    expect(e.status).toBe('needs_manual_review');
  });
});
