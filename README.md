# Multi-Agent Onboarding Case Reviewer

A full-stack application that reviews **synthetic** banking customer-onboarding cases using four specialised, deterministic AI agents coordinated by a supervisor. For each case it identifies missing documents and inconsistencies, assesses predefined risk indicators, and produces an explainable recommendation — **approve**, **reject** or **refer for manual review** — with the findings, evidence and full execution trace behind it. A human reviewer can then record the actual decision.

> **Fictional data only.** All customers, documents and risk flags are invented. The application does **not** perform real identity verification, fraud detection, sanctions screening or any regulatory compliance check, and it does not connect to any banking system. A recommendation is never a banking action.

---

## Contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Installation and running](#installation-and-running)
- [Using the application](#using-the-application)
- [Seeded cases and expected outcomes](#seeded-cases-and-expected-outcomes)
- [Workflow rules](#workflow-rules)
- [REST API](#rest-api)
- [Database](#database)
- [Testing](#testing)
- [Project structure](#project-structure)
- [Limitations](#limitations)
- [AI development tools used](#ai-development-tools-used)

---

## What it does

| Agent | Responsibility | Receives |
|---|---|---|
| **Document Completeness** | Checks identity, address and income proof are present, current, readable and have complete metadata. Distinguishes *missing* from *present but verification pending*. Never claims authenticity. | Case documents |
| **Identity Consistency** | Compares profile name, date of birth and address with the submitted documents. Unavailable data is reported as *unavailable*, never assumed to match. | Profile, recorded verification status, documents |
| **Risk Indicator** | Evaluates predefined synthetic risk flags plus the two upstream results using transparent rules; assigns a risk level (low / medium / high). Receives no demographic data. | Risk flags + Document and Identity results |
| **Recommendation** | Combines the three check results into one explainable recommendation with outstanding issues and escalation reasons. | All three check results |

A **supervisor** runs the agents in dependency order, validates every input and output with Zod, retries transient failures, records an ordered audit trace, applies an independent safety guard, and applies the selected **autonomy mode**:

- **Human approval required** — every recommendation waits for a reviewer's explicit decision.
- **Human review only on exception** — only a case where every check passes with low risk progresses automatically; anything high-risk, inconsistent, incomplete or failed is escalated to manual review.

**Core safety rule:** a failed, incomplete or invalid check can never result in automatic approval.

The **React dashboard** shows the case list, synthetic case details, review controls, each agent's findings and evidence, the consolidated recommendation, the execution trace, and the human decision controls.

## Architecture

```
React + TypeScript (Vite, :5173)
        │  /api  (proxied in development)
        ▼
Express + TypeScript (:4000)
  routes (Zod validation) ──► ReviewService (business rules, conflict guards)
                                 │                    │
                                 ▼                    ▼
                         Supervisor/Orchestrator   Repository (all SQL)
                                 │                    │
        Document ─┐              │                    ▼
        Identity ─┴► Risk ─► Recommendation       SQLite (better-sqlite3)
                                 │
                        safety guard ─► autonomy policy
```

- **Shared contracts:** Zod schemas in `server/src/schemas` are the single source of truth; TypeScript types are inferred from them and imported (type-only) by the frontend.
- **Agents** are pure, async (so a real LLM implementation could replace a mock), independently testable, and never call each other — every hand-off goes through the supervisor.
- **Persistence:** every agent attempt, audit event and human decision is stored. The audit table is append-only (enforced by database triggers).

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| [Node.js](https://nodejs.org/) | **22 or later** (tested with 22.23) | Required by `better-sqlite3` |
| npm | 10+ | Comes with Node.js |
| `sqlite3` CLI | any 3.x | *Optional* — only for `npm run db:reset` and `database/verify.sql`. The server creates and seeds the database itself. |

## Installation and running

```bash
git clone https://github.com/manvideore21/Multi-Agent-Onboarding-Case-Reviewer.git
cd Multi-Agent-Onboarding-Case-Reviewer

# 1. Install dependencies
cd server && npm install
cd ../client && npm install
cd ..
```

Run the backend and frontend in **two terminals**:

```bash
# Terminal 1 — API on http://localhost:4000/api
cd server
npm start            # or: npm run dev   (auto-reload)
```

```bash
# Terminal 2 — UI on http://localhost:5173
cd client
npm run dev
```

Open **http://localhost:5173**.

On first start the server creates `database/onboarding.db` from `database/schema.sql` and loads `database/seed.sql` (three synthetic cases). Nothing else needs to be set up.

### Configuration (optional)

Defaults work out of the box. To override them, copy `server/.env.example` to `server/.env`:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | API port (the Vite proxy in `client/vite.config.ts` expects 4000) |
| `DATABASE_PATH` | `../database/onboarding.db` | SQLite file, relative to `server/` |
| `MAX_AGENT_ATTEMPTS` | `2` | Attempts per agent, including the first (1 initial + 1 retry) |

No secrets are required, and nothing in the configuration is exposed to the frontend.

### Resetting the demo data

Reviews and decisions change case state (a decided case cannot be reviewed again). To restore the three seeded cases:

```bash
cd server
npm run db:reset     # requires the sqlite3 CLI
```

Without the `sqlite3` CLI: stop the server, delete `database/onboarding.db` (and any `-wal`/`-shm` files), and start the server again.

> After changing `database/schema.sql`, reset the database — the schema uses `CREATE TABLE IF NOT EXISTS` and will not alter an existing file.

### Production build of the UI (optional)

```bash
cd client && npm run build    # output in client/dist
```

## Using the application

1. Select a case in the left-hand list (the list shows status and the latest assessed risk level).
2. Review the synthetic profile, documents and risk indicators.
3. Choose an **autonomy mode** and click **Run review**. The button is disabled while a review is running, and when the case is awaiting a decision or already decided.
4. Inspect the **Recommendation and outcome** panel (workflow state, agent recommendation and final outcome are shown separately), each **agent's findings and evidence**, and the **execution trace**.
5. If a human decision is required, enter a reviewer name and **Approve** or **Reject**. A comment is required whenever the decision does not follow an approve/reject recommendation (e.g. approving a referral).
6. *Testing aid:* the **Simulate agent failure** selector forces one agent to fail on every attempt, to demonstrate retries, incomplete checks and safe escalation.

## Seeded cases and expected outcomes

| Case | Scenario | Exception-only mode | Human-approval mode |
|---|---|---|---|
| **CASE-1001** Amelia Hart | Complete documents, consistent identity, only a resolved low flag | `approve` → **completed automatically** under policy | `approve` → waits for human approval |
| **CASE-1002** Ravi Menon | Income proof missing; ID shows "Ravi Men**e**n" | `refer_for_manual_review` → needs manual review | `refer_for_manual_review` → waits for human |
| **CASE-1003** Sofia Marlow | Identity verification pending; open **high** synthetic watchlist-similarity flag | `refer_for_manual_review` → needs manual review | `refer_for_manual_review` → waits for human |

## Workflow rules

### Execution sequence

```
pending → running
  Document Completeness  ┐ independent checks
  Identity Consistency   ┘
  Risk Indicator          (uses both results, including failures)
  Recommendation          (uses all three results)
  safety guard → autonomy policy
→ completed | needs_human_approval | needs_manual_review | failed
```

### Recommendation rules (first match wins)

| Rule | Condition | Recommendation |
|---|---|---|
| R1 | Any upstream agent failed or produced invalid output | `refer_for_manual_review` |
| R2 | Explicit rejection rule: recorded identity verification is *failed*, or an unresolved **critical** risk flag exists | `reject` |
| R3 | Any check failed, or risk escalation is required | `refer_for_manual_review` |
| R4 | All three checks passed and risk level is low | `approve` |

Missing information alone never causes rejection.

### Autonomy policy

| Recommendation (after safety guard) | Human approval required | Exception only |
|---|---|---|
| `approve` (R4, all checks passed) | `needs_human_approval` | `completed`, outcome *approved* by `auto_policy` |
| `reject` | `needs_human_approval` | `needs_manual_review` |
| `refer_for_manual_review` | `needs_human_approval` | `needs_manual_review` |
| Recommendation agent failed | `failed` | `failed` |

### Reliability and safety

- **Retries:** at most `MAX_AGENT_ATTEMPTS` (default 2). Only thrown errors (assumed transient) are retried; invalid input/output from deterministic agents is not, and a business-rule *fail* is a valid result.
- **Failed check agent:** recorded as `CHECK_INCOMPLETE`, shown as *unavailable*, and never counted as passed; the workflow continues so all findings stay visible, then escalates.
- **Safety guard:** the supervisor independently re-checks any `approve` against the actual check results and downgrades it to a referral (`SAFETY_OVERRIDE`) if anything did not pass.
- **Invariant check:** the final execution record is validated before it is saved; e.g. an automatic outcome is only valid for a clean approve in exception-only mode.
- **Separate concepts:** the agent *recommendation*, the *workflow status* and the *final outcome* (with its source: `human` or `auto_policy`) are stored and displayed separately.
- **No conflicting decisions:** a new review is refused while a decision is pending or once a case is decided; concurrent reviews of one case are blocked; decisions are written in a transaction and the database allows one decision per execution.

## REST API

Base URL: `http://localhost:4000/api`. Errors always have the shape `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Description | Success |
|---|---|---|---|
| GET | `/health` | Service and database health | 200 |
| GET | `/cases` | Case summaries (status, counts, latest execution and risk level) | 200 |
| GET | `/cases/:id` | Full synthetic case with documents and risk indicators | 200 |
| POST | `/cases` | Create a synthetic case (requires `"syntheticDataConfirmed": true`) | 201 |
| POST | `/cases/:id/review` | Run the workflow. Body: `{ "autonomyMode": "human_approval_required" \| "exception_only", "simulateFailure"?: agentName }` | 201 |
| GET | `/cases/:id/executions` | Execution history for a case | 200 |
| GET | `/executions/:id` | Execution with recommendation, agent attempts, audit trace and decision | 200 |
| POST | `/executions/:id/decision` | Record a human decision. Body: `{ "decision": "approved" \| "rejected", "reviewerName", "comment"? }` | 201 |

Common error codes: `VALIDATION_ERROR` / `INVALID_JSON` (400), `NOT_FOUND` (404), `DECISION_PENDING`, `CASE_ALREADY_DECIDED`, `REVIEW_IN_PROGRESS`, `DECISION_ALREADY_RECORDED`, `EXECUTION_NOT_AWAITING_DECISION` (409), `COMMENT_REQUIRED`, `INVALID_WORKFLOW_INPUT` (422).

Example:

```bash
curl -X POST http://localhost:4000/api/cases/CASE-1003/review \
  -H 'Content-Type: application/json' \
  -d '{"autonomyMode":"exception_only"}'
```

## Database

SQLite, defined in `database/schema.sql`:

| Table | Purpose |
|---|---|
| `onboarding_cases` | Synthetic customer profile and case status |
| `supporting_documents` | Document **metadata** only (no files); one per type per case |
| `risk_indicators` | Predefined synthetic risk flags with severity and status |
| `workflow_executions` | One row per review run: mode, status, recommendation, final outcome and its source |
| `agent_results` | Every agent attempt (retries are separate rows) with JSON output or error |
| `audit_events` | Append-only ordered trace (update/delete blocked by triggers) |
| `human_decisions` | At most one reviewer decision per execution |

Useful commands (from the repository root, `sqlite3` CLI required):

```bash
sh database/reset.sh                                   # recreate and seed
sqlite3 database/onboarding.db < database/verify.sql   # integrity checks and scenario queries
```

## Testing

```bash
cd server
npm run typecheck    # TypeScript compilation
npm test             # Vitest: 97 tests
```

| Test file | Covers |
|---|---|
| `schemas/schemas.test.ts` | Contract invariants (no contradictory "pass", explicit failures, no unsafe automatic outcome) |
| `agents/*.test.ts` | Each agent separately, plus the real agent chain |
| `orchestrator/supervisor.test.ts` | Sequence, both autonomy modes, retries, failed agents, safety guard, policy matrix |
| `api/api.test.ts` | HTTP + real schema/seed in in-memory SQLite: all endpoints, persistence, human decisions, concurrent conflicting decisions, invalid input, failed agents never auto-approved |

Frontend checks:

```bash
cd client
npx tsc -b && npm run lint && npm run build
```

## Project structure

```
database/            schema.sql, seed.sql, verify.sql, reset.sh
server/
  src/schemas/       Zod contracts (domain, agents, workflow, api)
  src/types/         Inferred domain types + raw database row types
  src/agents/        Four deterministic agents + single-attempt executor
  src/orchestrator/  Supervisor (sequencing, retries, trace) + policy (safety guard, autonomy)
  src/services/      Review and human-decision business rules
  src/db/            SQLite connection + repository
  src/api/           Express routes + error handling
  src/testFixtures/  In-memory copies of the seeded cases
  .env.example
client/
  src/api/           Typed API client (types imported from the server)
  src/components/    Case list, details, review controls, findings, recommendation, decision, trace
```

## Limitations

- Agents are **deterministic rule-based mocks** behind an async agent interface; no external LLM is called.
- Document checks use metadata only; nothing is authenticated.
- The in-process review lock assumes a single server instance.
- There is no authentication; the reviewer name is free text. This is a demonstration, not a production system.

## AI development tools used

This project was developed with **Claude Code** (Anthropic's agentic coding CLI, model Claude Opus 5.5) as an AI pair-programmer, working in small, reviewed phases: database → contracts → each agent → orchestrator → API → backend verification → frontend → documentation. The developer defined the requirements and approved each phase; Claude Code proposed the design, wrote the code and tests, and ran type-checks, the Vitest suite, `curl` checks and a headless-browser UI check against the running application, reporting the actual results.
