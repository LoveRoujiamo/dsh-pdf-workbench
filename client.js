/**
 * PDF 全能工具台 / PDF Workbench — the single browser-side module.
 *
 * Loaded by the DSH client through `window.__ModuleLoader__.load(...)`; exports
 * `apply` + `inject` only (CONTRACT.md §3.1). No JSX, no bundler, no imports —
 * every element is written with `React.createElement` and every style rule is
 * scoped under `.pdfw-`.
 *
 * Layout: constants/copy → pure helpers → transport → UI atoms → feature views →
 * Workbench root → apply().
 */
window.__ModuleLoader__.load({
  id: "@local/pdf-workbench",
  factory: function (require) {
    "use strict"
    var module = { exports: {} }
    var exports = module.exports

    var React = require("react")
    var h = React.createElement
    var Fragment = React.Fragment
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef

    /* ==================================================================== */
    /* 1. constants                                                          */
    /* ==================================================================== */

    /** Bumped on every client change: the only reliable way to tell which
     *  bundle the page is running (the module is loaded once per page load). */
    var CLIENT_BUILD = "v1.3.0"

    var API_BASE = "/api/pdf-workbench"

    /** Every endpoint — exact paths, ids ride as query parameters (CONTRACT §2). */
    var ENDPOINTS = {
      catalog: API_BASE + "/catalog",
      info: API_BASE + "/info",
      jobs: API_BASE + "/jobs",
      job: function (jobId) {
        return API_BASE + "/job?id=" + encodeURIComponent(String(jobId || ""))
      },
      cancel: function (jobId) {
        return API_BASE + "/cancel?id=" + encodeURIComponent(String(jobId || ""))
      },
      file: function (jobId, fileId, inline) {
        return (
          API_BASE +
          "/file?job=" +
          encodeURIComponent(String(jobId || "")) +
          "&file=" +
          encodeURIComponent(String(fileId || "")) +
          (inline ? "&inline=1" : "")
        )
      },
      preview: function (jobId, fileId, page, width) {
        return (
          API_BASE +
          "/preview?job=" +
          encodeURIComponent(String(jobId || "")) +
          "&file=" +
          encodeURIComponent(String(fileId || "")) +
          "&page=" +
          encodeURIComponent(String(page || 1)) +
          "&w=" +
          encodeURIComponent(String(width || 900))
        )
      },
      pages: function (jobId, fileId) {
        return (
          API_BASE +
          "/pages?job=" +
          encodeURIComponent(String(jobId || "")) +
          "&file=" +
          encodeURIComponent(String(fileId || ""))
        )
      },
    }

    /** Product limits (CONTRACT §3.3 / catalog LIMITS); the server value wins. */
    var FALLBACK_LIMITS = {
      maxFileBytes: 100 * 1024 * 1024,
      maxBatchFiles: 20,
      maxBatchBytes: 300 * 1024 * 1024,
      retentionMs: 24 * 60 * 60 * 1000,
    }

    var POLL_BASE_MS = 400
    var POLL_FACTOR = 1.4
    var POLL_MAX_MS = 1500
    var PREVIEW_WIDTH = 900
    var PREVIEW_MAX_HEIGHT = 520

    var TERMINAL_STATUS = { done: true, failed: true, cancelled: true }
    var IMAGE_KINDS = { image: true, png: true, jpg: true, jpeg: true, webp: true, gif: true, bmp: true, tif: true, tiff: true }
    var TEXT_KINDS = { text: true, txt: true, md: true, json: true, csv: true, html: true, log: true }
    var KIND_BADGE = { pdf: "PDF", zip: "ZIP", image: "IMG", png: "PNG", jpg: "JPG", text: "TXT", txt: "TXT", md: "MD", json: "JSON", docx: "DOCX", xlsx: "XLSX", pptx: "PPTX" }
    var FORMAT_LABEL = {
      pdf: "PDF",
      doc: "Word",
      docx: "Word",
      xls: "Excel",
      xlsx: "Excel",
      ppt: "PPT",
      pptx: "PPT",
      png: "PNG",
      jpg: "JPG",
      jpeg: "JPG",
      webp: "WEBP",
      bmp: "BMP",
      tif: "TIFF",
      tiff: "TIFF",
      txt: "TXT",
      md: "MD",
      json: "JSON",
    }
    var GROUP_ICON = { convert: "refresh", edit: "layers", extract: "search", ai: "sparkles" }
    var EMPTY_OBJECT = {}
    var EMPTY_ARRAY = []

    var fileSeq = 0

    /* ==================================================================== */
    /* 2. copy (zh / en — every visible string lives here)                   */
    /* ==================================================================== */

    var COPY = {
      zh: {
        "app.title": "PDF 全能工具台",
        "app.short": "PDF 工具台",

        "nav.home": "首页",
        "nav.backHome": "返回首页",
        "nav.search": "搜索",
        "nav.searchPlaceholder": "搜索功能，例如「压缩」「OCR」「翻译」",
        "nav.noResults": "没有匹配的功能",
        "nav.collapse": "收起左栏",
        "nav.expand": "展开左栏",
        "nav.rightCollapse": "收起结果栏",
        "nav.rightExpand": "展开结果栏",
        "nav.groupOps": "{n} 项",
        "nav.browse": "全部功能",

        "home.title": "选择一个工具开始",
        "home.desc": "全部处理都在本机完成；上传文件与产物 24 小时后自动清除。",
        "home.resultCount": "匹配到 {n} 项功能",
        "home.emptyTitle": "没有找到匹配的功能",
        "home.emptyDesc": "换个关键词试试，或从左侧分组浏览全部功能。",

        "common.retry": "重试",
        "common.close": "关闭",
        "common.remove": "移除",
        "common.reset": "重置",
        "common.copy": "复制",
        "common.copied": "已复制",
        "common.copyFailed": "复制失败，请手动选择文本",
        "common.download": "下载",
        "common.downloadAll": "全部下载",
        "common.preview": "预览",
        "common.loading": "加载中…",
        "common.error": "出错",
        "common.none": "无",
        "common.pageOf": "第 {page} / {total} 页",
        "common.prevPage": "上一页",
        "common.nextPage": "下一页",
        "common.size": "大小",
        "common.type": "类型",
        "common.filesCount": "{n} 个文件",
        "common.selectedCount": "已添加 {n} 个",
        "common.totalSize": "合计 {size}",
        "common.empty": "暂无",
        "common.tryAgain": "重新加载",
        "common.dismiss": "忽略",
        "common.open": "打开",

        "upload.title": "上传文件",
        "upload.subtitle": "拖拽到下方区域，或点击选择文件",
        "upload.multi": "，支持多选",
        "upload.single": "，仅支持单个文件",
        "upload.dropTitle": "把文件拖到这里",
        "upload.dropTitleActive": "松开即可添加",
        "upload.choose": "选择文件",
        "upload.formats": "支持格式",
        "upload.maxFile": "单文件最大 100 MB",
        "upload.maxBatch": "最多 {n} 个文件",
        "upload.maxTotal": "合计上限 {size}",
        "upload.reorderHint": "拖动文件可调整处理顺序",
        "upload.moveUp": "上移",
        "upload.moveDown": "下移",
        "upload.emptyList": "还没有文件，先添加要处理的文件。",
        "upload.err.tooLarge": "以下文件超过单文件上限 {maxFile}：{names}",
        "upload.err.tooLargeHint": "请先压缩或拆分这些文件后重试。",
        "upload.err.tooMany": "一次最多处理 {maxFiles} 个文件，多出的：{names}",
        "upload.err.tooManyHint": "请分批提交。",
        "upload.err.tooManyBytes": "文件合计超过 {maxTotal}：{names}",
        "upload.err.tooManyBytesHint": "请减少文件数量或先压缩。",
        "upload.err.singleOnly": "该功能一次只处理 1 个文件，已保留第一个。",

        "params.title": "参数设置",
        "params.none": "该功能无需额外参数。",
        "params.reset": "恢复默认",
        "params.required": "必填",
        "params.range": "范围 {min} – {max}",
        "params.requiredMissing": "请填写「{label}」",
        "params.invalidNumberLabel": "「{label}」需要填写数字",
        "params.tooSmallLabel": "「{label}」不能小于 {min}",
        "params.tooLargeLabel": "「{label}」不能大于 {max}",
        "params.colorHex": "十六进制色值",

        "action.title": "开始处理",
        "action.start": "开始处理",
        "action.ask": "提问",
        "action.cancel": "取消任务",
        "action.reprocess": "重新处理",
        "action.busy": "正在处理中，请稍候…",
        "action.needFiles": "请先添加文件",
        "action.needFilesHint": "在「上传文件」区添加文件后再开始。",
        "action.needFilesOne": "请先添加 1 个文件",
        "action.needFilesOneHint": "该功能一次只处理一个文件。",
        "action.needQuestion": "请先输入你的问题",
        "action.needQuestionHint": "问题会随任务一起提交。",
        "action.invalidParams": "参数还不合法",
        "action.invalidParamsHint": "请按提示修正参数后重试。",
        "action.disabledReason": "无法开始：{reason}",
        "action.single": "单个文件",
        "action.batch": "批量处理",

        "progress.title": "处理进度",
        "progress.uploading": "正在上传…",
        "progress.queued": "排队中…",
        "progress.processing": "处理中…",
        "progress.done": "已完成",
        "progress.failed": "处理失败",
        "progress.cancelled": "已取消",
        "progress.stage": "阶段：{stage}",
        "progress.eta": "预计剩余 {time}",
        "progress.elapsed": "已用 {time}",
        "progress.percent": "{n}%",

        "error.title": "出错了",
        "error.hintRetry": "稍后重试；若持续失败请查看插件日志。",
        "error.hintCancelled": "任务已取消，可以重新提交。",
        "error.jobFailed": "处理失败",
        "error.badResponse": "服务返回了无法识别的数据",
        "error.network": "网络请求失败",
        "error.http": "接口返回错误状态",
        "error.clipboard": "无法访问剪贴板",
        "error.unknown": "未知错误",

        "result.title": "结果预览",
        "result.empty": "还没有结果",
        "result.emptyHint": "完成一次处理后会在这里出现预览与下载。",
        "result.running": "正在生成结果…",
        "result.outputs": "产物",
        "result.noPreview": "该格式不支持在线预览，请下载后查看。",
        "result.previewLoading": "预览加载中…",
        "result.previewFailed": "预览加载失败",
        "result.batchTitle": "批量任务",
        "result.batchProgress": "总进度 {n}%",
        "result.batchSummary": "成功 {ok} · 失败 {failed} · 处理中 {pending}",
        "result.batchRetry": "重试该文件",
        "result.stateSuccess": "成功",
        "result.stateFailed": "失败",
        "result.statePending": "处理中",
        "result.stateUnknown": "未知",
        "result.textTitle": "文本结果",
        "result.downloadAllHint": "批量任务优先下载打包 zip",
        "result.reprocessHint": "用相同参数重新处理当前文件",
        "result.fileGone": "原始文件已不在列表中",
        "result.fileGoneHint": "请重新添加该文件后再重试。",
        "result.chatTitle": "对话问答",
        "result.chatEmpty": "上传文档并提问后，可以在这里连续追问。",
        "result.chatPlaceholder": "继续追问；Enter 发送，Shift+Enter 换行",
        "result.chatLabel": "追问内容",
        "result.warningsTitle": "以下项目需要注意（结果仍然生成）",
        "result.compressed": "已压缩 {from} → {to}",
        "result.capMissed": "未达到目标体积",
        "result.capBadge": "已压缩",
        "result.chatSend": "发送",
        "result.chatThinking": "正在思考…",
        "result.chatYou": "你",
        "result.chatAI": "AI",
        "result.pages": "{n} 页",
        "result.copyText": "复制正文",
        "result.askFirst": "先在③输入你的问题并提交。",

        "notes.title": "说明与限制",
        "notes.limitsTitle": "全局限制",
        "notes.maxFile": "单文件 ≤ {size}",
        "notes.maxBatch": "单次 ≤ {n} 个文件",
        "notes.maxTotal": "合计 ≤ {size}",
        "notes.retention": "产物与上传文件保留 {hours} 小时后自动删除",
        "notes.opTitle": "「{title}」说明",
        "notes.formats": "可上传：{formats}",
        "notes.mode": "处理方式：{mode}",
        "notes.preview": "结果支持在线预览",
        "notes.ai": "该功能由已配置的大模型完成，结果仅供参考。",
        "notes.ocr": "扫描件 OCR 依赖本机 OCR 组件，未安装时会明确报错。",
        "notes.translateBudget": "单次翻译最多 {n} 页，超出请分段处理",
        "notes.office": "Office 转换依赖 LibreOffice。",
        "notes.tip": "处理时间取决于页数与文件体积。",
        "notes.shortcuts": "键盘：Tab 移动焦点，Enter 触发按钮，空格切换开关。",
        "notes.retentionUnknown": "处理完成后请尽快下载产物。",

        "cap.aiUnavailable": "未配置 AI 模型，暂时无法使用该功能",
        "cap.aiUnavailableHint": "请先在设置中配置模型，再重试。",
        "cap.ocrUnavailable": "本机未安装 OCR 组件",
        "cap.ocrUnavailableHint": "安装 OCR 组件后再试，其他功能不受影响。",
        "cap.libreofficeUnavailable": "未检测到 LibreOffice，Office 转换可能失败",
        "cap.libreofficeUnavailableHint": "安装 LibreOffice 后可稳定转换 Office 文件。",

        "status.queued": "排队中",
        "status.running": "处理中",
        "status.done": "已完成",
        "status.failed": "失败",
        "status.cancelled": "已取消",

        "badge.batch": "批量",
        "badge.ai": "AI",
        "unit.eta": "约 {time}",
      },
      en: {
        "app.title": "PDF Workbench",
        "app.short": "PDF Tools",

        "nav.home": "Home",
        "nav.backHome": "Back to home",
        "nav.search": "Search",
        "nav.searchPlaceholder": "Search tools, e.g. compress, OCR, translate",
        "nav.noResults": "No matching tool",
        "nav.collapse": "Collapse left panel",
        "nav.expand": "Expand left panel",
        "nav.rightCollapse": "Collapse results panel",
        "nav.rightExpand": "Expand results panel",
        "nav.groupOps": "{n}",
        "nav.browse": "All tools",

        "home.title": "Pick a tool to start",
        "home.desc": "Everything runs locally; uploads and outputs are deleted after 24 hours.",
        "home.resultCount": "{n} matching tools",
        "home.emptyTitle": "Nothing matched",
        "home.emptyDesc": "Try another keyword, or browse the groups on the left.",

        "common.retry": "Retry",
        "common.close": "Close",
        "common.remove": "Remove",
        "common.reset": "Reset",
        "common.copy": "Copy",
        "common.copied": "Copied",
        "common.copyFailed": "Copy failed — select the text manually",
        "common.download": "Download",
        "common.downloadAll": "Download all",
        "common.preview": "Preview",
        "common.loading": "Loading…",
        "common.error": "Error",
        "common.none": "None",
        "common.pageOf": "Page {page} of {total}",
        "common.prevPage": "Previous page",
        "common.nextPage": "Next page",
        "common.size": "Size",
        "common.type": "Type",
        "common.filesCount": "{n} files",
        "common.selectedCount": "{n} added",
        "common.totalSize": "Total {size}",
        "common.empty": "Nothing yet",
        "common.tryAgain": "Reload",
        "common.dismiss": "Dismiss",
        "common.open": "Open",

        "upload.title": "Upload files",
        "upload.subtitle": "Drag files below or click to choose",
        "upload.multi": "; multiple files supported",
        "upload.single": "; one file only",
        "upload.dropTitle": "Drop files here",
        "upload.dropTitleActive": "Release to add",
        "upload.choose": "Choose files",
        "upload.formats": "Formats",
        "upload.maxFile": "Max 100 MB per file",
        "upload.maxBatch": "Up to {n} files",
        "upload.maxTotal": "Total limit {size}",
        "upload.reorderHint": "Drag files to reorder processing",
        "upload.moveUp": "Move up",
        "upload.moveDown": "Move down",
        "upload.emptyList": "No files yet — add the files to process.",
        "upload.err.tooLarge": "These files exceed the {maxFile} per-file limit: {names}",
        "upload.err.tooLargeHint": "Compress or split them first, then retry.",
        "upload.err.tooMany": "At most {maxFiles} files per job; extra: {names}",
        "upload.err.tooManyHint": "Split the batch into several jobs.",
        "upload.err.tooManyBytes": "Total size exceeds {maxTotal}: {names}",
        "upload.err.tooManyBytesHint": "Remove some files or compress them first.",
        "upload.err.singleOnly": "This tool handles one file at a time; only the first was kept.",

        "params.title": "Parameters",
        "params.none": "This tool needs no extra parameters.",
        "params.reset": "Reset to defaults",
        "params.required": "Required",
        "params.range": "Range {min} – {max}",
        "params.requiredMissing": "“{label}” is required",
        "params.invalidNumberLabel": "“{label}” must be a number",
        "params.tooSmallLabel": "“{label}” must be at least {min}",
        "params.tooLargeLabel": "“{label}” must be at most {max}",
        "params.colorHex": "Hex value",

        "action.title": "Run",
        "action.start": "Start processing",
        "action.ask": "Ask",
        "action.cancel": "Cancel job",
        "action.reprocess": "Run again",
        "action.busy": "A job is running, please wait…",
        "action.needFiles": "Add a file first",
        "action.needFilesHint": "Add files in step 1, then start.",
        "action.needFilesOne": "Add one file first",
        "action.needFilesOneHint": "This tool processes a single file at a time.",
        "action.needQuestion": "Type your question first",
        "action.needQuestionHint": "The question is sent with the job.",
        "action.invalidParams": "Parameters are not valid yet",
        "action.invalidParamsHint": "Fix the highlighted parameters and retry.",
        "action.disabledReason": "Cannot start: {reason}",
        "action.single": "Single file",
        "action.batch": "Batch",

        "progress.title": "Progress",
        "progress.uploading": "Uploading…",
        "progress.queued": "Queued…",
        "progress.processing": "Processing…",
        "progress.done": "Finished",
        "progress.failed": "Failed",
        "progress.cancelled": "Cancelled",
        "progress.stage": "Stage: {stage}",
        "progress.eta": "About {time} remaining",
        "progress.elapsed": "{time} elapsed",
        "progress.percent": "{n}%",

        "error.title": "Something went wrong",
        "error.hintRetry": "Retry in a moment; check the plugin log if it keeps failing.",
        "error.hintCancelled": "The job was cancelled; you can run it again.",
        "error.jobFailed": "Processing failed",
        "error.badResponse": "The service returned an unexpected response",
        "error.network": "Network request failed",
        "error.http": "Request failed with status",
        "error.clipboard": "Clipboard unavailable",
        "error.unknown": "Unknown error",

        "result.title": "Results",
        "result.empty": "No results yet",
        "result.emptyHint": "Previews and downloads appear here after a job.",
        "result.running": "Building results…",
        "result.outputs": "Outputs",
        "result.noPreview": "This format cannot be previewed inline; download it instead.",
        "result.previewLoading": "Loading preview…",
        "result.previewFailed": "Preview failed",
        "result.batchTitle": "Batch job",
        "result.batchProgress": "Overall {n}%",
        "result.batchSummary": "{ok} done · {failed} failed · {pending} in progress",
        "result.batchRetry": "Retry this file",
        "result.stateSuccess": "Done",
        "result.stateFailed": "Failed",
        "result.statePending": "Pending",
        "result.stateUnknown": "Unknown",
        "result.textTitle": "Text result",
        "result.downloadAllHint": "Batch jobs download the zip bundle first",
        "result.reprocessHint": "Run the same settings again",
        "result.fileGone": "The original file is no longer listed",
        "result.fileGoneHint": "Add the file again, then retry.",
        "result.chatTitle": "Conversation",
        "result.chatEmpty": "Upload a document and ask something; follow-ups stay in context.",
        "result.chatPlaceholder": "Ask a follow-up; Enter sends, Shift+Enter adds a line",
        "result.chatLabel": "Follow-up question",
        "result.warningsTitle": "Completed with notes",
        "result.compressed": "Compressed {from} → {to}",
        "result.capMissed": "Target not reached",
        "result.capBadge": "Compressed",
        "result.chatSend": "Send",
        "result.chatThinking": "Thinking…",
        "result.chatYou": "You",
        "result.chatAI": "AI",
        "result.pages": "{n} pages",
        "result.copyText": "Copy text",
        "result.askFirst": "Type your question in step 3 and submit first.",

        "notes.title": "Notes & limits",
        "notes.limitsTitle": "Global limits",
        "notes.maxFile": "Per file ≤ {size}",
        "notes.maxBatch": "≤ {n} files per job",
        "notes.maxTotal": "Total ≤ {size}",
        "notes.retention": "Outputs and uploads are deleted after {hours} hours",
        "notes.opTitle": "About “{title}”",
        "notes.formats": "Accepts: {formats}",
        "notes.mode": "Mode: {mode}",
        "notes.preview": "Results can be previewed inline",
        "notes.ai": "Powered by the configured model; review the output before use.",
        "notes.ocr": "Scanned documents need the local OCR component, which reports an error when missing.",
        "notes.translateBudget": "One run translates up to {n} pages; split longer documents",
        "notes.office": "Office conversion relies on LibreOffice.",
        "notes.tip": "Processing time depends on page count and file size.",
        "notes.shortcuts": "Keyboard: Tab moves focus, Enter activates, Space toggles switches.",
        "notes.retentionUnknown": "Download outputs before the retention window ends.",

        "cap.aiUnavailable": "No AI model configured for this feature",
        "cap.aiUnavailableHint": "Configure a model in settings, then retry.",
        "cap.ocrUnavailable": "The local OCR component is missing",
        "cap.ocrUnavailableHint": "Install the OCR component; other tools still work.",
        "cap.libreofficeUnavailable": "LibreOffice not detected; Office conversion may fail",
        "cap.libreofficeUnavailableHint": "Install LibreOffice for reliable Office conversion.",

        "status.queued": "Queued",
        "status.running": "Running",
        "status.done": "Done",
        "status.failed": "Failed",
        "status.cancelled": "Cancelled",

        "badge.batch": "Batch",
        "badge.ai": "AI",
        "unit.eta": "~{time}",
      },
    }

    /* ==================================================================== */
    /* 3. locale                                                             */
    /* ==================================================================== */

    /** `ctx.locale` handed over by `apply`; `null` until then (and in tests). */
    var localeService = null

    function attachLocale(service) {
      localeService = service && typeof service === "object" ? service : null
    }

    /** Active locale id from the host locale service, else the browser, else zh. */
    function activeLocaleId() {
      var service = localeService
      if (service) {
        try {
          if (typeof service.getSnapshot === "function") {
            var snapshot = service.getSnapshot()
            if (snapshot && typeof snapshot.active === "string" && snapshot.active) return snapshot.active
            if (snapshot && typeof snapshot.language === "string" && snapshot.language) return snapshot.language
          }
          if (typeof service.active === "string" && service.active) return service.active
          if (typeof service.language === "string" && service.language) return service.language
        } catch (error) {
          /* fall through to navigator */
        }
      }
      try {
        if (typeof navigator !== "undefined" && navigator && typeof navigator.language === "string") return navigator.language
      } catch (error) {
        /* ignore */
      }
      return "zh"
    }

    /** Two locales only: English when the host says so, Chinese otherwise. */
    function currentLang() {
      return /^en\b/i.test(activeLocaleId()) ? "en" : "zh"
    }

    function interpolate(text, vars) {
      if (vars == null || text == null) return text == null ? "" : String(text)
      return String(text).replace(/\{(\w+)\}/g, function (match, key) {
        return vars[key] == null ? match : String(vars[key])
      })
    }

    /** `t('result.title')` — localized copy, Chinese fallback, key as last resort. */
    function t(key, vars) {
      var lang = currentLang()
      var table = COPY[lang] || COPY.zh
      var text = table[key]
      if (text == null) text = COPY.zh[key]
      if (text == null) text = key
      return interpolate(text, vars)
    }

    /** Resolve a catalog string that may be plain or `{ zh, en }`. */
    function pick(value) {
      if (value == null) return ""
      if (typeof value === "string") return value
      if (typeof value === "number" || typeof value === "boolean") return String(value)
      if (typeof value === "object") {
        var lang = currentLang()
        if (typeof value[lang] === "string" && value[lang]) return value[lang]
        if (typeof value.zh === "string" && value.zh) return value.zh
        if (typeof value.en === "string" && value.en) return value.en
        for (var key in value) {
          if (typeof value[key] === "string" && value[key]) return value[key]
        }
      }
      return String(value)
    }

    /* ==================================================================== */
    /* 4. pure helpers (unit-tested by client.selftest.mjs)                  */
    /* ==================================================================== */

    function clampNumber(value, min, max) {
      var n = Number(value)
      if (!isFinite(n)) n = 0
      if (n < min) n = min
      if (n > max) n = max
      return n
    }

    function formatBytes(bytes) {
      var n = Number(bytes)
      if (!isFinite(n) || n < 0) return "—"
      if (n < 1024) return Math.round(n) + " B"
      var units = ["B", "KB", "MB", "GB", "TB"]
      var index = 0
      while (n >= 1024 && index < units.length - 1) {
        n = n / 1024
        index += 1
      }
      var digits = index >= 3 ? 2 : 1
      var scale = Math.pow(10, digits)
      return (Math.round(n * scale) / scale).toFixed(digits) + " " + units[index]
    }

    /** Language-neutral duration: "8s" / "1m 20s" / "1h 05m". */
    function formatDuration(ms) {
      var total = Number(ms)
      if (!isFinite(total) || total < 0) return "—"
      var seconds = Math.round(total / 1000)
      if (seconds < 60) return seconds + "s"
      var minutes = Math.floor(seconds / 60)
      var rest = seconds % 60
      if (minutes < 60) return minutes + "m " + (rest < 10 ? "0" : "") + rest + "s"
      var hours = Math.floor(minutes / 60)
      var mins = minutes % 60
      return hours + "h " + (mins < 10 ? "0" : "") + mins + "m"
    }

    function progressPercent(value) {
      return Math.round(clampNumber(value, 0, 1) * 100)
    }

    /** Polling backoff: 400 → ×1.4 → capped at 1500 ms. */
    function nextDelay(previous) {
      var current = Number(previous)
      if (!isFinite(current) || current <= 0) return POLL_BASE_MS
      var next = Math.round(current * POLL_FACTOR)
      return next > POLL_MAX_MS ? POLL_MAX_MS : next
    }

    function isTerminalStatus(status) {
      return TERMINAL_STATUS[String(status || "")] === true
    }

    function normalizeLimits(limits) {
      var source = limits && typeof limits === "object" ? limits : EMPTY_OBJECT
      var out = {
        maxFileBytes: Number(source.maxFileBytes),
        maxBatchFiles: Number(source.maxBatchFiles),
        maxBatchBytes: Number(source.maxBatchBytes),
        retentionMs: Number(source.retentionMs),
      }
      if (!isFinite(out.maxFileBytes) || out.maxFileBytes <= 0) out.maxFileBytes = FALLBACK_LIMITS.maxFileBytes
      if (!isFinite(out.maxBatchFiles) || out.maxBatchFiles <= 0) out.maxBatchFiles = FALLBACK_LIMITS.maxBatchFiles
      if (!isFinite(out.maxBatchBytes) || out.maxBatchBytes <= 0) out.maxBatchBytes = FALLBACK_LIMITS.maxBatchBytes
      if (!isFinite(out.retentionMs) || out.retentionMs <= 0) out.retentionMs = FALLBACK_LIMITS.retentionMs
      return out
    }

    function isFieldVisible(field, values) {
      if (!field) return false
      var rule = field.visibleWhen
      if (!rule || !rule.key) return true
      var actual = values ? values[rule.key] : undefined
      if (Array.isArray(rule.equals)) {
        for (var i = 0; i < rule.equals.length; i += 1) {
          if (String(actual) === String(rule.equals[i])) return true
        }
        return false
      }
      if (rule.equals === undefined) return Boolean(actual)
      return String(actual) === String(rule.equals)
    }

    function visibleFields(fields, values) {
      var list = Array.isArray(fields) ? fields : EMPTY_ARRAY
      var out = []
      for (var i = 0; i < list.length; i += 1) {
        if (isFieldVisible(list[i], values)) out.push(list[i])
      }
      return out
    }

    /** Fields a tool actually shows: hidden ones dropped, chat question moved to the composer. */
    function formFields(op, values) {
      var list = op && Array.isArray(op.fields) ? op.fields : EMPTY_ARRAY
      var visible = visibleFields(list, values)
      if (!op || op.chat !== true) return visible
      var out = []
      for (var i = 0; i < visible.length; i += 1) {
        if (visible[i].key !== "question") out.push(visible[i])
      }
      return out
    }

    function fieldDefault(field) {
      if (!field) return ""
      var value = field.default
      if (field.type === "switch") return value === true
      if (value === undefined || value === null) return field.type === "number" ? "" : ""
      if (typeof value === "object") return pick(value)
      if (typeof value === "number") return String(value)
      if (typeof value === "boolean") return value
      return String(value)
    }

    function defaultsFor(fields) {
      var list = Array.isArray(fields) ? fields : EMPTY_ARRAY
      var out = {}
      for (var i = 0; i < list.length; i += 1) out[list[i].key] = fieldDefault(list[i])
      return out
    }

    function isEmptyValue(value) {
      return value === undefined || value === null || (typeof value === "string" && value.trim() === "")
    }

    /**
     * Validate the visible parameters. Returns `[{ key, code, label?, min?, max? }]`
     * where code ∈ REQUIRED | NOT_NUMBER | TOO_SMALL | TOO_LARGE.
     */
    function validateValues(fields, values, options) {
      var list = Array.isArray(fields) ? fields : EMPTY_ARRAY
      var skipKeys = (options && options.skipKeys) || EMPTY_ARRAY
      var issues = []
      for (var i = 0; i < list.length; i += 1) {
        var field = list[i]
        if (!isFieldVisible(field, values)) continue
        if (skipKeys.indexOf(field.key) !== -1) continue
        var raw = values ? values[field.key] : undefined
        var empty = isEmptyValue(raw)
        if (field.required === true && empty) {
          issues.push({ key: field.key, code: "REQUIRED", label: field.label })
          continue
        }
        if (field.type === "number" && !empty) {
          var n = Number(raw)
          if (!isFinite(n)) {
            issues.push({ key: field.key, code: "NOT_NUMBER", label: field.label })
            continue
          }
          if (field.min !== undefined && field.min !== null && n < Number(field.min)) {
            issues.push({ key: field.key, code: "TOO_SMALL", label: field.label, min: field.min, max: field.max })
            continue
          }
          if (field.max !== undefined && field.max !== null && n > Number(field.max)) {
            issues.push({ key: field.key, code: "TOO_LARGE", label: field.label, min: field.min, max: field.max })
            continue
          }
        }
      }
      return issues
    }

    /** Catalog values → engine params: numbers as numbers, switches as booleans. */
    function buildParams(fields, values) {
      var list = Array.isArray(fields) ? fields : EMPTY_ARRAY
      var out = {}
      for (var i = 0; i < list.length; i += 1) {
        var field = list[i]
        if (!isFieldVisible(field, values)) continue
        var raw = values ? values[field.key] : undefined
        if (field.type === "switch") {
          out[field.key] = raw === true
        } else if (field.type === "number") {
          if (isEmptyValue(raw)) continue
          var n = Number(raw)
          out[field.key] = isFinite(n) ? n : String(raw)
        } else {
          out[field.key] = raw == null ? "" : String(raw)
        }
      }
      return out
    }

    /**
     * Front-end limit pre-check. `existing` = files already added, `incoming` =
     * newly picked files; returns accepted + rejected entries so the caller can
     * show exactly which files were refused and why.
     */
    function validateFiles(limits, existing, incoming) {
      var lim = normalizeLimits(limits)
      var already = Array.isArray(existing) ? existing : EMPTY_ARRAY
      var list = Array.isArray(incoming) ? incoming : EMPTY_ARRAY
      var count = already.length
      var bytes = 0
      for (var i = 0; i < already.length; i += 1) bytes += Number(already[i].size) || 0
      var accepted = []
      var rejected = []
      for (var j = 0; j < list.length; j += 1) {
        var file = list[j]
        var size = Number(file && file.size) || 0
        var reason = null
        if (size > lim.maxFileBytes) reason = "tooLarge"
        else if (count + accepted.length + 1 > lim.maxBatchFiles) reason = "tooMany"
        else if (bytes + size > lim.maxBatchBytes) reason = "tooManyBytes"
        if (reason) {
          rejected.push({ name: file && file.name ? file.name : "file-" + (j + 1), size: size, reason: reason })
        } else {
          accepted.push(file)
          bytes += size
        }
      }
      return { accepted: accepted, rejected: rejected, limits: lim }
    }

    function previewKindFor(output) {
      if (!output) return "none"
      var kind = String(output.kind || "").toLowerCase()
      if (kind === "pdf") return "pdf"
      if (IMAGE_KINDS[kind]) return "image"
      if (TEXT_KINDS[kind]) return "text"
      return "none"
    }

    /**
     * True when a follow-up chat turn can reuse the Host-uploaded originals
     * instead of re-posting the files (`sourceIds` from `POST /jobs`).
     */
    function reuseSourceIds(op, sourceIds, forceUpload) {
      if (forceUpload === true) return false
      if (!op || op.chat !== true) return false
      return Array.isArray(sourceIds) && sourceIds.length > 0
    }

    /** Serialize source ids for the `sourceIds` multipart field. */
    function encodeSourceIds(sourceIds) {
      var list = Array.isArray(sourceIds) ? sourceIds : EMPTY_ARRAY
      var out = []
      for (var i = 0; i < list.length; i += 1) out.push(String(list[i]))
      return JSON.stringify(out)
    }

    function kindBadge(kind) {
      var key = String(kind || "").toLowerCase()
      return KIND_BADGE[key] || key.toUpperCase() || "FILE"
    }

    function acceptList(accept) {
      if (!accept) return []
      var parts = String(accept).split(",")
      var out = []
      for (var i = 0; i < parts.length; i += 1) {
        var token = parts[i].trim()
        if (token) out.push(token)
      }
      return out
    }

    /** `.pdf,.png` → ["PDF", "PNG"] (deduped, human readable). */
    function formatLabels(accept) {
      var tokens = acceptList(accept)
      var seen = {}
      var out = []
      for (var i = 0; i < tokens.length; i += 1) {
        var ext = tokens[i].replace(/^\./, "").toLowerCase()
        var label = FORMAT_LABEL[ext] || ext.toUpperCase()
        if (!seen[label]) {
          seen[label] = true
          out.push(label)
        }
      }
      return out
    }

    /** Split `text` into `{ text, hit }` pieces around `query` (for <mark>). */
    function highlightParts(text, query) {
      var source = text == null ? "" : String(text)
      var needle = query == null ? "" : String(query).trim()
      if (!needle || !source) return [{ text: source, hit: false }]
      var lower = source.toLowerCase()
      var target = needle.toLowerCase()
      var parts = []
      var from = 0
      var index = lower.indexOf(target)
      while (index !== -1) {
        if (index > from) parts.push({ text: source.slice(from, index), hit: false })
        parts.push({ text: source.slice(index, index + target.length), hit: true })
        from = index + target.length
        index = lower.indexOf(target, from)
      }
      if (from < source.length) parts.push({ text: source.slice(from), hit: false })
      return parts.length ? parts : [{ text: source, hit: false }]
    }

    var GROUP_ICON_BY_ID = GROUP_ICON

    function groupIconForOp(op) {
      if (!op) return "file"
      return GROUP_ICON_BY_ID[op.group] || "file"
    }

    function operationMatches(op, query) {
      if (!op) return false
      var needle = String(query || "").trim().toLowerCase()
      if (!needle) return true
      var haystack = [
        String(op.id || ""),
        String(op.engine || ""),
        pick(op.title),
        pick(op.description),
        pick(op.section),
      ]
        .join("\n")
        .toLowerCase()
      return haystack.indexOf(needle) !== -1
    }

    /** Catalog → navigation entries: `[{ group, sections:[{ key, title, ops }] }]`. */
    function buildNavigation(catalog) {
      if (!catalog || !Array.isArray(catalog.groups) || !Array.isArray(catalog.operations)) return []
      var byId = {}
      for (var i = 0; i < catalog.operations.length; i += 1) {
        var operation = catalog.operations[i]
        if (operation && operation.id) byId[operation.id] = operation
      }
      var entries = []
      for (var g = 0; g < catalog.groups.length; g += 1) {
        var group = catalog.groups[g]
        if (!group || !group.id) continue
        var ids = Array.isArray(group.operations) ? group.operations : []
        if (!ids.length) {
          ids = []
          for (var k = 0; k < catalog.operations.length; k += 1) {
            if (catalog.operations[k] && catalog.operations[k].group === group.id) ids.push(catalog.operations[k].id)
          }
        }
        var buckets = []
        var indexByKey = {}
        for (var j = 0; j < ids.length; j += 1) {
          var op = byId[ids[j]]
          if (!op) continue
          var sectionTitle = op.section ? pick(op.section) : ""
          var bucketKey = sectionTitle || ""
          if (indexByKey[bucketKey] === undefined) {
            indexByKey[bucketKey] = buckets.length
            buckets.push({ key: bucketKey, title: sectionTitle, ops: [] })
          }
          buckets[indexByKey[bucketKey]].ops.push(op)
        }
        if (!buckets.length) continue
        entries.push({ group: group, sections: buckets })
      }
      return entries
    }

    function filterNavigation(navigation, query) {
      var entries = Array.isArray(navigation) ? navigation : EMPTY_ARRAY
      var needle = String(query || "").trim()
      if (!needle) return entries
      var out = []
      for (var i = 0; i < entries.length; i += 1) {
        var entry = entries[i]
        var groupHit = operationMatches({ id: entry.group.id, title: entry.group.title, description: entry.group.description }, needle)
        var sections = []
        for (var s = 0; s < entry.sections.length; s += 1) {
          var section = entry.sections[s]
          var ops = groupHit ? section.ops.slice() : []
          if (!groupHit) {
            for (var o = 0; o < section.ops.length; o += 1) {
              if (operationMatches(section.ops[o], needle)) ops.push(section.ops[o])
            }
          }
          if (ops.length) sections.push({ key: section.key, title: section.title, ops: ops })
        }
        if (sections.length) out.push({ group: entry.group, sections: sections })
      }
      return out
    }

    function navigationOps(entry) {
      var out = []
      if (!entry || !Array.isArray(entry.sections)) return out
      for (var i = 0; i < entry.sections.length; i += 1) {
        for (var j = 0; j < entry.sections[i].ops.length; j += 1) out.push(entry.sections[i].ops[j])
      }
      return out
    }

    function countNavigationOps(navigation) {
      var total = 0
      var entries = Array.isArray(navigation) ? navigation : EMPTY_ARRAY
      for (var i = 0; i < entries.length; i += 1) total += navigationOps(entries[i]).length
      return total
    }

    /** Which capability a tool needs and lacks right now (`ai` | `ocr` | null). */
    function capabilityGap(op, info) {
      if (!op || !info || !info.capabilities) return null
      var caps = info.capabilities
      if (op.ai === true && caps.ai && caps.ai.available === false) return "ai"
      if (op.engine === "ocr" && caps.ocr === false) return "ocr"
      return null
    }

    function capabilityWarning(op, info) {
      if (!op || !info || !info.capabilities) return null
      var caps = info.capabilities
      if (op.engine === "toPDF" && caps.libreoffice === false) return "libreoffice"
      return null
    }

    /** "about 12s remaining" from progress + start time; `null` when unknown. */
    function estimateRemainingMs(job, now) {
      if (!job) return null
      var progress = Number(job.progress)
      var startedAt = Number(job.startedAt) || Number(job.createdAt) || 0
      if (!isFinite(progress) || progress <= 0.02 || progress >= 1) return null
      if (!startedAt) return null
      var stamp = Number(now) > 0 ? Number(now) : Date.now()
      var elapsed = stamp - startedAt
      if (elapsed <= 0) return null
      var remaining = (elapsed / progress) * (1 - progress)
      return remaining > 0 ? remaining : null
    }

    function statusCopy(status) {
      var key = "status." + String(status || "")
      var text = t(key)
      return text === key ? String(status || "") : text
    }

    function fileExtension(name) {
      var text = String(name || "")
      var dot = text.lastIndexOf(".")
      return dot >= 0 ? text.slice(dot + 1).toLowerCase() : ""
    }

    /* ==================================================================== */
    /* 5. transport                                                          */
    /* ==================================================================== */

    function makeError(code, message, hint) {
      var error = new Error(message || t("error.unknown"))
      error.code = code || "ERROR"
      error.hint = hint || t("error.hintRetry")
      return error
    }

    function isAbortError(error) {
      return Boolean(error) && (error.name === "AbortError" || error.code === "ABORT_ERR" || error.code === "ABORTED")
    }

    function errorFromPayload(payload) {
      var detail = payload && payload.error ? payload.error : EMPTY_OBJECT
      var error = makeError(detail.code || "UNKNOWN", detail.message || t("error.unknown"), detail.hint || t("error.hintRetry"))
      return error
    }

    function readEnvelope(response, raw) {
      var payload = null
      if (raw) {
        try {
          payload = JSON.parse(raw)
        } catch (error) {
          payload = null
        }
      }
      if (payload && payload.ok === true) return payload.value
      if (payload && payload.ok === false) throw errorFromPayload(payload)
      if (!response || response.ok !== true) {
        var status = response && response.status ? response.status : 0
        throw makeError("HTTP_" + status, t("error.http") + " " + status, t("error.hintRetry"))
      }
      if (payload && typeof payload === "object") return payload
      throw makeError("BAD_RESPONSE", t("error.badResponse"), t("error.hintRetry"))
    }

    function transportError(error) {
      if (!error) return makeError("UNKNOWN", t("error.unknown"), t("error.hintRetry"))
      if (typeof error === "object" && error.message) return error
      return makeError("UNKNOWN", String(error), t("error.hintRetry"))
    }

    function apiGet(path, signal) {
      var init = { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } }
      if (signal) init.signal = signal
      return fetch(path, init).then(function (response) {
        return response.text().then(function (raw) {
          return readEnvelope(response, raw)
        })
      })
    }

    function apiSend(path, init, signal) {
      var options = init || {}
      options.credentials = "same-origin"
      options.headers = { accept: "application/json" }
      if (signal) options.signal = signal
      return fetch(path, options).then(function (response) {
        return response.text().then(function (raw) {
          return readEnvelope(response, raw)
        })
      })
    }

    function apiPostForm(path, form, signal) {
      return apiSend(path, { method: "POST", body: form }, signal)
    }

    function apiDelete(path, signal) {
      return apiSend(path, { method: "DELETE" }, signal)
    }

    /** Raw text of an output (inline preview / copy). */
    function apiGetText(path, signal) {
      var init = { method: "GET", credentials: "same-origin" }
      if (signal) init.signal = signal
      return fetch(path, init).then(function (response) {
        return response.text().then(function (raw) {
          if (!response.ok) {
            var payload = null
            try {
              payload = raw ? JSON.parse(raw) : null
            } catch (error) {
              payload = null
            }
            if (payload && payload.ok === false) throw errorFromPayload(payload)
            throw makeError("HTTP_" + response.status, t("error.http") + " " + response.status, t("error.hintRetry"))
          }
          var maybeError = null
          try {
            maybeError = raw ? JSON.parse(raw) : null
          } catch (error) {
            maybeError = null
          }
          if (maybeError && maybeError.ok === false) throw errorFromPayload(maybeError)
          return raw
        })
      })
    }

    function copyToClipboard(text) {
      var value = text == null ? "" : String(text)
      if (!value) return Promise.reject(makeError("EMPTY", t("error.clipboard"), t("common.copyFailed")))
      try {
        if (typeof navigator !== "undefined" && navigator && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          return navigator.clipboard.writeText(value)
        }
      } catch (error) {
        /* fall through */
      }
      return Promise.reject(makeError("CLIPBOARD", t("error.clipboard"), t("common.copyFailed")))
    }

    /** Detached anchor click — never touches the host DOM tree. */
    function triggerDownload(jobId, output) {
      if (!jobId || !output || !output.id) return
      try {
        var anchor = document.createElement("a")
        anchor.href = ENDPOINTS.file(jobId, output.id, false)
        anchor.download = output.name || "download"
        anchor.rel = "noopener"
        anchor.click()
      } catch (error) {
        /* the per-output <a download> remains available */
      }
    }

    /* ==================================================================== */
    /* 6. hooks                                                              */
    /* ==================================================================== */

    /** Re-render on host locale changes (zh ⇄ en) without owning the service. */
    function useLocaleTick() {
      var state = useState(0)
      var bump = state[1]
      useEffect(function () {
        var service = localeService
        if (!service || typeof service.subscribe !== "function") return undefined
        var dispose = null
        try {
          dispose = service.subscribe(function () {
            bump(function (n) {
              return n + 1
            })
          })
        } catch (error) {
          dispose = null
        }
        return function () {
          if (typeof dispose === "function") dispose()
        }
      }, [])
    }

    /** 500 ms heartbeat so progress / ETA stay live while a job runs. */
    function useTicker(active) {
      var state = useState(0)
      var bump = state[1]
      useEffect(
        function () {
          if (!active) return undefined
          var timer = setInterval(function () {
            bump(function (n) {
              return n + 1
            })
          }, 500)
          return function () {
            clearInterval(timer)
          }
        },
        [active]
      )
    }

    /** Transient copy feedback: `['copied' | 'failed' | null, copy(text)]`. */
    function useCopyFeedback() {
      var state = useState(null)
      var feedback = state[0]
      var setFeedback = state[1]
      var timerRef = useRef(null)
      useEffect(function () {
        return function () {
          if (timerRef.current) clearTimeout(timerRef.current)
        }
      }, [])
      function copy(text) {
        copyToClipboard(text)
          .then(function () {
            setFeedback("copied")
          })
          .catch(function () {
            setFeedback("failed")
          })
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(function () {
          setFeedback(null)
        }, 1800)
      }
      return [feedback, copy]
    }

    /** Fire-and-forget refetch of the page count for PDF outputs without `pages`. */
    function usePageCount(jobId, fileId, knownPages) {
      var state = useState(Number(knownPages) || 0)
      var setCount = state[1]
      var count = Number(knownPages) || state[0]
      useEffect(
        function () {
          if (Number(knownPages) > 0) {
            setCount(Number(knownPages))
            return undefined
          }
          if (!jobId || !fileId) return undefined
          var controller = null
          var cancelled = false
          try {
            controller = new AbortController()
          } catch (error) {
            controller = null
          }
          apiGet(ENDPOINTS.pages(jobId, fileId), controller ? controller.signal : undefined)
            .then(function (value) {
              if (cancelled) return
              var pages = value && typeof value.count === "number" ? value.count : 0
              if (pages > 0) setCount(pages)
            })
            .catch(function () {
              /* preview still renders page 1 */
            })
          return function () {
            cancelled = true
            if (controller) controller.abort()
          }
        },
        [jobId, fileId, knownPages]
      )
      return count
    }

    /* ==================================================================== */
    /* 7. UI atoms                                                           */
    /* ==================================================================== */

    function cx() {
      var out = []
      for (var i = 0; i < arguments.length; i += 1) {
        if (arguments[i]) out.push(arguments[i])
      }
      return out.join(" ")
    }

    var ICON_PATHS = {
      refresh: ["M20.5 12a8.5 8.5 0 1 1-2.5-6", "M20.5 3.5V9H15"],
      layers: ["M12 3 3 7.5 12 12l9-4.5L12 3Z", "m3 12 9 4.5L21 12", "m3 16.5 9 4.5 9-4.5"],
      search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z", "m16.2 16.2 4.3 4.3"],
      sparkles: ["M12 3.5 13.8 8.7 19 10.5l-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8L12 3.5Z", "M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2Z"],
      upload: ["M12 16.5V4", "m7.5 8.5 4.5-4.5 4.5 4.5", "M4.5 15.5v3A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-3"],
      file: ["M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5l-5-5Z", "M13.5 3.5v5h5"],
      close: ["m6 6 12 12", "m18 6-12 12"],
      chevronDown: ["m6.5 9.5 5.5 5.5 5.5-5.5"],
      chevronRight: ["m9.5 6.5 5.5 5.5-5.5 5.5"],
      arrowLeft: ["M20 12H4.5", "m10.5 6-6 6 6 6"],
      arrowRight: ["M4 12h15.5", "m13.5 6 6 6-6 6"],
      arrowUp: ["M12 19.5V5", "m6.5 10.5 5.5-5.5 5.5 5.5"],
      arrowDown: ["M12 4.5V19", "m6.5 13 5.5 5.5 5.5-5.5"],
      download: ["M12 4v11", "m7.5 10.5 4.5 4.5 4.5-4.5", "M4.5 20h15"],
      retry: ["M20 12a8 8 0 1 1-2.3-5.6", "M20 4.5V10h-5.5"],
      check: ["m5 13 4.5 4.5L19.5 7"],
      alert: ["M12 4.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z", "M12 8v5.5", "M12 16.3h.01"],
      copy: ["M9.5 9.5h9A1.5 1.5 0 0 1 20 11v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 8 20v-9a1.5 1.5 0 0 1 1.5-1.5Z", "M15.5 6.5V4.5A1.5 1.5 0 0 0 14 3H5A1.5 1.5 0 0 0 3.5 4.5V14A1.5 1.5 0 0 0 5 15.5h2"],
      home: ["M4 10.5 12 4l8 6.5", "M6 10v10h12V10"],
      panelLeft: ["M4.5 4.5h15A1.5 1.5 0 0 1 21 6v12a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18V6a1.5 1.5 0 0 1 1.5-1.5Z", "M9 4.5v15"],
      panelRight: ["M4.5 4.5h15A1.5 1.5 0 0 1 21 6v12a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18V6a1.5 1.5 0 0 1 1.5-1.5Z", "M15 4.5v15"],
      send: ["m4 12 16-7.5-6.5 16-2.5-6.5L4 12Z"],
      image: ["M4.5 4.5h15A1.5 1.5 0 0 1 21 6v12a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18V6a1.5 1.5 0 0 1 1.5-1.5Z", "m4 16 4.5-4.5 4 4 3-3 4.5 4.5", "M9 9.5h.01"],
      info: ["M12 4.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z", "M12 11v5.5", "M12 8.2h.01"],
      trash: ["M5 7h14", "M9.5 7V4.5h5V7", "M6.5 7l1 12.5h9l1-12.5", "M10.5 10.5v6", "M13.5 10.5v6"],
      spinner: ["M12 4.5a7.5 7.5 0 1 0 7.5 7.5"],
    }

    function Icon(props) {
      var size = props.size || 16
      var paths = ICON_PATHS[props.name] || ICON_PATHS.file
      var children = []
      for (var i = 0; i < paths.length; i += 1) children.push(h("path", { key: i, d: paths[i] }))
      return h(
        "svg",
        {
          className: cx("pdfw-icon", props.className),
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: props.strokeWidth || 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false",
        },
        children
      )
    }

    function Spinner(props) {
      return h("span", { className: "pdfw-spinner", "aria-hidden": "true" }, h(Icon, { name: "spinner", size: props && props.size ? props.size : 14 }))
    }

    function Btn(props) {
      var children = []
      if (props.icon) children.push(h(Icon, { key: "i", name: props.icon, size: props.iconSize || 15 }))
      if (props.children != null) children.push(h("span", { key: "l", className: "pdfw-btn-label" }, props.children))
      return h(
        "button",
        {
          type: "button",
          className: cx("pdfw-btn", "pdfw-btn--" + (props.variant || "ghost"), props.block ? "pdfw-btn--block" : "", props.className),
          onClick: props.onClick,
          disabled: props.disabled === true,
          title: props.title,
          "aria-label": props.ariaLabel,
        },
        children
      )
    }

    function IconBtn(props) {
      return h(
        "button",
        {
          type: "button",
          className: cx("pdfw-iconbtn", props.className),
          onClick: props.onClick,
          disabled: props.disabled === true,
          title: props.title || props.label,
          "aria-label": props.label || props.title,
          "aria-expanded": props.expanded,
        },
        h(Icon, { name: props.icon, size: props.size || 16 })
      )
    }

    function Badge(props) {
      return h("span", { className: cx("pdfw-badge", props.tone ? "pdfw-badge--" + props.tone : "", props.className), title: props.title }, props.children)
    }

    function StatusBadge(props) {
      var status = String(props.status || "")
      var tone = status === "done" ? "success" : status === "failed" ? "danger" : status === "cancelled" ? "muted" : "accent"
      return h(Badge, { tone: tone, className: "pdfw-status" }, statusCopy(status))
    }

    function Highlight(props) {
      var parts = highlightParts(props.text, props.query)
      var children = []
      for (var i = 0; i < parts.length; i += 1) {
        children.push(parts[i].hit ? h("mark", { key: i, className: "pdfw-mark" }, parts[i].text) : h("span", { key: i }, parts[i].text))
      }
      return h(Fragment, null, children)
    }

    function EmptyState(props) {
      return h(
        "div",
        { className: "pdfw-empty" },
        h("span", { className: "pdfw-empty-icon" }, h(Icon, { name: props.icon || "file", size: 26 })),
        h("p", { className: "pdfw-empty-title" }, props.title),
        props.desc ? h("p", { className: "pdfw-empty-desc" }, props.desc) : null
      )
    }

    function SectionHead(props) {
      return h(
        "div",
        { className: "pdfw-section-head" },
        h("span", { className: "pdfw-step" }, props.step),
        h("h3", { className: "pdfw-section-title" }, props.title),
        props.extra ? h("div", { className: "pdfw-section-extra" }, props.extra) : null
      )
    }

    function SearchBox(props) {
      return h(
        "div",
        { className: cx("pdfw-search", props.big ? "pdfw-search--big" : "") },
        h(Icon, { name: "search", size: props.big ? 17 : 15, className: "pdfw-search-icon" }),
        h("input", {
          type: "search",
          className: "pdfw-search-input",
          value: props.value,
          placeholder: props.placeholder,
          onChange: function (event) {
            props.onChange(event.target.value)
          },
          "aria-label": props.ariaLabel || t("nav.search"),
        }),
        props.value
          ? h(IconBtn, {
              icon: "close",
              label: t("common.close"),
              size: 14,
              className: "pdfw-search-clear",
              onClick: function () {
                props.onChange("")
              },
            })
          : null
      )
    }

    function ErrorStrip(props) {
      var error = props.error
      if (!error) return null
      var message = typeof error === "string" ? error : error.message || t("error.title")
      var hint = typeof error === "string" ? "" : error.hint
      var code = typeof error === "string" ? "" : error.code
      return h(
        "div",
        { className: "pdfw-error", role: "alert" },
        h("span", { className: "pdfw-error-icon" }, h(Icon, { name: "alert", size: 18 })),
        h(
          "div",
          { className: "pdfw-error-body" },
          h("p", { className: "pdfw-error-message" }, message),
          hint ? h("p", { className: "pdfw-error-hint" }, hint) : null,
          code ? h("p", { className: "pdfw-error-code" }, code) : null
        ),
        props.onRetry ? h(Btn, { variant: "subtle", icon: "retry", onClick: props.onRetry }, t("common.retry")) : null,
        props.onDismiss ? h(IconBtn, { icon: "close", label: t("common.close"), onClick: props.onDismiss }) : null
      )
    }

    function ProgressBar(props) {
      var percent = clampNumber(props.percent, 0, 100)
      return h(
        "div",
        {
          className: cx("pdfw-progress", props.indeterminate ? "pdfw-is-indeterminate" : "", props.tone ? "pdfw-is-" + props.tone : ""),
          role: "progressbar",
          "aria-valuemin": 0,
          "aria-valuemax": 100,
          "aria-valuenow": props.indeterminate ? undefined : Math.round(percent),
          "aria-label": props.label || t("progress.title"),
        },
        h("span", { className: "pdfw-progress-fill", style: { width: Math.max(percent, props.indeterminate ? 22 : 0) + "%" } })
      )
    }

    /* ==================================================================== */
    /* 8. field controls (CONTRACT §3.4)                                     */
    /* ==================================================================== */

    function FieldShell(props) {
      return h(
        "div",
        { className: cx("pdfw-field", props.inline ? "pdfw-field--inline" : "", props.invalid ? "pdfw-is-invalid" : "", props.wide ? "pdfw-field--wide" : "") },
        h(
          "div",
          { className: "pdfw-field-head" },
          h(
            "span",
            { className: "pdfw-field-label" },
            props.label,
            props.required ? h("span", { className: "pdfw-req", title: t("params.required") }, "*") : null
          ),
          props.help ? h("span", { className: "pdfw-field-help" }, props.help) : null
        ),
        h("div", { className: "pdfw-field-control" }, props.control),
        props.invalid ? h("p", { className: "pdfw-field-error", role: "alert" }, props.invalid) : null,
        props.range ? h("p", { className: "pdfw-field-range" }, props.range) : null
      )
    }

    function SelectControl(props) {
      var options = []
      for (var i = 0; i < props.options.length; i += 1) {
        var option = props.options[i]
        options.push(h("option", { key: String(option.value), value: String(option.value) }, pick(option.label)))
      }
      return h(
        "select",
        {
          className: "pdfw-select",
          value: props.value,
          onChange: function (event) {
            props.onChange(event.target.value)
          },
          disabled: props.disabled === true,
          "aria-label": props.label,
        },
        options
      )
    }

    function RadioControl(props) {
      var buttons = []
      for (var i = 0; i < props.options.length; i += 1) {
        var option = props.options[i]
        var active = String(props.value) === String(option.value)
        buttons.push(
          h(
            "button",
            {
              key: String(option.value),
              type: "button",
              role: "radio",
              "aria-checked": active ? "true" : "false",
              className: cx("pdfw-segment", active ? "pdfw-is-active" : ""),
              onClick: function (value) {
                return function () {
                  props.onChange(value)
                }
              }(String(option.value)),
              disabled: props.disabled === true,
            },
            h("span", { className: "pdfw-segment-label" }, pick(option.label)),
            option.hint ? h("span", { className: "pdfw-segment-hint" }, pick(option.hint)) : null
          )
        )
      }
      return h("div", { className: "pdfw-segments", role: "radiogroup", "aria-label": props.label }, buttons)
    }

    function NumberControl(props) {
      return h("input", {
        type: "number",
        className: "pdfw-input pdfw-input--number",
        value: props.value,
        min: props.min,
        max: props.max,
        step: props.step,
        onChange: function (event) {
          props.onChange(event.target.value)
        },
        disabled: props.disabled === true,
        "aria-label": props.label,
      })
    }

    function TextControl(props) {
      return h("input", {
        type: "text",
        className: "pdfw-input",
        value: props.value,
        placeholder: props.placeholder,
        onChange: function (event) {
          props.onChange(event.target.value)
        },
        disabled: props.disabled === true,
        "aria-label": props.label,
        spellCheck: false,
      })
    }

    function TextareaControl(props) {
      return h("textarea", {
        className: "pdfw-textarea",
        rows: props.rows || 3,
        value: props.value,
        placeholder: props.placeholder,
        onChange: function (event) {
          props.onChange(event.target.value)
        },
        disabled: props.disabled === true,
        "aria-label": props.label,
      })
    }

    function SwitchControl(props) {
      var on = props.value === true
      return h(
        "button",
        {
          type: "button",
          role: "switch",
          "aria-checked": on ? "true" : "false",
          className: cx("pdfw-switch", on ? "pdfw-is-on" : ""),
          onClick: function () {
            if (props.disabled !== true) props.onChange(!on)
          },
          disabled: props.disabled === true,
          "aria-label": props.label,
        },
        h("span", { className: "pdfw-switch-track", "aria-hidden": "true" }, h("span", { className: "pdfw-switch-thumb" }))
      )
    }

    function ColorControl(props) {
      var value = typeof props.value === "string" && props.value ? props.value : "#ffffff"
      return h(
        "div",
        { className: "pdfw-color" },
        h("input", {
          type: "color",
          className: "pdfw-color-swatch",
          value: value,
          onChange: function (event) {
            props.onChange(event.target.value)
          },
          disabled: props.disabled === true,
          "aria-label": props.label,
        }),
        h("input", {
          type: "text",
          className: "pdfw-input pdfw-input--hex",
          value: props.value,
          placeholder: "#ffffff",
          onChange: function (event) {
            props.onChange(event.target.value)
          },
          disabled: props.disabled === true,
          "aria-label": t("params.colorHex"),
          spellCheck: false,
        })
      )
    }

    function fieldControl(field, value, onChange, disabled) {
      if (field.type === "select" && Array.isArray(field.options)) {
        return h(SelectControl, { options: field.options, value: value == null ? "" : String(value), onChange: onChange, disabled: disabled, label: pick(field.label) })
      }
      if (field.type === "radio" && Array.isArray(field.options)) {
        return h(RadioControl, { options: field.options, value: value, onChange: onChange, disabled: disabled, label: pick(field.label) })
      }
      if (field.type === "switch") {
        return h(SwitchControl, { value: value === true, onChange: onChange, disabled: disabled, label: pick(field.label) })
      }
      if (field.type === "number") {
        return h(NumberControl, { value: value == null ? "" : String(value), min: field.min, max: field.max, step: field.step, onChange: onChange, disabled: disabled, label: pick(field.label) })
      }
      if (field.type === "textarea") {
        return h(TextareaControl, { value: value == null ? "" : String(value), rows: field.rows || 3, placeholder: field.placeholder ? pick(field.placeholder) : "", onChange: onChange, disabled: disabled, label: pick(field.label) })
      }
      if (field.type === "color") {
        return h(ColorControl, { value: value == null ? "" : String(value), onChange: onChange, disabled: disabled, label: pick(field.label) })
      }
      return h(TextControl, { value: value == null ? "" : String(value), placeholder: field.placeholder ? pick(field.placeholder) : "", onChange: onChange, disabled: disabled, label: pick(field.label) })
    }

    function fieldRangeLabel(field) {
      if (field.type !== "number" || (field.min === undefined && field.max === undefined)) return ""
      var min = field.min === undefined || field.min === null ? "—" : field.min
      var max = field.max === undefined || field.max === null ? "—" : field.max
      return t("params.range", { min: min, max: max })
    }

    function issueMessage(issue, fields) {
      var label = issue && issue.label ? pick(issue.label) : issue && issue.key ? issue.key : ""
      if (!issue) return t("action.invalidParams")
      if (issue.code === "REQUIRED") return t("params.requiredMissing", { label: label })
      if (issue.code === "NOT_NUMBER") return t("params.invalidNumberLabel", { label: label })
      if (issue.code === "TOO_SMALL") return t("params.tooSmallLabel", { label: label, min: issue.min })
      if (issue.code === "TOO_LARGE") return t("params.tooLargeLabel", { label: label, max: issue.max })
      return t("action.invalidParams")
    }

    /* ==================================================================== */
    /* 9. small shared bits                                                 */
    /* ==================================================================== */

    function nextFileId() {
      fileSeq += 1
      return "f" + fileSeq
    }

    function findField(fields, key) {
      var list = Array.isArray(fields) ? fields : EMPTY_ARRAY
      for (var i = 0; i < list.length; i += 1) {
        if (list[i].key === key) return list[i]
      }
      return null
    }

    function questionField(op) {
      return findField(op && op.fields, "question")
    }

    function totalFilesSize(files) {
      var total = 0
      var list = Array.isArray(files) ? files : EMPTY_ARRAY
      for (var i = 0; i < list.length; i += 1) total += Number(list[i].size) || 0
      return total
    }

    function isValidationError(error) {
      return Boolean(error) && (error.code === "VALIDATION" || error.code === "VALIDATION_FILES" || error.code === "CAPABILITY")
    }

    function uploadRejectError(result) {
      if (!result || !result.rejected || !result.rejected.length) return null
      var limits = result.limits || FALLBACK_LIMITS
      var reason = result.rejected[0].reason
      var names = []
      for (var i = 0; i < result.rejected.length && i < 4; i += 1) names.push(result.rejected[i].name)
      var joined = names.join(", ")
      var vars = {
        names: joined,
        maxFile: formatBytes(limits.maxFileBytes),
        maxFiles: limits.maxBatchFiles,
        maxTotal: formatBytes(limits.maxBatchBytes),
      }
      var code = reason === "tooLarge" ? "TOO_LARGE" : reason === "tooMany" ? "TOO_MANY_FILES" : "TOO_LARGE_TOTAL"
      return makeError(code, t("upload.err." + reason, vars), t("upload.err." + reason + "Hint", vars))
    }

    /* ==================================================================== */
    /* 10. upload zone (step 1)                                             */
    /* ==================================================================== */

    function UploadZone(props) {
      var draggingState = useState(false)
      var dragging = draggingState[0]
      var setDragging = draggingState[1]
      var overState = useState(-1)
      var overIndex = overState[0]
      var setOverIndex = overState[1]
      var dragState = useState(-1)
      var dragIndex = dragState[0]
      var setDragIndex = dragState[1]
      var inputRef = useRef(null)
      var depthRef = useRef(0)

      var op = props.op || EMPTY_OBJECT
      var files = Array.isArray(props.files) ? props.files : EMPTY_ARRAY
      var limits = props.limits ? props.limits : FALLBACK_LIMITS
      var disabled = props.disabled === true
      var multiple = op.multiple === true
      var reorder = op.reorder === true && files.length > 1
      var formats = formatLabels(op.accept).join(" / ")

      function openPicker() {
        if (disabled) return
        var input = inputRef.current
        if (input && typeof input.click === "function") input.click()
      }

      function handlePicked(event) {
        var picked = event.target && event.target.files ? event.target.files : null
        var list = []
        if (picked) {
          for (var i = 0; i < picked.length; i += 1) list.push(picked[i])
        }
        event.target.value = ""
        if (list.length) props.onFiles(list)
      }

      function handleDragEnter(event) {
        if (disabled) return
        event.preventDefault()
        depthRef.current += 1
        setDragging(true)
      }

      function handleDragOver(event) {
        if (disabled) return
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
      }

      function handleDragLeave(event) {
        if (disabled) return
        event.preventDefault()
        depthRef.current = Math.max(0, depthRef.current - 1)
        if (depthRef.current === 0) setDragging(false)
      }

      function handleDrop(event) {
        if (disabled) return
        event.preventDefault()
        depthRef.current = 0
        setDragging(false)
        var dropped = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files : null
        var list = []
        if (dropped) {
          for (var i = 0; i < dropped.length; i += 1) list.push(dropped[i])
        }
        if (list.length) props.onFiles(list)
      }

      function rowDragStart(index) {
        return function (event) {
          setDragIndex(index)
          setOverIndex(index)
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move"
            try {
              event.dataTransfer.setData("text/plain", String(index))
            } catch (error) {
              /* some browsers refuse custom payloads for file drags */
            }
          }
        }
      }

      function rowDragOver(index) {
        return function (event) {
          if (!reorder) return
          event.preventDefault()
          setOverIndex(index)
        }
      }

      function rowDrop(index) {
        return function (event) {
          if (!reorder) return
          event.preventDefault()
          var from = dragIndex
          if (from < 0 && event.dataTransfer) {
            var raw = event.dataTransfer.getData("text/plain")
            var parsed = parseInt(raw, 10)
            if (!isNaN(parsed)) from = parsed
          }
          if (from >= 0 && from !== index) props.onMove(from, index)
          setDragIndex(-1)
          setOverIndex(-1)
        }
      }

      function rowDragEnd() {
        setDragIndex(-1)
        setOverIndex(-1)
      }

      var rows = []
      for (var index = 0; index < files.length; index += 1) {
        var entry = files[index]
        var rowChildren = []
        if (reorder) {
          rowChildren.push(h("span", { key: "grip", className: "pdfw-file-grip", "aria-hidden": "true" }, h(Icon, { name: "layers", size: 13 })))
          rowChildren.push(h("span", { key: "idx", className: "pdfw-file-index" }, String(index + 1)))
        }
        rowChildren.push(h("span", { key: "icon", className: "pdfw-file-icon" }, h(Icon, { name: "file", size: 15 })))
        rowChildren.push(
          h(
            "span",
            { key: "meta", className: "pdfw-file-meta" },
            h("span", { className: "pdfw-file-name", title: entry.name }, entry.name),
            h("span", { className: "pdfw-file-size" }, formatBytes(entry.size))
          )
        )
        if (reorder) {
          rowChildren.push(
            h(
              "span",
              { key: "order", className: "pdfw-file-order" },
              h(IconBtn, {
                icon: "arrowUp",
                label: t("upload.moveUp"),
                size: 14,
                disabled: disabled || index === 0,
                onClick: function (at) {
                  return function () {
                    props.onMove(at, at - 1)
                  }
                }(index),
              }),
              h(IconBtn, {
                icon: "arrowDown",
                label: t("upload.moveDown"),
                size: 14,
                disabled: disabled || index === files.length - 1,
                onClick: function (at) {
                  return function () {
                    props.onMove(at, at + 1)
                  }
                }(index),
              })
            )
          )
        }
        rowChildren.push(
          h(IconBtn, {
            key: "remove",
            icon: "close",
            label: t("common.remove"),
            size: 14,
            className: "pdfw-file-remove",
            disabled: disabled,
            onClick: function (id) {
              return function () {
                props.onRemove(id)
              }
            }(entry.id),
          })
        )
        var rowProps = {
          key: entry.id,
          className: cx("pdfw-file", dragIndex === index ? "pdfw-is-dragging" : "", overIndex === index && dragIndex !== index ? "pdfw-is-over" : ""),
          draggable: reorder && !disabled ? "true" : undefined,
        }
        if (reorder) {
          rowProps.onDragStart = rowDragStart(index)
          rowProps.onDragOver = rowDragOver(index)
          rowProps.onDrop = rowDrop(index)
          rowProps.onDragEnd = rowDragEnd
        }
        rows.push(h("li", rowProps, rowChildren))
      }

      return h(
        "section",
        { className: "pdfw-card pdfw-upload" },
        h(SectionHead, { step: "1", title: t("upload.title"), extra: files.length ? h(Badge, { tone: "muted" }, t("common.filesCount", { n: files.length })) : null }),
        h("p", { className: "pdfw-section-desc" }, t("upload.subtitle") + (multiple ? t("upload.multi") : t("upload.single"))),
        h(
          "div",
          {
            className: cx("pdfw-drop", dragging ? "pdfw-is-dragging" : "", disabled ? "pdfw-is-disabled" : ""),
            role: "button",
            tabIndex: disabled ? -1 : 0,
            "aria-label": t("upload.dropTitle"),
            onClick: openPicker,
            onKeyDown: function (event) {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                openPicker()
              }
            },
            onDragEnter: handleDragEnter,
            onDragOver: handleDragOver,
            onDragLeave: handleDragLeave,
            onDrop: handleDrop,
          },
          h("span", { className: "pdfw-drop-icon" }, h(Icon, { name: "upload", size: 26 })),
          h("p", { className: "pdfw-drop-title" }, dragging ? t("upload.dropTitleActive") : t("upload.dropTitle")),
          h(
            "p",
            { className: "pdfw-drop-hint" },
            t("upload.choose") +
              " · " +
              t("upload.maxFile") +
              (multiple
                ? " · " + t("upload.maxBatch", { n: limits.maxBatchFiles }) + " · " + t("upload.maxTotal", { size: formatBytes(limits.maxBatchBytes) })
                : "")
          ),
          formats ? h("p", { className: "pdfw-drop-formats" }, t("upload.formats") + ": " + formats) : null,
          h("input", {
            ref: inputRef,
            type: "file",
            className: "pdfw-hidden-input",
            accept: op.accept || undefined,
            multiple: multiple,
            tabIndex: -1,
            "aria-hidden": "true",
            onChange: handlePicked,
            onClick: function (event) {
              event.stopPropagation()
            },
          })
        ),
        rows.length
          ? h(
              "div",
              { className: "pdfw-files" },
              h(
                "div",
                { className: "pdfw-files-head" },
                h("span", null, t("common.selectedCount", { n: files.length })),
                h("span", null, t("common.totalSize", { size: formatBytes(totalFilesSize(files)) })),
                reorder ? h("span", { className: "pdfw-files-hint" }, t("upload.reorderHint")) : null
              ),
              h("ul", { className: "pdfw-file-list" }, rows)
            )
          : h("p", { className: "pdfw-muted pdfw-upload-empty" }, t("upload.emptyList"))
      )
    }

    /* ==================================================================== */
    /* 11. parameter panel (step 2)                                         */
    /* ==================================================================== */

    function ParamsPanel(props) {
      var fields = Array.isArray(props.fields) ? props.fields : EMPTY_ARRAY
      var issues = Array.isArray(props.issues) ? props.issues : EMPTY_ARRAY
      var issueByKey = {}
      for (var i = 0; i < issues.length; i += 1) {
        if (!issueByKey[issues[i].key]) issueByKey[issues[i].key] = issues[i]
      }
      var rows = []
      for (var j = 0; j < fields.length; j += 1) {
        var field = fields[j]
        var issue = issueByKey[field.key]
        rows.push(
          h(FieldShell, {
            key: field.key,
            label: pick(field.label),
            help: field.help ? pick(field.help) : "",
            required: field.required === true,
            inline: field.type === "switch",
            invalid: issue ? issueMessage(issue, fields) : "",
            range: fieldRangeLabel(field),
            control: fieldControl(
              field,
              props.values ? props.values[field.key] : undefined,
              function (key) {
                return function (next) {
                  props.onChange(key, next)
                }
              }(field.key),
              props.disabled === true
            ),
          })
        )
      }
      return h(
        "section",
        { className: "pdfw-card pdfw-params" },
        h(
          SectionHead,
          {
            step: "2",
            title: t("params.title"),
            extra: h(Btn, { variant: "ghost", icon: "retry", onClick: props.onReset, disabled: props.disabled === true }, t("params.reset")),
          }
        ),
        fields.length ? h("div", { className: "pdfw-fields" }, rows) : h("p", { className: "pdfw-muted" }, t("params.none"))
      )
    }

    /* ==================================================================== */
    /* 12. progress panel (step 4)                                          */
    /* ==================================================================== */

    function ProgressPanel(props) {
      var job = props.job
      var busy = props.busy === true
      var status = job ? String(job.status || "") : BusyStatus(busy)
      var percent = job && typeof job.progress === "number" ? progressPercent(job.progress) : busy ? 2 : 0
      var indeterminate = busy && !job
      var remaining = estimateRemainingMs(job)
      var elapsed = job && job.startedAt ? Date.now() - Number(job.startedAt) : 0
      var stageText = resolveStageText(job, props.stage, busy)
      var meta = [h("span", { key: "stage", className: "pdfw-progress-stage" }, stageText), h("span", { key: "pct", className: "pdfw-progress-num" }, t("progress.percent", { n: percent }))]
      if (remaining) meta.push(h("span", { key: "eta", className: "pdfw-progress-eta" }, t("progress.eta", { time: formatDuration(remaining) })))
      else if (elapsed > 0 && busy) meta.push(h("span", { key: "elapsed", className: "pdfw-progress-eta" }, t("progress.elapsed", { time: formatDuration(elapsed) })))
      return h(
        "section",
        { className: "pdfw-card pdfw-progress-panel" },
        h(SectionHead, { step: "4", title: t("progress.title"), extra: job ? h(StatusBadge, { status: status }) : null }),
        h(ProgressBar, { percent: percent, indeterminate: indeterminate, label: t("progress.title") }),
        h("div", { className: "pdfw-progress-meta" }, meta)
      )
    }

    function BusyStatus(busy) {
      return busy ? "running" : ""
    }

    function resolveStageText(job, stage, busy) {
      if (stage === "uploading") return t("progress.uploading")
      if (job && job.stage) return String(job.stage)
      var status = job ? String(job.status || "") : ""
      if (status === "queued") return t("progress.queued")
      if (status === "running") return t("progress.processing")
      if (status === "done") return t("progress.done")
      if (status === "failed") return t("progress.failed")
      if (status === "cancelled") return t("progress.cancelled")
      return busy ? t("progress.processing") : t("common.empty")
    }

    /* ==================================================================== */
    /* 13. feature view — the five-step flow                                */
    /* ==================================================================== */

    function WorkspaceView(props) {
      var op = props.op
      var ws = props.ws
      var limits = props.limits
      var info = props.info
      var allFields = op && Array.isArray(op.fields) ? op.fields : EMPTY_ARRAY
      var shownFields = formFields(op, ws.values)
      var skipKeys = op && op.chat === true ? ["question"] : EMPTY_ARRAY
      var issues = validateValues(allFields, ws.values, { skipKeys: skipKeys })
      var gap = capabilityGap(op, info)
      var warning = capabilityWarning(op, info)
      var needQuestion = op && op.chat === true && !String(ws.question || "").trim()
      var needsFiles = ws.files.length === 0
      var chatQuestion = questionField(op)
      var blockedReason = null

      useTicker(ws.busy === true)

      if (ws.busy) blockedReason = t("action.busy")
      else if (needsFiles) blockedReason = op && op.multiple === true ? t("action.needFiles") : t("action.needFilesOne")
      else if (needQuestion) blockedReason = t("action.needQuestion")
      else if (issues.length) blockedReason = issueMessage(issues[0], allFields)
      else if (gap) blockedReason = t("cap." + gap + "Unavailable")
      var canStart = blockedReason === null

      return h(
        "div",
        { className: "pdfw-workspace" },
        h(
          "header",
          { className: "pdfw-workspace-head" },
          h("span", { className: "pdfw-workspace-icon" }, h(Icon, { name: groupIconForOp(op), size: 20 })),
          h(
            "div",
            { className: "pdfw-workspace-copy" },
            h("h1", { className: "pdfw-workspace-title" }, pick(op.title)),
            h("p", { className: "pdfw-workspace-desc" }, pick(op.description))
          ),
          h(
            "div",
            { className: "pdfw-workspace-badges" },
            h(Badge, { tone: "muted" }, op.multiple === true ? t("action.batch") : t("action.single")),
            op.ai === true ? h(Badge, { tone: "accent" }, t("badge.ai")) : null
          )
        ),
        gap
          ? h(
              "div",
              { className: "pdfw-warn", role: "status" },
              h(Icon, { name: "alert", size: 16 }),
              h("div", null, h("p", { className: "pdfw-warn-title" }, t("cap." + gap + "Unavailable")), h("p", { className: "pdfw-warn-hint" }, t("cap." + gap + "UnavailableHint")))
            )
          : null,
        warning
          ? h(
              "p",
              { className: "pdfw-warn-text" },
              t("cap." + warning + "Unavailable") + " · " + t("cap." + warning + "UnavailableHint")
            )
          : null,
        h(UploadZone, {
          op: op,
          files: ws.files,
          limits: limits,
          disabled: ws.busy,
          onFiles: ws.addFiles,
          onRemove: ws.removeFile,
          onMove: ws.moveFile,
        }),
        h(ParamsPanel, {
          fields: shownFields,
          values: ws.values,
          issues: issues,
          disabled: ws.busy,
          onChange: ws.setFieldValue,
          onReset: ws.resetParams,
        }),
        h(
          "section",
          { className: "pdfw-card pdfw-run" },
          h(SectionHead, { step: "3", title: t("action.title") }),
          chatQuestion
            ? h("div", { className: "pdfw-run-question" },
                h("textarea", {
                  className: "pdfw-textarea",
                  rows: chatQuestion.rows || 3,
                  value: ws.question,
                  placeholder: chatQuestion.placeholder ? pick(chatQuestion.placeholder) : "",
                  disabled: ws.busy,
                  "aria-label": chatQuestion.label ? pick(chatQuestion.label) : t("action.ask"),
                  onChange: function (event) {
                    ws.setQuestion(event.target.value)
                  },
                })
              )
            : null,
          h(
            "div",
            { className: "pdfw-run-actions" },
            h(
              Btn,
              {
                variant: "primary",
                icon: op.chat === true ? "send" : "check",
                onClick: function () {
                  ws.start()
                },
                disabled: !canStart,
                title: canStart ? undefined : blockedReason,
              },
              op.chat === true ? t("action.ask") : t("action.start")
            ),
            ws.busy ? h(Btn, { variant: "ghost", icon: "close", onClick: ws.cancel }, t("action.cancel")) : null
          ),
          canStart ? null : h("p", { className: "pdfw-blocked", role: "status" }, t("action.disabledReason", { reason: blockedReason }))
        ),
        ws.busy || ws.job ? h(ProgressPanel, { job: ws.job, busy: ws.busy, stage: ws.stage }) : null,
        h(ErrorStrip, {
          error: ws.error,
          onRetry: ws.error && !isValidationError(ws.error) ? ws.reprocess : undefined,
          onDismiss: ws.error ? ws.clearError : undefined,
        })
      )
    }

    /* ==================================================================== */
    /* 14. navigation (left column)                                         */
    /* ==================================================================== */

    function LeftNav(props) {
      var expandedState = useState({})
      var expanded = expandedState[0]
      var setExpanded = expandedState[1]
      var nav = Array.isArray(props.nav) ? props.nav : EMPTY_ARRAY
      var query = props.query || ""
      var searchActive = String(query).trim().length > 0
      var filtered = filterNavigation(nav, query)

      function toggle(groupId) {
        setExpanded(function (previous) {
          var next = {}
          for (var key in previous) next[key] = previous[key]
          next[groupId] = previous[groupId] === false
          return next
        })
      }

      var groups = []
      for (var i = 0; i < filtered.length; i += 1) {
        var entry = filtered[i]
        var group = entry.group
        var open = searchActive || expanded[group.id] !== false
        var ops = navigationOps(entry)
        var sections = []
        for (var s = 0; s < entry.sections.length; s += 1) {
          var section = entry.sections[s]
          var items = []
          for (var o = 0; o < section.ops.length; o += 1) {
            var op = section.ops[o]
            var active = op.id === props.activeOpId
            items.push(
              h(
                "button",
                {
                  key: op.id,
                  type: "button",
                  className: cx("pdfw-nav-item", active ? "pdfw-is-active" : ""),
                  "aria-current": active ? "page" : undefined,
                  disabled: props.busy === true,
                  title: props.busy === true ? t("action.busy") : undefined,
                  onClick: function (id) {
                    return function () {
                      props.onOpen(id)
                    }
                  }(op.id),
                },
                h("span", { className: "pdfw-nav-item-title" }, h(Highlight, { text: pick(op.title), query: query })),
                op.ai === true ? h("span", { className: "pdfw-nav-tag" }, "AI") : null,
                op.batch === true ? h("span", { className: "pdfw-nav-tag" }, t("badge.batch")) : null
              )
            )
          }
          sections.push(
            h(
              "div",
              { key: section.key || "__default", className: "pdfw-nav-section" },
              section.key ? h("p", { className: "pdfw-nav-section-title" }, pick(section.title)) : null,
              items
            )
          )
        }
        groups.push(
          h(
            "div",
            { key: group.id, className: "pdfw-nav-group" },
            h(
              "button",
              {
                type: "button",
                className: cx("pdfw-nav-group-head", open ? "pdfw-is-open" : ""),
                onClick: function (id) {
                  return function () {
                    toggle(id)
                  }
                }(group.id),
                "aria-expanded": open ? "true" : "false",
              },
              h(Icon, { name: open ? "chevronDown" : "chevronRight", size: 13 }),
              h(Icon, { name: group.icon || "file", size: 15, className: "pdfw-nav-group-icon" }),
              h("span", { className: "pdfw-nav-group-title" }, pick(group.title)),
              h("span", { className: "pdfw-nav-count" }, String(ops.length))
            ),
            open ? h("div", { className: "pdfw-nav-items" }, sections) : null
          )
        )
      }

      return h(
        "nav",
        { className: "pdfw-nav", "aria-label": t("nav.browse") },
        filtered.length === 0 ? h("p", { className: "pdfw-muted pdfw-nav-empty" }, t("nav.noResults")) : groups
      )
    }

    /* ==================================================================== */
    /* 15. home view (center column)                                        */
    /* ==================================================================== */

    function OpCard(props) {
      var op = props.op
      return h(
        "button",
        {
          type: "button",
          className: "pdfw-card pdfw-opcard",
          disabled: props.busy === true,
          title: props.busy === true ? t("action.busy") : undefined,
          onClick: function () {
            props.onOpen(op.id)
          },
        },
        h("span", { className: "pdfw-opcard-icon" }, h(Icon, { name: groupIconForOp(op), size: 18 })),
        h(
          "span",
          { className: "pdfw-opcard-copy" },
          h("span", { className: "pdfw-opcard-title" }, h(Highlight, { text: pick(op.title), query: props.query })),
          h("span", { className: "pdfw-opcard-desc" }, h(Highlight, { text: pick(op.description), query: props.query }))
        ),
        h(
          "span",
          { className: "pdfw-opcard-tags" },
          op.ai === true ? h(Badge, { tone: "accent" }, t("badge.ai")) : null,
          op.batch === true ? h(Badge, { tone: "muted" }, t("badge.batch")) : null
        )
      )
    }

    function HomeView(props) {
      var nav = Array.isArray(props.nav) ? props.nav : EMPTY_ARRAY
      var filtered = filterNavigation(nav, props.query)
      var total = countNavigationOps(filtered)
      var sections = []
      for (var i = 0; i < filtered.length; i += 1) {
        var entry = filtered[i]
        var ops = navigationOps(entry)
        var cards = []
        for (var j = 0; j < ops.length; j += 1) cards.push(h(OpCard, { key: ops[j].id, op: ops[j], query: props.query, onOpen: props.onOpen, busy: props.busy }))
        sections.push(
          h(
            "section",
            { key: entry.group.id, className: "pdfw-home-group" },
            h(
              "div",
              { className: "pdfw-home-group-head" },
              h("span", { className: "pdfw-home-group-icon" }, h(Icon, { name: entry.group.icon || "file", size: 16 })),
              h("h2", { className: "pdfw-home-group-title" }, h(Highlight, { text: pick(entry.group.title), query: props.query })),
              h(Badge, { tone: "muted" }, t("nav.groupOps", { n: ops.length }))
            ),
            h("p", { className: "pdfw-home-group-desc" }, pick(entry.group.description)),
            h("div", { className: "pdfw-cards" }, cards)
          )
        )
      }
      return h(
        "div",
        { className: "pdfw-home" },
        h(
          "header",
          { className: "pdfw-home-head" },
          h("h1", { className: "pdfw-home-title" }, t("home.title")),
          h("p", { className: "pdfw-home-desc" }, t("home.desc")),
          h(SearchBox, {
            value: props.query,
            onChange: props.onQueryChange,
            placeholder: t("nav.searchPlaceholder"),
            big: true,
            ariaLabel: t("nav.search"),
          })
        ),
        String(props.query || "").trim() ? h("p", { className: "pdfw-home-count" }, t("home.resultCount", { n: total })) : null,
        total === 0
          ? h(EmptyState, { icon: "search", title: t("home.emptyTitle"), desc: t("home.emptyDesc") })
          : sections
      )
    }

    /* ==================================================================== */
    /* 16. notes panel (right column on home)                               */
    /* ==================================================================== */

    function NoteRow(props) {
      return h("li", { className: "pdfw-note-row" }, props.icon ? h(Icon, { name: props.icon, size: 14 }) : null, h("span", null, props.children))
    }

    function NotesPanel(props) {
      var op = props.op
      var limits = normalizeLimits(props.limits)
      var info = props.info || EMPTY_OBJECT
      var hours = typeof info.retentionHours === "number" && info.retentionHours > 0 ? info.retentionHours : Math.round(limits.retentionMs / 3600000)
      var items = []
      if (op) {
        items.push(h("h3", { key: "t", className: "pdfw-notes-title" }, t("notes.opTitle", { title: pick(op.title) })))
        items.push(h(NoteRow, { key: "fmt", icon: "file" }, t("notes.formats", { formats: formatLabels(op.accept).join(" / ") || "—" })))
        items.push(h(NoteRow, { key: "mode", icon: "layers" }, t("notes.mode", { mode: op.multiple === true ? t("action.batch") : t("action.single") })))
        if (op.preview && op.preview !== "none") items.push(h(NoteRow, { key: "prev", icon: "image" }, t("notes.preview")))
        if (op.ai === true) items.push(h(NoteRow, { key: "ai", icon: "sparkles" }, t("notes.ai")))
        if (op.engine === "ocr") items.push(h(NoteRow, { key: "ocr", icon: "search" }, t("notes.ocr")))
        if (op.engine === "toPDF") items.push(h(NoteRow, { key: "office", icon: "refresh" }, t("notes.office")))
        if (op.id === "ai.translate") {
          var budget = info.capabilities && info.capabilities.translatePageBudget
          items.push(h(NoteRow, { key: "budget", icon: "info" }, t("notes.translateBudget", { n: typeof budget === "number" && budget > 0 ? budget : 80 })))
        }
        items.push(h(NoteRow, { key: "tip", icon: "info" }, t("notes.tip")))
      }
      return h(
        "div",
        { className: "pdfw-notes" },
        h("h2", { className: "pdfw-pane-title" }, t("notes.title")),
        items,
        h("h3", { className: "pdfw-notes-title" }, t("notes.limitsTitle")),
        h(
          "ul",
          { className: "pdfw-note-list" },
          h(NoteRow, { icon: "file", key: "f" }, t("notes.maxFile", { size: formatBytes(limits.maxFileBytes) })),
          h(NoteRow, { icon: "layers", key: "b" }, t("notes.maxBatch", { n: limits.maxBatchFiles })),
          h(NoteRow, { icon: "upload", key: "t" }, t("notes.maxTotal", { size: formatBytes(limits.maxBatchBytes) })),
          h(NoteRow, { icon: "info", key: "r" }, t("notes.retention", { hours: hours })),
          h(NoteRow, { icon: "check", key: "k" }, t("notes.shortcuts"))
        )
      )
    }

    /* ==================================================================== */
    /* 16b. minimal Markdown renderer                                        */
    /* ==================================================================== */

    /**
     * Render the marked-up text the model returns (headings, lists, tables,
     * fenced code, **bold**, `code`) instead of dumping raw Markdown into a
     * <pre>. Deliberately tiny: no HTML passthrough, no links, no nesting.
     */
    function splitRow(line) {
      return String(line).trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (cell) { return cell.trim() })
    }

    function mdInline(text, keyPrefix) {
      var nodes = []
      var source = String(text || "")
      var pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g
      var last = 0
      var match
      var index = 0
      while ((match = pattern.exec(source)) !== null) {
        if (match.index > last) nodes.push(source.slice(last, match.index))
        var token = match[0]
        if (token.slice(0, 2) === "**") nodes.push(h("strong", { key: keyPrefix + "-b" + index }, token.slice(2, -2)))
        else nodes.push(h("code", { key: keyPrefix + "-c" + index }, token.slice(1, -1)))
        last = match.index + token.length
        index += 1
      }
      if (last < source.length) nodes.push(source.slice(last))
      return nodes.length ? nodes : [source]
    }

    function mdBlocks(text) {
      var lines = String(text || "").replace(/\r\n?/g, "\n").split("\n")
      var blocks = []
      var i = 0
      var key = 0
      while (i < lines.length) {
        var line = lines[i]
        if (!line.trim()) { i += 1; continue }
        if (/^```/.test(line)) {
          var code = []
          i += 1
          while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i += 1 }
          i += 1
          blocks.push(h("pre", { key: "md" + key++, className: "pdfw-pre pdfw-md-code" }, code.join("\n")))
          continue
        }
        var heading = line.match(/^(#{1,6})\s+(.*)$/)
        if (heading) {
          var level = Math.min(4, heading[1].length)
          blocks.push(h("h" + (level + 2), { key: "md" + key++, className: "pdfw-md-h pdfw-md-h" + level }, mdInline(heading[2], "md" + key)))
          i += 1
          continue
        }
        if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
          var header = splitRow(line)
          i += 2
          var rows = []
          while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i += 1 }
          blocks.push(
            h(
              "div",
              { key: "md" + key++, className: "pdfw-md-table-wrap" },
              h(
                "table",
                { className: "pdfw-md-table" },
                h("thead", null, h("tr", null, header.map(function (cell, cellIndex) { return h("th", { key: cellIndex }, mdInline(cell, "mdh" + cellIndex)) }))),
                h(
                  "tbody",
                  null,
                  rows.map(function (row, rowIndex) {
                    return h(
                      "tr",
                      { key: rowIndex },
                      header.map(function (_, cellIndex) {
                        return h("td", { key: cellIndex }, mdInline(row[cellIndex] || "", "mdt" + rowIndex + "-" + cellIndex))
                      })
                    )
                  })
                )
              )
            )
          )
          continue
        }
        if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
          var ordered = /^\s*\d+[.)]\s+/.test(line)
          var items = []
          while (i < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) {
            items.push(h("li", { key: items.length }, mdInline(lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""), "mdi" + items.length)))
            i += 1
          }
          blocks.push(h(ordered ? "ol" : "ul", { key: "md" + key++, className: "pdfw-md-list" }, items))
          continue
        }
        var paragraph = []
        while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) {
          paragraph.push(lines[i])
          i += 1
        }
        blocks.push(h("p", { key: "md" + key++, className: "pdfw-md-p" }, mdInline(paragraph.join(" "), "mdp" + key)))
      }
      return blocks
    }

    function Markdown(props) {
      return h("div", { className: "pdfw-md" }, mdBlocks(props.text))
    }

    /* 17. output previews                                                  */
    /* ==================================================================== */

    function PdfPreview(props) {
      var total = usePageCount(props.jobId, props.fileId, props.pages)
      var pageState = useState(1)
      var page = pageState[0]
      var setPage = pageState[1]
      var failedState = useState(false)
      var failed = failedState[0]
      var setFailed = failedState[1]
      var src = ENDPOINTS.preview(props.jobId, props.fileId, page, PREVIEW_WIDTH)

      useEffect(
        function () {
          setFailed(false)
        },
        [src]
      )

      var maxPage = total > 0 ? total : 1
      return h(
        "div",
        { className: "pdfw-preview" },
        failed
          ? h("p", { className: "pdfw-muted pdfw-preview-failed" }, t("result.previewFailed"))
          : h("img", {
              className: "pdfw-preview-img",
              src: src,
              alt: props.name || "",
              loading: "lazy",
              onError: function () {
                setFailed(true)
              },
            }),
        h(
          "div",
          { className: "pdfw-preview-nav" },
          h(IconBtn, {
            icon: "arrowLeft",
            label: t("common.prevPage"),
            size: 15,
            disabled: page <= 1,
            onClick: function () {
              setPage(function (previous) {
                return Math.max(1, previous - 1)
              })
            },
          }),
          h("span", { className: "pdfw-preview-count" }, t("common.pageOf", { page: page, total: total > 0 ? total : "—" })),
          h(IconBtn, {
            icon: "arrowRight",
            label: t("common.nextPage"),
            size: 15,
            disabled: total > 0 && page >= maxPage,
            onClick: function () {
              setPage(function (previous) {
                return Math.min(maxPage, previous + 1)
              })
            },
          })
        )
      )
    }

    function ImagePreview(props) {
      var failedState = useState(false)
      var failed = failedState[0]
      var setFailed = failedState[1]
      var src = ENDPOINTS.file(props.jobId, props.fileId, true)
      return h(
        "div",
        { className: "pdfw-preview" },
        failed
          ? h("p", { className: "pdfw-muted pdfw-preview-failed" }, t("result.previewFailed"))
          : h("img", {
              className: "pdfw-preview-img",
              src: src,
              alt: props.name || "",
              loading: "lazy",
              onError: function () {
                setFailed(true)
              },
            })
      )
    }

    function TextPreview(props) {
      var valueState = useState({ loading: true, text: "", error: null })
      var value = valueState[0]
      var setValue = valueState[1]
      var copyState = useCopyFeedback()
      var copied = copyState[0]
      var copy = copyState[1]

      useEffect(
        function () {
          var cancelled = false
          var controller = null
          try {
            controller = new AbortController()
          } catch (error) {
            controller = null
          }
          setValue({ loading: true, text: "", error: null })
          apiGetText(ENDPOINTS.file(props.jobId, props.fileId, true), controller ? controller.signal : undefined)
            .then(function (text) {
              if (cancelled) return
              setValue({ loading: false, text: text, error: null })
            })
            .catch(function (error) {
              if (cancelled || isAbortError(error)) return
              setValue({ loading: false, text: "", error: transportError(error) })
            })
          return function () {
            cancelled = true
            if (controller) controller.abort()
          }
        },
        [props.jobId, props.fileId]
      )

      return h(
        "div",
        { className: "pdfw-text-preview" },
        h(
          "div",
          { className: "pdfw-text-toolbar" },
          h("span", { className: "pdfw-muted" }, t("result.textTitle")),
          h(
            Btn,
            {
              variant: "ghost",
              icon: "copy",
              disabled: value.loading || !value.text,
              onClick: function () {
                copy(value.text)
              },
            },
            copied === "copied" ? t("common.copied") : t("common.copy")
          )
        ),
        value.loading
          ? h("p", { className: "pdfw-muted" }, t("result.previewLoading"))
          : value.error
          ? h("p", { className: "pdfw-muted" }, value.error.message + (value.error.hint ? " · " + value.error.hint : ""))
          : h("pre", { className: "pdfw-pre" }, value.text || t("common.empty"))
      )
    }

    function OutputRow(props) {
      var output = props.output
      var jobId = props.jobId
      var kind = previewKindFor(output)
      var url = ENDPOINTS.file(jobId, output.id, false)
      var originalBytes = Number(output.originalBytes) || 0
      var capped = originalBytes > 0 && originalBytes > Number(output.bytes || 0)
      return h(
        "article",
        { className: "pdfw-output" },
        h(
          "header",
          { className: "pdfw-output-head" },
          h("span", { className: "pdfw-output-icon" }, h(Icon, { name: kind === "image" ? "image" : "file", size: 15 })),
          h(
            "span",
            { className: "pdfw-output-meta" },
            h("span", { className: "pdfw-output-name", title: output.name }, output.name),
            h(
              "span",
              { className: "pdfw-output-sub" },
              formatBytes(output.bytes),
              output.pages ? " · " + t("result.pages", { n: output.pages }) : "",
              capped && originalBytes
                ? " · " + t("result.compressed", { from: formatBytes(originalBytes), to: formatBytes(output.bytes) })
                : ""
            )
          ),
          capped ? h(Badge, { tone: output.targetReached === false ? "danger" : "success" }, output.targetReached === false ? t("result.capMissed") : t("result.capBadge")) : null,
          h(Badge, { tone: "muted" }, kindBadge(output.kind)),
          h(
            "a",
            {
              className: "pdfw-btn pdfw-btn--subtle pdfw-output-download",
              href: url,
              download: output.name || "",
              title: t("common.download") + " · " + (output.name || ""),
            },
            h(Icon, { name: "download", size: 15 }),
            h("span", { className: "pdfw-btn-label" }, t("common.download"))
          )
        ),
        kind === "none" ? h("p", { className: "pdfw-muted pdfw-output-none" }, t("result.noPreview")) : null,
        props.inline === false
          ? null
          : kind === "pdf"
            ? h(PdfPreview, { jobId: jobId, fileId: output.id, pages: output.pages, name: output.name })
            : kind === "image"
              ? h(ImagePreview, { jobId: jobId, fileId: output.id, name: output.name })
              : kind === "text"
                ? h(TextPreview, { jobId: jobId, fileId: output.id })
                : null
      )
    }

    /* ==================================================================== */
    /* 18. batch status list                                                */
    /* ==================================================================== */

    function batchRows(job) {
      var inputs = job && Array.isArray(job.inputs) ? job.inputs : EMPTY_ARRAY
      var items = job && Array.isArray(job.items) ? job.items : EMPTY_ARRAY
      var byName = {}
      var i
      for (i = 0; i < items.length; i += 1) {
        if (items[i] && items[i].input) byName[items[i].input] = items[i]
      }
      var consumed = {}
      var rows = []
      for (i = 0; i < inputs.length; i += 1) {
        var name = inputs[i].name || "file-" + (i + 1)
        var item = byName[name] || null
        consumed[name] = true
        rows.push({
          name: name,
          size: inputs[i].size,
          item: item,
          state: item ? (item.ok === true ? "success" : "failed") : "pending",
        })
      }
      for (i = 0; i < items.length; i += 1) {
        var extra = items[i]
        if (!extra || !extra.input || consumed[extra.input]) continue
        rows.push({ name: String(extra.input), size: 0, item: extra, state: extra.ok === true ? "success" : "failed" })
      }
      return rows
    }

    function BatchPanel(props) {
      var job = props.job
      var rows = batchRows(job)
      var terminal = isTerminalStatus(job && job.status)
      var ok = 0
      var failed = 0
      var pending = 0
      var list = []
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i]
        var state = row.state
        if (state === "pending" && terminal) state = "unknown"
        if (state === "success") ok += 1
        else if (state === "failed") failed += 1
        else if (state === "pending") pending += 1
        var errorText = row.item && row.item.error ? String(row.item.error.message || "") : ""
        var hintText = row.item && row.item.error && row.item.error.hint ? String(row.item.error.hint) : ""
        list.push(
          h(
            "li",
            { key: row.name + ":" + i, className: "pdfw-batch-row pdfw-is-" + state },
            h("span", { className: "pdfw-batch-icon" }, h(Icon, { name: state === "success" ? "check" : state === "failed" ? "alert" : "file", size: 14 })),
            h(
              "span",
              { className: "pdfw-batch-meta" },
              h("span", { className: "pdfw-batch-name", title: row.name }, row.name),
              errorText ? h("span", { className: "pdfw-batch-error" }, errorText) : null,
              hintText ? h("span", { className: "pdfw-batch-hint" }, hintText) : null
            ),
            h(Badge, { tone: state === "success" ? "success" : state === "failed" ? "danger" : state === "pending" ? "accent" : "muted" }, stateCopy(state)),
            state === "failed"
              ? h(
                  Btn,
                  {
                    variant: "subtle",
                    icon: "retry",
                    disabled: props.disabled === true,
                    onClick: function (name) {
                      return function () {
                        props.onRetry(name)
                      }
                    }(row.name),
                  },
                  t("result.batchRetry")
                )
              : null
          )
        )
      }
      return h(
        "section",
        { className: "pdfw-card pdfw-batch" },
        h(SectionHead, { step: "•", title: t("result.batchTitle"), extra: h(Badge, { tone: "muted" }, t("result.batchProgress", { n: progressPercent(job && job.progress) })) }),
        h(ProgressBar, { percent: progressPercent(job && job.progress), label: t("result.batchTitle") }),
        h("p", { className: "pdfw-batch-summary" }, t("result.batchSummary", { ok: ok, failed: failed, pending: pending })),
        h("ul", { className: "pdfw-batch-list" }, list)
      )
    }

    function stateCopy(state) {
      if (state === "success") return t("result.stateSuccess")
      if (state === "failed") return t("result.stateFailed")
      if (state === "pending") return t("result.statePending")
      return t("result.stateUnknown")
    }

    /* ==================================================================== */
    /* 19. AI chat                                                          */
    /* ==================================================================== */

    function ChatBubble(props) {
      var ai = props.role === "assistant"
      return h(
        "div",
        { className: cx("pdfw-bubble", ai ? "pdfw-bubble--ai" : "pdfw-bubble--user") },
        h("div", { className: "pdfw-bubble-head" }, ai ? t("result.chatAI") : t("result.chatYou")),
        ai ? h("div", { className: "pdfw-bubble-text pdfw-md" }, mdBlocks(props.content)) : h("pre", { className: "pdfw-bubble-text" }, props.content)
      )
    }

    function ChatPane(props) {
      var messages = Array.isArray(props.messages) ? props.messages : EMPTY_ARRAY
      var logRef = useRef(null)
      var question = props.question || ""
      var busy = props.busy === true

      useEffect(
        function () {
          var node = logRef.current
          if (node) node.scrollTop = node.scrollHeight
        },
        [messages.length, busy]
      )

      var bubbles = []
      for (var i = 0; i < messages.length; i += 1) {
        bubbles.push(h(ChatBubble, { key: i, role: messages[i].role, content: messages[i].content }))
      }
      if (busy) bubbles.push(h("div", { key: "thinking", className: "pdfw-bubble pdfw-bubble--ai pdfw-is-thinking" }, h(Spinner, { size: 13 }), h("span", null, t("result.chatThinking"))))

      return h(
        "section",
        { className: "pdfw-card pdfw-chat" },
        h(SectionHead, { step: "•", title: t("result.chatTitle") }),
        h("div", { className: "pdfw-chat-log", ref: logRef, role: "log", "aria-live": "polite" }, bubbles.length ? bubbles : h("p", { className: "pdfw-muted" }, t("result.chatEmpty"))),
        h(
          "div",
          { className: "pdfw-chat-composer" },
          h("textarea", {
            className: "pdfw-textarea",
            rows: 2,
            value: question,
            placeholder: t("result.chatPlaceholder"),
            disabled: busy,
            "aria-label": t("result.chatLabel"),
            onChange: function (event) {
              props.onQuestionChange(event.target.value)
            },
            onKeyDown: function (event) {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                props.onSend()
              }
            },
          }),
          h(
            Btn,
            {
              variant: "primary",
              icon: "send",
              disabled: busy || !String(question).trim(),
              onClick: function () {
                props.onSend()
              },
            },
            t("result.chatSend")
          )
        )
      )
    }

    /* ==================================================================== */
    /* 20. result pane (right column)                                       */
    /* ==================================================================== */

    function ResultPane(props) {
      var op = props.op
      var ws = props.ws
      var job = ws.job
      var outputs = job && Array.isArray(job.outputs) ? job.outputs : EMPTY_ARRAY
      var inputs = job && Array.isArray(job.inputs) ? job.inputs : EMPTY_ARRAY
      var items = job && Array.isArray(job.items) ? job.items : EMPTY_ARRAY
      var status = job ? String(job.status || "") : ws.busy ? "running" : ""
      var isBatch =
        Boolean(op && (op.multiple === true || op.batch === true)) ||
        Boolean(job && (inputs.length > 1 || items.length > 1))
      var text = job && typeof job.text === "string" ? job.text : ""
      var copyState = useCopyFeedback()
      var copied = copyState[0]
      var copy = copyState[1]
      var zip = null
      for (var z = 0; z < outputs.length; z += 1) {
        if (String(outputs[z].kind || "").toLowerCase() === "zip") {
          zip = outputs[z]
          break
        }
      }

      var outputRows = []
      // Rendering 100 preview images (PDF→images) or dozens of live PDF previews
      // would spawn one engine process each; only the first result previews inline.
      for (var i = 0; i < outputs.length; i += 1) outputRows.push(h(OutputRow, { key: outputs[i].id || i, output: outputs[i], jobId: job.id || ws.jobId, inline: i === 0 }))

      var body = []
      if (ws.error && (!job || job.status !== "failed")) {
        body.push(
          h(ErrorStrip, {
            key: "err",
            error: ws.error,
            onRetry: isValidationError(ws.error) ? undefined : ws.reprocess,
            onDismiss: ws.clearError,
          })
        )
      }
      if (job && job.status === "failed") {
        var jobError = job.error && job.error.message ? makeError(job.error.code, job.error.message, job.error.hint) : makeError("JOB_FAILED", t("error.jobFailed"), t("error.hintRetry"))
        body.push(h(ErrorStrip, { key: "joberr", error: jobError, onRetry: ws.reprocess }))
      }
      if (job && Array.isArray(job.warnings) && job.warnings.length) {
        body.push(
          h(
            "section",
            { key: "warnings", className: "pdfw-card pdfw-warnings", role: "status" },
            h("p", { className: "pdfw-warn-title" }, t("result.warningsTitle")),
            h(
              "ul",
              { className: "pdfw-warning-list" },
              job.warnings.map(function (text, index) {
                return h("li", { key: index }, String(text))
              })
            )
          )
        )
      }
      if (isBatch && job) body.push(h(BatchPanel, { key: "batch", job: job, disabled: ws.busy, onRetry: ws.retryFile }))
      if (outputRows.length) {
        body.push(
          h(
            "div",
            { key: "outs", className: "pdfw-outputs" },
            h("p", { className: "pdfw-outputs-title" }, t("result.outputs")),
            outputRows
          )
        )
      }
      if (text && op && op.chat !== true) {
        body.push(
          h(
            "section",
            { key: "text", className: "pdfw-card pdfw-text-card" },
            h(
              SectionHead,
              {
                step: "•",
                title: t("result.textTitle"),
                extra: h(
                  Btn,
                  {
                    variant: "ghost",
                    icon: "copy",
                    onClick: function () {
                      copy(text)
                    },
                  },
                  copied === "copied" ? t("common.copied") : copied === "failed" ? t("common.copyFailed") : t("result.copyText")
                ),
              }
            ),
            String(text).indexOf("\n") >= 0 ? h(Markdown, { text: text }) : h("pre", { className: "pdfw-pre" }, text)
          )
        )
      }
      if (op && op.chat === true) {
        body.push(
          h(ChatPane, {
            key: "chat",
            messages: ws.messages,
            question: ws.question,
            busy: ws.busy,
            onQuestionChange: ws.setQuestion,
            onSend: function () {
              ws.ask(ws.question)
            },
          })
        )
      }
      if (!body.length) {
        body.push(
          h(EmptyState, {
            key: "empty",
            icon: "image",
            title: ws.busy ? t("result.running") : t("result.empty"),
            desc: ws.busy ? t("result.previewLoading") : t("result.emptyHint"),
          })
        )
      }

      var actions = []
      if (outputs.length > 1 || zip) {
        actions.push(
          h(
            Btn,
            {
              variant: "subtle",
              icon: "download",
              title: isBatch ? t("result.downloadAllHint") : t("common.downloadAll"),
              onClick: function () {
                if (zip) {
                  triggerDownload(job.id || ws.jobId, zip)
                  return
                }
                for (var index = 0; index < outputs.length; index += 1) {
                  (function (output, delay) {
                    setTimeout(function () {
                      triggerDownload(job.id || ws.jobId, output)
                    }, delay)
                  })(outputs[index], index * 220)
                }
              },
            },
            t("common.downloadAll")
          )
        )
      }
      if (job) {
        actions.push(
          h(
            Btn,
            {
              variant: "ghost",
              icon: "retry",
              title: t("result.reprocessHint"),
              disabled: ws.busy,
              onClick: function () {
                ws.reprocess()
              },
            },
            t("action.reprocess")
          )
        )
      }

      return h(
        "div",
        { className: "pdfw-results" },
        h(
          "div",
          { className: "pdfw-pane-head" },
          h("h2", { className: "pdfw-pane-title" }, h("span", { className: "pdfw-step" }, "5"), t("result.title")),
          status ? h(StatusBadge, { status: status }) : null,
          ws.busy ? h(Spinner, { size: 13 }) : null,
          h("div", { className: "pdfw-pane-actions" }, actions)
        ),
        body,
        h(NotesPanel, { limits: props.limits, info: props.info, op: op })
      )
    }

    /* ==================================================================== */
    /* 21. workspace state machine                                          */
    /* ==================================================================== */

    function createSession(op) {
      return {
        opId: op ? op.id : null,
        files: [],
        values: defaultsFor(op && op.fields),
        error: null,
        job: null,
        jobId: null,
        busy: false,
        stage: null,
        messages: [],
        question: "",
        sourceIds: [],
      }
    }

    /**
     * All per-tool state (files, params, job, chat). The session resets itself
     * when the active tool changes — rendered during the same pass (React lets a
     * component adjust its own state during render), so a switch never flashes
     * the previous tool's files or results.
     */
    function useWorkspace(op, limits, info) {
      var opId = op ? op.id : null
      var state = useState(function () {
        return createSession(op)
      })
      var session = state[0]
      var setSession = state[1]
      var current = session
      if (current.opId !== opId) {
        current = createSession(op)
        setSession(current)
      }

      var runRef = useRef({ controller: null, timer: null })
      var mountedRef = useRef(true)
      var infoRef = useRef(info)
      infoRef.current = info
      var limitsRef = useRef(limits)
      limitsRef.current = limits

      useEffect(
        function () {
          mountedRef.current = true
          return function () {
            mountedRef.current = false
            abortRun()
          }
        },
        [opId]
      )

      function update(mutate) {
        if (!mountedRef.current) return
        setSession(function (previous) {
          var partial = typeof mutate === "function" ? mutate(previous) : mutate
          return Object.assign({}, previous, partial || EMPTY_OBJECT)
        })
      }

      function abortRun() {
        var run = runRef.current
        if (run.timer) {
          clearTimeout(run.timer)
          run.timer = null
        }
        if (run.controller) {
          try {
            run.controller.abort()
          } catch (error) {
            /* ignore */
          }
          run.controller = null
        }
      }

      function fail(code, message, hint) {
        update(function () {
          return { error: makeError(code, message, hint) }
        })
      }

      function clearError() {
        update(function () {
          return { error: null }
        })
      }

      function addFiles(list) {
        if (!op || !list || !list.length) return
        var multiple = op.multiple === true
        update(function (previous) {
          var existing = multiple ? previous.files : EMPTY_ARRAY
          var incoming = []
          for (var i = 0; i < list.length; i += 1) {
            var raw = list[i]
            if (!raw) continue
            incoming.push({ name: raw.name || "file-" + (i + 1), size: Number(raw.size) || 0, file: raw })
          }
          var result = validateFiles(limitsRef.current, existing, incoming)
          var error = uploadRejectError(result)
          if (!multiple) {
            var kept = []
            if (result.accepted.length) {
              kept.push({ id: nextFileId(), name: result.accepted[0].name, size: result.accepted[0].size, file: result.accepted[0].file })
            }
            if (incoming.length > 1 && !error) error = makeError("VALIDATION_FILES", t("upload.err.singleOnly"), "")
            return { files: kept, error: error, sourceIds: [] }
          }
          var nextFiles = previous.files.slice()
          for (var j = 0; j < result.accepted.length; j += 1) {
            nextFiles.push({ id: nextFileId(), name: result.accepted[j].name, size: result.accepted[j].size, file: result.accepted[j].file })
          }
          return { files: nextFiles, error: error, sourceIds: [] }
        })
      }

      function removeFile(id) {
        update(function (previous) {
          var next = []
          for (var i = 0; i < previous.files.length; i += 1) {
            if (previous.files[i].id !== id) next.push(previous.files[i])
          }
          return { files: next, sourceIds: [] }
        })
      }

      function moveFile(from, to) {
        update(function (previous) {
          var files = previous.files.slice()
          if (from < 0 || from >= files.length || to < 0 || to >= files.length || from === to) return { files: files }
          var moved = files.splice(from, 1)[0]
          files.splice(to, 0, moved)
          return { files: files, sourceIds: [] }
        })
      }

      function setFieldValue(key, value) {
        update(function (previous) {
          var next = {}
          for (var existing in previous.values) next[existing] = previous.values[existing]
          next[key] = value
          return { values: next }
        })
      }

      function resetParams() {
        update(function () {
          return { values: defaultsFor(op && op.fields), error: null }
        })
      }

      function setQuestion(value) {
        update(function () {
          return { question: value == null ? "" : String(value) }
        })
      }

      /** Same as `update`, but a no-op once the session's tool has changed. */
      function updateFor(expectedOpId, mutate) {
        if (!mountedRef.current) return
        setSession(function (previous) {
          if (previous.opId !== expectedOpId) return previous
          var partial = typeof mutate === "function" ? mutate(previous) : mutate
          return Object.assign({}, previous, partial || EMPTY_OBJECT)
        })
      }

      function pollJob(jobId, controller, runOpId) {
        return new Promise(function (resolve, reject) {
          var delay = POLL_BASE_MS
          var stopped = false
          function settle(error, value) {
            if (stopped) return
            stopped = true
            if (runRef.current.timer) {
              clearTimeout(runRef.current.timer)
              runRef.current.timer = null
            }
            if (error) reject(error)
            else resolve(value)
          }
          if (controller.signal) {
            if (controller.signal.aborted) {
              settle(makeError("ABORTED", t("error.hintCancelled"), t("error.hintCancelled")))
              return
            }
            controller.signal.addEventListener("abort", function () {
              settle(makeError("ABORTED", t("error.hintCancelled"), t("error.hintCancelled")))
            })
          }
          function tick() {
            if (stopped) return
            runRef.current.timer = null
            apiGet(ENDPOINTS.job(jobId), controller.signal)
              .then(function (snapshot) {
                if (stopped) return
                if (!snapshot || typeof snapshot !== "object") throw makeError("BAD_RESPONSE", t("error.badResponse"), t("error.hintRetry"))
                updateFor(runOpId, function () {
                  return { job: snapshot }
                })
                if (isTerminalStatus(snapshot.status)) {
                  settle(null, snapshot)
                  return
                }
                delay = nextDelay(delay)
                runRef.current.timer = setTimeout(tick, delay)
              })
              .catch(function (error) {
                if (stopped) return
                if (isAbortError(error)) settle(error)
                else settle(error)
              })
          }
          runRef.current.timer = setTimeout(tick, delay)
        })
      }

      function finish(snapshot, runOpId) {
        var status = String(snapshot.status || "")
        updateFor(runOpId, function (previous) {
          var patch = {
            busy: false,
            stage: null,
            job: snapshot,
            jobId: snapshot.id ? String(snapshot.id) : previous.jobId,
          }
          if (status === "done") {
            patch.error = null
            var answer = op && op.chat === true && typeof snapshot.text === "string" ? snapshot.text : ""
            if (answer) patch.messages = previous.messages.concat([{ role: "assistant", content: answer }])
          } else if (status === "failed") {
            var detail = snapshot.error
            patch.error =
              detail && detail.message
                ? makeError(detail.code || "JOB_FAILED", detail.message, detail.hint || t("error.hintRetry"))
                : makeError("JOB_FAILED", t("error.jobFailed"), t("error.hintRetry"))
          } else if (status === "cancelled") {
            patch.error = makeError("CANCELLED", t("progress.cancelled"), t("error.hintCancelled"))
          }
          return patch
        })
      }

      function run(fileList, questionOverride, historyOverride, options) {
        if (!op || current.busy) return
        var files = Array.isArray(fileList) ? fileList : current.files
        var allFields = Array.isArray(op.fields) ? op.fields : EMPTY_ARRAY
        var skipKeys = op.chat === true ? ["question"] : EMPTY_ARRAY
        var issues = validateValues(allFields, current.values, { skipKeys: skipKeys })
        var gap = capabilityGap(op, infoRef.current)
        var ask =
          op.chat === true
            ? String(questionOverride !== undefined && questionOverride !== null ? questionOverride : current.question || current.values.question || "").trim()
            : ""
        if (!files.length) {
          fail("VALIDATION", op.multiple === true ? t("action.needFiles") : t("action.needFilesOne"), op.multiple === true ? t("action.needFilesHint") : t("action.needFilesOneHint"))
          return
        }
        if (issues.length) {
          fail("VALIDATION", issueMessage(issues[0], allFields), t("action.invalidParamsHint"))
          return
        }
        if (op.chat === true && !ask) {
          fail("VALIDATION", t("action.needQuestion"), t("action.needQuestionHint"))
          return
        }
        if (gap) {
          fail("CAPABILITY", t("cap." + gap + "Unavailable"), t("cap." + gap + "UnavailableHint"))
          return
        }
        if (typeof AbortController !== "function" || typeof FormData !== "function") {
          fail("UNSUPPORTED", t("error.unknown"), t("error.hintRetry"))
          return
        }

        abortRun()
        var runOpId = opId
        var controller = new AbortController()
        runRef.current.controller = controller
        var params = buildParams(allFields, current.values)
        if (op.chat === true) {
          var history = Array.isArray(historyOverride) ? historyOverride : current.messages
          var carried = []
          for (var m = 0; m < history.length; m += 1) {
            var message = history[m]
            if (message && (message.role === "user" || message.role === "assistant") && typeof message.content === "string") {
              carried.push({ role: message.role, content: message.content })
            }
          }
          params.question = ask
          params.history = carried
        }
        var reuse = reuseSourceIds(op, current.sourceIds, options && options.forceUpload)
        var form = new FormData()
        form.append("op", op.id)
        if (op.engine) form.append("engine", op.engine)
        form.append("params", JSON.stringify(params))
        if (reuse) {
          // Follow-up chat turn: the Host reuses the first upload, nothing is re-sent.
          form.append("sourceIds", encodeSourceIds(current.sourceIds))
        } else {
          for (var f = 0; f < files.length; f += 1) {
            try {
              form.append("file", files[f].file, files[f].name)
            } catch (error) {
              form.append("file", files[f].file)
            }
          }
        }

        update(function (previous) {
          var patch = { busy: true, error: null, job: null, jobId: null, stage: "uploading", question: "" }
          if (op.chat === true) patch.messages = previous.messages.concat([{ role: "user", content: ask }])
          return patch
        })

        apiPostForm(ENDPOINTS.jobs, form, controller.signal)
          .then(function (created) {
            var jobId = created && created.jobId ? String(created.jobId) : ""
            if (!jobId) throw makeError("BAD_RESPONSE", t("error.badResponse"), t("error.hintRetry"))
            updateFor(runOpId, function () {
              return {
                stage: "processing",
                jobId: jobId,
                sourceIds: created && Array.isArray(created.sourceIds) ? created.sourceIds.map(String) : [],
              }
            })
            return pollJob(jobId, controller, runOpId)
          })
          .then(function (snapshot) {
            if (!snapshot) return
            finish(snapshot, runOpId)
          })
          .catch(function (error) {
            if (isAbortError(error)) {
              updateFor(runOpId, function () {
                return { busy: false, stage: null }
              })
              return
            }
            var uiError = transportError(error)
            var lostUpload = uiError.code === "SOURCE_GONE" || uiError.code === "BAD_SOURCES"
            updateFor(runOpId, function () {
              var patch = { busy: false, stage: null, error: uiError }
              // A stale reusable upload cannot be retried — drop the ids so the
              // next attempt posts the files again.
              if (lostUpload) patch.sourceIds = []
              return patch
            })
          })
      }

      function start() {
        run(current.files, null)
      }

      function ask(question) {
        run(current.files, question)
      }

      function cancel() {
        var jobId = current.jobId
        abortRun()
        update(function () {
          return { busy: false, stage: null, error: makeError("CANCELLED", t("progress.cancelled"), t("error.hintCancelled")) }
        })
        if (jobId) {
          apiDelete(ENDPOINTS.cancel(jobId)).catch(function () {
            /* the abort above already released the UI */
          })
        }
      }

      function reprocess() {
        if (!op) return
        if (op.chat === true) {
          var messages = current.messages
          for (var i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i].role === "user") {
              run(current.files, messages[i].content, messages.slice(0, i), { forceUpload: true })
              return
            }
          }
          run(current.files, null, [], { forceUpload: true })
          return
        }
        run(current.files, null, undefined, { forceUpload: true })
      }

      function retryFile(name) {
        var entry = null
        for (var i = 0; i < current.files.length; i += 1) {
          if (current.files[i].name === name) {
            entry = current.files[i]
            break
          }
        }
        if (!entry) {
          fail("VALIDATION", t("result.fileGone"), t("result.fileGoneHint"))
          return
        }
        run([entry], null, undefined, { forceUpload: true })
      }

      return {
        opId: opId,
        files: current.files,
        values: current.values,
        error: current.error,
        job: current.job,
        jobId: current.jobId,
        busy: current.busy,
        stage: current.stage,
        messages: current.messages,
        question: current.question,
        addFiles: addFiles,
        removeFile: removeFile,
        moveFile: moveFile,
        setFieldValue: setFieldValue,
        resetParams: resetParams,
        setQuestion: setQuestion,
        start: start,
        ask: ask,
        cancel: cancel,
        reprocess: reprocess,
        retryFile: retryFile,
        clearError: clearError,
      }
    }

    /* ==================================================================== */
    /* 22. loading skeleton                                                 */
    /* ==================================================================== */

    function LoadingSkeleton() {
      var cards = []
      for (var i = 0; i < 6; i += 1) cards.push(h("span", { key: i, className: "pdfw-skeleton-card" }))
      return h(
        "div",
        { className: "pdfw-skeleton", role: "status", "aria-label": t("common.loading") },
        h("span", { className: "pdfw-skeleton-line pdfw-skeleton-line--title" }),
        h("span", { className: "pdfw-skeleton-line" }),
        h("div", { className: "pdfw-skeleton-grid" }, cards)
      )
    }

    /* ==================================================================== */
    /* 23. Workbench root                                                   */
    /* ==================================================================== */

    function Workbench(props) {
      useLocaleTick()

      var catalogState = useState(null)
      var catalog = catalogState[0]
      var setCatalog = catalogState[1]
      var infoState = useState(null)
      var info = infoState[0]
      var setInfo = infoState[1]
      var bootState = useState({ loading: true, error: null })
      var boot = bootState[0]
      var setBoot = bootState[1]
      var reloadState = useState(0)
      var reloadToken = reloadState[0]
      var reload = reloadState[1]
      var opState = useState(null)
      var opId = opState[0]
      var setOpId = opState[1]
      var queryState = useState("")
      var query = queryState[0]
      var setQuery = queryState[1]
      var leftState = useState(false)
      var leftCollapsed = leftState[0]
      var setLeftCollapsed = leftState[1]
      var rightState = useState(false)
      var rightCollapsed = rightState[0]
      var setRightCollapsed = rightState[1]

      useEffect(
        function () {
          var cancelled = false
          var controller = null
          try {
            controller = new AbortController()
          } catch (error) {
            controller = null
          }
          setBoot({ loading: true, error: null })
          Promise.all([
            apiGet(ENDPOINTS.catalog, controller ? controller.signal : undefined),
            apiGet(ENDPOINTS.info, controller ? controller.signal : undefined).catch(function (error) {
              if (isAbortError(error)) throw error
              return null
            }),
          ])
            .then(function (values) {
              if (cancelled) return
              setCatalog(values[0] || null)
              setInfo(values[1] || null)
              setBoot({ loading: false, error: null })
            })
            .catch(function (error) {
              if (cancelled || isAbortError(error)) return
              setBoot({ loading: false, error: transportError(error) })
            })
          return function () {
            cancelled = true
            if (controller) controller.abort()
          }
        },
        [reloadToken]
      )

      var operations = catalog && Array.isArray(catalog.operations) ? catalog.operations : EMPTY_ARRAY
      var byId = {}
      for (var i = 0; i < operations.length; i += 1) {
        if (operations[i] && operations[i].id) byId[operations[i].id] = operations[i]
      }
      var activeOp = opId ? byId[opId] || null : null
      var nav = buildNavigation(catalog)
      var limits = normalizeLimits(catalog && catalog.limits ? catalog.limits : info && info.limits ? info.limits : null)
      var ws = useWorkspace(activeOp, limits, info)

      /** Switching tools rebuilds the workspace, so a running job must not be
       *  discarded by a stray click: navigation is disabled while busy. */
      function openOp(id) {
        if (ws && ws.busy) return
        setOpId(id)
      }

      function goHome() {
        if (ws && ws.busy) return
        setOpId(null)
      }

      function retryBoot() {
        reload(function (n) {
          return n + 1
        })
      }

      var center
      if (boot.error) {
        center = h(
          "div",
          { className: "pdfw-center-inner" },
          h(ErrorStrip, { error: boot.error, onRetry: retryBoot }),
          h("p", { className: "pdfw-muted" }, t("error.hintRetry"))
        )
      } else if (boot.loading && !catalog) {
        center = h(LoadingSkeleton)
      } else if (activeOp) {
        center = h(WorkspaceView, { op: activeOp, ws: ws, limits: limits, info: info })
      } else {
        center = h(HomeView, { nav: nav, query: query, onQueryChange: setQuery, onOpen: openOp, busy: ws.busy === true })
      }

      var left
      if (leftCollapsed) {
        left = h(
          "div",
          { className: "pdfw-rail" },
          h(IconBtn, { icon: "panelLeft", label: t("nav.expand"), size: 17, onClick: function () { setLeftCollapsed(false) } }),
          h(IconBtn, { icon: "file", label: t("app.title"), size: 17, onClick: goHome }),
          activeOp ? h(IconBtn, { icon: "home", label: t("nav.backHome"), size: 17, onClick: goHome }) : null
        )
      } else {
        left = [
          h(
            "div",
            { key: "brand", className: "pdfw-brand-row" },
            h("span", { className: "pdfw-brand-icon" }, h(Icon, { name: "file", size: 18 })),
            h(
              "span",
              { className: "pdfw-brand-copy" },
              h("span", { className: "pdfw-brand-title" }, t("app.title")),
              h("span", { className: "pdfw-brand-sub" }, t("app.short") + " · " + CLIENT_BUILD)
            ),
            h(IconBtn, { icon: "panelLeft", label: t("nav.collapse"), size: 16, onClick: function () { setLeftCollapsed(true) } })
          ),
          h(
            "div",
            { key: "tools", className: "pdfw-left-tools" },
            h(
              Btn,
              {
                variant: "ghost",
                icon: "home",
                block: true,
                onClick: goHome,
                disabled: activeOp === null,
                title: t("nav.backHome"),
              },
              t("nav.backHome")
            )
          ),
          h(SearchBox, {
            key: "search",
            value: query,
            onChange: setQuery,
            placeholder: t("nav.searchPlaceholder"),
            ariaLabel: t("nav.search"),
          }),
          catalog
            ? h(LeftNav, { key: "nav", nav: nav, query: query, activeOpId: opId, onOpen: openOp, busy: ws.busy === true })
            : h("p", { key: "nav-loading", className: "pdfw-muted pdfw-nav-empty" }, boot.error ? t("error.title") : t("common.loading"))
        ]
      }

      var right
      if (rightCollapsed) {
        right = h(
          "div",
          { className: "pdfw-rail" },
          h(IconBtn, { icon: "panelRight", label: t("nav.rightExpand"), size: 17, onClick: function () { setRightCollapsed(false) } }),
          activeOp ? h(IconBtn, { icon: "download", label: t("result.title"), size: 17, onClick: function () { setRightCollapsed(false) } }) : null
        )
      } else {
        right = [
          h(
            "div",
            { key: "head", className: "pdfw-right-head" },
            h("span", { className: "pdfw-right-title" }, activeOp ? t("result.title") : t("notes.title")),
            h(IconBtn, { icon: "panelRight", label: t("nav.rightCollapse"), size: 16, onClick: function () { setRightCollapsed(true) } })
          ),
          activeOp
            ? h(ResultPane, { key: "results", op: activeOp, ws: ws, limits: limits, info: info })
            : h(NotesPanel, { key: "notes", limits: limits, info: info, op: null }),
        ]
      }

      return h(
        "div",
        { className: cx("pdfw-root", leftCollapsed ? "pdfw-is-left-collapsed" : "", rightCollapsed ? "pdfw-is-right-collapsed" : "") },
        h("style", { key: "css" }, CSS),
        h("aside", { key: "left", className: "pdfw-col pdfw-col--left" }, left),
        h("section", { key: "center", className: "pdfw-col pdfw-col--center" }, center),
        h("aside", { key: "right", className: "pdfw-col pdfw-col--right" }, right)
      )
    }

    /* ==================================================================== */
    /* 24. styles — every selector is scoped under .pdfw-                   */
    /* ==================================================================== */

    var CSS = `
.pdfw-root{--pdfw-accent:var(--dsh-plugin-workbench-accent,#b45309);--pdfw-accent-ink:#ffffff;--pdfw-accent-soft:color-mix(in srgb,var(--pdfw-accent) 12%,var(--dsw-alias-bg-base,#ffffff));--pdfw-ink:var(--dsw-alias-label-primary,#1b1b22);--pdfw-ink-2:var(--dsw-alias-label-secondary,#4a4a55);--pdfw-ink-3:var(--dsw-alias-label-tertiary,#70707c);--pdfw-bg:var(--dsw-alias-bg-base,#ffffff);--pdfw-layer:var(--dsw-alias-bg-layer-1,#f7f7f9);--pdfw-layer-2:var(--dsw-alias-bg-layer-2,#f0f0f4);--pdfw-layer-3:var(--dsw-alias-bg-layer-3,#e8e8ee);--pdfw-border:var(--dsw-alias-border-l1,#e3e3e9);--pdfw-border-2:var(--dsw-alias-border-l2,#d0d0d8);--pdfw-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));--pdfw-active:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.08));--pdfw-danger:var(--dsw-alias-state-error-primary,#c62828);--pdfw-success:var(--dsw-alias-state-success-primary,#2e7d32);--pdfw-warn:var(--dsw-alias-state-warn-primary,#b26a00);--pdfw-brand:var(--dsw-alias-brand-primary,var(--pdfw-accent));--pdfw-radius:10px;--pdfw-left:260px;--pdfw-right:380px;position:relative;display:grid;grid-template-columns:var(--pdfw-left) minmax(0,1fr) var(--pdfw-right);height:100%;min-height:480px;overflow:hidden;background:var(--pdfw-bg);color:var(--pdfw-ink);font-family:var(--dsh-font-family-text,var(--dsh-font-family-content,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif));font-size:13px;line-height:1.55;-webkit-font-smoothing:antialiased}
.pdfw-root *,.pdfw-root *::before,.pdfw-root *::after{box-sizing:border-box}
.pdfw-root>style{display:none}
.pdfw-md{display:grid;gap:8px;font-size:13px;line-height:1.7;overflow-wrap:anywhere}
.pdfw-md-h3{font-size:16px;font-weight:650;margin-top:4px}
.pdfw-md-h4{font-size:14px;font-weight:650;margin-top:4px}
.pdfw-md-h5,.pdfw-md-h6{font-size:13px;font-weight:650}
.pdfw-md-p{margin:0;white-space:pre-wrap}
.pdfw-md-list{margin:0;padding-inline-start:20px;display:grid;gap:4px}
.pdfw-md-table-wrap{overflow-x:auto;max-width:100%}
.pdfw-md-table{border-collapse:collapse;font-size:12px;min-width:100%}
.pdfw-md-table th,.pdfw-md-table td{border:1px solid var(--pdfw-border);padding:5px 8px;text-align:start;vertical-align:top}
.pdfw-md-table th{background:var(--pdfw-layer-2);font-weight:600}
.pdfw-md-code{font-size:12px}
.pdfw-warning-list{margin:0;padding-inline-start:18px;display:grid;gap:4px;font-size:12px;color:var(--pdfw-ink-2)}
.pdfw-warnings .pdfw-warn-title{font-weight:600;color:var(--pdfw-warn);margin-bottom:6px}
.pdfw-root button{font:inherit;color:inherit}
.pdfw-root :focus-visible{outline:2px solid var(--pdfw-brand);outline-offset:2px}
@media (max-width:1240px){.pdfw-root{--pdfw-left:228px;--pdfw-right:330px}}
@media (max-width:1020px){.pdfw-root{--pdfw-left:212px;--pdfw-right:300px}}
.pdfw-root.pdfw-is-left-collapsed{--pdfw-left:56px}
.pdfw-root.pdfw-is-right-collapsed{--pdfw-right:52px}
.pdfw-col{min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.pdfw-col--left{border-right:1px solid var(--pdfw-border);background:var(--pdfw-layer);padding:12px 10px 16px;gap:10px;overflow-y:auto}
.pdfw-col--center{background:var(--pdfw-bg);overflow-y:auto;padding:20px 22px 28px}
.pdfw-col--right{border-left:1px solid var(--pdfw-border);background:var(--pdfw-layer);padding:12px 12px 18px;gap:10px;overflow-y:auto}
.pdfw-rail{display:flex;flex-direction:column;align-items:center;gap:8px;padding:2px 0}
.pdfw-brand-row{display:flex;align-items:center;gap:9px;min-height:34px}
.pdfw-brand-icon{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px;background:var(--pdfw-accent);color:var(--pdfw-accent-ink);flex:none}
.pdfw-brand-copy{display:flex;flex-direction:column;min-width:0;flex:1 1 auto}
.pdfw-brand-title{font-weight:650;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pdfw-brand-sub{font-size:11px;color:var(--pdfw-ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pdfw-left-tools{display:flex;gap:6px}
.pdfw-search{position:relative;display:flex;align-items:center;gap:6px;background:var(--pdfw-bg);border:1px solid var(--pdfw-border-2);border-radius:9px;padding:0 8px;min-height:32px}
.pdfw-search--big{min-height:40px;padding:0 10px;border-radius:10px}
.pdfw-search:focus-within{border-color:var(--pdfw-brand);box-shadow:0 0 0 3px var(--pdfw-accent-soft)}
.pdfw-search-icon{color:var(--pdfw-ink-3);flex:none}
.pdfw-search-input{flex:1 1 auto;min-width:0;border:0;background:transparent;color:var(--pdfw-ink);font:inherit;padding:6px 0;outline:none}
.pdfw-search--big .pdfw-search-input{font-size:14px}
.pdfw-search-input::placeholder{color:var(--pdfw-ink-3)}
.pdfw-search-input::-webkit-search-cancel-button{display:none}
.pdfw-search-clear{width:22px;height:22px;min-width:22px}
.pdfw-nav{display:flex;flex-direction:column;gap:2px;min-height:0}
.pdfw-nav-empty{font-size:12px;padding:8px 4px}
.pdfw-nav-group{display:flex;flex-direction:column}
.pdfw-nav-group-head{display:flex;align-items:center;gap:7px;width:100%;border:0;background:transparent;color:var(--pdfw-ink);cursor:pointer;padding:6px 6px;border-radius:8px;text-align:left;font-size:12.5px;font-weight:600}
.pdfw-nav-group-head:hover{background:var(--pdfw-hover)}
.pdfw-nav-group-icon{color:var(--pdfw-ink-2)}
.pdfw-nav-group-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pdfw-nav-count{font-size:11px;color:var(--pdfw-ink-3);font-variant-numeric:tabular-nums;background:var(--pdfw-layer-2);border-radius:999px;padding:0 6px;line-height:18px}
.pdfw-nav-items{display:flex;flex-direction:column;padding:2px 0 6px 12px;border-left:1px solid var(--pdfw-border);margin-left:11px}
.pdfw-nav-section{display:flex;flex-direction:column}
.pdfw-nav-section-title{margin:6px 4px 2px;font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--pdfw-ink-3);font-weight:600}
.pdfw-nav-item{display:flex;align-items:center;gap:6px;width:100%;border:0;background:transparent;color:var(--pdfw-ink-2);cursor:pointer;padding:6px 8px;border-radius:7px;text-align:left;font-size:12.5px}
.pdfw-nav-item:hover{background:var(--pdfw-hover);color:var(--pdfw-ink)}
.pdfw-nav-item.pdfw-is-active{background:var(--pdfw-accent);color:var(--pdfw-accent-ink);font-weight:600}
.pdfw-nav-item-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pdfw-nav-tag{font-size:9.5px;line-height:15px;padding:0 5px;border-radius:999px;border:1px solid currentColor;opacity:.75;flex:none}
.pdfw-home{display:flex;flex-direction:column;gap:22px;max-width:1080px;margin:0 auto;width:100%}
.pdfw-home-head{display:flex;flex-direction:column;gap:10px}
.pdfw-home-title{margin:0;font-size:22px;line-height:1.3;font-weight:680;letter-spacing:-.01em}
.pdfw-home-desc{margin:0;color:var(--pdfw-ink-2);font-size:13px;max-width:60ch}
.pdfw-home-count{margin:0;font-size:12px;color:var(--pdfw-ink-3)}
.pdfw-home-group{display:flex;flex-direction:column;gap:8px}
.pdfw-home-group-head{display:flex;align-items:center;gap:8px}
.pdfw-home-group-icon{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;background:var(--pdfw-accent-soft);color:var(--pdfw-accent)}
.pdfw-home-group-title{margin:0;font-size:15px;font-weight:650}
.pdfw-home-group-desc{margin:0;color:var(--pdfw-ink-3);font-size:12px}
.pdfw-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(232px,1fr));gap:10px}
.pdfw-card{background:var(--pdfw-bg);border:1px solid var(--pdfw-border);border-radius:var(--pdfw-radius)}
.pdfw-opcard{display:flex;align-items:flex-start;gap:10px;text-align:left;padding:12px;cursor:pointer;transition:border-color .12s ease,background .12s ease,transform .12s ease}
.pdfw-opcard:hover{border-color:var(--pdfw-border-2);background:var(--pdfw-hover)}
.pdfw-opcard:active{transform:translateY(1px)}
.pdfw-opcard-icon{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:9px;background:var(--pdfw-accent-soft);color:var(--pdfw-accent);flex:none}
.pdfw-opcard-copy{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 auto}
.pdfw-opcard-title{font-size:13px;font-weight:640;color:var(--pdfw-ink)}
.pdfw-opcard-desc{font-size:11.5px;line-height:1.45;color:var(--pdfw-ink-3)}
.pdfw-opcard-tags{display:flex;flex-direction:column;gap:4px;align-items:flex-end;flex:none}
.pdfw-mark{background:var(--pdfw-accent-soft);color:inherit;border-radius:3px;padding:0 1px;font-weight:700}
.pdfw-badge{display:inline-flex;align-items:center;gap:3px;font-size:10.5px;line-height:17px;padding:0 6px;border-radius:999px;border:1px solid var(--pdfw-border-2);color:var(--pdfw-ink-2);background:var(--pdfw-layer-2);white-space:nowrap}
.pdfw-badge--muted{color:var(--pdfw-ink-3)}
.pdfw-badge--accent{background:var(--pdfw-accent);border-color:transparent;color:var(--pdfw-accent-ink);font-weight:600}
.pdfw-badge--success{background:transparent;border-color:var(--pdfw-success);color:var(--pdfw-success)}
.pdfw-badge--danger{background:transparent;border-color:var(--pdfw-danger);color:var(--pdfw-danger)}
.pdfw-status{font-weight:600}
.pdfw-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border-radius:8px;border:1px solid transparent;padding:7px 12px;font-size:12.5px;font-weight:560;cursor:pointer;white-space:nowrap;transition:background .12s ease,border-color .12s ease,color .12s ease;text-decoration:none}
.pdfw-btn--primary{background:var(--pdfw-accent);color:var(--pdfw-accent-ink);border-color:var(--pdfw-accent);font-weight:620}
.pdfw-btn--primary:hover:not(:disabled){filter:brightness(1.08)}
.pdfw-btn--ghost{background:transparent;border-color:var(--pdfw-border-2);color:var(--pdfw-ink-2)}
.pdfw-btn--ghost:hover:not(:disabled){background:var(--pdfw-hover);color:var(--pdfw-ink)}
.pdfw-btn--subtle{background:var(--pdfw-layer-2);border-color:transparent;color:var(--pdfw-ink-2)}
.pdfw-btn--subtle:hover:not(:disabled){background:var(--pdfw-layer-3);color:var(--pdfw-ink)}
.pdfw-btn--block{width:100%}
.pdfw-btn:disabled{opacity:.45;cursor:not-allowed}
.pdfw-btn-label{display:inline-block}
.pdfw-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:7px;border:1px solid transparent;background:transparent;color:var(--pdfw-ink-2);cursor:pointer;flex:none;transition:background .12s ease,color .12s ease}
.pdfw-iconbtn:hover:not(:disabled){background:var(--pdfw-hover);color:var(--pdfw-ink)}
.pdfw-iconbtn:disabled{opacity:.35;cursor:not-allowed}
.pdfw-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:36px 18px;text-align:center;border:1px dashed var(--pdfw-border-2);border-radius:var(--pdfw-radius);background:var(--pdfw-layer)}
.pdfw-empty-icon{color:var(--pdfw-ink-3)}
.pdfw-empty-title{margin:0;font-weight:620;font-size:13.5px}
.pdfw-empty-desc{margin:0;color:var(--pdfw-ink-3);font-size:12px;max-width:46ch}
.pdfw-center-inner{display:flex;flex-direction:column;gap:10px;max-width:760px;margin:0 auto}
.pdfw-muted{margin:0;color:var(--pdfw-ink-3);font-size:12px}
.pdfw-skeleton{display:flex;flex-direction:column;gap:10px;animation:pdfw-pulse 1.4s ease-in-out infinite}
.pdfw-skeleton-line{display:block;height:12px;border-radius:6px;background:var(--pdfw-layer-2);width:100%}
.pdfw-skeleton-line--title{height:22px;width:38%}
.pdfw-skeleton-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(232px,1fr));gap:10px}
.pdfw-skeleton-card{display:block;height:84px;border-radius:var(--pdfw-radius);background:var(--pdfw-layer-2)}
.pdfw-workspace{display:flex;flex-direction:column;gap:14px;max-width:880px;margin:0 auto;width:100%}
.pdfw-workspace-head{display:flex;align-items:flex-start;gap:11px}
.pdfw-workspace-icon{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:10px;background:var(--pdfw-accent);color:var(--pdfw-accent-ink);flex:none}
.pdfw-workspace-copy{flex:1 1 auto;min-width:0}
.pdfw-workspace-title{margin:0;font-size:18px;font-weight:680;line-height:1.35}
.pdfw-workspace-desc{margin:2px 0 0;color:var(--pdfw-ink-2);font-size:12.5px}
.pdfw-workspace-badges{display:flex;flex-direction:column;gap:4px;align-items:flex-end;flex:none}
.pdfw-warn{display:flex;gap:9px;align-items:flex-start;padding:10px 12px;border-radius:9px;border:1px solid var(--pdfw-warn);background:transparent;color:var(--pdfw-warn)}
.pdfw-warn-title{margin:0;font-weight:620;font-size:12.5px}
.pdfw-warn-hint{margin:2px 0 0;font-size:11.5px;opacity:.85}
.pdfw-warn-text{margin:0;font-size:11.5px;color:var(--pdfw-warn)}
.pdfw-card.pdfw-upload,.pdfw-card.pdfw-params,.pdfw-card.pdfw-run,.pdfw-card.pdfw-progress-panel,.pdfw-card.pdfw-batch,.pdfw-card.pdfw-chat,.pdfw-card.pdfw-text-card{padding:14px}
.pdfw-section-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.pdfw-step{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 5px;border-radius:6px;background:var(--pdfw-accent-soft);color:var(--pdfw-accent);font-size:11px;font-weight:700;flex:none}
.pdfw-section-title{margin:0;font-size:13.5px;font-weight:650;flex:1 1 auto}
.pdfw-section-extra{display:flex;align-items:center;gap:6px;flex:none}
.pdfw-section-desc{margin:-4px 0 10px;font-size:12px;color:var(--pdfw-ink-3)}
.pdfw-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:24px 16px;border:1.5px dashed var(--pdfw-border-2);border-radius:var(--pdfw-radius);background:var(--pdfw-layer);cursor:pointer;text-align:center;transition:border-color .12s ease,background .12s ease}
.pdfw-drop:hover{border-color:var(--pdfw-accent);background:var(--pdfw-accent-soft)}
.pdfw-drop.pdfw-is-dragging{border-color:var(--pdfw-accent);background:var(--pdfw-accent-soft);border-style:solid}
.pdfw-drop.pdfw-is-disabled{opacity:.6;cursor:not-allowed}
.pdfw-drop-icon{color:var(--pdfw-accent)}
.pdfw-drop-title{margin:0;font-size:13.5px;font-weight:620}
.pdfw-drop-hint{margin:0;font-size:11.5px;color:var(--pdfw-ink-3)}
.pdfw-drop-formats{margin:2px 0 0;font-size:11px;color:var(--pdfw-ink-3);max-width:100%;word-break:break-word}
.pdfw-hidden-input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.pdfw-files{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.pdfw-files-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11.5px;color:var(--pdfw-ink-3)}
.pdfw-files-hint{color:var(--pdfw-ink-3);font-style:italic}
.pdfw-file-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.pdfw-file{display:flex;align-items:center;gap:8px;padding:7px 9px;border:1px solid var(--pdfw-border);border-radius:8px;background:var(--pdfw-bg)}
.pdfw-file.pdfw-is-dragging{opacity:.55}
.pdfw-file.pdfw-is-over{border-color:var(--pdfw-accent);box-shadow:0 0 0 2px var(--pdfw-accent-soft)}
.pdfw-file-grip{color:var(--pdfw-ink-3);cursor:grab;display:inline-flex;flex:none}
.pdfw-file-index{font-size:11px;color:var(--pdfw-ink-3);font-variant-numeric:tabular-nums;min-width:14px;text-align:right;flex:none}
.pdfw-file-icon{color:var(--pdfw-ink-2);display:inline-flex;flex:none}
.pdfw-file-meta{display:flex;flex-direction:column;min-width:0;flex:1 1 auto;gap:1px}
.pdfw-file-name{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--pdfw-ink)}
.pdfw-file-size{font-size:11px;color:var(--pdfw-ink-3)}
.pdfw-file-order{display:flex;gap:2px;flex:none}
.pdfw-file-remove{color:var(--pdfw-ink-3)}
.pdfw-file-remove:hover:not(:disabled){color:var(--pdfw-danger);background:transparent}
.pdfw-upload-empty{margin:10px 0 0}
.pdfw-fields{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;align-items:start}
.pdfw-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.pdfw-field--wide{grid-column:1/-1}
.pdfw-field-head{display:flex;flex-direction:column;gap:1px}
.pdfw-field--inline{grid-column:1/-1;flex-direction:row;align-items:center;justify-content:space-between;gap:12px;border:1px solid var(--pdfw-border);border-radius:9px;padding:8px 10px;background:var(--pdfw-layer)}
.pdfw-field--inline .pdfw-field-head{order:1;flex:1 1 auto}
.pdfw-field--inline .pdfw-field-control{order:2;flex:none}
.pdfw-field-label{font-size:12px;font-weight:580;color:var(--pdfw-ink);display:flex;gap:3px;align-items:baseline}
.pdfw-req{color:var(--pdfw-danger);font-weight:700}
.pdfw-field-help{font-size:11px;color:var(--pdfw-ink-3);line-height:1.4}
.pdfw-field-control{display:flex;min-width:0}
.pdfw-field-control>*{flex:1 1 auto;min-width:0}
.pdfw-field-error{margin:0;font-size:11px;color:var(--pdfw-danger)}
.pdfw-field-range{margin:0;font-size:10.5px;color:var(--pdfw-ink-3);font-variant-numeric:tabular-nums}
.pdfw-field.pdfw-is-invalid .pdfw-input,.pdfw-field.pdfw-is-invalid .pdfw-select,.pdfw-field.pdfw-is-invalid .pdfw-textarea,.pdfw-field.pdfw-is-invalid .pdfw-color{border-color:var(--pdfw-danger)}
.pdfw-input,.pdfw-select,.pdfw-textarea{border:1px solid var(--pdfw-border-2);border-radius:8px;background:var(--pdfw-bg);color:var(--pdfw-ink);font:inherit;font-size:12.5px;padding:7px 9px;min-width:0;width:100%;transition:border-color .12s ease,box-shadow .12s ease}
.pdfw-input:focus,.pdfw-select:focus,.pdfw-textarea:focus{outline:none;border-color:var(--pdfw-brand);box-shadow:0 0 0 3px var(--pdfw-accent-soft)}
.pdfw-textarea{resize:vertical;min-height:64px;line-height:1.5}
.pdfw-input--number{font-variant-numeric:tabular-nums;max-width:180px}
.pdfw-color{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0}
.pdfw-color-swatch{width:34px;height:30px;padding:2px;border:1px solid var(--pdfw-border-2);border-radius:7px;background:var(--pdfw-bg);flex:none;cursor:pointer}
.pdfw-input--hex{max-width:120px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.pdfw-segments{display:flex;flex-wrap:wrap;gap:6px}
.pdfw-segment{display:flex;flex-direction:column;gap:1px;align-items:flex-start;border:1px solid var(--pdfw-border-2);background:var(--pdfw-bg);color:var(--pdfw-ink-2);border-radius:8px;padding:6px 10px;cursor:pointer;text-align:left;transition:border-color .12s ease,background .12s ease}
.pdfw-segment:hover:not(:disabled){background:var(--pdfw-hover)}
.pdfw-segment.pdfw-is-active{border-color:var(--pdfw-accent);background:var(--pdfw-accent-soft);color:var(--pdfw-ink);font-weight:600}
.pdfw-segment-label{font-size:12px}
.pdfw-segment-hint{font-size:10.5px;color:var(--pdfw-ink-3);font-weight:400}
.pdfw-switch{display:inline-flex;align-items:center;gap:8px;border:0;background:transparent;padding:0;cursor:pointer;flex:none}
.pdfw-switch-track{position:relative;display:inline-flex;width:36px;height:20px;border-radius:999px;background:var(--pdfw-layer-3);transition:background .14s ease;flex:none}
.pdfw-switch-thumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--pdfw-bg);box-shadow:0 1px 2px var(--dsw-alias-bg-mask-1,rgba(0,0,0,.25));transition:transform .14s ease}
.pdfw-switch.pdfw-is-on .pdfw-switch-track{background:var(--pdfw-accent)}
.pdfw-switch.pdfw-is-on .pdfw-switch-thumb{transform:translateX(16px)}
.pdfw-switch:disabled{opacity:.5;cursor:not-allowed}
.pdfw-run-question{margin-bottom:10px}
.pdfw-run-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.pdfw-blocked{margin:8px 0 0;font-size:11.5px;color:var(--pdfw-ink-3)}
.pdfw-progress{position:relative;height:6px;border-radius:999px;background:var(--pdfw-layer-3);overflow:hidden}
.pdfw-progress-fill{display:block;height:100%;border-radius:999px;background:var(--pdfw-accent);transition:width .25s ease}
.pdfw-progress.pdfw-is-indeterminate .pdfw-progress-fill{animation:pdfw-indeterminate 1.2s ease-in-out infinite alternate;opacity:.7}
.pdfw-progress.pdfw-is-success .pdfw-progress-fill{background:var(--pdfw-success)}
.pdfw-progress.pdfw-is-danger .pdfw-progress-fill{background:var(--pdfw-danger)}
.pdfw-progress-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:8px;font-size:11.5px;color:var(--pdfw-ink-3)}
.pdfw-progress-stage{color:var(--pdfw-ink-2)}
.pdfw-progress-num{font-variant-numeric:tabular-nums;font-weight:600;color:var(--pdfw-ink)}
.pdfw-error{display:flex;align-items:flex-start;gap:9px;padding:10px 12px;border:1px solid var(--pdfw-danger);border-radius:9px;background:transparent;color:var(--pdfw-danger)}
.pdfw-error-icon{margin-top:1px;flex:none}
.pdfw-error-body{flex:1 1 auto;min-width:0}
.pdfw-error-message{margin:0;font-size:12.5px;font-weight:600;word-break:break-word}
.pdfw-error-hint{margin:2px 0 0;font-size:11.5px;opacity:.85}
.pdfw-error-code{margin:4px 0 0;font-size:10.5px;opacity:.7;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.pdfw-right-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 2px}
.pdfw-right-title{font-size:12px;font-weight:650;letter-spacing:.02em;text-transform:uppercase;color:var(--pdfw-ink-3)}
.pdfw-results{display:flex;flex-direction:column;gap:10px}
.pdfw-pane-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pdfw-pane-title{margin:0;font-size:14px;font-weight:660}
.pdfw-pane-actions{display:flex;gap:6px;margin-left:auto;flex-wrap:wrap}
.pdfw-outputs{display:flex;flex-direction:column;gap:8px}
.pdfw-outputs-title{margin:0;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--pdfw-ink-3);font-weight:650}
.pdfw-output{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--pdfw-border);border-radius:var(--pdfw-radius);background:var(--pdfw-bg)}
.pdfw-output-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.pdfw-output-icon{color:var(--pdfw-ink-2);display:inline-flex;flex:none}
.pdfw-output-meta{display:flex;flex-direction:column;min-width:0;flex:1 1 90px}
.pdfw-output-name{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pdfw-output-sub{font-size:10.5px;color:var(--pdfw-ink-3);font-variant-numeric:tabular-nums}
.pdfw-output-download{padding:5px 9px;font-size:11.5px}
.pdfw-output-none{margin:0}
.pdfw-preview{display:flex;flex-direction:column;gap:6px;border:1px solid var(--pdfw-border);border-radius:8px;background:var(--pdfw-layer);padding:6px;overflow:hidden}
.pdfw-preview-img{display:block;width:100%;height:auto;max-height:${PREVIEW_MAX_HEIGHT}px;object-fit:contain;border-radius:5px;background:var(--pdfw-bg)}
.pdfw-preview-nav{display:flex;align-items:center;justify-content:center;gap:8px}
.pdfw-preview-count{font-size:11px;color:var(--pdfw-ink-3);font-variant-numeric:tabular-nums}
.pdfw-preview-failed{margin:0;padding:14px;text-align:center}
.pdfw-text-preview{display:flex;flex-direction:column;gap:6px}
.pdfw-text-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px}
.pdfw-pre{margin:0;max-height:340px;overflow:auto;padding:10px;border:1px solid var(--pdfw-border);border-radius:8px;background:var(--pdfw-layer);color:var(--pdfw-ink);font-family:ui-monospace,SFMono-Regular,Menlo,"PingFang SC",monospace;font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.pdfw-batch-summary{margin:6px 0 0;font-size:11.5px;color:var(--pdfw-ink-3)}
.pdfw-batch-list{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:5px;max-height:280px;overflow:auto}
.pdfw-batch-row{display:flex;align-items:center;gap:7px;padding:6px 8px;border:1px solid var(--pdfw-border);border-radius:8px;background:var(--pdfw-bg);flex-wrap:wrap}
.pdfw-batch-icon{display:inline-flex;flex:none;color:var(--pdfw-ink-3)}
.pdfw-batch-row.pdfw-is-success .pdfw-batch-icon{color:var(--pdfw-success)}
.pdfw-batch-row.pdfw-is-failed .pdfw-batch-icon{color:var(--pdfw-danger)}
.pdfw-batch-meta{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 90px}
.pdfw-batch-name{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pdfw-batch-error{font-size:10.5px;color:var(--pdfw-danger);word-break:break-word}
.pdfw-batch-hint{font-size:10.5px;color:var(--pdfw-ink-3)}
.pdfw-chat{display:flex;flex-direction:column;gap:8px}
.pdfw-chat-log{display:flex;flex-direction:column;gap:8px;max-height:320px;overflow-y:auto;padding:2px}
.pdfw-bubble{display:flex;flex-direction:column;gap:3px;border-radius:10px;padding:8px 10px;border:1px solid var(--pdfw-border);background:var(--pdfw-bg);max-width:100%}
.pdfw-bubble--user{align-self:flex-end;background:var(--pdfw-accent-soft);border-color:transparent}
.pdfw-bubble--ai{align-self:flex-start}
.pdfw-bubble-head{font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--pdfw-ink-3)}
.pdfw-bubble-text{margin:0;white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:12px;line-height:1.55;color:var(--pdfw-ink);max-height:260px;overflow:auto}
.pdfw-bubble.pdfw-is-thinking{flex-direction:row;align-items:center;gap:6px;color:var(--pdfw-ink-3);font-size:11.5px}
.pdfw-chat-composer{display:flex;align-items:flex-end;gap:6px}
.pdfw-chat-composer .pdfw-textarea{flex:1 1 auto}
.pdfw-notes{display:flex;flex-direction:column;gap:6px}
.pdfw-notes-title{margin:0;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--pdfw-ink-3);font-weight:650;padding-top:4px}
.pdfw-note-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
.pdfw-note-row{display:flex;align-items:flex-start;gap:6px;font-size:11.5px;color:var(--pdfw-ink-2);line-height:1.5}
.pdfw-note-row .pdfw-icon{color:var(--pdfw-ink-3);margin-top:2px;flex:none}
.pdfw-icon{display:block;flex:none}
.pdfw-spinner{display:inline-flex;color:var(--pdfw-accent);animation:pdfw-spin .9s linear infinite}
.pdfw-col--left::-webkit-scrollbar,.pdfw-col--center::-webkit-scrollbar,.pdfw-col--right::-webkit-scrollbar,.pdfw-pre::-webkit-scrollbar,.pdfw-chat-log::-webkit-scrollbar,.pdfw-batch-list::-webkit-scrollbar{width:8px;height:8px}
.pdfw-col--left::-webkit-scrollbar-thumb,.pdfw-col--center::-webkit-scrollbar-thumb,.pdfw-col--right::-webkit-scrollbar-thumb,.pdfw-pre::-webkit-scrollbar-thumb,.pdfw-chat-log::-webkit-scrollbar-thumb,.pdfw-batch-list::-webkit-scrollbar-thumb{background:var(--pdfw-border-2);border-radius:999px}
@keyframes pdfw-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@keyframes pdfw-pulse{0%,100%{opacity:1}50%{opacity:.55}}
@keyframes pdfw-indeterminate{from{transform:translateX(-30%)}to{transform:translateX(60%)}}
@media (prefers-reduced-motion:reduce){.pdfw-root *,.pdfw-root *::before,.pdfw-root *::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important;scroll-behavior:auto!important}}

