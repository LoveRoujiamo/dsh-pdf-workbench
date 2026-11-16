/**
 * Host integration smoke test: drives the real `/api/pdf-workbench/*` route
 * handlers in-process, without the web carrier or a browser.
 *
 * Usage: node tests/host-smoke.mjs [--engine]
 *   --engine also exercises a real job (needs engine/pdf_engine.py + engine/runtime).
 */

import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** First DSH runtime Python root under $DSH_HOME, or the env override. */
function detectPythonRoot() {
  if (process.env.PDFW_PYTHON_ROOT) return process.env.PDFW_PYTHON_ROOT
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  const runtimes = join(home, 'dsh-runtimes')
  try {
    for (const name of readdirSync(runtimes)) {
      const candidate = join(runtimes, name, 'dependencies', 'python')
      if (existsSync(join(candidate, 'lib', 'python3.12'))) return candidate
    }
  } catch {}
  return ''
}

const BUNDLE = join(import.meta.dirname, '..')
const withEngine = process.argv.includes('--engine')

/* ------------------------------------------------------------------ harness */

const routes = new Map()
const routePaths = new Set()
const registered = []

const fakeCtx = {
  get: () => undefined,
  inject: (deps, callback) => {
    for (const dep of deps) registered.push(dep)
    callback({
      effect: (factory) => {
        factory()
      },
      connection: {
        fetch: {
          // Mirrors the real registry: keyed by path alone, throws on a duplicate.
          // Without this, a GET/DELETE collision stays invisible in tests.
          register: (route) => {
            if (routePaths.has(route.path)) {
              throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
            }
            routePaths.add(route.path)
            routes.set(`${route.methods.join(',')} ${route.path}`, route)
            return async () => {}
          },
        },
      },
    })
    return () => {}
  },
  effect: (factory) => {
    factory()
  },
}

const mod = await import(join(BUNDLE, 'index.js'))
mod.apply(fakeCtx)
await new Promise((resolve) => setTimeout(resolve, 2500)) // let probeEngine settle

let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function call(method, path, init = {}) {
  const bare = path.split('?')[0]
  const route = routes.get(`${method} ${bare}`)
  if (!route) throw new Error(`route not registered: ${method} ${bare}`)
  const request = new Request(`http://127.0.0.1:9999${path}`, { method, ...init })
  const response = await route.fetch(request)
  const clone = response.clone()
  let body = null
  const type = response.headers.get('content-type') ?? ''
  if (type.includes('application/json')) body = await clone.json()
  else if (type.startsWith('text/')) body = await clone.text()
  return { status: response.status, type, body, response }
}

/* -------------------------------------------------------------------- tests */

console.log('route table')
{
  const table = mod.routeTable()
  const paths = table.map((entry) => entry.split(' ')[1])
  check('every route path is unique (registry is keyed by path)', new Set(paths).size === paths.length, JSON.stringify(table))
  check('all routes live under /api/', paths.every((entry) => entry.startsWith('/api/')), JSON.stringify(paths))
  check('cancel has its own path', table.includes('DELETE /api/pdf-workbench/cancel'))
}

console.log('routes registered:')
for (const key of routes.keys()) console.log(`  · ${key}`)

console.log('\n1. catalog')
{
  const { status, body } = await call('GET', '/api/pdf-workbench/catalog')
  check('status 200', status === 200, String(status))
  check('ok envelope', body?.ok === true)
  check('four groups', body?.value?.groups?.length === 4, JSON.stringify(body?.value?.groups?.map((g) => g.id)))
  const ops = body?.value?.operations ?? []
  check('operations >= 25', ops.length >= 25, String(ops.length))
  check('every op has fields', ops.every((op) => Array.isArray(op.fields)))
  check('groups reference known ops', body.value.groups.every((g) => g.operations.every((id) => ops.some((op) => op.id === id))))
  const ids = new Set(ops.map((op) => op.id))
  check('required V1.1 ops present', [
    'page.resize',
    'page.batchResize',
    'page.crop',
    'convert.pdf2word',
    'ai.summary',
    'ai.qa',
  ].every((id) => ids.has(id)))
  check('limits 100MB / 20 files', body.value.limits.maxFileBytes === 104857600 && body.value.limits.maxBatchFiles === 20)
  const withSizeCap = ['edit.merge', 'convert.toPDF', 'page.batchResize']
  check('size-cap switch exposed on every bulk PDF op',
    withSizeCap.every((id) => (ops.find((entry) => entry.id === id)?.fields ?? []).some((field) => field.key === 'limitSize')),
    JSON.stringify(withSizeCap.map((id) => [id, (ops.find((o) => o.id === id)?.fields ?? []).map((f) => f.key)])))
  check('compress tool offers its own target mode', (ops.find((entry) => entry.id === 'edit.compress')?.fields ?? []).some((field) => field.key === 'targetSizeMB'))
}

