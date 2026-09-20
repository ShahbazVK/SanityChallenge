#!/usr/bin/env node
/**
 * Phase 10a: the LLM-backed claim extractor.
 *
 * This closes the intake gap. Until now a claim only existed because a human typed it into
 * the Add Claim form, which left the whole pipeline downstream of manual data entry:
 *
 *   source.content  ->  [extract.mjs]  ->  claims
 *                                        ->  [detect.mjs]  ->  case + detected event
 *                                                           ->  [agent.mjs]  ->  proposal
 *                                                                              ->  human rules
 *
 * DRY RUN BY DEFAULT: nothing is written without `--commit`, so a bad prompt or a
 * hallucinated topic cannot land in the dataset unnoticed.
 *
 * ONE CAVEAT ABOUT THIS DATASET: the reader uses `source.content`, which the seed fills with
 * a one-line SUMMARY of the source ("Customer-facing FAQ."). A summary asserts no facts, so
 * a dry run against a seeded source correctly returns ZERO claims. The script is not the
 * limiting factor - the content is. Put real prose in `content` and it has something to
 * extract.
 *
 * PROVIDER REUSE: `PROVIDERS` (urls, default models, response readers) and
 * `extractJsonObject` (the defensive JSON parser) are imported from `scripts/agent.mjs`.
 * Only the request bodies and the fetch glue are re-stated here; see `buildRequest` for why
 * those two pieces could not be shared.
 *
 * Usage:
 *   node --env-file=.env scripts/extract.mjs --source source-public-faq
 *   node --env-file=.env scripts/extract.mjs --source source-public-faq --commit
 */
import {pathToFileURL} from 'node:url'

import {createClient} from '@sanity/client'

import {PROVIDERS, extractJsonObject} from './agent.mjs'

const PROJECT_ID = 'cqb58l0f'
const DATASET = 'production'
const API_VERSION = '2025-01-01'

/** Bumped when the prompt below changes, so a stored claim batch stays attributable. */
const PROMPT_VERSION = 'extract-v1'

/** Generous: a long source can yield a dozen claims, and the reply is pure JSON. */
const MAX_TOKENS = 3000

const SYSTEM_PROMPT =
  'You extract atomic factual claims from a source document into strict JSON. ' +
  'You only ever use topics from the list you are given, and you never invent one.'

const SOURCE_QUERY = `*[_type == "source" && _id == $sourceId][0] {
  _id,
  title,
  content,
  sourceType,
  lastReviewedAt
}`

/**
 * The only topics the extractor may use. `slug` is the stable key the prompt works in.
 *
 * `description` is LOAD-BEARING, not decoration, and that is a finding rather than a
 * preference: several topics are distinguishable ONLY by it. "Deleted accounts are retained for
 * 60 days before permanent erasure." fits both `data-retention` ("How long we keep customer
 * data") and `account-deletion` ("How long data is retained after an account deletion
 * request"), and with names alone the model chose the wrong one. Sending each topic's
 * description is what makes rule 3a answerable.
 */
const TOPICS_QUERY = `*[_type == "topic"] {
  _id,
  name,
  "slug": slug.current,
  description
} | order(name asc)`

/** Claims this source already contributed, so a re-run does not duplicate them. */
const EXISTING_CLAIMS_QUERY = `*[_type == "claim" && source._ref == $sourceId] {
  _id,
  value,
  "topicRef": topic._ref
}`

// --- CLI -------------------------------------------------------------------------------

function printUsage() {
  console.log('Usage:')
  console.log('  node --env-file=.env scripts/extract.mjs --source <sourceId>            # dry run')
  console.log('  node --env-file=.env scripts/extract.mjs --source <sourceId> --commit   # write')
  console.log('')
  console.log('  --source <id>  the source document whose `content` is read')
  console.log('  --commit       actually create the claims (default is a dry run)')
  console.log('')
  console.log('Environment (same as scripts/agent.mjs):')
  console.log('  LLM_API_KEY     API key for the provider (required)')
  console.log('  LLM_PROVIDER    anthropic | openai | groq   (default: anthropic)')
  console.log('  LLM_MODEL       model id                    (default: per provider)')
  console.log('  SANITY_WRITE_TOKEN  only needed with --commit')
}

