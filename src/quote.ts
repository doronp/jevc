/** A server-chosen string (a model ID), as it may be printed. It lands on a terminal and in
 * logs: JSON-quoted so an escape sequence arrives as \u001b (JSON leaves DEL and C1 alone, so
 * those are escaped by hand), and cut at 64 characters because a server that echoes the request
 * can put the whole state here. No Jev ID comes near 64. Matching still uses the whole string.
 *
 * Its own module so that `validateResponse` and `scripts/rerecord.ts` share one quoter without
 * it joining the package API: `index.ts` re-exports everything in `contract.ts`, and nothing
 * here. */
export const quoted = (s: string): string =>
  JSON.stringify(s.length > 64 ? `${s.slice(0, 64)}…` : s)
    .replace(/[\u007f-\u009f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
