# Contradiction Triage

A governance tool for structured content, built on the [Sanity App SDK](https://www.sanity.io/docs/app-sdk).

When two sources disagree, an agent proposes a ruling with cited precedent, a human approves or overrides it, and the decision becomes a typed, queryable document that future decisions can cite.

**Submission for the DEV × Sanity Challenge.**

**Demo video:** https://youtu.be/3FO7lC7xahg

---

## Contents

- [What it does](#what-it-does)
- [The schema](#the-schema)
- [Workflow](#workflow)
- [Setup](#setup)
- [Commands](#commands)
- [Scripts](#scripts)
- [The Two Proposers](#the-two-proposers)
- [Human-in-the-Loop](#human-in-the-loop)
- [Demo](#demo)
- [Deployment](#deployment)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Challenge](#challenge)



## What it does

Contradiction Triage turns conflicting claims into a structured review workflow.

**Three main views**


| View        | What it shows                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| **Triage**  | The work queue, grouped by stage: awaiting your ruling, needs a proposal, recent rulings, and superseded cases. |
| **History** | Every ruling that has been made, including attribution and precedent citations.                                 |
| **Answers** | The canonical answer for each topic, with provenance.                                                           |


The workflow is designed around a simple principle:

> **AI can propose. A human decides.**



## The schema

The app uses six document types:

- `source`
- `topic`
- `claim`
- `case`
- `caseEvent`
- `instruction`

It also uses one embedded object type, `precedent`, which records *how* a ruling used a prior ruling: `follows`, `distinguishes`, or `overrules`. It is used in two places, deliberately:

- `case.proposal.precedents`: what the agent chose to cite (frozen as evidence, so it can be scored)
- `instruction.precedents`: what the ruling actually relied on (the durable chain)

The workflow state machine lives in `workflow.def.json` and is validated against every event. `case.stage` is derived from the latest `caseEvent` rather than stored, so a case's stage cannot drift from its event log.

**Core invariant:** `ruled` may only be fired by a human.

## Workflow

```text
Source
  ↓
Claims extracted
  ↓
Conflicting claims detected
  ↓
Case opened
  ↓
Agent proposes ruling
  ↓
Human reviews
  ↓
Human rules
  ↓
Decision becomes precedent
```

Future cases can retrieve previous rulings as precedent.

## Setup



### Requirements

- **Node.js 22.12+**
- A **Sanity project** (the project ID and dataset are configured in `sanity.config.ts`)
- An **LLM API key**

The repository includes an `.nvmrc` that pins Node `24.11.1`.

### Install

```bash
nvm use
npm install
```



### Environment variables

Copy the environment template:

```bash
cp .env.example .env
```

Then configure:

```bash
# Sanity write token
SANITY_WRITE_TOKEN=

# LLM provider
LLM_PROVIDER=groq
LLM_API_KEY=
LLM_MODEL=openai/gpt-oss-120b
```


| Variable             | Description                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `SANITY_WRITE_TOKEN` | Sanity Editor token used by the scripts to write data                                                                           |
| `LLM_PROVIDER`       | LLM provider used for extraction and proposal generation (`anthropic`, `openai`, or `groq`; defaults to `anthropic` when unset) |
| `LLM_API_KEY`        | API key for the selected LLM provider                                                                                           |
| `LLM_MODEL`          | Optional model override (each provider has a default model)                                                                     |


> **Never commit** `.env` **or any secret tokens.** `.env` is gitignored; `.env.example` is the only environment file that belongs in the repository.



## Commands



### Development

Start the development server:

```bash
npm run dev
```

The CLI prints a Sanity Dashboard URL to open. The app only renders inside the Dashboard, so viewing it requires a signed-in Sanity account.

### Build

```bash
npm run build
```



### Deploy

```bash
npm run deploy
```



### Seed

Reset the dataset to the demo state:

```bash
npm run seed
```

Seed reads its token from the environment, so either export it for the command or point Node at your `.env`:

```bash
SANITY_WRITE_TOKEN="<token>" npm run seed
node --env-file=.env scripts/seed.mjs
```

> `package.json` also defines `npm start`, `npm run studio` (an alias of `dev`), and `npm run studio:build` (an alias of `build`).



## Scripts

The scripts talk to the Content Lake directly. Each one accepts `--help` and prints its own usage.

> The examples below use the `node --env-file=.env scripts/...` form, because that is what loads your `.env`. The scripts never read `.env` implicitly; if your variables are already exported in the shell, the bare `node scripts/...` form works the same way.



### Extract claims

```bash
node --env-file=.env scripts/extract.mjs --source <id>
```

Reads a source's prose and uses an LLM to produce structured claims.

The script runs in dry-run mode by default. To write the generated claims:

```bash
node --env-file=.env scripts/extract.mjs --source <id> --commit
```



### Detect contradictions

```bash
node --env-file=.env scripts/detect.mjs
```

Scans unresolved claims and opens a case for detected conflicts. A dry run needs no write token.

To commit the detected cases:

```bash
node --env-file=.env scripts/detect.mjs --commit
```



### Agent proposer

Propose a ruling for one case:

```bash
node --env-file=.env scripts/agent.mjs --case <id>
```

Or process all cases:

```bash
node --env-file=.env scripts/agent.mjs --all
```



### Evaluation

```bash
node --env-file=.env scripts/eval.mjs
```

Evaluates the deterministic proposer against human rulings and writes an evaluation report to `eval-report.md`.

## The Two Proposers



### Deterministic proposer

Located at:

```text
scripts/lib/propose.mjs
```

The deterministic proposer is a pure function that runs in the browser, so the app can propose a ruling with no network round trip.

It ranks claims using:

- Source authority
- Review date
- Confidence
- Claim ID as a deterministic tie-breaker



### LLM proposer

Located at:

```text
scripts/agent.mjs
```

The LLM proposer:

1. Reads the current case.
2. Retrieves relevant precedent using GROQ.
3. Sends the case and precedent to the configured model.
4. Produces a proposed ruling.
5. Writes the same `case.proposal` shape used by the deterministic proposer.

Both approaches feed the same human-review workflow.

## Human-in-the-Loop

The system deliberately separates proposal from decision.

The agent can suggest a ruling, but it cannot finalize one.

A human must review the case and explicitly create the ruling event.

This makes the resulting decision auditable and allows future decisions to cite the ruling as precedent.

## Demo

The application includes a seeded contradiction scenario so the complete workflow can be demonstrated without manually creating the initial dataset.

Seed the demo data:

```bash
npm run seed
```

Start the app:

```bash
npm run dev
```

Open:

```text
http://localhost:3333
```

The dev server needs a signed-in Sanity account: the CLI prints the Dashboard URL that embeds the app.

## Deployment

Deploy using:

```bash
npm run deploy
```

The deployed App SDK application runs inside the authenticated Sanity Dashboard, so the deployed application requires a Sanity login.

`sanity.cli.ts` holds the organization ID and the deployed app ID, so a deploy needs no interactive app setup.

Challenge judge credentials and access details can be provided separately with the submission.

## Tech Stack

- Sanity App SDK (`@sanity/sdk-react`)
- Sanity UI (`@sanity/ui`)
- Sanity Content Lake
- GROQ
- JavaScript / Node.js
- React 19 and TypeScript
- LLM-backed claim extraction
- LLM-backed ruling proposals
- Deterministic proposal engine



## Project Structure

```text
.
├── scripts/
│   ├── agent.mjs            # LLM proposer: case + precedent -> case.proposal
│   ├── detect.mjs           # Finds conflicting claims, opens cases
│   ├── eval.mjs             # Scores the proposer against human rulings
│   ├── extract.mjs          # LLM claim extraction from a source
│   ├── seed.mjs             # Resets the dataset to the demo state
│   ├── seed-data.mjs        # The demo dataset itself
│   └── lib/
│       ├── propose.mjs      # The deterministic proposer (pure, shared with the app)
│       └── workflow-def.mjs # Loads and validates workflow.def.json
├── schemaTypes/
│   ├── source.ts
│   ├── topic.ts
│   ├── claim.ts
│   ├── case.ts
│   ├── caseEvent.ts
│   ├── instruction.ts
│   ├── precedent.ts         # Embedded object: how a ruling used a prior ruling
│   ├── workflowStages.ts    # Stage and actor vocabularies, mirrored from the JSON
│   └── index.ts
├── src/
│   ├── App.tsx              # SanityApp entry point
│   ├── SanityUI.tsx         # Sanity UI theme provider
│   ├── queries.ts           # GROQ queries
│   ├── types.ts             # Shared types
│   └── components/
│       ├── TriageDashboard.tsx   # Tab shell: Triage, History, Answers
│       ├── ContradictionView.tsx # Case detail: claims, proposal, precedent
│       ├── ResolveForm.tsx       # The human ruling form
│       ├── ProposeActions.tsx    # Runs the deterministic proposer in the app
│       ├── CaseList.tsx          # The work queue, grouped by stage
│       ├── ClaimsList.tsx        # Claims for the selected topic
│       ├── AddClaimDialog.tsx
│       ├── AddSourceDialog.tsx
│       ├── HistoryView.tsx       # Every ruling, with attribution and citations
│       └── AnswersView.tsx       # Canonical answer per topic, with provenance
├── workflow.def.json        # The case state machine, validated against every event
├── sanity.config.ts         # Project, dataset, and schema registration
├── sanity.cli.ts            # Organization ID, app entry, deployed app ID
├── tsconfig.json
├── eval-report.md           # Generated by scripts/eval.mjs
├── .env.example
├── .nvmrc
└── ...
```



## Challenge

Built for the DEV × Sanity Challenge.

Tags: `sanitychallenge` `sanity` `devchallenge` `ai`