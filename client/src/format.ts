// Display helpers shared by components.
import type { AgentAttempt, AgentName, CheckAgentName, WorkflowExecution } from './api/types';

export const AGENT_LABELS: Record<AgentName, string> = {
  document_completeness: 'Document Completeness Agent',
  identity_consistency: 'Identity Consistency Agent',
  risk_indicator: 'Risk Indicator Agent',
  recommendation: 'Recommendation Agent',
};

export const CHECK_AGENTS: CheckAgentName[] = ['document_completeness', 'identity_consistency', 'risk_indicator'];

export const AWAITING_DECISION = ['needs_human_approval', 'needs_manual_review'];

// "needs_human_approval" -> "Needs human approval"
export function humanize(value: string | null | undefined): string {
  if (!value) return '—';
  const text = value.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

// Colour family for a status-like value.
export type Tone = 'good' | 'bad' | 'warn' | 'neutral' | 'info';

export function toneFor(value: string | null | undefined): Tone {
  switch (value) {
    case 'pass':
    case 'success':
    case 'approve':
    case 'approved':
    case 'verified':
    case 'provided':
    case 'low':
    case 'completed':
      return 'good';
    case 'fail':
    case 'failed':
    case 'error':
    case 'invalid_input':
    case 'invalid_output':
    case 'unavailable':
    case 'reject':
    case 'rejected':
    case 'high':
    case 'critical':
    case 'expired':
    case 'unreadable':
      return 'bad';
    case 'medium':
    case 'pending':
    case 'pending_verification':
    case 'refer_for_manual_review':
    case 'needs_human_approval':
    case 'needs_manual_review':
    case 'in_review':
    case 'open':
      return 'warn';
    case 'running':
    case 'info':
      return 'info';
    default:
      return 'neutral';
  }
}

// The final attempt for each agent (retries create several attempts).
export function latestAttempts(execution: WorkflowExecution): Partial<Record<AgentName, AgentAttempt & { attempts: number }>> {
  const result: Partial<Record<AgentName, AgentAttempt & { attempts: number }>> = {};
  for (const attempt of execution.agentAttempts) {
    result[attempt.agentName] = { ...attempt, attempts: attempt.attempt };
  }
  return result;
}
