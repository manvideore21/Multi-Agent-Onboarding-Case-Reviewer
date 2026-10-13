// Builds the Express app from its dependencies (no listening, so tests can use it).
import express from 'express';
import { createRouter } from './api/routes';
import { errorHandler, HttpError } from './api/errors';
import { Repository } from './db/repository';
import type { Db } from './db/connection';
import { ReviewService } from './services/reviewService';

export function createApp(db: Db, options: { maxAgentAttempts: number; now?: () => Date; logRequests?: boolean }) {
  const repo = new Repository(db);
  const service = new ReviewService(repo, options);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  if (options.logRequests) {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`));
      next();
    });
  }

  app.use('/api', createRouter(service, () => repo.ping()));
  app.use((req, _res, next) => next(new HttpError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`)));
  app.use(errorHandler);
  return app;
}
