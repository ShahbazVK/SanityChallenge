import {Suspense, useCallback, useEffect, useMemo, useRef, useState, type RefObject} from 'react'
import {
  createDocument,
  createDocumentHandle,
  editDocument,
  publishDocument,
  useApplyDocumentActions,
} from '@sanity/sdk-react'
import {Badge, Button, Card, Flex, Label, Select, Stack, Text, TextArea, TextInput} from '@sanity/ui'

import type {Actor, CaseDetail, PrecedentCitation, RulingPayload} from '../types'
import {ClaimCard, PrecedentList, formatDate} from './ClaimsList'

/**
 * The human's side of a case, for all three states a human can act on:
 *
 *   `detected` - rule from scratch (no agent proposal exists)
 *   `proposed` - approve the agent's proposal, or override it
 *   anything else - already decided, so there is nothing to do
 *
 * Every path funnels through ONE write function, `writeRuling`, so the instruction, the
 * legacy claim sync and the caseEvent are always written as one atomic transaction. A
 * ruling that stored its instruction but not its event would be invisible to the derived
 * stage, which is the one failure this whole design exists to prevent.
 */

/**
 * A UX floor, not a schema rule: the schema puts no minimum on a ruling's text, but an
 * override with no explanation is exactly the unaccountable decision this app is about.
 */
const MIN_OVERRIDE_REASON = 20

const refTo = (_ref: string) => ({_type: 'reference' as const, _ref})

/**
 * Text the human has typed, mirrored so the write path can read the latest values at
 * submit time. Both panels share one shape because only ever one of them renders.
 */
type RulingDraft = {
  /** `detected` path: the ruling text. */
  resolution: string
  /** `detected` path: free-text attribution. */
  decidedBy: string
  /** `override` path: a value to establish instead of upholding a claim. */
  outcomeValue: string
  /** `override` path: why the human departed from - or re-endorsed - the proposal. */
  reason: string
}

const emptyDraft = (): RulingDraft => ({
  resolution: '',
  decidedBy: '',
  outcomeValue: '',
  reason: '',
})

/**
 * A fully-resolved ruling.
 *
 * "Exactly one of `winnerId` / `outcomeValue`" is an invariant of this type, held by the
 * builders below rather than by the schema: the schema's rule for it is only a
 * `.warning()` during the expand window, so it would not stop a bad write.
 */
type RulingDecision = {
  winnerId: string | null
  outcomeValue: string | null
  overruledIds: string[]
  resolution: string
  decidedBy?: string
  precedents: PrecedentCitation[]
  from: 'detected' | 'proposed'
  payload: RulingPayload
}

type RulingActionsHandle = {
  resolveDetected: () => Promise<void>
  approveProposal: () => Promise<void>
  submitOverride: () => Promise<void>
}

/** Drops incomplete citations rather than writing a reference the precedent schema rejects. */
function toWritablePrecedents(citations: PrecedentCitation[]) {
  return citations
    .filter((citation) => Boolean(citation.instructionId) && Boolean(citation.relation))
    .map((citation, index) => ({
      _type: 'precedent',
      _key: `prec-${index}`,
      instruction: refTo(citation.instructionId as string),
      relation: citation.relation,
    }))
}

/**
 * Either a ruling ready to write, or the reason it cannot be built.
 *
 * These three builders are pure and module-level so the decision rules can be exercised
 * directly: `winner XOR outcomeValue`, which claims get overruled, and whether the human
 * endorsed the agent. The schema's rule for the XOR is only a `.warning()`, so nothing else
 * would catch a mistake here.
 */
type DecisionResult = {decision: RulingDecision; error: null} | {decision: null; error: string}

/**
 * `detected`: rule from scratch. The resolution text is the human's, because there is no
 * proposal to endorse, and no precedent chain is carried.
 */
function buildDetectedDecision({
  claimIds,
  draft,
  selectedClaimId,
}: {
  claimIds: string[]
  draft: RulingDraft
  selectedClaimId: string
}): DecisionResult {
  if (!draft.resolution.trim() || !selectedClaimId) {
    return {decision: null, error: 'Choose the correct claim and write a resolution.'}
  }

  return {
    decision: {
      winnerId: selectedClaimId,
      outcomeValue: null,
      overruledIds: claimIds.filter((claimId) => claimId !== selectedClaimId),
      resolution: draft.resolution,
      decidedBy: draft.decidedBy,
      precedents: [],
      from: 'detected',
      payload: {
        humanOutcomeId: selectedClaimId,
        note: 'Resolved directly from detected; no agent proposal existed for this case.',
      },
    },
    error: null,
  }
}

