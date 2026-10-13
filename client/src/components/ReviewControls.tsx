import { useState } from 'react';
import type { AgentName, AutonomyMode, OnboardingCase, WorkflowExecution } from '../api/types';
import { AGENT_LABELS, AWAITING_DECISION } from '../format';

interface Props {
  onboardingCase: OnboardingCase;
  latestExecution: WorkflowExecution | null;
  running: boolean;
  error: string | null;
  success: string | null;
  onRun: (mode: AutonomyMode, simulateFailure?: AgentName) => void;
}

const MODES: { value: AutonomyMode; label: string; description: string }[] = [
  {
    value: 'human_approval_required',
    label: 'Human approval required',
    description: 'Every recommendation waits for a reviewer to approve or reject.',
  },
  {
    value: 'exception_only',
    label: 'Human review only on exception',
    description: 'Only a case where every check passes with low risk progresses automatically. Everything else is escalated.',
  },
];

export function ReviewControls({ onboardingCase, latestExecution, running, error, success, onRun }: Props) {
  const [mode, setMode] = useState<AutonomyMode>('human_approval_required');
  const [simulateFailure, setSimulateFailure] = useState<AgentName | ''>('');

  // Mirrors the backend's rules so the button explains why it is disabled; the
  // backend still enforces them.
  let blockedReason: string | null = null;
  if (latestExecution && AWAITING_DECISION.includes(latestExecution.status) && !latestExecution.humanDecision) {
    blockedReason = 'The latest review is awaiting a human decision. Record a decision before running another review.';
  } else if (onboardingCase.caseStatus === 'approved' || onboardingCase.caseStatus === 'rejected') {
    blockedReason = `This case already has a final outcome (${onboardingCase.caseStatus}).`;
  }

  return (
    <section className="panel">
      <h2>Run review</h2>
      <fieldset className="mode-options" disabled={running}>
        <legend>Autonomy mode</legend>
        {MODES.map((m) => (
          <label key={m.value} className={`mode-option ${mode === m.value ? 'selected' : ''}`}>
            <input type="radio" name="mode" value={m.value} checked={mode === m.value} onChange={() => setMode(m.value)} />
            <span>
              <strong>{m.label}</strong>
              <span className="muted small">{m.description}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <label className="inline-field">
        <span>Testing aid: simulate agent failure</span>
        <select
          value={simulateFailure}
          disabled={running}
          onChange={(e) => setSimulateFailure(e.target.value as AgentName | '')}
        >
          <option value="">None (normal run)</option>
          {(Object.keys(AGENT_LABELS) as AgentName[]).map((a) => (
            <option key={a} value={a}>{AGENT_LABELS[a]}</option>
          ))}
        </select>
      </label>

      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={running || blockedReason !== null}
          onClick={() => onRun(mode, simulateFailure || undefined)}
        >
          {running ? 'Running review…' : 'Run review'}
        </button>
      </div>
      {blockedReason && <p className="muted small">{blockedReason}</p>}
      {running && <div className="alert alert-info">The agents are reviewing the case…</div>}
      {error && <div className="alert alert-bad">Review failed: {error}</div>}
      {success && !running && <div className="alert alert-good">{success}</div>}
    </section>
  );
}
