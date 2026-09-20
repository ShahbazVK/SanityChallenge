import {useCallback, useMemo, useState} from 'react'
import {
  createDocument,
  createDocumentHandle,
  publishDocument,
  useApplyDocumentActions,
} from '@sanity/sdk-react'
import {
  Badge,
  Button,
  Card,
  Dialog,
  Flex,
  Label,
  LayerProvider,
  Select,
  Stack,
  Text,
  TextArea,
  TextInput,
} from '@sanity/ui'

import type {TriageCase} from '../types'

/**
 * Intake: create a source AND the claims already extracted from it, then detect whether
 * those claims conflict with what the dataset already says.
 *
 * WHY THE CLAIMS ARE BUNDLED, NOT EXTRACTED HERE. The real extractor is
 * `scripts/extract.mjs`, and it cannot run in a browser: it needs `process.env.LLM_API_KEY`
 * and an outbound call to a provider that refuses browser origins (CORS). Shipping the key
 * to the client to work around that would publish it. So each bundled sample carries the
 * output the extractor produced for its prose, and this dialog writes that output as if the
 * extraction had just run. The pipeline stays demonstrable from the UI without a secret in
 * the bundle.
 *
 * The PROPOSER is different and is NOT pre-computed: `scripts/lib/propose.mjs` is pure and
 * runs in the browser (see `ProposeActions.tsx`).
 */

/**
 * The two lookups this dialog needs.
 *
 * They are declared HERE rather than in `src/queries.ts` - the app's single query module,
 * per its own module comment - only because that file is out of scope for this change. Move
 * them there when it is next touched.
 *
 * `TOPICS_OPTIONS` from `queries.ts` cannot be reused: it projects `{_id, name}` and the
 * samples are keyed by topic SLUG. A slug is what the extractor emits, deliberately, so a
 * model never has to invent a document id; resolving slug → `_id` is this dialog's job.
 */
export const INTAKE_TOPICS_QUERY = `*[_type == "topic"] {
  _id,
  name,
  "slug": slug.current
} | order(name asc)`

/** Stable module-level identity: the SDK hashes this object into its query key. */
export const INTAKE_TOPICS_OPTIONS = {query: INTAKE_TOPICS_QUERY}

/**
 * Every OPEN claim, shaped for conflict detection.
 *
 * The predicate mirrors `scripts/detect.mjs` exactly, and both clauses are load-bearing:
 * `status == "unresolved"`, because a ruled topic's claims are `resolved` and re-flagging
 * them would reopen questions that are already answered; and the drafts exclusion, because
 * an unpublished draft and its published original would otherwise be counted twice.
 */
export const UNRESOLVED_CLAIMS_QUERY = `*[_type == "claim"
    && status == "unresolved"
    && !(_id in path("drafts.**"))
  ] {
    _id,
    value,
    statement,
    "topicRef": topic._ref,
    "topicName": topic->name,
    "topicSlug": topic->slug.current
  } | order(_id asc)`

/** Stable module-level identity: the SDK hashes this object into its query key. */
export const UNRESOLVED_CLAIMS_OPTIONS = {query: UNRESOLVED_CLAIMS_QUERY}

/** A topic as the slug resolver needs it. Wider than `TopicOption` in `src/types.ts`. */
export type TopicChoice = {
  _id: string
  name: string | null
  slug: string | null
}

/** One open claim, as `UNRESOLVED_CLAIMS_QUERY` returns it. */
export type UnresolvedClaimRow = {
  _id: string
  value: string | null
  statement: string | null
  topicRef: string | null
  topicName: string | null
  topicSlug: string | null
}

/** One claim as a sample carries it: the extractor's output shape, no document ids yet. */
type SampleClaim = {
  statement: string
  value: string
  topicSlug: string
  confidence: number
}

type ReferenceValue = {_type: 'reference'; _ref: string}