/**
 * Approve: the proposal becomes the ruling verbatim. Its rationale is the resolution text
 * and its precedent chain becomes the ruling's chain, because endorsing an outcome is also
 * endorsing the reasoning that produced it.
 */
function buildApproveDecision({
  agentOutcomeId,
  agentPrecedents,
  agentRationale,
  claimIds,
}: {
  agentOutcomeId: string | null
  agentPrecedents: PrecedentCitation[]
  agentRationale: string | null
  claimIds: string[]
}): DecisionResult {
  if (!agentOutcomeId || !agentRationale) {
    return {decision: null, error: 'This case has no proposal to approve.'}
  }

  return {
    decision: {
      winnerId: agentOutcomeId,
      outcomeValue: null,
      overruledIds: claimIds.filter((claimId) => claimId !== agentOutcomeId),
      resolution: agentRationale,
      precedents: agentPrecedents,
      from: 'proposed',
      payload: {approvedProposal: true},
    },
    error: null,
  }
}

/**
 * Override: the human authors the ruling instead of endorsing the agent's.
 *
 * The three rules, in one place:
 *
 *  - A filled value field replaces the claim pick, and then EVERY claim is overruled,
 *    because the ruling matches none of them. (The seeded
 *    `instruction-cancellation-notice-1` has exactly that shape: no winner, `outcomeValue`
 *    set, both claims overruled.)
 *  - The agent's precedent chain carries forward ONLY when the human landed on the same
 *    outcome. Otherwise the ruling cites nothing, because recording the agent's citations
 *    as the human's reliance would fabricate a chain they never used.
 *  - `resolution` is the human's REASON, not the agent's rationale. Nothing is lost:
 *    `case.proposal.rationale` stays on the case document, frozen, so the eval can still
 *    compare what the agent argued against what the human decided.
 */
function buildOverrideDecision({
  agentOutcomeId,
  agentPrecedents,
  claimIds,
  draft,
  selectedClaimId,
}: {
  agentOutcomeId: string | null
  agentPrecedents: PrecedentCitation[]
  claimIds: string[]
  draft: RulingDraft
  selectedClaimId: string
}): DecisionResult {
  const reason = draft.reason.trim()
  const establishedValue = draft.outcomeValue.trim()

  if (reason.length < MIN_OVERRIDE_REASON) {
    return {
      decision: null,
      error: `Explain the override in at least ${MIN_OVERRIDE_REASON} characters.`,
    }
  }

  const winnerId = establishedValue ? null : selectedClaimId || null
  if (!winnerId && !establishedValue) {
    return {decision: null, error: 'Uphold a claim or state the value to establish.'}
  }

  const approvedProposal = Boolean(winnerId && agentOutcomeId && winnerId === agentOutcomeId)

  return {
    decision: {
      winnerId,
      outcomeValue: establishedValue || null,
      overruledIds: winnerId ? claimIds.filter((claimId) => claimId !== winnerId) : [...claimIds],
      resolution: reason,
      precedents: approvedProposal ? agentPrecedents : [],
      from: 'proposed',
      payload: approvedProposal
        ? // Same outcome: the human endorsed the agent's pick, and said why.
          {approvedProposal: true, note: reason}
        : {
            approvedProposal: false,
            // The value-only case has no human claim id to record, because the human ruled
            // beyond the claims. The established value lives on the instruction, which is
            // the only field that can hold it.
            agentOutcomeId: agentOutcomeId ?? null,
            humanOutcomeId: winnerId,
            note: reason,
          },
    },
    error: null,
  }
}

/**
 * The one place that writes a ruling, shared by all three paths.
 *
 * It holds no data hook beyond `useApplyDocumentActions` and takes only primitives, arrays
 * and refs, so a suspension elsewhere cannot remount it mid-decision. The panels keep their
 * typed text in refs for the same reason.
 */
