/**
 * Phase 2 demo dataset: 90 documents for the agent-proposes / human-rules rebuild.
 *
 * DISCLOSURE - simulated humans. Some caseEvents in this fixture carry
 * `actor.kind: "human"`. Those are NOT real user actions. They exist so the History view
 * has a believable timeline to render before any human has actually used the app. Every
 * one of them uses:
 *     actor.id:    "seed-fixture-human"
 *     actor.label: "Seed fixture (simulated human)"
 * and the legacy `instruction.decidedBy` carries the same label, so nothing in the
 * dataset can be mistaken for a real person's decision. This matters because `ruled` is
 * human-only in workflow.def.json: the seed cannot honestly use an "agent" or "system"
 * actor for those transitions without violating the table, so it uses a human actor and
 * labels that actor as a fixture.
 *
 * Dates: the two retroactive cases keep their existing instruction dates (2026-06-15 and
 * 2026-07-01) so History and `instruction.decidedAt` agree. The other ten spread across
 * 2026-09-01 to 2026-09-15.
 *
 * This module is pure data plus a few pure helpers: no client, no I/O, no side effects.
 * The Phase 7 eval harness imports it directly for ground truth.
 */
import {proposeRule, withPrecedentNote} from './lib/propose.mjs'

/** Constraint A: the disclosure applies to every seeded human actor. */
const SIMULATED_HUMAN = {
  kind: 'human',
  id: 'seed-fixture-human',
  label: 'Seed fixture (simulated human)',
}
const SEED_ACTOR = {kind: 'seed', id: 'seed-script', label: 'Seed script'}
const AGENT_ACTOR = {
  kind: 'agent',
  id: 'offline-heuristic-v1',
  label: 'Agent (offline heuristic)',
}
const SYSTEM_ACTOR = {kind: 'system', id: 'supersession-sweep', label: 'Supersession sweep'}

const ref = (_ref) => ({_type: 'reference', _ref})
const refs = (ids) => ids.map((_ref) => ({_type: 'reference', _ref, _key: _ref}))

/**
 * PHASE 10c - `content` is PROSE now, not a description of the document.
 *
 * The claim extractor (`scripts/extract.mjs`) reads this field and looks for factual
 * assertions. A description of what the document IS - "Customer-facing FAQ." - asserts
 * nothing, which is why every source used to extract zero claims. Each `content` below is
 * now 3-5 real sentences that assert specific facts about topics that already exist.
 *
 * WHERE THE VALUES COME FROM: they are chosen to MATCH the values in CLAIM_ROWS below, so an
 * extraction run reproduces what is already in the dataset rather than inventing a second
 * generation of near-duplicate values. The disagreements this demo depends on are the ones
 * already in CLAIM_ROWS - refund window (30 vs 14 days), shipping cost (5 vs 7 USD), warranty
 * period (1 vs 2 years) - and the prose deliberately carries BOTH sides: the internal policy
 * says 30 days, the public FAQ says 14.
 *
 * VERIFIED, NOT ASSUMED: every `content` below was run through the shipped prompt and
 * validator before being written here, because the model's normalisation is not always the
 * one the seed uses. Three findings drove the final wording, each noted at the sentence:
 *   - "a 1-year warranty" came back as "12 months" (the hyphen triggers the conversion), so
 *     the hyphen is gone;
 *   - "10 business days" came back as "10 business days" against a seeded "10 days", so the
 *     sentence says "10 days";
 *   - "Deleted accounts are retained for 60 days…" landed on DATA RETENTION rather than
 *     account deletion, so those sentences lead with "Account deletion".
 * Each of the three would otherwise have created a second value on a topic that already has
 * a case, i.e. a fresh case for a question that is already answered.
 *
 * The seed only STORES this text; extraction is never automatic. To see what a source yields:
 *   node --env-file=.env scripts/extract.mjs --source source-public-faq
 */
