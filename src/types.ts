/**
 * Result shapes for the queries in `src/queries.ts`.
 *
 * These mirror the projections exactly. Everything is nullable because GROQ returns
 * `null` for a missing field and the UI must render absence rather than assume presence -
 * a `ruled` case with no instruction is a real state we ship (`case-data-retention-1`).
 */

/** The four stages, derived from the event log rather than stored. */
export type CaseStage = 'detected' | 'proposed' | 'ruled' | 'superseded'

/** Who moved a case. `human` events in seeded data are labelled fixtures. */
export type ActorKind = 'agent' | 'human' | 'system' | 'seed'

export type Actor = {
  kind: ActorKind | null
  id: string | null
  label: string | null
}

export type ClaimSource = {
  _id: string
  title: string | null
  sourceType: string | null
  lastReviewedAt: string | null
}

/**
 * A claim as the case queries return it.
 *
 * NOTE: this is nested (`source: {...}`) rather than the old flat `sourceTitle` /
 * `topicName` shape. The topic now lives on the case - that is the entire point of the
 * case model - so a claim no longer carries its own topic projection, and authority
 * ranking needs the whole source object, not just its title.
 */
export type ClaimSummary = {
  _id: string
  statement: string | null
  value: string | null
  confidence: number | null
  source: ClaimSource | null
}

/**
 * How a ruling used a prior ruling.
 *
 * The relation is the whole reason precedents are typed rather than a bare reference
 * list: `distinguishes` means a cited ruling was held NOT to apply, and that is a
 * different claim about the world than `follows`.
 */
export type PrecedentCitation = {
  relation: 'follows' | 'distinguishes' | 'overrules' | null
  instructionId: string | null
  instructionResolution: string | null
  instructionTopic: string | null
}

/** The agent's proposal. Absent while a case is `detected`. */
export type Proposal = {
  outcome: ClaimSummary | null
  rationale: string | null
  confidence: number | null
  proposedAt: string | null
  model: string | null
  promptVersion: string | null
  precedents: PrecedentCitation[]
}

/**
 * The instruction that answered a case.
 *
 * Exactly one of `winner` / `outcomeValue` is set: a ruling either picks one of the
 * claims in conflict, or establishes a value that no claim asserted.
 */
export type Ruling = {
  _id: string
  resolution: string | null
  outcomeValue: string | null
  winner: ClaimSummary | null
  overruled: ClaimSummary[]
  precedents: PrecedentCitation[]
  /** Non-null when a LATER instruction supersedes this one. */
  supersededBy: {_id: string; resolution: string | null} | null
}

export type CaseEventEntry = {
  _id: string
  from: CaseStage | null
  to: CaseStage
  at: string
  actor: Actor | null
  rationale: string | null
}

/**
 * The audit snapshot written on a `ruled` transition, by either actor.
 *
 * `approvedProposal` is the field the Phase 7 eval reads to separate an acceptance from an
 * override. `agentOutcomeId` / `humanOutcomeId` are STRINGS rather than references, so the
 * row records what was true at rule time instead of tracking a live claim.
 *
 * Write-side only: `CASE_DETAIL_QUERY` does not project `payload`, so `CaseEventEntry`
 * deliberately omits these rather than promising data the query never returns.
 */
export type RulingPayload = {
  approvedProposal?: boolean
  agentOutcomeId?: string | null
  humanOutcomeId?: string | null
  note?: string
}

/** One row of the left panel. */
export type TriageCase = {
  _id: string
  topicRef: string | null
  topicName: string | null
  detectedBy: string | null
  detectedAt: string | null
  claims: ClaimSummary[]
  stage: CaseStage
}

/** The centre panel's case: everything the claim cards, proposal panel and form need. */
export type CaseDetail = TriageCase & {
  proposal: Proposal | null
  ruling: Ruling | null
  events: CaseEventEntry[]
}

/** One row of the History tab. `instruction` is null for a dismissed false positive. */
export type HistoryRow = {
  _id: string
  at: string
  actor: Actor | null
  rationale: string | null
  caseId: string | null
  topicName: string | null
  instruction: {
    _id: string
    resolution: string | null
    outcomeValue: string | null
    winner: ClaimSummary | null
    overruled: ClaimSummary[]
    precedents: PrecedentCitation[]
    supersededBy: string | null
  } | null
}

/** The currently-answerable ruling for a topic (Phase 6's consumer panel). */
export type CanonicalAnswer = {
  _id: string
  resolution: string | null
  decidedAt: string | null
  decidedBy: string | null
  topicName: string | null
  topicDescription: string | null
  value: string | null
  winner: ClaimSummary | null
  overruled: ClaimSummary[]
  precedents: PrecedentCitation[]
}

/** One row of the Answers panel's left column: a topic and the answer it returns now. */
export type TopicWithAnswer = {
  /** `appliesToTopic` is `required()` in the schema, so this is never null in practice. */
  topicRef: string
  topicName: string | null
  topicDescription: string | null
  value: string | null
  /** The instruction establishing this answer. */
  instructionId: string
}

/** A ruling a later one replaced, for the Answers panel's superseded chain. */
export type SupersededRuling = {
  _id: string
  resolution: string | null
  decidedAt: string | null
  decidedBy: string | null
  value: string | null
  /** The instruction that replaced this one. */
  supersededBy: string | null
}

export type TopicOption = {
  _id: string
  name: string | null
}

export type SourceOption = {
  _id: string
  title: string | null
}
