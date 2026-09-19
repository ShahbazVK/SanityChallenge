#!/usr/bin/env node
/**
 * Seeds the Contradiction Triage demo data.
 *
 * Writes directly to the published document IDs via `createOrReplace`, so the
 * script is idempotent — re-running it resets the demo to a known state.
 *
 * A run does the whole reset first, then writes the demo data in two phases. Both
 * orderings are load-bearing:
 *
 *  - The reset must finish before the write. Reset step 4 deletes every instruction, so
 *    writing the instructions first would have them deleted again before the claims
 *    could reference them; reset step 2 would also strip `basedOnClaim` /
 *    `contradictsClaim` back off the freshly seeded instructions.
 *  - The write is split into two phases because claims and instructions reference each
 *    other, and Content Lake validates a reference at write time against documents that
 *    already exist. No single creation order can satisfy both sides:
 *      instructions first → `basedOnClaim` points at a claim that does not exist yet
 *      claims first       → `resolvedBy` points at an instruction that does not exist yet
 *    Phase A creates every document with the three cyclic fields omitted
 *    (`claim.resolvedBy`, `instruction.basedOnClaim`, `instruction.contradictsClaim`).
 *    Phase B patches them in, once both sides exist.
 *
 * The reset steps:
 *   1. clear drafts of the seeded documents — the draft layer is invisible to
 *      `createOrReplace`, and a draft claim can hold a stale `resolvedBy`
 *   2. clear the bidirectional references: unset `resolvedBy` on every claim, and
 *      `basedOnClaim` / `contradictsClaim` on every instruction
 *   3. delete claims this script does not own (leftovers from Add Claim tests)
 *   4. delete every `instruction` document, now that no references remain either way
 *
 * Phase A writes in reference order — topics → sources → instructions → claims — which
 * satisfies the references that are not part of the cycle (`claim.source`,
 * `claim.topic`, `instruction.appliesToTopic`). Phase B then closes the cycle.
 *
 * Usage:
 *   SANITY_WRITE_TOKEN="<token>" npm run seed
 */
import {createClient} from '@sanity/client'

const PROJECT_ID = 'cqb58l0f'
const DATASET = 'production'
const API_VERSION = '2025-01-01'

/**
 * The published ids this script owns — kept in sync with `documents` below so the
 * cleanup can address their draft counterparts too, and so the stray-claim sweep knows
 * which claims are legitimate.
 */
const SEED_DOCUMENT_IDS = [
  // topics
  'topic-refund-window',
  'topic-data-retention',
  'topic-refund-method',
  'topic-shipping-cost',
  'topic-warranty-period',
  'topic-account-deletion',
  // sources
  'source-internal-policy',
  'source-public-faq',
  'source-marketing-site',
  'source-legal-terms',
  'source-support-docs',
  // instructions
  'instruction-refund-method',
  'instruction-account-deletion',
  // claims
  'claim-refund-30',
  'claim-refund-14',
  'claim-shipping-5-marketing',
  'claim-shipping-7-faq',
  'claim-shipping-5-support',
  'claim-warranty-1y',
  'claim-warranty-2y',
  'claim-retention-7y',
  'claim-retention-7y-support',
  'claim-refund-method-original',
  'claim-refund-method-credit',
  'claim-account-deletion-60',
  'claim-account-deletion-30',
]

/**
 * The order Phase A writes documents in. Each type only references types that appear
 * earlier in this list, so every reference present in a Phase A payload resolves to a
 * document that already exists — Content Lake validates references on write.
 *
 * The three fields that form the claim/instruction cycle are deliberately absent from
 * the Phase A payloads, because no ordering can satisfy them. `patchCyclicReferences`
 * adds them in Phase B, once both sides of the cycle exist.
 */
