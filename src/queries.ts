import type {
  CanonicalAnswer,
  CaseDetail,
  HistoryRow,
  SourceOption,
  SupersededRuling,
  TopicOption,
  TopicWithAnswer,
  TriageCase,
} from './types'

/**
 * Every GROQ query the app runs, in one place.
 *
 * Two predicates are load-bearing and must not be swapped back:
 *
 * 1. SUPERSESSION uses `supersedes._ref == ^._id`, NOT `references(^._id)`.
 *    `references()` also matches `precedents` citations, so it conflates "this ruling was
 *    replaced" with "this ruling was cited". We hit that bug in Phase 2: the canonical
 *    answer for Account Deletion disappeared because a later ruling cited it.
 *
 * 2. "IS A CLAIM RESOLVED" still uses `references(^._id)`, which is correct there: any
 *    instruction naming a claim - as winner or as overruled - has settled it.
 *    `references()` is only wrong when one field carries two meanings.
 */

/**
 * The derived stage: the `to` of the latest `caseEvent` for the case, falling back to
 * `"detected"` when no events exist.
 *
 * Deriving from the event log rather than from artifacts is what makes a case ruled
 * WITHOUT an instruction (`case-data-retention-1`, a dismissed false positive) read as
 * `ruled` rather than `detected`.
 *
 * `^` binds to the immediately enclosing scope, so inside this subquery it is the case.
 * Verified against the live dataset: 3 proposed, 1 detected, 7 ruled, 1 superseded.
 */
const STAGE_EXPRESSION = `coalesce(
    *[_type == "caseEvent" && case._ref == ^._id] | order(at desc)[0].to,
    "detected"
  )`

/**
 * Every case with its derived stage and its claims dereferenced.
 *
 * Ordered by `detectedAt desc` in GROQ and grouped by stage in the UI: the requested
 * "proposed, then detected, then ruled, then superseded" ordering is done in JS because
 * GROQ cannot order by a field computed in the same projection without repeating this
 * nested subquery four times inside a `select`.
 */
export const TRIAGE_CASES_QUERY = `*[_type == "case"] | order(detectedAt desc) {
  _id,
  "topicRef": topic._ref,
  "topicName": topic->name,
  detectedBy,
  detectedAt,
  "claims": claims[]->{
    _id,
    statement,
    value,
    confidence,
    "source": source->{_id, title, sourceType, lastReviewedAt}
  },
  "stage": ${STAGE_EXPRESSION}
}`

/** Stable module-level identity: the SDK hashes this object into its query key. */
export const TRIAGE_CASES_OPTIONS = {query: TRIAGE_CASES_QUERY}

/**
 * One case with everything the centre panel needs.
 *
 * Uses `$caseId` rather than `^._id` for the outer lookups, because a parameter has no
 * scope ambiguity. The one genuinely nested use of `^` is
 * `supersedes._ref == ^._id` inside the ruling projection, where `^` must bind to the
 * INSTRUCTION rather than the case. Verified against live data.
 */
export const CASE_DETAIL_QUERY = `*[_type == "case" && _id == $caseId][0] {
  _id,
  "topicRef": topic._ref,
  "topicName": topic->name,
  detectedBy,
  detectedAt,
  "claims": claims[]->{
    _id,
    statement,
    value,
    confidence,
    "source": source->{_id, title, sourceType, lastReviewedAt}
  },
  "stage": coalesce(
    *[_type == "caseEvent" && case._ref == $caseId] | order(at desc)[0].to,
    "detected"
  ),
  "proposal": proposal {
    "outcome": outcome->{
      _id, statement, value, confidence,
      "source": source->{_id, title, sourceType, lastReviewedAt}
    },
    rationale,
    confidence,
    proposedAt,
    model,
    promptVersion,
    "precedents": precedents[]{
      relation,
      "instructionId": instruction._ref,
      "instructionResolution": instruction->resolution,
      "instructionTopic": instruction->appliesToTopic->name
    }
  },
  "ruling": *[_type == "instruction" && case._ref == $caseId][0] {
    _id,
    resolution,
    outcomeValue,
    "winner": winner->{
      _id, statement, value, confidence,
      "source": source->{_id, title, sourceType, lastReviewedAt}
    },
    "overruled": overruled[]->{
      _id, statement, value, confidence,
      "source": source->{_id, title, sourceType, lastReviewedAt}
    },
    "precedents": precedents[]{
      relation,
      "instructionId": instruction._ref,
      "instructionResolution": instruction->resolution,
      "instructionTopic": instruction->appliesToTopic->name
    },
    "supersededBy": *[_type == "instruction" && supersedes._ref == ^._id][0]{
      _id, resolution
    }
  },
  "events": *[_type == "caseEvent" && case._ref == $caseId] | order(at asc) {
    _id, from, to, at, actor, rationale
  }
}`

/** Memoize the result of this in the component on `[caseId]`. */
export function caseDetailOptions(caseId: string) {
  return {query: CASE_DETAIL_QUERY, params: {caseId}}
}

/**
 * The governance record: every `ruled` event, newest first.
 *
 * History iterates the EVENT LOG rather than instructions, because the log is where the
 * transition happened and it records WHO moved the case. A dismissed false positive has a
 * `ruled` event and no instruction, so `instruction` is null for that row and the UI
 * renders the disposition from `rationale` instead.
 *
 * The two `^` levels here resolve differently and deliberately: the outer
 * `case._ref == ^.case._ref` binds to the caseEvent, the inner
 * `supersedes._ref == ^._id` binds to the instruction. Both verified against live data.
 */
