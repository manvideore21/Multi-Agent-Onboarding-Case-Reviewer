// Application-domain types, inferred from the Zod schemas (single source of truth).
import type { z } from 'zod';
import type * as D from '../schemas/domain';
import type * as A from '../schemas/agents';
import type * as W from '../schemas/workflow';

// Case data
export type DocumentType = z.infer<typeof D.DocumentTypeSchema>;
export type SupportingDocument = z.infer<typeof D.SupportingDocumentSchema>;
export type RiskSeverity = z.infer<typeof D.RiskSeveritySchema>;
export type RiskIndicator = z.infer<typeof D.RiskIndicatorSchema>;
export type CaseStatus = z.infer<typeof D.CaseStatusSchema>;
export type OnboardingCase = z.infer<typeof D.OnboardingCaseSchema>;

// Agents
export type AgentName = z.infer<typeof A.AgentNameSchema>;
export type CheckAgentName = z.infer<typeof A.CheckAgentNameSchema>;
export type Evidence = z.infer<typeof A.EvidenceSchema>;
export type AgentFinding = z.infer<typeof A.AgentFindingSchema>;

export type DocumentCompletenessInput = z.infer<typeof A.DocumentCompletenessInputSchema>;
export type DocumentCompletenessOutput = z.infer<typeof A.DocumentCompletenessOutputSchema>;
export type IdentityConsistencyInput = z.infer<typeof A.IdentityConsistencyInputSchema>;
export type IdentityConsistencyOutput = z.infer<typeof A.IdentityConsistencyOutputSchema>;
export type IdentityField = z.infer<typeof A.IdentityFieldSchema>;
export type FieldComparison = z.infer<typeof A.FieldComparisonSchema>;
export type RiskIndicatorInput = z.infer<typeof A.RiskIndicatorInputSchema>;
export type RiskIndicatorOutput = z.infer<typeof A.RiskIndicatorOutputSchema>;
export type RiskLevel = z.infer<typeof A.RiskLevelSchema>;
export type RecommendationInput = z.infer<typeof A.RecommendationInputSchema>;
export type RecommendationOutput = z.infer<typeof A.RecommendationOutputSchema>;
export type Recommendation = z.infer<typeof A.RecommendationSchema>;
export type RecommendationRule = z.infer<typeof A.RecommendationRuleSchema>;
export type CheckSummary = z.infer<typeof A.CheckSummarySchema>;
export type AttributedFinding = z.infer<typeof A.AttributedFindingSchema>;

export type AgentInput =
  | DocumentCompletenessInput
  | IdentityConsistencyInput
  | RiskIndicatorInput
  | RecommendationInput;

// Explicit success | failed result per agent.
export type DocumentCompletenessResult = z.infer<typeof A.DocumentCompletenessResultSchema>;
export type IdentityConsistencyResult = z.infer<typeof A.IdentityConsistencyResultSchema>;
export type RiskIndicatorResult = z.infer<typeof A.RiskIndicatorResultSchema>;
export type RecommendationResult = z.infer<typeof A.RecommendationResultSchema>;
export type AgentResult =
  | DocumentCompletenessResult
  | IdentityConsistencyResult
  | RiskIndicatorResult
  | RecommendationResult;

// Workflow
export type AutonomyMode = z.infer<typeof W.AutonomyModeSchema>;
export type WorkflowState = z.infer<typeof W.WorkflowStateSchema>;
export type FinalOutcome = z.infer<typeof W.FinalOutcomeSchema>;
export type OutcomeSource = z.infer<typeof W.OutcomeSourceSchema>;
export type AgentAttempt = z.infer<typeof W.AgentAttemptSchema>;
export type AuditEventType = z.infer<typeof W.AuditEventTypeSchema>;
export type AuditEvent = z.infer<typeof W.AuditEventSchema>;
export type HumanDecision = z.infer<typeof W.HumanDecisionSchema>;
export type WorkflowExecution = z.infer<typeof W.WorkflowExecutionSchema>;
export type RunWorkflowRequest = z.infer<typeof W.RunWorkflowRequestSchema>;
export type HumanDecisionRequest = z.infer<typeof W.HumanDecisionRequestSchema>;

// API response summaries
export interface CaseSummary {
  id: string;
  customerFullName: string;
  productType: string;
  caseStatus: string;
  identityVerificationStatus: string;
  documentCount: number;
  openRiskCount: number;
  // riskLevel comes from the latest run's Risk Indicator Agent (null if it did not complete)
  latestExecution: { id: string; status: string; recommendation: string | null; riskLevel: RiskLevel | null } | null;
  createdAt: string;
}

export interface ExecutionSummary {
  id: string;
  autonomyMode: string;
  status: string;
  recommendation: string | null;
  finalOutcome: string | null;
  outcomeSource: string | null;
  startedAt: string;
  completedAt: string | null;
}
