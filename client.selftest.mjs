/**
 * client.selftest.mjs — offline verification for pdf-workbench/client.js.
 *
 * Runs with plain Node (`node pdf-workbench/client.selftest.mjs`): no browser,
 * no bundler, no network. It fakes `window.__ModuleLoader__`, supplies a minimal
 * React stand-in (react is not installed in this workspace and the profile's
 * node_modules symlinks are stale), loads the real catalog for fixtures, and
 * renders the exported components with a tiny hook-aware renderer so that view
 * code paths are actually executed.
 */

import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = path.join(HERE, "client.js")
const CATALOG_PATH = path.join(HERE, "catalog.js")

let passed = 0
let failed = 0
const failures = []

function check(label, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failed += 1
    failures.push(`${label}: ${error && error.message ? error.message : error}`)
  }
}

async function checkAsync(label, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failed += 1
    failures.push(`${label}: ${error && error.message ? error.message : error}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed")
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || "not equal"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assertDeep(actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message || "not deep equal"}: expected ${b}, got ${a}`)
}

/* ------------------------------------------------------------------------ */
/* minimal React stand-in: hooks + a rendering walker                        */
/* ------------------------------------------------------------------------ */

function createMiniReact() {
  const FRAGMENT = Symbol("react.fragment")

  function flatten(list, value) {
    if (value === null || value === undefined || typeof value === "boolean") return
    if (Array.isArray(value)) {
      for (const item of value) flatten(list, item)
      return
    }
    list.push(value)
  }

  function createElement(type, props) {
    const children = []
    for (let i = 2; i < arguments.length; i += 1) flatten(children, arguments[i])
    const nextProps = Object.assign({}, props || null)
    if (children.length === 1) nextProps.children = children[0]
    else if (children.length > 1) nextProps.children = children
    return { __el: true, type, props: nextProps, children }
  }

  const stack = []

  function store() {
    const current = stack[stack.length - 1]
    if (!current) throw new Error("hook called outside of a component render")
    return current
  }

  function useState(initial) {
    const current = store()
    const index = current.index
    current.index += 1
    if (!(index in current.hooks)) current.hooks[index] = typeof initial === "function" ? initial() : initial
    const set = (next) => {
      const previous = current.hooks[index]
      current.hooks[index] = typeof next === "function" ? next(previous) : next
    }
    return [current.hooks[index], set]
  }

  function useEffect() {
    const current = store()
    current.index += 1 // effects are not executed by this offline renderer
  }

  function useRef(initial) {
    const current = store()
    const index = current.index
    current.index += 1
    if (!(index in current.hooks)) current.hooks[index] = { current: initial }
    return current.hooks[index]
  }

  function useMemo(factory) {
    store().index += 1
    return factory()
  }

  function useCallback(callback) {
    store().index += 1
    return callback
  }

  function walk(element) {
    if (element === null || element === undefined || typeof element === "boolean") return null
    if (typeof element === "string" || typeof element === "number") return { text: String(element) }
    if (Array.isArray(element)) {
      const children = []
      for (const child of element) {
        const node = walk(child)
        if (node) children.push(node)
      }
      return { children }
    }
    if (!element || !element.__el) return null
    const { type, props, children } = element
    if (type === FRAGMENT) {
      const nodes = []
      for (const child of children) {
        const node = walk(child)
        if (node) nodes.push(node)
      }
      return { children: nodes }
    }
    if (typeof type === "function") {
      const current = { hooks: [], index: 0 }
      stack.push(current)
      let rendered
      try {
        rendered = type(props)
      } finally {
        stack.pop()
      }
      return walk(rendered)
    }
    const nodes = []
    for (const child of children) {
      const node = walk(child)
      if (node) nodes.push(node)
    }
    return { tag: String(type), props, children: nodes }
  }

  return { createElement, Fragment: FRAGMENT, useState, useEffect, useRef, useMemo, useCallback, walk }
}

function collect(tree, visit) {
  if (!tree) return
  visit(tree)
  if (tree.children) for (const child of tree.children) collect(child, visit)
}

function tagsOf(tree) {
  const tags = new Set()
  collect(tree, (node) => {
    if (node.tag) tags.add(node.tag)
  })
  return tags
}

function classesOf(tree) {
  const out = []
  collect(tree, (node) => {
    if (node.tag && node.props && typeof node.props.className === "string") out.push(node.props.className)
  })
  return out
}

function propsOf(tree) {
  const out = []
  collect(tree, (node) => {
    if (!node.tag || !node.props) return
    for (const key of Object.keys(node.props)) {
      if (typeof node.props[key] === "string") out.push(node.props[key])
    }
  })
  return out
}

function textOf(tree, options) {
  const skipStyle = !options || options.skipStyle !== false
  const parts = []
  collect(tree, (node) => {
    if (node.text !== undefined) {
      parts.push(node.text)
      return
    }
    if (!node.tag) return
    if (skipStyle && node.tag === "style") return
    if (node.tag === "style" && node.children) return
  })
  return parts.join("")
}

/* ------------------------------------------------------------------------ */
/* load the real catalog (plain ESM syntactically, evaluated in a sandbox)   */
/* ------------------------------------------------------------------------ */

const catalogSource = fs.readFileSync(CATALOG_PATH, "utf8").replace(/^export /gm, "")
const catalogSandbox = { __out: null }
vm.createContext(catalogSandbox)
vm.runInContext(`${catalogSource}\n;__out = { catalogView, LIMITS, OPERATIONS, findOperation() {} }`, catalogSandbox, { filename: "catalog.js" })
const CATALOG = catalogSandbox.__out.catalogView()

/* ------------------------------------------------------------------------ */
/* load client.js through a fake module loader                               */
/* ------------------------------------------------------------------------ */

const miniReact = createMiniReact()
const loadCalls = []
const requireCalls = []
const fakeWindow = {
  __ModuleLoader__: {
    load(entry) {
      loadCalls.push(entry)
    },
  },
}

const sandbox = {
  window: fakeWindow,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  AbortController,
}
const context = vm.createContext(sandbox)

const fetchCalls = []
function fakeResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body) }
}
let fetchResponder = () => fakeResponse(200, JSON.stringify({ ok: true, value: {} }))
sandbox.fetch = (url, init) => {
  fetchCalls.push({ url, init })
  return Promise.resolve(fetchResponder())
}

const clientSource = fs.readFileSync(CLIENT_PATH, "utf8")

check("client.js loads and calls __ModuleLoader__.load exactly once", () => {
  vm.runInContext(clientSource, context, { filename: "client.js" })
  assertEqual(loadCalls.length, 1, "load call count")
  assertEqual(loadCalls[0].id, "@local/pdf-workbench", "module id")
  assertEqual(typeof loadCalls[0].factory, "function", "factory is a function")
})

const moduleExports = loadCalls[0].factory((name) => {
  requireCalls.push(name)
  if (name === "react") return miniReact
  throw new Error(`unexpected require: ${name}`)
})

const T = moduleExports.__pdfwTest
const COPY_NAMESPACES = new Set(["app", "nav", "home", "common", "upload", "params", "action", "progress", "error", "result", "notes", "cap", "status", "badge", "unit"])

