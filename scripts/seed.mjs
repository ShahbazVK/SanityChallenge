#!/usr/bin/env node
/**
 * Seeds the Contradiction Triage demo data (Phase 2 of the Track B rebuild).
 *
 * A run does the whole reset first, then writes in five phases. Both orderings are
 * load-bearing.
 *
 * THE RESET runs to completion before anything is written, and it must, because the write
 * phases recreate the same cycles the reset is there to break. Reset step 2 unsets every
 * reference that blocks a delete; steps 3-6 then remove the seed-owned graph in an order
 * where nothing is still pointing at what is being deleted.
 *
 * THE WRITE is phased because references are validated at write time against documents
 * that already exist, and the graph is cyclic:
 *
 *   A  sources, topics, claims        - leaves; nothing they point at points back
 *   B  cases (no proposal)            - needs topics and claims from A
 *   C  instructions                   - needs cases from B; written OLDEST FIRST so
 *                                       `precedents` targets already exist
 *   D  PATCH deferred references      - case.proposal (needs claims + instructions), and
 *                                       the legacy claim.resolvedBy (needs instructions)
 *   E  caseEvents                     - needs only cases from B
 *
 * Phase D exists solely because `case.proposal.outcome` and `case.proposal.precedents`
 * point forward at an instruction that B could not have created yet.
 *
 * EXPAND WINDOW: the schema currently carries both the v1 fields and the Track B fields,
 * and the deployed v1 app reads the v1 ones. `createOrReplace` replaces documents
 * wholesale, so every payload below writes BOTH shapes or the deployed app goes blank.
 * The legacy values are derived from the new model in `seed-data.mjs`, not hand-written,
 * so the two cannot disagree. Phase 8 removes the v1 fields from both schema and seed.
 *
 * Usage:
 *   SANITY_WRITE_TOKEN="<token>" npm run seed
 */
import {createClient} from '@sanity/client'

import {
  SEED_DOCUMENT_IDS,
  TOTAL_DOCUMENTS,
  caseEvents,
  caseProposals,
  cases,
  claims,
  documentsByType,
  expectedStages,
  instructions,
  legacyResolvedBy,
  sources,
  topics,
  SIMULATED_HUMAN_LABEL,
} from './seed-data.mjs'
import {
  assertSchemaStagesInSync,
  assertTransitionsLegal,
  summariseTransitions,
} from './lib/workflow-def.mjs'

const PROJECT_ID = 'cqb58l0f'
const DATASET = 'production'
const API_VERSION = '2025-01-01'

const token = process.env.SANITY_WRITE_TOKEN

