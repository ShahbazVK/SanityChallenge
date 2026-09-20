#!/usr/bin/env node
/**
 * Phase 7: the eval harness - scores the DETERMINISTIC proposer against human ground truth.
 *
 * For every case that has BOTH a proposal and a ruling, it asks one question: did the
 * agent's proposed outcome survive contact with the human who ruled on it? Then it slices
 * the answer by confidence, by the principle the agent applied, and by what happened to
 * the precedents it cited.
 *
 * READ-ONLY, and structurally so: the client is created with NO token, so this script
 * could not write to the dataset even if it tried, and it contains no mutation call.
 *
 * GROUND TRUTH is the instruction: `winner` where the human upheld a claim, `outcomeValue`
 * where the human ruled beyond the claims. The agent only ever proposes a CLAIM - the
 * schema gives `case.proposal` no value field - so an `outcomeValue` ruling necessarily
 * counts as a MISS for outcome accuracy. That is a real limit of the comparison, not a
 * failure of the proposer, so it is counted separately and stated in the report itself.
 *
 * Usage:
 *   node --env-file=.env scripts/eval.mjs
 */
import {writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'

import {createClient} from '@sanity/client'

const PROJECT_ID = 'cqb58l0f'
const DATASET = 'production'
const API_VERSION = '2025-01-01'

/** Resolved against this file, so the report lands at the repo root from any cwd. */
const REPORT_PATH = fileURLToPath(new URL('../eval-report.md', import.meta.url))

/** The producer whose rule attribution can be inferred from confidence. */
const DETERMINISTIC_MODEL = 'offline-heuristic-v1'

const client = createClient({
  projectId: PROJECT_ID,
  dataset: DATASET,
  apiVersion: API_VERSION,
  // No token: reading published data needs none, and omitting it makes "read-only" a
  // property of the script rather than a promise.
  useCdn: false,
})

/**
 * Every case with a proposal AND a ruling.
 *
 * `defined(proposal)` is the proposal half. The ruling half is the instruction that names
 * the case, which is exactly how the app derives a ruling too. A case can be at `ruled`
 * stage with no instruction at all (`case-data-retention-1` was dismissed as a false
 * positive), which is why the stage is not used as the filter.
 *
 * The proposal's precedents and the ruling's precedents are both projected WITH their
 * relations, because "the agent cited X" and "the agent cited X as follows" are different
 * claims and only the second one can be checked against what the human did.
 */
const EVALUATED_CASES_QUERY = `*[_type == "case"
    && defined(proposal)
    && count(*[_type == "instruction" && case._ref == ^._id]) > 0
  ] | order(_id asc) {
    _id,
    "topicName": topic->name,
    "proposal": proposal {
      confidence,
      model,
      promptVersion,
      rationale,
      "outcomeId": outcome._ref,
      "outcomeValue": outcome->value,
      "precedents": precedents[]{relation, "instructionId": instruction._ref}
    },
    "ruling": *[_type == "instruction" && case._ref == ^._id][0] {
      _id,
      outcomeValue,
      decidedAt,
      decidedBy,
      "winnerId": winner._ref,
      "winnerValue": winner->value,
      "precedents": precedents[]{relation, "instructionId": instruction._ref}
    },
    "recordedApproval": *[_type == "caseEvent" && case._ref == ^._id && to == "ruled"]
      | order(at desc)[0].payload.approvedProposal
  }`

// --- scoring ---------------------------------------------------------------------------

/**
 * Confidence buckets, high to low.
 *
 * The 0.5 boundary belongs to "coin flips", not to 0.5-0.7. The deterministic proposer
 * reports exactly 0.5 when its rule 4 broke a tie on claim id, so a bucket labelled
 * "coin flips" that excluded the coin flips would be worse than useless.
 */
const BUCKETS = [
  {label: '0.9-1.0', note: 'high-confidence', includes: (c) => c >= 0.9},
  {label: '0.7-0.9', note: null, includes: (c) => c >= 0.7 && c < 0.9},
  {label: '0.5-0.7', note: null, includes: (c) => c > 0.5 && c < 0.7},
  {label: '0.0-0.5', note: 'coin flips', includes: (c) => c <= 0.5},
]

function bucketFor(confidence) {
  if (typeof confidence !== 'number') return null
  const bucket = BUCKETS.find((candidate) => candidate.includes(confidence))
  return bucket ? bucket.label : null
}

/**
 * The principle the agent applied, inferred from the confidence it reported.
 *
 * This is exact ONLY for the deterministic proposer, whose confidences come from a fixed
 * table (rule 1 -> 0.9, rule 2 -> 0.75, rule 3 -> 0.6, rule 4 -> 0.5). A model's
 * self-reported confidence means something else entirely, so the report names the
 * producers it saw and warns when the attribution would be applied to something else.
 */
const CATEGORIES = [
  {name: 'authority-beats-recency', rule: 'rule 1', note: 'source authority separated the claims'},
  {name: 'newer-supersedes-older', rule: 'rule 2', note: 'review date separated them'},
  {name: 'confidence-decides', rule: 'rule 3', note: 'claim confidence separated them'},
  {
    name: 'precedent-applies',
    rule: 'citation',
    note: 'agent cited a precedent as "follows" and the human endorsed it',
  },
  {
    name: 'precedent-misleads',
    rule: 'citation',
    note: 'agent cited a precedent as "follows" and the human did not endorse it',
  },
  {name: 'true-tie', rule: 'rule 4', note: 'nothing separated them; broken on claim id'},
  {name: 'unclassified', rule: '-', note: 'no confidence recorded'},
]

const CATEGORY_ORDER = CATEGORIES.map((category) => category.name)

/** The human's answer, and whether it came from a claim or from a ruling that set a value. */
function humanOutcome(ruling) {
  if (ruling.winnerId) {
    return {id: ruling.winnerId, value: ruling.winnerValue, kind: 'claim'}
  }

  return {id: null, value: ruling.outcomeValue, kind: 'value'}
}

/** The agent's proposed answer. Always a claim: `case.proposal` has no value field. */
function agentOutcome(proposal) {
  return {id: proposal.outcomeId, value: proposal.outcomeValue}
}

/** Citation identity is the instruction AND the relation - the relation is the claim. */
const citationKey = (citation) => `${citation.instructionId}::${citation.relation}`

function citationsOf(citations) {
  return new Set(
    (citations ?? [])
      .filter((citation) => Boolean(citation?.instructionId) && Boolean(citation?.relation))
      .map(citationKey),
  )
}

/**
 * Did the human reject a precedent the agent followed?
 *
 * Either counts: the human cited the SAME instruction with a different relation
 * (`distinguishes` / `overrules`), or they reached a different outcome. On this dataset
 * only the first occurs - `case-gift-card-expiry-1`, where the agent followed the Account
 * Deletion ruling and the human distinguished it while still reaching the same outcome. The
 * reasoning failed and the answer held, which is exactly why this category is about the
 * citation rather than about the verdict.
 */
function rejectedPrecedent(agentFollows, humanCitations) {
  return agentFollows.some((citation) => {
    const citedSameInstruction = [...humanCitations].some((key) =>
      key.startsWith(`${citation.instructionId}::`),
    )
    return citedSameInstruction && !humanCitations.has(citationKey(citation))
  })
}

function categorize({citedFollows, confidence, precedentMisleads}) {
  // Precedent categories win, and the two are complementary, so neither is double-counted.
  if (citedFollows) return precedentMisleads ? 'precedent-misleads' : 'precedent-applies'

  if (typeof confidence !== 'number') return 'unclassified'
  if (confidence >= 0.9) return 'authority-beats-recency'
  if (confidence >= 0.7) return 'newer-supersedes-older'
  if (confidence > 0.5) return 'confidence-decides'
  return 'true-tie'
}

function scoreCase(caseDocument) {
  const {proposal, ruling} = caseDocument
  const agent = agentOutcome(proposal)
  const human = humanOutcome(ruling)

  const matched = Boolean(agent.id && human.id && agent.id === human.id)
  const overridden = !matched

  const agentCitations = citationsOf(proposal.precedents)
  const humanCitations = citationsOf(ruling.precedents)
  const shared = [...agentCitations].filter((key) => humanCitations.has(key))
  const agentFollows = (proposal.precedents ?? []).filter(
    (citation) => citation?.relation === 'follows' && citation.instructionId,
  )
  const citedFollows = agentFollows.length > 0
  const precedentMisleads =
    citedFollows && (rejectedPrecedent(agentFollows, humanCitations) || overridden)

  return {
    caseId: caseDocument._id,
    topicName: caseDocument.topicName,
    agent,
    human,
    matched,
    overridden,
    // The human's own recorded flag, where the event carries one. Used only to RE-CHECK the
    // derived override above: if the two ever disagree, the report says so.
    recordedApproval: caseDocument.recordedApproval,
    bucket: bucketFor(proposal.confidence),
    category: categorize({citedFollows, confidence: proposal.confidence, precedentMisleads}),
    confidence: proposal.confidence,
    model: proposal.model,
    citations: {
      agent: agentCitations.size,
      human: humanCitations.size,
      shared: shared.length,
    },
  }
}

// --- reporting -------------------------------------------------------------------------

const percent = (part, whole) => (whole === 0 ? 'n/a' : `${Math.round((part / whole) * 100)}%`)

const ratio = (part, whole) =>
  whole === 0 ? '0 / 0 (n/a)' : `${part} / ${whole} (${percent(part, whole)})`

const sum = (rows, select) => rows.reduce((total, row) => total + select(row), 0)

function tally(rows) {
  return {matched: rows.filter((row) => row.matched).length, total: rows.length}
}

/** `agent: x human: y ✗`, the shape in the brief, plus the category for context. */
function caseLine(row) {
  const agent = row.agent.value ?? '(no value)'
  const human = `${row.human.value ?? '(no value)'}${row.human.kind === 'value' ? ' (value)' : ''}`
  return (
    `${row.caseId} agent: ${agent} human: ${human} ${row.matched ? '✓' : '✗'}` +
    `  [${row.category}, confidence ${row.confidence ?? 'n/a'}]`
  )
}

function renderReport({rows, generatedAt, coverage}) {
  const out = []
  const overall = tally(rows)
  const overrideCount = rows.filter((row) => row.overridden).length

  out.push('EVAL REPORT - deterministic proposer')
  out.push('========================================')
  out.push('')
  out.push(`Generated: ${generatedAt}`)
  out.push(`Cases evaluated: ${rows.length}`)
  out.push('')
  out.push(
    'Each case pairs the agent proposal with the ruling a human (or the seed simulated ' +
      'human) actually made. A match means the human upheld the very claim the agent proposed.',
  )
  out.push('')

  out.push('## OVERALL ACCURACY')
  out.push('')
  out.push(`- Outcome match: ${ratio(overall.matched, overall.total)}`)
  out.push(`- Overrides: ${ratio(overrideCount, rows.length)}`)
  out.push('')

  const producers = [...new Set(rows.map((row) => row.model ?? 'unknown'))]
  const foreignProducers = producers.filter((producer) => producer !== DETERMINISTIC_MODEL)
  out.push('## PRODUCERS')
  out.push('')
  for (const producer of producers) {
    const count = rows.filter((row) => (row.model ?? 'unknown') === producer).length
    out.push(`- ${producer}: ${count}`)
  }
  if (foreignProducers.length > 0) {
    out.push('')
    out.push(
      `> WARNING: ${foreignProducers.join(', ')} did not come from the deterministic ` +
        'proposer, so its confidence does NOT map onto the rules below and the categories ' +
        'for those cases are not meaningful.',
    )
  }
  out.push('')

  out.push('## BY CONFIDENCE BUCKET')
  out.push('')
  for (const bucket of BUCKETS) {
    const result = tally(rows.filter((row) => row.bucket === bucket.label))
    out.push(`- ${bucket.label}: ${ratio(result.matched, result.total)}${bucket.note ? ` - ${bucket.note}` : ''}`)
  }
  out.push('')

  out.push('## BY CATEGORY')
  out.push('')
  for (const name of CATEGORY_ORDER) {
    const category = CATEGORIES.find((candidate) => candidate.name === name)
    const categoryRows = rows.filter((row) => row.category === name)
    const result = tally(categoryRows)
    const overrides = categoryRows.filter((row) => row.overridden).length
    const note = result.total === 0 ? ' - no cases' : ` - ${overrides} overridden`
    out.push(`- ${name} (${category.rule}: ${category.note}): ${ratio(result.matched, result.total)}${note}`)
  }
  out.push('')
  out.push(
    'Categories are exclusive, so the case counts sum to the total. A case where the agent ' +
      'leaned on a precedent is grouped by the precedent, because that is the more specific fact.',
  )
  out.push('')
  out.push(
    'Read the two precedent categories carefully: the CATEGORY is about the citation, while the ' +
      'percentage is about the OUTCOME. A case can sit in `precedent-misleads` and still count as ' +
      'a match - the agent followed a precedent the human rejected and reached the same answer ' +
      'anyway. Its argument failed; its conclusion did not. `case-gift-card-expiry-1` is that case.',
  )
  out.push('')

  const withCitations = rows.filter((row) => row.citations.agent > 0)
  const agreed = withCitations.filter(
    (row) =>
      row.citations.shared === row.citations.agent && row.citations.human === row.citations.agent,
  ).length
  const agentCitations = sum(rows, (row) => row.citations.agent)
  const humanCitations = sum(rows, (row) => row.citations.human)
  const sharedCitations = sum(rows, (row) => row.citations.shared)

  out.push('## PRECEDENT HANDLING')
  out.push('')
  out.push(`- Cases with agent citations: ${withCitations.length}`)
  out.push(`- Cases where human agreed: ${ratio(agreed, withCitations.length)}`)
  out.push(
    `- Citation precision (agent citations the ruling also made): ${ratio(sharedCitations, agentCitations)}`,
  )
  out.push(
    `- Citation recall (ruling citations the agent also made): ${ratio(sharedCitations, humanCitations)}`,
  )
  out.push('')
  out.push(
    'A citation counts only when the instruction AND the relation match: citing a ruling as ' +
      '"follows" when the human cited it as "distinguishes" is a disagreement, not a hit.',
  )
  out.push('')
  out.push(
    '> NOTE: recall here is depressed by the app\'s bookkeeping as well as by the proposer. ' +
      'When a human overrides the agent with a different outcome, the ruling deliberately ' +
      'does NOT inherit the agent\'s citations, so those rulings have nothing to recall. Read ' +
      'precision as the proposer\'s precision; recall is a joint measure of both.',
  )
  out.push('')

  out.push('## COVERAGE')
  out.push('')
  out.push(`- Cases in the dataset: ${coverage.total}`)
  out.push(`- Evaluated (proposal AND ruling): ${rows.length}`)
  out.push(`- Skipped: ${coverage.skipped.length}`)
  for (const skipped of coverage.skipped) {
    out.push(`  - ${skipped._id} (${skipped.reason})`)
  }
  out.push('')
  out.push(
    'A case is evaluated only when it has BOTH artifacts. A case still at `detected` has no ' +
      'proposal, and a case dismissed as a false positive never got a ruling - neither can ' +
      'be scored against human judgement.',
  )
  out.push('')

  const withFlag = rows.filter((row) => typeof row.recordedApproval === 'boolean')
  const disagreements = withFlag.filter((row) => row.recordedApproval === row.overridden)
  out.push('## CROSS-CHECK')
  out.push('')
  out.push(
    '- Derived override agrees with the recorded `payload.approvedProposal`: ' +
      `${ratio(withFlag.length - disagreements.length, withFlag.length)}`,
  )
  out.push('')
  out.push(
    'This does not score the agent - it checks the HARNESS. The override column is derived by ' +
      'comparing outcomes, and the event log records the same fact independently; if those two ' +
      'ever diverged, the numbers above would be suspect.',
  )
  out.push('')

  out.push('## CASE-BY-CASE')
  out.push('')
  out.push('```')
  for (const row of rows) out.push(caseLine(row))
  out.push('```')
  out.push('')

  out.push('## READING THESE NUMBERS')
  out.push('')
  out.push(
    `1. n = ${rows.length}. Every percentage moves about 10 points per case, so treat these as ` +
      'directions rather than measurements, and do not quote a single category as a rate.',
  )
  out.push(
    '2. A ruling that establishes a NEW VALUE (`outcomeValue`) can never count as a match: the ' +
      'agent proposes a claim, and `case.proposal` has no field for a value. Those cases are ' +
      'misses by construction, not by disagreement.',
  )
  out.push(
    '3. Rule attribution is inferred from the confidence the proposer reported, which is exact ' +
      'only for the deterministic proposer - see PRODUCERS for a warning when it is not.',
  )
  out.push(
    '4. The buckets are coarse because the proposer only reports four confidence values ' +
      '(0.9, 0.75, 0.6, 0.5), so the middle buckets can be empty and the outer ones can hold ' +
      'a single case.',
  )
  out.push('')

  return out.join('\n')
}

// --- main ------------------------------------------------------------------------------

const COVERAGE_QUERY = `*[_type == "case"] {
  _id,
  "hasProposal": defined(proposal),
  "instructionCount": count(*[_type == "instruction" && case._ref == ^._id])
}`

async function main() {
  const [caseDocuments, allCases] = await Promise.all([
    client.fetch(EVALUATED_CASES_QUERY),
    client.fetch(COVERAGE_QUERY),
  ])

  const rows = caseDocuments.map(scoreCase)
  const skipped = allCases
    .filter((entry) => !entry.hasProposal || entry.instructionCount === 0)
    .map((entry) => ({
      _id: entry._id,
      reason: entry.hasProposal ? 'no ruling' : 'no proposal',
    }))

  const report = renderReport({
    rows,
    generatedAt: new Date().toISOString(),
    coverage: {total: allCases.length, skipped},
  })

  console.log(report)
  console.log('')
  console.log(`Report written to ${REPORT_PATH}`)

  writeFileSync(REPORT_PATH, `${report}\n`, 'utf8')
}

main().catch((error) => {
  console.error(`Error: ${error.message}`)
  process.exitCode = 1
})