function RulingActions({
  actor,
  agentOutcomeId,
  agentPrecedents,
  agentRationale,
  caseId,
  claimIds,
  draftRef,
  onActionsReady,
  onError,
  onRuled,
  onSavingChange,
  selectedClaimId,
  topicRef,
}: {
  actor: Actor
  agentOutcomeId: string | null
  agentPrecedents: PrecedentCitation[]
  agentRationale: string | null
  caseId: string
  claimIds: string[]
  draftRef: RefObject<RulingDraft>
  onActionsReady: (handle: RulingActionsHandle | null) => void
  onError: (message: string | null) => void
  onRuled: () => void
  onSavingChange: (isSaving: boolean) => void
  selectedClaimId: string
  topicRef: string
}) {
  const apply = useApplyDocumentActions()

  const writeRuling = useCallback(
    async (decision: RulingDecision) => {
      onSavingChange(true)
      onError(null)

      // Generated up front so the overruled claims can point their legacy `resolvedBy` at
      // the instruction inside the same batch.
      const instructionId = crypto.randomUUID()
      const instructionHandle = createDocumentHandle({
        documentId: instructionId,
        documentType: 'instruction',
      })
      const eventHandle = createDocumentHandle({
        documentId: crypto.randomUUID(),
        documentType: 'caseEvent',
      })

      const now = new Date().toISOString()
      const decidedBy = decision.decidedBy?.trim() || actor.label || undefined

      const winnerHandle = decision.winnerId
        ? createDocumentHandle({documentId: decision.winnerId, documentType: 'claim'})
        : null
      const overruledHandles = decision.overruledIds.map((claimId) =>
        createDocumentHandle({documentId: claimId, documentType: 'claim'}),
      )

      const instruction = {
        resolution: decision.resolution.trim(),
        appliesToTopic: refTo(topicRef),
        case: refTo(caseId),
        // Exactly one of these two is present - see `RulingDecision`.
        ...(decision.winnerId ? {winner: refTo(decision.winnerId)} : {}),
        ...(decision.outcomeValue ? {outcomeValue: decision.outcomeValue} : {}),
        overruled: decision.overruledIds.map((claimId) => ({...refTo(claimId), _key: claimId})),
        precedents: toWritablePrecedents(decision.precedents),
        // --- expand-window legacy projection ---------------------------------------
        // The deployed v1 app reads these. `basedOnClaim` is `required()` there, but a
        // ruling that establishes a value has no claim to derive it from - the seeded
        // `instruction-cancellation-notice-1` leaves it unset for exactly that reason, so
        // this matches the canonical shape rather than inventing one.
        ...(decision.winnerId ? {basedOnClaim: refTo(decision.winnerId)} : {}),
        decidedAt: now,
        ...(decidedBy ? {decidedBy} : {}),
        ...(decision.overruledIds[0]
          ? {contradictsClaim: refTo(decision.overruledIds[0])}
          : {}),
      }

      const caseEvent = {
        case: refTo(caseId),
        from: decision.from,
        to: 'ruled',
        actor: {
          kind: 'human',
          ...(actor.id ? {id: actor.id} : {}),
          ...(decidedBy ? {label: decidedBy} : {}),
        },
        at: now,
        payload: decision.payload,
      }

      try {
        // ONE transaction: `apply` sends a batch as a single transaction, so a failure
        // leaves no half-recorded ruling behind. Order matters - the instruction is created
        // and published first so `instructionId` is a real published document by the time
        // the claims reference it, and each claim's edit precedes its own publish so the
        // published copy carries the resolution rather than the stale draft.
        await apply([
          createDocument(instructionHandle, instruction as never),
          publishDocument(instructionHandle),

          // --- expand-window legacy claim sync ---------------------------------------
          // The deployed v1 app asks whether a claim is still open with
          // `status == "unresolved"`, so a claim left untouched here keeps showing as an
          // open conflict over there. `resolvedBy` means "overruled by", so the winner
          // deliberately does NOT get one.
          ...(winnerHandle ? [editDocument(winnerHandle, {set: {status: 'resolved'}})] : []),
          ...overruledHandles.map((handle) =>
            editDocument(handle, {
              set: {status: 'resolved', resolvedBy: refTo(instructionId)},
            }),
          ),
          ...(winnerHandle ? [publishDocument(winnerHandle)] : []),
          ...overruledHandles.map((handle) => publishDocument(handle)),

          createDocument(eventHandle, caseEvent as never),
          publishDocument(eventHandle),
        ])
        onRuled()
      } catch (caught) {
        onError(caught instanceof Error ? caught.message : 'Failed to record the ruling.')
      } finally {
        onSavingChange(false)
      }
    },
    [actor.id, actor.label, apply, caseId, onError, onRuled, onSavingChange, topicRef],
  )

  /** `detected`: rule from scratch. See `buildDetectedDecision` for the rules. */
  const resolveDetected = useCallback(async () => {
    const result = buildDetectedDecision({claimIds, draft: draftRef.current, selectedClaimId})
    if (!result.decision) {
      onError(result.error)
      return
    }

    await writeRuling(result.decision)
  }, [claimIds, draftRef, onError, selectedClaimId, writeRuling])

  /** Approve: endorse the proposal verbatim. See `buildApproveDecision`. */
  const approveProposal = useCallback(async () => {
    const result = buildApproveDecision({
      agentOutcomeId,
      agentPrecedents,
      agentRationale,
      claimIds,
    })
    if (!result.decision) {
      onError(result.error)
      return
    }

    await writeRuling(result.decision)
  }, [agentOutcomeId, agentPrecedents, agentRationale, claimIds, onError, writeRuling])

  /** Override: the human authors the ruling. See `buildOverrideDecision` for the rules. */
  const submitOverride = useCallback(async () => {
    const result = buildOverrideDecision({
      agentOutcomeId,
      agentPrecedents,
      claimIds,
      draft: draftRef.current,
      selectedClaimId,
    })
    if (!result.decision) {
      onError(result.error)
      return
    }

    await writeRuling(result.decision)
  }, [agentOutcomeId, agentPrecedents, claimIds, draftRef, onError, selectedClaimId, writeRuling])

  useEffect(() => {
    onActionsReady({resolveDetected, approveProposal, submitOverride})
    return () => onActionsReady(null)
  }, [approveProposal, onActionsReady, resolveDetected, submitOverride])

  return null
}

