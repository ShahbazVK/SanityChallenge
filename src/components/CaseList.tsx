import {useCallback, useState} from 'react'
import {Badge, Button, Card, Flex, Stack, Text} from '@sanity/ui'

import type {CaseStage, TriageCase} from '../types'
import {StageBadge} from './ClaimsList'

/**
 * One section of the left panel.
 *
 * `collapsible` marks the sections that hold HISTORY rather than live work. Those start
 * closed and carry their count in the header instead of a badge, so an archive that grows
 * all day never buries the case that needs a ruling right now.
 *
 * `limit` is how many rows an expanded section shows before it offers the rest.
 * `historyLink` renders a pointer to the History tab under the rows.
 */
type SectionConfig = {
  stage: CaseStage
  title: string
  hint?: string
  collapsible?: boolean
  limit?: number
  historyLink?: boolean
}

const SECTIONS: SectionConfig[] = [
  {stage: 'proposed', title: 'Awaiting your ruling', hint: 'The agent has proposed an outcome.'},
  {stage: 'detected', title: 'Needs a proposal', hint: 'No proposal yet.'},
  {stage: 'ruled', title: 'Recent rulings', collapsible: true, historyLink: true, limit: 10},
  {stage: 'superseded', title: 'Superseded', collapsible: true, limit: 5},
]

export type StageCounts = Record<CaseStage, number>

type CaseListProps = {
  cases: TriageCase[]
  counts: StageCounts
  selectedCaseId: string | null
  onSelectCase: (caseId: string) => void
}

/**
 * The left panel: every case, grouped by its derived stage.
 *
 * The panel lists CASES rather than claims. A claim on its own is not actionable - it only
 * means something next to the claims it disagrees with, which is what a case holds together.
 * Grouping by stage replaces the old derived-from-values grouping, because the stage now
 * *is* the state of the work.
 */
export function CaseList({cases, counts, selectedCaseId, onSelectCase}: CaseListProps) {
  /**
   * Open/closed per section. Session state only - deliberately NOT localStorage, so every
   * mount starts closed and nothing a judge collapses is remembered against them.
   */
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({})

  /**
   * The second stage of disclosure: a section that is open, is still truncated, and has
   * been asked for everything. It is a separate flag rather than a third value of
   * `openSections` so that collapsing and reopening a section - or a refresh of the case
   * list - never has to guess whether "open" meant "show ten" or "show all".
   */
  const [showAllSections, setShowAllSections] = useState<Record<string, boolean>>({})

  const toggleSection = useCallback((stage: CaseStage) => {
    setOpenSections((current) => ({...current, [stage]: !current[stage]}))
  }, [])

  const showAllRows = useCallback((stage: CaseStage) => {
    setShowAllSections((current) => ({...current, [stage]: true}))
  }, [])

  return (
    <Stack space={4}>
      {/* The whole board in one line, in the order the sections appear below. */}
      <Text muted size={0}>
        {counts.proposed} proposed · {counts.detected} detected · {counts.ruled} ruled ·{' '}
        {counts.superseded} superseded
      </Text>

      {cases.length === 0 ? (
        <Card border padding={4} radius={2} tone="positive">
          <Text size={1}>No cases yet. Add a claim to get started.</Text>
        </Card>
      ) : (
        SECTIONS.map((section) => (
          <CaseSection
            cases={cases.filter((entry) => entry.stage === section.stage)}
            isOpen={Boolean(openSections[section.stage])}
            key={section.stage}
            onSelectCase={onSelectCase}
            onShowAll={() => showAllRows(section.stage)}
            onToggle={() => toggleSection(section.stage)}
            section={section}
            selectedCaseId={selectedCaseId}
            showAll={Boolean(showAllSections[section.stage])}
          />
        ))
      )}
    </Stack>
  )
}

/**
 * The disclosure arithmetic for one section, in one place.
 *
 * Extracted from the render so the three rules - collapsed means NO rows, an expanded
 * section shows `limit`, and "show all" removes the limit - can be read (and exercised)
 * without a browser. `hidden` is deliberately reported even while collapsed, because the
 * count in the header and the "+ N more" affordance are decided by different guards.
 */
