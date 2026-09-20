import {useCallback, useState} from 'react'
import {
  createDocument,
  createDocumentHandle,
  editDocument,
  publishDocument,
  useApplyDocumentActions,
} from '@sanity/sdk-react'
import {Button, Card, Stack, Text} from '@sanity/ui'

import {proposeRule} from '../../scripts/lib/propose.mjs'
import type {ClaimSource, ClaimSummary} from '../types'

/**
 * Runs the deterministic proposer in the browser and records the result.
 *
 * WHY THIS CAN RUN HERE WHEN EXTRACTION CANNOT. `scripts/lib/propose.mjs` is a pure
 * function: no imports, no I/O, no key. It is the SAME implementation the seed precomputed
 * every seeded proposal with, so the button and the eval cannot drift - one rule, two
 * callers. Extraction is the opposite case (an API key plus an outbound provider call that a
 * browser origin cannot make), which is why extracted claims arrive pre-computed instead.
 *
 * The button appears on a `detected` case, where no proposal exists yet. After a successful
 * write the case's live queries re-read and the panel switches to the proposal, so this
 * component's only job is the write plus reporting a failure.
 */

/** Names this producer in `case.proposal.model`, so the eval can attribute proposals. */
const PROPOSER_ID = 'offline-heuristic-v1'

/**
 * `case.proposal.promptVersion` exists so a proposal stays reproducible after the prompt
 * changes. This producer has no prompt - it is a fixed rule - so the version names the RULE
 * revision. `v1` is what the seeded proposals carry.
 */
const PROPOSER_VERSION = 'v1'

const refTo = (_ref: string): {_type: 'reference'; _ref: string} => ({_type: 'reference', _ref})

/** A claim the proposer can rank: the rule needs the source's authority and review date. */
type RankableClaim = ClaimSummary & {source: ClaimSource & {sourceType: string}}

function isRankable(claim: ClaimSummary): claim is RankableClaim {
  return Boolean(claim.source?.sourceType)
}

type ProposeActionsProps = {
  caseId: string
  claims: ClaimSummary[]
  onProposed: () => void
}

export function ProposeActions({caseId, claims, onProposed}: ProposeActionsProps) {
  const apply = useApplyDocumentActions()
  const [isProposing, setIsProposing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handlePropose = useCallback(async () => {
    setIsProposing(true)
    setError(null)

    try {
      const rankable = claims.filter(isRankable)
      if (rankable.length < 2) {
        throw new Error(
          `The proposer ranks claims by their source, and this case has ${rankable.length} ` +
            'claim(s) whose source could be read. It needs at least two.',
        )
      }

      const now = new Date().toISOString()

      // The same call the seed makes. `lastReviewedAt` defaults to an empty string rather
      // than null: the rule compares dates as strings, and an empty date sorts last, which
      // is the right reading for "never reviewed".
      const result = proposeRule({
        claims: rankable.map((claim) => ({
          _id: claim._id,
          value: claim.value ?? '',
          confidence: claim.confidence ?? undefined,
          source: {
            _id: claim.source._id,
            title: claim.source.title ?? claim.source._id,
            sourceType: claim.source.sourceType,
            lastReviewedAt: claim.source.lastReviewedAt ?? '',
          },
        })),
      })

      if (!claims.some((claim) => claim._id === result.outcomeId)) {
        // `proposal.outcome` must be one of the case's own claims (schemaTypes/case.ts).
        throw new Error(`The proposer chose ${result.outcomeId}, which is not in this case.`)
      }

      const caseHandle = createDocumentHandle({documentId: caseId, documentType: 'case'})
      const eventHandle = createDocumentHandle({
        documentId: `event-${caseId}-proposed`,
        documentType: 'caseEvent',
      })

      // ONE transaction: the proposal and the event announcing it can never disagree. The
      // case is edited BEFORE it is published so the published copy carries the proposal
      // rather than the stale draft - the ordering ResolveForm uses for its claim edits.
      await apply([
        editDocument(caseHandle, {
          set: {
            proposal: {
              outcome: refTo(result.outcomeId),
              rationale: result.rationale,
              confidence: result.confidence,
              // The offline proposer cites no precedents: it ranks claims by source
              // authority, recency, confidence and id, and never reads the record.
              precedents: [],
              proposedAt: now,
              model: PROPOSER_ID,
              promptVersion: PROPOSER_VERSION,
            },
          },
        }),
        publishDocument(caseHandle),
        createDocument(eventHandle, {
          case: refTo(caseId),
          from: 'detected',
          to: 'proposed',
          actor: {kind: 'agent', id: PROPOSER_ID, label: 'Offline proposer'},
          at: now,
          payload: {note: `Proposed by ${PROPOSER_ID} (rule ${result.decidingRule}).`},
        } as never),
        publishDocument(eventHandle),
      ])

      onProposed()
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : 'Failed to propose a ruling.',
      )
    } finally {
      setIsProposing(false)
    }
  }, [apply, caseId, claims, onProposed])

  return (
    <Stack space={3}>
      <Button
        disabled={isProposing}
        fontSize={1}
        onClick={handlePropose}
        text={isProposing ? 'Proposing…' : 'Propose ruling'}
        tone="primary"
      />

      {error ? (
        <Card border padding={3} radius={2} tone="critical">
          <Text size={1}>{error}</Text>
        </Card>
      ) : null}
    </Stack>
  )
}
