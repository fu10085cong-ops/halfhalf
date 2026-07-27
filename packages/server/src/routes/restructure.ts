import { Router, type Request, type Response } from 'express';
import { createRestructurePlan, FocusSpecError } from '../engine/restructure-plan.js';
import {
  materializeRestructure,
  MaterializeError,
} from '../engine/restructure-materializer.js';
import type {
  ApiErrorResponse,
  FocusSpec,
  KnowledgeDocument,
  RestructurePlan,
} from '../types/index.js';

interface RestructurePlanRequest {
  document: KnowledgeDocument;
  focus: FocusSpec;
}
interface MaterializeRequest {
  document: KnowledgeDocument;
  plan: RestructurePlan;
  sourceMarkdown: string;
}


export const restructureRouter: Router = Router();

restructureRouter.post('/restructure/plan', (req: Request, res: Response) => {
  const body = req.body as Partial<RestructurePlanRequest>;
  if (!body.document || !body.focus) {
    res.status(400).json({
      error: 'document and focus are required',
    } satisfies ApiErrorResponse);
    return;
  }

  try {
    const plan = createRestructurePlan(body.document, body.focus);
    res.json(plan);
  } catch (error) {
    if (error instanceof FocusSpecError) {
      res.status(400).json({ error: error.message } satisfies ApiErrorResponse);
      return;
    }
    res.status(500).json({
      error: `failed to create restructure plan: ${String(error)}`,
    } satisfies ApiErrorResponse);
  }
});

restructureRouter.post('/restructure/materialize', (req: Request, res: Response) => {
  const body = req.body as Partial<MaterializeRequest>;
  if (!body.document || !body.plan || typeof body.sourceMarkdown !== 'string') {
    res.status(400).json({
      error: 'document, plan and sourceMarkdown are required',
    } satisfies ApiErrorResponse);
    return;
  }

  try {
    const result = materializeRestructure(body.document, body.plan, body.sourceMarkdown);
    res.json(result);
  } catch (error) {
    if (error instanceof MaterializeError) {
      res.status(400).json({ error: error.message } satisfies ApiErrorResponse);
      return;
    }
    res.status(500).json({
      error: `failed to materialize restructure plan: ${String(error)}`,
    } satisfies ApiErrorResponse);
  }
});
