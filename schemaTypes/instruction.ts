import {defineArrayMember, defineField, defineType} from 'sanity'

/**
 * A human decision resolving a contradiction. Applies to future entries.
 */
export const instruction = defineType({
  name: 'instruction',
  title: 'Instruction',
  type: 'document',
  fields: [
    defineField({
      name: 'resolution',
      title: 'Resolution',
      type: 'text',
      description: "The human's ruling.",
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'appliesToTopic',
      title: 'Applies to topic',
      type: 'reference',
      to: [{type: 'topic'}],
      description: 'The topic this instruction governs.',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'basedOnClaim',
      title: 'Based on claim',
      type: 'reference',
      to: [{type: 'claim'}],
      description: 'The claim that was chosen as correct.',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'contradictsClaim',
      title: 'Contradicts claim',
      type: 'reference',
      to: [{type: 'claim'}],
      description: 'The claim that was overruled.',
    }),
    defineField({
      name: 'decidedBy',
      title: 'Decided by',
      type: 'string',
    }),
    defineField({
      name: 'decidedAt',
      title: 'Decided at',
      type: 'datetime',
      initialValue: () => new Date().toISOString(),
    }),

    // -----------------------------------------------------------------------------
    // Track B (Phase 1). Additive only - every field below is optional right now so
    // that the instructions already in the dataset stay valid and the deployed v1 app
    // keeps rendering. Phase 8 tightens the two that should be required.
    // -----------------------------------------------------------------------------

    /**
     * NOTE: Optional during expand only for schema-compat. The Phase 2 seed MUST set
     * `case` on every instruction it writes. Phase 8 flips this to required.
     */
    defineField({
      name: 'case',
      title: 'Case',
      type: 'reference',
      to: [{type: 'case'}],
      description: 'The case this ruling answers.',
    }),
    /**
     * The claim upheld as correct.
     *
     * Exactly one of `winner` / `outcomeValue` is set: a ruling either picks one of the
     * claims in conflict, or establishes a value that no claim asserted. The rule below
     * is a WARNING, not an error, because the legacy instructions in the dataset have
     * neither field. Phase 8 promotes it to an error.
     *
     * The document-level rule lives on this field rather than being repeated on both,
     * because the warning is about the pair.
     */
    defineField({
      name: 'winner',
      title: 'Winner',
      type: 'reference',
      to: [{type: 'claim'}],
      description: 'The claim upheld as correct.',
      validation: (rule) =>
        rule
          .custom((_, context) => {
            // `context.document` is loosely typed without generated types; the cast
            // narrows it to the two fields this rule actually reads.
            const doc = context.document as
              | {winner?: unknown; outcomeValue?: unknown}
              | undefined
            if (!doc) return true

            const hasWinner = Boolean(doc.winner)
            const hasOutcomeValue = Boolean(doc.outcomeValue)

            if (hasWinner === hasOutcomeValue) {
              // both true or both false
              if (!hasWinner && !hasOutcomeValue) {
                // Legacy instruction with neither field - warn but don't error during expand
                return 'Neither winner nor outcomeValue is set. (Legacy: OK during expand; will be required.)'
              }
              return 'Exactly one of winner or outcomeValue must be set.'
            }

            return true
          })
          .warning(),
    }),
    /**
     * The value this ruling establishes when it matches no claim.
     *
     * Needed for the "true tie" case: sometimes the correct answer is neither claim -
     * a human may rule that the real window is 21 days even though no source says so.
     * Without this field the schema cannot express that ruling at all.
     */
    defineField({
      name: 'outcomeValue',
      title: 'Outcome value',
      type: 'string',
      description:
        'The canonical value this ruling establishes. Set instead of a winner when the ruling matches no existing claim.',
    }),
    /**
     * Every claim this ruling rejected.
     *
     * An array, not a singular reference: the Shipping Cost conflict is three-way
     * (5 USD, 5 USD, 7 USD), so one ruling can overrule two claims at once. The v1
     * `contradictsClaim` field could not express that.
     */
    defineField({
      name: 'overruled',
      title: 'Overruled claims',
      type: 'array',
      of: [defineArrayMember({type: 'reference', to: [{type: 'claim'}]})],
      description: 'The claims this ruling rejected.',
    }),
    /**
     * Prior rulings this one relied on, and how.
     *
     * Typed rather than a bare reference list so a `distinguishes` - a cited precedent
     * held not to apply - is distinguishable from a `follows`. That distinction is the
     * eval's most interesting category.
     */
    defineField({
      name: 'precedents',
      title: 'Precedents relied on',
      type: 'array',
      of: [defineArrayMember({type: 'precedent'})],
      description: 'Earlier rulings this one cited, and the relation it took to each.',
    }),
    /**
     * The ruling this one replaces, if any.
     *
     * WEAK on purpose. A strong reference would block deleting the target and would make
     * the precedent chain progressively harder to clean up; `weak: true` is the schema
     * default for new references, and the seed also writes `_weak: true` in the data
     * (two distinct mechanisms - the schema flag sets the default, the data flag is the
     * actual link). It additionally relaxes write ordering inside the seed.
     *
     * Same-topic only: a new instruction may supersede a prior ruling on the same topic.
     * Cross-topic relevance belongs in `precedents`.
     */
    defineField({
      name: 'supersedes',
      title: 'Supersedes',
      type: 'reference',
      to: [{type: 'instruction'}],
      weak: true,
      description: 'The earlier ruling on this topic that this one replaces. Never deleted.',
    }),
  ],
  preview: {
    select: {
      title: 'resolution',
      topicName: 'appliesToTopic.name',
      decidedAt: 'decidedAt',
    },
    prepare: ({title, topicName, decidedAt}) => ({
      title,
      subtitle: `${topicName} · ${decidedAt}`,
    }),
  },
})
