import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api/client';
import type { AgentName, AutonomyMode, CaseSummary, HumanDecisionRequest, OnboardingCase, WorkflowExecution } from './api/types';
import { AgentFindings } from './components/AgentFindings';
import { CaseDetails } from './components/CaseDetails';
import { CaseList } from './components/CaseList';
import { DecisionControls } from './components/DecisionControls';
import { ExecutionTrace } from './components/ExecutionTrace';
import { RecommendationPanel } from './components/RecommendationPanel';
import { ReviewControls } from './components/ReviewControls';
import { humanize } from './format';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function App() {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [casesLoading, setCasesLoading] = useState(true);
  const [casesError, setCasesError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [caseData, setCaseData] = useState<OnboardingCase | null>(null);
  const [execution, setExecution] = useState<WorkflowExecution | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [reviewRunning, setReviewRunning] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewSuccess, setReviewSuccess] = useState<string | null>(null);

  // Ignore responses for a case that is no longer selected.
  const selectionRef = useRef<string | null>(null);

  const loadCases = useCallback(async () => {
    setCasesLoading(true);
    setCasesError(null);
    try {
      setCases(await api.getCases());
    } catch (e) {
      setCasesError(message(e));
    } finally {
      setCasesLoading(false);
    }
  }, []);

  const loadCase = useCallback(async (id: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const [c, executions] = await Promise.all([api.getCase(id), api.getCaseExecutions(id)]);
      const latest = executions[0] ? await api.getExecution(executions[0].id) : null;
      if (selectionRef.current !== id) return;
      setCaseData(c);
      setExecution(latest);
    } catch (e) {
      if (selectionRef.current === id) setDetailError(message(e));
    } finally {
      if (selectionRef.current === id) setDetailLoading(false);
    }
  }, []);

  // Initial load (state is only set once the request settles).
  useEffect(() => {
    let active = true;
    api
      .getCases()
      .then((c) => active && setCases(c))
      .catch((e) => active && setCasesError(message(e)))
      .finally(() => active && setCasesLoading(false));
    return () => {
      active = false;
    };
  }, []);

  function selectCase(id: string) {
    if (reviewRunning) return;
    selectionRef.current = id;
    setSelectedId(id);
    setCaseData(null);
    setExecution(null);
    setReviewError(null);
    setReviewSuccess(null);
    void loadCase(id);
  }

  async function runReview(mode: AutonomyMode, simulateFailure?: AgentName) {
    if (!caseData || reviewRunning) return; // guard against duplicate submissions
    const id = caseData.id;
    setReviewRunning(true);
    setReviewError(null);
    setReviewSuccess(null);
    try {
      const result = await api.runReview(id, { autonomyMode: mode, simulateFailure });
      if (selectionRef.current === id) {
        setExecution(result);
        setReviewSuccess(`Review finished: ${humanize(result.status)}.`);
        setCaseData(await api.getCase(id));
      }
    } catch (e) {
      setReviewError(message(e));
    } finally {
      setReviewRunning(false);
      void loadCases();
    }
  }

  async function submitDecision(request: HumanDecisionRequest) {
    if (!execution) return;
    const updated = await api.submitDecision(execution.id, request); // errors shown by DecisionControls
    setExecution(updated);
    if (selectedId) setCaseData(await api.getCase(selectedId));
    void loadCases();
  }

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>Onboarding Case Reviewer</h1>
          <p>Multi-agent review of customer onboarding cases</p>
        </div>
        <div className="synthetic-banner">
          Synthetic demonstration data only. No real identity verification, fraud detection or sanctions screening is
          performed.
        </div>
      </header>

      <main className="layout">
        <aside>
          <CaseList
            cases={cases}
            selectedId={selectedId}
            loading={casesLoading}
            error={casesError}
            onSelect={selectCase}
            onRetry={() => void loadCases()}
          />
        </aside>

        <div className="content">
          {!selectedId && <section className="panel muted">Select a case to view its details and run a review.</section>}
          {detailLoading && <section className="panel muted">Loading case…</section>}
          {detailError && (
            <div className="alert alert-bad">
              Could not load case: {detailError}{' '}
              {selectedId && <button type="button" className="link-button" onClick={() => void loadCase(selectedId)}>Retry</button>}
            </div>
          )}

          {caseData && (
            <>
              <CaseDetails data={caseData} />
              <ReviewControls
                onboardingCase={caseData}
                latestExecution={execution}
                running={reviewRunning}
                error={reviewError}
                success={reviewSuccess}
                onRun={(mode, fail) => void runReview(mode, fail)}
              />
              {execution ? (
                <>
                  <RecommendationPanel execution={execution} />
                  <DecisionControls key={execution.id} execution={execution} onSubmit={submitDecision} />
                  <AgentFindings execution={execution} />
                  <ExecutionTrace execution={execution} />
                </>
              ) : (
                !detailLoading && <section className="panel muted">This case has not been reviewed yet.</section>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
