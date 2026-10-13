// Workflow supervisor: runs the agents in dependency order, retries transient
// failures, records an ordered trace, applies the safety guard and autonomy
// policy, and returns the complete workflow result. Agents never call each
// other; every hand-off goes through here.
//
// Sequence:  document_completeness -> identity_consistency   (independent checks)
//            -> risk_indicator (uses both results)
//            -> recommendation (uses all three) -> safety guard -> autonomy policy
//
// Termination:
//   completed            exception-only mode and a guarded R4 'approve'
//   needs_human_approval human-approval mode, once a recommendation exists
//   needs_manual_review  exception-only mode and anything other than a clean approve
//   failed               the Recommendation Agent could not produce a valid result
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { documentCompletenessAgent } from '../agents/documentCompleteness';
import { identityConsistencyAgent } from '../agents/identityConsistency';
import { recommendationAgent } from '../agents/recommendation';
import { riskIndicatorAgent } from '../agents/riskIndicator';
import { type Agent, type AgentExecution, executeAgent } from '../agents/types';
import { OnboardingCaseSchema } from '../schemas/domain';
import { AutonomyModeSchema, WorkflowExecutionSchema } from '../schemas/workflow';
import type {
  AgentAttempt,
  AgentName,
  AuditEvent,
  AuditEventType,
  AutonomyMode,
  DocumentCompletenessInput,
  DocumentCompletenessOutput,
  IdentityConsistencyInput,
  IdentityConsistencyOutput,
  OnboardingCase,
  RecommendationInput,
  RecommendationOutput,
  RiskIndicatorInput,
  RiskIndicatorOutput,
  WorkflowExecution,
  WorkflowState,
} from '../types';
import { applyAutonomy, safetyGuard } from './policy';

export const DEFAULT_MAX_ATTEMPTS = 2; // 1 initial attempt + 1 retry

export interface WorkflowAgents {
  document_completeness: Agent<'document_completeness', DocumentCompletenessInput, DocumentCompletenessOutput>;
  identity_consistency: Agent<'identity_consistency', IdentityConsistencyInput, IdentityConsistencyOutput>;
  risk_indicator: Agent<'risk_indicator', RiskIndicatorInput, RiskIndicatorOutput>;
  recommendation: Agent<'recommendation', RecommendationInput, RecommendationOutput>;
}

export const defaultAgents: WorkflowAgents = {
  document_completeness: documentCompletenessAgent,
  identity_consistency: identityConsistencyAgent,
  risk_indicator: riskIndicatorAgent,
  recommendation: recommendationAgent,
};

export interface RunWorkflowOptions {
  agents?: Partial<WorkflowAgents>; // dependency injection for tests / a future LLM agent
  maxAttempts?: number;
  simulateFailure?: AgentName; // demo aid: the named agent throws on every attempt
  now?: () => Date;
}

export interface WorkflowRunResult {
  execution: WorkflowExecution;
  agentResults: {
    document_completeness: AgentExecution<'document_completeness', DocumentCompletenessOutput>;
    identity_consistency: AgentExecution<'identity_consistency', IdentityConsistencyOutput>;
    risk_indicator: AgentExecution<'risk_indicator', RiskIndicatorOutput>;
    recommendation: AgentExecution<'recommendation', RecommendationOutput>;
  };
}

// Thrown before any execution is created when the case or mode is invalid.
export class InvalidWorkflowInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWorkflowInputError';
  }
}

function withSimulatedFailure<N extends AgentName, I, O>(agent: Agent<N, I, O>): Agent<N, I, O> {
  return {
    ...agent,
    run: async () => {
      throw new Error(`Simulated failure of the ${agent.name} agent`);
    },
  };
}