/* ------------------------------------------------------------------------ */
/* 1. module surface & slot registration                                     */
/* ------------------------------------------------------------------------ */

check("factory only requires react", () => {
  assertDeep(requireCalls, ["react"], "require calls")
})

check("exports.apply / exports.inject", () => {
  assertEqual(typeof moduleExports.apply, "function", "apply type")
  assert(Array.isArray(moduleExports.inject), "inject is an array")
  assert(moduleExports.inject.includes("slots"), "inject contains slots")
  assert(moduleExports.inject.includes("locale"), "inject contains locale")
})

check("apply registers main + sidebar.panellist slots", () => {
  const injected = []
  const registered = []
  const fakeCtx = {
    locale: {
      getSnapshot: () => ({ active: "zh" }),
      subscribe: () => () => {},
      bind: () => (key) => key,
      register: () => () => {},
    },
    slots: {
      inject(name, factory) {
        injected.push(name)
        registered.push(factory())
      },
      register(options, component) {
        const record = { options, component }
        registered.push(record)
        return record
      },
    },
  }
  moduleExports.apply(fakeCtx)
  assertDeep(injected, ["main", "sidebar.panellist"], "injected slot names")
  const main = registered.find((record) => record.options && record.options.name === "main")
  const panel = registered.find((record) => record.options && record.options.name === "sidebar.panellist")
  assert(main, "main registration missing")
  assertEqual(main.options.key, "pdf-workbench", "main key")
  assertEqual(typeof main.component, "function", "main component")
  assertDeep(main.options.inject(), { workbench: true }, "main inject payload")
  assert(panel, "sidebar registration missing")
  assertEqual(panel.options.id, "pdf-workbench", "sidebar id")
  assertEqual(panel.options.order, 56, "sidebar order")
  assertEqual(typeof panel.options.label, "function", "label is a function")
  assert(panel.options.label().length > 0, "label is non-empty")
  const icon = miniReact.walk(miniReact.createElement(panel.component, { size: 16 }))
  assert(tagsOf(icon).has("svg"), "panel icon renders an svg")
})

check("stylesheet tokenises into many rules (no unclosed paren/quote collapse)", () => {
  const css = clientSource.match(/var CSS = `([\s\S]*?)`\n/)[1]
  let depth = 0
  let paren = 0
  let quote = null
  let rules = 0
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i]
    if (quote) {
      if (ch === "\\") i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2)
      i = end === -1 ? css.length : end + 1
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === "(") paren += 1
    else if (ch === ")") paren -= 1
    else if (ch === "{") { if (depth === 0) rules += 1; depth += 1 }
    else if (ch === "}") depth -= 1
  }
  assertEqual(depth, 0, "brace depth")
  assertEqual(paren, 0, "paren depth (an unclosed var() collapses the whole sheet)")
  assertEqual(quote, null, "unterminated string")
  assert(rules > 300, "top-level rules = " + rules + " (a collapsed sheet reads as 1)")
})

check("apply tolerates a context without slots", () => {
  moduleExports.apply({ locale: null })
  moduleExports.apply(null)
})

