// HTTP routes: validate path params and bodies with Zod, delegate to the
// service, and shape the response. No business logic or SQL here.
import { Router } from 'express';
import { CaseIdParamSchema, CreateCaseRequestSchema, ExecutionIdParamSchema } from '../schemas/api';
import { HumanDecisionRequestSchema, RunWorkflowRequestSchema } from '../schemas/workflow';
import type { ReviewService } from '../services/reviewService';

export function createRouter(service: ReviewService, health: () => boolean): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', database: health() ? 'ok' : 'unavailable' });
  });

  router.get('/cases', (_req, res) => {
    res.json({ cases: service.listCases() });
  });

  router.post('/cases', (req, res) => {
    const body = CreateCaseRequestSchema.parse(req.body);
    res.status(201).json({ case: service.createCase(body) });
  });

  router.get('/cases/:id', (req, res) => {
    const { id } = CaseIdParamSchema.parse(req.params);
    res.json({ case: service.getCase(id) });
  });

  router.post('/cases/:id/review', async (req, res) => {
    const { id } = CaseIdParamSchema.parse(req.params);
    const body = RunWorkflowRequestSchema.parse(req.body);
    res.status(201).json({ execution: await service.reviewCase(id, body) });
  });

  router.get('/cases/:id/executions', (req, res) => {
    const { id } = CaseIdParamSchema.parse(req.params);
    res.json({ executions: service.listExecutions(id) });
  });

  router.get('/executions/:id', (req, res) => {
    const { id } = ExecutionIdParamSchema.parse(req.params);
    res.json({ execution: service.getExecution(id) });
  });

  router.post('/executions/:id/decision', (req, res) => {
    const { id } = ExecutionIdParamSchema.parse(req.params);
    const body = HumanDecisionRequestSchema.parse(req.body);
    res.status(201).json({ execution: service.recordHumanDecision(id, body) });
  });

  return router;
}
