#!/usr/bin/env node
/**
 * Phase 4 of the Track B rebuild: the LLM-backed proposer.
 *
 * This is the ONLY producer of a proposal that calls a model. `scripts/lib/propose.mjs`
 * stays the deterministic offline proposer the seed and Phase 5's in-browser button use;
 * this script exists so the demo can show a REAL model proposal, and so Phase 7's eval
 * can score a model against the same ground truth it scores the heuristic against.
 *
 * WHAT IT WRITES is exactly what the seed writes: `case.proposal` plus one `caseEvent`,
 * in a single transaction. Anything the UI renders from a seeded proposal, it renders
 * from an LLM proposal too, because the shape is identical - `model` is what tells them
 * apart ("offline-heuristic-v1" vs a model id).
 *
 * IDEMPOTENT: without `--dev` a case that is not at stage `detected` is skipped, so a
 * re-run cannot silently rewrite a proposal a human is already reviewing. `--dev` clears
 * the proposal and its `proposed` event first, then re-proposes.
 *
 * Usage:
 *   node --env-file=.env scripts/agent.mjs --case case-refund-window-1
 *   node --env-file=.env scripts/agent.mjs --all
 *   node --env-file=.env scripts/agent.mjs --case case-refund-window-1 --dev
 *
 * Requires SANITY_WRITE_TOKEN (same as the seed) and LLM_API_KEY.
 */
import {pathToFileURL} from 'node:url'

import {createClient} from '@sanity/client'

const PROJECT_ID = 'cqb58l0f'
const DATASET = 'production'
const API_VERSION = '2025-01-01'

/** Bumped when the prompt below changes, so a stored proposal stays attributable. */
const PROMPT_VERSION = 'agent-llm-v1'

const MAX_TOKENS = 1200

const SYSTEM_PROMPT =
  'You are a careful governance agent arbitrating between conflicting documentation sources. ' +
  'A human will review your proposal and may overrule it. You must reply with a single JSON object.'

/**
 * The three supported providers.
 *
 * `openai` and `groq` share a builder because Groq is OpenAI-compatible: same path shape,
 * same body, same `choices[0].message.content` response. Only the host differs.
 *
 * Model defaults are overridable with LLM_MODEL. They are cheap, current models rather
 * than the strongest available: this task is a constrained choice, and the eval compares
 * the model against a deterministic heuristic, so cost matters more than depth.
 */
const PROVIDERS = {
  anthropic: {
    label: 'Anthropic Messages API',
    url: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-haiku-4-5-20251001',
    buildRequest({apiKey, model, userPrompt}) {
      return {
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: {
          model,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{role: 'user', content: userPrompt}],
        },
      }
    },
    readText: (data) => data?.content?.find((block) => block.type === 'text')?.text,
    readUsage: (data) => ({input: data?.usage?.input_tokens, output: data?.usage?.output_tokens}),
  },

  openai: {
    label: 'OpenAI chat completions',
    url: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o-mini',
    buildRequest: openAiStyleRequest,
    readText: readOpenAiText,
    readUsage: readOpenAiUsage,
  },

  groq: {
    label: 'Groq (OpenAI-compatible)',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    defaultModel: 'llama-3.1-70b-versatile',
    buildRequest: openAiStyleRequest,
    readText: readOpenAiText,
    readUsage: readOpenAiUsage,
  },
}

function openAiStyleRequest({apiKey, model, userPrompt}) {
  return {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: {
      model,
      messages: [
        {role: 'system', content: SYSTEM_PROMPT},
        {role: 'user', content: userPrompt},
      ],
      temperature: 0,
      // Groq and OpenAI both accept this. The prompt contains the literal word "JSON",
      // which OpenAI requires before it will honour `json_object` mode.
      response_format: {type: 'json_object'},
    },
  }
}

/**
 * Shared by the `openai` and `groq` entries, which return the same response shape.
 *
 * Declared as function statements rather than `const` arrows on purpose: `PROVIDERS`
 * above references them during module initialisation, and a `const` is still in the
 * temporal dead zone at that point. That mistake made the script crash on startup while
 * still passing `node --check`.
 */
function readOpenAiText(data) {
  return data?.choices?.[0]?.message?.content
}