check("client source has no forbidden constructs", () => {
  assert(!/document\.body/.test(clientSource), "must not touch document.body")
  assert(!/@deepseek-ai\//.test(clientSource), "must not reference @deepseek-ai packages")
  assert(!/^\s*import\s/m.test(clientSource), "must not use import statements")
  const requires = [...clientSource.matchAll(/require\(\s*(["'])([^"']+)\1\s*\)/g)].map((match) => match[2])
  assertDeep(requires, ["react"], "only require('react')")
  const cssMatch = clientSource.match(/var CSS = `([\s\S]*?)`\n/)
  assert(cssMatch, "CSS template string found")
  const cssClasses = [...new Set([...cssMatch[1].matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]))]
  const unscoped = cssClasses.filter((name) => !name.startsWith("pdfw-"))
  assert(unscoped.length === 0, `unscoped CSS class names: ${unscoped.join(", ")}`)
  assert(!/:root\s*\{|(^|\n)\s*body\s*\{/.test(cssMatch[1]), "CSS must not style host roots")
  assert(cssMatch[1].includes("@media (prefers-reduced-motion:reduce)"), "reduced-motion guard")
})

/* ------------------------------------------------------------------------ */
/* 2. locale                                                                 */
/* ------------------------------------------------------------------------ */

check("locale defaults to Chinese and switches to English", () => {
  T.attachLocale(null)
  assertEqual(T.currentLang(), "zh", "default language")
  assertEqual(T.t("app.title"), "PDF 全能工具台", "zh title")
  T.attachLocale({ getSnapshot: () => ({ active: "en-US" }) })
  assertEqual(T.currentLang(), "en", "en language")
  assertEqual(T.t("app.title"), "PDF Workbench", "en title")
  assertEqual(T.pick({ zh: "中文", en: "English" }), "English", "localized pick")
  T.attachLocale({ getSnapshot: () => ({ active: "zh-CN" }) })
  assertEqual(T.pick({ zh: "中文", en: "English" }), "中文", "localized pick zh")
  assertEqual(T.pick("plain"), "plain", "plain string pick")
})

check("copy tables are complete and symmetric", () => {
  const zhKeys = Object.keys(T.COPY.zh)
  const enKeys = Object.keys(T.COPY.en)
  assertDeep(enKeys.sort(), zhKeys.sort(), "zh/en key parity")
  for (const key of zhKeys) {
    assert(typeof T.COPY.zh[key] === "string" && T.COPY.zh[key].length > 0, `empty zh copy: ${key}`)
    assert(typeof T.COPY.en[key] === "string" && T.COPY.en[key].length > 0, `empty en copy: ${key}`)
  }
  T.attachLocale(null)
  for (const key of zhKeys) assert(T.t(key) !== key, `t() leaked key in zh: ${key}`)
  T.attachLocale({ getSnapshot: () => ({ active: "en" }) })
  for (const key of zhKeys) assert(T.t(key) !== key, `t() leaked key in en: ${key}`)
  T.attachLocale(null)
})

check("interpolate fills placeholders", () => {
  assertEqual(T.interpolate("a {n} b {x}", { n: 2 }), "a 2 b {x}", "partial interpolation")
  assertEqual(T.interpolate("plain"), "plain", "no vars")
})

/* ------------------------------------------------------------------------ */
/* 3. pure helpers                                                           */
/* ------------------------------------------------------------------------ */

check("formatBytes", () => {
  assertEqual(T.formatBytes(0), "0 B", "zero")
  assertEqual(T.formatBytes(512), "512 B", "bytes")
  assertEqual(T.formatBytes(1536), "1.5 KB", "kilobytes")
  assertEqual(T.formatBytes(1024 * 1024), "1.0 MB", "megabytes")
  assertEqual(T.formatBytes(100 * 1024 * 1024), "100.0 MB", "100MB limit")
  assertEqual(T.formatBytes(-1), "—", "negative")
})

check("formatDuration", () => {
  assertEqual(T.formatDuration(820), "1s", "sub-second rounds")
  assertEqual(T.formatDuration(45000), "45s", "seconds")
  assertEqual(T.formatDuration(80000), "1m 20s", "minutes")
  assertEqual(T.formatDuration(3900000), "1h 05m", "hours")
})

check("progressPercent clamps and rounds", () => {
  assertEqual(T.progressPercent(0), 0, "zero")
  assertEqual(T.progressPercent(0.426), 43, "rounds")
  assertEqual(T.progressPercent(1), 100, "one")
  assertEqual(T.progressPercent(3), 100, "clamped high")
  assertEqual(T.progressPercent(-2), 0, "clamped low")
})

check("nextDelay backs off 400ms ×1.4 to a 1500ms cap", () => {
  assertEqual(T.nextDelay(undefined), 400, "starts at 400")
  assertEqual(T.nextDelay(0), 400, "zero start")
  assertEqual(T.nextDelay(400), 560, "first backoff")
  let delay = 400
  const seen = [delay]
  for (let i = 0; i < 12; i += 1) {
    delay = T.nextDelay(delay)
    seen.push(delay)
  }
  assertEqual(seen[seen.length - 1], T.POLL_MAX_MS, "caps at max")
  assert(seen.every((value) => value <= T.POLL_MAX_MS), "never exceeds max")
  assert(seen[1] > seen[0], "monotonic before the cap")
})

check("isTerminalStatus", () => {
  assert(T.isTerminalStatus("done"), "done")
  assert(T.isTerminalStatus("failed"), "failed")
  assert(T.isTerminalStatus("cancelled"), "cancelled")
  assert(!T.isTerminalStatus("running"), "running is not terminal")
  assert(!T.isTerminalStatus("queued"), "queued is not terminal")
  assert(!T.isTerminalStatus(undefined), "undefined is not terminal")
})

check("normalizeLimits merges and guards", () => {
  const merged = T.normalizeLimits({ maxFileBytes: 10, maxBatchFiles: 2, maxBatchBytes: 20 })
  assertEqual(merged.maxFileBytes, 10, "explicit max file")
  assertEqual(merged.maxBatchFiles, 2, "explicit batch")
  assertEqual(merged.maxBatchBytes, 20, "explicit total")
  assertEqual(merged.retentionMs, T.FALLBACK_LIMITS.retentionMs, "retention fallback")
  const guarded = T.normalizeLimits({ maxFileBytes: "nope", maxBatchFiles: -1 })
  assertEqual(guarded.maxFileBytes, T.FALLBACK_LIMITS.maxFileBytes, "bad value falls back")
  assertEqual(guarded.maxBatchFiles, T.FALLBACK_LIMITS.maxBatchFiles, "negative falls back")
  assertEqual(T.normalizeLimits(null).maxBatchFiles, T.FALLBACK_LIMITS.maxBatchFiles, "null falls back")
})

/* ------------------------------------------------------------------------ */
/* 4. front-end limit pre-check                                              */
/* ------------------------------------------------------------------------ */

const LIMITS = T.normalizeLimits(CATALOG.limits)

function fakeFile(name, size) {
  return { name, size }
}

check("validateFiles rejects oversized single files", () => {
  const result = T.validateFiles(LIMITS, [], [fakeFile("big.pdf", LIMITS.maxFileBytes + 1), fakeFile("ok.pdf", 1024)])
  assertEqual(result.accepted.length, 1, "only the small file accepted")
  assertEqual(result.accepted[0].name, "ok.pdf", "accepted name")
  assertEqual(result.rejected.length, 1, "one rejected")
  assertEqual(result.rejected[0].reason, "tooLarge", "tooLarge reason")
  assertEqual(result.rejected[0].name, "big.pdf", "rejected name")
})

check("validateFiles enforces the 20-file batch cap", () => {
  const incoming = []
  for (let i = 0; i < LIMITS.maxBatchFiles + 1; i += 1) incoming.push(fakeFile(`f${i}.pdf`, 10))
  const result = T.validateFiles(LIMITS, [], incoming)
  assertEqual(result.accepted.length, LIMITS.maxBatchFiles, "accepted at cap")
  assertEqual(result.rejected.length, 1, "one over the cap")
  assertEqual(result.rejected[0].reason, "tooMany", "tooMany reason")
})

check("validateFiles enforces the total byte cap", () => {
  const existing = [fakeFile("a.pdf", LIMITS.maxFileBytes), fakeFile("b.pdf", LIMITS.maxFileBytes), fakeFile("c.pdf", LIMITS.maxFileBytes)]
  const result = T.validateFiles(LIMITS, existing, [fakeFile("d.pdf", 4096)])
  assertEqual(result.accepted.length, 0, "extra file rejected")
  assertEqual(result.rejected[0].reason, "tooManyBytes", "tooManyBytes reason")
})

check("validateFiles counts files already added", () => {
  const existing = []
  for (let i = 0; i < LIMITS.maxBatchFiles; i += 1) existing.push(fakeFile(`e${i}.pdf`, 10))
  const result = T.validateFiles(LIMITS, existing, [fakeFile("extra.pdf", 10)])
  assertEqual(result.accepted.length, 0, "nothing accepted past the cap")
  assertEqual(result.rejected[0].reason, "tooMany", "reason")
})

check("validateFiles accepts a valid batch", () => {
  const result = T.validateFiles(LIMITS, [], [fakeFile("a.pdf", 100), fakeFile("b.pdf", 200)])
  assertEqual(result.accepted.length, 2, "both accepted")
  assertEqual(result.rejected.length, 0, "none rejected")
})

/* ------------------------------------------------------------------------ */
/* 5. declarative fields                                                     */
/* ------------------------------------------------------------------------ */

const resizeOp = CATALOG.operations.find((operation) => operation.id === "page.resize")
const encryptOp = CATALOG.operations.find((operation) => operation.id === "edit.encrypt")
const cropOp = CATALOG.operations.find((operation) => operation.id === "page.crop")
const qaOp = CATALOG.operations.find((operation) => operation.id === "ai.qa")

check("defaultsFor materializes catalog defaults", () => {
  const defaults = T.defaultsFor(resizeOp.fields)
  assertEqual(defaults.sizePreset, "A4", "select default")
  assertEqual(defaults.margin, "0", "number default kept as string")
  assertEqual(defaults.keepMetadata, true, "switch default stays boolean")
  assertEqual(defaults.customWidth, "210", "conditional default")
  assertEqual(defaults.background, "#ffffff", "color default")
})

check("visibleFields honours visibleWhen", () => {
  const defaults = T.defaultsFor(resizeOp.fields)
  const visible = T.visibleFields(resizeOp.fields, defaults).map((field) => field.key)
  assert(visible.includes("sizePreset"), "sizePreset visible")
  assert(!visible.includes("customWidth"), "customWidth hidden for A4")
  const custom = T.visibleFields(resizeOp.fields, Object.assign({}, defaults, { sizePreset: "custom" })).map((field) => field.key)
  assert(custom.includes("customWidth"), "customWidth visible for custom")
  assert(custom.includes("customHeight"), "customHeight visible for custom")
  assert(custom.includes("unit"), "unit visible for custom")
})

check("buildParams coerces numbers, switches and drops hidden fields", () => {
  const defaults = T.defaultsFor(resizeOp.fields)
  const values = Object.assign({}, defaults, { sizePreset: "A4", margin: "12", keepMetadata: false, customWidth: "999" })
  const params = T.buildParams(resizeOp.fields, values)
  assertEqual(params.sizePreset, "A4", "select string")
  assertEqual(params.margin, 12, "number coerced")
  assertEqual(params.keepMetadata, false, "switch boolean")
  assertEqual(params.background, "#ffffff", "color string")
  assertEqual(params.customWidth, undefined, "hidden field excluded")
})

check("formFields hides the chat question from the parameter panel", () => {
  const defaults = T.defaultsFor(qaOp.fields)
  const keys = T.formFields(qaOp, defaults).map((field) => field.key)
  assert(!keys.includes("question"), "question moved to the chat composer")
  assert(keys.includes("pageRange"), "pageRange still shown")
})

check("validateValues flags required / non-numeric / out-of-range", () => {
  const encryptDefaults = T.defaultsFor(encryptOp.fields)
  const missing = T.validateValues(encryptOp.fields, encryptDefaults)
  assertEqual(missing.length, 1, "one required issue")
  assertEqual(missing[0].code, "REQUIRED", "required code")
  assertEqual(missing[0].key, "userPassword", "required key")

  const cropDefaults = T.defaultsFor(cropOp.fields)
  const tooBig = T.validateValues(cropOp.fields, Object.assign({}, cropDefaults, { threshold: "999" }))
  assertEqual(tooBig.length, 1, "one range issue")
  assertEqual(tooBig[0].code, "TOO_LARGE", "range code")

  const notNumber = T.validateValues(cropOp.fields, Object.assign({}, cropDefaults, { threshold: "abc" }))
  assertEqual(notNumber[0].code, "NOT_NUMBER", "not-a-number code")

  const ok = T.validateValues(cropOp.fields, cropDefaults)
  assertEqual(ok.length, 0, "defaults are valid")
})

check("issueMessage builds a readable, localized reason", () => {
  const issue = { key: "threshold", code: "TOO_LARGE", label: { zh: "白边判定灵敏度", en: "Whiteness sensitivity" }, min: 200, max: 255 }
  const message = T.issueMessage(issue, cropOp.fields)
  assert(message.includes("255"), "range value in message")
  assert(message.includes("白边判定灵敏度"), "field label in message")
})

/* ------------------------------------------------------------------------ */
/* 6. navigation & search                                                    */
/* ------------------------------------------------------------------------ */

check("buildNavigation groups the catalog into sections", () => {
  const nav = T.buildNavigation(CATALOG)
  assertEqual(nav.length, 4, "four groups")
  assertEqual(T.countNavigationOps(nav), CATALOG.operations.length, "every operation reachable")
  const edit = nav.find((entry) => entry.group.id === "edit")
  const sectionTitles = edit.sections.map((section) => section.title)
  assert(sectionTitles.includes("基础操作"), "edit basics section")
  assert(sectionTitles.includes("页面排版"), "edit layout section")
})

check("filterNavigation searches across groups, keeps groups open", () => {
  const nav = T.buildNavigation(CATALOG)
  const hit = T.filterNavigation(nav, "word")
  assert(hit.length >= 1, "at least one group matched")
  const ids = hit.flatMap((entry) => T.navigationOps(entry).map((operation) => operation.id))
  assert(ids.includes("convert.pdf2word"), "PDF to Word matched")
  const none = T.filterNavigation(nav, "zzzz-not-a-tool")
  assertEqual(none.length, 0, "no group matches")
  assertEqual(T.countNavigationOps(T.filterNavigation(nav, "")), CATALOG.operations.length, "empty query keeps everything")
  const zhHit = T.filterNavigation(nav, "压缩")
  assert(zhHit.flatMap((entry) => T.navigationOps(entry)).some((operation) => operation.id === "edit.compress"), "Chinese title matches")
})

check("highlightParts splits around the query", () => {
  const parts = T.highlightParts("PDF to Word", "word")
  assertEqual(parts.length, 2, "two parts")
  assertEqual(parts[0].hit, false, "prefix")
  assertEqual(parts[1].hit, true, "hit")
  assertEqual(parts[1].text.toLowerCase(), "word", "hit text")
  assertEqual(T.highlightParts("abc", "").length, 1, "empty query")
})

/* ------------------------------------------------------------------------ */
/* 7. capability + preview + misc helpers                                    */
/* ------------------------------------------------------------------------ */

check("capabilityGap reports missing AI / OCR", () => {
  const aiOp = CATALOG.operations.find((operation) => operation.ai === true)
  assertEqual(T.capabilityGap(aiOp, { capabilities: { ai: { available: false } } }), "ai", "ai gap")
  assertEqual(T.capabilityGap(aiOp, { capabilities: { ai: { available: true } } }), null, "ai available")
  assertEqual(T.capabilityGap({ engine: "ocr" }, { capabilities: { ocr: false } }), "ocr", "ocr gap")
  assertEqual(T.capabilityGap({ engine: "merge" }, { capabilities: { ocr: false } }), null, "no gap")
  assertEqual(T.capabilityGap(null, null), null, "null op")
})

check("previewKindFor maps artifact kinds", () => {
  assertEqual(T.previewKindFor({ kind: "pdf" }), "pdf", "pdf")
  assertEqual(T.previewKindFor({ kind: "image" }), "image", "image")
  assertEqual(T.previewKindFor({ kind: "png" }), "image", "png")
  assertEqual(T.previewKindFor({ kind: "text" }), "text", "text")
  assertEqual(T.previewKindFor({ kind: "md" }), "text", "md")
  assertEqual(T.previewKindFor({ kind: "json" }), "text", "json")
  assertEqual(T.previewKindFor({ kind: "docx" }), "none", "docx")
  assertEqual(T.previewKindFor({ kind: "zip" }), "none", "zip")
  assertEqual(T.previewKindFor(null), "none", "null")
})

check("formatLabels humanizes accept lists", () => {
  assertDeep(T.formatLabels(".pdf"), ["PDF"], "pdf only")
  assertDeep(T.formatLabels(".doc,.docx"), ["Word"], "word dedupes")
  assert(T.formatLabels(".png,.jpg").includes("PNG"), "png label")
})

check("estimateRemainingMs", () => {
  const now = 100000
  assertEqual(T.estimateRemainingMs(null), null, "no job")
  assertEqual(T.estimateRemainingMs({ progress: 0, startedAt: now - 1000 }), null, "no progress")
  const remaining = T.estimateRemainingMs({ progress: 0.5, startedAt: now - 1000 }, now)
  assert(remaining > 900 && remaining < 1100, `expected ~1000ms, got ${remaining}`)
  assertEqual(T.estimateRemainingMs({ progress: 1, startedAt: now - 1000 }, now), null, "finished")
})

/* ------------------------------------------------------------------------ */
/* 8. rendering: every view runs without throwing                            */
/* ------------------------------------------------------------------------ */

const limits = LIMITS
const nav = T.buildNavigation(CATALOG)

function render(component, props) {
  return miniReact.walk(miniReact.createElement(component, props || {}))
}

function makeWorkspace(files, values, extra) {
  return Object.assign(
    {
      files,
      values,
      error: null,
      job: null,
      jobId: null,
      busy: false,
      stage: null,
      messages: [],
      question: "",
      addFiles() {},
      removeFile() {},
      moveFile() {},
      setFieldValue() {},
      resetParams() {},
      setQuestion() {},
      start() {},
      ask() {},
      cancel() {},
      reprocess() {},
      retryFile() {},
      clearError() {},
    },
    extra || {}
  )
}

function fakeEntry(name, size) {
  return { id: "id-" + name, name, size, file: { name, size } }
}

check("Workbench renders the three-column shell before catalog loads", () => {
  const tree = render(T.components.Workbench, { workbench: true })
  const classes = classesOf(tree)
  assert(classes.some((value) => value.includes("pdfw-root")), "root class")
  assert(classes.some((value) => value.includes("pdfw-col--left")), "left column")
  assert(classes.some((value) => value.includes("pdfw-col--center")), "center column")
  assert(classes.some((value) => value.includes("pdfw-col--right")), "right column")
  assert(tagsOf(tree).has("style"), "scoped style element rendered")
  assert(textOf(tree).includes("PDF 全能工具台"), "brand copy rendered")
})

check("HomeView renders grouped cards, highlights search and shows the empty state", () => {
  const tree = render(T.components.HomeView, { nav, query: "", onQueryChange() {}, onOpen() {} })
  const classes = classesOf(tree)
  assert(classes.filter((value) => value.includes("pdfw-home-group")).length >= 4, "four home groups")
  assert(classes.filter((value) => value.includes("pdfw-opcard")).length > 10, "many cards")
  assert(tagsOf(tree).has("input"), "home search input")
  const filtered = render(T.components.HomeView, { nav, query: "word", onQueryChange() {}, onOpen() {} })
  assert(tagsOf(filtered).has("mark"), "search hit highlighted")
  const empty = render(T.components.HomeView, { nav, query: "zzz-no-hit", onQueryChange() {}, onOpen() {} })
  assert(textOf(empty).includes("没有找到匹配的功能"), "empty state copy")
})

check("LeftNav renders groups, sections and the active tool", () => {
  const tree = render(T.components.LeftNav, { nav, query: "", activeOpId: "edit.merge", onOpen() {} })
  const classes = classesOf(tree)
  assert(classes.some((value) => value.includes("pdfw-nav-group-head")), "group headers")
  assert(textOf(tree).includes("基础操作"), "section title")
  assert(classes.some((value) => value.includes("is-active")), "active tool highlighted")
  const searching = render(T.components.LeftNav, { nav, query: "word", activeOpId: null, onOpen() {} })
  assert(textOf(searching).includes("PDF 转 Word"), "search result in tree")
})

check("WorkspaceView renders steps 1-3 and blocks without files", () => {
  const op = resizeOp
  const tree = render(T.components.WorkspaceView, {
    op,
    ws: makeWorkspace([], T.defaultsFor(op.fields)),
    limits,
    info: null,
  })
  const classes = classesOf(tree)
  assert(classes.some((value) => value.includes("pdfw-upload")), "upload section")
  assert(classes.some((value) => value.includes("pdfw-params")), "params section")
  assert(classes.some((value) => value.includes("pdfw-run")), "run section")
  assert(classes.some((value) => value.includes("pdfw-drop")), "drop zone")
  const text = textOf(tree)
  assert(text.includes("上传文件"), "step 1 copy")
  assert(text.includes("参数设置"), "step 2 copy")
  assert(text.includes("开始处理"), "step 3 copy")
  assert(text.includes("请先添加"), "blocked reason shown")
  assert(text.includes("纸张规格"), "catalog field label rendered")
  assert(text.includes("等比缩放适配"), "radio option rendered")
  assert(tagsOf(tree).has("select"), "select control")
  assert(tagsOf(tree).has("input"), "number/text control")
})

check("WorkspaceView enables start with a file and valid params", () => {
  const op = resizeOp
  const tree = render(T.components.WorkspaceView, {
    op,
    ws: makeWorkspace([fakeEntry("合同.pdf", 2048)], T.defaultsFor(op.fields)),
    limits,
    info: null,
  })
  const text = textOf(tree)
  assert(text.includes("合同.pdf"), "file name listed")
  assert(text.includes("2.0 KB"), "file size formatted")
  assert(!text.includes("无法开始"), "no blocked reason")
})

check("WorkspaceView shows progress + error panels when busy / failing", () => {
  const op = resizeOp
  const job = { id: "j_1", status: "running", progress: 0.42, stage: "正在处理第 3 页", startedAt: Date.now() - 2000 }
  const tree = render(T.components.WorkspaceView, {
    op,
    ws: makeWorkspace([fakeEntry("a.pdf", 1024)], T.defaultsFor(op.fields), {
      busy: true,
      stage: "processing",
      job,
      error: { code: "ENGINE", message: "引擎崩溃", hint: "请重试" },
    }),
    limits,
    info: null,
  })
  const text = textOf(tree)
  assert(text.includes("处理进度"), "step 4 shown")
  assert(text.includes("42%"), "progress percent")
  assert(text.includes("正在处理第 3 页"), "engine stage copy")
  assert(text.includes("引擎崩溃"), "error message")
  assert(text.includes("请重试"), "error hint")
  assert(classesOf(tree).some((value) => value.includes("pdfw-progress-fill")), "progress bar rendered")
})

check("WorkspaceView surfaces a missing AI capability", () => {
  const op = CATALOG.operations.find((operation) => operation.ai === true)
  const tree = render(T.components.WorkspaceView, {
    op,
    ws: makeWorkspace([fakeEntry("a.pdf", 1024)], T.defaultsFor(op.fields)),
    limits,
    info: { capabilities: { ai: { available: false } } },
  })
  const text = textOf(tree)
  assert(text.includes("未配置 AI 模型"), "AI warning copy")
})

check("ResultPane previews a PDF output and offers downloads", () => {
  const op = CATALOG.operations.find((operation) => operation.id === "page.resize")
  const output = { id: "f_1", name: "合同_A4.pdf", kind: "pdf", bytes: 234567, pages: 12 }
  const job = {
    id: "j_1",
    status: "done",
    progress: 1,
    inputs: [{ name: "合同.pdf", size: 1024 }],
    items: [{ input: "合同.pdf", ok: true, error: null, outputs: [output] }],
    outputs: [output],
    text: "",
  }
  const tree = render(T.components.ResultPane, { op, ws: makeWorkspace([fakeEntry("合同.pdf", 1024)], T.defaultsFor(op.fields), { job, jobId: "j_1" }), limits, info: null })
  const tags = tagsOf(tree)
  assert(tags.has("img"), "pdf preview image")
  assert(textOf(tree).includes("合同_A4.pdf"), "output name")
  assert(textOf(tree).includes("229.1 KB"), "output size")
  const props = propsOf(tree)
  assert(props.some((value) => value.includes("/api/pdf-workbench/preview") && value.includes("page=1")), "preview url")
  assert(props.some((value) => value.includes("/api/pdf-workbench/file")), "file download url")
  const anchors = []
  collect(tree, (node) => {
    if (node.tag === "a" && node.props && node.props.download) anchors.push(node.props)
  })
  assert(anchors.length >= 1, "download anchor with download attribute")
  assertEqual(anchors[0].download, "合同_A4.pdf", "download filename")
  assert(textOf(tree).includes("说明与限制"), "notes rendered under results")
})

check("ResultPane renders a batch list with per-file retry", () => {
  const op = CATALOG.operations.find((operation) => operation.id === "page.batchResize")
  const job = {
    id: "j_2",
    status: "done",
    progress: 1,
    inputs: [
      { name: "a.pdf", size: 100 },
      { name: "b.pdf", size: 200 },
    ],
    items: [
      { input: "a.pdf", ok: true, error: null, outputs: [{ id: "f_a", name: "a_A4.pdf", kind: "pdf", bytes: 120, pages: 2 }] },
      { input: "b.pdf", ok: false, error: { code: "BROKEN", message: "无法解析", hint: "换一个文件" }, outputs: [] },
    ],
    outputs: [{ id: "f_a", name: "a_A4.pdf", kind: "pdf", bytes: 120, pages: 2 }],
    text: "",
  }
  const tree = render(T.components.ResultPane, { op, ws: makeWorkspace([fakeEntry("a.pdf", 100), fakeEntry("b.pdf", 200)], T.defaultsFor(op.fields), { job, jobId: "j_2" }), limits, info: null })
  const text = textOf(tree)
  assert(text.includes("批量任务"), "batch title")
  assert(text.includes("a.pdf") && text.includes("b.pdf"), "both inputs listed")
  assert(text.includes("无法解析"), "per-file error")
  assert(text.includes("换一个文件"), "per-file hint")
  assert(text.includes("成功 1") || text.includes("成功"), "batch summary")
  assert(text.includes("重试该文件"), "retry button copy")
  const classes = classesOf(tree)
  assert(classes.some((value) => value.includes("pdfw-batch-row pdfw-is-success")), "success row")
  assert(classes.some((value) => value.includes("pdfw-batch-row pdfw-is-failed")), "failed row")
})

check("ResultPane renders Markdown text results as formatted blocks", () => {
  const op = CATALOG.operations.find((operation) => operation.id === "ai.summary")
  const body = "# 摘要\n\n- 要点一\n- 要点二\n\n| 甲方 | 乙方 |\n| --- | --- |\n| 甲公司 | 乙公司 |\n\n**加粗**结论"
  const job = { id: "j_3", status: "done", progress: 1, inputs: [{ name: "a.pdf", size: 10 }], items: [], outputs: [], text: body }
  const tree = render(T.components.ResultPane, { op, ws: makeWorkspace([fakeEntry("a.pdf", 10)], T.defaultsFor(op.fields), { job, jobId: "j_3" }), limits, info: null })
  const tags = tagsOf(tree)
  const classes = classesOf(tree)
  const text = textOf(tree)
  assert(classes.some((value) => value.includes("pdfw-md")), "markdown container")
  assert(tags.has("h3") || tags.has("h4") || tags.has("h5"), "heading rendered as a heading element")
  assert(tags.has("ul") || tags.has("ol"), "list rendered as a list")
  assert(tags.has("table"), "table rendered as a table")
  assert(tags.has("strong"), "bold rendered as strong")
  assert(text.includes("摘要") && text.includes("甲公司"), "content preserved")
  assert(!text.includes("# 摘要"), "markdown markers stripped")
  assert(text.includes("复制正文"), "copy action")
})

check("ResultPane renders a failed job with retry", () => {
  const op = resizeOp
  const job = { id: "j_4", status: "failed", progress: 0, inputs: [{ name: "a.pdf", size: 10 }], items: [], outputs: [], error: { code: "NEED_PASSWORD", message: "该 PDF 已加密", hint: "填写密码后重试" } }
  const tree = render(T.components.ResultPane, { op, ws: makeWorkspace([fakeEntry("a.pdf", 10)], T.defaultsFor(op.fields), { job, jobId: "j_4" }), limits, info: null })
  const text = textOf(tree)
  assert(text.includes("该 PDF 已加密"), "job error message")
  assert(text.includes("填写密码后重试"), "job error hint")
  assert(text.includes("重新处理"), "reprocess action")
})

check("ResultPane shows an empty state before any job", () => {
  const op = resizeOp
  const tree = render(T.components.ResultPane, { op, ws: makeWorkspace([], T.defaultsFor(op.fields)), limits, info: null })
  const text = textOf(tree)
  assert(text.includes("还没有结果"), "empty state title")
  assert(text.includes("还没有文件") || text.includes("完成一次处理"), "empty hint")
})

check("ChatPane renders bubbles and a composer", () => {
  const tree = render(T.components.ChatPane, {
    messages: [
      { role: "user", content: "这条合同的违约条款是什么？" },
      { role: "assistant", content: "第 8 页第 3 条约定……" },
    ],
    question: "",
    busy: false,
    onQuestionChange() {},
    onSend() {},
  })
  const text = textOf(tree)
  assert(text.includes("这条合同的违约条款是什么？"), "user bubble")
  assert(text.includes("第 8 页第 3 条约定"), "assistant bubble")
  assert(text.includes("你") && text.includes("AI"), "role labels")
  assert(tagsOf(tree).has("textarea"), "composer")
  assert(classesOf(tree).some((value) => value.includes("pdfw-bubble--user")), "user bubble class")
  assert(classesOf(tree).some((value) => value.includes("pdfw-bubble--ai")), "ai bubble class")
  const thinking = render(T.components.ChatPane, { messages: [], question: "", busy: true, onQuestionChange() {}, onSend() {} })
  assert(textOf(thinking).includes("正在思考"), "thinking indicator")
})

check("NotesPanel lists limits and retention", () => {
  const tree = render(T.components.NotesPanel, { limits, info: { retentionHours: 24 }, op: resizeOp })
  const text = textOf(tree)
  assert(text.includes("说明与限制"), "notes title")
  assert(text.includes("100.0 MB"), "max file size")
  assert(text.includes("24"), "retention hours")
  assert(text.includes("可上传"), "accepted formats")
})

check("UploadZone lists files, supports reorder, and shows the format hint", () => {
  const op = CATALOG.operations.find((operation) => operation.id === "edit.merge")
  const files = [fakeEntry("a.pdf", 1024), fakeEntry("b.pdf", 2048)]
  const tree = render(T.components.UploadZone, { op, files, limits, onFiles() {}, onRemove() {}, onMove() {} })
  const text = textOf(tree)
  assert(text.includes("a.pdf") && text.includes("b.pdf"), "file names")
  assert(text.includes("拖动文件可调整处理顺序"), "reorder hint")
  assert(text.includes("支持格式: PDF"), "format hint")
  assert(text.includes("最多 20 个文件"), "batch cap hint")
  const moves = []
  collect(tree, (node) => {
    if (node.tag === "button" && node.props && typeof node.props.onClick === "function" && node.props["aria-label"] === "上移") moves.push(node)
  })
  assert(moves.length >= 1, "keyboard reorder buttons")
  const empty = render(T.components.UploadZone, { op, files: [], limits, onFiles() {}, onRemove() {}, onMove() {} })
  assert(textOf(empty).includes("还没有文件"), "empty file list copy")
})

check("ParamsPanel renders switches with role=switch and aria-checked", () => {
  const op = resizeOp
  const tree = render(T.components.ParamsPanel, {
    fields: T.formFields(op, T.defaultsFor(op.fields)),
    values: T.defaultsFor(op.fields),
    issues: [],
    onChange() {},
    onReset() {},
  })
  const switches = []
  collect(tree, (node) => {
    if (node.tag === "button" && node.props && node.props.role === "switch") switches.push(node.props)
  })
  assert(switches.length >= 1, "switch control rendered")
  assert(typeof switches[0]["aria-checked"] === "string", "aria-checked present")
  const radios = []
  collect(tree, (node) => {
    if (node.tag === "button" && node.props && node.props.role === "radio") radios.push(node.props)
  })
  assert(radios.length >= 2, "segmented radio group")
  const color = []
  collect(tree, (node) => {
    if (node.tag === "input" && node.props && node.props.type === "color") color.push(node.props)
  })
  assert(color.length === 1, "color swatch input")
})

check("ErrorStrip renders message, hint, reason code and retry", () => {
  const tree = render(T.components.ErrorStrip, { error: { code: "BAD_REQUEST", message: "参数不合法", hint: "请检查页码" }, onRetry() {} })
  const text = textOf(tree)
  assert(text.includes("参数不合法"), "message")
  assert(text.includes("请检查页码"), "hint")
  assert(text.includes("BAD_REQUEST"), "code")
  assert(text.includes("重试"), "retry label")
})

check("every catalog operation renders its workspace, fields and result pane", () => {
  const problems = []
  for (const op of CATALOG.operations) {
    try {
      const values = T.defaultsFor(op.fields)
      const tree = render(T.components.WorkspaceView, { op, ws: makeWorkspace([fakeEntry("示例.pdf", 4096)], values), limits, info: null })
      const text = textOf(tree)
      for (const field of T.formFields(op, values)) {
        const label = T.pick(field.label)
        if (label && !text.includes(label)) problems.push(`${op.id}: label "${label}" missing`)
      }
      const leaks = (text.match(/\b[a-z]+(?:\.[a-zA-Z]+)+\b/g) || []).filter((token) => COPY_NAMESPACES.has(token.split(".")[0]))
      if (leaks.length) problems.push(`${op.id}: copy keys ${[...new Set(leaks)].join(",")}`)
      if (text.includes("undefined")) problems.push(`${op.id}: rendered undefined`)
      const classes = classesOf(tree)
      for (const expected of ["pdfw-upload", "pdfw-params", "pdfw-run"]) {
        if (!classes.some((value) => value.includes(expected))) problems.push(`${op.id}: missing ${expected}`)
      }
      const doneJob = {
        id: "j_" + op.id,
        op: op.id,
        status: "done",
        progress: 1,
        inputs: [{ name: "示例.pdf", size: 4096 }],
        items: [{ input: "示例.pdf", ok: true, error: null, outputs: [] }],
        outputs: [],
        text: op.ai === true ? "# 结果" : "",
      }
      const results = render(T.components.ResultPane, { op, ws: makeWorkspace([fakeEntry("示例.pdf", 4096)], values, { job: doneJob, jobId: doneJob.id }), limits, info: null })
      const resultText = textOf(results)
      if (resultText.includes("undefined")) problems.push(`${op.id}: result rendered undefined`)
      if (op.chat === true && !resultText.includes("对话问答")) problems.push(`${op.id}: chat pane missing`)
      if (op.ai === true && op.chat !== true && !resultText.includes("# 结果")) problems.push(`${op.id}: text result missing`)
    } catch (error) {
      problems.push(`${op.id}: threw ${error && error.message ? error.message : error}`)
    }
  }
  assert(problems.length === 0, problems.slice(0, 8).join(" | "))
})

check("every operation advertises at least one accepted format", () => {
  const problems = []
  for (const op of CATALOG.operations) {
    if (!T.formatLabels(op.accept).length) problems.push(op.id)
  }
  assert(problems.length === 0, problems.join(", "))
})

/* ------------------------------------------------------------------------ */
/* 9. English rendering has no missing copy                                  */
/* ------------------------------------------------------------------------ */

check("views render in English without leaking copy keys", () => {
  T.attachLocale({ getSnapshot: () => ({ active: "en" }) })
  const parts = []
  parts.push(textOf(render(T.components.HomeView, { nav, query: "", onQueryChange() {}, onOpen() {} })))
  parts.push(textOf(render(T.components.WorkspaceView, { op: resizeOp, ws: makeWorkspace([fakeEntry("a.pdf", 10)], T.defaultsFor(resizeOp.fields)), limits, info: null })))
  parts.push(textOf(render(T.components.NotesPanel, { limits, info: { retentionHours: 24 }, op: resizeOp })))
  const all = parts.join(" \n ")
  assert(all.includes("Pick a tool to start"), "English home copy")
  assert(all.includes("Upload files"), "English step 1")
  assert(all.includes("Notes & limits"), "English notes")
  const leaks = (all.match(/\b[a-z]+(?:\.[a-zA-Z]+)+\b/g) || []).filter((token) => COPY_NAMESPACES.has(token.split(".")[0]))
  assert(leaks.length === 0, `copy keys leaked: ${[...new Set(leaks)].join(", ")}`)
  assert(!all.includes("undefined"), "no undefined in rendered copy")
  assert(!all.includes("[object Object]"), "no stringified objects in rendered copy")
  T.attachLocale(null)
})

check("Chinese rendering has no missing copy", () => {
  T.attachLocale(null)
  const all = [
    textOf(render(T.components.HomeView, { nav, query: "", onQueryChange() {}, onOpen() {} })),
    textOf(render(T.components.WorkspaceView, { op: encryptOp, ws: makeWorkspace([fakeEntry("a.pdf", 10)], T.defaultsFor(encryptOp.fields)), limits, info: null })),
    textOf(render(T.components.NotesPanel, { limits, info: null, op: null })),
  ].join(" \n ")
  assert(all.includes("选择一个工具开始"), "Chinese home copy")
  assert(!all.includes("undefined"), "no undefined in rendered copy")
  assert(!all.includes("[object Object]"), "no stringified objects in rendered copy")
  const leaks = (all.match(/\b[a-z]+(?:\.[a-zA-Z]+)+\b/g) || []).filter((token) => COPY_NAMESPACES.has(token.split(".")[0]))
  assert(leaks.length === 0, `copy keys leaked: ${[...new Set(leaks)].join(", ")}`)
})

check("endpoint builders use exact paths with query parameters", () => {
  assertEqual(T.ENDPOINTS.catalog, "/api/pdf-workbench/catalog", "catalog")
  assertEqual(T.ENDPOINTS.job("j_1"), "/api/pdf-workbench/job?id=j_1", "job")
  assertEqual(T.ENDPOINTS.file("j_1", "f_1", false), "/api/pdf-workbench/file?job=j_1&file=f_1", "file")
  assertEqual(T.ENDPOINTS.file("j_1", "f_1", true), "/api/pdf-workbench/file?job=j_1&file=f_1&inline=1", "inline file")
  assertEqual(T.ENDPOINTS.preview("j_1", "f_1", 3, 900), "/api/pdf-workbench/preview?job=j_1&file=f_1&page=3&w=900", "preview")
  assertEqual(T.ENDPOINTS.pages("j_1", "f_1"), "/api/pdf-workbench/pages?job=j_1&file=f_1", "pages")
  assert(T.ENDPOINTS.file("j /1", "f&1", false).includes("job=j%20%2F1"), "ids are encoded")
})

/* ------------------------------------------------------------------------ */
/* 10. multi-turn chat reuses the Host-uploaded originals                     */
/* ------------------------------------------------------------------------ */

check("chat follow-ups reuse sourceIds instead of re-uploading files", () => {
  const chatOperation = CATALOG.operations.find((operation) => operation.chat === true)
  assert(chatOperation, "catalog has a chat operation")
  assert(T.reuseSourceIds(chatOperation, ["s_1"], false), "reuses known ids")
  assert(!T.reuseSourceIds(chatOperation, [], false), "uploads when no ids")
  assert(!T.reuseSourceIds(chatOperation, undefined, false), "uploads when ids unknown")
  assert(!T.reuseSourceIds(chatOperation, ["s_1"], true), "forceUpload wins")
  assert(!T.reuseSourceIds(resizeOp, ["s_1"], false), "non-chat tools never reuse")
  assertEqual(T.encodeSourceIds(["s_1", "s_2"]), '["s_1","s_2"]', "sourceIds payload")
  assertEqual(T.encodeSourceIds(null), "[]", "null payload")
  assertEqual(T.encodeSourceIds([1, "s_2"]), '["1","s_2"]', "ids are stringified")
})

/* ------------------------------------------------------------------------ */
/* 10. transport: envelopes, errors and request shape                        */
/* ------------------------------------------------------------------------ */

await checkAsync("apiGet unwraps the {ok:true,value} envelope", async () => {
  fetchCalls.length = 0
  fetchResponder = () => fakeResponse(200, JSON.stringify({ ok: true, value: { jobId: "j_9" } }))
  const value = await T.transport.apiGet(T.ENDPOINTS.job("j_9"))
  assertEqual(value.jobId, "j_9", "value")
  assertEqual(fetchCalls.length, 1, "one request")
  const call = fetchCalls[0]
  assertEqual(call.url, "/api/pdf-workbench/job?id=j_9", "url")
  assertEqual(call.init.method, "GET", "method")
  assertEqual(call.init.credentials, "same-origin", "credentials")
  assertEqual(call.init.headers.accept, "application/json", "accept header")
})

await checkAsync("apiGet surfaces error.message and error.hint", async () => {
  fetchResponder = () => fakeResponse(400, JSON.stringify({ ok: false, error: { code: "BAD_REQUEST", message: "op 不合法", hint: "检查参数" } }))
  let caught = null
  try {
    await T.transport.apiGet("/api/pdf-workbench/info")
  } catch (error) {
    caught = error
  }
  assert(caught, "rejects on ok:false")
  assertEqual(caught.code, "BAD_REQUEST", "code")
  assertEqual(caught.message, "op 不合法", "message")
  assertEqual(caught.hint, "检查参数", "hint")
})

await checkAsync("apiGet handles a non-JSON HTTP failure", async () => {
  fetchResponder = () => fakeResponse(502, "<html>bad gateway</html>")
  let caught = null
  try {
    await T.transport.apiGet("/api/pdf-workbench/catalog")
  } catch (error) {
    caught = error
  }
  assert(caught, "rejects")
  assertEqual(caught.code, "HTTP_502", "code")
  assert(caught.message.includes("502"), "status in message")
  assert(caught.hint && caught.hint.length > 0, "hint present")
})

await checkAsync("apiPostForm posts multipart with same-origin credentials", async () => {
  fetchCalls.length = 0
  fetchResponder = () => fakeResponse(200, JSON.stringify({ ok: true, value: { jobId: "j_1", status: "queued", sourceIds: [] } }))
  const form = { kind: "fake-formdata" }
  const value = await T.transport.apiPostForm(T.ENDPOINTS.jobs, form)
  assertEqual(value.jobId, "j_1", "jobId")
  const call = fetchCalls[0]
  assertEqual(call.url, "/api/pdf-workbench/jobs", "url")
  assertEqual(call.init.method, "POST", "method")
  assertEqual(call.init.body, form, "form body forwarded")
  assertEqual(call.init.credentials, "same-origin", "credentials")
})

await checkAsync("apiDelete cancels through the query-param endpoint", async () => {
  fetchCalls.length = 0
  fetchResponder = () => fakeResponse(200, JSON.stringify({ ok: true, value: { cancelled: true } }))
  const value = await T.transport.apiDelete(T.ENDPOINTS.job("j_1"))
  assertEqual(value.cancelled, true, "cancelled")
  assertEqual(fetchCalls[0].url, "/api/pdf-workbench/job?id=j_1", "url")
  assertEqual(fetchCalls[0].init.method, "DELETE", "method")
})

await checkAsync("apiGetText returns raw text and parses inline error envelopes", async () => {
  fetchResponder = () => fakeResponse(200, "# 标题\n正文")
  const text = await T.transport.apiGetText(T.ENDPOINTS.file("j", "f", true))
  assertEqual(text, "# 标题\n正文", "raw text")
  fetchResponder = () => fakeResponse(400, JSON.stringify({ ok: false, error: { code: "GONE", message: "产物已过期", hint: "重新处理" } }))
  let caught = null
  try {
    await T.transport.apiGetText(T.ENDPOINTS.file("j", "f", true))
  } catch (error) {
    caught = error
  }
  assert(caught, "rejects")
  assertEqual(caught.message, "产物已过期", "message")
  assertEqual(caught.hint, "重新处理", "hint")
})

await checkAsync("abort errors are recognised", async () => {
  const aborted = new Error("aborted")
  aborted.name = "AbortError"
  assert(T.transport.isAbortError(aborted), "AbortError name")
  assert(T.transport.isAbortError(T.transport.makeError("ABORTED", "x", "y")), "ABORTED code")
  assert(!T.transport.isAbortError(new Error("boom")), "plain error is not an abort")
})

/* ------------------------------------------------------------------------ */
/* report                                                                    */
/* ------------------------------------------------------------------------ */

const total = passed + failed
console.log(`pdf-workbench client selftest: ${passed}/${total} checks passed`)
if (failed > 0) {
  console.error("\nfailures:")
  for (const failure of failures) console.error("  ✗ " + failure)
  process.exitCode = 1
} else {
  console.log("all checks passed")
}
