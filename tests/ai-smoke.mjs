/**
 * AI pipeline test: drives `Workbench.runAiJob` with a stubbed model so the
 * prompt construction, chunking, page selection and deliverable building are
 * verified without spending tokens.
 *
 * Usage: node tests/ai-smoke.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
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
const PYROOT = join(
  process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh'),
  'dsh-runtimes',
  'dsh-primary-runtime',
  'dependencies',
  'python',
)
const python = join(BUNDLE, 'engine', 'runtime', 'python', 'bin', 'python3.12')

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

function makePdf(path, pages, { chars = 200, scan = false } = {}) {
  // Keep every line inside the 842pt media box so extraction really sees it.
  const lines = Math.min(44, Math.max(1, Math.ceil(chars / 110)))
  const repeat = Math.max(1, Math.round(chars / (lines * 12)))
  const script = [
    "import sys; sys.path.insert(0, r'" + join(BUNDLE, 'engine', 'runtime', 'pylib') + "')",
    'import pymupdf',
    'd = pymupdf.open()',
    'for i in range(' + pages + '):',
    '    p = d.new_page(width=595, height=842)',
    scan
      ? '    p.draw_rect(pymupdf.Rect(40, 40, 540, 780), color=(0.85,0.85,0.85), fill=(0.85,0.85,0.85))'
      : [
          "    p.insert_text((60, 90), 'Chapter %d 第%d章' % (i + 1, i + 1), fontsize=18)",
          '    for k in range(' + lines + '):',
          "        p.insert_text((60, 130 + k * 15), ('段落文字 ABCDEFG 数据分析 %d ' % k) * " + repeat + ', fontsize=7)',
        ].join('\n'),
    'd.save(r\'' + path + "')",
  ].join('\n')
  execFileSync(python, ['-c', script], { env: { ...process.env, PYTHONHOME: PYROOT } })
}

/* ---------------------------------------------------------------- stub model */

const calls = []
const stubLlm = {
  async prepareCall({ provider, model }) {
    return {
      stream(options) {
        calls.push({ provider, model, options })
        const prompt = options.messages
          .map((message) => (message.content ?? []).map((block) => block.text ?? '').join(''))
          .join('\n')
        let answer = `MODEL-ANSWER-${calls.length}`
        if (prompt.includes('抽取要求')) answer = '{"headers":["甲方","乙方"],"rows":[["甲公司","乙公司"],["丙公司","丁公司"]]}'
        else if (prompt.includes('翻译为语言代码')) answer = 'TRANSLATED-BODY'
        else if (prompt.includes('请输出结构化摘要')) answer = '## 核心观点\n摘要内容（第 1 页）'
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: answer }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
  },
}

function makeCtx(withLlm = true) {
  return {
    get(name) {
      if (name === 'llm') return withLlm ? stubLlm : undefined
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'stub-provider', model: 'stub-model' }) }
      return undefined
    },
    effect: (factory) => {
      factory()
    },
    inject: () => () => {},
  }
}

const mod = await import(join(BUNDLE, 'index.js'))
const workbench = new mod.Workbench(makeCtx())
await workbench.initialize()
const workbenchNoLlm = new mod.Workbench(makeCtx(false))
await workbenchNoLlm.initialize()

async function submit(wb, { op, params, inputs = [], sourceIds }) {
  const form = new FormData()
  form.set('op', op)
  form.set('params', JSON.stringify(params ?? {}))
  if (sourceIds) form.set('sourceIds', JSON.stringify(sourceIds))
  for (const input of inputs) form.append('file', new File([await readFile(input.path)], input.name, { type: 'application/pdf' }))
  const response = await wb.handleCreate(new Request('http://127.0.0.1/x/api/pdf-workbench/jobs', { method: 'POST', body: form }))
  const body = await response.json()
  if (!body.ok) return { error: body.error }
  const jobId = body.value.jobId
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = (await (await wb.handleJobGet(new Request(`http://x/api/pdf-workbench/job?id=${jobId}`))).json()).value
    if (['done', 'failed', 'cancelled'].includes(snapshot.status)) return { ...snapshot, sourceIds: body.value.sourceIds }
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  return { status: 'timeout' }
}

const doc = join(import.meta.dirname, 'ai-doc.pdf')
const scanned = join(import.meta.dirname, 'ai-scan.pdf')
const long = join(import.meta.dirname, 'ai-long.pdf')
makePdf(doc, 3, { chars: 400 })
makePdf(scanned, 1, { scan: true })
makePdf(long, 14, { chars: 5200 })

console.log('\n1. ai.summary (small document)')
{
  calls.length = 0
  const job = await submit(workbench, { op: 'ai.summary', params: { style: 'structured', language: 'zh' }, inputs: [{ path: doc, name: 'doc.pdf' }] })
  check('job done', job.status === 'done', JSON.stringify(job.error ?? job.status))
  check('model was called once', calls.length === 1, String(calls.length))
  const prompt = calls[0].options.messages[0].content.map((b) => b.text).join('')
  check('prompt carries page markers', prompt.includes('【第 1 页】'), prompt.slice(0, 120))
  check('prompt carries the structured task', prompt.includes('章节大纲'))
  check('job.text is the model answer', String(job.text).includes('核心观点'), String(job.text).slice(0, 80))
  check('markdown deliverable registered', job.outputs?.some((o) => o.kind === 'md'), JSON.stringify(job.outputs?.map((o) => o.kind)))
}