function readOpenAiUsage(data) {
  return {
    input: data?.usage?.prompt_tokens,
    output: data?.usage?.completion_tokens,
  }
}

/** Raised for anything the model got wrong, so callers can report it precisely. */
class LlmOutputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LlmOutputError'
  }
}

function printUsage() {
  console.log('Usage:')
  console.log('  node --env-file=.env scripts/agent.mjs --case <caseId>')
  console.log('  node --env-file=.env scripts/agent.mjs --all')
  console.log('  node --env-file=.env scripts/agent.mjs --case <caseId> --dev')
  console.log('')
  console.log('  --case <id>  propose for one case')
  console.log('  --all        propose for every case still at stage "detected"')
  console.log('  --dev        replace an existing proposal (clears it and its event first)')
  console.log('')
  console.log('Environment:')
  console.log('  SANITY_WRITE_TOKEN  Editor token for the project (required)')
  console.log('  LLM_API_KEY         API key for the chosen provider (required)')
  console.log('  LLM_PROVIDER        anthropic | openai | groq   (default: anthropic)')
  console.log('  LLM_MODEL           model id               (default: per provider)')
}

/** Hand-rolled so the script has no dependencies. Unknown flags are an error, not a shrug. */
function parseArgs(argv) {
  const args = {caseId: null, all: false, dev: false, help: false}

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    if (token === '--case') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error('--case needs a case id, e.g. --case case-refund-window-1')
      }
      args.caseId = value
      index += 1
    } else if (token === '--all') {
      args.all = true
    } else if (token === '--dev') {
      args.dev = true
    } else if (token === '--help' || token === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${token}`)
    }
  }

  if (!args.help && !args.caseId && !args.all) {
    throw new Error('Pass either --case <caseId> or --all.')
  }
  if (args.caseId && args.all) {
    throw new Error('Pass either --case <caseId> or --all, not both.')
  }

  return args
}

/** Fails loudly rather than defaulting, because a silent fallback picks the wrong vendor. */
function resolveProvider() {
  const name = (process.env.LLM_PROVIDER ?? 'anthropic').trim().toLowerCase()
  const provider = PROVIDERS[name]

  if (!provider) {
    throw new Error(
      `LLM_PROVIDER "${name}" is not supported. Use one of: ${Object.keys(PROVIDERS).join(', ')}.`,
    )
  }

  return {name, provider, model: (process.env.LLM_MODEL ?? '').trim() || provider.defaultModel}
}

function requireApiKey() {
  const apiKey = process.env.LLM_API_KEY

  if (!apiKey) {
    console.error('Error: the LLM_API_KEY environment variable is not set.')
    console.error('')
    console.error('The agent needs a model to propose with. Either put it in a .env file:')
    console.error('')
    console.error('  LLM_PROVIDER=anthropic')
    console.error('  LLM_API_KEY="<your-key>"')
    console.error('  LLM_MODEL=claude-haiku-4-5-20251001')
    console.error('')
    console.error('...and run this script with --env-file=.env, or export it inline:')
    console.error('')
    console.error('  LLM_API_KEY="<your-key>" SANITY_WRITE_TOKEN="<token>" \\')
    console.error('    node scripts/agent.mjs --case case-refund-window-1')
    console.error('')
    console.error('This script will not fall back to the offline proposer: a proposal recorded')
    console.error('as model output must actually come from a model.')
    process.exitCode = 1
  }

  return apiKey
}

function requireSanityToken() {
  const token = process.env.SANITY_WRITE_TOKEN

  if (!token) {
    console.error('Error: the SANITY_WRITE_TOKEN environment variable is not set.')
    console.error('')
    console.error('Create an Editor (write) token for this project:')
    console.error(`  https://www.sanity.io/manage/project/${PROJECT_ID}/api#tokens`)
    console.error('')
    console.error('Then run:')
    console.error('  SANITY_WRITE_TOKEN="<your-token>" node scripts/agent.mjs --all')
    process.exitCode = 1
  }

  return token
}