export const HISTORY_RULED_QUERY = `*[_type == "caseEvent" && to == "ruled"] | order(at desc) {
  _id,
  at,
  actor,
  rationale,
  "caseId": case._ref,
  "topicName": case->topic->name,
  "instruction": *[_type == "instruction" && case._ref == ^.case._ref][0] {
    _id,
    resolution,
    outcomeValue,
    "winner": winner->{
      _id, statement, value, confidence,
      "source": source->{_id, title, sourceType, lastReviewedAt}
    },
    "overruled": overruled[]->{
      _id, statement, value, confidence,
      "source": source->{_id, title, sourceType, lastReviewedAt}
    },
    "precedents": precedents[]{
      relation,
      "instructionId": instruction._ref,
      "instructionResolution": instruction->resolution,
      "instructionTopic": instruction->appliesToTopic->name
    },
    "supersededBy": *[_type == "instruction" && supersedes._ref == ^._id][0]._id
  }
}`

export const HISTORY_RULED_OPTIONS = {query: HISTORY_RULED_QUERY}

/**
 * The ruling that currently answers a topic: the most recent instruction that nothing
 * supersedes. Written now for Phase 6's consumer panel.
 *
 * `supersedes._ref == ^._id`, never `references()` - see the module comment.
 *
 * `decidedAt` / `decidedBy` are projected because the panel attributes the answer to a
 * person and a date. NOTE: those two are expand-window legacy fields (Phase 8 removes
 * them); when that happens this projection should switch to the `ruled` caseEvent's
 * `actor.label` and `at`, which is where HistoryView already reads attribution from.
 */
export const CANONICAL_ANSWER_QUERY = `*[_type == "instruction"
    && appliesToTopic._ref == $topicId
    && count(*[_type == "instruction" && supersedes._ref == ^._id]) == 0
  ] | order(decidedAt desc)[0] {
    _id,
    resolution,
    decidedAt,
    decidedBy,
    "topicName": appliesToTopic->name,
    "topicDescription": appliesToTopic->description,
    "value": coalesce(winner->value, outcomeValue),
    "winner": winner->{
      _id, statement, value, confidence,
      "source": source->{_id, title, sourceType, lastReviewedAt}
    },
    "overruled": overruled[]->{
      _id, statement, value, confidence,
      "source": source->{_id, title, sourceType, lastReviewedAt}
    },
    "precedents": precedents[]{
      relation,
      "instructionId": instruction._ref,
      "instructionResolution": instruction->resolution,
      "instructionTopic": instruction->appliesToTopic->name
    }
  }`

/** Memoize on `[topicId]`. */
export function canonicalAnswerOptions(topicId: string) {
  return {query: CANONICAL_ANSWER_QUERY, params: {topicId}}
}

/**
 * Every topic that currently HAS an answer, alphabetically: one row per non-superseded
 * instruction. This is the left column of the Answers panel.
 *
 * The same corrected predicate as above: an instruction is current when nothing supersedes
 * it. `references()` would wrongly drop Account Deletion, whose ruling is cited by a later
 * one on another topic.
 */
export const TOPICS_WITH_ANSWERS_QUERY = `*[_type == "instruction"
    && count(*[_type == "instruction" && supersedes._ref == ^._id]) == 0
  ] | order(appliesToTopic->name asc) {
    "topicRef": appliesToTopic._ref,
    "topicName": appliesToTopic->name,
    "topicDescription": appliesToTopic->description,
    "value": coalesce(winner->value, outcomeValue),
    "instructionId": _id
  }`

/** Stable module-level identity: the SDK hashes this object into its query key. */
export const TOPICS_WITH_ANSWERS_OPTIONS = {query: TOPICS_WITH_ANSWERS_QUERY}

/**
 * The rulings a topic has REPLACED, oldest first, for the Answers panel's superseded chain.
 *
 * An instruction is superseded when something supersedes it - the exact complement of the
 * current-answer predicate, so between them the two queries account for every instruction
 * a topic has ever had.
 */
export const SUPERSEDED_CHAIN_QUERY = `*[_type == "instruction"
    && appliesToTopic._ref == $topicId
    && count(*[_type == "instruction" && supersedes._ref == ^._id]) > 0
  ] | order(decidedAt asc) {
    _id,
    resolution,
    decidedAt,
    decidedBy,
    "value": coalesce(winner->value, outcomeValue),
    "supersededBy": *[_type == "instruction" && supersedes._ref == ^._id][0]._id
  }`

/** Memoize on `[topicId]`. */
export function supersededChainOptions(topicId: string) {
  return {query: SUPERSEDED_CHAIN_QUERY, params: {topicId}}
}

// Dropdown lookups for the Add Claim dialog. They live here so the app has one query
// module; the dialog imports them instead of declaring its own copies.
export const TOPICS_QUERY = `*[_type == "topic"]{_id, name} | order(name asc)`
export const SOURCES_QUERY = `*[_type == "source"]{_id, title} | order(title asc)`

export const TOPICS_OPTIONS = {query: TOPICS_QUERY}
export const SOURCES_OPTIONS = {query: SOURCES_QUERY}

// Type-only re-exports, so a component can import the query and its result shape from
// one module.
export type {
  CanonicalAnswer,
  CaseDetail,
  HistoryRow,
  SourceOption,
  SupersededRuling,
  TopicOption,
  TopicWithAnswer,
  TriageCase,
}
