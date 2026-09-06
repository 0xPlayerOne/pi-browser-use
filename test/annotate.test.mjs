import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLEANUP_ANNOTATIONS,
  formatAnnotatedMap,
  INJECT_ANNOTATIONS,
  parseAnnotatedElements,
} from '../dist/annotate.js'
import { diagnose, formatDoctorReport } from '../dist/doctor.js'

describe('annotate', () => {
  it('injects numbered badges and cleans them up', () => {
    assert.match(INJECT_ANNOTATIONS, /data-pi-annotate/)
    assert.match(INJECT_ANNOTATIONS, /getBoundingClientRect/)
    assert.match(CLEANUP_ANNOTATIONS, /data-pi-annotate/)
  })

  it('parses fenced evaluate output into a coordinate map', () => {
    const text =
      'Script ran on page and returned:\n```json\n[{"n":1,"x":10,"y":20,"tag":"button","text":"Save"}]\n```'
    assert.deepEqual(parseAnnotatedElements(text), [
      { n: 1, x: 10, y: 20, tag: 'button', text: 'Save' },
    ])
    assert.equal(
      formatAnnotatedMap(parseAnnotatedElements(text)),
      '1: (10, 20) button "Save"'
    )
  })

  it('returns empty results on malformed output', () => {
    assert.deepEqual(parseAnnotatedElements('no json here'), [])
    assert.deepEqual(parseAnnotatedElements('Script ran:\n```json\nnull\n```'), [])
    assert.equal(formatAnnotatedMap([]), 'No interactive elements annotated.')
  })
})

describe('doctor', () => {
  it('reports an isolated headless session that launches Chrome', async () => {
    const report = await diagnose({ sessionMode: 'isolated', headless: true }, async () => [
      'list_pages',
      'take_snapshot',
    ])
    assert.equal(report.mode, 'isolated')
    assert.equal(report.headless, true)
    assert.equal(report.launchesChrome, true)
    assert.equal(report.upstreamTools, 2)
    assert.match(formatDoctorReport(report), /launches by|launched by/)
  })

  it('flags attached sessions where launch flags do not apply', async () => {
    const report = await diagnose(
      { sessionMode: 'existing', autoConnect: true },
      async () => []
    )
    assert.equal(report.launchesChrome, false)
    assert.match(formatDoctorReport(report), /do not apply/)
  })
})
