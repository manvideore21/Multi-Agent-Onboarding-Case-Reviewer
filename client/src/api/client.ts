// Typed wrappers around the backend REST API.
import type {
  CaseSummary,
  ExecutionSummary,
  HumanDecisionRequest,
  OnboardingCase,
  RunWorkflowRequest,
  WorkflowExecution,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init?: { method: 'POST'; body: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init?.method ?? 'GET',
      headers: init ? { 'Content-Type': 'application/json' } : undefined,
      body: init ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the backend. Is the API server running on port 4000?');
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = body?.error;
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? `Request failed with HTTP ${res.status}`, err?.details);
  }
  return body as T;
}

export const api = {
  getCases: () => request<{ cases: CaseSummary[] }>('/cases').then((r) => r.cases),
  getCase: (id: string) => request<{ case: OnboardingCase }>(`/cases/${id}`).then((r) => r.case),
  getCaseExecutions: (id: string) =>
    request<{ executions: ExecutionSummary[] }>(`/cases/${id}/executions`).then((r) => r.executions),
  getExecution: (id: string) => request<{ execution: WorkflowExecution }>(`/executions/${id}`).then((r) => r.execution),
  runReview: (caseId: string, body: RunWorkflowRequest) =>
    request<{ execution: WorkflowExecution }>(`/cases/${caseId}/review`, { method: 'POST', body }).then((r) => r.execution),
  submitDecision: (executionId: string, body: HumanDecisionRequest) =>
    request<{ execution: WorkflowExecution }>(`/executions/${executionId}/decision`, { method: 'POST', body }).then(
      (r) => r.execution,
    ),
};