function sectionDisclosure({
  cases,
  isOpen,
  section,
  showAll,
}: {
  cases: TriageCase[]
  isOpen: boolean
  section: SectionConfig
  showAll: boolean
}): {hidden: number; open: boolean; showHistoryLink: boolean; showMore: boolean; visible: TriageCase[]} {
  // A section without `collapsible` is live work and is always open.
  const open = section.collapsible ? isOpen : true
  const limit = showAll || !section.limit ? cases.length : section.limit
  const visible = open ? cases.slice(0, limit) : []

  return {
    hidden: cases.length - visible.length,
    open,
    showHistoryLink: Boolean(section.historyLink) && open,
    // Only once the section is OPEN and still short of its full list, so it can never be a
    // dead label next to rows nobody can reach.
    showMore: open && cases.length > visible.length,
    visible,
  }
}

/**
 * One section, and the only place the disclosure rules live.
 *
 * A collapsible section's header IS the click target, and its count lives inside the header
 * text ("RECENT RULINGS · 9") rather than in a badge, so the two do not compete for the same
 * pixel. Live sections keep the badge they already had.
 */
function CaseSection({
  cases,
  isOpen,
  onSelectCase,
  onShowAll,
  onToggle,
  section,
  selectedCaseId,
  showAll,
}: {
  cases: TriageCase[]
  isOpen: boolean
  onSelectCase: (caseId: string) => void
  onShowAll: () => void
  onToggle: () => void
  section: SectionConfig
  selectedCaseId: string | null
  showAll: boolean
}) {
  // An empty section renders nothing at all - a header reading "SUPERSEDED · 0" is noise.
  if (cases.length === 0) return null

  const {hidden, open, showHistoryLink, showMore, visible} = sectionDisclosure({
    cases,
    isOpen,
    section,
    showAll,
  })

  return (
    <Stack space={2}>
      {section.collapsible ? (
        <Flex
          align="center"
          aria-expanded={open}
          gap={2}
          onClick={onToggle}
          role="button"
          style={{cursor: 'pointer'}}
          tabIndex={0}
        >
          <Text aria-hidden="true" muted size={1}>
            {open ? '▾' : '▸'}
          </Text>
          <Text muted size={1} weight="semibold">
            {section.title.toUpperCase()} · {cases.length}
          </Text>
        </Flex>
      ) : (
        <Flex align="center" gap={2} justify="space-between">
          <Text muted size={1} weight="semibold">
            {section.title.toUpperCase()}
          </Text>
          <Badge tone={section.stage === 'proposed' ? 'caution' : 'default'}>{cases.length}</Badge>
        </Flex>
      )}

      {section.hint ? (
        <Text muted size={0}>
          {section.hint}
        </Text>
      ) : null}

      {visible.map((entry) => (
        <CaseRow
          entry={entry}
          isSelected={entry._id === selectedCaseId}
          key={entry._id}
          onSelectCase={onSelectCase}
        />
      ))}

      {showMore ? (
        <Button
          fontSize={1}
          mode="bleed"
          onClick={onShowAll}
          padding={2}
          text={`+ ${hidden} more`}
        />
      ) : null}

      {showHistoryLink ? (
        <Text muted size={0}>
          See all in History →
        </Text>
      ) : null}
    </Stack>
  )
}

function CaseRow({
  entry,
  isSelected,
  onSelectCase,
}: {
  entry: TriageCase
  isSelected: boolean
  onSelectCase: (caseId: string) => void
}) {
  return (
    <Card
      border
      onClick={() => onSelectCase(entry._id)}
      padding={3}
      radius={2}
      role="button"
      style={{cursor: 'pointer'}}
      tabIndex={0}
      tone={isSelected ? 'primary' : 'default'}
    >
      <Stack space={2}>
        <Flex align="center" gap={2} justify="space-between" wrap="wrap">
          <Text size={1} weight="semibold">
            {entry.topicName ?? 'Untitled topic'}
          </Text>
          <StageBadge stage={entry.stage} />
        </Flex>
        <Text size={0} muted>
          {entry.claims.length} claim{entry.claims.length === 1 ? '' : 's'} ·{' '}
          {entry.claims.map((claim) => claim.value ?? 'no value').join(' vs ')}
        </Text>
      </Stack>
    </Card>
  )
}

// Exported so a harness can exercise the disclosure arithmetic directly - the caps, the
// collapsed default and the "show all" escape - without rendering anything.
export {SECTIONS, sectionDisclosure}
