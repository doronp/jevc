#!/usr/bin/env node
/**
 * Regenerate `examples/GALLERY.md` from `fixtures/`. The gallery is generated rather than
 * written so it cannot drift from the recordings `npm test` asserts against — a hand-kept
 * gallery is a second copy of every number in the corpus, and the second copy is always
 * the one that rots.
 */
import { writeFileSync } from 'node:fs'
import { loadFixtures } from '../src/check.js'
import { renderGallery } from '../src/show.js'

const out = 'examples/GALLERY.md'
writeFileSync(out, renderGallery(loadFixtures('fixtures')))
process.stderr.write(`wrote ${out}\n`)