console.log('\n2. info')
{
  const { status, body } = await call('GET', '/api/pdf-workbench/info')
  check('status 200', status === 200)
  check('version present', typeof body?.value?.version === 'string')
  check('retention 24h', body?.value?.retentionHours === 24)
  if (withEngine) check('engine capability reported', body?.value?.capabilities?.pymupdf === true, JSON.stringify(body?.value?.capabilities))
}

console.log('\n3. error handling')
{
  const { status, body } = await call('GET', '/api/pdf-workbench/job?id=does-not-exist')
  check('unknown job is 400', status === 400, String(status))
  check('error envelope', body?.ok === false && body?.error?.code === 'JOB_NOT_FOUND')
  check('error carries a hint', typeof body?.error?.hint === 'string')
}
{
  const form = new FormData()
  form.set('op', 'nope.nothing')
  form.set('params', '{}')
  const { status, body } = await call('POST', '/api/pdf-workbench/jobs', { body: form })
  check('unknown op rejected', status === 400 && body?.error?.code === 'UNKNOWN_OP', JSON.stringify(body))
}
{
  const form = new FormData()
  form.set('op', 'edit.merge')
  form.set('params', '{}')
  const { status, body } = await call('POST', '/api/pdf-workbench/jobs', { body: form })
  check('missing files rejected', status === 400 && body?.error?.code === 'NO_FILES', JSON.stringify(body))
}
{
  const form = new FormData()
  form.set('op', 'edit.encrypt')
  form.set('params', '{}')
  form.set('file', new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'x.pdf', { type: 'application/pdf' }))
  const { status, body } = await call('POST', '/api/pdf-workbench/jobs', { body: form })
  check('missing required param rejected', status === 400 && body?.error?.code === 'MISSING_PARAM', JSON.stringify(body))
}