export const sources = [
  {
    _id: 'source-internal-policy',
    _type: 'source',
    title: 'Internal Policy',
    sourceType: 'internal',
    url: 'https://example.com/internal-policy',
    // The high-authority internal voice. Four of these five sentences already have a matching
    // claim in CLAIM_ROWS, so extraction confirms them; the shipping sentence is new for this
    // source but agrees with marketing and support, so it raises no conflict.
    content:
      'Customers may request a refund within 30 days of purchase. ' +
      'Refunds are issued to the original payment method. ' +
      'We retain customer data for 7 years after account closure. ' +
      // "1 year", NOT the hyphenated "1-year": the model reads the hyphenated form as
      // "12 months", which would look like a second value beside claim-warranty-1y.
      'All products are covered by a 1 year warranty. ' +
      'Standard shipping is charged at 5 USD per order.',
    lastReviewedAt: '2026-08-15T00:00:00Z',
  },
  {
    _id: 'source-public-faq',
    _type: 'source',
    title: 'Public FAQ',
    sourceType: 'external',
    url: 'https://example.com/faq',
    // The low-authority public voice, and the one that DISAGREES: 14 days against the policy's
    // 30, 7 USD against its 5. Those two conflicts are already in CLAIM_ROWS; the account
    // deletion sentence is the only genuinely new claim extraction produces from this source.
    content:
      'Customers may request a refund within 14 days of purchase. ' +
      'Standard shipping costs 7 USD per order. ' +
      'Refunds are issued as store credit only. ' +
      // Leading with "Account deletion" is deliberate. As "Deleted accounts are retained for
      // 60 days…" this sentence extracts onto DATA RETENTION instead - the prompt shows the
      // model topic names only, so the descriptions that separate the two never reach it. The
      // fact is unchanged; only the wording that survives that gap is used here.
      'Account deletion takes effect 60 days after the request.',
    lastReviewedAt: '2025-03-01T00:00:00Z',
  },
  {
    _id: 'source-marketing-site',
    _type: 'source',
    title: 'Marketing Site',
    sourceType: 'external',
    url: 'https://example.com/pricing',
    // The product promise, pitched at the customer: a 2-year warranty against the policy's 1
    // year is the disagreement, and it is already a seeded claim.
    content:
      'All products carry a 2-year warranty. ' +
      'Standard shipping is a flat 5 USD per order. ' +
      'Free trials last 21 days.',
    lastReviewedAt: '2026-02-10T00:00:00Z',
  },
  {
    _id: 'source-legal-terms',
    _type: 'source',
    title: 'Legal Terms',
    sourceType: 'official',
    url: 'https://example.com/legal/terms',
    // The binding voice. Its last sentence asserts nothing about any topic, so the extractor
    // is expected to DROP it - that is the "omit what does not fit" rule doing its job, and
    // the reason this source yields two claims rather than three.
    content:
      // Deliberately the same sentence as the FAQ's, so two independent sources state the same
      // rule and extraction confirms agreement rather than opening a second value. See the FAQ
      // comment for why it does not use the seed's original "Deleted accounts are retained…".
      'Account deletion takes effect 60 days after the request. ' +
      'Price matches are honoured for 30 days from the date of purchase. ' +
      'These terms supersede all other documentation.',
    lastReviewedAt: '2026-01-01T00:00:00Z',
  },
  {
    _id: 'source-support-docs',
    _type: 'source',
    title: 'Support Docs',
    sourceType: 'internal',
    url: 'https://example.com/support',
    // The runbook voice, and the source of the one live UNRESOLVED conflict: refunds take 10
    // days here against the FAQ's 5.
    content:
      // "10 days", not the seeded statement's "10 business days": the model keeps "business
      // days" in the value, which would read as a conflict with claim-refund-10-days rather
      // than the same fact.
      'Refunds are processed within 10 days. ' +
      'Deleted accounts are erased 30 days after the deletion request. ' +
      'Standard shipping is a flat 5 USD per order. ' +
      'Free trials last 14 days.',
    lastReviewedAt: '2026-05-01T00:00:00Z',
  },
]

export const topics = [
  {
    _id: 'topic-refund-window',
    _type: 'topic',
    name: 'Refund Window',
    slug: {_type: 'slug', current: 'refund-window'},
    description: 'How long customers have to request a refund.',
  },
  {
    _id: 'topic-data-retention',
    _type: 'topic',
    name: 'Data Retention',
    slug: {_type: 'slug', current: 'data-retention'},
    // Read by the extractor's prompt (rule 3a picks a topic by matching this text against the
    // assertion), not just shown in the UI. "for active accounts" was measured WRONG here: it
    // excludes post-closure retention, so the bare sentence "Customer data is retained for 7
    // years after account closure." went to account-deletion 0/3, AND it is the wrong emphasis,
    // because the seeded claim is precisely about what happens after an account closes. Naming
    // the closure case took the same sentence to data-retention 3/3.
    description: 'How long we keep customer data, including after an account closes.',
  },
  {
    _id: 'topic-refund-method',
    _type: 'topic',
    name: 'Refund Method',
    slug: {_type: 'slug', current: 'refund-method'},
    description: 'How a refund is paid back to the customer.',
  },
  {
    _id: 'topic-shipping-cost',
    _type: 'topic',
    name: 'Shipping Cost',
    slug: {_type: 'slug', current: 'shipping-cost'},
    description: 'What we charge for standard shipping.',
  },
  {
    _id: 'topic-warranty-period',
    _type: 'topic',
    name: 'Warranty Period',
    slug: {_type: 'slug', current: 'warranty-period'},
    description: 'How long the product warranty lasts.',
  },
  {
    _id: 'topic-account-deletion',
    _type: 'topic',
    name: 'Account Deletion',
    slug: {_type: 'slug', current: 'account-deletion'},
    // A LIFECYCLE EVENT, not a duration, and that wording is load-bearing. Phrased as "How long
    // data is retained after an account deletion request" it read like a retention rule, and a
    // bare one-sentence source - "Customer data is retained for 7 years after account closure."
    // - was extracted onto THIS topic instead of Data Retention. The extractor reads this text.
    description:
      "What happens to an account's data once the customer asks for deletion, and when it is erased.",
  },
  {
    _id: 'topic-refund-processing-time',
    _type: 'topic',
    name: 'Refund Processing Time',
    slug: {_type: 'slug', current: 'refund-processing-time'},
    description: 'How long a refund takes to reach the customer. Left unproposed on purpose.',
  },
  {
    _id: 'topic-price-match-window',
    _type: 'topic',
    name: 'Price Match Window',
    slug: {_type: 'slug', current: 'price-match-window'},
    description: 'How long after purchase a customer can request a price match.',
  },
  {
    _id: 'topic-trial-period',
    _type: 'topic',
    name: 'Trial Period',
    slug: {_type: 'slug', current: 'trial-period'},
    description: 'How long a free trial runs.',
  },
  {
    _id: 'topic-cancellation-notice',
    _type: 'topic',
    name: 'Cancellation Notice',
    slug: {_type: 'slug', current: 'cancellation-notice'},
    description: 'How much notice a member must give to cancel.',
  },
  {
    _id: 'topic-gift-card-expiry',
    _type: 'topic',
    name: 'Gift Card Expiry',
    slug: {_type: 'slug', current: 'gift-card-expiry'},
    description: 'How long a gift card stays valid.',
  },
]

