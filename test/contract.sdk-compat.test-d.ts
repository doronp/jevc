import type {
  Question, SystemOneRequest, NoulResponse, ChoiceResponse, ScoreResponse,
  NoulQuestion, ChoiceQuestion, ScoreQuestion,
} from '@typesafe-ai/sdk'
import type { JevQuestion, JevRequest, JevAnswer } from '../src/contract.js'

// jevc's contract must stay structurally compatible with the SDK's, or the
// runtime boundary needs unsafe casts. If this stops compiling, the SDK moved.

// noul and choice are structurally identical to the SDK's shapes: no cast
// needed at the boundary for either.
const _noul: NoulQuestion = {} as Extract<JevQuestion, { type: 'noul' }>
const _choice: ChoiceQuestion = {} as Extract<JevQuestion, { type: 'choice' }>

// score is the one genuine, permanent divergence: the SDK's ScoreCriteria is
// `readonly [EntryType, EntryType, ...EntryType[]]`, a tuple type whose
// 2-element minimum only TypeScript can enforce on a literal array written
// inline (e.g. via the SDK's `score()` builder with `const T extends
// ScoreCriteria`). jevc's score criteria is the plain `readonly EntryType[]`
// on purpose: questions are loaded from JSON/schemas at runtime with no
// literal length, and it's the *runtime* validator, not the type system,
// that has to catch a 1-level score (score_too_few_levels). Tightening this
// to match the SDK's tuple would make that check unreachable — TypeScript
// would refuse to construct the very fixtures the validator's tests exist
// to catch (see the 1-level and 11-level score cases in contract.test.ts).
// This is exactly why Task 6's call into the SDK needs `req as never`.
// @ts-expect-error - readonly EntryType[] cannot satisfy a 2-element-minimum tuple; see comment above.
const _score: ScoreQuestion = {} as Extract<JevQuestion, { type: 'score' }>

// The union/request-level checks below fail for the same reason (they
// include the score arm) and are the SDK-facing proof of it.
// @ts-expect-error - fails only through the score arm; noul and choice above are clean.
const _question: Question = {} as JevQuestion
// @ts-expect-error - fails only through `questions`' score arm; see above.
const _request: SystemOneRequest = {} as JevRequest
const _answer: JevAnswer = {} as NoulResponse | ChoiceResponse | ScoreResponse

void _noul; void _choice; void _score; void _question; void _request; void _answer