/**
 * THE PROMPT. Kept as one literal, with {{PLACEHOLDERS}}, so the exact text that produced a
 * stored proposal is readable in the source rather than assembled across a dozen calls.
 *
 * Three things in here are deliberate and load-bearing:
 *
 * - The category list is ordered, and rule 1 is stated before rule 2, because "authority
 *   beats recency" is a genuine policy choice a model will otherwise guess at.
 * - Category 5 exists because `case.proposal` can ONLY name one of the case's claims: the
 *   schema has no `proposal.outcomeValue`. Rather than let the model walk into an answer
 *   the data model cannot store, it is told that a true tie still names a claim at low
 *   confidence - which is exactly what the deterministic proposer's rule 4 does (0.5).
 * - The word "JSON" appears literally, which OpenAI requires before it will honour
 *   `response_format: {type: "json_object"}`.
 */
const PROMPT_TEMPLATE = `You are arbitrating a contradiction between sources in a company knowledge base. A human reviewer will approve or overrule your proposal, and your proposal is stored permanently and scored against their ruling. Choose the single claim that should govern.

TOPIC
  Name: {{TOPIC_NAME}}
  Description: {{TOPIC_DESCRIPTION}}

CLAIMS IN CONFLICT (choose your outcome from these ids)
{{CLAIMS}}

PRIOR RULINGS ON THIS SAME TOPIC (most recent first)
{{SAME_TOPIC_PRECEDENTS}}

PRIOR RULINGS ON OTHER TOPICS THAT TURNED ON A SIMILAR SOURCE CONFLICT
{{CROSS_TOPIC_PRECEDENTS}}

HOW TO DECIDE
Apply the first principle that separates the claims:
  1. AUTHORITY BEATS RECENCY. Source types rank official > internal > external > community.
     A higher-authority source outranks a newer lower-authority one.
  2. NEWER SUPERSEDES OLDER. At equal authority, the more recently reviewed source wins.
  3. PRECEDENT APPLIES. A prior ruling on this topic, or one that turned on the same kind of
     source conflict, should be followed unless this case is materially different. Cite it
     with relation "follows".
  4. PRECEDENT MISLEADS. If a prior ruling looks like a precedent but its reasoning does not
     transfer, cite it with relation "distinguishes" and say why it does not apply.
  5. TRUE TIE. If nothing above separates the claims, still name one claim as the outcome and
     report LOW confidence. A proposal must name a claim; establishing a brand-new value is
     reserved for a human ruling, not for a proposal.

OUTPUT
Reply with ONLY a JSON object. No prose, no markdown fences, no explanation outside the object. Shape:

{
  "outcomeId": "<id of the winning claim, copied exactly from CLAIMS IN CONFLICT>",
  "outcomeValue": null,
  "rationale": "<two or three sentences naming the sources and the principle you applied>",
  "confidence": <number between 0 and 1>,
  "precedents": [{"instructionId": "<id of a prior ruling listed above>", "relation": "follows"}]
}

Constraints:
  - Exactly one of "outcomeId" or "outcomeValue" must be non-null. Per rule 5, "outcomeId"
    is the correct choice here: "outcomeValue" is only for a human ruling that establishes
    a value no claim asserts.
  - "confidence" must be a number from 0 to 1. Use 0.5 or below when the call was close.
  - "precedents" may be empty. "relation" must be "follows", "distinguishes" or "overrules".
    Cite only instruction ids that appear above, and cite nothing rather than inventing one.`

/** `{{KEY}}` substitution. A missing key stays visible, so a bug shows up rather than silently blanking. */
function fillTemplate(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  )
}

function formatClaims(claims) {
  return claims
    .map(
      (claim) =>
        `  - id: ${claim._id}\n` +
        `    value: ${claim.value ?? '(none)'}\n` +
        `    statement: ${claim.statement ?? '(none)'}\n` +
        `    source: ${claim.sourceTitle ?? 'unknown'} (type: ${claim.sourceType ?? 'unknown'}, ` +
        `last reviewed: ${(claim.lastReviewedAt ?? 'unknown').slice(0, 10)})\n` +
        `    claim confidence: ${typeof claim.confidence === 'number' ? claim.confidence : 'not stated'}`,
    )
    .join('\n')
}