/**
 * Legacy (v1) resolution state, DERIVED from the new model.
 *
 * The deployed v1 app queries `*[_type == "claim" && status == "unresolved"]` for its
 * triage panel, and stamps `resolvedBy` when a human resolves a conflict. During the
 * expand window the seed must keep writing both fields or the deployed app goes blank -
 * `createOrReplace` replaces documents wholesale, so omitting a field deletes it.
 *
 * Deriving them here rather than hand-writing them per claim means the two models cannot
 * disagree. v1 semantics are preserved exactly: a WINNING claim is `resolved` with NO
 * `resolvedBy` (nothing overruled it), and an OVERRULED claim is `resolved` WITH
 * `resolvedBy` pointing at the instruction that overruled it.
 */
const OVERRULED_BY = {
  'claim-refund-method-credit': 'instruction-refund-method',
  'claim-account-deletion-30': 'instruction-account-deletion',
  'claim-price-match-14-marketing': 'instruction-price-match-window-1',
  'claim-trial-14-guide': 'instruction-trial-period-1',
  'claim-trial-21-marketing': 'instruction-trial-period-2',
  'claim-cancellation-30-support': 'instruction-cancellation-notice-1',
  'claim-cancellation-60-support': 'instruction-cancellation-notice-1',
  'claim-giftcard-24-months': 'instruction-gift-card-expiry-1',
}

const RESOLVED_WINNERS = new Set([
  'claim-refund-method-original',
  'claim-account-deletion-60',
  'claim-price-match-30-legal',
  'claim-trial-30-policy',
  'claim-giftcard-12-months',
])

function legacyStatus(claimId) {
  return OVERRULED_BY[claimId] || RESOLVED_WINNERS.has(claimId) ? 'resolved' : 'unresolved'
}

