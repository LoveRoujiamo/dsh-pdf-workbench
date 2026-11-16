/**
 * PDF 全能工具台 / PDF Workbench — Host half.
 *
 * Owns three things:
 *   1. the same-origin `/api/pdf-workbench/*` endpoints the browser workbench talks to,
 *   2. the job store (upload staging, engine execution, result files, 24h retention),
 *   3. the AI pipeline that pipes extracted document text through the configured model.
 *
 * The PDF engine runs as a child Python process so a malformed document can never
 * take the Harness process down with it.
 */

import { spawn } from 'node:child_process'
import { appendFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import { catalogView, findOperation, LIMITS } from './catalog.js'

const VERSION = '1.0.0'
const HERE = dirname(fileURLToPath(import.meta.url))
const ENGINE = join(HERE, 'engine', 'pdf_engine.py')
const API = '/api/pdf-workbench'
const RETENTION_MS = LIMITS.retentionMs
const MAX_TOTAL_BYTES = LIMITS.maxBatchBytes
/** Pages a single translation run will pay for; documented in the UI help text. */
const TRANSLATE_PAGE_BUDGET = 80
/** Characters of document text handed to one model call. */
const AI_CHUNK_CHARS = 38000
const AI_QA_CHARS = 55000

const MIME = {
  pdf: 'application/pdf',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

const KIND_BY_EXT = {
  '.pdf': 'pdf',
  '.zip': 'zip',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.txt': 'text',
  '.md': 'md',
  '.csv': 'json',
  '.json': 'json',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.pptx': 'pptx',
}

/** A failure the browser can act on: machine code, human message, retry hint. */
class WorkbenchError extends Error {
  constructor(code, message, hint = '') {
    super(message)
    this.code = code
    this.hint = hint
  }
}

/* ------------------------------------------------------------------ helpers */

/** Temporary activation diagnostics: appends one line to <tmp>/dsh-pdf-workbench/diag.log. */
function diag(message) {
  try {
    const dir = join(tmpdir(), 'dsh-pdf-workbench')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'diag.log'), `${new Date().toISOString()} pid=${process.pid} ${message}\n`)
  } catch {
    /* diagnostics must never break activation */
  }
}

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

const okValue = (value) => jsonResponse(200, { ok: true, value })
const failValue = (error, status = 400) =>
  jsonResponse(status, {
    ok: false,
    error: {
      code: error.code ?? 'INTERNAL',
      message: error.message || '处理失败',
      hint: error.hint || '',
    },
  })

const sanitizeName = (name) =>
  (name || 'document')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120) || 'document'

const baseNameOf = (name) => {
  const base = sanitizeName(basename(String(name || 'document')))
  const ext = extname(base)
  return ext ? base.slice(0, -ext.length) || 'document' : base
}

const kindOf = (name) => KIND_BY_EXT[extname(String(name || '')).toLowerCase()] ?? 'file'

const fmtBytes = (n) => (n > 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

function contentDisposition(kind, name, inline) {
  const safe = sanitizeName(name)
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_')
  const encoded = encodeURIComponent(safe)
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/**
 * Where the Python half lives. Nothing here ships in the repository.
 *
 *   - a development checkout keeps it beside the engine (`engine/runtime`),
 *   - an installed package (npm / GitHub) uses `$DSH_HOME/pdf-workbench-runtime`,
 *     because a package directory is read-only, replaceable code.
 * `PDFW_RUNTIME_DIR` overrides both.
 */
function runtimeHome() {
  if (process.env.PDFW_RUNTIME_DIR) return process.env.PDFW_RUNTIME_DIR
  const bundled = join(HERE, 'engine', 'runtime')
  if (existsSync(join(bundled, 'python', 'bin', 'python3.12'))) return bundled
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'pdf-workbench-runtime')
}

/**
 * Locate the interpreter that can load the PyMuPDF / onnxruntime wheels.
 *
 * The Harness runtime Python is signed with the hardened runtime and its Team ID,
 * so macOS library validation rejects the ad-hoc-signed extensions pip installs.
 * The engine uses an ad-hoc re-signed copy of that very interpreter (no hardened
 * runtime), which loads them happily; it borrows the standard library and the
 * bundled site-packages through PYTHONHOME.
 */
function dshPythonRoots() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const roots = []
  if (process.env.PDFW_PYTHON_ROOT) roots.push(process.env.PDFW_PYTHON_ROOT)
  try {
    for (const name of readdirSync(join(home, 'dsh-runtimes'))) {
      roots.push(join(home, 'dsh-runtimes', name, 'dependencies', 'python'))
    }
  } catch {}
  return roots.filter((root) => existsSync(join(root, 'lib', 'python3.12')))
}

function resolveInterpreter() {
  const root = dshPythonRoots()[0]
  const local = join(runtimeHome(), 'python', 'bin', 'python3.12')
  if (root && existsSync(local)) return { python: local, env: { PYTHONHOME: root } }
  if (root) return { python: join(root, 'bin', 'python3'), env: {} }
  const fallback = candidatePythons().find((path) => existsSync(path)) ?? 'python3'
  return { python: fallback, env: {} }
}

/** Locate the Python interpreter that owns the bundled PyMuPDF copy. */
function candidatePythons() {
  const list = []
  if (process.env.PDFW_PYTHON) list.push(process.env.PDFW_PYTHON)
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  try {
    for (const name of readdirSync(join(home, 'dsh-runtimes'))) {
      list.push(join(home, 'dsh-runtimes', name, 'dependencies', 'python', 'bin', 'python3'))
      list.push(join(home, 'dsh-runtimes', name, 'dependencies', 'python', 'bin', 'python'))
    }
  } catch {}
  list.push('/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3', 'python3')
  return [...new Set(list)]
}