/** Stable identity, so passing "no precedents" never churns a callback dependency. */
const NO_PRECEDENTS: PrecedentCitation[] = []

/**
 * Shared wiring for the two panels: the ref that receives the write path's handles, the
 * draft the text inputs mirror into, and the saving/error state.
 *
 * It holds only `useRef`/`useState`/`useCallback` - no data hooks - so a panel that uses it
 * still never suspends, and typed text cannot be lost to a remount.
 */
function useRulingActions() {
  const draftRef = useRef<RulingDraft>(emptyDraft())
  const actionsRef = useRef<RulingActionsHandle | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleActionsReady = useCallback((handle: RulingActionsHandle | null) => {
    actionsRef.current = handle
  }, [])

  /** Called when the selected case changes, so a draft never leaks across cases. */
  const reset = useCallback(() => {
    draftRef.current = emptyDraft()
    setError(null)
  }, [])

  return {actionsRef, draftRef, error, handleActionsReady, isSaving, reset, setError, setIsSaving}
}

/**
 * Dispatches on the DERIVED stage, because the stage is what decides which decision the
 * human is being asked for. There is no mode to set and nothing to keep in sync.
 */
export function ResolveForm({
  detail,
  actor,
  onResolved,
}: {
  detail: CaseDetail
  actor: Actor
  onResolved: () => void
}) {
  if (detail.stage === 'proposed') {
    return <ApproveOverridePanel actor={actor} detail={detail} onResolved={onResolved} />
  }

  if (detail.stage === 'detected') {
    return <DetectedResolvePanel actor={actor} detail={detail} onResolved={onResolved} />
  }

  return (
    <Stack space={4}>
      <Text size={1} weight="semibold" muted>
        RESOLVE
      </Text>
      <Card border padding={4} radius={2} tone="positive">
        <Stack space={3}>
          <Badge tone="positive">{detail.stage === 'superseded' ? 'Superseded' : 'Ruled'}</Badge>
          <Text size={1}>
            {detail.ruling?.resolution ??
              'This case was closed without a ruling, or has already been ruled on.'}
          </Text>
        </Stack>
      </Card>
    </Stack>
  )
}