/** [id, statement, value, sourceId, topicId, confidence] */
const CLAIM_ROWS = [
  // --- open conflicts: these stay unresolved, so v1's triage still queues them ---
  ['claim-refund-30', 'Customers may request a refund within 30 days of purchase.', '30 days', 'source-internal-policy', 'topic-refund-window', 0.95],
  ['claim-refund-14', 'Customers may request a refund within 14 days of purchase.', '14 days', 'source-public-faq', 'topic-refund-window', 0.6],
  ['claim-shipping-5-marketing', 'Standard shipping costs $5 per order.', '5 USD', 'source-marketing-site', 'topic-shipping-cost', 0.8],
  ['claim-shipping-7-faq', 'Standard shipping costs $7 per order.', '7 USD', 'source-public-faq', 'topic-shipping-cost', 0.55],
  ['claim-shipping-5-support', 'Standard shipping is a flat $5 per order.', '5 USD', 'source-support-docs', 'topic-shipping-cost', 0.7],
  ['claim-warranty-1y', 'All products carry a 1-year warranty.', '1 year', 'source-internal-policy', 'topic-warranty-period', 0.85],
  ['claim-warranty-2y', 'All products carry a 2-year warranty.', '2 years', 'source-marketing-site', 'topic-warranty-period', 0.5],
  // Data Retention: two claims that AGREE on "7 years". Also the dismissed false positive.
  ['claim-retention-7y', 'We retain customer data for 7 years.', '7 years', 'source-internal-policy', 'topic-data-retention', 0.9],
  ['claim-retention-7y-support', 'Customer data is retained for 7 years after account closure.', '7 years', 'source-support-docs', 'topic-data-retention', 0.85],
  // Decision 1: the detected-only case judges resolve from scratch.
  ['claim-refund-5-days', 'Refunds are processed within 5 business days.', '5 days', 'source-public-faq', 'topic-refund-processing-time', 0.7],
  ['claim-refund-10-days', 'Refunds are processed within 10 business days.', '10 days', 'source-support-docs', 'topic-refund-processing-time', 0.6],
  // --- pre-resolved (retroactive cases) ---
  ['claim-refund-method-original', 'Refunds are issued to the original payment method.', 'Original payment method', 'source-internal-policy', 'topic-refund-method', 0.9],
  ['claim-refund-method-credit', 'Refunds are issued as store credit only.', 'Store credit only', 'source-public-faq', 'topic-refund-method', 0.4],
  ['claim-account-deletion-60', 'Deleted accounts are retained for 60 days before permanent erasure.', '60 days', 'source-legal-terms', 'topic-account-deletion', 0.95],
  ['claim-account-deletion-30', 'Deleted accounts are erased 30 days after the deletion request.', '30 days', 'source-support-docs', 'topic-account-deletion', 0.75],
  // --- eval: authority beats recency (official 2026-01-01 beats external 2026-02-10) ---
  ['claim-price-match-30-legal', 'Price matches are honoured for 30 days after purchase.', '30 days', 'source-legal-terms', 'topic-price-match-window', 0.8],
  ['claim-price-match-14-marketing', 'Price matches are honoured for 14 days after purchase.', '14 days', 'source-marketing-site', 'topic-price-match-window', 0.6],
  // --- eval: newer supersedes older (both internal; 2026-08-15 beats 2026-05-01) ---
  ['claim-trial-30-policy', 'Free trials last 30 days.', '30 days', 'source-internal-policy', 'topic-trial-period', 0.8],
  ['claim-trial-14-guide', 'Free trials last 14 days.', '14 days', 'source-support-docs', 'topic-trial-period', 0.6],
  ['claim-trial-21-marketing', 'Free trials last 21 days.', '21 days', 'source-marketing-site', 'topic-trial-period', 0.5],
  // --- eval: true tie. Same source, so authority, review date AND confidence all tie,
  // forcing the proposer onto its rule-4 id tie-break at confidence 0.5. ---
  ['claim-cancellation-30-support', "Members must give 30 days' notice to cancel.", '30 days', 'source-support-docs', 'topic-cancellation-notice', 0.7],
  ['claim-cancellation-60-support', "Members must give 60 days' notice to cancel.", '60 days', 'source-support-docs', 'topic-cancellation-notice', 0.7],
  // --- eval: precedent misleads ---
  ['claim-giftcard-12-months', 'Gift cards expire 12 months after purchase.', '12 months', 'source-internal-policy', 'topic-gift-card-expiry', 0.8],
  ['claim-giftcard-24-months', 'Gift cards expire 24 months after purchase.', '24 months', 'source-marketing-site', 'topic-gift-card-expiry', 0.6],
]

export const claims = CLAIM_ROWS.map(([id, statement, value, sourceId, topicId, confidence]) => ({
  _id: id,
  _type: 'claim',
  statement,
  value,
  source: ref(sourceId),
  topic: ref(topicId),
  confidence,
  // Expand-window legacy field. Removed from the schema and the data in Phase 8.
  status: legacyStatus(id),
}))

/** Phase D: overruled claims, whose legacy `resolvedBy` is patched after instructions exist. */
export const legacyResolvedBy = Object.entries(OVERRULED_BY).map(([claimId, instructionId]) => ({
  claimId,
  instructionId,
}))

const CLAIMS_BY_ID = new Map(claims.map((claim) => [claim._id, claim]))
const SOURCES_BY_ID = new Map(sources.map((source) => [source._id, source]))

/** A claim joined to its source, which is the shape the proposer ranks. */
function enrich(claimId) {
  const claim = CLAIMS_BY_ID.get(claimId)
  if (!claim) throw new Error(`Unknown claim id: ${claimId}`)
  const source = SOURCES_BY_ID.get(claim.source._ref)
  if (!source) throw new Error(`Claim ${claimId} points at unknown source ${claim.source._ref}`)
  return {
    _id: claim._id,
    statement: claim.statement,
    value: claim.value,
    confidence: claim.confidence,
    source: {
      _id: source._id,
      title: source.title,
      sourceType: source.sourceType,
      lastReviewedAt: source.lastReviewedAt,
    },
  }
}

export const SIMULATED_HUMAN_LABEL = SIMULATED_HUMAN.label

/**
 * The twelve cases. `proposedAt` / `ruledAt` / `supersededAt` are the event clock: the
 * proposal timestamps and the caseEvent timeline both read from here, so they cannot
 * drift apart. `case-refund-processing-time-1` deliberately has no `proposedAt` - it is
 * the case a judge resolves from scratch.
 *
 * `case-trial-period-2` is detected at 2026-09-10T09:00, *before* `case-trial-period-1`
 * is marked superseded at 2026-09-10T16:00 - the later case arrives first, and the
 * supersession is recorded when it is ruled.
 */
