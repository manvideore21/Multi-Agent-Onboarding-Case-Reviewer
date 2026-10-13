// API contract types are imported from the backend (type-only, erased at build
// time), so the UI cannot drift from the server's Zod schemas.
export type * from '../../../server/src/types';
