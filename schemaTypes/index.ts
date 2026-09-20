import {caseType} from './case'
import {caseEvent} from './caseEvent'
import {claim} from './claim'
import {instruction} from './instruction'
import {precedent} from './precedent'
import {source} from './source'
import {topic} from './topic'

export {caseEvent, caseType, claim, instruction, precedent, source, topic}

/**
 * Registered in dependency order: objects before the documents that embed them, and
 * `claim` / `instruction` last because they are referenced by `case` and `precedent`.
 *
 * `caseType` is exported under that name because `case` is a reserved word in
 * JavaScript; the document type itself is still `case`.
 */
export const schemaTypes = [source, topic, claim, precedent, caseType, caseEvent, instruction]