function sofficePath() {
  const list = [
    process.env.PDFW_SOFFICE,
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/local/bin/soffice',
    '/opt/homebrew/bin/soffice',
    '/usr/bin/soffice',
  ].filter(Boolean)
  return list.find((path) => path !== 'soffice' && existsSync(path)) ?? list.find((path) => path === 'soffice')
}

/* ------------------------------------------------------------------ engine */

function spawnEngine(args, { timeoutMs = 15 * 60 * 1000, onStage, signal } = {}) {
  return new Promise((resolvePromise, reject) => {
    const { python, env } = resolveInterpreter()
    const child = spawn(python, [ENGINE, ...args], {
      cwd: HERE,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...env,
        PYTHONPATH: join(runtimeHome(), 'pylib'),
        PDFW_PYLIB: join(runtimeHome(), 'pylib'),
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        OMP_NUM_THREADS: process.env.OMP_NUM_THREADS ?? '2',
      },
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      fn(value)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(reject, new WorkbenchError('TIMEOUT', '处理超时，已终止任务', '请尝试拆分文件或减少页数后重试'))
    }, timeoutMs)
    const abort = () => {
      child.kill('SIGKILL')
      finish(reject, new WorkbenchError('CANCELLED', '任务已取消', ''))
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      for (const line of String(chunk).split('\n')) {
        const text = line.trim()
        if (!text.startsWith('{')) continue
        try {
          const event = JSON.parse(text)
          if (typeof event.progress === 'number') onStage?.(event.progress, event.stage)
        } catch {
          /* engine chatter is not progress */
        }
        if (stderr.length > 200000) stderr = stderr.slice(-50000)
      }
    })
    child.on('error', (error) => finish(reject, new WorkbenchError('ENGINE_SPAWN', `无法启动 PDF 引擎：${error.message}`, '请确认 DSH 运行时完整')))
    child.on('close', (code) => {
      const parsed = lastJsonLine(stdout)
      if (parsed && parsed.ok === false) {
        diag(`engine error ${args[0]} python=${python}: ${JSON.stringify(parsed.error).slice(0, 300)}`)
      }
      if (parsed === undefined) {
        diag(`engine no output ${args[0]} code=${code} stderr=${stderr.trim().slice(-400)}`)
        const detail = stderr.trim().split('\n').slice(-6).join('\n')
        finish(reject, new WorkbenchError('ENGINE_NO_OUTPUT', 'PDF 引擎没有返回结果', detail.slice(0, 900) || `退出码 ${code}`))
        return
      }
      finish(resolvePromise, parsed)
    })
  })
}

function lastJsonLine(text) {
  const lines = String(text || '').trim().split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line)
    } catch {
      /* keep scanning upwards */
    }
  }
  return undefined
}

/* -------------------------------------------------------------------- jobs */

class Workbench {
  constructor(ownerCtx) {
    this.ctx = ownerCtx
    this.jobs = new Map()
    /** sourceId -> staged upload, so follow-up AI turns reuse the first upload. */
    this.sources = new Map()
    this.engineStatus = { version: null, libreoffice: Boolean(sofficePath()), ocr: false, pymupdf: false }
    this.root = join(tmpdir(), 'dsh-pdf-workbench')
    this.cleanupTimer = undefined
  }

  async initialize() {
    await mkdir(this.root, { recursive: true })
    await this.sweepExpired()
    this.cleanupTimer = setInterval(() => {
      this.sweepExpired().catch(() => {})
    }, 10 * 60 * 1000)
    if (this.cleanupTimer.unref) this.cleanupTimer.unref()
    this.scheduleProbe()
  }

  /** Probe once; retry a few times while the engine bundle is still settling. */
  scheduleProbe(attempt = 0) {
    this.probeEngine()
      .then((status) => {
        if (!status.pymupdf && attempt < 6) {
          const timer = setTimeout(() => this.scheduleProbe(attempt + 1), 5000 * (attempt + 1))
          if (timer.unref) timer.unref()
        }
      })
      .catch(() => {})
  }

