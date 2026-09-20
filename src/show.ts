import type { EntryType, JevAnswer, JevQuestion } from './contract.js'
import type { Fixture } from './check.js'

/**
 * Render one measured fixture as the whole story: the natural-language prompt it
 * replaces, the state it ran against, the questions jevc asks instead, what the model
 * actually answered, and the verdict the reducer computed from those answers.
 *
 * The 60 fixtures are the best examples in the repo — each is a real prompt from a real
 * harness, run once against the real model and recorded — and until now they were only
 * reachable as `jevc check` pass/fail rows. This is the renderer behind `jevc show` and
 * behind `examples/GALLERY.md`, so the gallery is generated from the same recordings the
 * test suite asserts against and cannot drift from them.
 */

const text = (v: EntryType): string => typeof v === 'string' ? v : JSON.stringify(v)

/** One line per answer, aligned, with the number that matters and nothing else. */
function answerLine(id: string, a: JevAnswer | undefined, pad: number): string {
  const label = id.padEnd(pad)
  if (!a) return `  ${label}  (not answered)`
  if (a.type === 'noul') return `  ${label}  ${a.noul.toFixed(2)}`
  if (a.type === 'choice') {
    const runner = Object.entries(a.probabilities)
      .filter(([k]) => k !== a.choice)
      .sort((x, y) => y[1] - x[1])[0]
    // The margin is the number that decides whether a choice answer is usable, and it is
    // the one nobody looks at — `bash-rm-rf-node-modules-benign` picks `allow` by 0.07.
    const margin = runner ? ` (margin ${(a.probabilities[a.choice] - runner[1]).toFixed(2)} over ${runner[0]})` : ''
    return `  ${label}  ${a.choice} @ confidence ${a.confidence.toFixed(2)}${margin}`
  }
  const level = a.legend?.[String(Math.round(a.score))]
  return `  ${label}  ${a.score.toFixed(2)} @ confidence ${a.confidence.toFixed(2)}${level ? ` — ${text(level)}` : ''}`
}

function questionLine(id: string, q: JevQuestion, pad: number): string {
  const kind = q.type === 'score'
    ? `score[${(q.criteria as readonly EntryType[]).length}]`
    : q.type === 'choice'
      ? `choice[${Object.keys(q.criteria).length}]`
      : 'noul'
  return `  ${id.padEnd(pad)}  ${kind.padEnd(10)}  ${text(q.instructions)}`
}

const wrap = (s: string, width: number, indent: string): string => {
  const out: string[] = []
  for (const para of s.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/)) {
      if (line === '') line = word
      else if (line.length + 1 + word.length <= width) line += ` ${word}`
      else { out.push(indent + line); line = word }
    }
    out.push(indent + line)
  }
  return out.join('\n')
}

export interface ShowOptions {
  /** Characters of the replaced prompt to print. The full prompt is the point of the
   *  BEFORE section, so the default shows all of it; the gallery caps it to stay readable. */
  promptChars?: number
}

export function renderFixture(f: Fixture, opts: ShowOptions = {}): string {
  const ids = Object.keys(f.questions)
  const pad = Math.max(...ids.map(i => i.length))
  const prompt = typeof f.llm_prompt === 'string' ? f.llm_prompt : ''
  const limit = opts.promptChars ?? prompt.length
  const shown = prompt.length > limit ? `${prompt.slice(0, limit).trimEnd()}\n…` : prompt
  const state = typeof f.state === 'string' ? f.state : JSON.stringify(f.state, null, 2)

  const out: string[] = []
  out.push(`${f.id}`)
  out.push(`${f.domain}${f.title ? ` — ${f.title}` : ''}`)
  out.push('')

  out.push(`BEFORE — the prompt this replaces (${prompt.length} characters, ${ids.length} judgments in one head)`)
  out.push(wrap(shown, 88, '  '))
  out.push('')

  out.push('STATE — what the caller actually had')
  out.push(state.split('\n').slice(0, 24).map(l => `  ${l.length > 96 ? `${l.slice(0, 95)}…` : l}`).join('\n'))
  if (state.split('\n').length > 24) out.push('  …')
  out.push('')

  out.push('AFTER — the questions jevc asks instead, each narrow enough to answer from evidence')
  for (const id of ids) out.push(questionLine(id, f.questions[id], pad))
  out.push('')

  out.push(`MEASURED — one call, ${f.measured.model}, recorded 2026-09-18`)
  for (const id of ids) out.push(answerLine(id, f.measured.answers[id], pad))
  out.push('')

  // `measured.verdict` is the CURATION outcome — keep / keep-with-adjusted-expectation —
  // not a reducer verdict, and labelling it one would be a false claim of exactly the kind
  // this repo exists to catch. A fixture records questions and answers; it carries no
  // `reduce`, so there is no computed verdict here to print. The reducer is the caller's.
  out.push('DID THE PREDICTION HOLD?')
  out.push(f.measured.verdict === 'keep'
    ? '  Yes — the thresholds written before the call survived it unchanged. 24 of 60 did.'
    : '  No — the thresholds written before the call were wrong, and were recalibrated to'
      + '\n  what the model actually returned. So were 36 of the 60, which is why this'
      + '\n  corpus is measured rather than written.')
  out.push('')

  if (f.rationale) {
    out.push('WHY THIS ONE IS IN THE CORPUS')
    out.push(wrap(f.rationale, 88, '  '))
    out.push('')
  }
  if (f.provenance) {
    out.push('PROVENANCE')
    out.push(wrap(f.provenance, 88, '  '))
    out.push('')
  }
  if (f.measured.notes) {
    out.push('NOTES FROM THE RECORDING')
    out.push(wrap(f.measured.notes, 88, '  '))
    out.push('')
  }
  return out.join('\n')
}

