import type { AuditEvent, WorkflowExecution } from '../api/types';
import { AGENT_LABELS, formatTime, humanize } from '../format';
import { Badge } from './Badge';

// What each agent receives from the supervisor (the hand-offs).
const HANDOFFS: Record<string, string> = {
  document_completeness: 'receives the case documents',
  identity_consistency: 'receives the profile, verification status and documents',
  risk_indicator: 'receives risk flags + Document and Identity results',
  recommendation: 'receives all three check results',
};

function describe(e: AuditEvent): string {
  const d = (e.details ?? {}) as Record<string, any>;
  switch (e.eventType) {
    case 'WORKFLOW_STARTED':
      return `Mode: ${humanize(d.autonomyMode)} · max attempts per agent: ${d.maxAttempts}`;
    case 'STATUS_CHANGED':
      return `${humanize(d.from)} → ${humanize(d.to)}. ${d.reason ?? ''}`;
    case 'AGENT_STARTED':
      return `Attempt ${d.attempt} of ${d.maxAttempts}; ${HANDOFFS[e.actor] ?? ''}`;
    case 'AGENT_SUCCEEDED':
      return `Completed${d.checkStatus ? `, check ${d.checkStatus}` : ''} (${d.durationMs} ms)`;
    case 'AGENT_FAILED':
    case 'AGENT_OUTPUT_INVALID':
      return `Attempt ${d.attempt}: ${humanize(d.failureReason)}: ${d.errorMessage}`;
    case 'AGENT_RETRY':
      return `Retrying ${AGENT_LABELS[d.agent as keyof typeof AGENT_LABELS] ?? d.agent} (attempt ${d.nextAttempt} of ${d.maxAttempts})`;
    case 'CHECK_INCOMPLETE':
      return `${AGENT_LABELS[d.agent as keyof typeof AGENT_LABELS] ?? d.agent} failed after ${d.attempts} attempt(s). ${d.note ?? ''}`;
    case 'RECOMMENDATION_MADE':
      return `${humanize(d.recommendation)} (${d.ruleApplied})`;
    case 'SAFETY_OVERRIDE':
      return `Overrode '${d.original}' → '${d.replacement}': ${(d.problems ?? []).join(' ')}`;
    case 'HUMAN_DECISION_RECORDED':
      return `${humanize(d.decision)}; ${d.followsRecommendation ? 'follows' : 'does not follow'} the recommendation (${humanize(d.recommendation)})`;
    case 'WORKFLOW_FINISHED':
      return `Final state: ${humanize(d.status)}${d.finalOutcome ? `, outcome ${d.finalOutcome} (${humanize(d.outcomeSource)})` : ''}`;
    default:
      return e.details ? JSON.stringify(e.details) : '';
  }
}

const tone = (type: string) =>
  type === 'AGENT_FAILED' || type === 'AGENT_OUTPUT_INVALID' || type === 'CHECK_INCOMPLETE' || type === 'SAFETY_OVERRIDE'
    ? 'bad'
    : type === 'AGENT_RETRY'
      ? 'warn'
      : type === 'HUMAN_DECISION_RECORDED'
        ? 'good'
        : '';

export function ExecutionTrace({ execution }: { execution: WorkflowExecution }) {
  const retries = execution.auditEvents.filter((e) => e.eventType === 'AGENT_RETRY').length;
  const failures = execution.auditEvents.filter((e) => e.eventType === 'AGENT_FAILED' || e.eventType === 'AGENT_OUTPUT_INVALID').length;

  return (
    <section className="panel">
      <h2>Execution trace</h2>
      <p className="small">
        <Badge value={execution.status} /> · Started {formatTime(execution.startedAt)} · Completed {formatTime(execution.completedAt)} ·{' '}
        {humanize(execution.autonomyMode)} · {retries} retr{retries === 1 ? 'y' : 'ies'} · {failures} failed attempt(s)
      </p>
      <p className="muted small mono">Execution {execution.id}</p>
      {execution.errorMessage && <div className="alert alert-bad">{execution.errorMessage}</div>}

      <ol className="trace">
        {execution.auditEvents.map((e) => (
          <li key={e.id} className={`trace-event ${tone(e.eventType)}`}>
            <span className="trace-time mono small">{new Date(e.createdAt).toLocaleTimeString()}</span>
            <span className="trace-actor small">{AGENT_LABELS[e.actor as keyof typeof AGENT_LABELS] ?? e.actor}</span>
            <span className="trace-type mono small">{e.eventType}</span>
            <span className="trace-detail small">{describe(e)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