const CASE_ROWS = [
  {_id: 'case-refund-window-1', topic: 'topic-refund-window', claims: ['claim-refund-30', 'claim-refund-14'], detectedBy: 'seed', detectedAt: '2026-09-01T09:00:00Z', proposedAt: '2026-09-01T11:00:00Z'},
  {_id: 'case-shipping-cost-1', topic: 'topic-shipping-cost', claims: ['claim-shipping-5-marketing', 'claim-shipping-7-faq', 'claim-shipping-5-support'], detectedBy: 'seed', detectedAt: '2026-09-02T09:00:00Z', proposedAt: '2026-09-02T11:00:00Z'},
  {_id: 'case-warranty-period-1', topic: 'topic-warranty-period', claims: ['claim-warranty-1y', 'claim-warranty-2y'], detectedBy: 'seed', detectedAt: '2026-09-03T09:00:00Z', proposedAt: '2026-09-03T11:00:00Z'},
  {_id: 'case-price-match-window-1', topic: 'topic-price-match-window', claims: ['claim-price-match-30-legal', 'claim-price-match-14-marketing'], detectedBy: 'seed', detectedAt: '2026-09-04T09:00:00Z', proposedAt: '2026-09-04T11:00:00Z', ruledAt: '2026-09-04T15:00:00Z'},
  {_id: 'case-trial-period-1', topic: 'topic-trial-period', claims: ['claim-trial-30-policy', 'claim-trial-14-guide'], detectedBy: 'seed', detectedAt: '2026-09-05T09:00:00Z', proposedAt: '2026-09-05T11:00:00Z', ruledAt: '2026-09-06T10:00:00Z', supersededAt: '2026-09-10T16:00:00Z'},
  {_id: 'case-cancellation-notice-1', topic: 'topic-cancellation-notice', claims: ['claim-cancellation-30-support', 'claim-cancellation-60-support'], detectedBy: 'seed', detectedAt: '2026-09-12T09:00:00Z', proposedAt: '2026-09-12T11:00:00Z', ruledAt: '2026-09-12T15:00:00Z'},
  {_id: 'case-data-retention-1', topic: 'topic-data-retention', claims: ['claim-retention-7y', 'claim-retention-7y-support'], detectedBy: 'agent', detectedAt: '2026-09-13T09:00:00Z', ruledAt: '2026-09-13T10:00:00Z'},
  {_id: 'case-gift-card-expiry-1', topic: 'topic-gift-card-expiry', claims: ['claim-giftcard-12-months', 'claim-giftcard-24-months'], detectedBy: 'seed', detectedAt: '2026-09-14T09:00:00Z', proposedAt: '2026-09-14T11:00:00Z', ruledAt: '2026-09-14T15:00:00Z'},
  {_id: 'case-trial-period-2', topic: 'topic-trial-period', claims: ['claim-trial-30-policy', 'claim-trial-21-marketing'], detectedBy: 'seed', detectedAt: '2026-09-10T09:00:00Z', proposedAt: '2026-09-10T11:00:00Z', ruledAt: '2026-09-10T16:00:00Z'},
  {_id: 'case-refund-processing-time-1', topic: 'topic-refund-processing-time', claims: ['claim-refund-5-days', 'claim-refund-10-days'], detectedBy: 'seed', detectedAt: '2026-09-15T09:00:00Z'},
  {_id: 'case-refund-method-1', topic: 'topic-refund-method', claims: ['claim-refund-method-original', 'claim-refund-method-credit'], detectedBy: 'seed', detectedAt: '2026-06-28T09:00:00Z', proposedAt: '2026-06-28T11:00:00Z', ruledAt: '2026-07-01T14:00:00Z'},
  {_id: 'case-account-deletion-1', topic: 'topic-account-deletion', claims: ['claim-account-deletion-60', 'claim-account-deletion-30'], detectedBy: 'seed', detectedAt: '2026-06-10T09:00:00Z', proposedAt: '2026-06-10T11:00:00Z', ruledAt: '2026-06-15T10:00:00Z'},
]

const CASES_BY_ID = new Map(CASE_ROWS.map((row) => [row._id, row]))

/** Phase B payloads: cases with NO proposal. Phase D patches the proposals in. */
export const cases = CASE_ROWS.map((row) => ({
  _id: row._id,
  _type: 'case',
  topic: ref(row.topic),
  claims: refs(row.claims),
  detectedBy: row.detectedBy,
  detectedAt: row.detectedAt,
}))

export {CASES_BY_ID}

/**
 * Precedent citations. Only two cases cite anything, and both notes are hand-written
 * because precedent applicability is narrative - the ranking rule cannot know whether
 * an earlier ruling on another topic transfers.
 *
 * `case-gift-card-expiry-1` is the "precedent misleads" case: the AGENT cites the
 * account-deletion ruling as governing, and the human's instruction will cite the same
 * ruling as `distinguishes`. The agent's note below is deliberately overconfident - that
 * is the failure being demonstrated.
 */