const CREATE_ORDER = ['topic', 'source', 'instruction', 'claim']

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

  const documents = [
    // --- Topics -----------------------------------------------------------
    {
      _id: 'topic-refund-window',
      _type: 'topic',
      name: 'Refund Window',
      slug: {_type: 'slug', current: 'refund-window'},
      description: 'How long customers have to request a refund.',
    },
    {
      _id: 'topic-data-retention',
      _type: 'topic',
      name: 'Data Retention',
      slug: {_type: 'slug', current: 'data-retention'},
      description: 'How long we keep customer data.',
    },
    {
      _id: 'topic-refund-method',
      _type: 'topic',
      name: 'Refund Method',
      slug: {_type: 'slug', current: 'refund-method'},
      description: 'How a refund is paid back to the customer.',
    },
    {
      _id: 'topic-shipping-cost',
      _type: 'topic',
      name: 'Shipping Cost',
      slug: {_type: 'slug', current: 'shipping-cost'},
      description: 'What we charge for standard shipping.',
    },
    {
      _id: 'topic-warranty-period',
      _type: 'topic',
      name: 'Warranty Period',
      slug: {_type: 'slug', current: 'warranty-period'},
      description: 'How long the product warranty lasts.',
    },
    {
      _id: 'topic-account-deletion',
      _type: 'topic',
      name: 'Account Deletion',
      slug: {_type: 'slug', current: 'account-deletion'},
      description: 'How long data is retained after an account deletion request.',
    },

    // --- Sources ----------------------------------------------------------
    {
      _id: 'source-internal-policy',
      _type: 'source',
      title: 'Internal Policy',
      sourceType: 'internal',
      url: 'https://example.com/internal-policy',
      content: 'Internal policy bundle covering refunds, retention and warranty.',
      lastReviewedAt: '2026-08-15T00:00:00Z',
    },
    {
      _id: 'source-public-faq',
      _type: 'source',
      title: 'Public FAQ',
      sourceType: 'external',
      url: 'https://example.com/faq',
      content: 'Customer-facing FAQ.',
      lastReviewedAt: '2025-03-01T00:00:00Z',
    },
    {
      _id: 'source-marketing-site',
      _type: 'source',
      title: 'Marketing Site',
      sourceType: 'external',
      url: 'https://example.com/pricing',
      content: 'Public pricing and product-promise pages.',
      lastReviewedAt: '2026-02-10T00:00:00Z',
    },
    {
      _id: 'source-legal-terms',
      _type: 'source',
      title: 'Legal Terms',
      sourceType: 'official',
      url: 'https://example.com/legal/terms',
      content: 'Binding terms of service. Legal language supersedes all other sources.',
      lastReviewedAt: '2026-01-01T00:00:00Z',
    },
    {
      _id: 'source-support-docs',
      _type: 'source',
      title: 'Support Docs',
      sourceType: 'internal',
      url: 'https://example.com/support',
      content: 'Support-agent runbooks and self-service help articles.',
      lastReviewedAt: '2026-05-01T00:00:00Z',
    },

    // --- Instructions ------------------------------------------------------
    // `basedOnClaim` and `contradictsClaim` are NOT in these payloads. They point at
    // claims, while the pre-resolved claims carry `resolvedBy` pointing back at these
    // instructions — a cycle. Content Lake validates a reference on write against
    // documents that already exist, so whichever side is written second would reference
    // a document that is not there yet. Phase B (`patchCyclicReferences`) patches these
    // two fields in after the claims exist.
    //
    // `appliesToTopic` stays: it points at a topic, which is written before this and
    // never references back.
    {
      _id: 'instruction-refund-method',
      _type: 'instruction',
      resolution:
        'Refunds are issued to the original payment method. Store credit is offered only when the original payment method is unavailable.',
      appliesToTopic: {_type: 'reference', _ref: 'topic-refund-method'},
      decidedBy: 'Priya Raman (Policy Lead)',
      decidedAt: '2026-07-01T14:00:00Z',
    },
    {
      _id: 'instruction-account-deletion',
      _type: 'instruction',
      resolution:
        'Legal Terms govern even though Support Docs is more recent — legal language supersedes support documentation. Deleted accounts are retained for 60 days.',
      appliesToTopic: {_type: 'reference', _ref: 'topic-account-deletion'},
      decidedBy: 'Marcus Hale (Legal)',
      decidedAt: '2026-06-15T10:00:00Z',
    },

    // --- Claims ------------------------------------------------------------
    // Refund Window — open conflict: 30 days vs 14 days.
    {
      _id: 'claim-refund-30',
      _type: 'claim',
      statement: 'Customers may request a refund within 30 days of purchase.',
      value: '30 days',
      source: {_type: 'reference', _ref: 'source-internal-policy'},
      topic: {_type: 'reference', _ref: 'topic-refund-window'},
      status: 'unresolved',
      confidence: 0.95,
    },
    {
      _id: 'claim-refund-14',
      _type: 'claim',
      statement: 'Customers may request a refund within 14 days of purchase.',
      value: '14 days',
      source: {_type: 'reference', _ref: 'source-public-faq'},
      topic: {_type: 'reference', _ref: 'topic-refund-window'},
      status: 'unresolved',
      confidence: 0.6,
    },
    // Shipping Cost — open conflict across THREE claims. Marketing Site and Support
    // Docs both assert "5 USD" and therefore agree; Public FAQ's "7 USD" is the
    // outlier. Proves the conflict rule is not a simple claim count.
    {
      _id: 'claim-shipping-5-marketing',
      _type: 'claim',
      statement: 'Standard shipping costs $5 per order.',
      value: '5 USD',
      source: {_type: 'reference', _ref: 'source-marketing-site'},
      topic: {_type: 'reference', _ref: 'topic-shipping-cost'},
      status: 'unresolved',
      confidence: 0.8,
    },
    {
      _id: 'claim-shipping-7-faq',
      _type: 'claim',
      statement: 'Standard shipping costs $7 per order.',
      value: '7 USD',
      source: {_type: 'reference', _ref: 'source-public-faq'},
      topic: {_type: 'reference', _ref: 'topic-shipping-cost'},
      status: 'unresolved',
      confidence: 0.55,
    },
    {
      _id: 'claim-shipping-5-support',
      _type: 'claim',
      statement: 'Standard shipping is a flat $5 per order.',
      value: '5 USD',
      source: {_type: 'reference', _ref: 'source-support-docs'},
      topic: {_type: 'reference', _ref: 'topic-shipping-cost'},
      status: 'unresolved',
      confidence: 0.7,
    },
    // Warranty Period — open conflict: 1 year vs 2 years.
    {
      _id: 'claim-warranty-1y',
      _type: 'claim',
      statement: 'All products carry a 1-year warranty.',
      value: '1 year',
      source: {_type: 'reference', _ref: 'source-internal-policy'},
      topic: {_type: 'reference', _ref: 'topic-warranty-period'},
      status: 'unresolved',
      confidence: 0.85,
    },
    {
      _id: 'claim-warranty-2y',
      _type: 'claim',
      statement: 'All products carry a 2-year warranty.',
      value: '2 years',
      source: {_type: 'reference', _ref: 'source-marketing-site'},
      topic: {_type: 'reference', _ref: 'topic-warranty-period'},
      status: 'unresolved',
      confidence: 0.5,
    },
    // Data Retention — TWO unresolved claims that AGREE on "7 years". This is the
    // "no crying wolf" case: the values are identical, so `hasValueConflict` is false,
    // the topic stays out of the triage panel, and the centre panel reports it as
    // consistent. Two sources saying the same thing must not read as a contradiction.
    {
      _id: 'claim-retention-7y',
      _type: 'claim',
      statement: 'We retain customer data for 7 years.',
      value: '7 years',
      source: {_type: 'reference', _ref: 'source-internal-policy'},
      topic: {_type: 'reference', _ref: 'topic-data-retention'},
      status: 'unresolved',
      confidence: 0.9,
    },
    {
      _id: 'claim-retention-7y-support',
      _type: 'claim',
      statement: 'Customer data is retained for 7 years after account closure.',
      value: '7 years',
      source: {_type: 'reference', _ref: 'source-support-docs'},
      topic: {_type: 'reference', _ref: 'topic-data-retention'},
      status: 'unresolved',
      confidence: 0.85,
    },
    // Refund Method — PRE-RESOLVED. The winning claim carries only
    // `status: "resolved"`; the overruled claim additionally carries `resolvedBy`.
    // That split mirrors exactly what src/components/ResolveForm.tsx writes when a
    // human resolves a contradiction, so the seeded state is indistinguishable from a
    // decision made in the app.
    //
    // `status` is not a reference, so it stays in the Phase A payload. `resolvedBy` on
    // the overruled claim is one leg of the claim/instruction cycle and is patched in
    // Phase B (`patchCyclicReferences`).
    {
      _id: 'claim-refund-method-original',
      _type: 'claim',
      statement: 'Refunds are issued to the original payment method.',
      value: 'Original payment method',
      source: {_type: 'reference', _ref: 'source-internal-policy'},
      topic: {_type: 'reference', _ref: 'topic-refund-method'},
      status: 'resolved',
      confidence: 0.9,
    },
    {
      _id: 'claim-refund-method-credit',
      _type: 'claim',
      statement: 'Refunds are issued as store credit only.',
      value: 'Store credit only',
      source: {_type: 'reference', _ref: 'source-public-faq'},
      topic: {_type: 'reference', _ref: 'topic-refund-method'},
      status: 'resolved',
      confidence: 0.4,
    },
    // Account Deletion — PRE-RESOLVED, and the NEWER source LOST. Support Docs was
    // reviewed 2026-05-01 and says 30 days; Legal Terms was reviewed 2026-01-01 and
    // says 60 days. The instruction rules for the OLDER source, so History shows the
    // tool records human judgment rather than "most recent source wins".
    //
    // The overruled claim's `resolvedBy` is the other leg of the claim/instruction
    // cycle, so it is patched in Phase B (`patchCyclicReferences`).
    {
      _id: 'claim-account-deletion-60',
      _type: 'claim',
      statement: 'Deleted accounts are retained for 60 days before permanent erasure.',
      value: '60 days',
      source: {_type: 'reference', _ref: 'source-legal-terms'},
      topic: {_type: 'reference', _ref: 'topic-account-deletion'},
      status: 'resolved',
      confidence: 0.95,
    },
    {
      _id: 'claim-account-deletion-30',
      _type: 'claim',
      statement: 'Deleted accounts are erased 30 days after the deletion request.',
      value: '30 days',
      source: {_type: 'reference', _ref: 'source-support-docs'},
      topic: {_type: 'reference', _ref: 'topic-account-deletion'},
      status: 'resolved',
      confidence: 0.75,
    },
  ]

  /**
   * Step 1: clears the draft layer for the seeded documents.
   *
   * A draft claim can hold a stale `resolvedBy` from a resolve test, and an
   * instruction that is still referenced cannot be deleted — so the draft layer has
   * to stop pointing at instructions before the unset and delete steps.
   * `createOrReplace` cannot do this for us: it writes the published id, while drafts
   * live at `drafts.<id>`.
   *
   * `client.delete` skips ids that do not exist instead of throwing.
   */
  async function clearSeedDrafts() {
    const draftIds = SEED_DOCUMENT_IDS.map((documentId) => `drafts.${documentId}`)
    const existingDrafts = await client.fetch('*[_id in $draftIds]._id', {draftIds})

    if (existingDrafts.length === 0) {
      console.log('  · no leftover drafts')
      return
    }

    await client.delete(existingDrafts)
    console.log(`  ✔ removed ${existingDrafts.length} draft(s): ${existingDrafts.join(', ')}`)
  }

  /**
   * Step 2: breaks the reference cycle between claims and instructions.
   *
   * The relationship is bidirectional — `claim.resolvedBy` points at an instruction,
   * while `instruction.basedOnClaim` and `instruction.contradictsClaim` point back at
   * claims — so neither side can be deleted while the other reference still exists.
   * Content Lake rejects deleting a referenced document, which is exactly how the
   * earlier runs failed.
   *
   * Two sequential unset patches remove every reference in both directions. Once they
   * have run, the deletes in steps 3 and 4 cannot fail on referential integrity, so
   * their order no longer matters.
   *
   * `client.patch` accepts a `MutationSelection` — see
   * `@sanity/client/dist/index.d.ts:5724` (`patch(selection, operations)`), with
   * `PatchSelection = string | string[] | MutationSelection` at `:4069` and
   * `MutationSelection = {query: string; params?} | {id: string | string[]}`.
   * A query patch is multi-document, so `.commit()` resolves to an array of results.
   */
  async function clearBidirectionalReferences() {
    const patchedClaims = await client
      .patch({query: '*[_type == "claim" && defined(resolvedBy)]'})
      .unset(['resolvedBy'])
      .commit()

    const patchedInstructions = await client
      .patch({query: '*[_type == "instruction"]'})
      .unset(['basedOnClaim', 'contradictsClaim'])
      .commit()

    console.log(
      `  ✔ references cleared (${patchedClaims?.length ?? 0} claim(s), ` +
        `${patchedInstructions?.length ?? 0} instruction(s))`,
    )
  }

  /**
   * Step 3: deletes claims this script does not own — leftovers from Add Claim tests.
   * They are the documents most likely to reference an instruction, and they are not
   * part of the demo dataset.
   *
   * Safe because step 2 already unset every `basedOnClaim` / `contradictsClaim` that
   * could point at these documents.
   *
   * `_id in $ids` is an exact string comparison, so `drafts.<id>` does NOT match its
   * published `<id>`. Verified against the dataset: drafts are only matched by their
   * own `drafts.`-prefixed id. Both forms of the seeded ids are therefore excluded
   * explicitly, so a seeded draft can never be mistaken for a stray.
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
   * Step 4: removes every instruction document.
   *
   * Runs after step 2 has broken the claim/instruction reference cycle. Before that,
   * Content Lake rejected the delete with "cannot be deleted as there are references to
   * it from <claim>", because a claim still held `resolvedBy`. It must also run before
   * the write, so the reset cannot delete the instructions the seeded claims need.
   * The ids are reported before the delete so the intent is visible in the output.
   */
  async function clearInstructions() {
    const existingInstructions = await client.fetch('*[_type == "instruction"]._id')

    if (existingInstructions.length === 0) {
      console.log('  · no instructions to remove')
      return
    }

    const result = await client.delete({query: '*[_type == "instruction"]'})
    console.log(
      `  ✔ removed ${result?.documentIds?.length ?? 0} instruction(s): ` +
        existingInstructions.join(', '),
    )
  }

  /**
   * Phase B: patches in the three references that form the claim/instruction cycle.
   *
   * Phase A writes both sides of the cycle without these fields, because Content Lake
   * validates a reference on write against documents that already exist and no single
   * creation order can satisfy a cycle:
   *
   *   instructions first → `basedOnClaim` points at a claim that does not exist yet
   *   claims first       → `resolvedBy` points at an instruction that does not exist yet
   *
   * By the time this runs, Phase A has created every topic, source, instruction and
   * claim, so each patch below sets a reference whose target is already published.
   * Nothing here is part of the non-cyclic graph — `claim.source`, `claim.topic` and
   * `instruction.appliesToTopic` were written in Phase A.
   *
   * `client.patch(id)` addresses the published document id directly, which is where
   * `createOrReplace` wrote the Phase A payloads.
   */
  async function patchCyclicReferences() {
    // Patch instructions -> claims
    await client
      .patch('instruction-refund-method')
      .set({
        basedOnClaim: {_type: 'reference', _ref: 'claim-refund-method-original'},
        contradictsClaim: {_type: 'reference', _ref: 'claim-refund-method-credit'},
      })
      .commit()

    await client
      .patch('instruction-account-deletion')
      .set({
        basedOnClaim: {_type: 'reference', _ref: 'claim-account-deletion-60'},
        contradictsClaim: {_type: 'reference', _ref: 'claim-account-deletion-30'},
      })
      .commit()

    // Patch claims -> instructions
    await client
      .patch('claim-refund-method-credit')
      .set({resolvedBy: {_type: 'reference', _ref: 'instruction-refund-method'}})
      .commit()

    await client
      .patch('claim-account-deletion-30')
      .set({resolvedBy: {_type: 'reference', _ref: 'instruction-account-deletion'}})
      .commit()

    console.log('  ✔ patched cyclic references')
  }

  async function seed() {
    console.log(`Seeding ${documents.length} documents into ${PROJECT_ID}/${DATASET}…`)
    console.log('')

    // The reset runs to completion before anything is written. Reset step 4 deletes
    // every instruction, so writing the pre-resolved instructions first would have them
    // deleted again before the claims could reference them. Reset step 2 also unsets
    // every claim/instruction reference, which would otherwise strip `basedOnClaim` and
    // `contradictsClaim` back off the freshly seeded instructions.
    console.log('Reset 1/5 — clear drafts of the seeded documents')
    await clearSeedDrafts()
    console.log('')

    console.log('Reset 2/5 — clear bidirectional references')
    await clearBidirectionalReferences()
    console.log('')

    console.log('Reset 3/5 — remove stray claims')
    await clearStrayClaims()
    console.log('')

    console.log('Reset 4/5 — remove instructions')
    await clearInstructions()
    console.log('')

    console.log(`Write 5/5 — phase A: create ${documents.length} documents`)
    const countsByType = new Map()

    for (const type of CREATE_ORDER) {
      const documentsOfType = documents.filter((document) => document._type === type)

      console.log(`  ${type}`)
      for (const document of documentsOfType) {
        const created = await client.createOrReplace(document)
        countsByType.set(created._type, (countsByType.get(created._type) ?? 0) + 1)
        console.log(`    ✔ ${created._id}`)
      }
    }
    console.log('')

    console.log('Write 5/5 — phase B: patch the cyclic references')
    await patchCyclicReferences()
    console.log('')

    const total = [...countsByType.values()].reduce((sum, count) => sum + count, 0)

    console.log('Summary')
    for (const type of CREATE_ORDER) {
      console.log(`  ${type.padEnd(11)} ${countsByType.get(type) ?? 0}`)
    }
    console.log(`  ${'total'.padEnd(11)} ${total}`)
    console.log('')
    console.log('Expected result in the app:')
    console.log('  - Triage tab shows 3 conflicts:')
    console.log('      Refund Window (2 claims: 30 days vs 14 days)')
    console.log('      Shipping Cost (3 claims: 5 USD, 5 USD, 7 USD — 2 agree)')
    console.log('      Warranty Period (2 claims: 1 year vs 2 years)')
    console.log('  - Data Retention (2 claims, both 7 years) — hidden, values agree')
    console.log('  - Refund Method and Account Deletion — hidden, resolved')
    console.log('  - History tab shows 2 pre-resolved decisions')
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
