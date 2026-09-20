import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * `scan` answers the first question a new user actually has — "I have a pile of rules in
 * markdown, which of them can this thing do anything with?" — without asking them to
 * produce a JSON Schema first.
 *
 * It is deliberately a READING tool. It does not call a model, does not write files, and
 * does not decide anything: it finds the instruction files a project already has, splits
 * them into candidate rules, sorts those three ways, and prints the next command. The
 * classification is a text heuristic and is wrong sometimes; that is acceptable here and
 * nowhere else in this repo, because nothing downstream consumes it. A human reads the
 * output and picks a file to lift.
 */

/**
 * Where agent harnesses keep their instructions. Fixed list rather than a glob over the
 * whole tree: a repo-wide walk for "*.md" finds every README and changelog in
 * `node_modules`, and the signal-to-noise of that is zero. These are the paths the
 * harnesses themselves document.
 */
const FILES = [
  'CLAUDE.md', 'CLAUDE.local.md',
  'AGENTS.md', 'AGENT.md',
  'GEMINI.md',
  '.cursorrules',
  '.windsurfrules',
  '.github/copilot-instructions.md',
  '.clinerules',
]

/** Directories whose every `*.md` (Claude Code) or `*.mdc` (Cursor) file is instructions. */
const DIRS: Array<{ dir: string; ext: string }> = [
  { dir: '.claude/skills', ext: '.md' },
  { dir: '.claude/agents', ext: '.md' },
  { dir: '.claude/commands', ext: '.md' },
  { dir: '.claude/rules', ext: '.md' },
  { dir: '.cursor/rules', ext: '.mdc' },
]

export type RuleKind = 'decidable' | 'procedure' | 'generation'

export interface ScannedRule {
  line: number
  text: string
  kind: RuleKind
  /** The word that decided the classification, so the output can justify itself. */
  because: string
}

export interface ScannedFile {
  path: string
  rules: ScannedRule[]
}

/**
 * Classification keys on the rule's HEAD VERB, not on the first keyword anywhere in the
 * sentence. Scanning for keywords anywhere gets the common case backwards: "NEVER commit
 * unless the user explicitly asks. Produce the message; let the human run it." contains
 * `run`, so a first-match-wins scan files the repo's strongest prohibition as procedure.
 * The head verb is what the rule is actually asking for.
 */

/** Modals and adverbs that sit in front of the verb. Stripped so the head verb is visible. */
const LEAD = /^(?:(?:you|we|it|they)\s+)?(?:(?:never|always|please|do\s+not|do|don'?t|must\s+not|must|should\s+not|shouldn'?t|should|may\s+not|may|can\s?not|cannot|can|will\s+not|will|only|avoid|prefer|ensure|make\s+sure)\s+)+/i

/**
 * Generation verbs in head position. A rule whose ask is "produce this text" can never
 * compile — Jev returns probabilities and emits no strings — so this is checked first and
 * the answer is a flat no, not a warning.
 */
const GENERATION_HEAD = /^(write|draft|compose|summari[sz]e|explain|describe|generate|rephrase|translate|paraphrase|document|report|respond|reply|answer|comment|annotate|narrate|phrase)\b/i

/** The same verbs plus the nouns of prose, matched anywhere as a weaker fallback. */
const GENERATION = /\b(write|draft|compose|summari[sz]e|explain|describe|generate|rephrase|translate|respond with|reply with|answer in|phrase|word it|prose|wording|tone)\b/i

/** Prohibition, obligation and approval — the shapes that become a typed question. */
const DECIDABLE = /\b(never|always|do not|don'?t|must not|must|may not|should not|shouldn'?t|only|forbidden|prohibited|disallow|require[sd]?|needs?|ensure|avoid|no |not allowed|ask (?:before|first|the user)|approval|sign-?off|human in the loop)\b/i

/** Ordering and mechanics: real instructions, but control flow, so they stay in the prompt. */
const PROCEDURE = /\b(before|after|first|then|finally|run|execute|invoke|install|cd |activate|re-?read|open|prefer .* over|use \S+ (not|instead|over)|step \d)\b/i

/**
 * Whether a line is a candidate rule at all. Instruction files are mostly not rules —
 * they are headings, fences, tables, links and blank lines — and counting those as rules
 * makes every summary meaningless. A rule is a prose line with a verb in it.
 */
