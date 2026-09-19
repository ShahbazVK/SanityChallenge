import {Suspense, memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject} from 'react'
import {
  type DocumentHandle,
  createDocument,
  createDocumentHandle,
  editDocument,
  publishDocument,
  useApplyDocumentActions,
  useDocumentProjection,
} from '@sanity/sdk-react'
import {Badge, Button, Card, Flex, Label, Select, Stack, Text, TextArea, TextInput} from '@sanity/ui'

type ReferenceValue = {
  _type: 'reference'
  _ref: string
}

type InstructionDraft = {
  resolution: string
  appliesToTopic: ReferenceValue
  basedOnClaim: ReferenceValue
  contradictsClaim: ReferenceValue
  decidedBy?: string
  decidedAt: string
}

type ResolveFormProps = {
  claims: DocumentHandle[]
  /**
   * The claim currently selected in the centre panel. Used only to *seed* the winner —
   * it is deliberately not a controlled value, so a manual dropdown choice keeps
   * winning until the user picks a different claim in the panel.
   */
  initialWinnerId: string | null
  topicId: string
  topicName: string | null
  onResolved: () => void
}

/**
 * The panel's selection when it is still part of this topic, otherwise the first
 * claim. Returns `''` for an empty list.
 */
function pickWinner(claims: DocumentHandle[], initialWinnerId: string | null): string {
  const fromPanel = claims.find((claim) => claim.documentId === initialWinnerId)?.documentId
  return fromPanel ?? claims[0]?.documentId ?? ''
}

/** The first claim that is not the winner, so the two selections can never collide. */
function pickLoser(claims: DocumentHandle[], winnerId: string): string {
  return claims.find((claim) => claim.documentId !== winnerId)?.documentId ?? ''
}

/**
 * Mirrors the text fields so `ResolveActions` can read the latest values at submit
 * time without receiving them as props (changing props would re-render it on every
 * keystroke, re-executing its document hooks).
 */
type ResolveDraft = {
  resolution: string
  decidedBy: string
}

type SubmitResolve = () => Promise<void>

type ResolveActionsProps = {
  topicId: string
  winnerId: string
  loserId: string
  draftRef: RefObject<ResolveDraft>
  onError: (message: string | null) => void
  onResolved: () => void
  onSavingChange: (isSaving: boolean) => void
  onSubmitReady: (submit: SubmitResolve | null) => void
}

// Module-level constants with stable identities for the lifetime of the module, so
// the SDK's option-identity memoization never sees a "changed" object on re-render.
const CLAIM_OPTION_PROJECTION = '{statement}'

/**
 * `memo` plus a memoized options object. Without both, every re-render of the form
 * handed `useDocumentProjection` a brand new object literal, which changed the
 * hook's `stateSource`/`subscribe` identities, churned the subscription and made the
 * SDK re-resolve the projection (and refetch the document) on every keystroke.
 */
const ClaimOption = memo(function ClaimOption({handle}: {handle: DocumentHandle}) {
  const options = useMemo(() => ({...handle, projection: CLAIM_OPTION_PROJECTION}), [handle])
  const {data} = useDocumentProjection<{statement: string | null}>(options)

  return <option value={handle.documentId}>{data.statement ?? handle.documentId}</option>
})

function OptionFallback() {
  return <option value="">Loading…</option>
}

/**
 * Owns the resolve write path. It is wrapped in `memo` and receives only stable props
 * — the typed resolution/decided-by values travel through `draftRef` — so a keystroke
 * re-renders the form shell without re-executing anything here.
 *
 * The whole decision goes out as one `useApplyDocumentActions` transaction, so there
 * is no `useEditDocument` (and no per-document suspense) anymore: this component
 * renders `null` and simply hands its `submit` function up to the shell.
 */
