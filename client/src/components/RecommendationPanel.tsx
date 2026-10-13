import type { WorkflowExecution } from '../api/types';
import { AGENT_LABELS, formatTime, humanize, latestAttempts } from '../format';
import { FindingList } from './AgentFindings';
import { Badge } from './Badge';

// Shows the agent's RECOMMENDATION, the WORKFLOW STATE and the actual OUTCOME
// as three clearly separate things.
export function RecommendationPanel({ execution }: { execution: WorkflowExecution }) {
  const rec = execution.recommendation;
  const recAttempt = latestAttempts(execution).recommendation;

  return (
    <section className="panel">
      <h2>Recommendation and outcome</h2>

      <div className="summary-row">
        <div>
          <div className="muted small">Workflow state</div>
          <Badge value={execution.status} />
        </div>
        <div>
          <div className="muted small">Agent recommendation (not a decision)</div>
          {rec ? <Badge value={rec.recommendation} /> : <span className="muted">None</span>}
        </div>
        <div>
          <div className="muted small">Final outcome</div>
          <Outcome execution={execution} />
        </div>
      </div>

      {execution.status === 'failed' && (
        <div className="alert alert-bad">
          The workflow failed and produced no recommendation. Manual handling is required.
          {execution.errorMessage && <pre className="error-text">{execution.errorMessage}</pre>}
          {recAttempt && recAttempt.attempts > 1 && <div className="small">Recommendation Agent attempts: {recAttempt.attempts}</div>}
        </div>
      )}

      {rec && (
        <>
          <p className="explanation">{rec.explanation}</p>
          <p className="muted small">
            Rule applied: <span className="mono">{rec.ruleApplied}</span>
          </p>

          <h3>Check summary</h3>
          <ul className="check-summary">
            {rec.checkSummary.map((c) => (
              <li key={c.agent}>
                {AGENT_LABELS[c.agent]}: <Badge value={c.result} />
              </li>
            ))}
          </ul>

          {rec.escalationReasons.length > 0 && (
            <>
              <h3>Reasons for escalation</h3>
              <ul>{rec.escalationReasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </>
          )}

          <h3>Outstanding issues</h3>
          {rec.outstandingIssues.length === 0 ? (
            <p className="muted small">None.</p>
          ) : (
            <ul>{rec.outstandingIssues.map((r, i) => <li key={i}>{r}</li>)}</ul>
          )}

          <details>
            <summary>Supporting findings ({rec.supportingFindings.length})</summary>
            <FindingList findings={rec.supportingFindings} />
          </details>
        </>
      )}
    </section>
  );
}

function Outcome({ execution }: { execution: WorkflowExecution }) {
  const d = execution.humanDecision;
  if (d) {
    return (
      <div>
        <Badge value={d.decision} label={`${humanize(d.decision)} by human`} />
        <div className="small">
          {d.reviewerName} · {formatTime(d.decidedAt)}
          {d.comment && <div className="muted">“{d.comment}”</div>}
        </div>
      </div>
    );
  }
  if (execution.outcomeSource === 'auto_policy') {
    return (
      <div>
        <Badge value={execution.finalOutcome} label={`${humanize(execution.finalOutcome)} automatically`} />
        <div className="muted small">Progressed under exception-only policy; no human decision was made.</div>
      </div>
    );
  }
  return <span className="muted">No decision yet</span>;
}
