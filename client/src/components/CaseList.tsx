import type { CaseSummary } from '../api/types';
import { Badge } from './Badge';

interface Props {
  cases: CaseSummary[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onRetry: () => void;
}

export function CaseList({ cases, selectedId, loading, error, onSelect, onRetry }: Props) {
  return (
    <section className="panel">
      <h2>Onboarding cases</h2>
      {loading && cases.length === 0 && <p className="muted">Loading cases…</p>}
      {error && (
        <div className="alert alert-bad">
          {error} <button type="button" className="link-button" onClick={onRetry}>Retry</button>
        </div>
      )}
      <ul className="case-list">
        {cases.map((c) => {
          const risk = c.latestExecution?.riskLevel ?? null;
          return (
            <li key={c.id}>
              <button
                type="button"
                className={`case-item ${c.id === selectedId ? 'selected' : ''}`}
                onClick={() => onSelect(c.id)}
                aria-current={c.id === selectedId}
              >
                <span className="case-item-row">
                  <strong>{c.id}</strong>
                  <Badge value={c.caseStatus} />
                </span>
                <span className="case-item-row">
                  <span>{c.customerFullName}</span>
                  {risk ? (
                    <Badge value={risk} label={`Risk: ${risk}`} />
                  ) : (
                    <span className="muted small">Risk: not assessed</span>
                  )}
                </span>
                <span className="muted small">
                  {c.documentCount} document(s) · {c.openRiskCount} open flag(s)
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
