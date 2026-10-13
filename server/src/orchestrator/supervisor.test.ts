import { describe, expect, it } from 'vitest';
import { documentCompletenessAgent } from '../agents/documentCompleteness';
import { riskIndicatorAgent } from '../agents/riskIndicator';
import { CASE_1001, CASE_1002, CASE_1003 } from '../testFixtures/cases';
import type { AutonomyMode, OnboardingCase, RecommendationOutput } from '../types';
import { applyAutonomy } from './policy';
import { InvalidWorkflowInputError, runWorkflow } from './supervisor';

const now = () => new Date('2026-10-12T10:00:00.000Z');
const run = (c: OnboardingCase, mode: AutonomyMode, options = {}) => runWorkflow(c, mode, { now, ...options });

const eventTypes = (r: Awaited<ReturnType<typeof runWorkflow>>) => r.execution.auditEvents.map((e) => e.eventType);
const attemptsOf = (r: Awaited<ReturnType<typeof runWorkflow>>, agent: string) =>
  r.execution.agentAttempts.filter((a) => a.agentName === agent);

describe('Supervisor — routine case', () => {
  it('auto-progresses CASE-1001 in exception-only mode with the full ordered trace', async () => {
    const r = await run(CASE_1001, 'exception_only');

    expect(r.execution).toMatchObject({
      status: 'completed',
      finalOutcome: 'approved',
      outcomeSource: 'auto_policy',
      humanDecision: null,
      errorMessage: null,
    });
    expect(r.execution.recommendation?.recommendation).toBe('approve');
    expect(r.execution.completedAt).not.toBeNull();
    expect(eventTypes(r)).toEqual([
      'WORKFLOW_STARTED',
      'STATUS_CHANGED', // pending -> running
      'AGENT_STARTED', 'AGENT_SUCCEEDED', // document_completeness
      'AGENT_STARTED', 'AGENT_SUCCEEDED', // identity_consistency
      'AGENT_STARTED', 'AGENT_SUCCEEDED', // risk_indicator
      'AGENT_STARTED', 'AGENT_SUCCEEDED', // recommendation
      'RECOMMENDATION_MADE',
      'STATUS_CHANGED', // running -> completed
      'WORKFLOW_FINISHED',
    ]);
    expect(r.execution.auditEvents.filter((e) => e.eventType === 'AGENT_STARTED').map((e) => e.actor)).toEqual([
      'document_completeness',
      'identity_consistency',
      'risk_indicator',
      'recommendation',
    ]);
    expect(r.execution.auditEvents.map((e) => e.id)).toEqual(r.execution.auditEvents.map((_, i) => i + 1));
  });

  it('waits for a human in human-approval mode and records no decision automatically', async () => {
    const r = await run(CASE_1001, 'human_approval_required');

    expect(r.execution).toMatchObject({
      status: 'needs_human_approval',
      finalOutcome: null,
      outcomeSource: null,
      humanDecision: null,
      completedAt: null,
    });
    // Recommendation and workflow status are separate concepts.
    expect(r.execution.recommendation?.recommendation).toBe('approve');
  });
});

describe('Supervisor — cases requiring review', () => {
  it.each([
    ['CASE-1002 (missing income proof, name mismatch)', CASE_1002],
    ['CASE-1003 (pending verification, high-risk flag)', CASE_1003],
  ])('%s is referred and never auto-approved in either mode', async (_label, c) => {
    const exception = await run(c, 'exception_only');
    const human = await run(c, 'human_approval_required');

    expect(exception.execution.recommendation?.recommendation).toBe('refer_for_manual_review');
    expect(exception.execution.status).toBe('needs_manual_review');
    expect(exception.execution.finalOutcome).toBeNull();
    expect(human.execution.status).toBe('needs_human_approval');
    expect(human.execution.finalOutcome).toBeNull();
  });
});