  dispose() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    for (const job of this.jobs.values()) job.controller?.abort()
    this.jobs.clear()
    this.sources.clear()
  }

  async sweepExpired() {
    const cutoff = Date.now() - RETENTION_MS
    for (const [id, job] of [...this.jobs.entries()]) {
      if (job.finishedAt && job.finishedAt < cutoff) {
        this.jobs.delete(id)
        await rm(join(this.root, id), { recursive: true, force: true }).catch(() => {})
      }
    }
    let entries = []
    try {
      entries = await readdir(this.root)
    } catch {
      return
    }
    for (const entry of entries) {
      if (this.jobs.has(entry)) continue
      const path = join(this.root, entry)
      try {
        const info = await stat(path)
        if (info.mtimeMs < cutoff) await rm(path, { recursive: true, force: true })
      } catch {
        /* a concurrent request may have removed it already */
      }
    }
  }

  async probeEngine() {
    try {
      const result = await spawnEngine(['env', join(this.root, 'env.json')], { timeoutMs: 30000 })
      if (result?.ok) {
        this.engineStatus = {
          version: result.pymupdf ?? null,
          libreoffice: Boolean(result.libreoffice),
          ocr: Boolean(result.ocr),
          pymupdf: Boolean(result.pymupdf),
        }
      }
    } catch {
      /* /info reports the last known state */
    }
    return this.engineStatus
  }

  aiSelection() {
    const fromDefault = this.ctx.get('agentDefaultModel')?.currentSelection?.()
    if (fromDefault?.provider && fromDefault?.model) return fromDefault
    return undefined
  }

  /* ------------------------------------------------------------- endpoints */

  async handleCatalog() {
    return okValue(catalogView())
  }

  async handleInfo() {
    // The activation-time probe can race the bundle link; probe once on demand so
    // the capability list self-heals without restarting the app.
    if (!this.engineStatus.pymupdf && !this.probing) {
      this.probing = this.probeEngine()
        .catch(() => undefined)
        .finally(() => {
          this.probing = undefined
        })
    }
    if (this.probing) {
      await Promise.race([this.probing, new Promise((resolve) => setTimeout(resolve, 20000))])
    }
    const selection = this.aiSelection()
    return okValue({
      version: VERSION,
      limits: LIMITS,
      retentionHours: Math.round(RETENTION_MS / 3600000),
      capabilities: {
        libreoffice: this.engineStatus.libreoffice,
        ocr: this.engineStatus.ocr,
        pymupdf: this.engineStatus.pymupdf,
        ai: {
          available: Boolean(this.ctx.get('llm')) && Boolean(selection),
          provider: selection?.provider ?? null,
          model: selection?.model ?? null,
        },
        translatePageBudget: TRANSLATE_PAGE_BUDGET,
      },
    })
  }

  async handleCreate(request) {
    let form
    try {
      form = await request.formData()
    } catch (error) {
      throw new WorkbenchError('BAD_FORM', '无法解析上传内容', String(error?.message ?? error))
    }
    const opId = String(form.get('op') ?? '')
    const operation = findOperation(opId)
    if (!operation) throw new WorkbenchError('UNKNOWN_OP', `未知功能：${opId}`, '请刷新页面后重试')

    let params = {}
    const rawParams = form.get('params')
    if (typeof rawParams === 'string' && rawParams.trim()) {
      try {
        params = JSON.parse(rawParams)
      } catch {
        throw new WorkbenchError('BAD_PARAMS', '参数格式不正确', '请重置参数后重试')
      }
    }
    const missing = (operation.fields ?? []).find(
      (field) => field.required && (params[field.key] === undefined || params[field.key] === ''),
    )
    if (missing) throw new WorkbenchError('MISSING_PARAM', `请填写「${missing.label?.zh ?? missing.key}」`, '')

    const staged = []
    const uploads = form.getAll('file').filter((entry) => entry && typeof entry === 'object' && 'arrayBuffer' in entry)
    const sourceIds = []

    if (uploads.length === 0) {
      const rawSources = form.get('sourceIds')
      if (typeof rawSources === 'string' && rawSources.trim()) {
        let ids = []
        try {
          ids = JSON.parse(rawSources)
        } catch {
          throw new WorkbenchError('BAD_SOURCES', '无法识别复用的文件', '请重新上传')
        }
        for (const id of ids) {
          const source = this.sources.get(String(id))
          if (!source) throw new WorkbenchError('SOURCE_GONE', '复用的文件已过期', '请重新上传文件')
          staged.push({ ...source, sourceId: String(id) })
          sourceIds.push(String(id))
        }
      }
    } else {
      if (uploads.length > LIMITS.maxBatchFiles) {
        throw new WorkbenchError(
          'TOO_MANY_FILES',
          `单次最多处理 ${LIMITS.maxBatchFiles} 个文件，当前 ${uploads.length} 个`,
          '请分批上传',
        )
      }
      let total = 0
      for (const file of uploads) {
        if (file.size > LIMITS.maxFileBytes) {
          throw new WorkbenchError(
            'FILE_TOO_LARGE',
            `「${file.name}」超过单文件 ${fmtBytes(LIMITS.maxFileBytes)} 限制`,
            '请先压缩或拆分该文件',
          )
        }
        total += file.size
        if (total > MAX_TOTAL_BYTES) {
          throw new WorkbenchError(
            'BATCH_TOO_LARGE',
            `单次上传总量超过 ${fmtBytes(MAX_TOTAL_BYTES)} 限制`,
            '请分批上传处理',
          )
        }
        staged.push({ file, name: sanitizeName(file.name), size: file.size })
      }
    }

    if (staged.length === 0) throw new WorkbenchError('NO_FILES', '请先选择要处理的文件', '')
    if (operation.multiple === false && staged.length > 1) {
      staged.splice(1)
    }

    const job = {
      id: `j_${randomUUID()}`,
      op: opId,
      operation,
      params,
      status: 'queued',
      progress: 0,
      stage: '已接收文件，等待处理',
      createdAt: Date.now(),
      startedAt: undefined,
      finishedAt: undefined,
      inputs: [],
      items: [],
      outputs: [],
      warnings: [],
      text: undefined,
      error: undefined,
      controller: new AbortController(),
    }

    const jobDir = join(this.root, job.id)
    const inDir = join(jobDir, 'in')
    const outDir = join(jobDir, 'out')
    await mkdir(inDir, { recursive: true })
    await mkdir(outDir, { recursive: true })

    try {
      for (const [index, entry] of staged.entries()) {
        if (entry.file) {
          const target = join(inDir, `${String(index).padStart(2, '0')}-${entry.name}`)
          if (typeof entry.file.stream === 'function') {
            await pipeline(Readable.fromWeb(entry.file.stream()), createWriteStream(target))
          } else {
            await writeFile(target, Buffer.from(await entry.file.arrayBuffer()))
          }
          const sourceId = `s_${randomUUID()}`
          const source = { path: target, name: entry.name, size: entry.size }
          this.sources.set(sourceId, source)
          job.inputs.push({ ...source, sourceId })
        } else {
          job.inputs.push({ path: entry.path, name: entry.name, size: entry.size, sourceId: entry.sourceId })
        }
      }
    } catch (error) {
      await rm(jobDir, { recursive: true, force: true }).catch(() => {})
      throw new WorkbenchError('UPLOAD_FAILED', '文件保存失败', String(error?.message ?? error))
    }

    this.jobs.set(job.id, job)
    queueMicrotask(() => {
      this.runJob(job).catch(() => {})
    })
    return okValue({
      jobId: job.id,
      status: job.status,
      sourceIds: job.inputs.map((input) => input.sourceId).filter(Boolean),
    })
  }

  async handleJobGet(request) {
    const id = new URL(request.url).searchParams.get('id') ?? ''
    const job = this.jobs.get(id)
    if (!job) throw new WorkbenchError('JOB_NOT_FOUND', '任务不存在或已过期（结果保留 24 小时）', '请重新提交')
    return okValue(this.snapshot(job))
  }

  async handleJobCancel(request) {
    const id = new URL(request.url).searchParams.get('id') ?? ''
    const job = this.jobs.get(id)
    if (!job) throw new WorkbenchError('JOB_NOT_FOUND', '任务不存在或已过期', '')
    if (job.status === 'queued' || job.status === 'running') {
      job.controller.abort()
      job.status = 'cancelled'
      job.finishedAt = Date.now()
      job.stage = '任务已取消'
    }
    return okValue({ cancelled: true })
  }

  async handleFile(request) {
    const url = new URL(request.url)
    const job = this.jobs.get(url.searchParams.get('job') ?? '')
    const output = job?.outputs.find((entry) => entry.id === url.searchParams.get('file'))
    if (!job || !output) throw new WorkbenchError('FILE_NOT_FOUND', '结果文件不存在或已过期', '')
    const inline = url.searchParams.get('inline') === '1'
    const extension = extname(output.name).toLowerCase().slice(1)
    const stream = Readable.toWeb(createReadStream(output.path))
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': MIME[extension] ?? 'application/octet-stream',
        'content-length': String(output.bytes),
        'content-disposition': contentDisposition(output.kind, output.name, inline),
        'cache-control': 'private, max-age=3600',
      },
    })
  }

  async handlePreview(request) {
    const url = new URL(request.url)
    const job = this.jobs.get(url.searchParams.get('job') ?? '')
    const output = job?.outputs.find((entry) => entry.id === url.searchParams.get('file'))
    if (!job || !output) throw new WorkbenchError('FILE_NOT_FOUND', '结果文件不存在或已过期', '')
    if (output.kind === 'image') {
      const extension = extname(output.name).toLowerCase().slice(1)
      return new Response(Readable.toWeb(createReadStream(output.path)), {
        status: 200,
        headers: { 'content-type': MIME[extension] ?? 'image/png', 'cache-control': 'private, max-age=600' },
      })
    }
    if (output.kind !== 'pdf') throw new WorkbenchError('NO_PREVIEW', '该文件类型不支持页面预览', '请下载后查看')
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1)
    const width = Math.min(1600, Math.max(240, Number(url.searchParams.get('w') ?? '900') || 900))
    const cacheDir = join(this.root, job.id, 'out', '.previews')
    await mkdir(cacheDir, { recursive: true })
    const target = join(cacheDir, `${output.id}-${page}-${width}.png`)
    if (!existsSync(target)) {
      const report = await spawnEngine(['preview', await this.writeJobFile(job, {
        op: 'preview',
        params: { page, width },
        inputs: [{ path: output.path, name: output.name, size: output.bytes }],
        outDir: cacheDir,
        target,
      }, 'preview')], { timeoutMs: 120000 })
      if (!report?.ok) throw new WorkbenchError('PREVIEW_FAILED', '页面预览生成失败', report?.error?.message ?? '')
    }
    return new Response(Readable.toWeb(createReadStream(target)), {
      status: 200,
      headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=600' },
    })
  }

  async handlePages(request) {
    const url = new URL(request.url)
    const job = this.jobs.get(url.searchParams.get('job') ?? '')
    const output = job?.outputs.find((entry) => entry.id === url.searchParams.get('file'))
    if (!job || !output) throw new WorkbenchError('FILE_NOT_FOUND', '结果文件不存在或已过期', '')
    if (output.kind !== 'pdf') throw new WorkbenchError('NO_PREVIEW', '该文件不是 PDF', '')
    const report = await spawnEngine(['probe', await this.writeJobFile(job, {
      op: 'probe',
      params: {},
      inputs: [{ path: output.path, name: output.name, size: output.bytes }],
      outDir: join(this.root, job.id, 'out'),
    }, 'probe')], { timeoutMs: 60000 })
    if (!report?.ok) throw new WorkbenchError('PROBE_FAILED', '读取页数失败', report?.error?.message ?? '')
    return okValue({ count: report.count, pages: report.pages ?? [] })
  }

  snapshot(job) {
    const finished = job.status === 'done' || job.status === 'failed' || job.status === 'cancelled'
    return {
      id: job.id,
      op: job.op,
      status: job.status,
      progress: finished ? (job.status === 'done' ? 1 : job.progress) : job.progress,
      stage: job.stage,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      inputs: job.inputs.map((input) => ({ name: input.name, size: input.size, sourceId: input.sourceId })),
      items: job.items,
      outputs: job.outputs.map((output) => ({
        id: output.id,
        name: output.name,
        kind: output.kind,
        bytes: output.bytes,
        pages: output.pages,
        from: output.from,
      })),
      warnings: job.warnings ?? [],
      text: job.text,
      error: job.error ?? null,
    }
  }

  /* ----------------------------------------------------------- job runner */

  async writeJobFile(job, body, tag) {
    const path = join(this.root, job.id, `${tag}-${randomUUID()}.json`)
    await writeFile(path, JSON.stringify(body), 'utf8')
    return path
  }

  setProgress(job, progress, stage) {
    job.progress = Math.max(job.progress, Math.min(0.99, progress))
    if (stage) job.stage = stage
  }

  async runJob(job) {
    job.status = 'running'
    job.startedAt = Date.now()
    try {
      if (job.operation.ai) await this.runAiJob(job)
      else await this.runEngineJob(job)
      if (job.status !== 'cancelled') {
        job.status = 'done'
        job.progress = 1
        job.stage = `完成，共 ${job.outputs.length} 个结果文件`
      }
    } catch (error) {
      if (job.controller.signal.aborted || error?.code === 'CANCELLED') {
        job.status = 'cancelled'
        job.stage = '任务已取消'
      } else {
        job.status = 'failed'
        job.error = {
          code: error?.code ?? 'FAILED',
          message: error?.message ?? '处理失败',
          hint: error?.hint ?? '请检查文件与参数后重试',
        }
        job.stage = job.error.message
      }
    } finally {
      job.finishedAt = Date.now()
    }
  }

  async runEngineJob(job) {
    const outDir = join(this.root, job.id, 'out')
    this.setProgress(job, 0.08, '正在解析文件')
    const body = {
      op: job.operation.engine,
      params: job.params,
      inputs: job.inputs.map((input) => ({ path: input.path, name: input.name, size: input.size })),
      outDir,
    }
    const jobFile = await this.writeJobFile(job, body, 'engine')
    const report = await spawnEngine(['run', jobFile], {
      timeoutMs: 15 * 60 * 1000,
      signal: job.controller.signal,
      onStage: (progress, stage) => this.setProgress(job, 0.1 + progress * 0.85, stage),
    })
    if (!report?.ok) {
      throw new WorkbenchError(
        report?.error?.code ?? 'ENGINE_FAILED',
        report?.error?.message ?? '处理失败',
        report?.error?.hint ?? '',
      )
    }
    this.setProgress(job, 0.96, '正在整理结果')
    const items = []
    for (const item of report.items ?? []) {
      const itemOut = []
      for (const output of item.outputs ?? []) {
        const record = await this.registerOutput(job, output, item.input)
        if (record) itemOut.push(record)
      }
      items.push({
        input: item.input,
        ok: Boolean(item.ok) && itemOut.length > 0,
        error: item.error ?? null,
        outputs: itemOut,
      })
    }
    job.items = items
    // The engine reports non-fatal notes (a page with nothing to crop, an
    // annotation that could not be re-created, a form field left behind);
    // dropping them would let a partial result look complete.
    const warnings = Array.isArray(report?.meta?.warnings) ? [...report.meta.warnings] : []
    for (const item of report.items ?? []) {
      if (Array.isArray(item.warnings)) warnings.push(...item.warnings)
    }
    job.warnings = [...new Set(warnings.map(String))].slice(0, 40)
    if (!job.outputs.length) {
      const firstFailure = items.find((item) => !item.ok)?.error
      throw new WorkbenchError(
        firstFailure?.code ?? 'NO_OUTPUT',
        firstFailure?.message ?? '没有产生任何结果文件',
        firstFailure?.hint ?? '请检查文件是否为有效 PDF',
      )
    }
  }

  async registerOutput(job, output, from) {
    if (!output?.path) return undefined
    let info
    try {
      info = await stat(output.path)
    } catch {
      return undefined
    }
    const record = {
      id: `f_${randomUUID()}`,
      name: sanitizeName(output.name ?? basename(output.path)),
      path: output.path,
      kind: output.kind ?? kindOf(output.name ?? output.path),
      bytes: info.size,
      pages: output.pages,
      from: from ?? null,
    }
    job.outputs.push(record)
    return record
  }

  /* -------------------------------------------------------------- AI jobs */

  async runAiJob(job) {
    const llm = this.ctx.get('llm')
    const selection = this.aiSelection()
    if (!llm || !selection) {
      throw new WorkbenchError(
        'AI_UNAVAILABLE',
        '当前没有可用的模型路由',
        '请在「设置 → 模型」中配置并选择一个可用模型后重试',
      )
    }
    this.setProgress(job, 0.06, '正在提取文档文字')
    const pages = await this.extractPages(job)
    const filled = pages.filter((page) => page.text.trim().length > 0)
    if (filled.length === 0) {
      throw new WorkbenchError(
        'NO_TEXT',
        '这份 PDF 没有可提取的文字层（可能是扫描件）',
        '请先到「内容提取与增强 → OCR 文字识别」生成文字层后再使用 AI 功能',
      )
    }
    const totalChars = filled.reduce((sum, page) => sum + page.text.length, 0)
    this.setProgress(job, 0.16, `已读取 ${totalChars.toLocaleString()} 字，正在调用模型`)
    const op = job.op

    if (op === 'ai.summary') {
      const markdown = await this.aiSummary(job, llm, selection, filled)
      await this.emitText(job, markdown, '智能摘要')
    } else if (op === 'ai.qa') {
      const answer = await this.aiAnswer(job, llm, selection, filled)
      await this.emitText(job, answer, '文档问答')
    } else if (op === 'ai.translate') {
      const segments = await this.aiTranslate(job, llm, selection, filled)
      const format = job.params.outputFormat ?? 'pdf'
      const title = baseNameOf(job.inputs[0]?.name ?? 'document')
      const built = await this.buildDocument(job, 'textDoc', {
        format,
        title: job.params.mode === 'bilingual' ? `${title}-双语对照` : `${title}-${job.params.targetLang ?? 'en'}`,
        bilingual: job.params.mode !== 'target',
        segments,
      })
      const previewText = segments
        .slice(0, 12)
        .map((segment) =>
          job.params.mode === 'bilingual'
            ? `**第 ${segment.page} 页**\n\n${segment.original}\n\n${segment.translated}`
            : `**第 ${segment.page} 页**\n\n${segment.translated}`,
        )
        .join('\n\n---\n\n')
      job.text = `${previewText}${segments.length > 12 ? '\n\n…（完整内容见下载文件）' : ''}`
      if (built.note) job.text += `\n\n> ${built.note}`
    } else if (op === 'ai.proofread') {
      const markdown = await this.aiProofread(job, llm, selection, filled)
      await this.emitText(job, markdown, '校对报告')
    } else if (op === 'ai.extractInfo') {
      const table = await this.aiExtractInfo(job, llm, selection, filled)
      await this.emitTable(job, table)
    } else {
      throw new WorkbenchError('AI_UNKNOWN_OP', `未实现的 AI 功能：${op}`, '')
    }
    this.setProgress(job, 0.97, '正在整理结果')
  }

  async extractPages(job) {
    const body = {
      op: 'readText',
      params: { pageRange: job.params.pageRange ?? '' },
      inputs: job.inputs.map((input) => ({ path: input.path, name: input.name, size: input.size })),
      outDir: join(this.root, job.id, 'out'),
    }
    const jobFile = await this.writeJobFile(job, body, 'text')
    const report = await spawnEngine(['text', jobFile], {
      timeoutMs: 10 * 60 * 1000,
      signal: job.controller.signal,
    })
    if (!report?.ok) {
      throw new WorkbenchError(
        report?.error?.code ?? 'TEXT_FAILED',
        report?.error?.message ?? '文字提取失败',
        report?.error?.hint ?? '',
      )
    }
    return (report.pages ?? []).map((page) => ({ page: page.page, text: String(page.text ?? '') }))
  }

  async complete(job, llm, selection, { system, prompt, maxTokens = 3000, temperature = 0.2 }) {
    let prepared
    try {
      prepared = await llm.prepareCall({ provider: selection.provider, model: selection.model })
    } catch (error) {
      throw new WorkbenchError(
        'AI_UNAVAILABLE',
        `无法使用模型 ${selection.provider}/${selection.model}：${error?.message ?? '未知原因'}`,
        '请在「设置 → 模型」中确认该模型可用、凭据有效后重试',
      )
    }
    const stream = prepared.stream({
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
      system,
      maxTokens,
      temperature,
      sessionId: this.ctx.get('agents')?.currentInitiator?.()?.session?.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    })
    let text = ''
    for await (const chunk of stream) {
      if (job.controller.signal.aborted) throw new WorkbenchError('CANCELLED', '任务已取消', '')
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error') {
          throw new WorkbenchError(
            'MODEL_ERROR',
            `模型调用失败：${chunk.reason.failure?.message ?? '未知错误'}`,
            '请检查模型配置与网络后重试',
          )
        }
        if (chunk.reason.kind === 'aborted') throw new WorkbenchError('CANCELLED', '模型调用被中断', '')
      }
    }
    const trimmed = text.trim()
    if (!trimmed) throw new WorkbenchError('MODEL_EMPTY', '模型没有返回内容', '请稍后重试')
    return trimmed
  }

  chunkPages(pages, budget = AI_CHUNK_CHARS) {
    const chunks = []
    let current = []
    let size = 0
    for (const page of pages) {
      const length = page.text.length + 24
      if (current.length > 0 && size + length > budget) {
        chunks.push(current)
        current = []
        size = 0
      }
      current.push(page)
      size += length
    }
    if (current.length > 0) chunks.push(current)
    return chunks
  }

  pageText(pages) {
    return pages.map((page) => `【第 ${page.page} 页】\n${page.text}`).join('\n\n')
  }

  async aiSummary(job, llm, selection, pages) {
    const style = job.params.style ?? 'structured'
    const language = job.params.language === 'en' ? 'English' : '简体中文'
    const chunks = this.chunkPages(pages)
    const system = `你是资深文档分析师。请只依据给定原文作答，不得编造原文没有的信息；用 ${language} 回答，输出 Markdown。`
    const taskByStyle = {
      structured:
        '请输出结构化摘要，严格包含以下小节：\n## 核心观点\n## 章节大纲\n## 关键数据\n## 结论与建议\n关键结论后用（第 N 页）标注出处。',
      brief: '请用一段 150–250 字的话概括全文主旨，结尾用（第 N 页）标注主要依据。',
      detailed:
        '请输出详尽解读，包含：## 背景与目的\n## 逐章要点\n## 关键数据与事实\n## 结论、风险与建议\n每个要点后用（第 N 页）标注出处。',
    }
    if (chunks.length === 1) {
      return this.complete(job, llm, selection, {
        system,
        prompt: `${taskByStyle[style] ?? taskByStyle.structured}\n\n原文：\n\n${this.pageText(chunks[0])}`,
        maxTokens: style === 'brief' ? 800 : 4000,
      })
    }
    const partials = []
    for (const [index, chunk] of chunks.entries()) {
      this.setProgress(job, 0.2 + (index / chunks.length) * 0.55, `正在分段解析 ${index + 1}/${chunks.length}`)
      partials.push(
        await this.complete(job, llm, selection, {
          system,
          prompt: `这是长文档的第 ${index + 1}/${chunks.length} 段。请提炼本段的要点、关键数据与结论，用（第 N 页）标注出处，输出 Markdown 列表。\n\n${this.pageText(chunk)}`,
          maxTokens: 2200,
        }),
      )
    }
    this.setProgress(job, 0.82, '正在合并分段摘要')
    return this.complete(job, llm, selection, {
      system,
      prompt: `下面是一份长文档各段落的摘要。请把它们合并为最终摘要。\n\n${taskByStyle[style] ?? taskByStyle.structured}\n\n分段摘要：\n\n${partials.join('\n\n---\n\n')}`,
      maxTokens: 4000,
    })
  }

  async aiAnswer(job, llm, selection, pages) {
    const question = String(job.params.question ?? '').trim()
    if (!question) throw new WorkbenchError('MISSING_QUESTION', '请输入问题', '')
    const selected = this.selectRelevantPages(pages, question, AI_QA_CHARS)
    const history = Array.isArray(job.params.history) ? job.params.history.slice(-8) : []
    const historyText = history
      .map((turn) => `${turn.role === 'user' ? '用户' : '助手'}：${String(turn.content ?? '').slice(0, 1200)}`)
      .join('\n')
    const system =
      '你是文档问答助手。只能依据给出的原文回答；原文没有提到时明确说明「文档中没有相关说明」，不要猜测。回答后用（第 N 页）标注引用位置。'
    const prompt = [
      historyText ? `此前的对话：\n${historyText}\n` : '',
      `文档原文：\n\n${this.pageText(selected)}`,
      `\n\n问题：${question}\n\n请给出准确、结构清晰的回答。`,
    ]
      .filter(Boolean)
      .join('\n')
    return this.complete(job, llm, selection, { system, prompt, maxTokens: 2500 })
  }

  /** Keyword-scored page selection so a 500-page document still answers. */
  selectRelevantPages(pages, question, budget) {
    const tokens = new Set()
    for (const run of String(question).match(/[\u4e00-\u9fa5]{2,}/g) ?? []) {
      for (let index = 0; index + 1 < run.length; index += 1) tokens.add(run.slice(index, index + 2))
    }
    for (const word of String(question).toLowerCase().match(/[a-z0-9]{2,}/g) ?? []) tokens.add(word)
    const scored = pages.map((page) => {
      const haystack = page.text.toLowerCase()
      let score = 0
      for (const token of tokens) if (haystack.includes(token)) score += 1
      return { page, score }
    })
    const chosen = []
    let size = 0
    const ranked = [...scored].sort((a, b) => b.score - a.score || a.page.page - b.page.page)
    for (const entry of ranked) {
      const length = entry.page.text.length + 24
      if (size + length > budget) continue
      chosen.push(entry.page)
      size += length
      if (size > budget * 0.92) break
    }
    if (chosen.length === 0) {
      for (const page of pages) {
        if (size + page.text.length > budget) break
        chosen.push(page)
        size += page.text.length + 24
      }
    }
    return chosen.sort((a, b) => a.page - b.page)
  }

  async aiTranslate(job, llm, selection, pages) {
    const target = job.params.targetLang ?? 'en'
    const limited = pages.slice(0, TRANSLATE_PAGE_BUDGET)
    const system =
      '你是专业文档翻译。忠实翻译原文，保留段落结构与数字、专有名词；只输出译文，不要解释。'
    const segments = []
    for (const [index, page] of limited.entries()) {
      this.setProgress(
        job,
        0.2 + (index / limited.length) * 0.6,
        `正在翻译第 ${page.page} 页（${index + 1}/${limited.length}）`,
      )
      const translated = await this.complete(job, llm, selection, {
        system,
        prompt: `把下面的内容翻译为语言代码「${target}」：\n\n${page.text}`,
        maxTokens: Math.min(4000, Math.max(600, Math.round(page.text.length * 1.6))),
        temperature: 0.1,
      })
      segments.push({ page: page.page, original: page.text, translated })
      if (job.controller.signal.aborted) throw new WorkbenchError('CANCELLED', '任务已取消', '')
    }
    const truncated = pages.length > limited.length
    if (truncated) segments.push({
      page: 0,
      original: '',
      translated: `（原文共 ${pages.length} 页，本次翻译前 ${limited.length} 页；如需完整翻译请分段处理。）`,
    })
    return segments
  }

  async aiProofread(job, llm, selection, pages) {
    const strict = job.params.strictness === 'strict'
    const system = '你是严谨的中文与英文文字编辑。只指出原文中确实存在的问题，不编造。'
    const chunks = this.chunkPages(pages, 30000)
    const reports = []
    for (const [index, chunk] of chunks.entries()) {
      this.setProgress(job, 0.2 + (index / chunks.length) * 0.65, `正在校对 ${index + 1}/${chunks.length}`)
      reports.push(
        await this.complete(job, llm, selection, {
          system,
          prompt: [
            `请校对下面的文档内容${strict ? '，并给出润色建议' : ''}。`,
            '输出 Markdown 表格，列为：页码 | 原文片段 | 问题类型（错别字/语法/标点/表达） | 修改建议。',
            '若某段没有问题则不要列出。最后附一节「## 润色后全文」给出修改后的完整文本段落。',
            strict ? '' : '仅指出明确错误，不要做风格改写。',
            '',
            this.pageText(chunk),
          ]
            .filter(Boolean)
            .join('\n'),
          maxTokens: 3500,
          temperature: 0.1,
        }),
      )
    }
    return reports.join('\n\n---\n\n')
  }

  async aiExtractInfo(job, llm, selection, pages) {
    const instruction = String(job.params.instruction ?? '').trim()
    if (!instruction) throw new WorkbenchError('MISSING_INSTRUCTION', '请填写提取要求', '')
    const chunks = this.chunkPages(pages, 30000)
    const rows = []
    let headers = []
    for (const [index, chunk] of chunks.entries()) {
      this.setProgress(job, 0.2 + (index / chunks.length) * 0.6, `正在抽取 ${index + 1}/${chunks.length}`)
      const raw = await this.complete(job, llm, selection, {
        system: '你是信息抽取引擎。严格只输出 JSON，不要输出任何解释文字或代码围栏。',
        prompt: [
          `抽取要求：${instruction}`,
          '输出格式：{"headers":["字段1","字段2"],"rows":[["值1","值2"]]}',
          '原文没有的信息用空字符串；没有可抽取内容时 rows 返回 []。',
          '',
          this.pageText(chunk),
        ].join('\n'),
        maxTokens: 2500,
        temperature: 0,
      })
      const parsed = parseJsonLoose(raw)
      if (parsed && Array.isArray(parsed.headers) && parsed.headers.length) headers = parsed.headers
      if (parsed && Array.isArray(parsed.rows)) {
        for (const row of parsed.rows) if (Array.isArray(row) && row.length) rows.push(row.map((cell) => String(cell ?? '')))
      }
    }
    if (rows.length === 0) {
      throw new WorkbenchError('NOTHING_EXTRACTED', '没有从文档中抽取到符合要求的信息', '请换一种更具体的提取要求后重试')
    }
    return { headers, rows }
  }

  async emitText(job, markdown, title) {
    job.text = markdown
    const name = `${baseNameOf(job.inputs[0]?.name ?? 'document')}-${title}.md`
    const path = join(this.root, job.id, 'out', sanitizeName(name))
    await writeFile(path, `# ${title}\n\n${markdown}\n`, 'utf8')
    await this.registerOutput(job, { path, name, kind: 'md' })
  }

  async emitTable(job, table) {
    const format = job.params.outputFormat ?? 'xlsx'
    const built = await this.buildDocument(job, 'tableDoc', {
      format,
      title: '信息提取结果',
      headers: table.headers,
      rows: table.rows,
    })
    const previewLimit = 40
    const head = `| ${table.headers.join(' | ')} |`
    const divider = `| ${table.headers.map(() => '---').join(' | ')} |`
    const body = table.rows
      .slice(0, previewLimit)
      .map((row) => `| ${table.headers.map((_, index) => String(row[index] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`)
      .join('\n')
    job.text = `${head}\n${divider}\n${body}${table.rows.length > previewLimit ? `\n\n…共 ${table.rows.length} 行，完整结果见下载文件` : ''}`
    if (built.note) job.text += `\n\n> ${built.note}`
  }

  async buildDocument(job, kind, params) {
    const outDir = join(this.root, job.id, 'out')
    const jobFile = await this.writeJobFile(job, {
      op: kind,
      params: { ...params, kind },
      inputs: [],
      outDir,
    }, 'build')
    const report = await spawnEngine(['build', jobFile], { timeoutMs: 5 * 60 * 1000, signal: job.controller.signal })
    if (!report?.ok) {
      return { note: `文档生成失败：${report?.error?.message ?? '未知错误'}（正文已在上方展示）` }
    }
    for (const output of report.outputs ?? []) await this.registerOutput(job, output)
    return { note: '' }
  }
}

