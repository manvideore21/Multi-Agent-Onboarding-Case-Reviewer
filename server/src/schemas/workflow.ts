// Workflow, audit and human-decision schemas, plus API request bodies.
// Recommendation (agent output), status (workflow state) and finalOutcome
// (what was actually decided, and by whom) are deliberately separate fields.
import { z } from 'zod';
import { AgentNameSchema, RecommendationOutputSchema } from './agents';

const timestamp = z.string().min(1);

export const AutonomyModeSchema = z.enum(['human_approval_required', 'exception_only']);

export const WorkflowStateSchema = z.enum([
  'pending',
  'running',
  'completed',
  'needs_human_approval',
  'needs_manual_review',
  'failed',
]);

export const FinalOutcomeSchema = z.enum(['approved', 'rejected']);
export const OutcomeSourceSchema = z.enum(['human', 'auto_policy']);
export const HumanDecisionValueSchema = z.enum(['approved', 'rejected']);

export const AuditEventTypeSchema = z.enum([
  'CASE_CREATED',
  'WORKFLOW_STARTED',
  'AGENT_STARTED',
  'AGENT_SUCCEEDED',
  'AGENT_FAILED',
  'AGENT_OUTPUT_INVALID',
  'AGENT_RETRY',
  'CHECK_INCOMPLETE',
  'RECOMMENDATION_MADE',
  'SAFETY_OVERRIDE',
  'STATUS_CHANGED',
  'HUMAN_DECISION_RECORDED',
  'WORKFLOW_FINISHED',
]);

export const AuditEventSchema = z.object({
  id: z.number().int(),
  caseId: z.string().min(1),
  executionId: z.string().nullable(),
  eventType: AuditEventTypeSchema,
  actor: z.string().min(1),
  details: z.record(z.string(), z.unknown()).nullable(),
  createdAt: timestamp,
});

// One stored attempt of one agent (one agent_results row).
export const AgentAttemptSchema = z.object({
  id: z.number().int(),
  agentName: AgentNameSchema,
  attempt: z.number().int().min(1),
  status: z.enum(['success', 'error', 'invalid_input', 'invalid_output']),
  output: z.unknown().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: timestamp,
  completedAt: timestamp,
});

export const HumanDecisionSchema = z.object({
  id: z.number().int(),
  executionId: z.string().min(1),
  decision: HumanDecisionValueSchema,
  reviewerName: z.string().min(1),
  comment: z.string().nullable(),
  decidedAt: timestamp,
});

export const WorkflowExecutionSchema = z
  .object({
    id: z.string().min(1),
    caseId: z.string().min(1),
    autonomyMode: AutonomyModeSchema,
    status: WorkflowStateSchema,
    recommendation: RecommendationOutputSchema.nullable(),
    finalOutcome: FinalOutcomeSchema.nullable(),
    outcomeSource: OutcomeSourceSchema.nullable(),
    errorMessage: z.string().nullable(),
    startedAt: timestamp,
    completedAt: timestamp.nullable(),
    agentAttempts: z.array(AgentAttemptSchema),
    auditEvents: z.array(AuditEventSchema),
    humanDecision: HumanDecisionSchema.nullable(),
  })
  .refine((e) => (e.finalOutcome === null) === (e.outcomeSource === null), {
    message: 'finalOutcome and outcomeSource must be set together',
  })
  // The policy may only ever auto-approve a clean 'approve' in exception-only mode.
  .refine(
    (e) =>
      e.outcomeSource !== 'auto_policy' ||
      (e.autonomyMode === 'exception_only' &&
        e.finalOutcome === 'approved' &&
        e.recommendation?.recommendation === 'approve'),
    { message: 'Automatic outcomes are only allowed for approve recommendations in exception_only mode' },
  )
  .refine((e) => e.outcomeSource !== 'human' || e.humanDecision !== null, {
    message: 'A human outcome requires a recorded human decision',
  });

// ---------- API request bodies ----------

export const RunWorkflowRequestSchema = z.object({
  autonomyMode: AutonomyModeSchema,
  // Demo/testing aid: forces the named agent to fail on every attempt.
  simulateFailure: AgentNameSchema.optional(),
});

export const HumanDecisionRequestSchema = z.object({
  decision: HumanDecisionValueSchema,
  reviewerName: z.string().trim().min(1).max(100),
  comment: z.string().trim().max(1000).optional(),
});