const ResolveActions = memo(function ResolveActions({
  topicId,
  winnerId,
  loserId,
  draftRef,
  onError,
  onResolved,
  onSavingChange,
  onSubmitReady,
}: ResolveActionsProps) {
  const apply = useApplyDocumentActions()

  const submit = useCallback(async () => {
    const {resolution, decidedBy} = draftRef.current

    if (!resolution.trim() || !winnerId || !loserId || winnerId === loserId) return

    onSavingChange(true)
    onError(null)

    // The instruction id is generated up front so the handle exists before the
    // transaction, and so the reference writes below can carry the PUBLISHED id.
    const instructionId = crypto.randomUUID()
    const instructionHandle = createDocumentHandle({
      documentId: instructionId,
      documentType: 'instruction',
    })

    const instruction: InstructionDraft = {
      resolution: resolution.trim(),
      appliesToTopic: {_type: 'reference', _ref: topicId},
      basedOnClaim: {_type: 'reference', _ref: winnerId},
      contradictsClaim: {_type: 'reference', _ref: loserId},
      ...(decidedBy.trim() ? {decidedBy: decidedBy.trim()} : {}),
      decidedAt: new Date().toISOString(),
    }

    const winnerHandle = createDocumentHandle({documentId: winnerId, documentType: 'claim'})
    const loserHandle = createDocumentHandle({documentId: loserId, documentType: 'claim'})

    try {
      // The entire decision as one atomic transaction. Order matters: the instruction
      // is created and published first so `instructionId` is a real published document
      // by the time the claims reference it, and each claim's edit precedes its publish
      // so the published copy carries the resolution instead of the stale draft.
      await apply([
        // `createDocument`'s `initialValue` is typed from the `groq` Typegen registry
        // (SanityDocument<TDocumentType, `${projectId}.${dataset}`>), which collapses to
        // `never` without generated types. The payload is still fully checked by its
        // `InstructionDraft` annotation above, so this assertion only bridges the SDK's
        // missing types rather than silencing a real check.
        createDocument(instructionHandle, instruction as never),
        publishDocument(instructionHandle),

        // The overruled claim was resolved by that instruction.
        editDocument(loserHandle, {
          set: {
            resolvedBy: {_type: 'reference', _ref: instructionId},
            status: 'resolved',
          },
        }),

        // The winning claim is no longer contested.
        editDocument(winnerHandle, {set: {status: 'resolved'}}),

        // Commit both claims to the published layer too, so the decision is not left
        // behind as a draft edit for anyone reading without the drafts perspective.
        publishDocument(loserHandle),
        publishDocument(winnerHandle),
      ])

      onResolved()
    } catch (caughtError) {
      onError(caughtError instanceof Error ? caughtError.message : 'Failed to resolve contradiction.')
    } finally {
      onSavingChange(false)
    }
  }, [apply, draftRef, loserId, onError, onResolved, onSavingChange, topicId, winnerId])

  // Hand the submit function up to the button in the shell.
  useEffect(() => {
    onSubmitReady(submit)
    return () => onSubmitReady(null)
  }, [onSubmitReady, submit])

  return null
})

/**
 * Holds every piece of drafted state (both dropdown selections plus the typed
 * resolution and "decided by"). This component calls no data hooks, so it never
 * suspends — a refresh of the claims list cannot remount it or lose user input.
 */