function parseArgs(argv) {
  const args = {sourceId: null, commit: false, help: false}

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    if (token === '--source') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error('--source needs a source id, e.g. --source source-public-faq')
      }
      args.sourceId = value
      index += 1
    } else if (token === '--commit') {
      args.commit = true
    } else if (token === '--help' || token === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${token}`)
    }
  }

  if (!args.help && !args.sourceId) throw new Error('Pass --source <sourceId>.')

  return args
}

// --- provider --------------------------------------------------------------------------

/**
 * Duplicated from agent.mjs (~12 lines) because it is not exported there. Everything it
 * returns about the provider itself comes from the shared `PROVIDERS` table.
 */
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
    console.error('Put it in a .env file and run with --env-file=.env:')
    console.error('  LLM_PROVIDER=groq')
    console.error('  LLM_API_KEY="<your-key>"')
    console.error('  LLM_MODEL=openai/gpt-oss-120b')
    process.exitCode = 1
  }

  return apiKey
}

function requireSanityToken() {
  const token = process.env.SANITY_WRITE_TOKEN

  if (!token) {
    console.error('Error: --commit needs SANITY_WRITE_TOKEN, and it is not set.')
    console.error('')
    console.error('Create an Editor (write) token for this project:')
    console.error(`  https://www.sanity.io/manage/project/${PROJECT_ID}/api#tokens`)
    process.exitCode = 1
  }

  return token
}

/**
 * The request body is written HERE rather than reusing `provider.buildRequest` from
 * agent.mjs, and that is deliberate. Those builders hard-code agent.mjs's own governance
 * system prompt ("You are a careful governance agent arbitrating...") with no parameter to
 * override it, so reusing them would send this extraction prompt under a system message
 * about arbitration - the wrong instructions for the wrong task.
 *
 * The URLs, default models and response READERS still come from the shared table, so only
 * these ~25 lines are re-stated.
 */
function buildRequest({providerName, apiKey, model, userPrompt}) {
  if (providerName === 'anthropic') {
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
  }

  // `openai` and `groq` share the OpenAI chat-completions shape.
  return {
    headers: {'content-type': 'application/json', authorization: `Bearer ${apiKey}`},
    body: {
      model,
      messages: [
        {role: 'system', content: SYSTEM_PROMPT},
        {role: 'user', content: userPrompt},
      ],
      temperature: 0,
      // The prompt contains the literal word "JSON", which OpenAI requires before it will
      // honour `json_object` mode.
      response_format: {type: 'json_object'},
    },
  }
}

/** Thin fetch glue. The response SHAPE is still read by the shared provider readers. */
async function callLlm({providerName, provider, apiKey, model, userPrompt}) {
  const {headers, body} = buildRequest({providerName, apiKey, model, userPrompt})

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
    throw new Error(
      `${providerName} returned no text content. Response was: ${JSON.stringify(data).slice(0, 400)}`,
    )
  }

  return {text, usage: provider.readUsage(data)}
}

// --- prompt ----------------------------------------------------------------------------

/**
 * THE PROMPT, as one literal with {{PLACEHOLDERS}}, so the exact text that produced a claim
 * batch is readable in the source.
 *
 * Five rules carry weight:
 *  - Rule 2 (normalisation) is what makes the output comparable at all. "30 days" and
 *    "thirty days" are the same assertion, and only the normalised form lets the detector
 *    see that two claims agree or disagree.
 *  - Rule 3a is the disambiguation rule, and the reason `TOPICS_QUERY` fetches descriptions:
 *    "Deleted accounts are retained for 60 days" fits both Data Retention and Account
 *    Deletion by name, and only the descriptions separate them.
 *  - Rule 3/4 exist because a hallucinated topic would create a claim nothing can ever
 *    group with, silently outside every conflict check.
 *  - Rule 6 matters most for THIS dataset: the seeded sources are one-line summaries that
 *    assert nothing, and an empty list is the correct answer for them. Without this rule a
 *    model would invent claims to be helpful.
 *  - Rule 5 defines confidence as HOW CLEARLY the source asserts it, not how likely it is
 *    to be true - a source is evidence, not a verdict.
 */
const PROMPT_TEMPLATE = `You are reading ONE source document from a company knowledge base, and extracting the factual claims it makes about topics that already exist.

SOURCE
  Title: {{SOURCE_TITLE}}
  Type: {{SOURCE_TYPE}}
  Last reviewed: {{SOURCE_REVIEWED}}
  Content:
  """
{{SOURCE_CONTENT}}
  """

EXISTING TOPICS (the ONLY topics you may use)
Each line is: slug - Name: what the topic covers
{{TOPIC_LIST}}

RULES
  1. Extract one claim per factual assertion the source makes about an existing topic.
     "statement" is the source's own wording, in ONE sentence.
  2. "value" is the NORMALIZED comparison key, never a sentence. Use the short form a reader
     would compare: "30 days", "5 USD", "12 months", "Original payment method". Two claims
     about the same topic with DIFFERENT values are in contradiction, so this normalisation
     is what makes the comparison work at all.
  3. "topicSlug" MUST be one of the slugs listed above, copied exactly. NEVER invent a topic.
  3a. When two topics could plausibly fit an assertion, choose the one whose description
      matches the ASSERTION's meaning, not the one whose name superficially matches. Read the
      descriptions carefully.
  4. If an assertion does not fit any existing topic, OMIT it. Do not stretch a topic to fit.
  5. "confidence" is how CLEARLY this source asserts the claim (0 to 1), not how true you
     think it is. A hedged "usually around 30 days" belongs near 0.5; a flat "30 days" near
     0.95.
  6. A source that asserts nothing about these topics yields an empty list. That is a correct
     answer - never invent a claim to fill the list, and never pad it.
  7. Do not extract the same fact twice, even if the source repeats it.

OUTPUT
Reply with ONLY a JSON object. No prose, no markdown fences, no explanation outside it.
Shape:

{
  "claims": [
    {
      "statement": "Customers may request a refund within 30 days of purchase.",
      "value": "30 days",
      "topicSlug": "refund-window",
      "confidence": 0.95
    }
  ]
}`