/**
 * `detected`: no proposal exists, so the human rules from scratch.
 *
 * Unchanged in substance from the Phase 3 form - it now shares its write path with the
 * approve/override panel instead of owning one.
 */
function DetectedResolvePanel({
  detail,
  actor,
  onResolved,
}: {
  detail: CaseDetail
  actor: Actor
  onResolved: () => void
}) {
  const claimIds = useMemo(() => detail.claims.map((claim) => claim._id), [detail.claims])
  const [winnerId, setWinnerId] = useState(() => claimIds[0] ?? '')
  const [resolution, setResolution] = useState('')
  const [decidedBy, setDecidedBy] = useState('')
  const {
    actionsRef,
    draftRef,
    error,
    handleActionsReady,
    isSaving,
    reset,
    setError,
    setIsSaving,
  } = useRulingActions()

  // Selecting a different case must not carry the previous draft over.
  useEffect(() => {
    setWinnerId(claimIds[0] ?? '')
    setResolution('')
    setDecidedBy('')
    reset()
  }, [claimIds, detail._id, reset])

  const handleSubmit = useCallback(() => {
    void actionsRef.current?.resolveDetected()
  }, [actionsRef])

  const isReadyToSubmit =
    Boolean(detail.topicRef) && Boolean(winnerId) && resolution.trim().length > 0 && !isSaving

  return (
    <Stack space={4}>
      <Flex align="center" gap={2} wrap="wrap">
        <Text size={1} weight="semibold" muted>
          RESOLVE
        </Text>
        <Badge tone="primary">{detail.topicName ?? 'Untitled topic'}</Badge>
      </Flex>

      <Card border padding={4} radius={2}>
        <Stack space={4}>
          <Stack space={2}>
            <Label as="label" htmlFor="winner-select">
              Which claim is correct?
            </Label>
            <Select
              id="winner-select"
              onChange={(event) => setWinnerId(event.currentTarget.value)}
              value={winnerId}
            >
              {detail.claims.map((claim) => (
                <option key={claim._id} value={claim._id}>
                  {claim.statement ?? claim._id}
                </option>
              ))}
            </Select>
          </Stack>

          <Stack space={2}>
            <Label as="label" htmlFor="resolution-input">
              Resolution
            </Label>
            <TextArea
              id="resolution-input"
              onChange={(event) => {
                const value = event.currentTarget.value
                setResolution(value)
                draftRef.current.resolution = value
              }}
              placeholder="e.g. The 30-day refund window in the internal policy governs; the public FAQ is out of date."
              rows={5}
              value={resolution}
            />
          </Stack>

          <Stack space={2}>
            <Label as="label" htmlFor="decided-by-input">
              Decided by (optional)
            </Label>
            <TextInput
              id="decided-by-input"
              onChange={(event) => {
                const value = event.currentTarget.value
                setDecidedBy(value)
                draftRef.current.decidedBy = value
              }}
              placeholder={actor.label ?? 'e.g. Priya Raman'}
              value={decidedBy}
            />
          </Stack>

          {/* Renders nothing: it only builds the write path and hands its handles up. Kept
              in its own component inside a boundary so a suspension here can never remount
              the inputs and lose what was typed. */}
          <Suspense fallback={null}>
            <RulingActions
              actor={actor}
              agentOutcomeId={null}
              agentPrecedents={NO_PRECEDENTS}
              agentRationale={null}
              caseId={detail._id}
              claimIds={claimIds}
              draftRef={draftRef}
              onActionsReady={handleActionsReady}
              onError={setError}
              onRuled={onResolved}
              onSavingChange={setIsSaving}
              selectedClaimId={winnerId}
              topicRef={detail.topicRef ?? ''}
            />
          </Suspense>

          <Button
            disabled={!isReadyToSubmit}
            onClick={handleSubmit}
            text={isSaving ? 'Resolving…' : 'Resolve Contradiction'}
            tone="primary"
          />

          {error ? (
            <Card border padding={3} radius={2} tone="critical">
              <Text size={1}>{error}</Text>
            </Card>
          ) : null}
        </Stack>
      </Card>
    </Stack>
  )
}

