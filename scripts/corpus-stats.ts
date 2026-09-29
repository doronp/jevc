#!/usr/bin/env node
/**
 * Recompute the corpus numbers quoted in source comments: the drift-headroom paragraph in
 * `src/check.ts` and the fractional-score count in `src/contract.ts`. Offline; reads
 * `fixtures/` only. Run: `env -u TYPESAFE_API_KEY npx tsx scripts/corpus-stats.ts`.
 * `test/examples.test.ts` recomputes the same numbers and fails when a comment goes stale.
 */
import { loadFixtures } from '../src/check.js'

const corpus = loadFixtures('fixtures')

// Headroom is how far a recorded answer sits from the bound it must hold. Rounded to 1e-10
// because 0.95 - 0.8 is 0.1499999... in floating point, and a bound with exactly 0.15 of
// headroom is NOT inside one drift threshold: diffFixture flags |delta| > 0.15, and a move of
// exactly 0.15 lands on the bound, which still holds.
const bounds = corpus.flatMap(f =>
  Object.entries(f.expect).flatMap(([id, exp]) =>
    Object.entries(exp).flatMap(([key, bound]) => {
      if (typeof bound !== 'number') return []
      const a = f.measured.answers[id]
      const actual = key.startsWith('noul_') ? (a?.type === 'noul' ? a.noul : undefined)
        : key.startsWith('score_') ? (a?.type === 'score' ? a.score : undefined)
          : (a?.type === 'choice' || a?.type === 'score' ? a.confidence : undefined)
      if (typeof actual !== 'number') return []
      return [{ at: `${f.id}.${id} ${key}`, headroom: Number(Math.abs(actual - bound).toFixed(10)) }]
    })))

const sorted = bounds.map(b => b.headroom).sort((x, y) => x - y)
const mid = sorted.length >> 1
const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
const min = sorted[0]

const scores = corpus.flatMap(f => Object.values(f.measured.answers))
  .filter(a => a.type === 'score') as { score: number }[]

const lines = [
  `fixtures:                ${corpus.length}`,
  `numeric bounds:          ${bounds.length}`,
  `headroom < 0.15:         ${sorted.filter(h => h < 0.15).length}`,
  `headroom exactly 0.15:   ${sorted.filter(h => h === 0.15).length}`,
  `median headroom:         ${median.toFixed(3)}`,
  `headroom < 0.05:         ${sorted.filter(h => h < 0.05).length}`,
  `minimum headroom:        ${min.toFixed(3)} (${bounds.filter(b => b.headroom === min).map(b => b.at).join(', ')})`,
  `fractional score answers: ${scores.filter(a => !Number.isInteger(a.score)).length} of ${scores.length}`,
]
process.stdout.write(lines.join('\n') + '\n')
