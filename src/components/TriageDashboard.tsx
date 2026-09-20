import {Suspense, useCallback, useEffect, useMemo, useState} from 'react'
import {useCurrentUser, useQuery} from '@sanity/sdk-react'
import {Box, Button, Card, Flex, Spinner, Stack, Tab, TabList, TabPanel, Text} from '@sanity/ui'

import {SOURCES_OPTIONS, TOPICS_OPTIONS, TRIAGE_CASES_OPTIONS, caseDetailOptions} from '../queries'
import type {Actor, CaseDetail, SourceOption, TopicOption, TriageCase} from '../types'
import {AddClaimDialog} from './AddClaimDialog'
import {
  AddSourceDialog,
  INTAKE_TOPICS_OPTIONS,
  UNRESOLVED_CLAIMS_OPTIONS,
  type TopicChoice,
  type UnresolvedClaimRow,
} from './AddSourceDialog'
import {AnswersView} from './AnswersView'
import {CaseList, type StageCounts} from './CaseList'
import {ContradictionView} from './ContradictionView'
import {HistoryView} from './HistoryView'
import {ResolveForm} from './ResolveForm'

function CenteredSpinner() {
  return (
    <Flex align="center" justify="center" padding={6} style={{width: '100%', minHeight: '60vh'}}>
      <Spinner />
    </Flex>
  )
}

/**
 * The Triage tab's onboarding note: what the dataset is, and how to drive the pipeline.
 *
 * It sits at the top of the CENTRE panel, which is the part of the workspace a reader faces
 * with nothing selected, and it is rendered by `TriageWorkspace`, so it can only ever appear
 * on the Triage tab.
 *
 * Deliberately NOT dismissible: this is the only thing on screen that says where the data came
 * from, and a judge who hid it could not get the context back. The wording is count-agnostic
 * for a related reason - the dataset grows as the pipeline is exercised, so a card quoting the
 * seed's numbers would start lying the moment someone added a source.
 */
function IntroCard() {
  return (
    <Card border padding={3} radius={2}>
      <Stack space={2}>
        <Text muted size={1}>
          This workspace ships with sample data from a fictional company (sources, cases, and past
          rulings), so you can see the governance loop at work. Click “+ Add Source” in the panel on
          the left to run the pipeline yourself.
        </Text>
        {/* A size smaller than the sentence above: this is context about the environment rather
            than an instruction, and it has to be read before anyone's first write. */}
        <Text muted size={0}>
          This is a shared workspace: your changes are visible to other visitors.
        </Text>
      </Stack>
    </Card>
  )
}

type DashboardTab = 'triage' | 'history' | 'answers'

/**
 * App shell: a fixed tab switcher above one scrollable content area. "Triage" holds the
 * three-panel dashboard, "History" the governance record, and "Answers" the consumer view
 * of what the dataset currently says. The active tab is component state only - no storage,
 * no URL sync - and defaults to "Triage".
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
          <Tab
            aria-controls="answers-panel"
            id="answers-tab"
            label="Answers"
            onClick={() => setActiveTab('answers')}
            selected={activeTab === 'answers'}
          />
        </TabList>
      </Card>

      {/* The single scroll container. `minHeight: 0` lets it shrink inside the column flex
          so each tab's own content governs its overflow. */}
      <Box flex={1} style={{minHeight: 0, overflowY: 'auto'}}>
        {activeTab === 'triage' ? (
          <TabPanel aria-labelledby="triage-tab" id="triage-panel" style={{height: '100%'}}>
            <Suspense fallback={<CenteredSpinner />}>
              <TriageWorkspace />
            </Suspense>
          </TabPanel>
        ) : activeTab === 'history' ? (
          <TabPanel aria-labelledby="history-tab" id="history-panel">
            <Suspense fallback={<CenteredSpinner />}>
              <HistoryView />
            </Suspense>
          </TabPanel>
        ) : (
          <TabPanel aria-labelledby="answers-tab" id="answers-panel" style={{height: '100%'}}>
            <Suspense fallback={<CenteredSpinner />}>
              <AnswersView />
            </Suspense>
          </TabPanel>
        )}
      </Box>
    </Flex>
  )
}