function isCandidate(line: string): boolean {
  const t = line.trim()
  if (t.length < 12) return false                 // same floor as a provenance quote
  if (/^(#{1,6}\s|```|\||>\s|<!--|---|===)/.test(t)) return false
  if (/^\[.*\]:\s*http/.test(t)) return false     // link reference definition
  return /[a-z]/.test(t)
}

/** Strip the list bullet, checkbox and bold run-in so the classifier sees the sentence. */
function normalise(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*\[[ xX]\]\s+/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .trim()
}

function classify(text: string): { kind: RuleKind; because: string } {
  // "Always explain your reasoning" is an obligation whose object is text, so it is
  // generation despite the `always`. "Never run a command that deletes data" is a
  // prohibition whose object is an action, so it is decidable despite the `run`.
  const head = GENERATION_HEAD.exec(text.replace(LEAD, ''))
  if (head) return { kind: 'generation', because: head[0].trim() }

  const dec = DECIDABLE.exec(text)
  if (dec) return { kind: 'decidable', because: dec[0].trim() }

  const gen = GENERATION.exec(text)
  if (gen) return { kind: 'generation', because: gen[0].trim() }

  const proc = PROCEDURE.exec(text)
  if (proc) return { kind: 'procedure', because: proc[0].trim() }
  return { kind: 'procedure', because: 'no directive word' }
}

/**
 * Rules found in one document. Exported so a caller can scan a file the fixed list does
 * not know about — an in-house harness, a prompt kept somewhere else.
 */
export function scanText(text: string): ScannedRule[] {
  const out: ScannedRule[] = []
  let inFence = false
  text.split(/\r\n|\r|\n/).forEach((raw, i) => {
    // Code inside a fence is an example, not a rule, and it is dense in exactly the verbs
    // the classifier keys on (`run`, `install`, `cd`). Counting it inflates `procedure`
    // and buries the real rules.
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; return }
    if (inFence || !isCandidate(raw)) return
    const t = normalise(raw)
    if (t === '') return
    out.push({ line: i + 1, text: t, ...classify(t) })
  })
  return out
}

function listDir(root: string, dir: string, ext: string): string[] {
  const found: string[] = []
  const walk = (d: string) => {
    let entries: string[]
    try { entries = readdirSync(d) } catch { return }
    for (const e of entries) {
      const p = join(d, e)
      let s
      try { s = statSync(p) } catch { continue }
      if (s.isDirectory()) walk(p)
      else if (e.endsWith(ext)) found.push(p)
    }
  }
  walk(join(root, dir))
  return found.map(p => relative(root, p).split(sep).join('/')).sort()
}

/** Every instruction file under `root`, with its rules classified. */
export function scanProject(root: string): ScannedFile[] {
  const paths: string[] = []
  for (const f of FILES) {
    try { if (statSync(join(root, f)).isFile()) paths.push(f) } catch { /* absent */ }
  }
  for (const { dir, ext } of DIRS) paths.push(...listDir(root, dir, ext))

  const out: ScannedFile[] = []
  for (const p of paths) {
    let text: string
    try { text = readFileSync(join(root, p), 'utf8') } catch { continue }
    const rules = scanText(text)
    if (rules.length > 0) out.push({ path: p, rules })
  }
  return out
}

export const countBy = (rules: ScannedRule[], kind: RuleKind) =>
  rules.filter(r => r.kind === kind).length

/**
 * The human report. Written here rather than in cli.ts so the shape is testable without
 * a child process, and so the one place that decides what a new user reads first is one
 * function.
 */
export function renderScan(root: string, files: ScannedFile[]): string {
  if (files.length === 0) {
    return [
      `No instruction files found in ${root}.`,
      '',
      'jevc scan looks for the files agent harnesses read:',
      `  ${FILES.join(', ')}`,
      `  ${DIRS.map(d => `${d.dir}/**/*${d.ext}`).join(', ')}`,
      '',
      'Point it at a project that has one, or lift any document directly:',
      '  jevc compile path/to/rules.md --lift',
      '',
    ].join('\n')
  }

  const pad = Math.max(...files.map(f => f.path.length))
  const rows = files.map(f => {
    const d = countBy(f.rules, 'decidable')
    const p = countBy(f.rules, 'procedure')
    const g = countBy(f.rules, 'generation')
    return { f, d, line: `  ${f.path.padEnd(pad)}  ${String(f.rules.length).padStart(4)} rules  ${String(d).padStart(4)} decidable  ${String(p).padStart(4)} procedure  ${String(g).padStart(4)} generation` }
  })

  const totalRules = files.reduce((n, f) => n + f.rules.length, 0)
  const totalDecidable = rows.reduce((n, r) => n + r.d, 0)
  const best = [...rows].sort((a, b) => b.d - a.d)[0]

  const out: string[] = []
  out.push(`${root}`, '')
  out.push(...rows.map(r => r.line))
  out.push('')
  out.push(`${totalRules} rules across ${files.length} file${files.length === 1 ? '' : 's'}. ${totalDecidable} look decidable — those are the ones that can become typed Jev questions.`)

  if (totalDecidable > 0) {
    out.push('', `Start with ${best.f.path}, which has the most:`, '')
    for (const r of best.f.rules.filter(x => x.kind === 'decidable').slice(0, 5)) {
      out.push(`  ${String(r.line).padStart(4)}  ${r.text.length > 84 ? `${r.text.slice(0, 83)}…` : r.text}`)
    }
    const more = countBy(best.f.rules, 'decidable') - 5
    if (more > 0) out.push(`  ${' '.repeat(4)}  … and ${more} more`)
    // Joined with `root`, because the paths above are relative to the scanned directory
    // and this line is meant to be copy-pasted from the same shell that ran the scan.
    const next = root === '.' ? best.f.path : `${root.replace(/\/$/, '')}/${best.f.path}`
    out.push('', 'Next:', '', `  jevc compile ${next} --lift`, '', '  Hand the request it prints to the agent you already have open. No second API key.', '')
  } else {
    out.push('', 'Nothing here is decidable — these files are procedure and prose, which is a fine', 'answer. jevc compiles judgment calls, not instructions.', '')
  }

  out.push('Classification is a text heuristic, so read the list rather than trusting the counts:')
  out.push('a rule asking for written output is `generation`, one describing an order of steps is')
  out.push('`procedure`, and everything else with a directive word in it is `decidable`. The lift')
  out.push('step is where a model and then a human decide what actually becomes a question.')
  out.push('')
  return out.join('\n')
}
