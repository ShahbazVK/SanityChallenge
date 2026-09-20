/**
 * TypeScript mirrors of the stage and actor vocabularies in `/workflow.def.json`.
 *
 * WHY THIS FILE EXISTS: `workflow.def.json` is the source of truth, but schema files
 * must not import it. Sanity loads the schema through its own TS/JS path, and JSON
 * module imports are not guaranteed to work there - a schema that fails to load takes
 * the whole Studio and the schema store down with it. So the vocabulary is duplicated
 * here, in the one form the schema loader is certain to accept, and correctness is
 * enforced by a check rather than by hope.
 *
 * Keep in sync with workflow.def.json. A seed-time validator asserts equality.
 */

/** The four stages a case moves through. Mirrors `stages` in workflow.def.json. */
export const STAGES = ['detected', 'proposed', 'ruled', 'superseded'] as const

/** Every actor kind that may appear on a `caseEvent.actor`. */
export const ACTOR_KINDS = ['agent', 'human', 'system', 'seed'] as const

/**
 * Actor kinds legal on `case.detectedBy`.
 *
 * Narrower than {@link ACTOR_KINDS} on purpose: `system` may advance a case (e.g. a
 * supersession sweep) but should not be credited with opening one.
 */
export const ACTOR_KINDS_DETECTED_BY = ['agent', 'human', 'seed'] as const