/** The same story as markdown, for `examples/GALLERY.md`. */
export function renderFixtureMarkdown(f: Fixture, opts: ShowOptions = {}): string {
  const ids = Object.keys(f.questions)
  const prompt = typeof f.llm_prompt === 'string' ? f.llm_prompt : ''
  const limit = opts.promptChars ?? 600
  const shown = prompt.length > limit ? `${prompt.slice(0, limit).trimEnd()}\n…` : prompt

  const out: string[] = []
  out.push(`### \`${f.id}\``)
  out.push('')
  if (f.title) out.push(`${f.title}`, '')
  out.push(`**Before** — ${prompt.length} characters of prompt, ${ids.length} judgments in one call:`)
  out.push('', '```text', shown, '```', '')
  out.push('**After** — the questions, and what the model answered:', '')
  out.push('| Question | Kind | Answered |')
  out.push('| --- | --- | --- |')
  for (const id of ids) {
    const q = f.questions[id]
    const a = f.measured.answers[id]
    const kind = q.type === 'score'
      ? `score[${(q.criteria as readonly EntryType[]).length}]`
      : q.type === 'choice' ? `choice[${Object.keys(q.criteria).length}]` : 'noul'
    const ans = !a ? '—'
      : a.type === 'noul' ? a.noul.toFixed(2)
      : a.type === 'choice' ? `\`${a.choice}\` @ ${a.confidence.toFixed(2)}`
      : `${a.score.toFixed(2)} @ ${a.confidence.toFixed(2)}`
    out.push(`| \`${id}\` | ${kind} | ${ans} |`)
  }
  out.push('')
  out.push(f.measured.verdict === 'keep'
    ? '**Prediction held.** The thresholds written before the call survived it unchanged.'
    : '**Prediction did not hold.** The thresholds were recalibrated to the measured answers.')
  out.push('')
  if (f.rationale) out.push(`> ${f.rationale.replace(/\n+/g, ' ')}`, '')
  out.push(`Full story: \`jevc show ${f.id}\``)
  out.push('')
  return out.join('\n')
}

/** The whole corpus as one browsable page, grouped by domain. */
export function renderGallery(fixtures: Fixture[]): string {
  const domains = [...new Set(fixtures.map(f => f.domain))].sort()
  const out: string[] = []
  out.push('# The corpus, as a gallery')
  out.push('')
  out.push(`Every one of these ${fixtures.length} entries is a real prompt from a real harness, run once`)
  out.push('against `jev-1.13.0` on 2026-09-18 and recorded. Nothing here is written by hand or')
  out.push('predicted — the answers are what the model returned, and `npm test` asserts them.')
  out.push('')
  out.push('This file is generated. Run `npm run gallery` to rebuild it from `fixtures/`.')
  out.push('')
  out.push('| Domain | Entries |')
  out.push('| --- | --- |')
  for (const d of domains) {
    out.push(`| [${d}](#${d}) | ${fixtures.filter(f => f.domain === d).length} |`)
  }
  out.push('')
  for (const d of domains) {
    out.push(`## ${d}`, '')
    for (const f of fixtures.filter(x => x.domain === d)) out.push(renderFixtureMarkdown(f))
  }
  return out.join('\n')
}
