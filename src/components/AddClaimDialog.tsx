import {useCallback, useEffect, useMemo, useState} from 'react'
import {
  createDocument,
  createDocumentHandle,
  publishDocument,
  useApplyDocumentActions,
} from '@sanity/sdk-react'
import {
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

/**
 * Dropdown data. Module-level options keep their identity stable, so the SDK's option
 * memoization never sees a change. They are consumed by TriageDashboard (which already
 * sits inside a Suspense boundary) and passed in as props, so the dialog itself never
 * suspends and opens immediately.
 *
 * The query strings themselves now live in `src/queries.ts`, so the app has exactly one
 * place that talks to Content Lake. These are re-exports to keep this module's public
 * surface unchanged.
 */
export {SOURCES_OPTIONS, TOPICS_OPTIONS} from '../queries'

const MIN_STATEMENT_LENGTH = 5
const MIN_VALUE_LENGTH = 2

export type TopicOption = {
  _id: string
  name: string | null
}

export type SourceOption = {
  _id: string
  title: string | null
}

type ReferenceValue = {
  _type: 'reference'
  _ref: string
}

type ClaimDraft = {
  statement: string
  value: string
  topic: ReferenceValue
  source: ReferenceValue
  status: string
  confidence?: number
}

type AddClaimDialogProps = {
  topics: TopicOption[]
  sources: SourceOption[]
  onClose: () => void
  onCreated: () => void
}

export function AddClaimDialog({topics, sources, onClose, onCreated}: AddClaimDialogProps) {
  const [statement, setStatement] = useState('')
  const [value, setValue] = useState('')
  const [topicId, setTopicId] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [confidence, setConfidence] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const apply = useApplyDocumentActions()

  // Preselect the first option so a claim always carries a valid topic and source.
  useEffect(() => {
    if (!topicId && topics[0]) setTopicId(topics[0]._id)
  }, [topicId, topics])

  useEffect(() => {
    if (!sourceId && sources[0]) setSourceId(sources[0]._id)
  }, [sourceId, sources])

  const parsedConfidence = useMemo(() => {
    const trimmed = confidence.trim()
    if (trimmed === '') return null
    return Number(trimmed)
  }, [confidence])

  const confidenceIsValid =
    parsedConfidence === null ||
    (!Number.isNaN(parsedConfidence) && parsedConfidence >= 0 && parsedConfidence <= 1)

  const isReadyToSubmit =
    statement.trim().length >= MIN_STATEMENT_LENGTH &&
    value.trim().length >= MIN_VALUE_LENGTH &&
    Boolean(topicId) &&
    Boolean(sourceId) &&
    confidenceIsValid &&
    !isSaving

  const handleSubmit = useCallback(async () => {
    if (!isReadyToSubmit) return

    setIsSaving(true)
    setError(null)

    const claimHandle = createDocumentHandle({
      documentId: crypto.randomUUID(),
      documentType: 'claim',
    })

    const claim: ClaimDraft = {
      statement: statement.trim(),
      value: value.trim(),
      topic: {_type: 'reference', _ref: topicId},
      source: {_type: 'reference', _ref: sourceId},
      status: 'unresolved',
      ...(parsedConfidence !== null ? {confidence: parsedConfidence} : {}),
    }

    try {
      // The same atomic create + publish pattern the resolve flow uses: the SDK writes
      // new documents as drafts, so without the publish the claim would never reach the
      // published layer that the triage queries read.
      await apply([
        // `createDocument`'s `initialValue` type is derived from the groq Typegen
        // registry, which collapses to `never` without generated types. The payload is
        // still checked by its `ClaimDraft` annotation above, so this assertion only
        // bridges the SDK's missing types.
        createDocument(claimHandle, claim as never),
        publishDocument(claimHandle),
      ])

      onCreated()
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to create claim.')
    } finally {
      setIsSaving(false)
    }
  }, [apply, isReadyToSubmit, onCreated, parsedConfidence, sourceId, statement, topicId, value])

  const missingLookups = topics.length === 0 || sources.length === 0

  return (
    /**
     * `Dialog` calls `useLayer()`, which throws "missing context value" without a
     * `LayerProvider` ancestor (`LayerContext` defaults to `null`). Scoping the provider
     * to this dialog keeps it self-contained, rather than requiring a change to the
     * app-wide ThemeProvider/ToastProvider shell.
     */
    <LayerProvider>
      <Dialog
        footer={
          // `padding={4}` matches the content padding, so the buttons line up with the fields
          // instead of sitting closer to the dialog edge than the form above them.
          <Flex gap={2} justify="flex-end" padding={4}>
            <Button mode="ghost" onClick={onClose} text="Cancel" />
            <Button
              disabled={!isReadyToSubmit}
              onClick={handleSubmit}
              text={isSaving ? 'Creating…' : 'Create claim'}
              tone="primary"
            />
          </Flex>
        }
        header="Add claim"
        id="add-claim-dialog"
        onClose={onClose}
        width={1}
      >
        {/* `Dialog` pads its header (and the footer pads itself) but renders its CHILDREN
            raw - see @sanity/ui's DialogCard, which wraps the header in `<Flex padding={3}>`
            and puts `children` straight into `DialogContent`. Without this padding the
            labels and inputs sit flush against the dialog edge while the header above them
            is inset, which is what made this form look broken. */}
        <Stack padding={4} space={5}>
          <Text muted size={1}>
            A claim is one source’s assertion about a topic. Two claims on the same topic with
            different values are in contradiction.
          </Text>

          <Stack space={2}>
            <Label as="label" htmlFor="claim-statement">
              Statement
            </Label>
            <TextArea
              id="claim-statement"
              onChange={(event) => setStatement(event.currentTarget.value)}
              placeholder="e.g. Customers may request a refund within 21 days of purchase."
              rows={4}
              value={statement}
            />
            <Text muted size={0}>
              Required: at least {MIN_STATEMENT_LENGTH} characters.
            </Text>
          </Stack>

          <Stack space={2}>
            <Label as="label" htmlFor="claim-value">
              Value
            </Label>
            <TextInput
              id="claim-value"
              onChange={(event) => setValue(event.currentTarget.value)}
              placeholder="e.g. 30 days"
              value={value}
            />
            <Text muted size={0}>
              The comparison key for its topic: two claims with different values are in
              contradiction.
            </Text>
          </Stack>

          <Stack space={2}>
            <Label as="label" htmlFor="claim-topic">
              Topic
            </Label>
            <Select
              id="claim-topic"
              onChange={(event) => setTopicId(event.currentTarget.value)}
              value={topicId}
            >
              {topics.map((topic) => (
                <option key={topic._id} value={topic._id}>
                  {topic.name ?? topic._id}
                </option>
              ))}
            </Select>
          </Stack>

          <Stack space={2}>
            <Label as="label" htmlFor="claim-source">
              Source
            </Label>
            <Select
              id="claim-source"
              onChange={(event) => setSourceId(event.currentTarget.value)}
              value={sourceId}
            >
              {sources.map((source) => (
                <option key={source._id} value={source._id}>
                  {source.title ?? source._id}
                </option>
              ))}
            </Select>
          </Stack>

          <Stack space={2}>
            <Label as="label" htmlFor="claim-confidence">
              Confidence (optional)
            </Label>
            <TextInput
              id="claim-confidence"
              max={1}
              min={0}
              onChange={(event) => setConfidence(event.currentTarget.value)}
              placeholder="e.g. 0.8"
              step={0.05}
              type="number"
              value={confidence}
            />
            <Text muted size={0}>
              A number between 0 and 1.
            </Text>
          </Stack>

          {missingLookups ? (
            <Card border padding={3} radius={2} tone="caution">
              <Text size={1}>
                Add at least one topic and one source before creating claims: both dropdowns need an
                option.
              </Text>
            </Card>
          ) : null}

          {error ? (
            <Card border padding={3} radius={2} tone="critical">
              <Text size={1}>{error}</Text>
            </Card>
          ) : null}
        </Stack>
      </Dialog>
    </LayerProvider>
  )
}