/* ══════════════════════════════════════════════════════════════════════════
   Theme v2 — dark navigation rail + bright-card workspace.
   Overrides only; every selector already exists in the rules above.
   Colours ride on the host tokens, except the rail which is intentionally
   dark in both themes so the two-panel hierarchy stays readable.
   ══════════════════════════════════════════════════════════════════════════ */
.pdfw-root{
--pdfw-radius:16px;--pdfw-radius-sm:10px;
/* warm palette: amber / terracotta accents on an ivory page */
--pdfw-accent:var(--dsh-plugin-workbench-accent,#b45309);
--pdfw-accent-strong:#92400e;
--pdfw-brand:var(--pdfw-accent);
--pdfw-page:color-mix(in srgb,var(--pdfw-accent) 6%,var(--dsw-alias-bg-layer-1,#faf6f0));
--pdfw-bg:color-mix(in srgb,var(--pdfw-accent) 2%,var(--dsw-alias-bg-base,#fffdf9));
--pdfw-layer:color-mix(in srgb,var(--pdfw-accent) 5%,var(--dsw-alias-bg-layer-1,#f7f1e8));
--pdfw-layer-2:color-mix(in srgb,var(--pdfw-accent) 8%,var(--dsw-alias-bg-layer-2,#f2eadf));
--pdfw-layer-3:color-mix(in srgb,var(--pdfw-accent) 12%,var(--dsw-alias-bg-layer-3,#ebe1d3));
--pdfw-border:color-mix(in srgb,var(--pdfw-accent) 15%,var(--dsw-alias-border-l1,#e8dfd3));
--pdfw-border-2:color-mix(in srgb,var(--pdfw-accent) 22%,var(--dsw-alias-border-l2,#d9cdbd));
--pdfw-hover:color-mix(in srgb,var(--pdfw-accent) 9%,transparent);
--pdfw-card-shadow:0 1px 2px rgba(68,45,20,.05),0 12px 32px -22px rgba(68,45,20,.35);
--pdfw-card-shadow-hover:0 2px 8px rgba(68,45,20,.08),0 22px 44px -24px rgba(180,83,9,.45);
--pdfw-rail:#1c1611;--pdfw-rail-2:#251d16;--pdfw-rail-line:rgba(255,235,205,.10);
--pdfw-rail-text:#e7dac7;--pdfw-rail-muted:#a8927a;
--pdfw-danger:var(--dsw-alias-state-error-primary,#b23a2a);
--pdfw-success:var(--dsw-alias-state-success-primary,#3f7d4e);
--pdfw-warn:var(--dsw-alias-state-warn-primary,#a16207);
--pdfw-left:264px;--pdfw-right:392px;
background:var(--pdfw-page)
}
/* ── columns ─────────────────────────────────────────────────────────────── */
.pdfw-col--center{background:var(--pdfw-page);padding:22px 26px 34px}
.pdfw-col--right{background:var(--pdfw-page);border-left:1px solid color-mix(in srgb,var(--pdfw-border) 65%,transparent);padding:14px 14px 20px;gap:12px}
.pdfw-col--left{background:linear-gradient(180deg,var(--pdfw-rail) 0%,#15100c 100%);border-right:0;padding:16px 12px 20px;gap:12px;box-shadow:inset -1px 0 0 rgba(255,255,255,.04)}
.pdfw-rail{border-left:0;color:var(--pdfw-rail-text)}
/* ── brand ───────────────────────────────────────────────────────────────── */
.pdfw-brand-row{gap:10px;min-height:38px;padding:2px 4px 4px}
.pdfw-brand-icon{width:32px;height:32px;border-radius:10px;background:linear-gradient(135deg,#f0a03a,#c2410c);color:#fff;box-shadow:0 6px 16px -8px rgba(194,65,12,.9)}
.pdfw-brand-title{color:#fff;font-size:14px;font-weight:680;letter-spacing:-.01em}
.pdfw-brand-sub{color:var(--pdfw-rail-muted)}
.pdfw-col--left .pdfw-left-tools .pdfw-btn--ghost{background:rgba(255,255,255,.06);border-color:var(--pdfw-rail-line);color:var(--pdfw-rail-text);justify-content:flex-start;font-weight:560}
.pdfw-col--left .pdfw-left-tools .pdfw-btn--ghost:hover:not(:disabled){background:rgba(255,255,255,.12);color:#fff}
/* ── search (rail) ───────────────────────────────────────────────────────── */
.pdfw-col--left .pdfw-search{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.12);border-radius:11px;min-height:38px}
.pdfw-col--left .pdfw-search:focus-within{background:rgba(255,255,255,.11);border-color:rgba(245,158,11,.7);box-shadow:0 0 0 3px rgba(217,119,6,.22)}
.pdfw-col--left .pdfw-search-icon{color:var(--pdfw-rail-muted)}
.pdfw-col--left .pdfw-search-input{color:#eaf1fb}
.pdfw-col--left .pdfw-search-input::placeholder{color:#7b8fad}
.pdfw-col--left .pdfw-search-clear{color:#9db0cc}
/* ── navigation ──────────────────────────────────────────────────────────── */
.pdfw-col--left .pdfw-nav{gap:4px}
.pdfw-col--left .pdfw-nav-group-head{color:#d9e5f6;font-size:13px;font-weight:620;padding:9px 9px;border-radius:11px;gap:8px}
.pdfw-col--left .pdfw-nav-group-head:hover{background:rgba(255,255,255,.08)}
.pdfw-col--left .pdfw-nav-group-icon{color:#8fa8c9}
.pdfw-col--left .pdfw-nav-group-head>.pdfw-icon:first-child{color:#6b83a5}
.pdfw-col--left .pdfw-nav-count{background:rgba(255,255,255,.1);color:#9fb3d0;min-width:22px;text-align:center}
.pdfw-col--left .pdfw-nav-items{border-left:1px solid var(--pdfw-rail-line);margin-left:15px;padding:4px 0 8px 9px}
.pdfw-col--left .pdfw-nav-section-title{color:#7589a8;letter-spacing:.06em;font-size:10px;margin:8px 6px 4px}
.pdfw-col--left .pdfw-nav-item{color:#afc0d8;font-size:12.5px;padding:8px 10px;border-radius:10px;transition:background .13s ease,color .13s ease}
.pdfw-col--left .pdfw-nav-item:hover:not(:disabled){background:rgba(255,255,255,.09);color:#fff}
.pdfw-col--left .pdfw-nav-item.pdfw-is-active{background:linear-gradient(135deg,#c2710c,#a4530a);color:#fff;font-weight:620;box-shadow:0 10px 22px -12px rgba(180,83,9,.9)}
.pdfw-col--left .pdfw-nav-item:disabled{opacity:.45}
.pdfw-col--left .pdfw-nav-tag{border-color:rgba(255,255,255,.34);color:#dce7f7;opacity:.9}
.pdfw-col--left .pdfw-nav-item.pdfw-is-active .pdfw-nav-tag{border-color:rgba(255,255,255,.7)}
.pdfw-col--left .pdfw-mark{background:rgba(217,119,6,.5);color:#fff}
.pdfw-col--left .pdfw-muted,.pdfw-col--left .pdfw-nav-empty{color:var(--pdfw-rail-muted)}
.pdfw-col--left ::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16)}
/* ── home ────────────────────────────────────────────────────────────────── */
.pdfw-home{gap:30px;max-width:1180px}
.pdfw-home-head{gap:8px;padding:2px 2px 0}
.pdfw-home-title{font-size:27px;font-weight:700;letter-spacing:-.025em;color:var(--pdfw-ink)}
.pdfw-home-desc{font-size:13.5px;color:var(--pdfw-ink-2);max-width:64ch;line-height:1.65}
.pdfw-home-count{font-size:12px;color:var(--pdfw-ink-3);letter-spacing:.02em}
.pdfw-home-group{gap:12px}
.pdfw-home-group-head{gap:10px}
.pdfw-home-group-icon{width:30px;height:30px;border-radius:10px;background:color-mix(in srgb,var(--pdfw-accent) 12%,transparent);color:var(--pdfw-accent)}
.pdfw-home-group-title{font-size:16px;font-weight:680;letter-spacing:-.01em}
.pdfw-home-group-desc{font-size:12px}
.pdfw-cards{grid-template-columns:repeat(auto-fill,minmax(246px,1fr));gap:14px}
/* home header: title left, prominent search right (as in the reference) */
.pdfw-home-head{display:grid;grid-template-columns:minmax(0,1fr) minmax(230px,340px);grid-template-rows:auto auto;gap:5px 26px;align-items:center}
.pdfw-home-head>.pdfw-home-title{grid-column:1;grid-row:1;align-self:end}
.pdfw-home-head>.pdfw-home-desc{grid-column:1;grid-row:2;align-self:start}
.pdfw-home-head>.pdfw-search{grid-column:2;grid-row:1 / span 2;align-self:center;width:100%}
.pdfw-search--big{min-height:44px;border-radius:12px;padding:0 12px;background:var(--pdfw-bg);border-color:color-mix(in srgb,var(--pdfw-border-2) 80%,transparent);box-shadow:var(--pdfw-card-shadow)}
.pdfw-search--big:focus-within{border-color:var(--pdfw-accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--pdfw-accent) 13%,transparent)}
.pdfw-search--big .pdfw-search-input{font-size:13.5px}
.pdfw-home-count{display:inline-flex;align-self:flex-start;background:color-mix(in srgb,var(--pdfw-accent) 9%,transparent);color:var(--pdfw-accent);border-radius:999px;padding:3px 12px;font-weight:600}
@media (max-width:960px){.pdfw-home-head{grid-template-columns:1fr;grid-template-rows:auto auto auto}.pdfw-home-head>.pdfw-search{grid-column:1;grid-row:3}}
/* ── operation card ──────────────────────────────────────────────────────── */
.pdfw-opcard{flex-direction:column;align-items:stretch;gap:12px;padding:18px;min-height:146px;border-radius:16px;border-color:color-mix(in srgb,var(--pdfw-border) 80%,transparent);background:var(--pdfw-bg);box-shadow:var(--pdfw-card-shadow);transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease}
.pdfw-opcard:hover:not(:disabled){border-color:color-mix(in srgb,var(--pdfw-accent) 46%,transparent);box-shadow:var(--pdfw-card-shadow-hover);transform:translateY(-2px);background:var(--pdfw-bg)}
.pdfw-opcard:disabled{opacity:.55;transform:none;box-shadow:none}
.pdfw-opcard-icon{width:40px;height:40px;border-radius:13px;background:color-mix(in srgb,var(--pdfw-accent) 10%,transparent);color:var(--pdfw-accent)}
.pdfw-opcard-copy{gap:7px}
.pdfw-opcard-title{font-size:14.5px;font-weight:660;letter-spacing:-.01em;line-height:1.4}
.pdfw-opcard-desc{font-size:12px;line-height:1.6;color:var(--pdfw-ink-2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pdfw-opcard-tags{flex-direction:row;align-items:center;gap:6px;margin-top:auto}
/* ── workspace (tool) head ───────────────────────────────────────────────── */
.pdfw-workspace{display:flex;flex-direction:column;gap:14px;max-width:1180px;margin:0 auto;width:100%}
.pdfw-workspace-head{display:flex;align-items:center;gap:12px;padding:0 2px 4px;flex-wrap:wrap}
.pdfw-workspace-icon{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:13px;background:color-mix(in srgb,var(--pdfw-accent) 11%,transparent);color:var(--pdfw-accent);flex:none}
.pdfw-workspace-copy{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}
.pdfw-workspace-title{margin:0;font-size:19px;font-weight:690;letter-spacing:-.015em;color:var(--pdfw-ink)}
.pdfw-workspace-desc{margin:0;font-size:12.5px;color:var(--pdfw-ink-2);line-height:1.55}
.pdfw-workspace-badges{display:flex;gap:6px;flex-wrap:wrap;align-items:center;flex:none}
/* ── workspace cards read like the reference dialog ──────────────────────── */
.pdfw-workspace .pdfw-card{padding:20px;border-radius:18px;border-color:color-mix(in srgb,var(--pdfw-border) 75%,transparent);background:var(--pdfw-bg);box-shadow:var(--pdfw-card-shadow)}
.pdfw-section-head{gap:10px;margin-bottom:14px}
.pdfw-step{min-width:24px;height:24px;border-radius:8px;background:color-mix(in srgb,var(--pdfw-accent) 13%,transparent);color:var(--pdfw-accent);font-size:11.5px}
.pdfw-section-title{margin:0;font-size:15px;font-weight:680;letter-spacing:-.01em;color:var(--pdfw-ink)}
.pdfw-section-desc{margin:-4px 0 12px;font-size:12px;color:var(--pdfw-ink-3);line-height:1.55}
.pdfw-section-extra{margin-left:auto}
/* ── inputs ──────────────────────────────────────────────────────────────── */
.pdfw-input,.pdfw-select,.pdfw-textarea{min-height:42px;border-radius:11px;border-color:color-mix(in srgb,var(--pdfw-border-2) 85%,transparent);background:var(--pdfw-bg);font-size:13px;padding:10px 12px;transition:border-color .13s ease,box-shadow .13s ease,background .13s ease}
.pdfw-select{appearance:none;-webkit-appearance:none;padding-right:34px;background-image:linear-gradient(45deg,transparent 50%,#6b7c99 50%),linear-gradient(135deg,#6b7c99 50%,transparent 50%);background-position:calc(100% - 17px) calc(50% + 1px),calc(100% - 12px) calc(50% + 1px);background-size:5px 5px,5px 5px;background-repeat:no-repeat;background-attachment:scroll}
.pdfw-input:hover,.pdfw-select:hover,.pdfw-textarea:hover{border-color:var(--pdfw-border-2)}
.pdfw-input:focus,.pdfw-select:focus,.pdfw-textarea:focus{border-color:var(--pdfw-accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--pdfw-accent) 14%,transparent)}
.pdfw-textarea{min-height:86px;line-height:1.6}
.pdfw-field{gap:7px}
.pdfw-field-label{font-size:12.5px;font-weight:600;color:var(--pdfw-ink-2)}
.pdfw-field-help{font-size:11.5px;line-height:1.55}
.pdfw-field--inline{border-radius:12px;padding:11px 13px;background:color-mix(in srgb,var(--pdfw-accent) 4%,var(--pdfw-bg));border-color:color-mix(in srgb,var(--pdfw-border) 80%,transparent)}
/* ── segmented radio ─────────────────────────────────────────────────────── */
.pdfw-segments{gap:8px}
.pdfw-segment{border-radius:11px;padding:9px 13px;gap:2px;background:var(--pdfw-bg);transition:border-color .13s ease,background .13s ease,box-shadow .13s ease}
.pdfw-segment:hover:not(:disabled){border-color:color-mix(in srgb,var(--pdfw-accent) 40%,transparent);background:color-mix(in srgb,var(--pdfw-accent) 4%,var(--pdfw-bg))}
.pdfw-segment.pdfw-is-active{border-color:var(--pdfw-accent);background:color-mix(in srgb,var(--pdfw-accent) 9%,var(--pdfw-bg));box-shadow:0 0 0 3px color-mix(in srgb,var(--pdfw-accent) 10%,transparent)}
.pdfw-segment-label{font-size:12.5px}
/* ── buttons ─────────────────────────────────────────────────────────────── */
.pdfw-btn{min-height:40px;padding:9px 16px;border-radius:11px;font-size:13px;font-weight:600;gap:7px}
.pdfw-btn--primary{background:var(--pdfw-accent);border-color:var(--pdfw-accent);color:#fff;box-shadow:0 1px 2px rgba(180,83,9,.28),0 10px 22px -12px rgba(180,83,9,.85)}
.pdfw-btn--primary:hover:not(:disabled){background:color-mix(in srgb,var(--pdfw-accent) 88%,#000);border-color:transparent;box-shadow:0 2px 4px rgba(180,83,9,.32),0 14px 28px -14px rgba(180,83,9,.9)}
.pdfw-btn--primary:disabled{background:color-mix(in srgb,var(--pdfw-accent) 45%,var(--pdfw-bg));border-color:transparent;box-shadow:none;color:#fff}
.pdfw-btn--ghost{border-color:color-mix(in srgb,var(--pdfw-border-2) 90%,transparent);color:var(--pdfw-ink-2);background:var(--pdfw-bg)}
.pdfw-btn--ghost:hover:not(:disabled){background:var(--pdfw-hover);color:var(--pdfw-ink);border-color:var(--pdfw-border-2)}
.pdfw-btn--subtle{background:color-mix(in srgb,var(--pdfw-accent) 8%,var(--pdfw-bg));color:var(--pdfw-accent)}
.pdfw-btn--subtle:hover:not(:disabled){background:color-mix(in srgb,var(--pdfw-accent) 14%,var(--pdfw-bg))}
.pdfw-run-actions{gap:10px}
.pdfw-run-actions .pdfw-btn--primary{min-width:180px;min-height:44px;font-size:13.5px}
/* ── upload ──────────────────────────────────────────────────────────────── */
.pdfw-drop{padding:30px 18px;border-radius:16px;border-width:1.5px;border-color:color-mix(in srgb,var(--pdfw-accent) 28%,var(--pdfw-border-2));background:color-mix(in srgb,var(--pdfw-accent) 3.5%,var(--pdfw-bg));gap:7px;transition:border-color .15s ease,background .15s ease,transform .15s ease}
.pdfw-drop:hover{border-color:var(--pdfw-accent);background:color-mix(in srgb,var(--pdfw-accent) 7%,var(--pdfw-bg))}
.pdfw-drop.pdfw-is-dragging{border-color:var(--pdfw-accent);background:color-mix(in srgb,var(--pdfw-accent) 11%,var(--pdfw-bg));box-shadow:0 0 0 4px color-mix(in srgb,var(--pdfw-accent) 12%,transparent)}
.pdfw-drop-icon{color:var(--pdfw-accent)}
.pdfw-drop-title{font-size:14px;font-weight:650;color:var(--pdfw-ink)}
.pdfw-drop-hint{font-size:11.5px}
.pdfw-file{border-radius:11px;padding:9px 11px;background:color-mix(in srgb,var(--pdfw-accent) 3%,var(--pdfw-bg))}
.pdfw-file:hover{border-color:color-mix(in srgb,var(--pdfw-accent) 30%,transparent)}
.pdfw-file-name{font-weight:560}
/* ── progress + status ───────────────────────────────────────────────────── */
.pdfw-progress{height:8px;border-radius:999px;background:color-mix(in srgb,var(--pdfw-accent) 12%,var(--pdfw-layer-3))}
.pdfw-progress-fill{background:linear-gradient(90deg,var(--pdfw-accent),color-mix(in srgb,var(--pdfw-accent) 55%,#f59e0b))}
.pdfw-progress-num{font-size:13px}
.pdfw-error{border-radius:12px;padding:12px 14px;background:color-mix(in srgb,var(--pdfw-danger) 6%,var(--pdfw-bg));border-color:color-mix(in srgb,var(--pdfw-danger) 45%,transparent)}
.pdfw-warn{border-radius:12px}
.pdfw-badge{border-radius:999px;padding:0 8px;line-height:19px}
.pdfw-badge--accent{background:color-mix(in srgb,var(--pdfw-accent) 90%,#fff);color:#fff}
/* ── right column ────────────────────────────────────────────────────────── */
.pdfw-right-head{padding:2px 4px}
.pdfw-right-title{font-size:11px;letter-spacing:.08em;color:var(--pdfw-ink-3)}
.pdfw-results{gap:12px}
.pdfw-pane-title{font-size:15px;font-weight:680;display:flex;align-items:center;gap:8px}
.pdfw-col--right .pdfw-notes{background:var(--pdfw-bg);border:1px solid color-mix(in srgb,var(--pdfw-border) 75%,transparent);border-radius:16px;padding:16px;box-shadow:var(--pdfw-card-shadow)}
.pdfw-col--right .pdfw-notes-title{font-size:10.5px;letter-spacing:.07em;color:var(--pdfw-ink-3)}
.pdfw-output{border-radius:14px;padding:12px;background:var(--pdfw-bg);box-shadow:var(--pdfw-card-shadow);border-color:color-mix(in srgb,var(--pdfw-border) 75%,transparent)}
.pdfw-preview{border-radius:12px;padding:8px}
.pdfw-empty{border-radius:16px;background:color-mix(in srgb,var(--pdfw-accent) 3%,var(--pdfw-bg));border-color:color-mix(in srgb,var(--pdfw-accent) 22%,var(--pdfw-border-2));padding:40px 20px}
.pdfw-empty-title{font-size:14px}
.pdfw-bubble{border-radius:12px;padding:10px 12px}
.pdfw-bubble--user{background:color-mix(in srgb,var(--pdfw-accent) 12%,var(--pdfw-bg))}
.pdfw-bubble--ai{background:var(--pdfw-bg);border-color:color-mix(in srgb,var(--pdfw-border) 80%,transparent)}
.pdfw-skeleton-card{border-radius:16px}
/* ── icon buttons + collapsed rails ──────────────────────────────────────── */
.pdfw-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--pdfw-ink-2);cursor:pointer;transition:background .13s ease,color .13s ease,border-color .13s ease;flex:none}
.pdfw-iconbtn:hover:not(:disabled){background:var(--pdfw-hover);color:var(--pdfw-ink)}
.pdfw-iconbtn:disabled{opacity:.45;cursor:not-allowed}
.pdfw-col--left .pdfw-iconbtn{color:var(--pdfw-rail-muted);border-color:var(--pdfw-rail-line)}
.pdfw-col--left .pdfw-iconbtn:hover:not(:disabled){background:rgba(255,255,255,.12);color:#fff;border-color:rgba(255,255,255,.18)}
.pdfw-rail{gap:10px;padding:4px 0}
.pdfw-col--left .pdfw-rail{background:transparent}
.pdfw-col--right .pdfw-rail{color:var(--pdfw-ink-2)}
/* ── responsive ──────────────────────────────────────────────────────────── */
@media (max-width:1320px){.pdfw-root{--pdfw-left:246px;--pdfw-right:360px}}
@media (max-width:1120px){.pdfw-root{--pdfw-left:230px;--pdfw-right:320px}.pdfw-col--center{padding:18px 18px 28px}.pdfw-cards{grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}}
@media (max-width:880px){.pdfw-root{--pdfw-left:212px;--pdfw-right:0px}.pdfw-col--right{display:none}.pdfw-home-title{font-size:23px}}

/* ── v1.1.2 layout fixes ─────────────────────────────────────────────────────
   The host main panel can be ~1000px wide; a fixed 264+392 shell then leaves
   the centre about 400px, which collapsed the two-column home header to a
   single character per line. Columns now scale with the panel and the home
   header stacks instead of forcing a rigid grid.                            */
.pdfw-root{--pdfw-left:clamp(212px,20%,264px);--pdfw-right:clamp(258px,27%,392px)}
.pdfw-home{max-width:1180px;width:100%}
.pdfw-home-head{display:flex;flex-direction:column;align-items:stretch;gap:8px;min-width:0}
.pdfw-home-head>.pdfw-home-title{grid-column:auto;grid-row:auto;width:100%;min-width:0;font-size:clamp(20px,2.2vw,27px);line-height:1.25;overflow-wrap:anywhere}
.pdfw-home-head>.pdfw-home-desc{grid-column:auto;grid-row:auto;width:100%;min-width:0;max-width:62ch}
.pdfw-home-head>.pdfw-search{grid-column:auto;grid-row:auto;width:100%;max-width:460px;min-width:0;align-self:stretch;margin-top:4px}
.pdfw-cards{grid-template-columns:repeat(auto-fill,minmax(212px,1fr));gap:12px}
.pdfw-opcard{min-height:132px;padding:15px}
.pdfw-opcard-desc{-webkit-line-clamp:3}
.pdfw-home-group-head{flex-wrap:wrap}
/* The workspace header must wrap rather than squeeze on a narrow panel. */
.pdfw-workspace-head{align-items:flex-start}
.pdfw-workspace-copy{flex:1 1 220px}
.pdfw-workspace-title{overflow-wrap:anywhere}
.pdfw-fields{grid-template-columns:repeat(auto-fill,minmax(min(100%,200px),1fr))}
.pdfw-segments{flex-wrap:wrap}
/* Right column: keep the pane usable when it is squeezed. */
.pdfw-col--right{padding:12px 12px 18px}
.pdfw-col--right .pdfw-notes{padding:14px}
.pdfw-right-title{font-size:10.5px}
/* keep the narrow-viewport behaviour the earlier rule intended: my clamp
   rules sit after those media queries, so re-assert the collapsed track. */
@media (max-width:880px){.pdfw-root{--pdfw-left:200px;--pdfw-right:0px}.pdfw-home-head>.pdfw-search{max-width:none}}
`

    /* ==================================================================== */
    /* 25. sidebar panel icon                                               */
    /* ==================================================================== */

    function PanelIcon(props) {
      var size = props && props.size ? props.size : 16
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false",
          className: "pdfw-panel-icon",
        },
        h("path", { d: "M7 3.5h7.5L19 8v12.5H7Z" }),
        h("path", { d: "M14.5 3.5V8H19" }),
        h("path", { d: "M9.8 12h6.4" }),
        h("path", { d: "M9.8 15.5h4.2" })
      )
    }

    /* ==================================================================== */
    /* 26. apply — slot registration (CONTRACT §3.2)                        */
    /* ==================================================================== */

    function safeInject(ctx, name, factory) {
      try {
        ctx.slots.inject(name, factory)
      } catch (error) {
        try {
          console.error("[pdf-workbench] could not register slot " + name, error)
        } catch (ignored) {
          /* console is unavailable */
        }
      }
    }

    function apply(ctx) {
      attachLocale(ctx && ctx.locale)
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") return

      // Belt and braces: the component also renders its <style> inline, but a
      // document-level copy guarantees the sheet applies no matter where the
      // slot host mounts the workbench (portal, shadow boundary, late mount).
      if (typeof ctx.effect === "function" && typeof document !== "undefined" && document.head) {
        ctx.effect(function () {
          var marker = 'style[data-plugin-css="pdf-workbench/client.css"]'
          if (document.querySelector(marker)) return function () {}
          var style = document.createElement("style")
          style.dataset.pluginCss = "pdf-workbench/client.css"
          style.dataset.plugin = "pdf-workbench"
          style.textContent = CSS
          document.head.appendChild(style)
          return function () {
            style.remove()
          }
        }, "pdf-workbench: stylesheet")
      }

      safeInject(ctx, "main", function () {
        return ctx.slots.register(
          { name: "main", key: "pdf-workbench", inject: function () { return { workbench: true } } },
          Workbench
        )
      })

      safeInject(ctx, "sidebar.panellist", function () {
        return ctx.slots.register(
          {
            name: "sidebar.panellist",
            id: "pdf-workbench",
            order: 56,
            label: function () {
              return t("app.short")
            },
          },
          PanelIcon
        )
      })
    }

    exports.apply = apply
    exports.inject = ["slots", "locale"]

    /**
     * Test-only surface for `client.selftest.mjs`. The host only reads `apply`
     * and `inject`; nothing in the runtime calls this object.
     */
    exports.__pdfwTest = {
      COPY: COPY,
      ENDPOINTS: ENDPOINTS,
      FALLBACK_LIMITS: FALLBACK_LIMITS,
      POLL_BASE_MS: POLL_BASE_MS,
      POLL_MAX_MS: POLL_MAX_MS,
      attachLocale: attachLocale,
      activeLocaleId: activeLocaleId,
      currentLang: currentLang,
      t: t,
      pick: pick,
      interpolate: interpolate,
      formatBytes: formatBytes,
      formatDuration: formatDuration,
      progressPercent: progressPercent,
      nextDelay: nextDelay,
      isTerminalStatus: isTerminalStatus,
      normalizeLimits: normalizeLimits,
      validateFiles: validateFiles,
      visibleFields: visibleFields,
      formFields: formFields,
      defaultsFor: defaultsFor,
      validateValues: validateValues,
      buildParams: buildParams,
      previewKindFor: previewKindFor,
      highlightParts: highlightParts,
      buildNavigation: buildNavigation,
      filterNavigation: filterNavigation,
      navigationOps: navigationOps,
      countNavigationOps: countNavigationOps,
      capabilityGap: capabilityGap,
      estimateRemainingMs: estimateRemainingMs,
      formatLabels: formatLabels,
      issueMessage: issueMessage,
      reuseSourceIds: reuseSourceIds,
      encodeSourceIds: encodeSourceIds,
      transport: {
        apiGet: apiGet,
        apiSend: apiSend,
        apiPostForm: apiPostForm,
        apiDelete: apiDelete,
        apiGetText: apiGetText,
        makeError: makeError,
        isAbortError: isAbortError,
      },
      components: {
        Workbench: Workbench,
        HomeView: HomeView,
        LeftNav: LeftNav,
        WorkspaceView: WorkspaceView,
        ParamsPanel: ParamsPanel,
        UploadZone: UploadZone,
        ProgressPanel: ProgressPanel,
        ResultPane: ResultPane,
        BatchPanel: BatchPanel,
        ChatPane: ChatPane,
        NotesPanel: NotesPanel,
        OutputRow: OutputRow,
        ErrorStrip: ErrorStrip,
        SearchBox: SearchBox,
        Icon: Icon,
        PanelIcon: PanelIcon,
      },
    }

    return module.exports
  },
})
