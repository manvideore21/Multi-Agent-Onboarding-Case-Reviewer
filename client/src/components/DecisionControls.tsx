import { useState } from 'react';
import type { HumanDecisionRequest, WorkflowExecution } from '../api/types';
import { AWAITING_DECISION } from '../format';

interface Props {
  execution: WorkflowExecution;
  onSubmit: (request: HumanDecisionRequest) => Promise<void>;
}

// Rendered only while the execution is awaiting a human decision. The backend
// enforces the same rules (single decision, eligible status, comment rule).
export function DecisionControls({ execution, onSubmit }: Props) {
  const [reviewerName, setReviewerName] = useState('');
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!AWAITING_DECISION.includes(execution.status) || execution.humanDecision) return null;

  const rec = execution.recommendation;
  const incomplete = rec?.checkSummary.filter((c) => c.result !== 'pass') ?? [];

  const commentRequired = (decision: 'approved' | 'rejected') =>
    !((rec?.recommendation === 'approve' && decision === 'approved') || (rec?.recommendation === 'reject' && decision === 'rejected'));

  async function submit(decision: 'approved' | 'rejected') {
    setError(null);
    if (!reviewerName.trim()) return setError('Enter your reviewer name.');
    if (commentRequired(decision) && !comment.trim()) {
      return setError('A comment is required when the decision does not follow an approve/reject recommendation.');
    }
    setSubmitting(true);
    try {
      await onSubmit({ decision, reviewerName: reviewerName.trim(), comment: comment.trim() || undefined });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="panel decision-panel">
      <h2>Human decision required</h2>
      <p className="small">
        {execution.status === 'needs_human_approval'
          ? 'This workflow requires explicit human approval before the case can progress.'
          : 'This case was escalated for manual review.'}{' '}
        Your decision is recorded separately from the agent recommendation and is audited.
      </p>
      {incomplete.length > 0 && (
        <div className="alert alert-warn">
          {incomplete.length} check(s) did not pass or did not complete. Approving would override the safety checks and
          requires a written justification.
        </div>
      )}

      <label className="block-field">
        <span>Reviewer name</span>
        <input value={reviewerName} onChange={(e) => setReviewerName(e.target.value)} maxLength={100} disabled={submitting} />
      </label>
      <label className="block-field">
        <span>Comment {commentRequired('approved') || commentRequired('rejected') ? '(required unless following an approve/reject recommendation)' : '(optional)'}</span>
        <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} maxLength={1000} disabled={submitting} />
      </label>

      <div className="actions">
        <button type="button" className="approve" disabled={submitting} onClick={() => submit('approved')}>
          {submitting ? 'Submitting…' : 'Approve case'}
        </button>
        <button type="button" className="reject" disabled={submitting} onClick={() => submit('rejected')}>
          {submitting ? 'Submitting…' : 'Reject case'}
        </button>
      </div>
      {error && <div className="alert alert-bad">{error}</div>}
    </section>
  );
}
