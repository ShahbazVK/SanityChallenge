#!/usr/bin/env node
/**
 * Phase 10b: the contradiction detector.
 *
 * Closes the loop that the extractor opened. Extraction turns sources into claims; nothing
 * turned claims into CASES, so a human still had to notice a conflict and open a case by
 * hand. This does that:
 *
 *   source.content -> [extract.mjs] -> claims
 *                                      -> [detect.mjs]  -> case + detected event
 *                                                        -> [agent.mjs] -> proposal
 *                                                                        -> human rules
 *
 * NO LLM, deliberately. "Do two open claims about one topic assert different values?" is a
 * data question with a deterministic answer, so detection costs nothing, cannot hallucinate,
 * and can be re-run as often as you like. Proposing what to DO about a conflict is the
 * model's job, and happens later.
 *
 * DRY RUN BY DEFAULT. Nothing is created without `--commit`.
 *
 * Usage:
 *   node --env-file=.env scripts/detect.mjs
 *   node --env-file=.env scripts/detect.mjs --commit
 */
import {pathToFileURL} from 'node:url'

import {createClient} from '@sanity/client'

const PROJECT_ID = 'cqb58l0f'
const DATASET = 'production'
const API_VERSION = '2025-01-01'

/**
 * The claims a conflict can be made of: UNRESOLVED ones, published only.
 *
 * The `status == "unresolved"` filter is load-bearing and is the one thing this query adds
 * to the obvious `*[_type == "claim"]`. Without it the detector re-opens every topic that
 * has already been ruled on - on this dataset that is 11 of 12 topics, because a ruling
 * resolves its claims but leaves them on the topic - and it would propose a dozen cases for
 * settled questions. A ruled conflict is not a live contradiction.
 *
 * `path("drafts.**")` excludes unpublished drafts, which would otherwise be counted twice
 * alongside their published originals.
 */
const UNRESOLVED_CLAIMS_QUERY = `*[_type == "claim"
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

/**
 * Every case, with its topic and the VALUES its claims assert.
 *
 * Values rather than claim ids, because the question being asked is "has this disagreement
 * already been decided for this topic?", and a claim added later that AGREES with what a case
 * already covers does not create a new disagreement.
 *
 * Drafts are included on purpose: a case someone is drafting in the Studio for this conflict
 * should suppress a second one, even though it is not published yet.
 */
const EXISTING_CASES_QUERY = `*[_type == "case"] {
  _id,
  "topicRef": topic._ref,
  "claimValues": claims[]->value
}`

// --- detection -------------------------------------------------------------------------

/**
 * Groups unresolved claims by topic and keeps the groups that genuinely disagree.
 *
 * The disagreement test is on the NORMALIZED `value`, not on the statement: two sources
 * saying "30 days" agree, and flagging them would be noise that trains a reviewer to ignore
 * the panel. `case-data-retention-1` is the live example - two unresolved claims that both
 * assert "7 years" and therefore raise no conflict at all.
 */
function findConflicts(claims) {
  const byTopic = new Map()

  for (const claim of claims) {
    if (!claim.topicRef) continue
    if (!byTopic.has(claim.topicRef)) byTopic.set(claim.topicRef, [])
    byTopic.get(claim.topicRef).push(claim)
  }

  const conflicts = []

  for (const [topicRef, group] of byTopic) {
    const values = [
      ...new Set(group.map((claim) => String(claim.value ?? '').trim()).filter(Boolean)),
    ]

    if (group.length < 2 || values.length < 2) continue

    conflicts.push({
      claims: group,
      topicName: group[0].topicName,
      topicRef,
      topicSlug: group[0].topicSlug,
      values,
    })
  }

  return conflicts.sort((a, b) => String(a.topicName).localeCompare(String(b.topicName)))
}

/** Values are compared the way the detector already compares them: trimmed, case-insensitive. */
function normaliseValue(value) {
  return String(value ?? '').trim().toLowerCase()
}

/** The distinct, non-empty values a list of raw values asserts. */
function distinctValues(values) {
  return new Set((values ?? []).map(normaliseValue).filter(Boolean))
}

/**
 * An existing case already covers this conflict when, FOR THE SAME TOPIC, it covers every
 * VALUE the conflict disagrees on - the same values, or a superset.
 *
 * Coverage by VALUE, not by claim id. A claim id is the wrong unit for the question being
 * asked: a new claim that AGREES with what the case already covers enlarges the group without
 * adding a disagreement, and id-matching would call that uncovered. Concretely, an extracted
 * "5 USD" shipping claim sitting beside the two claims that already say "5 USD" would have
 * opened a second case for a question that is already cased.
 *
 * The topic guard is REQUIRED, not defensive. Values are not unique across topics - "30 days"
 * is asserted about refunds, price matches, trials, cancellations and account deletion - so
 * without it `case-price-match-window-1` {30 days, 14 days} would "cover" the refund-window
 * conflict, which disagrees on exactly those two values, and the detector would go quiet.
 *
 * A genuinely NEW value is still uncovered, and still opens a case. That is deliberate: it is
 * what a second case on one topic means, and the seed holds the precedent - a new claim about
 * trial period arrived after `case-trial-period-1` was ruled, producing `case-trial-period-2`.
 * A check that could not tell "agrees" from "disagrees" would suppress that case.
 */
function alreadyHasCase(conflict, cases) {
  const wanted = distinctValues(conflict.claims.map((claim) => claim.value))
  if (wanted.size < 2) return false

  return cases.some((existing) => {
    if (existing.topicRef !== conflict.topicRef) return false
    const covered = distinctValues(existing.claimValues)
    return [...wanted].every((value) => covered.has(value))
  })
}

/**
 * `case-<topicSlug>-<n>`, the same convention the seed uses, stepping past anything that
 * exists so a second, genuinely NEW disagreement on one topic becomes `-2` rather than
 * colliding. A new claim that merely AGREES never reaches this point: the existing case on the
 * topic covers it.
 */
function nextCaseId(topicSlug, takenIds) {
  let index = 1
  while (takenIds.has(`case-${topicSlug}-${index}`)) index += 1
  return `case-${topicSlug}-${index}`
}

// --- CLI -------------------------------------------------------------------------------

function printUsage() {
  console.log('Usage:')
  console.log('  node --env-file=.env scripts/detect.mjs            # dry run')
  console.log('  node --env-file=.env scripts/detect.mjs --commit   # create the cases')
  console.log('')
  console.log('  --commit   actually create the cases and their detection events')
  console.log('')
  console.log('SANITY_WRITE_TOKEN is only needed with --commit.')
}

function parseArgs(argv) {
  const args = {commit: false, help: false}

  for (const token of argv) {
    if (token === '--commit') {
      args.commit = true
    } else if (token === '--help' || token === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${token}`)
    }
  }

  return args
}