const PRECEDENT_PLANS = {
  'case-trial-period-2': {
    precedents: [
      {
        _type: 'precedent',
        _key: 'prec-trial-period-1',
        instruction: ref('instruction-trial-period-1'),
        relation: 'follows',
      },
    ],
    note:
      'The earlier ruling on this topic (instruction-trial-period-1, that free trials ' +
      'last 30 days) remains applicable: this case adds a third source asserting 21 days, ' +
      'but does not disturb the authority ranking that decided the first, so the prior ' +
      'ruling is followed rather than revisited.',
  },
  'case-gift-card-expiry-1': {
    precedents: [
      {
        _type: 'precedent',
        _key: 'prec-account-deletion',
        instruction: ref('instruction-account-deletion'),
        relation: 'follows',
      },
    ],
    note:
      'The account-deletion ruling (instruction-account-deletion) is treated as governing: ' +
      'it established that the higher-authority source prevails even when a competing source ' +
      'is more recent, and the same ranking appears to decide this case.',
  },
}

/**
 * The precomputed proposals, produced by the shared deterministic rule - the same
 * function the in-browser "Propose ruling" button will call.
 *
 * Every case with a `proposedAt` gets a proposal; the presence of that timestamp IS the
 * plan. `case-refund-processing-time-1` (Decision 1) and `case-data-retention-1` (the
 * dismissed false positive) have none, so they stay at `detected` and `ruled` respectively.
 */
export const caseProposals = CASE_ROWS.filter((row) => row.proposedAt).map((row) => {
  const ranked = proposeRule({claims: row.claims.map(enrich)})
  const plan = PRECEDENT_PLANS[row._id] ?? {precedents: [], note: null}
  const outcomeClaim = CLAIMS_BY_ID.get(ranked.outcomeId)

  return {
    caseId: row._id,
    /** Phase D payload. */
    proposal: {
      outcome: ref(ranked.outcomeId),
      rationale: withPrecedentNote(ranked.rationale, plan.note),
      confidence: ranked.confidence,
      precedents: plan.precedents,
      proposedAt: row.proposedAt,
      model: 'offline-heuristic-v1',
      promptVersion: 'v1',
    },
    /** Not written to the document - used by the seed summary and the Phase 7 eval. */
    decidingRule: ranked.decidingRule,
    outcomeClaimId: ranked.outcomeId,
    outcomeStatement: outcomeClaim.statement,
    outcomeValue: outcomeClaim.value,
  }
})

const precedent = (instructionId, relation, key) => ({
  _type: 'precedent',
  _key: key,
  instruction: ref(instructionId),
  relation,
})

/**
 * The expand-window projection of an instruction onto the v1 shape.
 *
 * `instruction.decidedAt` and `decidedBy` are dropped from the schema in Phase 8 and
 * derived from caseEvents instead, but the deployed v1 app's History view reads them
 * directly and sorts on `decidedAt`. Omitting them here would blank out five of the seven
 * History rows, so they are written until the contract phase.
 *
 * `basedOnClaim` is omitted when the ruling established a new value instead of picking a
 * claim: v1 renders it as "Correct claim", and pointing at an overruled claim would
 * actively misreport the decision. That leaves one expected validation warning in the
 * Studio against `instruction-cancellation-notice-1` - accepted and reported.
 */
const legacy = ({winner, overruled, decidedAt}) => ({
  ...(winner ? {basedOnClaim: ref(winner)} : {}),
  ...(overruled && overruled.length > 0 ? {contradictsClaim: ref(overruled[0])} : {}),
  decidedBy: SIMULATED_HUMAN.label,
  decidedAt,
})