/**
 * Duplicated from agent.mjs (~5 lines) because it is not exported there. Kept identical in
 * behaviour: a missing key stays VISIBLE in the output rather than silently blanking, so a
 * template/prepare mismatch shows up as `{{TOPIC_LIST}}` in the prompt.
 */
function fillTemplate(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  )
}

/**
 * One line per topic - `slug - Name: what the topic covers` - matching the shape the prompt
 * documents. The description is appended only when the topic has one, so a topic without it
 * degrades to the previous line shape rather than printing "undefined" into the prompt.
 */
function formatTopics(topics) {
  return topics
    .map((topic) => {
      const description = topic.description ? `: ${topic.description}` : ''
      return `  - ${topic.slug} - ${topic.name}${description}`
    })
    .join('\n')
}

function buildPrompt({source, topics}) {
  return fillTemplate(PROMPT_TEMPLATE, {
    SOURCE_TITLE: source.title ?? '(untitled source)',
    SOURCE_TYPE: source.sourceType ?? 'unknown',
    SOURCE_REVIEWED: (source.lastReviewedAt ?? 'unknown').slice(0, 10),
    SOURCE_CONTENT: (source.content ?? '').trim() || '(the source has no content)',
    TOPIC_LIST: formatTopics(topics),
  })
}

// --- validation ------------------------------------------------------------------------

/**
 * Reshapes the model's answer into claims we are willing to write.
 *
 * A bad claim is DROPPED with a warning rather than failing the batch: one hallucinated
 * topic should not cost the four good claims beside it. The decisions that matter:
 *
 *  - An unknown `topicSlug` is fatal for that claim only. A claim pointing at a topic that
 *    does not exist would sit silently outside every conflict check, forever.
 *  - `confidence` may arrive quoted ("0.9"); only numeric strings are coerced, and the range
 *    is still enforced, so the accepted syntax widens without the rule loosening.
 *  - Rule 7 of the prompt asks the model not to repeat itself. This is where that becomes a
 *    guarantee.
 */
