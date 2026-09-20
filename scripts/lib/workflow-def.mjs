/**
 * Workflow definition loader + validators.
 *
 * `workflow.def.json` at the repo root is the single source of truth for the case state
 * machine. Schema files cannot import it - Sanity's schema loader is its own TS/JS path
 * and JSON imports there are not guaranteed - so `schemaTypes/workflowStages.ts` mirrors
 * the vocabularies as TS consts. This module is what keeps the two from drifting: it
 * reads BOTH files and refuses to let the seed run if they disagree.
 *
 * Everything here fails loud. A silent skip would be worse than no check at all, because
 * the duplication in workflowStages.ts is unavoidable - the check is the only thing
 * making it safe.
 */
import {readFileSync} from 'node:fs'

const DEF_URL = new URL('../../workflow.def.json', import.meta.url)
const STAGES_TS_URL = new URL('../../schemaTypes/workflowStages.ts', import.meta.url)

/** Absolute paths, surfaced in error messages. */
export const WORKFLOW_DEF_PATH = DEF_URL.pathname
export const WORKFLOW_STAGES_TS_PATH = STAGES_TS_URL.pathname

/** The parsed workflow.def.json. */
export const workflowDef = JSON.parse(readFileSync(DEF_URL, 'utf8'))

/**
 * Pulls the string literals out of `export const NAME = [...] as const` in a TS file.
 *
 * Node cannot import a .ts file, so the seed reads it as text. That is acceptable here
 * only because the three exports are flat arrays of string literals by design; if that
 * ever changes, this throws rather than silently reporting an empty vocabulary.
 */
function extractStringArray(source, exportName) {
  const pattern = new RegExp(`export const ${exportName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`)
  const match = pattern.exec(source)
  if (!match) {
    throw new Error(
      `Could not parse ${exportName} from ${WORKFLOW_STAGES_TS_PATH}.\n` +
        `Expected: export const ${exportName} = [...] as const\n` +
        `Refusing to skip the sync check.`,
    )
  }
  return [...match[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2])
}

/** Reads the three vocabularies mirrored in schemaTypes/workflowStages.ts. */
export function readSchemaVocabularies() {
  const source = readFileSync(STAGES_TS_URL, 'utf8')
  return {
    STAGES: extractStringArray(source, 'STAGES'),
    ACTOR_KINDS: extractStringArray(source, 'ACTOR_KINDS'),
    ACTOR_KINDS_DETECTED_BY: extractStringArray(source, 'ACTOR_KINDS_DETECTED_BY'),
  }
}

function sameMembers(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * Asserts that workflow.def.json and schemaTypes/workflowStages.ts agree, and that the
 * table is internally consistent. Throws with a readable diff on any disagreement.
 *
 * Called as the first statement of the seed, before the client is constructed, so a
 * mismatch can never produce a partial write.
 */
export function assertSchemaStagesInSync() {
  const {STAGES, ACTOR_KINDS, ACTOR_KINDS_DETECTED_BY} = readSchemaVocabularies()
  const problems = []

  if (!sameMembers(STAGES, workflowDef.stages)) {
    problems.push(
      `  workflow.def.json   stages: ${workflowDef.stages.join(', ')}\n` +
        `  workflowStages.ts   STAGES: ${STAGES.join(', ')}`,
    )
  }

  const actorsUsed = new Set(workflowDef.transitions.flatMap((t) => t.actors))
  const missingActors = [...actorsUsed].filter((actor) => !ACTOR_KINDS.includes(actor))
  if (missingActors.length > 0) {
    problems.push(
      `  transitions use actor kind(s) missing from ACTOR_KINDS: ${missingActors.join(', ')}\n` +
        `  ACTOR_KINDS: ${ACTOR_KINDS.join(', ')}`,
    )
  }

  const strayDetectedBy = ACTOR_KINDS_DETECTED_BY.filter((kind) => !ACTOR_KINDS.includes(kind))
  if (strayDetectedBy.length > 0) {
    problems.push(
      `  ACTOR_KINDS_DETECTED_BY is not a subset of ACTOR_KINDS: ${strayDetectedBy.join(', ')}`,
    )
  }

  // Internal consistency of the table itself.
  const knownStages = new Set(workflowDef.stages)
  const seenEdges = new Set()
  for (const transition of workflowDef.transitions) {
    const edge = `${transition.from}->${transition.to}`
    for (const end of ['from', 'to']) {
      if (!knownStages.has(transition[end])) {
        problems.push(`  transition ${edge}: unknown ${end} stage "${transition[end]}"`)
      }
    }
    if (seenEdges.has(edge)) problems.push(`  duplicate transition ${edge}`)
    seenEdges.add(edge)
    if (!Array.isArray(transition.actors) || transition.actors.length === 0) {
      problems.push(`  transition ${edge} has no actors`)
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Workflow definition out of sync.\n\n${problems.join('\n')}\n\n` +
        `Fix schemaTypes/workflowStages.ts or workflow.def.json so they agree.\n` +
        `Refusing to seed until they match.`,
    )
  }

  return {stages: STAGES, actorKinds: ACTOR_KINDS, transitions: workflowDef.transitions.length}
}

/**
 * Replays generated caseEvents against the transition table.
 *
 * Creation events (`from: null`) are exempt: the table describes transitions, and a
 * document coming into existence is not one. Everything else must be a legal edge fired
 * by a legal actor - which is what makes "`ruled` is human-only" a property of the data
 * rather than a promise in a comment.
 */
export function assertTransitionsLegal(caseEvents) {
  const edges = new Map(
    workflowDef.transitions.map((t) => [`${t.from}->${t.to}`, new Set(t.actors)]),
  )

  const violations = []
  let checked = 0

  for (const event of caseEvents) {
    if (event.from == null) continue
    checked += 1
    const edge = `${event.from}->${event.to}`
    const actors = edges.get(edge)
    if (!actors) {
      violations.push(`${event._id}: ${edge} is not in the table`)
      continue
    }
    if (!actors.has(event.actor.kind)) {
      violations.push(
        `${event._id}: actor "${event.actor.kind}" may not fire ${edge} ` +
          `(allowed: ${[...actors].join(', ')})`,
      )
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `caseEvents violate workflow.def.json:\n\n${violations.map((v) => `  ${v}`).join('\n')}\n`,
    )
  }

  return {
    total: caseEvents.length,
    creationEvents: caseEvents.length - checked,
    transitions: checked,
    violations: 0,
  }
}

/** Counts how the generated events use each edge - printed in the seed summary. */
export function summariseTransitions(caseEvents) {
  const counts = new Map()
  for (const event of caseEvents) {
    const edge = `${event.from ?? '∅'}->${event.to}`
    counts.set(edge, (counts.get(edge) ?? 0) + 1)
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))
}
