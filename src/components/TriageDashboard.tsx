import {Suspense, useCallback, useEffect, useMemo, useState} from 'react'
import {useDocuments, useQuery} from '@sanity/sdk-react'
import {Box, Button, Card, Flex, Spinner, Stack, Tab, TabList, TabPanel, Text} from '@sanity/ui'
import {
  AddClaimDialog,
  SOURCES_OPTIONS,
  TOPICS_OPTIONS,
  type SourceOption,
  type TopicOption,
} from './AddClaimDialog'
import {ClaimsList, hasValueConflict, type ClaimGroup, type ClaimSummary} from './ClaimsList'
import {ContradictionView} from './ContradictionView'
import {HistoryView} from './HistoryView'
import {ResolveForm} from './ResolveForm'

const UNRESOLVED_CLAIMS_QUERY = `*[_type == "claim" && status == "unresolved"] | order(topic->name asc, statement asc) {
  _id,
  statement,
  value,
  confidence,
  "topicRef": topic._ref,
  "topicName": topic->name,
  "sourceTitle": source->title
}`

// Module-level constant: the query string never changes, so neither should the
// options object the SDK hashes into its query key.
const UNRESOLVED_CLAIMS_OPTIONS = {query: UNRESOLVED_CLAIMS_QUERY}

/** Resolving needs two candidate claims to choose between. */
const MIN_CLAIMS_FOR_CONFLICT = 2

function CenteredSpinner() {
  return (
    <Flex align="center" justify="center" padding={6} style={{width: '100%', minHeight: '60vh'}}>
      <Spinner />
    </Flex>
  )
}

type DashboardTab = 'triage' | 'history'

/**
 * App shell: a fixed tab switcher above one scrollable content area. The "Triage" tab
 * holds the three-panel dashboard; the "History" tab is the governance record of every
 * instruction. The active tab is component state only — no storage, no URL sync — and
 * defaults to "Triage".
 */
export function TriageDashboard() {
  const [activeTab, setActiveTab] = useState<DashboardTab>('triage')

  return (
    <Flex direction="column" style={{height: '100vh'}}>
      {/* Fixed: only the content area below scrolls. */}
      <Card borderBottom padding={2}>
        <TabList>
          <Tab
            aria-controls="triage-panel"
            id="triage-tab"
            label="Triage"
            onClick={() => setActiveTab('triage')}
            selected={activeTab === 'triage'}
          />
          <Tab
            aria-controls="history-panel"
            id="history-tab"
            label="History"
            onClick={() => setActiveTab('history')}
            selected={activeTab === 'history'}
          />
        </TabList>
      </Card>

      {/* The single scroll container. `minHeight: 0` lets it shrink inside the column
          flex so each tab's own content governs its overflow. */}
      <Box flex={1} style={{minHeight: 0, overflowY: 'auto'}}>
        {activeTab === 'triage' ? (
          <TabPanel aria-labelledby="triage-tab" id="triage-panel" style={{height: '100%'}}>
            <Suspense fallback={<CenteredSpinner />}>
              <TriageWorkspace />
            </Suspense>
          </TabPanel>
        ) : (
          <TabPanel aria-labelledby="history-tab" id="history-panel">
            <Suspense fallback={<CenteredSpinner />}>
              <HistoryView />
            </Suspense>
          </TabPanel>
        )}
      </Box>
    </Flex>
  )
}