function formatPrecedents(precedents) {
  if (precedents.length === 0) return '  (none)'

  return precedents
    .map((precedent) => {
      const outcome = precedent.winnerValue ?? precedent.outcomeValue ?? '(no value recorded)'
      const overruled = (precedent.overruledValues ?? []).filter(Boolean)
      return (
        `  - id: ${precedent._id}\n` +
        `    decided: ${(precedent.decidedAt ?? '').slice(0, 10)} · topic: ${precedent.topic ?? 'unknown'}\n` +
        `    ruling: ${precedent.resolution ?? '(no text)'}\n` +
        `    upheld value: ${outcome}` +
        (overruled.length > 0 ? `\n    overruled values: ${overruled.join(', ')}` : '')
      )
    })
    .join('\n')
}

function buildPrompt({caseDocument, sameTopicPrecedents, crossTopicPrecedents}) {
  return fillTemplate(PROMPT_TEMPLATE, {
    TOPIC_NAME: caseDocument.topicName ?? 'Untitled topic',
    TOPIC_DESCRIPTION: caseDocument.topicDescription ?? '(no description)',
    CLAIMS: formatClaims(caseDocument.claims),
    SAME_TOPIC_PRECEDENTS: formatPrecedents(sameTopicPrecedents),
    CROSS_TOPIC_PRECEDENTS: formatPrecedents(crossTopicPrecedents),
  })
}

/**
 * Calls the provider and returns its text plus token usage.
 *
 * An HTTP failure surfaces the PROVIDER'S OWN error body rather than a generic message:
 * the most likely failure here is a model id the account cannot use, and that error names
 * the models which are available.
 */
async function callLlm({providerName, provider, apiKey, model, userPrompt}) {
  const {headers, body} = provider.buildRequest({apiKey, model, userPrompt})

  const response = await fetch(provider.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(
      `${providerName} returned HTTP ${response.status} ${response.statusText}. ${detail.slice(0, 600)}`,
    )
  }

  const data = await response.json()
  const text = provider.readText(data)

  if (typeof text !== 'string' || text.trim() === '') {
    throw new LlmOutputError(
      `${providerName} returned no text content. Response was: ${JSON.stringify(data).slice(0, 400)}`,
    )
  }

  return {text, usage: provider.readUsage(data)}
}

const RELATIONS = new Set(['follows', 'distinguishes', 'overrules'])

/**
 * Pulls a JSON object out of whatever the model actually sent.
 *
 * Three defences, in order, because each is a real failure mode of cheap models: a
 * markdown fence, prose wrapped around the object, and a brace-containing sentence before
 * the object. Anything still unparseable throws with the raw text attached, so an operator
 * sees exactly what arrived instead of guessing.
 */
function tryParse(value) {
  try {
    return {ok: true, value: JSON.parse(value)}
  } catch (error) {
    return {ok: false, error}
  }
}

function extractJsonObject(text) {
  let candidate = text.trim()

  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidate = fenced[1].trim()

  const whole = tryParse(candidate)
  if (whole.ok) return whole.value

  // Prose around the object, possibly containing braces of its own. Try every opening
  // brace in turn and keep the first slice that parses: a single `indexOf('{')` is not
  // enough, because "note the {placeholder}" before the answer would defeat it.
  for (let start = candidate.indexOf('{'); start !== -1; start = candidate.indexOf('{', start + 1)) {
    const end = candidate.lastIndexOf('}')
    if (end <= start) break

    const attempt = tryParse(candidate.slice(start, end + 1))
    if (attempt.ok) return attempt.value
  }

  throw new LlmOutputError(
    `Could not parse the model output as JSON (${whole.error.message}). ` +
      `Raw output was: ${text.slice(0, 500)}`,
  )
}

/**
 * Drops citations that are unusable instead of failing the whole proposal.
 *
 * A citation the model invented cannot be stored usefully: it would render as an
 * unresolvable reference in the UI. A hallucinated precedent is a data-quality problem
 * worth reporting, but not worth discarding an otherwise good ruling over.
 */