/**
 * The three bundled samples: prose plus the claims the extractor produced from it.
 *
 * `topicSlug` rather than a topic id, and `value` already NORMALIZED ("45 days", "8 USD"),
 * because that is the extractor's own output shape - see `PROMPT_TEMPLATE` in
 * `scripts/extract.mjs`, where rule 2 is what makes two claims comparable at all.
 *
 * A claim whose slug no longer resolves to a topic is dropped with a visible warning rather
 * than written against a dangling reference, mirroring the extractor's defensive validation.
 *
 * MEASURED EFFECT PER SAMPLE, by running the shipped detector (`scripts/detect.mjs`) over the
 * live dataset plus each sample's claims. Confirmed, not assumed:
 *   Refund Policy v2  → refund-window {14, 30, 45 days} and shipping-cost {5, 7, 8 USD} are
 *                       both new values → case-refund-window-2 AND case-shipping-cost-2
 *   Support Runbook   → shipping-cost gains "6 USD" → case-shipping-cost-2. Its "5 days"
 *                       refund claim AGREES with the FAQ's 5 days, so
 *                       case-refund-processing-time-1 still covers that topic
 *   Legal Update 2026 → data-retention gains "3 years" → case-data-retention-2. Its
 *                       price-match ("60 days") and account-deletion ("90 days") claims open
 *                       NOTHING: both topics have no open claim at all, because every claim
 *                       on them was resolved by an earlier ruling, and one claim alone cannot
 *                       disagree with itself
 */
const SAMPLES = [
  {
    name: 'Refund Policy v2',
    source: {
      title: 'Refund Policy v2',
      sourceType: 'internal',
      content:
        'Customers may request a refund within 45 days of purchase. ' +
        'Refunds are issued to the original payment method. ' +
        'Standard shipping is charged at 8 USD per order. ' +
        'All products are covered by a 2 year warranty.',
    },
    claims: [
      {
        statement: 'Customers may request a refund within 45 days of purchase.',
        value: '45 days',
        topicSlug: 'refund-window',
        confidence: 0.95,
      },
      {
        statement: 'Refunds are issued to the original payment method.',
        value: 'Original payment method',
        topicSlug: 'refund-method',
        confidence: 0.95,
      },
      {
        statement: 'Standard shipping is charged at 8 USD per order.',
        value: '8 USD',
        topicSlug: 'shipping-cost',
        confidence: 0.95,
      },
      {
        statement: 'All products are covered by a 2 year warranty.',
        value: '2 years',
        topicSlug: 'warranty-period',
        confidence: 0.95,
      },
    ],
  },
  {
    name: 'Support Runbook',
    source: {
      title: 'Support Runbook',
      sourceType: 'internal',
      content:
        'Refunds are processed within 5 days. ' +
        'Free trials last 14 days. ' +
        'Standard shipping is a flat 6 USD per order. ' +
        'Account deletion takes effect 90 days after the request.',
    },
    claims: [
      {
        statement: 'Refunds are processed within 5 days.',
        value: '5 days',
        topicSlug: 'refund-processing-time',
        confidence: 0.95,
      },
      {
        statement: 'Free trials last 14 days.',
        value: '14 days',
        topicSlug: 'trial-period',
        confidence: 0.95,
      },
      {
        statement: 'Standard shipping is a flat 6 USD per order.',
        value: '6 USD',
        topicSlug: 'shipping-cost',
        confidence: 0.95,
      },
      {
        statement: 'Account deletion takes effect 90 days after the request.',
        value: '90 days',
        topicSlug: 'account-deletion',
        confidence: 0.95,
      },
    ],
  },
  {
    name: 'Legal Update 2026',
    source: {
      title: 'Legal Update 2026',
      sourceType: 'official',
      content:
        'We retain customer data for 3 years after account closure. ' +
        'Price matches are honoured for 60 days from the date of purchase. ' +
        'Deleted accounts are erased 90 days after the deletion request.',
    },
    claims: [
      {
        statement: 'We retain customer data for 3 years after account closure.',
        value: '3 years',
        topicSlug: 'data-retention',
        confidence: 0.95,
      },
      {
        statement: 'Price matches are honoured for 60 days from the date of purchase.',
        value: '60 days',
        topicSlug: 'price-match-window',
        confidence: 0.95,
      },
      {
        statement: 'Deleted accounts are erased 90 days after the deletion request.',
        value: '90 days',
        topicSlug: 'account-deletion',
        confidence: 0.95,
      },
    ],
  },
] as const

/** The schema's `sourceType` vocabulary, in the order the select lists it. */
const SOURCE_TYPES = ['internal', 'external', 'official', 'community'] as const