if (withEngine) {
  console.log('\n4. real job: edit.merge on a generated PDF')
  const fitz = await import('node:child_process')
  const { execFileSync } = fitz
  const PYROOT = detectPythonRoot()
  const python = join(BUNDLE, 'engine', 'runtime', 'python', 'bin', 'python3.12')
  const sample = join(import.meta.dirname, 'sample.pdf')
  execFileSync(python, [
    '-c',
    [
      "import sys; sys.path.insert(0, r'" + join(BUNDLE, 'engine', 'runtime', 'pylib') + "')",
      'import pymupdf',
      "d = pymupdf.open()",
      "for i in range(3):",
      "    p = d.new_page(width=595, height=842)",
      "    p.insert_text((72, 100), 'PDF workbench page %d' % (i + 1), fontsize=18)",
      "d.save(r'" + sample + "')",
    ].join('\n'),
  ], { env: { ...process.env, PYTHONHOME: PYROOT } })

  const bytes = await readFile(sample)
  const form = new FormData()
  form.set('op', 'edit.merge')
  form.set('params', JSON.stringify({ addBookmarks: true }))
  form.append('file', new File([bytes], 'a.pdf', { type: 'application/pdf' }))
  form.append('file', new File([bytes], '合同 B.pdf', { type: 'application/pdf' }))
  const created = await call('POST', '/api/pdf-workbench/jobs', { body: form })
  check('job accepted', created.status === 200 && Boolean(created.body?.value?.jobId), JSON.stringify(created.body))
  const jobId = created.body?.value?.jobId
  let snapshot = null
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const polled = await call('GET', `/api/pdf-workbench/job?id=${jobId}`)
    snapshot = polled.body?.value
    if (snapshot && ['done', 'failed', 'cancelled'].includes(snapshot.status)) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  check('job finished', snapshot?.status === 'done', `${snapshot?.status} ${JSON.stringify(snapshot?.error)}`)
  const output = snapshot?.outputs?.[0]
  check('merged PDF produced', output?.kind === 'pdf', JSON.stringify(output))
  check('merged page count is 6', output?.pages === 6, String(output?.pages))
  if (output) {
    const download = await call('GET', `/api/pdf-workbench/file?job=${jobId}&file=${output.id}`)
    check('download streams a PDF', download.status === 200 && download.type === 'application/pdf')
    const buffer = new Uint8Array(await download.response.arrayBuffer())
    check('download starts with %PDF', String.fromCharCode(...buffer.slice(0, 4)) === '%PDF')
    const disposition = download.response.headers.get('content-disposition') ?? ''
    check('unicode filename is RFC5987 encoded', /filename\*=UTF-8''/.test(disposition) && disposition.includes('attachment'), disposition)
    const pages = await call('GET', `/api/pdf-workbench/pages?job=${jobId}&file=${output.id}`)
    check('pages endpoint reports 6', pages.body?.value?.count === 6, JSON.stringify(pages.body))
    const preview = await call('GET', `/api/pdf-workbench/preview?job=${jobId}&file=${output.id}&page=1&w=400`)
    check('preview renders PNG', preview.status === 200 && preview.type === 'image/png', `${preview.status} ${preview.type}`)
  }

  console.log('\n5. V1.1 page layout features')
  const fs = { readFile, writeFile: (await import('node:fs/promises')).writeFile }
  const makePdf = (out, pages, label) => {
    execFileSync(python, ['-c', [
      "import sys; sys.path.insert(0, r'" + join(BUNDLE, 'engine', 'runtime', 'pylib') + "')",
      'import pymupdf',
      'd = pymupdf.open()',
      'for i in range(' + pages + '):',
      '    p = d.new_page(width=595, height=842)',
      "    p.insert_text((72, 100), '" + label + " page %d' % (i + 1), fontsize=18)",
      "    p.insert_text((72, 140), 'Body text for resizing test', fontsize=12)",
      'd.save(r\'' + out + '\')',
    ].join('\n')], { env: { ...process.env, PYTHONHOME: PYROOT } })
  }
  const waitJob = async (jobId) => {
    let snapshot = null
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const polled = await call('GET', `/api/pdf-workbench/job?id=${jobId}`)
      snapshot = polled.body?.value
      if (snapshot && ['done', 'failed', 'cancelled'].includes(snapshot.status)) return snapshot
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return snapshot
  }

  const src = join(import.meta.dirname, 'layout.pdf')
  makePdf(src, 4, 'Layout')
  const srcBytes = await fs.readFile(src)

  {
    const form = new FormData()
    form.set('op', 'page.resize')
    form.set('params', JSON.stringify({ sizePreset: 'A5', fitMode: 'scale', orientation: 'auto', margin: 0, background: '#ffffff', keepMetadata: true }))
    form.append('file', new File([srcBytes], 'layout.pdf', { type: 'application/pdf' }))
    const created = await call('POST', '/api/pdf-workbench/jobs', { body: form })
    const snapshot = await waitJob(created.body?.value?.jobId)
    check('page.resize done', snapshot?.status === 'done', JSON.stringify(snapshot?.error))
    const out = snapshot?.outputs?.[0]
    check('page.resize produced A5 (420x595pt)', out?.kind === 'pdf', JSON.stringify(out))
    const pages = await call('GET', `/api/pdf-workbench/pages?job=${snapshot.id}&file=${out?.id}`)
    const dims = pages.body?.value?.pages?.[0]
    check('resized page is A5', Math.abs(dims?.width - 419.5) < 2 && Math.abs(dims?.height - 595.3) < 2, JSON.stringify(dims))
    const preview = await call('GET', `/api/pdf-workbench/preview?job=${snapshot.id}&file=${out?.id}&page=1&w=300`)
    check('resized page previews', preview.status === 200 && preview.type === 'image/png')
  }

  {
    const bad = join(import.meta.dirname, 'broken.pdf')
    await fs.writeFile(bad, Buffer.from('%PDF-1.4 not really a pdf'))
    const goodSmall = join(import.meta.dirname, 'layout2.pdf')
    makePdf(goodSmall, 2, 'Batch')
    const form = new FormData()
    form.set('op', 'page.batchResize')
    form.set('params', JSON.stringify({ sizePreset: 'A4', fitMode: 'scale', orientation: 'auto', zipOutput: true }))
    form.append('file', new File([await fs.readFile(goodSmall)], 'good.pdf', { type: 'application/pdf' }))
    form.append('file', new File([await fs.readFile(bad)], 'broken.pdf', { type: 'application/pdf' }))
    const created = await call('POST', '/api/pdf-workbench/jobs', { body: form })
    const snapshot = await waitJob(created.body?.value?.jobId)
    check('batchResize survives a bad input', snapshot?.status === 'done', JSON.stringify(snapshot?.error))
    check('batch items: 1 ok + 1 failed', snapshot?.items?.length === 2 && snapshot.items.filter((i) => i.ok).length === 1 && snapshot.items.filter((i) => !i.ok).length === 1, JSON.stringify(snapshot?.items?.map((i) => [i.input, i.ok, i.error?.code])))
    const failedItem = snapshot?.items?.find((i) => !i.ok)
    check('failed item carries a retryable reason', Boolean(failedItem?.error?.code), JSON.stringify(failedItem?.error))
    check('batch produced a zip', snapshot?.outputs?.some((o) => o.kind === 'zip'), JSON.stringify(snapshot?.outputs?.map((o) => o.kind)))
  }

  {
    const form = new FormData()
    form.set('op', 'page.crop')
    form.set('params', JSON.stringify({ cropMode: 'manual', uniform: true, marginTop: 10, marginBottom: 10, marginLeft: 15, marginRight: 15, safetyMargin: 2 }))
    form.append('file', new File([srcBytes], 'layout.pdf', { type: 'application/pdf' }))
    const created = await call('POST', '/api/pdf-workbench/jobs', { body: form })
    const snapshot = await waitJob(created.body?.value?.jobId)
    check('page.crop done', snapshot?.status === 'done', JSON.stringify(snapshot?.error))
    const out = snapshot?.outputs?.[0]
    const pages = await call('GET', `/api/pdf-workbench/pages?job=${snapshot.id}&file=${out?.id}`)
    const dims = pages.body?.value?.pages?.[0]
    check('cropped page is smaller', dims && dims.width < 595 && dims.height < 842, JSON.stringify(dims))
  }

  console.log('\n5b. engine warnings reach the browser')
  {
    const blank = join(import.meta.dirname, 'blank-page.pdf')
    execFileSync(python, ['-c', [
      "import sys; sys.path.insert(0, r'" + join(BUNDLE, 'engine', 'runtime', 'pylib') + "')",
      'import pymupdf',
      'd = pymupdf.open()',
      "p = d.new_page(width=595, height=842)",
      "p.insert_text((72, 120), 'Only page with content', fontsize=16)",
      "d.new_page(width=595, height=842)",                 // deliberately blank
      "d.save(r'" + blank + "')",
    ].join('\n')], { env: { ...process.env, PYTHONHOME: PYROOT } })
    const form = new FormData()
    form.set('op', 'page.crop')
    form.set('params', JSON.stringify({ cropMode: 'auto', uniform: false, safetyMargin: 2, threshold: 245 }))
    form.append('file', new File([await readFile(blank)], 'blank-page.pdf', { type: 'application/pdf' }))
    const created = await call('POST', '/api/pdf-workbench/jobs', { body: form })
    const snapshot = await waitJob(created.body?.value?.jobId)
    check('crop on a blank page still completes', snapshot?.status === 'done', JSON.stringify(snapshot?.error))
    check('snapshot always carries a warnings array', Array.isArray(snapshot?.warnings), JSON.stringify(snapshot?.warnings))
    check('blank-page note is surfaced', (snapshot?.warnings ?? []).length > 0, JSON.stringify(snapshot?.warnings))
  }

  console.log('\n5c. output size cap reaches the engine and the browser')
  {
    const form = new FormData()
    form.set('op', 'edit.merge')
    form.set('params', JSON.stringify({ addBookmarks: true, limitSize: true, targetSizeMB: 0.3 }))
    form.append('file', new File([srcBytes], 'a.pdf', { type: 'application/pdf' }))
    form.append('file', new File([srcBytes], 'b.pdf', { type: 'application/pdf' }))
    const created = await call('POST', '/api/pdf-workbench/jobs', { body: form })
    const snapshot = await waitJob(created.body?.value?.jobId)
    check('size-capped merge completes', snapshot?.status === 'done', JSON.stringify(snapshot?.error))
    const out = snapshot?.outputs?.[0]
    const target = Math.round(0.3 * 1024 * 1024)
    check('target size reaches the engine', out?.targetBytes === target, JSON.stringify(out?.targetBytes))
    check('result reports whether the target was met', out?.targetReached === true, JSON.stringify(out?.targetReached))
    check('audit carries the pre-cap size', Number(out?.originalBytes) >= Number(out?.bytes), JSON.stringify([out?.originalBytes, out?.bytes]))
    check('output honours the cap', Number(out?.bytes) <= target, JSON.stringify([out?.bytes, target]))
  }

  console.log('\n6. retention + cancellation')
  {
    const form = new FormData()
    form.set('op', 'convert.pdf2image')
    form.set('params', JSON.stringify({ format: 'png', dpi: 150 }))
    form.append('file', new File([srcBytes], 'layout.pdf', { type: 'application/pdf' }))
    const created = await call('POST', '/api/pdf-workbench/jobs', { body: form })
    const cancelled = await call('DELETE', `/api/pdf-workbench/cancel?id=${created.body?.value?.jobId}`)
    check('cancel returns cancelled:true', cancelled.body?.value?.cancelled === true)
    const snapshot = await waitJob(created.body?.value?.jobId)
    check('cancelled job settles as cancelled or done', ['cancelled', 'done'].includes(snapshot?.status), String(snapshot?.status))
  }

} else {
  console.log('\n4. real job — skipped (pass --engine to run)')
}