function TriageWorkspace() {
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null)
  const [isAddClaimOpen, setIsAddClaimOpen] = useState(false)

  // The grouped left panel needs topic names and source titles, which are field
  // values — `useDocuments` only returns handles, so the grouped view uses a query.
  const {data: unresolvedClaims} = useQuery<ClaimSummary[]>(UNRESOLVED_CLAIMS_OPTIONS)

  // Lookups for the add-claim dialog. Fetched here, inside the tab's Suspense boundary,
  // so the dialog receives them as props and opens without suspending.
  const {data: topics} = useQuery<TopicOption[]>(TOPICS_OPTIONS)
  const {data: sources} = useQuery<SourceOption[]>(SOURCES_OPTIONS)

  // Group every topic that has at least one unresolved claim. The left panel shows only
  // the conflicting ones, but the counts line above it describes all of them.
  const allGroups = useMemo<ClaimGroup[]>(() => {
    const byTopic = new Map<string, ClaimGroup>()

    for (const claim of unresolvedClaims) {
      const topicRef = claim.topicRef ?? 'no-topic'
      const existing = byTopic.get(topicRef)

      if (existing) {
        existing.claims.push(claim)
      } else {
        byTopic.set(topicRef, {
          topicRef,
          topicName: claim.topicName ?? 'Untitled topic',
          claims: [claim],
        })
      }
    }

    return Array.from(byTopic.values())
  }, [unresolvedClaims])

  // A topic is only triage work when its unresolved claims assert *different*
  // normalized values. Two sources saying "30 days" agree, so they stay out of the
  // queue instead of crying wolf.
  const groups = useMemo(
    () => allGroups.filter((group) => hasValueConflict(group.claims)),
    [allGroups],
  )

  // The three shapes a topic can be in, surfaced above the left panel so the value rule
  // is legible without opening anything.
  const counts = useMemo(
    () => ({
      conflicts: allGroups.filter((group) => hasValueConflict(group.claims)).length,
      consistent: allGroups.filter(
        (group) => group.claims.length >= 2 && !hasValueConflict(group.claims),
      ).length,
      single: allGroups.filter((group) => group.claims.length === 1).length,
    }),
    [allGroups],
  )

  const triageableClaimIds = useMemo(
    () => new Set(groups.flatMap((group) => group.claims.map((claim) => claim._id))),
    [groups],
  )

  // Keep a valid selection: when a contradiction is resolved the topic drops out of
  // `groups`, so the stale selection is replaced by the next contradicting claim.
  useEffect(() => {
    if (selectedClaimId && triageableClaimIds.has(selectedClaimId)) return
    setSelectedClaimId(groups[0]?.claims[0]?._id ?? null)
  }, [groups, triageableClaimIds, selectedClaimId])

  const selectedClaim = useMemo(() => {
    for (const group of groups) {
      const match = group.claims.find((claim) => claim._id === selectedClaimId)
      if (match) return match
    }
    return null
  }, [groups, selectedClaimId])

  const topicRef = selectedClaim?.topicRef ?? ''
  const topicName = selectedClaim?.topicName ?? null

  // The topic's unresolved claims — what the conflict verdict is judged on.
  const selectedTopicClaims = useMemo(
    () => unresolvedClaims.filter((claim) => claim.topicRef === topicRef),
    [topicRef, unresolvedClaims],
  )

  // Memoized on `topicRef` so a re-render never hands the SDK a new options object.
  const conflictingClaimOptions = useMemo(
    () => ({
      documentType: 'claim',
      filter: 'topic._ref == $topicId',
      params: {topicId: topicRef},
    }),
    [topicRef],
  )

  // Every claim sharing the selected claim's topic — the contradiction candidates.
  const {data: conflictingClaims} = useDocuments(conflictingClaimOptions)

  const handleResolved = useCallback(() => {
    // Clearing the selection lets the effect above pick the next contradiction.
    setSelectedClaimId(null)
  }, [])

  const handleClaimCreated = useCallback(() => {
    setIsAddClaimOpen(false)
    // Drop the selection so the selection effect re-evaluates against the refreshed
    // claim list and focuses the topic the new claim landed in.
    setSelectedClaimId(null)
  }, [])

  // `minHeight: 100%` rather than `100vh`: this workspace now renders below the tab
  // bar, so it should fill the tab panel instead of forcing a viewport-tall scroll.
  return (
    <Flex align="stretch" style={{minHeight: '100%'}}>
      <Card borderRight flex={1} padding={3} style={{overflowY: 'auto'}}>
        <Stack space={4}>
          <Button
            fontSize={1}
            mode="ghost"
            onClick={() => setIsAddClaimOpen(true)}
            padding={2}
            text="+ Add Claim"
          />
          <ClaimsList
            counts={counts}
            groups={groups}
            selectedClaimId={selectedClaimId}
            onSelectClaim={setSelectedClaimId}
          />
        </Stack>
      </Card>

      <Card borderRight flex={2} padding={4} style={{overflowY: 'auto'}}>
        <ContradictionView
          claims={conflictingClaims}
          selectedClaim={selectedClaim}
          topicName={topicName}
          unresolvedClaims={selectedTopicClaims}
        />
      </Card>

      {/* No Suspense wrapper here: ResolveForm keeps its own drafted text mounted,
          and only its inner pieces suspend. */}
      <Card flex={1} padding={4} style={{overflowY: 'auto'}}>
        {conflictingClaims.length >= MIN_CLAIMS_FOR_CONFLICT && topicRef ? (
          <ResolveForm
            claims={conflictingClaims}
            initialWinnerId={selectedClaimId}
            topicId={topicRef}
            topicName={topicName}
            onResolved={handleResolved}
          />
        ) : (
          <Stack space={4}>
            <Text muted size={1} weight="semibold">
              RESOLVE
            </Text>
            <Card border padding={4} radius={2}>
              <Text muted size={1}>
                A resolution form appears when a topic has two or more unresolved claims.
              </Text>
            </Card>
          </Stack>
        )}
      </Card>

      {/* The dialog portals to the document body, so its position in this flex row has
          no effect on the three-panel layout. */}
      {isAddClaimOpen ? (
        <AddClaimDialog
          onClose={() => setIsAddClaimOpen(false)}
          onCreated={handleClaimCreated}
          sources={sources}
          topics={topics}
        />
      ) : null}
    </Flex>
  )
}