function TriageWorkspace() {
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null)
  const [isAddClaimOpen, setIsAddClaimOpen] = useState(false)
  const [isAddSourceOpen, setIsAddSourceOpen] = useState(false)

  // The left panel needs each case's claims, their values and their sources - all field
  // values, so this is one query rather than handle-based hooks.
  const {data: cases} = useQuery<TriageCase[]>(TRIAGE_CASES_OPTIONS)

  // Lookups for the add-claim dialog, fetched here inside the tab's Suspense boundary so
  // the dialog receives them as props and opens without suspending.
  const {data: topics} = useQuery<TopicOption[]>(TOPICS_OPTIONS)
  const {data: sources} = useQuery<SourceOption[]>(SOURCES_OPTIONS)

  // Intake lookups. Fetched here, inside the tab's Suspense boundary, so the dialog receives
  // them as props and opens without suspending - the same reason the two lookups above live
  // here. This is a second topics query rather than `TOPICS_OPTIONS` because the bundled
  // samples resolve their claims by topic SLUG, which that projection does not carry; the
  // open claims are the pool the intake checks for conflicts.
  const {data: intakeTopics} = useQuery<TopicChoice[]>(INTAKE_TOPICS_OPTIONS)
  const {data: unresolvedClaims} = useQuery<UnresolvedClaimRow[]>(UNRESOLVED_CLAIMS_OPTIONS)

  // Called here rather than inside ResolveForm: the form deliberately holds no hook that
  // could suspend, so a suspension can never remount its inputs and lose typed text.
  const currentUser = useCurrentUser()
  const actor: Actor = useMemo(
    () => ({kind: 'human', id: currentUser?.id ?? null, label: currentUser?.name ?? null}),
    [currentUser?.id, currentUser?.name],
  )

  const counts: StageCounts = useMemo(
    () => ({
      detected: cases.filter((entry) => entry.stage === 'detected').length,
      proposed: cases.filter((entry) => entry.stage === 'proposed').length,
      ruled: cases.filter((entry) => entry.stage === 'ruled').length,
      superseded: cases.filter((entry) => entry.stage === 'superseded').length,
    }),
    [cases],
  )

  // Keep a valid selection, defaulting to work a human can act on: a proposal awaiting a
  // ruling first, then a case with no proposal, then anything at all.
  useEffect(() => {
    if (selectedCaseId && cases.some((entry) => entry._id === selectedCaseId)) return

    const actionable =
      cases.find((entry) => entry.stage === 'proposed') ??
      cases.find((entry) => entry.stage === 'detected') ??
      cases[0]
    setSelectedCaseId(actionable?._id ?? null)
  }, [cases, selectedCaseId])

  // Memoized so a re-render never hands the SDK a new options object for the same case.
  const detailOptions = useMemo(() => caseDetailOptions(selectedCaseId ?? ''), [selectedCaseId])
  const {data: detail} = useQuery<CaseDetail | null>(detailOptions)

  const handleResolved = useCallback(() => {
    // Drop the selection so the effect above re-evaluates against the refreshed case list.
    setSelectedCaseId(null)
  }, [])

  const handleClaimCreated = useCallback(() => {
    setIsAddClaimOpen(false)
    setSelectedCaseId(null)
  }, [])

  const handleSourceCreated = useCallback(() => {
    setIsAddSourceOpen(false)
    // Drop the selection so the effect above re-evaluates against the refreshed case list and
    // lands on the case the intake just opened, rather than leaving a stale detail behind.
    setSelectedCaseId(null)
  }, [])

  /**
   * A proposal just landed. Nothing to refetch - `useQuery` is live, so the case list and the
   * case detail both re-read on their own and the centre panel switches from "No proposal yet"
   * to the proposal. The selection is re-asserted rather than cleared: the case must stay on
   * screen while it moves `detected` → `proposed`, which is the point of clicking the button.
   */
  const handleProposed = useCallback(() => {
    setSelectedCaseId((current) => current)
  }, [])

  return (
    <Flex align="stretch" style={{minHeight: '100%'}}>
      <Card borderRight flex={1} padding={3} style={{overflowY: 'auto'}}>
        <Stack space={4}>
          {/* Intake first, in the order the pipeline runs: a source is what produces claims,
              and a claim is what a case is detected from. */}
          <Button
            fontSize={1}
            mode="ghost"
            onClick={() => setIsAddSourceOpen(true)}
            padding={2}
            text="+ Add Source"
          />
          <Button
            fontSize={1}
            mode="ghost"
            onClick={() => setIsAddClaimOpen(true)}
            padding={2}
            text="+ Add Claim"
          />
          <CaseList
            cases={cases}
            counts={counts}
            onSelectCase={setSelectedCaseId}
            selectedCaseId={selectedCaseId}
          />
        </Stack>
      </Card>

      <Card borderRight flex={2} padding={4} style={{overflowY: 'auto'}}>
        {/* Stacked so the intro card sits above whatever the centre panel is showing - the
            case in full, or the "select a case" placeholder. */}
        <Stack space={4}>
          <IntroCard />
          <ContradictionView detail={detail ?? null} onProposed={handleProposed} />
        </Stack>
      </Card>

      {/* No Suspense wrapper here: ResolveForm keeps its own drafted text mounted, and only
          its inner write-path component sits inside a boundary. */}
      <Card flex={1} padding={4} style={{overflowY: 'auto'}}>
        {detail ? (
          <ResolveForm actor={actor} detail={detail} onResolved={handleResolved} />
        ) : (
          <Stack space={4}>
            <Text muted size={1} weight="semibold">
              RESOLVE
            </Text>
            <Card border padding={4} radius={2}>
              <Text muted size={1}>
                Select a case to resolve it.
              </Text>
            </Card>
          </Stack>
        )}
      </Card>

      {/* The dialog portals to the document body, so its position in this flex row has no
          effect on the three-panel layout. */}
      {isAddClaimOpen ? (
        <AddClaimDialog
          onClose={() => setIsAddClaimOpen(false)}
          onCreated={handleClaimCreated}
          sources={sources}
          topics={topics}
        />
      ) : null}

      {/* Also portalled to the body, so its position in this flex row is irrelevant. The
          lookups are passed in rather than fetched here, because the dialog itself must not
          suspend once it is open. */}
      {isAddSourceOpen ? (
        <AddSourceDialog
          cases={cases}
          onClose={() => setIsAddSourceOpen(false)}
          onCreated={handleSourceCreated}
          topics={intakeTopics}
          unresolvedClaims={unresolvedClaims}
        />
      ) : null}
    </Flex>
  )
}