/**
 * The detector, DUPLICATED from `scripts/detect.mjs` rather than imported.
 *
 * The import was rejected on evidence, not overlooked. `scripts/detect.mjs` imports
 * `node:url` and guards its `main()` with `process.argv[1]`, so bundling it for the browser
 * would either break the Vite build on that builtin or throw `process is not defined` the
 * moment the module is evaluated - to gain three pure functions. The alternatives were to
 * fork the script's CLI plumbing or to copy them; the copy is small, pure, and pinned to
 * the same behaviour:
 *
 *   - grouping is by TOPIC, and disagreement is judged on the NORMALIZED value, so two
 *     sources that agree raise nothing at all;
 *   - coverage is by VALUE SET for the SAME TOPIC. The topic guard is REQUIRED, not
 *     defensive: values repeat across topics ("30 days" is asserted about refunds, price
 *     matches, trials and cancellations), so without it `case-price-match-window-1` would
 *     "cover" a refund-window conflict that happens to disagree on the same two values, and
 *     the detector would go quiet;
 *   - a genuinely NEW value is NOT covered, and does open a case. That is what a second
 *     case on one topic means, and `case-trial-period-2` is the seeded precedent.
 *
 * KEEP IN SYNC with `findConflicts`, `alreadyHasCase` and `nextCaseId` in
 * `scripts/detect.mjs`.
 */
function normaliseValue(value: string | null): string {
  return String(value ?? '').trim().toLowerCase()
}

function distinctValues(rows: {value: string | null}[]): Set<string> {
  return new Set(rows.map((row) => normaliseValue(row.value)).filter(Boolean))
}

type ConflictRow = {
  claims: UnresolvedClaimRow[]
  topicRef: string
  topicName: string | null
  topicSlug: string | null
  values: string[]
}

/** Groups open claims by topic and keeps the groups that genuinely disagree. */
function findConflicts(claims: UnresolvedClaimRow[]): ConflictRow[] {
  const byTopic = new Map<string, UnresolvedClaimRow[]>()

  for (const claim of claims) {
    if (!claim.topicRef) continue
    const group = byTopic.get(claim.topicRef) ?? []
    group.push(claim)
    byTopic.set(claim.topicRef, group)
  }

  const conflicts: ConflictRow[] = []

  for (const [topicRef, group] of byTopic) {
    const values = [
      ...new Set(group.map((claim) => String(claim.value ?? '').trim()).filter(Boolean)),
    ]

    if (group.length < 2 || values.length < 2) continue

    conflicts.push({
      claims: group,
      topicRef,
      topicName: group[0].topicName,
      topicSlug: group[0].topicSlug,
      values,
    })
  }

  return conflicts.sort((a, b) => String(a.topicName).localeCompare(String(b.topicName)))
}

/** `TriageCase` satisfies this structurally: it needs the topic and its claims' values. */
type CaseCoverage = {topicRef: string | null; claims: {value: string | null}[]}

/**
 * An existing case already covers this conflict when, FOR THE SAME TOPIC, it covers every
 * value the conflict disagrees on - the same values, or a superset.
 */
function alreadyHasCase(conflict: ConflictRow, cases: CaseCoverage[]): boolean {
  const wanted = distinctValues(conflict.claims)
  if (wanted.size < 2) return false

  return cases.some((existing) => {
    if (existing.topicRef !== conflict.topicRef) return false
    const covered = distinctValues(existing.claims)
    return [...wanted].every((value) => covered.has(value))
  })
}

/** `case-<topicSlug>-<n>`, stepping past ids the dataset already uses. */
function nextCaseId(topicSlug: string | null, takenIds: Set<string>): string {
  const slug = topicSlug ?? 'topic'
  let index = 1
  while (takenIds.has(`case-${slug}-${index}`)) index += 1
  return `case-${slug}-${index}`
}

const refTo = (_ref: string): ReferenceValue => ({_type: 'reference', _ref})

/** What a successful run did, shown in place of the form so it can be read. */
type IntakeOutcome = {
  claimCount: number
  droppedSlugs: string[]
  coveredTopicCount: number
  opened: {caseId: string; topicName: string | null; values: string[]}[]
}

type AddSourceDialogProps = {
  topics: TopicChoice[]
  unresolvedClaims: UnresolvedClaimRow[]
  cases: TriageCase[]
  onClose: () => void
  onCreated: () => void
}

