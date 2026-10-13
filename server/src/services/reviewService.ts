// Business logic between the HTTP layer and persistence/orchestration:
// starting reviews, guarding against conflicting work, and recording human
// decisions. A human decision is the only way an outcome is set by a person.
import { conflict, HttpError, notFound } from '../api/errors';
import type { CreateCaseRequest } from '../schemas/api';
import type { Repository } from '../db/repository';
import { runWorkflow } from '../orchestrator/supervisor';
import type { CaseStatus, HumanDecisionRequest, OnboardingCase, RunWorkflowRequest, WorkflowExecution } from '../types';

const AWAITING_DECISION = ['needs_human_approval', 'needs_manual_review'] as const;

// Case status shown on the case after a workflow run.
function caseStatusAfterRun(e: WorkflowExecution): CaseStatus {
  if (e.status === 'completed') return e.finalOutcome === 'rejected' ? 'rejected' : 'approved';
  if (e.status === 'needs_human_approval') return 'needs_human_approval';
  if (e.status === 'needs_manual_review') return 'needs_manual_review';
  return 'in_review'; // failed: review attempted, no outcome; can be re-run
}

export class ReviewService {
  private readonly reviewsInFlight = new Set<string>();

  constructor(
    private readonly repo: Repository,
    private readonly options: { maxAgentAttempts: number; now?: () => Date } = { maxAgentAttempts: 2 },
  ) {}

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  listCases() {
    return this.repo.listCases();
  }

  getCase(id: string): OnboardingCase {
    return this.repo.getCase(id) ?? (() => { throw notFound('Case', id); })();
  }

  createCase(input: CreateCaseRequest): OnboardingCase {
    return this.repo.createCase(input, this.now());
  }

  listExecutions(caseId: string) {
    this.getCase(caseId);
    return this.repo.listExecutions(caseId);
  }

  getExecution(id: string): WorkflowExecution {
    return this.repo.getExecution(id) ?? (() => { throw notFound('Execution', id); })();
  }

  // Refuses a review that could lead to conflicting decisions (persisted state).
  private assertNoConflictingWork(c: OnboardingCase): void {
    const open = this.repo.findOpenExecution(c.id);
    if (open) {
      throw conflict('DECISION_PENDING', `${c.id} already has an execution awaiting a human decision`, { executionId: open.id, status: open.status });
    }
    if (c.caseStatus === 'approved' || c.caseStatus === 'rejected') {
      throw conflict('CASE_ALREADY_DECIDED', `${c.id} already has a final outcome (${c.caseStatus})`);
    }
  }

  async reviewCase(caseId: string, request: RunWorkflowRequest): Promise<WorkflowExecution> {
    const onboardingCase = this.getCase(caseId);
    if (this.reviewsInFlight.has(caseId)) {
      throw conflict('REVIEW_IN_PROGRESS', `A review of ${caseId} is already running`);
    }
    this.assertNoConflictingWork(onboardingCase);

    this.reviewsInFlight.add(caseId);
    try {
      const { execution } = await runWorkflow(onboardingCase, request.autonomyMode, {
        maxAttempts: this.options.maxAgentAttempts,
        simulateFailure: request.simulateFailure,
        now: this.options.now,
      });
      this.repo.transaction(() => {
        this.assertNoConflictingWork(this.getCase(caseId)); // re-check inside the write transaction
        this.repo.saveExecution(execution);
        this.repo.updateCaseStatus(caseId, caseStatusAfterRun(execution));
      });
      return this.getExecution(execution.id);
    } finally {
      this.reviewsInFlight.delete(caseId);
    }
  }

  recordHumanDecision(executionId: string, request: HumanDecisionRequest): WorkflowExecution {
    this.repo.transaction(() => {
      const execution = this.getExecution(executionId);

      if (execution.humanDecision) {
        throw conflict('DECISION_ALREADY_RECORDED', 'A human decision has already been recorded for this execution', {
          existingDecision: execution.humanDecision,
        });
      }
      if (!(AWAITING_DECISION as readonly string[]).includes(execution.status)) {
        throw conflict('EXECUTION_NOT_AWAITING_DECISION', `Execution status is '${execution.status}'; it is not awaiting a human decision`);
      }

      const recommendation = execution.recommendation?.recommendation ?? null;
      const followsRecommendation =
        (recommendation === 'approve' && request.decision === 'approved') ||
        (recommendation === 'reject' && request.decision === 'rejected');
      if (!followsRecommendation && !request.comment) {
        throw new HttpError(422, 'COMMENT_REQUIRED', 'A comment is required when the decision does not follow an approve/reject recommendation');
      }

      const decidedAt = this.now();
      this.repo.insertHumanDecision(executionId, request, decidedAt);
      this.repo.updateExecutionOutcome(executionId, {
        status: 'completed',
        finalOutcome: request.decision,
        outcomeSource: 'human',
        completedAt: decidedAt,
      });
      this.repo.updateCaseStatus(execution.caseId, request.decision);

      const audit = (eventType: 'HUMAN_DECISION_RECORDED' | 'STATUS_CHANGED' | 'WORKFLOW_FINISHED', actor: string, details: Record<string, unknown>) =>
        this.repo.appendAuditEvent({ caseId: execution.caseId, executionId, eventType, actor, details, createdAt: decidedAt });
      audit('HUMAN_DECISION_RECORDED', request.reviewerName, {
        decision: request.decision,
        recommendation,
        followsRecommendation,
        comment: request.comment ?? null,
      });
      audit('STATUS_CHANGED', 'supervisor', { from: execution.status, to: 'completed', reason: 'Human decision recorded.' });
      audit('WORKFLOW_FINISHED', 'supervisor', { status: 'completed', finalOutcome: request.decision, outcomeSource: 'human' });
    });
    return this.getExecution(executionId);
  }
}
