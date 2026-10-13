import type {
  AgentFinding,
  CheckAgentName,
  DocumentCompletenessOutput,
  IdentityConsistencyOutput,
  RiskIndicatorOutput,
  WorkflowExecution,
} from '../api/types';
import { AGENT_LABELS, CHECK_AGENTS, humanize, latestAttempts } from '../format';
import { Badge } from './Badge';

export function FindingList({ findings }: { findings: AgentFinding[] }) {
  if (findings.length === 0) return <p className="muted small">No findings.</p>;
  return (
    <ul className="findings">
      {findings.map((f, i) => (
        <li key={i} className={`finding finding-${f.severity}`}>
          <div className="finding-head">
            <Badge value={f.severity === 'info' ? 'info' : f.severity} label={f.severity.toUpperCase()} />
            <span className="mono small">{f.code}</span>
          </div>
          <p>{f.message}</p>
          {f.evidence.length > 0 && (
            <table className="evidence">
              <thead>
                <tr><th>Source</th><th>Field</th><th>Observed</th><th>Expected</th></tr>
              </thead>
              <tbody>
                {f.evidence.map((e, j) => (
                  <tr key={j}>
                    <td>{humanize(e.source)}</td>
                    <td className="mono">{e.field}</td>
                    <td>{e.observed ?? <span className="muted">none</span>}</td>
                    <td>{e.expected ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </li>
      ))}
    </ul>
  );
}

// Agent-specific headline facts.
function Highlights({ agent, output }: { agent: CheckAgentName; output: unknown }) {
  if (agent === 'document_completeness') {
    const o = output as DocumentCompletenessOutput;
    return (
      <p className="small">
        Missing: {o.missingDocumentTypes.map(humanize).join(', ') || 'none'} · Verification pending:{' '}
        {o.pendingVerificationDocumentTypes.map(humanize).join(', ') || 'none'}
      </p>
    );
  }
  if (agent === 'identity_consistency') {
    const o = output as IdentityConsistencyOutput;
    return (
      <p className="small">
        {o.comparisons.map((c) => (
          <span key={c.field} className="comparison">
            {humanize(c.field)}: <Badge value={c.result === 'match' ? 'pass' : c.result === 'mismatch' ? 'fail' : 'pending'} label={c.result} />
          </span>
        ))}
      </p>
    );
  }
  const o = output as RiskIndicatorOutput;
  return (
    <p className="small">
      Risk level: <Badge value={o.riskLevel} label={o.riskLevel.toUpperCase()} /> · Escalation required:{' '}
      <strong>{o.escalationRequired ? 'Yes' : 'No'}</strong> · Open flags: {o.openIndicatorCount}
    </p>
  );
}

export function AgentFindings({ execution }: { execution: WorkflowExecution }) {
  const latest = latestAttempts(execution);

  return (
    <section className="panel">
      <h2>Agent findings</h2>
      <div className="agent-grid">
        {CHECK_AGENTS.map((agent) => {
          const attempt = latest[agent];
          const output = attempt?.status === 'success' ? (attempt.output as { status: 'pass' | 'fail'; explanation: string; findings: AgentFinding[] }) : null;
          const state = !attempt ? 'unavailable' : output ? output.status : 'unavailable';

          return (
            <article key={agent} className={`agent-card agent-${state}`}>
              <header>
                <h3>{AGENT_LABELS[agent]}</h3>
                <Badge value={state} label={state === 'unavailable' ? 'CHECK FAILED / INCOMPLETE' : state.toUpperCase()} />
              </header>
              {attempt && attempt.attempts > 1 && <p className="muted small">{attempt.attempts} attempts (retried)</p>}

              {output ? (
                <>
                  <p>{output.explanation}</p>
                  <Highlights agent={agent} output={output} />
                  <FindingList findings={output.findings} />
                </>
              ) : (
                <div className="alert alert-bad">
                  This check did not complete{attempt ? ` (${humanize(attempt.status)})` : ''} and is not treated as passed.
                  {attempt?.errorMessage && <pre className="error-text">{attempt.errorMessage}</pre>}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