function parseJsonLoose(raw) {
  const text = String(raw ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------- routes */

const routesFor = (workbench) => [
  {
    path: `${API}/catalog`,
    methods: ['GET'],
    requestBody: 'buffered',
    handler: () => workbench.handleCatalog(),
  },
  {
    path: `${API}/info`,
    methods: ['GET'],
    requestBody: 'buffered',
    handler: () => workbench.handleInfo(),
  },
  {
    path: `${API}/jobs`,
    methods: ['POST'],
    requestBody: 'streaming',
    handler: (request) => workbench.handleCreate(request),
  },
  {
    path: `${API}/job`,
    methods: ['GET'],
    requestBody: 'buffered',
    handler: (request) => workbench.handleJobGet(request),
  },
  {
    // The Fetch-route registry is keyed by path alone, so a second method on the
    // same path throws and takes the whole registration effect down with it.
    path: `${API}/cancel`,
    methods: ['DELETE'],
    requestBody: 'buffered',
    handler: (request) => workbench.handleJobCancel(request),
  },
  {
    path: `${API}/file`,
    methods: ['GET'],
    requestBody: 'buffered',
    handler: (request) => workbench.handleFile(request),
  },
  {
    path: `${API}/preview`,
    methods: ['GET'],
    requestBody: 'buffered',
    handler: (request) => workbench.handlePreview(request),
  },
  {
    path: `${API}/pages`,
    methods: ['GET'],
    requestBody: 'buffered',
    handler: (request) => workbench.handlePages(request),
  },
]

/** Wrap a handler so every failure becomes the documented JSON error packet. */
const guarded = (handler) => async (request) => {
  try {
    return await handler(request)
  } catch (error) {
    const known = error instanceof WorkbenchError
    return failValue(known ? error : new WorkbenchError('INTERNAL', error?.message ?? '内部错误', ''), known ? 400 : 500)
  }
}

/* -------------------------------------------------------------------- plugin */

export function apply(ctx) {
  const workbench = new Workbench(ctx)
  workbench.initialize().catch(() => {})
  diag(`apply start get(connection)=${typeof ctx.get === 'function' ? Boolean(ctx.get('connection')) : 'no-get'} get(webServer)=${typeof ctx.get === 'function' ? Boolean(ctx.get('webServer')) : 'no-get'}`)

  let fired = false
  ctx.inject(['connection'], (outer) => {
    fired = true
    diag(`inject fired connection=${Boolean(outer.connection)} fetch=${Boolean(outer.connection?.fetch)}`)
    outer.effect(() => {
      const disposers = []
      for (const route of routesFor(workbench)) {
        try {
          disposers.push(
            outer.connection.fetch.register({
              path: route.path,
              methods: route.methods,
              requestBody: route.requestBody,
              fetch: guarded(route.handler),
            }),
          )
          diag(`registered ${route.methods.join(',')} ${route.path}`)
        } catch (error) {
          diag(`REGISTER FAILED ${route.path}: ${error?.message}`)
        }
      }
      return async () => {
        for (const dispose of disposers) await dispose()
      }
    }, 'pdf-workbench: api routes')
  })
  diag('apply end')

  const timer = setTimeout(() => {
    if (!fired) diag('inject did not fire within 5s')
  }, 5000)
  if (timer.unref) timer.unref()

  ctx.effect(() => () => workbench.dispose(), 'pdf-workbench: job store')
}

/** Route table, exported so a test can assert every path is unique. */
export function routeTable() {
  return routesFor({
    handleCatalog: async () => undefined,
    handleInfo: async () => undefined,
    handleCreate: async () => undefined,
    handleJobGet: async () => undefined,
    handleJobCancel: async () => undefined,
    handleFile: async () => undefined,
    handlePreview: async () => undefined,
    handlePages: async () => undefined,
  }).map((route) => `${route.methods.join(',')} ${route.path}`)
}

export { VERSION, LIMITS, Workbench }