function validatePrecedents(raw, offeredIds) {
  const warnings = []

  if (raw == null) return {precedents: [], warnings}
  if (!Array.isArray(raw)) {
    warnings.push(`"precedents" was not an array (got ${typeof raw}); ignored.`)
    return {precedents: [], warnings}
  }

  const precedents = []
  raw.forEach((entry, index) => {
    const position = index + 1
    const instructionId = typeof entry?.instructionId === 'string' ? entry.instructionId.trim() : null
    const relation = typeof entry?.relation === 'string' ? entry.relation.trim().toLowerCase() : null

    if (!instructionId || !relation) {
      warnings.push(`dropped precedent ${position}: missing instructionId or relation`)
      return
    }
    if (!RELATIONS.has(relation)) {
      warnings.push(
        `dropped precedent ${position}: relation "${relation}" is not follows|distinguishes|overrules`,
      )
      return
    }
    if (!offeredIds.includes(instructionId)) {
      warnings.push(`dropped precedent ${position}: "${instructionId}" was never offered to the model`)
      return
    }

    precedents.push({
      _type: 'precedent',
      _key: `agent-prec-${index}`,
      instruction: {_type: 'reference', _ref: instructionId},
      relation,
    })
  })

  return {precedents, warnings}
}

/**
 * Validates the model's answer against the schema's own rules.
 *
 * The `outcomeValue` branch is parsed - the contract allows it - and then refused, because
 * `case.proposal` has no `outcomeValue` field (only `instruction` does). Writing a
 * proposal without an outcome would fail the proposal validator and leave a case that
 * renders as though the agent had said nothing.
 */
function validateProposal(raw, {claimIds, offeredPrecedentIds}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LlmOutputError(
      `Expected a JSON object, got ${Array.isArray(raw) ? 'an array' : typeof raw}.`,
    )
  }

  const outcomeId = typeof raw.outcomeId === 'string' && raw.outcomeId.trim() ? raw.outcomeId.trim() : null
  const outcomeValue =
    typeof raw.outcomeValue === 'string' && raw.outcomeValue.trim() ? raw.outcomeValue.trim() : null

  if (Boolean(outcomeId) === Boolean(outcomeValue)) {
    throw new LlmOutputError(
      'Exactly one of "outcomeId" / "outcomeValue" must be set, but got ' +
        `outcomeId=${JSON.stringify(raw.outcomeId)} and outcomeValue=${JSON.stringify(raw.outcomeValue)}.`,
    )
  }

  if (outcomeValue) {
    throw new LlmOutputError(
      `The model wanted to establish a new value ("${outcomeValue}") instead of naming a claim. ` +
        'A proposal cannot record that: `case.proposal` has no outcomeValue field, only ' +
        '`instruction` does. Either re-run, or add that field to the proposal schema.',
    )
  }

  if (!claimIds.includes(outcomeId)) {
    throw new LlmOutputError(
      `"${outcomeId}" is not one of this case's claims. Valid ids: ${claimIds.join(', ')}`,
    )
  }

  if (typeof raw.rationale !== 'string' || raw.rationale.trim().length === 0) {
    throw new LlmOutputError('The model returned no "rationale" string.')
  }

  // Cheap models sometimes quote the number. Only numeric strings are accepted, and the
  // range is still enforced: this widens the accepted syntax without loosening the rule.
  const confidence = typeof raw.confidence === 'string' ? Number(raw.confidence) : raw.confidence
  if (typeof confidence !== 'number' || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
    throw new LlmOutputError(
      `"confidence" must be a number from 0 to 1, but got ${JSON.stringify(raw.confidence)}.`,
    )
  }

  const {precedents, warnings} = validatePrecedents(raw.precedents, offeredPrecedentIds)

  return {outcomeId, rationale: raw.rationale.trim(), confidence, precedents, warnings}
}

/**
 * Every case still at stage `detected`.
 *
 * This uses the FILTER form of the stage derivation. That form was verified against the
 * projection form for all four stages on the live dataset, because `^` inside a nested
 * subquery is exactly the kind of thing that silently returns nothing rather than erroring.
 */
const DETECTED_CASES_QUERY = `*[_type == "case" && coalesce(
    *[_type == "caseEvent" && case._ref == ^._id] | order(at desc)[0].to,
    "detected"
  ) == "detected"]._id`

/**
 * Everything the prompt needs about one case. Sources are FLATTENED here rather than
 * nested, because that is how the prompt prints them, and one projection is cheaper than
 * dereferencing again in JS.
 */