export async function runWorkflow(
  rawCase: OnboardingCase,
  rawMode: AutonomyMode,
  options: RunWorkflowOptions = {},
): Promise<WorkflowRunResult> {
  // Validate at the boundary; nothing is recorded for invalid input.
  const parsedCase = OnboardingCaseSchema.safeParse(rawCase);
  if (!parsedCase.success) throw new InvalidWorkflowInputError(`Invalid onboarding case: ${z.prettifyError(parsedCase.error)}`);
  const parsedMode = AutonomyModeSchema.safeParse(rawMode);
  if (!parsedMode.success) throw new InvalidWorkflowInputError(`Invalid autonomy mode: ${String(rawMode)}`);
  const onboardingCase = parsedCase.data;
  const mode = parsedMode.data;

  const now = options.now ?? (() => new Date());
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const agents: WorkflowAgents = { ...defaultAgents, ...options.agents };
  if (options.simulateFailure) {
    const name = options.simulateFailure;
    (agents as Record<AgentName, Agent<AgentName, unknown, unknown>>)[name] = withSimulatedFailure(
      agents[name] as Agent<AgentName, unknown, unknown>,
    );
  }

  const execution: WorkflowExecution = {
    id: randomUUID(),
    caseId: onboardingCase.id,
    autonomyMode: mode,
    status: 'pending',
    recommendation: null,
    finalOutcome: null,
    outcomeSource: null,
    errorMessage: null,
    startedAt: now().toISOString(),
    completedAt: null,
    agentAttempts: [],
    auditEvents: [],
    humanDecision: null,
  };

  const record = (eventType: AuditEventType, actor: string, details: Record<string, unknown> | null = null) => {
    const event: AuditEvent = {
      id: execution.auditEvents.length + 1, // in-memory sequence; the database assigns its own ids
      caseId: execution.caseId,
      executionId: execution.id,
      eventType,
      actor,
      details,
      createdAt: now().toISOString(),
    };
    execution.auditEvents.push(event);
  };

  const setStatus = (to: WorkflowState, reason: string) => {
    record('STATUS_CHANGED', 'supervisor', { from: execution.status, to, reason });
    execution.status = to;
  };

  // Runs one agent with retries. Only thrown errors (assumed transient) are
  // retried; invalid input/output from deterministic agents would repeat, and a
  // business-rule 'fail' is a successful result, so neither is retried.
  async function runWithRetry<N extends AgentName, I, O>(agent: Agent<N, I, O>, input: I): Promise<AgentExecution<N, O>> {
    for (let attempt = 1; ; attempt++) {
      record('AGENT_STARTED', agent.name, { attempt, maxAttempts });
      const result = await executeAgent(agent, input, attempt);

      const stored: AgentAttempt = {
        id: execution.agentAttempts.length + 1,
        agentName: agent.name,
        attempt,
        status: result.outcome === 'success' ? 'success' : result.failureReason,
        output: result.outcome === 'success' ? result.output : null,
        errorMessage: result.outcome === 'failed' ? result.errorMessage : null,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
      };
      execution.agentAttempts.push(stored);

      if (result.outcome === 'success') {
        const status = (result.output as { status?: string }).status ?? null;
        record('AGENT_SUCCEEDED', agent.name, { attempt, durationMs: result.durationMs, checkStatus: status });
        return result;
      }

      const details = { attempt, failureReason: result.failureReason, errorMessage: result.errorMessage };
      record(result.failureReason === 'invalid_output' ? 'AGENT_OUTPUT_INVALID' : 'AGENT_FAILED', agent.name, details);

      const retryable = result.failureReason === 'error';
      if (retryable && attempt < maxAttempts) {
        record('AGENT_RETRY', 'supervisor', { agent: agent.name, nextAttempt: attempt + 1, maxAttempts });
        continue;
      }
      return result;
    }
  }

  const markIncomplete = (r: AgentExecution<AgentName, unknown>) => {
    if (r.outcome === 'failed') {
      record('CHECK_INCOMPLETE', 'supervisor', {
        agent: r.agentName,
        attempts: r.attempts,
        failureReason: r.failureReason,
        note: 'Treated as incomplete; it can never count as a passed check.',
      });
    }
  };

  record('WORKFLOW_STARTED', 'supervisor', { caseId: execution.caseId, autonomyMode: mode, maxAttempts });
  setStatus('running', 'Workflow started.');

  // 1-2. Independent checks.
  const referenceDate = now().toISOString().slice(0, 10);
  const document_completeness = await runWithRetry(agents.document_completeness, {
    caseId: onboardingCase.id,
    referenceDate,
    documents: onboardingCase.documents,
  });
  markIncomplete(document_completeness);

  const identity_consistency = await runWithRetry(agents.identity_consistency, {
    caseId: onboardingCase.id,
    profile: {
      customerFullName: onboardingCase.customerFullName,
      dateOfBirth: onboardingCase.dateOfBirth,
      residentialAddress: onboardingCase.residentialAddress,
    },
    identityVerificationStatus: onboardingCase.identityVerificationStatus,
    documents: onboardingCase.documents,
  });
  markIncomplete(identity_consistency);

  // 3. Risk assessment uses both upstream results (success or failure).
  const risk_indicator = await runWithRetry(agents.risk_indicator, {
    caseId: onboardingCase.id,
    riskIndicators: onboardingCase.riskIndicators,
    upstream: { document_completeness, identity_consistency },
  });
  markIncomplete(risk_indicator);

  // 4. Recommendation uses all three results.
  const checks = { document_completeness, identity_consistency, risk_indicator };
  const recommendation = await runWithRetry(agents.recommendation, {
    caseId: onboardingCase.id,
    caseReference: {
      id: onboardingCase.id,
      customerFullName: onboardingCase.customerFullName,
      productType: onboardingCase.productType,
    },
    checks,
  });
  const agentResults = { ...checks, recommendation };

  // Termination: without a valid recommendation the workflow fails safely.
  if (recommendation.outcome === 'failed') {
    execution.errorMessage = `Recommendation agent failed after ${recommendation.attempts} attempt(s): ${recommendation.errorMessage}`;
    setStatus('failed', 'No valid recommendation could be produced; manual handling is required.');
    execution.completedAt = now().toISOString();
    record('WORKFLOW_FINISHED', 'supervisor', { status: execution.status });
    return { execution: WorkflowExecutionSchema.parse(execution), agentResults };
  }

  // 5. Independent safety guard over the recommendation.
  const guarded = safetyGuard(recommendation.output, checks);
  if (guarded.overridden) {
    record('SAFETY_OVERRIDE', 'supervisor', {
      original: recommendation.output.recommendation,
      replacement: guarded.recommendation.recommendation,
      problems: guarded.problems,
    });
  }
  execution.recommendation = guarded.recommendation;
  record('RECOMMENDATION_MADE', 'recommendation', {
    recommendation: guarded.recommendation.recommendation,
    ruleApplied: guarded.recommendation.ruleApplied,
  });

  // 6. Autonomy policy decides the workflow status (never a human decision).
  const decision = applyAutonomy(mode, guarded.recommendation);
  execution.finalOutcome = decision.finalOutcome;
  execution.outcomeSource = decision.outcomeSource;
  setStatus(decision.status, decision.reason);
  if (decision.status === 'completed') execution.completedAt = now().toISOString();
  record('WORKFLOW_FINISHED', 'supervisor', {
    status: execution.status,
    recommendation: guarded.recommendation.recommendation,
    finalOutcome: execution.finalOutcome,
    outcomeSource: execution.outcomeSource,
  });

  // Final invariant check (e.g. no automatic outcome unless allowed). A
  // violation is a bug and is thrown, never silently ignored.
  return { execution: WorkflowExecutionSchema.parse(execution), agentResults };
}