if (!token) {
  console.error('Error: the SANITY_WRITE_TOKEN environment variable is not set.')
  console.error('')
  console.error('Create an Editor (write) token for this project:')
  console.error(`  https://www.sanity.io/manage/project/${PROJECT_ID}/api#tokens`)
  console.error('')
  console.error('Then run:')
  console.error('  SANITY_WRITE_TOKEN="<your-token>" npm run seed')
  process.exitCode = 1
} else {
  const client = createClient({
    projectId: PROJECT_ID,
    dataset: DATASET,
    apiVersion: API_VERSION,
    token,
    // Writes must be immediately readable by the app, so bypass the CDN.
    useCdn: false,
  })

  const refTo = (_ref) => ({_type: 'reference', _ref})

  /**
   * Step 1: clears the draft layer for the seeded documents.
   *
   * The draft layer is invisible to `createOrReplace`, and a draft claim can hold a
   * stale `resolvedBy` that blocks a later delete. `client.delete` skips ids that do not
   * exist rather than throwing.
   */
  async function clearSeedDrafts() {
    const draftIds = SEED_DOCUMENT_IDS.map((documentId) => `drafts.${documentId}`)
    const existingDrafts = await client.fetch('*[_id in $draftIds]._id', {draftIds})

    if (existingDrafts.length === 0) {
      console.log('  · no leftover drafts')
      return
    }

    await client.delete(existingDrafts)
    console.log(`  ✔ removed ${existingDrafts.length} draft(s)`)
  }

  /**
   * Step 2: unsets every reference that would block a delete.
   *
   * Both generations: a claim can still hold a stale v1 `resolvedBy`, and
   * `instruction.case` / `caseEvent.case` are strong references back into the documents
   * the following steps remove. Unsetting a field that is not set is a no-op.
   */
  async function clearReferences() {
    const patchedClaims = await client
      .patch({query: '*[_type == "claim" && defined(resolvedBy)]'})
      .unset(['resolvedBy'])
      .commit()

    const patchedInstructions = await client
      .patch({query: '*[_type == "instruction"]'})
      .unset([
        'basedOnClaim',
        'contradictsClaim',
        'case',
        'winner',
        'overruled',
        'precedents',
        'supersedes',
      ])
      .commit()

    const patchedCases = await client
      .patch({query: '*[_type == "case"]'})
      .unset(['proposal'])
      .commit()

    console.log(
      `  ✔ unset references (${patchedClaims?.length ?? 0} claim, ` +
        `${patchedInstructions?.length ?? 0} instruction, ${patchedCases?.length ?? 0} case)`,
    )
  }

  /**
   * Deletes every document of one type. Only for types this seed owns end to end, which
   * is why the caller order matters: caseEvents before cases, instructions before cases.
   */
  async function deleteAllOfType(type) {
    const ids = await client.fetch('*[_type == $type]._id', {type})
    if (ids.length === 0) {
      console.log(`  · no ${type} documents`)
      return 0
    }
    await client.delete({query: '*[_type == $type]', params: {type}})
    console.log(`  ✔ removed ${ids.length} ${type} document(s)`)
    return ids.length
  }

  /**
   * Step 6: claims this seed does not own - leftovers from Add Claim tests.
   *
   * `_id in $ids` is an exact string comparison, so `drafts.<id>` does NOT match its
   * published `<id>`; both forms are excluded explicitly. Safe to run here because steps
   * 2-5 have already removed every instruction and case that could reference a stray.
   */
  async function clearStrayClaims() {
    const coveredIds = [
      ...SEED_DOCUMENT_IDS,
      ...SEED_DOCUMENT_IDS.map((documentId) => `drafts.${documentId}`),
    ]

    const strayClaims = await client.fetch('*[_type == "claim" && !(_id in $ids)]._id', {
      ids: coveredIds,
    })

    if (strayClaims.length === 0) {
      console.log('  · no stray claims')
      return
    }

    await client.delete(strayClaims)
    console.log(`  ✔ removed ${strayClaims.length} stray claim(s): ${strayClaims.join(', ')}`)
  }

  /**
   * Oldest first, so every `precedents` / `supersedes` target is already in the dataset.
   * Sorted rather than hand-ordered: the dependency is real even where the current array
   * order happens to satisfy it.
   */
  const instructionsOldestFirst = [...instructions].sort((a, b) =>
    String(a.decidedAt).localeCompare(String(b.decidedAt)),
  )

  /** Writes one phase, reporting each document as it lands. */
  async function writePhase(label, documents) {
    console.log(label)
    for (const document of documents) {
      await client.createOrReplace(document)
      console.log(`    ✔ ${document._id}`)
    }
  }

  /** Phase D, part 1: the proposals, which could not exist until instructions did. */
  async function patchProposals() {
    for (const entry of caseProposals) {
      await client.patch(entry.caseId).set({proposal: entry.proposal}).commit()
      console.log(
        `    ✔ ${entry.caseId} → "${entry.outcomeValue}" ` +
          `(rule ${entry.decidingRule}, confidence ${entry.proposal.confidence})`,
      )
    }
  }

  /** Phase D, part 2: the v1 back-pointer on overruled claims. */
  async function patchLegacyResolvedBy() {
    for (const {claimId, instructionId} of legacyResolvedBy) {
      await client.patch(claimId).set({resolvedBy: refTo(instructionId)}).commit()
    }
    console.log(`    ✔ ${legacyResolvedBy.length} claim.resolvedBy back-pointer(s)`)
  }

  /**
   * Pre-write assertions. All of these run before the first write so a failure cannot
   * leave the dataset half-built.
   */
  function assertSeedIsSound() {
    const sync = assertSchemaStagesInSync()
    const transitions = assertTransitionsLegal(caseEvents)

    // Phase 2's trap: `instruction.case` is optional in the schema during expand, so the
    // schema cannot catch a seed that forgets it. This can.
    const caseless = instructions.filter((instruction) => !instruction.case)
    if (caseless.length > 0) {
      throw new Error(
        `Every instruction must set \`case\`. Missing on: ${caseless.map((i) => i._id).join(', ')}`,
      )
    }

    // Instruction-to-instruction edges must point backwards in write order.
    const written = new Set()
    for (const instruction of instructionsOldestFirst) {
      for (const precedent of instruction.precedents ?? []) {
        const target = precedent.instruction._ref
        if (!written.has(target)) {
          throw new Error(
            `${instruction._id}.precedents cites ${target}, which is written later. ` +
              `Instruction order must be chronological.`,
          )
        }
      }
      if (instruction.supersedes && !written.has(instruction.supersedes._ref)) {
        throw new Error(
          `${instruction._id}.supersedes targets ${instruction.supersedes._ref}, written later.`,
        )
      }
      written.add(instruction._id)
    }

    // D8: exactly one of winner / outcomeValue.
    for (const instruction of instructions) {
      const hasWinner = Boolean(instruction.winner)
      const hasOutcomeValue = Boolean(instruction.outcomeValue)
      if (hasWinner === hasOutcomeValue) {
        throw new Error(
          `${instruction._id} must set exactly one of winner / outcomeValue ` +
            `(winner=${hasWinner}, outcomeValue=${hasOutcomeValue}).`,
        )
      }
    }

    return {sync, transitions}
  }

  async function seed() {
    const {sync, transitions} = assertSeedIsSound()

    console.log(`Seeding ${TOTAL_DOCUMENTS} documents into ${PROJECT_ID}/${DATASET}…`)
    console.log(`  workflow.def.json: ${sync.stages.join(' → ')} · ${sync.transitions} transitions`)
    console.log('')

    console.log('Reset 1/6 - clear drafts of the seeded documents')
    await clearSeedDrafts()
    console.log('')

    console.log('Reset 2/6 - unset references that would block a delete')
    await clearReferences()
    console.log('')

    console.log('Reset 3/6 - remove case events')
    await deleteAllOfType('caseEvent')
    console.log('')

    console.log('Reset 4/6 - remove instructions')
    await deleteAllOfType('instruction')
    console.log('')

    console.log('Reset 5/6 - remove cases')
    await deleteAllOfType('case')
    console.log('')

    console.log('Reset 6/6 - remove stray claims')
    await clearStrayClaims()
    console.log('')

    await writePhase(
      `Write A/5 - sources, topics, claims (${sources.length + topics.length + claims.length})`,
      [...sources, ...topics, ...claims],
    )
    console.log('')

    await writePhase(`Write B/5 - cases, no proposal yet (${cases.length})`, cases)
    console.log('')

    await writePhase(
      `Write C/5 - instructions, oldest first (${instructionsOldestFirst.length})`,
      instructionsOldestFirst,
    )
    console.log('')

    console.log(
      `Write D/5 - patch deferred references (${caseProposals.length} proposals, ` +
        `${legacyResolvedBy.length} legacy resolvedBy)`,
    )
    await patchProposals()
    await patchLegacyResolvedBy()
    console.log('')

    await writePhase(`Write E/5 - case events (${caseEvents.length})`, caseEvents)
    console.log('')

    console.log('Documents written')
    for (const [type, documents] of Object.entries(documentsByType)) {
      console.log(`  ${type.padEnd(11)} ${documents.length}`)
    }
    console.log(`  ${'total'.padEnd(11)} ${TOTAL_DOCUMENTS}`)
    console.log('')

    console.log('Transitions verified against workflow.def.json')
    for (const [edge, count] of summariseTransitions(caseEvents)) {
      console.log(`  ${edge.padEnd(24)} ${count}`)
    }
    console.log(
      `  ${'checked'.padEnd(24)} ${transitions.transitions} transitions, ` +
        `${transitions.creationEvents} creation event(s), ${transitions.violations} violation(s)`,
    )
    console.log('')

    console.log('Proposals (deterministic rule, no LLM call)')
    for (const entry of caseProposals) {
      console.log(
        `  ${entry.caseId.padEnd(30)} rule ${entry.decidingRule} · ` +
          `confidence ${entry.proposal.confidence} → ${entry.outcomeValue}`,
      )
    }
    console.log('')

    console.log('Expected derived stage per case')
    for (const [caseId, stage] of Object.entries(expectedStages)) {
      console.log(`  ${caseId.padEnd(30)} ${stage}`)
    }
    console.log('')

    console.log('Expected result in the app:')
    console.log('  - the deployed v1 app: 4 conflicts (Refund Window, Shipping Cost,')
    console.log('    Warranty Period, Refund Processing Time) and 7 History decisions')
    console.log('  - after Phase 3, the new UI: 3 proposed · 1 detected · 7 ruled ·')
    console.log('    1 superseded')
    console.log('')
    console.log('⚠ Note: seeded caseEvents with actor.kind "human" are simulated fixtures, not')
    console.log('  real user actions. They exist so the History view has a timeline to render.')
    console.log(`  All of them are labelled "${SIMULATED_HUMAN_LABEL}".`)
  }

  try {
    await seed()
    process.exitCode = 0
  } catch (error) {
    console.error('')
    console.error('Seed failed:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