const CASE_QUERY = `*[_type == "case" && _id == $caseId][0]{
  _id,
  detectedBy,
  "topicId": topic._ref,
  "topicName": topic->name,
  "topicDescription": topic->description,
  "stage": coalesce(
    *[_type == "caseEvent" && case._ref == $caseId] | order(at desc)[0].to,
    "detected"
  ),
  "claims": claims[]->{
    _id,
    statement,
    value,
    confidence,
    "sourceTitle": source->title,
    "sourceType": source->sourceType,
    "lastReviewedAt": source->lastReviewedAt
  },
  "proposal": proposal{
    "outcome": outcome->{_id, value},
    confidence,
    model,
    proposedAt
  }
}`

/**
 * Prior rulings on this topic, newest first, capped at five.
 *
 * Superseded rulings are deliberately INCLUDED. A ruling that was later replaced is often
 * the most informative precedent there is - `case-trial-period` exists to show exactly
 * that - so filtering for "still current" would hide the case's whole point.
 */
const SAME_TOPIC_PRECEDENTS_QUERY = `*[_type == "instruction"
    && appliesToTopic._ref == $topicId
    && case._ref != $caseId
  ] | order(decidedAt desc)[0..4]{
    _id,
    resolution,
    outcomeValue,
    decidedAt,
    "topic": appliesToTopic->name,
    "winnerValue": winner->value,
    "overruledValues": overruled[]->value
  }`

/**
 * Rulings on OTHER topics, restricted to those whose winner came from one of the source
 * types in play here - the "does this precedent transfer?" evidence.
 */
const CROSS_TOPIC_PRECEDENTS_QUERY = `*[_type == "instruction"
    && appliesToTopic._ref != $topicId
    && winner->source->sourceType in $sourceTypes
  ] | order(decidedAt desc)[0..4]{
    _id,
    resolution,
    outcomeValue,
    decidedAt,
    "topic": appliesToTopic->name,
    "winnerValue": winner->value,
    "overruledValues": overruled[]->value
  }`

const PROPOSED_EVENT_IDS_QUERY = `*[_type == "caseEvent" && case._ref == $caseId && to == "proposed"]._id`

/** Recorded in the event's payload so a proposal's cost is auditable after the fact. */
function tokenNote({usage, providerName, model}) {
  const {input, output} = usage ?? {}

  if (typeof input !== 'number' && typeof output !== 'number') {
    return `provider=${providerName} model=${model} (provider did not report token usage)`
  }

  return (
    `provider=${providerName} model=${model} ` +
    `promptTokens=${input ?? '?'} completionTokens=${output ?? '?'}`
  )
}

/** `--dev` only: removes the proposal and the event that recorded it. */
async function clearProposal(client, caseId) {
  const proposedEventIds = await client.fetch(PROPOSED_EVENT_IDS_QUERY, {caseId})

  const transaction = client.transaction()
  transaction.patch(caseId, {unset: ['proposal']})
  for (const eventId of proposedEventIds) transaction.delete(eventId)
  await transaction.commit()

  console.log(
    `  · --dev: cleared the existing proposal and ${proposedEventIds.length} "proposed" event(s)`,
  )
}