function requireSanityToken() {
  const token = process.env.SANITY_WRITE_TOKEN

  if (!token) {
    console.error('Error: --commit needs SANITY_WRITE_TOKEN, and it is not set.')
    console.error('')
    console.error('Create an Editor (write) token for this project:')
    console.error(`  https://www.sanity.io/manage/project/${PROJECT_ID}/api#tokens`)
    process.exitCode = 1
  }

  return token
}

// --- main ------------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    printUsage()
    return
  }

  const token = args.commit ? requireSanityToken() : undefined
  if (args.commit && !token) return

  const client = createClient({
    projectId: PROJECT_ID,
    dataset: DATASET,
    apiVersion: API_VERSION,
    useCdn: false,
    ...(token ? {token} : {}),
  })

  console.log('Scanning for contradictions...')
  console.log('')

  const [claims, cases] = await Promise.all([
    client.fetch(UNRESOLVED_CLAIMS_QUERY),
    client.fetch(EXISTING_CASES_QUERY),
  ])

  const conflicts = findConflicts(claims)
  const covered = new Set(conflicts.filter((conflict) => alreadyHasCase(conflict, cases)))
  const takenIds = new Set(cases.map((existing) => existing._id))
  const toCreate = []

  for (const conflict of conflicts) {
    if (covered.has(conflict)) continue

    // Reserve the id as we PLAN, so two new conflicts cannot be handed the same one.
    const caseId = nextCaseId(conflict.topicSlug, takenIds)
    takenIds.add(caseId)
    toCreate.push({...conflict, caseId})
  }

  console.log(`Found ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}:`)
  if (conflicts.length === 0) {
    console.log('  (none - every topic with two or more open claims agrees on the value)')
  } else {
    for (const conflict of conflicts) {
      const suffix = covered.has(conflict) ? ' - already has a case' : ''
      console.log(
        `  ${conflict.topicName} - ${conflict.claims.length} claims` +
          ` (${conflict.values.join(' vs ')})${suffix}`,
      )
    }
  }
  console.log('')
  console.log(`Unresolved claims scanned: ${claims.length}`)
  console.log(`Existing cases: ${cases.length}`)
  console.log(`New cases to create: ${toCreate.length}`)
  console.log(`Skipped (already have a case): ${covered.size}`)
  console.log('')

  if (toCreate.length === 0) {
    console.log('Nothing to do. Re-run with --commit only if you want to create new cases.')
    return
  }

  for (const conflict of toCreate) {
    console.log(`  would create ${conflict.caseId} - ${conflict.topicName}`)
  }
  console.log('')

  if (!args.commit) {
    const plural = toCreate.length === 1 ? '' : 's'
    console.log(`Dry run. Re-run with --commit to create ${toCreate.length} case${plural}.`)
    return
  }

  const now = new Date().toISOString()

  for (const conflict of toCreate) {
    // One transaction PER CONFLICT: the case and the event explaining it land together, so a
    // case can never exist without the log entry that says why it was opened.
    const transaction = client.transaction()

    transaction.create({
      _id: conflict.caseId,
      _type: 'case',
      topic: {_type: 'reference', _ref: conflict.topicRef},
      claims: conflict.claims.map((claim) => ({
        _key: claim._id,
        _type: 'reference',
        _ref: claim._id,
      })),
      // `agent`, not `system`. `ACTOR_KINDS_DETECTED_BY` in schemaTypes/workflowStages.ts is
      // deliberately narrower than the full actor vocabulary: it documents that `system` may
      // advance a case but "should not be credited with opening" one.
      detectedBy: 'agent',
      detectedAt: now,
    })

    transaction.create({
      _id: `event-${conflict.caseId}-detected`,
      _type: 'caseEvent',
      case: {_type: 'reference', _ref: conflict.caseId},
      // `from` is deliberately absent: the schema documents an unset `from` as the creation
      // event, and it serialises as null.
      to: 'detected',
      actor: {kind: 'system', id: 'detect-script', label: 'Detection script'},
      at: now,
      payload: {
        note: `Detected by scanning unresolved claims: ${conflict.values.join(' vs ')}.`,
      },
    })

    await transaction.commit()
    console.log(`  ✔ created ${conflict.caseId} + detected event`)
  }

  console.log('')
  console.log(`✔ created ${toCreate.length} case(s). They stay at "detected" stage.`)
  console.log('Next: node --env-file=.env scripts/agent.mjs --all')
}

/**
 * Runs only when invoked directly, so a harness can import the detection rules without
 * scanning the dataset.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`)
    process.exitCode = 1
  })
}

export {alreadyHasCase, findConflicts, nextCaseId}