export function AddSourceDialog({
  topics,
  unresolvedClaims,
  cases,
  onClose,
  onCreated,
}: AddSourceDialogProps) {
  const [title, setTitle] = useState('')
  const [sourceType, setSourceType] = useState<string>(SOURCE_TYPES[0])
  const [sampleIndex, setSampleIndex] = useState<number | null>(null)
  const [content, setContent] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<IntakeOutcome | null>(null)

  const apply = useApplyDocumentActions()

  /**
   * The selected sample's claims, resolved to topic ids.
   *
   * A claim whose slug no longer resolves is reported and dropped rather than written
   * against a dangling reference - the same defensive stance as the extractor, which drops
   * a claim naming a topic that does not exist instead of failing the whole batch.
   */
  const resolved = useMemo(() => {
    const sample = sampleIndex === null ? null : SAMPLES[sampleIndex]
    if (!sample) return {claims: [], droppedSlugs: [] as string[]}

    const bySlug = new Map<string, TopicChoice>()
    for (const topic of topics) if (topic.slug) bySlug.set(topic.slug, topic)

    const claims: (SampleClaim & {topicId: string; topicName: string | null})[] = []
    const droppedSlugs: string[] = []

    for (const claim of sample.claims) {
      const topic = bySlug.get(claim.topicSlug)
      if (!topic) {
        droppedSlugs.push(claim.topicSlug)
        continue
      }
      claims.push({...claim, topicId: topic._id, topicName: topic.name})
    }

    return {claims, droppedSlugs}
  }, [sampleIndex, topics])

  const loadSample = useCallback((index: number) => {
    const sample = SAMPLES[index]
    setSampleIndex(index)
    setTitle(sample.source.title)
    setSourceType(sample.source.sourceType)
    setContent(sample.source.content)
    setError(null)
  }, [])

  const isReadyToSubmit =
    title.trim().length > 0 && content.trim().length > 0 && !isSaving && !outcome

  const handleSubmit = useCallback(async () => {
    if (!isReadyToSubmit) return

    setIsSaving(true)
    setError(null)

    try {
      const now = new Date().toISOString()
      const sourceId = crypto.randomUUID()

      // --- transaction 1: the source and its extracted claims -------------------------
      const sourceHandle = createDocumentHandle({documentId: sourceId, documentType: 'source'})
      const sourceDocument = {
        title: title.trim(),
        sourceType,
        content: content.trim(),
        // Stamped as reviewed now, which is what an intake is. It also gives the offline
        // proposer a real date to rank on (rule 2 is recency) instead of a null.
        lastReviewedAt: now,
      }

      const newClaims = resolved.claims.map((claim) => {
        const documentId = crypto.randomUUID()
        return {
          handle: createDocumentHandle({documentId, documentType: 'claim'}),
          document: {
            statement: claim.statement,
            value: claim.value,
            topic: refTo(claim.topicId),
            source: refTo(sourceId),
            // Legacy expand-window field: the deployed v1 app decides whether a claim is
            // still open with `status == "unresolved"`.
            status: 'unresolved',
            confidence: claim.confidence,
          },
          // The row shape the detector reads, so the new claims can be pooled with the ones
          // already in the dataset without reading anything back.
          row: {
            _id: documentId,
            value: claim.value,
            statement: claim.statement,
            topicRef: claim.topicId,
            topicName: claim.topicName,
            topicSlug: claim.topicSlug,
          } satisfies UnresolvedClaimRow,
        }
      })

      // ONE transaction: `apply` sends a batch as a single transaction, so a failure here
      // leaves neither a source without its claims nor claims without their source. Each
      // claim is created before the publish that follows it.
      await apply([
        createDocument(sourceHandle, sourceDocument as never),
        publishDocument(sourceHandle),
        ...newClaims.flatMap((claim) => [
          createDocument(claim.handle, claim.document as never),
          publishDocument(claim.handle),
        ]),
      ])

      // --- detection: no read-back needed --------------------------------------------
      // The new claims are in hand with their ids and values, so the pool is the live
      // snapshot plus these rows.
      const pool: UnresolvedClaimRow[] = [...unresolvedClaims, ...newClaims.map((c) => c.row)]
      const conflicts = findConflicts(pool)
      const takenIds = new Set(cases.map((entry) => entry._id))
      const toOpen: (ConflictRow & {caseId: string})[] = []

      for (const conflict of conflicts) {
        if (alreadyHasCase(conflict, cases)) continue
        // Reserve the id as we plan, so two conflicts cannot be handed the same one.
        const caseId = nextCaseId(conflict.topicSlug, takenIds)
        takenIds.add(caseId)
        toOpen.push({...conflict, caseId})
      }

      // --- transaction 2: one case + its creation event, per new conflict --------------
      // A SECOND transaction rather than one bigger first batch, because the case's
      // `claims` array references the claims, which must exist by the time the case is
      // written - the same ordering the seed and `scripts/detect.mjs` follow. Detection
      // needed no read, so this split is about reference validity, not about seeing the
      // new claims.
      //
      // Case and event go together: a case must never exist without the log entry that
      // says why it was opened.
      for (const conflict of toOpen) {
        const caseHandle = createDocumentHandle({
          documentId: conflict.caseId,
          documentType: 'case',
        })
        const eventHandle = createDocumentHandle({
          documentId: `event-${conflict.caseId}-detected`,
          documentType: 'caseEvent',
        })

        await apply([
          createDocument(caseHandle, {
            topic: refTo(conflict.topicRef),
            // Every open claim on the topic, not only the new ones: the case is the
            // question as it stands, and the snapshot is taken at detection time.
            claims: conflict.claims.map((claim) => ({...refTo(claim._id), _key: claim._id})),
            // `agent`, not `system`: `ACTOR_KINDS_DETECTED_BY` in schemaTypes/workflowStages.ts
            // is deliberately narrower than the actor vocabulary, because `system` may
            // advance a case but should not be credited with opening one.
            detectedBy: 'agent',
            detectedAt: now,
          } as never),
          publishDocument(caseHandle),
          createDocument(eventHandle, {
            case: refTo(conflict.caseId),
            // Explicit null: the schema documents an unset `from` as the creation event,
            // and the seeded creation events carry it too.
            from: null,
            to: 'detected',
            actor: {kind: 'agent', id: 'ui-intake', label: 'Add Source dialog'},
            at: now,
            payload: {
              note: `Detected while adding "${title.trim()}": ${conflict.values.join(' vs ')}.`,
            },
          } as never),
          publishDocument(eventHandle),
        ])
      }

      setOutcome({
        claimCount: newClaims.length,
        droppedSlugs: resolved.droppedSlugs,
        coveredTopicCount: conflicts.length - toOpen.length,
        opened: toOpen.map((conflict) => ({
          caseId: conflict.caseId,
          topicName: conflict.topicName,
          values: conflict.values,
        })),
      })
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to create the source.')
    } finally {
      setIsSaving(false)
    }
  }, [apply, cases, content, isReadyToSubmit, resolved, sourceType, title, unresolvedClaims])

  return (
    /**
     * `Dialog` calls `useLayer()`, which throws "missing context value" without a
     * `LayerProvider` ancestor. Scoping the provider to this dialog keeps it self-contained,
     * exactly as AddClaimDialog does.
     */
    <LayerProvider>
      <Dialog
        footer={
          <Flex gap={2} justify="flex-end" padding={4}>
            {outcome ? (
              // After a successful write the only sensible action is to look at what
              // happened, so the footer collapses to one button.
              <Button onClick={onCreated} text="Done" tone="primary" />
            ) : (
              <>
                <Button disabled={isSaving} mode="ghost" onClick={onClose} text="Cancel" />
                <Button
                  disabled={!isReadyToSubmit}
                  onClick={handleSubmit}
                  text={isSaving ? 'Creating…' : 'Create Source + Claims'}
                  tone="primary"
                />
              </>
            )}
          </Flex>
        }
        header="Add source"
        id="add-source-dialog"
        onClose={onClose}
        width={2}
      >
        {/* `Dialog` pads its header, and the footer pads itself, but renders its CHILDREN
            raw - see AddClaimDialog for the same note. */}
        <Stack padding={4} space={5}>
          {outcome ? (
            <Stack space={4}>
              <Card border padding={4} radius={2} tone="positive">
                <Stack space={3}>
                  <Text size={1} weight="semibold">
                    Wrote {outcome.claimCount} claim
                    {outcome.claimCount === 1 ? '' : 's'} and created “{title.trim()}”.
                  </Text>

                  {outcome.opened.length > 0 ? (
                    <Stack space={2}>
                      {outcome.opened.map((opened) => (
                        <Text key={opened.caseId} size={1}>
                          Opened {opened.caseId}: {opened.topicName ?? 'topic'} (
                          {opened.values.join(' vs ')}). It is waiting at the “detected” stage.
                        </Text>
                      ))}
                    </Stack>
                  ) : (
                    <Text size={1}>
                      No new case was needed: every topic these claims touch either agrees with
                      what is already on record or is already covered by a case.
                    </Text>
                  )}

                  {outcome.coveredTopicCount > 0 ? (
                    <Text muted size={0}>
                      {outcome.coveredTopicCount} conflicting topic
                      {outcome.coveredTopicCount === 1 ? '' : 's'} already had a case, so no
                      duplicate was opened.
                    </Text>
                  ) : null}

                  {outcome.droppedSlugs.length > 0 ? (
                    <Text muted size={0}>
                      Dropped {outcome.droppedSlugs.length} extracted claim
                      {outcome.droppedSlugs.length === 1 ? '' : 's'} with no matching topic:{' '}
                      {outcome.droppedSlugs.join(', ')}.
                    </Text>
                  ) : null}
                </Stack>
              </Card>

              <Text muted size={1}>
                The claims are published, so the Triage list and the Answers tab pick them up on
                their own. Open the new case to have the offline proposer rank its claims.
              </Text>
            </Stack>
          ) : (
            <Stack space={5}>
              <Text muted size={1}>
                A source is a document that claims are extracted from. A sample carries its prose
                AND the claims already extracted from it: extraction needs an API key and an
                outbound call to a model provider, and a browser can neither hold that key nor
                make that call, so the output is pre-computed and bundled here.
              </Text>

              <Stack space={3}>
                <Text size={0} weight="semibold" muted>
                  SAMPLE
                </Text>
                <Flex gap={2} wrap="wrap">
                  {SAMPLES.map((sample, index) => (
                    <Button
                      fontSize={1}
                      key={sample.name}
                      mode={sampleIndex === index ? 'default' : 'ghost'}
                      onClick={() => loadSample(index)}
                      selected={sampleIndex === index}
                      text={sample.name}
                      tone={sampleIndex === index ? 'primary' : 'default'}
                    />
                  ))}
                </Flex>
                <Text muted size={0}>
                  {resolved.claims.length > 0
                    ? `${resolved.claims.length} extracted claims will be written with the source, and checked against the open claims already on record.`
                    : 'No sample loaded: the source is created with no claims, so nothing is checked against the dataset.'}
                </Text>
              </Stack>

              <Stack space={2}>
                <Label as="label" htmlFor="source-title">
                  Title
                </Label>
                <TextInput
                  id="source-title"
                  onChange={(event) => setTitle(event.currentTarget.value)}
                  placeholder="e.g. Refund Policy v2"
                  value={title}
                />
              </Stack>

              <Stack space={2}>
                <Label as="label" htmlFor="source-type">
                  Type
                </Label>
                <Select
                  id="source-type"
                  onChange={(event) => setSourceType(event.currentTarget.value)}
                  value={sourceType}
                >
                  {SOURCE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </Select>
              </Stack>

              <Stack space={2}>
                <Label as="label" htmlFor="source-content">
                  Content
                </Label>
                <TextArea
                  id="source-content"
                  onChange={(event) => setContent(event.currentTarget.value)}
                  placeholder="Paste the source text, or load a sample above."
                  rows={6}
                  value={content}
                />
                <Text muted size={0}>
                  The prose an extraction run would read. Editing it does NOT re-extract: the
                  claims written below are the sample’s, produced in the CLI where the API key
                  lives.
                </Text>
              </Stack>

              {resolved.droppedSlugs.length > 0 ? (
                <Card border padding={3} radius={2} tone="caution">
                  <Text size={1}>
                    No topic matches {resolved.droppedSlugs.join(', ')}, so those extracted claims
                    will be dropped: a claim naming a topic that does not exist could never be
                    grouped into a conflict.
                  </Text>
                </Card>
              ) : null}

              {error ? (
                <Card border padding={3} radius={2} tone="critical">
                  <Text size={1}>{error}</Text>
                </Card>
              ) : null}
            </Stack>
          )}
        </Stack>
      </Dialog>
    </LayerProvider>
  )
}