describe('Supervisor — failures and retries', () => {
  it.each(['document_completeness', 'identity_consistency', 'risk_indicator'] as const)(
    'a persistently failing %s agent is retried once, marked incomplete, and never auto-approved',
    async (agent) => {
      for (const mode of ['exception_only', 'human_approval_required'] as const) {
        const r = await run(CASE_1001, mode, { simulateFailure: agent });

        expect(attemptsOf(r, agent).map((a) => a.status)).toEqual(['error', 'error']);
        expect(eventTypes(r)).toContain('AGENT_RETRY');
        expect(r.execution.auditEvents.find((e) => e.eventType === 'CHECK_INCOMPLETE')?.details).toMatchObject({ agent });
        expect(r.execution.recommendation?.ruleApplied).toBe('R1_INCOMPLETE_CHECKS_REFER');
        expect(r.execution.finalOutcome).toBeNull();
        expect(r.execution.status).toBe(mode === 'exception_only' ? 'needs_manual_review' : 'needs_human_approval');
      }
    },
  );

  it('recovers from a transient error on retry', async () => {
    let calls = 0;
    const flaky = {
      ...documentCompletenessAgent,
      run: async (input: Parameters<typeof documentCompletenessAgent.run>[0]) => {
        calls += 1;
        if (calls === 1) throw new Error('Temporary timeout');
        return documentCompletenessAgent.run(input);
      },
    };
    const r = await run(CASE_1001, 'exception_only', { agents: { document_completeness: flaky } });

    expect(attemptsOf(r, 'document_completeness').map((a) => a.status)).toEqual(['error', 'success']);
    expect(eventTypes(r).slice(2, 7)).toEqual(['AGENT_STARTED', 'AGENT_FAILED', 'AGENT_RETRY', 'AGENT_STARTED', 'AGENT_SUCCEEDED']);
    expect(r.execution.status).toBe('completed');
    expect(r.agentResults.document_completeness.attempts).toBe(2);
  });

  it('does not retry invalid output (deterministic) and escalates instead', async () => {
    const invalid = { ...riskIndicatorAgent, run: async () => ({ status: 'pass' }) as never };
    const r = await run(CASE_1001, 'exception_only', { agents: { risk_indicator: invalid } });

    expect(attemptsOf(r, 'risk_indicator').map((a) => a.status)).toEqual(['invalid_output']);
    expect(eventTypes(r)).toContain('AGENT_OUTPUT_INVALID');
    expect(eventTypes(r)).not.toContain('AGENT_RETRY');
    expect(r.execution.status).toBe('needs_manual_review');
  });

  it('terminates as failed, with no recommendation or outcome, when the Recommendation Agent fails', async () => {
    const r = await run(CASE_1001, 'exception_only', { simulateFailure: 'recommendation' });

    expect(r.execution).toMatchObject({ status: 'failed', recommendation: null, finalOutcome: null, outcomeSource: null });
    expect(r.execution.errorMessage).toContain('Recommendation agent failed after 2 attempt(s)');
    expect(r.execution.completedAt).not.toBeNull();
    expect(eventTypes(r).slice(-2)).toEqual(['STATUS_CHANGED', 'WORKFLOW_FINISHED']);
  });

  it('safety guard overrides an unsafe "approve" from a faulty Recommendation Agent', async () => {
    const reckless = {
      name: 'recommendation' as const,
      version: 'faulty',
      inputSchema: (await import('../schemas/agents')).RecommendationInputSchema,
      outputSchema: (await import('../schemas/agents')).RecommendationOutputSchema,
      // Claims everything passed, regardless of the real check results.
      run: async (): Promise<RecommendationOutput> => ({
        recommendation: 'approve',
        ruleApplied: 'R4_ALL_CHECKS_PASSED_APPROVE',
        explanation: 'Approve.',
        reasons: ['Looks fine.'],
        checkSummary: [
          { agent: 'document_completeness', result: 'pass' },
          { agent: 'identity_consistency', result: 'pass' },
          { agent: 'risk_indicator', result: 'pass' },
        ],
        supportingFindings: [],
        outstandingIssues: [],
        escalationReasons: [],
      }),
    };
    const r = await run(CASE_1003, 'exception_only', { agents: { recommendation: reckless } });

    expect(eventTypes(r)).toContain('SAFETY_OVERRIDE');
    expect(r.execution.recommendation?.recommendation).toBe('refer_for_manual_review');
    expect(r.execution.recommendation?.ruleApplied).toBe('SUPERVISOR_SAFETY_OVERRIDE');
    expect(r.execution.status).toBe('needs_manual_review');
    expect(r.execution.finalOutcome).toBeNull();
  });

  it('rejects an invalid case before creating any execution', async () => {
    const broken = { ...CASE_1001, dateOfBirth: 'not-a-date' };
    await expect(run(broken, 'exception_only')).rejects.toBeInstanceOf(InvalidWorkflowInputError);
    await expect(run(CASE_1001, 'fully_automatic' as AutonomyMode)).rejects.toBeInstanceOf(InvalidWorkflowInputError);
  });
});

describe('Autonomy policy', () => {
  const rec = (recommendation: RecommendationOutput['recommendation'], ruleApplied: RecommendationOutput['ruleApplied']) =>
    ({ recommendation, ruleApplied }) as RecommendationOutput;

  it.each([
    ['human_approval_required', 'approve', 'R4_ALL_CHECKS_PASSED_APPROVE', 'needs_human_approval', null],
    ['human_approval_required', 'reject', 'R2_EXPLICIT_REJECTION', 'needs_human_approval', null],
    ['human_approval_required', 'refer_for_manual_review', 'R3_UNRESOLVED_ISSUES_REFER', 'needs_human_approval', null],
    ['exception_only', 'approve', 'R4_ALL_CHECKS_PASSED_APPROVE', 'completed', 'approved'],
    ['exception_only', 'reject', 'R2_EXPLICIT_REJECTION', 'needs_manual_review', null],
    ['exception_only', 'refer_for_manual_review', 'R1_INCOMPLETE_CHECKS_REFER', 'needs_manual_review', null],
    ['exception_only', 'refer_for_manual_review', 'SUPERVISOR_SAFETY_OVERRIDE', 'needs_manual_review', null],
  ] as const)('%s + %s (%s) -> %s', (mode, recommendation, rule, status, outcome) => {
    const d = applyAutonomy(mode, rec(recommendation, rule));
    expect(d.status).toBe(status);
    expect(d.finalOutcome).toBe(outcome);
  });
});