/**
 * `proposed`: the human either endorses the agent's ruling or authors their own.
 *
 * This panel is the DECISION surface; the centre panel remains the EVIDENCE surface. The
 * proposal is summarised here on purpose - what you are about to approve has to sit next
 * to the button that approves it - even though the centre panel shows the same reasoning
 * in more detail.
 */
function ApproveOverridePanel({
  detail,
  actor,
  onResolved,
}: {
  detail: CaseDetail
  actor: Actor
  onResolved: () => void
}) {
  const proposal = detail.proposal
  const claimIds = useMemo(() => detail.claims.map((claim) => claim._id), [detail.claims])
  const agentOutcomeId = proposal?.outcome?._id ?? null

  const [isOverriding, setIsOverriding] = useState(false)
  const [claimId, setClaimId] = useState(() => agentOutcomeId ?? claimIds[0] ?? '')
  const [outcomeValue, setOutcomeValue] = useState('')
  const [reason, setReason] = useState('')
  const {
    actionsRef,
    draftRef,
    error,
    handleActionsReady,
    isSaving,
    reset,
    setError,
    setIsSaving,
  } = useRulingActions()

  // A different case gets a clean slate - a draft must never leak across cases.
  useEffect(() => {
    setClaimId(agentOutcomeId ?? claimIds[0] ?? '')
    setIsOverriding(false)
    setOutcomeValue('')
    setReason('')
    reset()
  }, [agentOutcomeId, claimIds, detail._id, reset])

  const handleApprove = useCallback(() => {
    void actionsRef.current?.approveProposal()
  }, [actionsRef])

  const handleSubmitOverride = useCallback(() => {
    void actionsRef.current?.submitOverride()
  }, [actionsRef])

  const handleCancelOverride = useCallback(() => setIsOverriding(false), [])

  // A filled value field replaces the claim pick, so "one of winner / outcomeValue" is
  // satisfied by construction rather than by a check that could disagree with the write.
  const establishedValue = outcomeValue.trim()
  const isOverrideReady =
    reason.trim().length >= MIN_OVERRIDE_REASON &&
    Boolean(establishedValue || claimId) &&
    !isSaving

  if (!proposal) {
    return (
      <Stack space={4}>
        <Text size={1} weight="semibold" muted>
          RESOLVE
        </Text>
        <Card border padding={4} radius={2} tone="caution">
          <Stack space={3}>
            <Badge tone="caution">Awaiting your ruling</Badge>
            <Text size={1}>
              This case is at stage “proposed” but carries no proposal, so there is nothing to
              approve. Re-run the seed or the agent script to restore it.
            </Text>
          </Stack>
        </Card>
      </Stack>
    )
  }

  return (
    <Stack space={4}>
      <Flex align="center" gap={2} wrap="wrap">
        <Text size={1} weight="semibold" muted>
          RESOLVE
        </Text>
        <Badge tone="caution">Awaiting your ruling</Badge>
      </Flex>

      <Card border padding={4} radius={2} tone="caution">
        <Stack space={4}>
          <Flex align="center" gap={2} justify="space-between" wrap="wrap">
            <Text size={1} weight="semibold">
              Agent proposal
            </Text>
            <Flex align="center" gap={2} wrap="wrap">
              {typeof proposal.confidence === 'number' ? (
                <Badge tone={proposal.confidence >= 0.75 ? 'positive' : 'caution'}>
                  confidence {proposal.confidence}
                </Badge>
              ) : null}
              <Text muted size={0}>
                {proposal.model ?? 'unknown model'} · {formatDate(proposal.proposedAt)}
              </Text>
            </Flex>
          </Flex>

          {/* The same card the centre panel uses, so an approved outcome and a merely
              proposed one are rendered by identical code. */}
          {proposal.outcome ? <ClaimCard claim={proposal.outcome} role="proposed" /> : null}

          <Stack space={2}>
            <Text size={0} weight="semibold" muted>
              RATIONALE
            </Text>
            <Text size={1}>{proposal.rationale ?? 'No rationale recorded'}</Text>
          </Stack>

          <Stack space={2}>
            <Text size={0} weight="semibold" muted>
              PRECEDENTS CITED
            </Text>
            <PrecedentList precedents={proposal.precedents} />
          </Stack>
        </Stack>
      </Card>

      {isOverriding ? (
        <Card border padding={4} radius={2}>
          <Stack space={4}>
            <Text size={1} weight="semibold">
              Override the agent
            </Text>

            <Stack space={2}>
              <Label as="label" htmlFor="override-claim-select">
                Which claim should be correct?
              </Label>
              <Select
                disabled={Boolean(establishedValue)}
                id="override-claim-select"
                onChange={(event) => setClaimId(event.currentTarget.value)}
                value={claimId}
              >
                {detail.claims.map((claim) => (
                  <option key={claim._id} value={claim._id}>
                    {claim.statement ?? claim._id}
                  </option>
                ))}
              </Select>
              {establishedValue ? (
                <Text size={0} muted>
                  A value below overrules every claim, so no claim is upheld.
                </Text>
              ) : null}
            </Stack>

            <Stack space={2}>
              <Label as="label" htmlFor="override-value-input">
                What value should be established? (optional)
              </Label>
              <TextInput
                id="override-value-input"
                onChange={(event) => {
                  const value = event.currentTarget.value
                  setOutcomeValue(value)
                  draftRef.current.outcomeValue = value
                }}
                placeholder="e.g. 45 days"
                value={outcomeValue}
              />
              <Text size={0} muted>
                Leave empty to uphold the claim above. Fill it in to establish a value no claim
                asserts: that overrules every claim.
              </Text>
            </Stack>

            <Stack space={2}>
              <Label as="label" htmlFor="override-reason-input">
                Why are you overriding the agent?
              </Label>
              <TextArea
                id="override-reason-input"
                onChange={(event) => {
                  const value = event.currentTarget.value
                  setReason(value)
                  draftRef.current.reason = value
                }}
                placeholder="e.g. The Support Docs page was rewritten last month and now contradicts the FAQ; the FAQ figure is the one we actually honour."
                rows={4}
                value={reason}
              />
              <Text size={0} muted>
                {reason.trim().length < MIN_OVERRIDE_REASON
                  ? `${reason.trim().length} of ${MIN_OVERRIDE_REASON} characters minimum`
                  : `${reason.trim().length} characters`}
              </Text>
            </Stack>

            <Flex gap={2} wrap="wrap">
              <Button
                disabled={!isOverrideReady}
                onClick={handleSubmitOverride}
                text={isSaving ? 'Recording…' : 'Submit Override'}
                tone="primary"
              />
              <Button disabled={isSaving} mode="ghost" onClick={handleCancelOverride} text="Cancel" />
            </Flex>
          </Stack>
        </Card>
      ) : (
        <Flex gap={3} wrap="wrap">
          <Button
            disabled={isSaving}
            fontSize={2}
            onClick={handleApprove}
            padding={4}
            text={isSaving ? 'Recording…' : 'Approve'}
            tone="primary"
          />
          <Button
            disabled={isSaving}
            fontSize={2}
            mode="ghost"
            onClick={() => setIsOverriding(true)}
            padding={4}
            text="Override"
          />
        </Flex>
      )}

      {error ? (
        <Card border padding={3} radius={2} tone="critical">
          <Text size={1}>{error}</Text>
        </Card>
      ) : null}

      {/* Renders nothing: it owns the write path for all three decision types. */}
      <Suspense fallback={null}>
        <RulingActions
          actor={actor}
          agentOutcomeId={agentOutcomeId}
          agentPrecedents={proposal.precedents ?? NO_PRECEDENTS}
          agentRationale={proposal.rationale}
          caseId={detail._id}
          claimIds={claimIds}
          draftRef={draftRef}
          onActionsReady={handleActionsReady}
          onError={setError}
          onRuled={onResolved}
          onSavingChange={setIsSaving}
          selectedClaimId={claimId}
          topicRef={detail.topicRef ?? ''}
        />
      </Suspense>
    </Stack>
  )
}

// The decision builders are exported so a harness can exercise the override rules directly:
// `winner XOR outcomeValue`, which claims get overruled, and whether the human endorsed the
// agent. None of them touches React, the network or the dataset.
export {buildApproveDecision, buildDetectedDecision, buildOverrideDecision}