console.log('\n7. limits and filenames')
{
  const form = new FormData()
  form.set('op', 'edit.merge')
  form.set('params', 'not-json')
  form.append('file', new File([new Uint8Array([1])], 'a.pdf', { type: 'application/pdf' }))
  const { status, body } = await call('POST', '/api/pdf-workbench/jobs', { body: form })
  check('malformed params rejected', status === 400 && body?.error?.code === 'BAD_PARAMS', JSON.stringify(body?.error))
}
{
  const form = new FormData()
  form.set('op', 'edit.batchResize'.replace('edit.', 'page.'))
  form.set('params', '{}')
  for (let index = 0; index < 21; index += 1) {
    form.append('file', new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], `f${index}.pdf`, { type: 'application/pdf' }))
  }
  const { status, body } = await call('POST', '/api/pdf-workbench/jobs', { body: form })
  check('21 files rejected by the 20-file limit', status === 400 && body?.error?.code === 'TOO_MANY_FILES', JSON.stringify(body?.error))
}
{
  const form = new FormData()
  form.set('op', 'convert.pdf2text')
  form.set('params', '{}')
  form.append('file', new File([new Uint8Array(1024)], '合同 2026（终稿）.pdf', { type: 'application/pdf' }))
  const { status, body } = await call('POST', '/api/pdf-workbench/jobs', { body: form })
  check('unicode filename accepted at submit', status === 200, JSON.stringify(body?.error))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