export const instructions = [
  {
    _id: 'instruction-refund-method',
    _type: 'instruction',
    resolution:
      'Refunds are issued to the original payment method. Store credit is offered only when the original payment method is unavailable.',
    appliesToTopic: ref('topic-refund-method'),
    case: ref('case-refund-method-1'),
    winner: ref('claim-refund-method-original'),
    overruled: refs(['claim-refund-method-credit']),
    precedents: [],
    ...legacy({
      winner: 'claim-refund-method-original',
      overruled: ['claim-refund-method-credit'],
      decidedAt: '2026-07-01T14:00:00Z',
    }),
  },
  {
    _id: 'instruction-account-deletion',
    _type: 'instruction',
    resolution:
      'Legal Terms govern even though Support Docs is more recent - legal language supersedes support documentation. Deleted accounts are retained for 60 days.',
    appliesToTopic: ref('topic-account-deletion'),
    case: ref('case-account-deletion-1'),
    winner: ref('claim-account-deletion-60'),
    overruled: refs(['claim-account-deletion-30']),
    precedents: [],
    ...legacy({
      winner: 'claim-account-deletion-60',
      overruled: ['claim-account-deletion-30'],
      decidedAt: '2026-06-15T10:00:00Z',
    }),
  },
  {
    _id: 'instruction-price-match-window-1',
    _type: 'instruction',
    resolution:
      'Price matches are honoured for 30 days. The Legal Terms window governs: the marketing page is a summary of the entitlement, not a shorter one.',
    appliesToTopic: ref('topic-price-match-window'),
    case: ref('case-price-match-window-1'),
    winner: ref('claim-price-match-30-legal'),
    overruled: refs(['claim-price-match-14-marketing']),
    precedents: [],
    ...legacy({
      winner: 'claim-price-match-30-legal',
      overruled: ['claim-price-match-14-marketing'],
      decidedAt: '2026-09-04T15:00:00Z',
    }),
  },
  {
    _id: 'instruction-trial-period-1',
    _type: 'instruction',
    resolution:
      'Free trials last 30 days. Both sources are internal, so the more recently reviewed Internal Policy governs over the older Support Docs figure.',
    appliesToTopic: ref('topic-trial-period'),
    case: ref('case-trial-period-1'),
    winner: ref('claim-trial-30-policy'),
    overruled: refs(['claim-trial-14-guide']),
    precedents: [],
    ...legacy({
      winner: 'claim-trial-30-policy',
      overruled: ['claim-trial-14-guide'],
      decidedAt: '2026-09-06T10:00:00Z',
    }),
  },
  {
    _id: 'instruction-trial-period-2',
    _type: 'instruction',
    resolution:
      'Free trials last 30 days. The 21-day marketing claim is overruled, and this ruling both follows and supersedes instruction-trial-period-1 as the current answer for this topic.',
    appliesToTopic: ref('topic-trial-period'),
    case: ref('case-trial-period-2'),
    winner: ref('claim-trial-30-policy'),
    overruled: refs(['claim-trial-21-marketing']),
    precedents: [precedent('instruction-trial-period-1', 'follows', 'prec-trial-period-1')],
    // WEAK: the superseded ruling is never deleted, and a strong reference here would
    // make the precedent chain progressively harder to clean up. `_weak` is the data-level
    // marker; the schema carries `weak: true` as the default for new references.
    supersedes: {_type: 'reference', _ref: 'instruction-trial-period-1', _weak: true},
    ...legacy({
      winner: 'claim-trial-30-policy',
      overruled: ['claim-trial-21-marketing'],
      decidedAt: '2026-09-10T16:00:00Z',
    }),
  },
  {
    _id: 'instruction-cancellation-notice-1',
    _type: 'instruction',
    resolution:
      'The correct notice period is 45 days. Both claims come from the same document with an identical review date and equal confidence, so neither is more authoritative and neither can be preferred; the customer-communication guidelines set 45 days as the period we can actually honour. Both claims are overruled, so this ruling establishes a new value rather than adopting one.',
    appliesToTopic: ref('topic-cancellation-notice'),
    case: ref('case-cancellation-notice-1'),
    // No `winner`: this ruling establishes a value no claim asserts (D8).
    outcomeValue: '45 days',
    overruled: refs(['claim-cancellation-30-support', 'claim-cancellation-60-support']),
    precedents: [],
    ...legacy({
      overruled: ['claim-cancellation-30-support', 'claim-cancellation-60-support'],
      decidedAt: '2026-09-12T15:00:00Z',
    }),
  },
  {
    _id: 'instruction-gift-card-expiry-1',
    _type: 'instruction',
    resolution:
      'Gift cards expire 12 months after purchase, per the Internal Policy. The agent cited the account-deletion ruling, but that precedent does not transfer: it turned on the legal authority of the Legal Terms specifically, and gift-card expiry is not a legally mandated term.',
    appliesToTopic: ref('topic-gift-card-expiry'),
    case: ref('case-gift-card-expiry-1'),
    winner: ref('claim-giftcard-12-months'),
    overruled: refs(['claim-giftcard-24-months']),
    // The human's reading of the same precedent the agent cited - as `distinguishes`.
    precedents: [precedent('instruction-account-deletion', 'distinguishes', 'prec-account-deletion')],
    ...legacy({
      winner: 'claim-giftcard-12-months',
      overruled: ['claim-giftcard-24-months'],
      decidedAt: '2026-09-14T15:00:00Z',
    }),
  },
]

export const INSTRUCTIONS_BY_ID = new Map(instructions.map((instruction) => [instruction._id, instruction]))

const PROPOSAL_BY_CASE = new Map(caseProposals.map((entry) => [entry.caseId, entry]))
const INSTRUCTION_BY_CASE = new Map(
  instructions.map((instruction) => [instruction.case._ref, instruction]),
)

const eventId = (caseId, to) => `event-${caseId.replace(/^case-/, '')}-${to}`

function event({caseId, from, to, at, actor, rationale, payload}) {
  const document = {
    _id: eventId(caseId, to),
    _type: 'caseEvent',
    case: ref(caseId),
    from,
    to,
    actor,
    at,
  }
  if (rationale) document.rationale = rationale
  if (payload) document.payload = payload
  return document
}

/**
 * Human rationales, written per case because this is the material the writeup leans on.
 * `case-cancellation-notice-1` and `case-gift-card-expiry-1` are the two cases where the
 * human's reasoning is the point of the demo.
 */