export function ResolveForm({claims, initialWinnerId, topicId, topicName, onResolved}: ResolveFormProps) {
  const [winnerId, setWinnerId] = useState(() => pickWinner(claims, initialWinnerId))
  const [loserId, setLoserId] = useState(() => pickLoser(claims, pickWinner(claims, initialWinnerId)))
  const [resolution, setResolution] = useState('')
  const [decidedBy, setDecidedBy] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isActionsReady, setIsActionsReady] = useState(false)

  // Mirror the typed values so `ResolveActions` can read the latest text at submit
  // time. Because they are not props, typing never re-renders it (and therefore never
  // re-executes its document hooks).
  const draftRef = useRef<ResolveDraft>({resolution: '', decidedBy: ''})
  const submitRef = useRef<SubmitResolve | null>(null)

  useEffect(() => {
    draftRef.current = {resolution, decidedBy}
  }, [resolution, decidedBy])

  // Remembers the panel selection we last synchronised to, so the dropdowns re-seed
  // only when the user actually picks a different claim (never on an ordinary
  // re-render or background refresh, which would clobber a manual override).
  const lastPanelSelectionRef = useRef(initialWinnerId)

  // Keep the winner on the panel selection, keep both ids valid for the current topic,
  // and guarantee the loser is never the same document as the winner.
  useEffect(() => {
    const ids = claims.map((claim) => claim.documentId)
    if (ids.length === 0) return

    const panelSelection = ids.includes(initialWinnerId ?? '') ? initialWinnerId : null
    const panelSelectionChanged = lastPanelSelectionRef.current !== initialWinnerId
    lastPanelSelectionRef.current = initialWinnerId

    let nextWinner = winnerId
    if (panelSelectionChanged && panelSelection) {
      nextWinner = panelSelection
    } else if (!ids.includes(winnerId)) {
      nextWinner = panelSelection ?? ids[0] ?? ''
    }

    const nextLoser =
      loserId !== nextWinner && ids.includes(loserId) ? loserId : (ids.find((id) => id !== nextWinner) ?? '')

    if (nextWinner !== winnerId) setWinnerId(nextWinner)
    if (nextLoser !== loserId) setLoserId(nextLoser)
  }, [claims, initialWinnerId, loserId, winnerId])

  const handleWinnerChange = useCallback(
    (nextWinnerId: string) => {
      setWinnerId(nextWinnerId)
      if (nextWinnerId === loserId) {
        setLoserId(claims.find((claim) => claim.documentId !== nextWinnerId)?.documentId ?? '')
      }
    },
    [claims, loserId],
  )

  const handleResolved = useCallback(() => {
    setResolution('')
    setDecidedBy('')
    onResolved()
  }, [onResolved])

  const handleSubmitReady = useCallback((submit: SubmitResolve | null) => {
    submitRef.current = submit
    setIsActionsReady(submit !== null)
  }, [])

  const handleSubmitClick = useCallback(() => {
    void submitRef.current?.()
  }, [])

  const isReadyToSubmit =
    Boolean(winnerId) &&
    Boolean(loserId) &&
    winnerId !== loserId &&
    resolution.trim().length > 0 &&
    !isSaving &&
    isActionsReady

  return (
    <Stack space={4}>
      <Flex align="center" justify="space-between">
        <Text muted size={1} weight="semibold">
          RESOLVE
        </Text>
        <Badge tone="primary">{topicName ?? 'Untitled topic'}</Badge>
      </Flex>

      <Card border padding={4} radius={2}>
        <Stack space={4}>
          <Stack space={2}>
            <Label as="label" htmlFor="winner-select">
              Which claim is correct?
            </Label>
            <Select
              id="winner-select"
              onChange={(event) => handleWinnerChange(event.currentTarget.value)}
              value={winnerId}
            >
              <Suspense fallback={<OptionFallback />}>
                {claims.map((handle) => (
                  <ClaimOption handle={handle} key={handle.documentId} />
                ))}
              </Suspense>
            </Select>
          </Stack>

          <Stack space={2}>
            <Label as="label" htmlFor="loser-select">
              Which claim is overruled?
            </Label>
            <Select
              id="loser-select"
              onChange={(event) => setLoserId(event.currentTarget.value)}
              value={loserId}
            >
              <Suspense fallback={<OptionFallback />}>
                {claims
                  .filter((handle) => handle.documentId !== winnerId)
                  .map((handle) => (
                    <ClaimOption handle={handle} key={handle.documentId} />
                  ))}
              </Suspense>
            </Select>
          </Stack>

          <Stack space={2}>
            <Label as="label" htmlFor="resolution-input">
              Resolution
            </Label>
            <TextArea
              id="resolution-input"
              onChange={(event) => setResolution(event.currentTarget.value)}
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
              onChange={(event) => setDecidedBy(event.currentTarget.value)}
              placeholder="e.g. Priya Raman"
              value={decidedBy}
            />
          </Stack>

          {/* Renders nothing: it only builds the write path and hands `submit` up via
              `onSubmitReady`. Nothing inside suspends now, so this boundary is purely a
              safety net in case the SDK's apply hook ever starts suspending. */}
          <Suspense fallback={null}>
            <ResolveActions
              draftRef={draftRef}
              loserId={loserId}
              onError={setError}
              onResolved={handleResolved}
              onSavingChange={setIsSaving}
              onSubmitReady={handleSubmitReady}
              topicId={topicId}
              winnerId={winnerId}
            />
          </Suspense>

          <Button
            disabled={!isReadyToSubmit}
            onClick={handleSubmitClick}
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