console.log('\n2. ai.qa multi-turn with sourceIds reuse')
{
  calls.length = 0
  const first = await submit(workbench, { op: 'ai.qa', params: { question: '第一章讲了什么？' }, inputs: [{ path: doc, name: 'doc.pdf' }] })
  check('first turn done', first.status === 'done', JSON.stringify(first.error ?? first.status))
  check('sourceIds returned', Array.isArray(first.sourceIds) && first.sourceIds.length === 1, JSON.stringify(first.sourceIds))
  const second = await submit(workbench, {
    op: 'ai.qa',
    params: {
      question: '再说详细一点',
      history: [
        { role: 'user', content: '第一章讲了什么？' },
        { role: 'assistant', content: String(first.text).slice(0, 200) },
      ],
    },
    sourceIds: first.sourceIds,
  })
  check('follow-up done without re-upload', second.status === 'done', JSON.stringify(second.error ?? second.status))
  const prompt = calls.at(-1).options.messages[0].content.map((b) => b.text).join('')
  check('follow-up prompt carries history', prompt.includes('此前的对话') && prompt.includes('第一章讲了什么'))
  check('follow-up prompt still carries the document', prompt.includes('【第 1 页】'))
}

console.log('\n3. ai.translate builds a deliverable')
{
  calls.length = 0
  const job = await submit(workbench, { op: 'ai.translate', params: { targetLang: 'en', mode: 'bilingual', outputFormat: 'pdf' }, inputs: [{ path: doc, name: 'doc.pdf' }] })
  check('translate done', job.status === 'done', JSON.stringify(job.error ?? job.status))
  check('one model call per page', calls.length === 3, String(calls.length))
  check('pdf deliverable produced', job.outputs?.some((o) => o.kind === 'pdf'), JSON.stringify(job.outputs?.map((o) => [o.kind, o.name])))
  check('text preview contains both sides', String(job.text).includes('第 1 页') && String(job.text).includes('TRANSLATED-BODY'), String(job.text).slice(0, 120))
}

console.log('\n4. ai.extractInfo builds a table')
{
  calls.length = 0
  const job = await submit(workbench, { op: 'ai.extractInfo', params: { instruction: '提取甲方乙方', outputFormat: 'xlsx' }, inputs: [{ path: doc, name: 'doc.pdf' }] })
  check('extract done', job.status === 'done', JSON.stringify(job.error ?? job.status))
  check('xlsx deliverable produced', job.outputs?.some((o) => o.kind === 'xlsx'), JSON.stringify(job.outputs?.map((o) => o.kind)))
  check('markdown table in text', String(job.text).includes('| 甲方 |'), String(job.text).slice(0, 120))
}

console.log('\n5. ai.proofread')
{
  calls.length = 0
  const job = await submit(workbench, { op: 'ai.proofread', params: { strictness: 'strict' }, inputs: [{ path: doc, name: 'doc.pdf' }] })
  check('proofread done', job.status === 'done', JSON.stringify(job.error ?? job.status))
  check('report present', String(job.text).includes('MODEL-ANSWER'), String(job.text).slice(0, 60))
}

console.log('\n6. long document is chunked')
{
  calls.length = 0
  const job = await submit(workbench, { op: 'ai.summary', params: { style: 'structured', language: 'zh' }, inputs: [{ path: long, name: 'long.pdf' }] })
  check('long summary done', job.status === 'done', JSON.stringify(job.error ?? job.status))
  check('multiple map calls plus a reduce call', calls.length >= 3, String(calls.length))
  const reducePrompt = calls.at(-1).options.messages[0].content.map((b) => b.text).join('')
  check('final call is the reduce step', reducePrompt.includes('分段摘要'), reducePrompt.slice(0, 100))
}

console.log('\n7. failure modes')
{
  const noModel = await submit(workbenchNoLlm, { op: 'ai.summary', params: {}, inputs: [{ path: doc, name: 'doc.pdf' }] })
  check('missing model route fails clearly', noModel.status === 'failed' && noModel.error?.code === 'AI_UNAVAILABLE', JSON.stringify(noModel.error))
  check('failure carries a hint', Boolean(noModel.error?.hint))
}
{
  const scanJob = await submit(workbench, { op: 'ai.summary', params: {}, inputs: [{ path: scanned, name: 'scan.pdf' }] })
  check('scanned document reports NO_TEXT', scanJob.status === 'failed' && scanJob.error?.code === 'NO_TEXT', JSON.stringify(scanJob.error))
  check('NO_TEXT hint points at OCR', String(scanJob.error?.hint ?? '').includes('OCR'), String(scanJob.error?.hint))
}

console.log('\n8. retention sweep')
{
  const { existsSync } = await import('node:fs')
  const job = await submit(workbench, { op: 'convert.pdf2text', params: {}, inputs: [{ path: doc, name: 'doc.pdf' }] })
  check('job completed before sweep', job.status === 'done', JSON.stringify(job.error ?? job.status))
  const jobDir = join(workbench.root, job.id)
  check('job directory exists', existsSync(jobDir))
  const record = workbench.jobs.get(job.id)
  record.finishedAt = Date.now() - 25 * 60 * 60 * 1000
  await workbench.sweepExpired()
  check('expired job dropped from memory', !workbench.jobs.has(job.id))
  check('expired job files deleted from disk', !existsSync(jobDir))
}

workbench.dispose()
workbenchNoLlm.dispose()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
