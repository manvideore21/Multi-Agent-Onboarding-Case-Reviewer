// Entry point: open the database, build the app, start listening.
import { createApp } from './app';
import { config } from './config';
import { openDatabase } from './db/connection';

const db = openDatabase(config.databasePath, { schemaPath: config.schemaPath, seedPath: config.seedPath });
const app = createApp(db, { maxAgentAttempts: config.maxAgentAttempts, logRequests: true });

const server = app.listen(config.port, () => {
  console.log(`Onboarding Case Reviewer API listening on http://localhost:${config.port}/api`);
  console.log(`Database: ${config.databasePath}`);
});

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