const HUMAN_RATIONALES = {
  'case-cancellation-notice-1':
    'Both sources agree on the source, its review date, and its confidence - the agent could not decide. Human judgment: the correct value is 45 days, splitting the difference and matching the customer-communication guidelines.',
  'case-gift-card-expiry-1':
    'The agent cited the account-deletion ruling, but that ruling turned on the legal authority of Legal Terms specifically. Gift cards are governed by consumer-protection rules that override internal policy, so the account-deletion precedent does not apply here.',
  'case-data-retention-1':
    'No conflict found: both claims assert 7 years. The case was opened on a detection false positive and is closed without a ruling.',
}

/**
 * What the human did with the agent's proposal, recorded on the ruled event.
 *
 * `approvedProposal` is true when the human's winner matches the agent's outcome. The
 * gift-card case is the interesting one: it reads `true` because the outcome really was
 * accepted, while the reasoning diverged (the agent cited the account-deletion precedent
 * as `follows`, the ruling cites it as `distinguishes`). Outcome agreement and reasoning
 * agreement are separate signals, which is why this field only captures the first.
 */
function ruledPayload(caseId) {
  const proposal = PROPOSAL_BY_CASE.get(caseId)
  const instruction = INSTRUCTION_BY_CASE.get(caseId)

  if (!proposal) {
    return {note: 'False positive: both claims assert the same value, so no ruling was needed.'}
  }

  const agentOutcomeId = proposal.outcomeClaimId
  if (instruction && instruction.winner) {
    return {
      approvedProposal: agentOutcomeId === instruction.winner._ref,
      agentOutcomeId,
      humanOutcomeId: instruction.winner._ref,
    }
  }

  return {
    approvedProposal: false,
    agentOutcomeId,
    note: `Human overrode the proposal and established a new value: ${instruction.outcomeValue}.`,
  }
}

/**
 * The 31 events, derived from the case clock so the timeline and the proposals cannot
 * disagree. Creation events carry `from: null` and use the acting detector as the actor;
 * every `ruled` event uses the disclosed simulated-human actor, because `ruled` is
 * human-only in workflow.def.json.
 */
export const caseEvents = CASE_ROWS.flatMap((row) => {
  const events = [
    event({
      caseId: row._id,
      from: null,
      to: 'detected',
      at: row.detectedAt,
      actor: row.detectedBy === 'agent' ? AGENT_ACTOR : SEED_ACTOR,
    }),
  ]

  if (row.proposedAt) {
    events.push(
      event({
        caseId: row._id,
        from: 'detected',
        to: 'proposed',
        at: row.proposedAt,
        actor: AGENT_ACTOR,
        payload: {note: 'Proposal computed by the offline heuristic (offline-heuristic-v1).'},
      }),
    )
  }

  if (row.ruledAt) {
    events.push(
      event({
        caseId: row._id,
        from: row.proposedAt ? 'proposed' : 'detected',
        to: 'ruled',
        at: row.ruledAt,
        actor: SIMULATED_HUMAN,
        rationale: HUMAN_RATIONALES[row._id],
        payload: ruledPayload(row._id),
      }),
    )
  }

  if (row.supersededAt) {
    events.push(
      event({
        caseId: row._id,
        from: 'ruled',
        to: 'superseded',
        at: row.supersededAt,
        actor: SYSTEM_ACTOR,
        payload: {
          note: 'Superseded by instruction-trial-period-2, which rules on a new claim about the same topic.',
        },
      }),
    )
  }

  return events
})

/**
 * Every id this seed owns, DERIVED from the data rather than hand-listed.
 *
 * At 90 documents a hand-maintained list is a guaranteed drift bug, and the list is not
 * merely documentation: `clearStrayClaims()` uses it to decide which claims to DELETE,
 * so a stale entry would remove seeded data.
 */
export const SEED_DOCUMENT_IDS = [
  ...sources,
  ...topics,
  ...claims,
  ...cases,
  ...instructions,
  ...caseEvents,
].map((document) => document._id)

/** Per-type collections, for the seed summary and post-seed verification. */
export const documentsByType = {
  source: sources,
  topic: topics,
  claim: claims,
  case: cases,
  instruction: instructions,
  caseEvent: caseEvents,
}

export const TOTAL_DOCUMENTS = SEED_DOCUMENT_IDS.length

/**
 * The stage each case should resolve to once the derived-stage query runs.
 *
 * This is the derived-from-events stage (latest event's `to`), written down here so the
 * seed can check its own output and so the Phase 3 UI author has the expectation sitting
 * next to the data. `case-data-retention-1` is the one to watch: it has a `ruled` event
 * but no instruction and no proposal, so an artifact-based derivation would wrongly call
 * it `detected`.
 */
export const expectedStages = Object.fromEntries(
  CASE_ROWS.map((row) => [
    row._id,
    row.supersededAt
      ? 'superseded'
      : row.ruledAt
        ? 'ruled'
        : row.proposedAt
          ? 'proposed'
          : 'detected',
  ]),
)