async function proposeForCase({client, caseId, dev, providerName, provider, apiKey, model}) {
  console.log(`proposing for ${caseId}...`)

  const caseDocument = await client.fetch(CASE_QUERY, {caseId})
  if (!caseDocument) {
    throw new Error(`No case found with _id "${caseId}".`)
  }

  if (caseDocument.stage !== 'detected') {
    if (!dev) {
      console.log(
        `  · skipped: stage is "${caseDocument.stage}", not "detected" ` +
          `(pass --dev to replace an existing proposal)`,
      )
      return {skipped: true}
    }
    if (caseDocument.stage !== 'proposed') {
      throw new Error(
        `--dev can only replace a case at stage "proposed"; "${caseId}" is "${caseDocument.stage}". ` +
          'Re-seed to put it back at "detected".',
      )
    }
    await clearProposal(client, caseId)
  }

  const claimIds = caseDocument.claims.map((claim) => claim._id)
  if (caseDocument.claims.length < 2) {
    throw new Error(
      `Case "${caseId}" has ${caseDocument.claims.length} claim(s); a proposal needs at least two.`,
    )
  }

  const sourceTypes = [...new Set(caseDocument.claims.map((claim) => claim.sourceType).filter(Boolean))]

  const sameTopicPrecedents = await client.fetch(SAME_TOPIC_PRECEDENTS_QUERY, {
    topicId: caseDocument.topicId,
    caseId,
  })
  const crossTopicPrecedents = await client.fetch(CROSS_TOPIC_PRECEDENTS_QUERY, {
    topicId: caseDocument.topicId,
    sourceTypes,
  })

  const userPrompt = buildPrompt({caseDocument, sameTopicPrecedents, crossTopicPrecedents})
  const {text, usage} = await callLlm({providerName, provider, apiKey, model, userPrompt})

  const proposal = validateProposal(extractJsonObject(text), {
    claimIds,
    offeredPrecedentIds: [...sameTopicPrecedents, ...crossTopicPrecedents].map(
      (precedent) => precedent._id,
    ),
  })

  for (const warning of proposal.warnings) console.log(`  ⚠ ${warning}`)

  const outcomeClaim = caseDocument.claims.find((claim) => claim._id === proposal.outcomeId)
  console.log(`  outcome: ${outcomeClaim?.value ?? proposal.outcomeId}, confidence ${proposal.confidence}`)

  const now = new Date().toISOString()
  // Deterministic per case and second, so an accidental double-run inside the same second
  // cannot produce two identical events.
  const eventId = `agentevent-${caseId}-${now.replace(/[:.]/g, '-')}`

  const transaction = client.transaction()
  transaction.patch(caseId, {
    set: {
      proposal: {
        outcome: {_type: 'reference', _ref: proposal.outcomeId},
        rationale: proposal.rationale,
        confidence: proposal.confidence,
        precedents: proposal.precedents,
        proposedAt: now,
        model,
        promptVersion: PROMPT_VERSION,
      },
    },
  })
  transaction.create({
    _id: eventId,
    _type: 'caseEvent',
    case: {_type: 'reference', _ref: caseId},
    from: 'detected',
    to: 'proposed',
    actor: {kind: 'agent', id: model, label: model},
    at: now,
    payload: {
      agentOutcomeId: proposal.outcomeId,
      note: tokenNote({usage, providerName, model}),
    },
  })

  // One transaction: a proposal is never stored without the event that explains it.
  await transaction.commit()

  console.log(`  ✔ wrote case.proposal and caseEvent ${eventId}`)
  return {skipped: false}
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    printUsage()
    return
  }

  const apiKey = requireApiKey()
  const token = requireSanityToken()
  if (!apiKey || !token) return

  const {name: providerName, provider, model} = resolveProvider()
  console.log(`agent: provider=${providerName} model=${model} prompt=${PROMPT_VERSION}`)

  const client = createClient({
    projectId: PROJECT_ID,
    dataset: DATASET,
    apiVersion: API_VERSION,
    token,
    // A proposal must be readable by the app immediately after this exits.
    useCdn: false,
  })

  if (args.all && args.dev) {
    console.log('note: --all only targets cases at stage "detected", so --dev has nothing to clear.')
  }

  const caseIds = args.all ? await client.fetch(DETECTED_CASES_QUERY) : [args.caseId]

  if (caseIds.length === 0) {
    console.log('no cases at stage "detected" - nothing to propose.')
    console.log('(use --case <id> --dev to replace an existing proposal instead)')
    return
  }

  let proposed = 0
  let skipped = 0
  const failures = []

  for (const caseId of caseIds) {
    try {
      const result = await proposeForCase({client, caseId, dev: args.dev, providerName, provider, apiKey, model})
      if (result.skipped) skipped += 1
      else proposed += 1
    } catch (error) {
      // One bad case must not abandon the rest of a --all run.
      failures.push({caseId, message: error.message})
      console.error(`  ✖ ${caseId}: ${error.message}`)
    }
  }

  console.log('')
  console.log(`done: ${proposed} proposed · ${skipped} skipped · ${failures.length} failed`)

  if (failures.length > 0) {
    console.error('')
    for (const failure of failures) {
      console.error(`  ✖ ${failure.caseId}: ${failure.message}`)
    }
    process.exitCode = 1
  }
}

/**
 * Runs only when invoked directly, so a harness can import the parsing and prompt helpers
 * and exercise them without firing an API call or touching the dataset.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`)
    process.exitCode = 1
  })
}

export {buildPrompt, extractJsonObject, parseArgs, validatePrecedents, validateProposal}

// `PROVIDERS` is exported so a harness can assert each provider's request shape without
// making a network call.
export {PROVIDERS}
