// Common agent contract and a single-attempt executor.
// Retries and sequencing belong to the supervisor, not here.
import { z } from 'zod';
import type { AgentName } from '../types';

export interface Agent<N extends AgentName, I, O> {
  name: N;
  version: string;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  // Async so a real LLM-backed implementation can replace the deterministic mock.
  run(input: I): Promise<O>;
}

interface ExecutionMetadata<N extends AgentName> {
  agentName: N;
  agentVersion: string;
  attempts: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export type AgentExecution<N extends AgentName, O> =
  | (ExecutionMetadata<N> & { outcome: 'success'; output: O })
  | (ExecutionMetadata<N> & {
      outcome: 'failed';
      failureReason: 'error' | 'invalid_input' | 'invalid_output';
      errorMessage: string;
    });

// Validates input, runs the agent once, validates output, and never throws:
// every failure is returned as an explicit 'failed' result.
export async function executeAgent<N extends AgentName, I, O>(
  agent: Agent<N, I, O>,
  rawInput: unknown,
  attempt = 1,
): Promise<AgentExecution<N, O>> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const meta = () => ({
    agentName: agent.name,
    agentVersion: agent.version,
    attempts: attempt,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Math.round((performance.now() - start) * 100) / 100,
  });

  const input = agent.inputSchema.safeParse(rawInput);
  if (!input.success) {
    return { ...meta(), outcome: 'failed', failureReason: 'invalid_input', errorMessage: z.prettifyError(input.error) };
  }

  let rawOutput: unknown;
  try {
    rawOutput = await agent.run(input.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...meta(), outcome: 'failed', failureReason: 'error', errorMessage: message || 'Unknown error' };
  }

  const output = agent.outputSchema.safeParse(rawOutput);
  if (!output.success) {
    return { ...meta(), outcome: 'failed', failureReason: 'invalid_output', errorMessage: z.prettifyError(output.error) };
  }
  return { ...meta(), outcome: 'success', output: output.data };
}