function validateExtraction(raw, {topicSlugs}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Expected a JSON object, got ${Array.isArray(raw) ? 'an array' : typeof raw}.`)
  }
  if (!Array.isArray(raw.claims)) {
    throw new Error('The response has no "claims" array.')
  }

  const accepted = []
  const rejected = []
  const seen = new Set()

  raw.claims.forEach((entry, index) => {
    const position = index + 1
    const statement = typeof entry?.statement === 'string' ? entry.statement.trim() : ''
    const value = typeof entry?.value === 'string' ? entry.value.trim() : ''
    const topicSlug = typeof entry?.topicSlug === 'string' ? entry.topicSlug.trim() : ''
    const confidence =
      typeof entry?.confidence === 'string' ? Number(entry.confidence) : entry?.confidence

    if (!statement || !value) {
      rejected.push(`claim ${position}: missing statement or value`)
      return
    }
    if (!topicSlugs.includes(topicSlug)) {
      rejected.push(`claim ${position}: "${topicSlug}" is not an existing topic`)
      return
    }
    if (
      typeof confidence !== 'number' ||
      Number.isNaN(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      rejected.push(
        `claim ${position}: confidence ${JSON.stringify(entry?.confidence)} is not a number from 0 to 1`,
      )
      return
    }

    const key = `${topicSlug}::${value.toLowerCase()}`
    if (seen.has(key)) {
      rejected.push(`claim ${position}: repeats an earlier claim (${topicSlug} = ${value})`)
      return
    }
    seen.add(key)

    accepted.push({statement, value, topicSlug, confidence})
  })

  return {accepted, rejected}
}

/** `--commit` only: is this claim already recorded against this source? */
function alreadyRecorded(claim, topicBySlug, existing) {
  const topicId = topicBySlug.get(claim.topicSlug)?._id

  return existing.some(
    (row) => row.topicRef === topicId && String(row.value).toLowerCase() === claim.value.toLowerCase(),
  )
}

// --- main ------------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    printUsage()
    return
  }

  const apiKey = requireApiKey()
  if (!apiKey) return

  // The Sanity token is only required to WRITE, so a dry run needs no credentials at all -
  // and the thing with write access is only ever the run that asked for it.
  const token = args.commit ? requireSanityToken() : undefined
  if (args.commit && !token) return

  const {name: providerName, provider, model} = resolveProvider()

  const client = createClient({
    projectId: PROJECT_ID,
    dataset: DATASET,
    apiVersion: API_VERSION,
    useCdn: false,
    ...(token ? {token} : {}),
  })

  const source = await client.fetch(SOURCE_QUERY, {sourceId: args.sourceId})
  if (!source) throw new Error(`No source found with _id "${args.sourceId}".`)

  const topics = await client.fetch(TOPICS_QUERY)

  console.log(`Extracting from: ${source.title ?? source._id} (${source._id})`)
  console.log(`Provider: ${providerName} / ${model}`)
  console.log('')

  const userPrompt = buildPrompt({source, topics})
  const {text, usage} = await callLlm({providerName, provider, apiKey, model, userPrompt})

  const {accepted, rejected} = validateExtraction(extractJsonObject(text), {
    topicSlugs: topics.map((topic) => topic.slug),
  })

  for (const warning of rejected) console.log(`  ⚠ dropped ${warning}`)
  if (rejected.length > 0) console.log('')

  console.log(`Proposed claims (${accepted.length}):`)
  if (accepted.length === 0) {
    console.log('  (none - this source asserts nothing about an existing topic)')
  } else {
    accepted.forEach((claim, index) => {
      const topic = topics.find((candidate) => candidate.slug === claim.topicSlug)
      console.log(`  ${index + 1}. "${claim.statement}"`)
      console.log(
        `     value: ${claim.value} · topic: ${topic?.name ?? claim.topicSlug}` +
          ` · confidence ${claim.confidence}`,
      )
    })
  }
  console.log('')

  if (!args.commit) {
    if (accepted.length === 0) {
      console.log(
        'Dry run. Nothing to write: this source asserts no claims about an existing topic.',
      )
      return
    }
    const plural = accepted.length === 1 ? '' : 's'
    console.log(`Dry run. Re-run with --commit to write ${accepted.length} claim${plural}.`)
    return
  }

  const existing = await client.fetch(EXISTING_CLAIMS_QUERY, {sourceId: source._id})
  const topicBySlug = new Map(topics.map((topic) => [topic.slug, topic]))
  const fresh = accepted.filter((claim) => !alreadyRecorded(claim, topicBySlug, existing))
  const skipped = accepted.length - fresh.length

  if (fresh.length === 0) {
    console.log(
      `Nothing to write: all ${accepted.length} claim(s) are already recorded against this source.`,
    )
    return
  }

  // ONE transaction, and no draft layer. `tx.create` writes a PUBLISHED document with
  // `@sanity/client`, unlike the App SDK's `createDocument` + `publishDocument` pair used in
  // the browser. So these claims are durable and immediately visible to the app's queries in
  // a single atomic commit, and a half-written batch is impossible.
  const transaction = client.transaction()

  for (const claim of fresh) {
    const topic = topicBySlug.get(claim.topicSlug)
    if (!topic) continue

    transaction.create({
      _id: crypto.randomUUID(),
      _type: 'claim',
      statement: claim.statement,
      value: claim.value,
      topic: {_type: 'reference', _ref: topic._id},
      source: {_type: 'reference', _ref: source._id},
      // Legacy expand-window field: the seed and the UI both still maintain it, and the
      // deployed v1 app decides whether a claim is open with `status == "unresolved"`.
      status: 'unresolved',
      confidence: claim.confidence,
    })
  }

  await transaction.commit()

  const tokens =
    usage && (usage.input !== undefined || usage.output !== undefined)
      ? ` (prompt ${usage.input ?? '?'} + completion ${usage.output ?? '?'} tokens)`
      : ''

  console.log(
    `✔ wrote ${fresh.length} claim(s) for ${source._id}` +
      `${skipped > 0 ? ` - skipped ${skipped} already recorded` : ''}${tokens}`,
  )
  console.log('')
  console.log('Next: node --env-file=.env scripts/detect.mjs --commit')
}

/**
 * Runs only when invoked directly, so a harness can import the prompt builder and the
 * validator without firing a model call or touching the dataset.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`)
    process.exitCode = 1
  })
}

// `buildRequest` is exported so a harness can drive the SHIPPED prompt and request shape
// against a synthetic source, which is the only way to tell "the extractor works" apart from
// "this source has nothing to extract".
export {PROMPT_TEMPLATE, buildPrompt, buildRequest, validateExtraction}
