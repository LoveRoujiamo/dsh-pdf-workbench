#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PDF Workbench engine — the single PDF processing engine of DSH's PDF workbench.

Invoked by the Host as a child process::

    python3 pdf_engine.py <mode> <job.json>

Modes: ``env`` | ``run`` | ``text`` | ``build`` | ``preview`` | ``probe``.

Contract
--------
* stdout carries **exactly one line** of JSON (the final result),
* progress goes to stderr as one-line JSON: ``{"progress":0.4,"stage":"..."}``,
* every op is defensive: one bad file never kills a batch, and no exception is
  allowed to escape as a stack trace on stdout.

The engine is a single file on purpose: the Host always launches it with the
same interpreter, so a self-contained module removes every import-path surprise.
"""

from __future__ import annotations

import sys
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
# Dependency directory. A development checkout keeps it at engine/runtime/pylib;
# an installed package cannot write there, so the Host passes PDFW_PYLIB pointing
# at $DSH_HOME/pdf-workbench-runtime/pylib instead.
_PYLIB = os.environ.get('PDFW_PYLIB') or os.path.join(_HERE, 'runtime', 'pylib')
if os.path.isdir(_PYLIB):
    sys.path.insert(0, _PYLIB)

import io
import json
import math
import platform
import re
import shutil
import subprocess
import tempfile
import time
import traceback
import zipfile

ENGINE_VERSION = '1.1.2'

MM = 72.0 / 25.4          # 1 millimetre in points
INCH = 72.0               # 1 inch in points
PX96 = 72.0 / 96.0        # 1 CSS pixel (96 dpi) in points
PT_TO_MM = 25.4 / 72.0

try:                          # PyMuPDF >= 1.24 exposes the modern module name
    import pymupdf as fitz
except Exception:             # pragma: no cover - fallback for the classic name
    try:
        import fitz
    except Exception:
        fitz = None

#: Portrait (width, height) in points for every paper preset of the catalog.
PAPER = {
    'A3': (297 * MM, 420 * MM),
    'A4': (210 * MM, 297 * MM),
    'A5': (148 * MM, 210 * MM),
    'B5': (176 * MM, 250 * MM),
    'Letter': (8.5 * INCH, 11 * INCH),
    'Legal': (8.5 * INCH, 14 * INCH),
    'Tabloid': (11 * INCH, 17 * INCH),
}

KIND_BY_EXT = {
    '.pdf': 'pdf', '.zip': 'zip',
    '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image',
    '.txt': 'text', '.md': 'md', '.json': 'json', '.csv': 'json',
    '.docx': 'docx', '.xlsx': 'xlsx', '.pptx': 'pptx',
}

OFFICE_EXTS = {'.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf'}
IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.gif'}
TEXT_EXTS = {'.txt', '.md', '.markdown', '.csv', '.log'}


# --------------------------------------------------------------------------- #
# errors & progress
# --------------------------------------------------------------------------- #

class EngineError(Exception):
    """A failure the browser can act on: machine code, message and retry hint."""

    def __init__(self, code, message, hint=''):
        super().__init__(message)
        self.code = str(code)
        self.message = str(message)
        self.hint = str(hint or '')

    def payload(self):
        return {'code': self.code, 'message': self.message, 'hint': self.hint}


def fail(code, message, hint=''):
    return EngineError(code, message, hint)


def progress(frac, stage=''):
    """Emit one progress event on stderr (the Host parses these lines)."""
    try:
        value = max(0.0, min(1.0, float(frac)))
        sys.stderr.write(json.dumps({'progress': round(value, 4), 'stage': str(stage or '')},
                                    ensure_ascii=False) + '\n')
        sys.stderr.flush()
    except Exception:                                  # never fail because of logging
        pass


def page_progress(index, total, label, lo=0.06, hi=0.92):
    span = max(0.0, hi - lo)
    frac = lo + span * (float(index + 1) / float(max(1, total)))
    progress(frac, '%s（%d/%d）' % (label, index + 1, total))


# --------------------------------------------------------------------------- #
# small coercion helpers
# --------------------------------------------------------------------------- #

def as_bool(value, default=False):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    if text in ('1', 'true', 'yes', 'on', 'y', '是'):
        return True
    if text in ('0', 'false', 'no', 'off', 'n', '否', ''):
        return False
    return default


def as_number(value, default=0.0):
    if value is None or value == '':
        return float(default)
    try:
        return float(value)
    except (TypeError, ValueError):
        try:
            return float(str(value).replace(',', '').strip())
        except (TypeError, ValueError):
            return float(default)


def as_int(value, default=0):
    try:
        return int(round(as_number(value, default)))
    except (TypeError, ValueError):
        return int(default)


def clamp(value, low, high):
    return max(low, min(high, value))


def require_fitz():
    if fitz is None:
        raise fail('PYMUPDF_MISSING',
                   'PDF 引擎组件 PyMuPDF 未安装，无法处理文件',
                   '请把 pymupdf 安装到 pdf-workbench/engine/.pylib 后重试')
    return fitz


def lazy_import(module, code, message, hint):
    try:
        return __import__(module, fromlist=['*'])
    except Exception as exc:
        raise fail(code, '%s（%s）' % (message, exc), hint)


def pil_image_module():
    try:
        from PIL import Image
        return Image
    except Exception as exc:
        raise fail('PIL_MISSING', '缺少 Pillow 图像库，无法处理图片任务（%s）' % exc,
                   '请安装 Pillow 后重试')


# --------------------------------------------------------------------------- #
# job context
# --------------------------------------------------------------------------- #

class Ctx:
    """Normalised view over one job.json file."""

    def __init__(self, job):
        job = job if isinstance(job, dict) else {}
        self.job = job
        self.op = str(job.get('op') or '')
        params = job.get('params')
        self.params = params if isinstance(params, dict) else {}
        inputs = job.get('inputs')
        self.inputs = inputs if isinstance(inputs, list) else []
        self.out_dir = str(job.get('outDir') or '') or tempfile.mkdtemp(prefix='pdfw-out-')
        self.target = job.get('target')
        self.warnings = []
        self.extra_meta = {}

    # -- params ---------------------------------------------------------- #
    def raw(self, key, default=None):
        return self.params.get(key, default)

    def text(self, key, default=''):
        value = self.params.get(key, default)
        if value is None:
            return default
        if isinstance(value, str):
            return value
        if isinstance(value, dict):
            # catalog.js declares some defaults as {zh, en}: pick a readable one
            for locale_key in ('zh', 'en', 'value', 'label'):
                candidate = value.get(locale_key)
                if isinstance(candidate, str) and candidate:
                    return candidate
            for candidate in value.values():
                if isinstance(candidate, str) and candidate:
                    return candidate
            return default
        return str(value)

    def number(self, key, default=0.0):
        return as_number(self.params.get(key), default)

    def integer(self, key, default=0):
        return as_int(self.params.get(key), default)

    def flag(self, key, default=False):
        return as_bool(self.params.get(key), default)

    def choice(self, key, default, allowed):
        value = str(self.params.get(key) or default)
        return value if value in allowed else default

    # -- misc ------------------------------------------------------------ #
    def warn(self, message):
        text = str(message or '').strip()
        if text and text not in self.warnings:
            self.warnings.append(text)
            try:
                sys.stderr.write(json.dumps({'warning': text}, ensure_ascii=False) + '\n')
                sys.stderr.flush()
            except Exception:
                pass

    def ensure_out_dir(self):
        path = os.path.abspath(self.out_dir)
        os.makedirs(path, exist_ok=True)
        return path

    def password(self, default=''):
        return self.text('password', default)


# --------------------------------------------------------------------------- #
# file names, output records, zips
# --------------------------------------------------------------------------- #

_FILENAME_CTRL = re.compile(r'[\x00-\x1f\x7f]')


def sanitize_name(name, fallback='document'):
    """Strip path separators and control characters from a user supplied name."""
    text = str(name or '')
    text = text.replace('\\', '_').replace('/', '_')
    text = _FILENAME_CTRL.sub('', text)
    text = re.sub(r'[:*?"<>|]', '_', text)
    text = text.strip().strip('.')
    text = text.strip()
    if not text:
        text = fallback
    if len(text) > 120:
        root, ext = os.path.splitext(text)
        if len(ext) > 16:
            ext = ''
        keep = max(1, 120 - len(ext))
        text = root[:keep] + ext
    return text or fallback


def base_of(name):
    raw = os.path.basename(str(name or 'document'))
    safe = sanitize_name(raw, 'document')
    root, _ext = os.path.splitext(safe)
    return root or 'document'


def ext_of(name):
    return os.path.splitext(str(name or ''))[1].lower()


def kind_for_path(path):
    return KIND_BY_EXT.get(ext_of(path), 'file')


def _inside_dir(directory, path):
    try:
        real_dir = os.path.realpath(directory)
        real_path = os.path.realpath(path)
        return os.path.commonpath([real_dir, real_path]) == real_dir
    except Exception:
        return False


def unique_path(out_dir, name):
    """Return a collision-free absolute path inside ``out_dir``."""
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    safe = sanitize_name(name)
    candidate = os.path.join(out_dir, safe)
    if not _inside_dir(out_dir, candidate):
        root, ext = os.path.splitext(safe)
        candidate = os.path.join(out_dir, sanitize_name(root or 'output') + (ext or ''))
    root, ext = os.path.splitext(candidate)
    if not os.path.basename(root):
        root = os.path.join(out_dir, 'output')
        candidate = root + ext
    index = 0
    while os.path.exists(candidate):
        index += 1
        candidate = '%s-%d%s' % (root, index, ext)
    return candidate


def out_path(ctx, base, suffix, ext):
    """Build ``<outDir>/<base><suffix>.<ext>`` with automatic de-duplication."""
    ex = str(ext or '').lstrip('.')
    stamp = '%s%s.%s' % (sanitize_name(base), suffix or '', ex)
    return unique_path(ctx.ensure_out_dir(), stamp)


def output_record(path, kind=None, name=None, pages=None):
    absolute = os.path.abspath(path)
    record = {
        'path': absolute,
        'name': os.path.basename(name) if name else os.path.basename(absolute),
    }
    record['kind'] = kind or kind_for_path(record['name'])
    try:
        record['bytes'] = os.path.getsize(absolute)
    except OSError:
        record['bytes'] = 0
    if pages is not None:
        try:
            record['pages'] = int(pages)
        except (TypeError, ValueError):
            pass
    return record


def pdf_record(ctx, path, pages=None):
    return output_record(path, 'pdf', None, pages)


def make_item(input_name, outputs, error=None):
    outs = [o for o in (outputs or []) if isinstance(o, dict) and o.get('path')]
    if error is None and not outs:
        error = {'code': 'NO_OUTPUT', 'message': '没有产生任何结果文件',
                 'hint': '请检查文件是否为有效 PDF 或调整参数后重试'}
    return {
        'input': str(input_name or 'document'),
        'ok': error is None,
        'outputs': outs if error is None else [],
        'error': None if error is None else error,
    }


def error_of(exc):
    if isinstance(exc, EngineError):
        return exc.payload()
    return {'code': 'ITEM_FAILED', 'message': str(exc) or '处理失败', 'hint': ''}


def error_dict(code, message, hint=''):
    return {'code': str(code), 'message': str(message), 'hint': str(hint or '')}


def bundle_zip(ctx, entries, base, suffix='_files'):
    """Zip ``(path, name)`` pairs into the output dir; returns an output record."""
    valid = [(p, n) for p, n in (entries or []) if p and os.path.isfile(p)]
    if not valid:
        return None
    path = out_path(ctx, base, suffix, 'zip')
    used = set()
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
        for src, name in valid:
            inner = os.path.basename(sanitize_name(name)) or 'file'
            root, ext = os.path.splitext(inner)
            candidate = inner
            number = 0
            while candidate in used:
                number += 1
                candidate = '%s-%d%s' % (root, number, ext)
            used.add(candidate)
            archive.write(src, arcname=candidate)
    return output_record(path, 'zip')


# --------------------------------------------------------------------------- #
# page ranges
# --------------------------------------------------------------------------- #

_RANGE_SEPARATORS = re.compile(r'[,;，；、\s]+')
_RANGE_PAIR = re.compile(r'^(\d+)\s*[-~–—]\s*(\d+)$')
_RANGE_FROM = re.compile(r'^(\d+)\s*[-~–—]$')
_RANGE_TO = re.compile(r'^[-~–—]\s*(\d+)$')


def _range_token(token, page_count):
    """Expand one range token into 0-based page indexes (unclamped)."""
    text = str(token or '').strip()
    if not text:
        return []
    if text.lower() in ('all', '*', '全部', '全'):
        return list(range(page_count))
    match = _RANGE_PAIR.match(text)
    if match:
        start, end = int(match.group(1)), int(match.group(2))
        if start > end:
            start, end = end, start
        return list(range(start - 1, end))
    match = _RANGE_FROM.match(text)
    if match:
        return list(range(int(match.group(1)) - 1, page_count))
    match = _RANGE_TO.match(text)
    if match:
        return list(range(0, int(match.group(1))))
    if text.isdigit():
        return [int(text) - 1]
    raise fail('BAD_RANGE', '页码范围格式不正确：%s' % text,
               '支持 1-3,5,8- 形式，留空表示全部页面')


def parse_page_range(text, page_count):
    """Parse ``1-3,5,8-`` into a sorted list of 0-based indexes.

    Empty input means "every page"; out-of-range values are clamped away.
    """
    page_count = int(page_count or 0)
    if page_count <= 0:
        return []
    raw = '' if text is None else str(text).strip()
    if not raw:
        return list(range(page_count))
    selected = []
    for token in _RANGE_SEPARATORS.split(raw):
        for index in _range_token(token, page_count):
            if 0 <= index < page_count and index not in selected:
                selected.append(index)
    if not selected:
        raise fail('BAD_RANGE', '页码范围没有落在 1-%d 内：%s' % (page_count, raw),
                   '请检查页码范围后重试')
    return sorted(selected)


def parse_range_groups(text, page_count):
    """Parse ``1-3,4-6,7-`` into *groups*, one output file per group."""
    page_count = int(page_count or 0)
    if page_count <= 0:
        return []
    raw = '' if text is None else str(text).strip()
    if not raw:
        return [list(range(page_count))]
    groups = []
    for chunk in re.split(r'[,;，；]+', raw):
        chunk = chunk.strip()
        if not chunk:
            continue
        indexes = [i for i in _range_token(chunk, page_count) if 0 <= i < page_count]
        if indexes:
            groups.append(indexes)
    if not groups:
        raise fail('BAD_RANGE', '分段页码范围没有落在 1-%d 内：%s' % (page_count, raw),
                   '例如 1-3,4-6,7- 表示拆成三个文件')
    return groups


# --------------------------------------------------------------------------- #
# opening & saving PDFs
# --------------------------------------------------------------------------- #

def input_paths(ctx):
    paths = []
    for entry in ctx.inputs:
        if isinstance(entry, dict) and entry.get('path'):
            paths.append((str(entry['path']), str(entry.get('name') or os.path.basename(str(entry['path'])))))
    return paths


def single_input(ctx):
    pairs = input_paths(ctx)
    if not pairs:
        raise fail('NO_INPUT', '没有收到输入文件', '请重新上传文件后重试')
    path, name = pairs[0]
    if not os.path.isfile(path):
        raise fail('BAD_FILE', '输入文件不存在或已被清理', '请重新上传文件后重试')
    return path, name


def open_pdf(path, password=None):
    """Open a PDF, translating every failure into a typed EngineError."""
    require_fitz()
    if not path or not os.path.isfile(path):
        raise fail('BAD_FILE', '文件不存在或已被清理', '请重新上传文件后重试')
    if os.path.getsize(path) == 0:
        raise fail('BAD_PDF', '文件不是有效的 PDF 或已损坏', '文件大小为 0，请重新上传')
    try:
        doc = fitz.open(path)
    except Exception:
        raise fail('BAD_PDF', '文件不是有效的 PDF 或已损坏', '请确认文件完整后重试')
    if getattr(doc, 'needs_pass', False):
        if password is None or str(password) == '':
            raise fail('NEED_PASSWORD', '该 PDF 已加密，请提供密码', '请先到「文档编辑工具箱 → PDF 解密」输入密码移除保护，再处理该文件')
        try:
            authenticated = doc.authenticate(str(password))
        except Exception:
            authenticated = 0
        if not authenticated:
            raise fail('WRONG_PASSWORD', '密码不正确，无法打开该 PDF', '请核对密码后重试')
    if doc.page_count <= 0:
        raise fail('EMPTY_PDF', '该 PDF 没有任何页面', '请换一个文件后重试')
    return doc


def save_pdf(doc, path, **kwargs):
    """Save a PDF, degrading optional compression flags if this build rejects them."""
    options = {'garbage': 4, 'deflate': True, 'clean': True}
    options.update(kwargs)
    attempts = [dict(options), {'garbage': 4, 'deflate': True}, {}]
    last = None
    for attempt in attempts:
        try:
            doc.save(path, **attempt)
            return path
        except Exception as exc:
            last = exc
            try:
                if os.path.exists(path):
                    os.remove(path)
            except OSError:
                pass
    raise fail('SAVE_FAILED', '无法写出 PDF 文件：%s' % last, '请检查磁盘空间与输出目录权限')


def save_encrypted(doc, path, user_pw, owner_pw, permissions):
    """Save with AES-256 encryption. Encryption is never silently dropped."""
    require_fitz()
    base = {
        'garbage': 4, 'deflate': True, 'clean': True,
        'encryption': fitz.PDF_ENCRYPT_AES_256,
        'user_pw': user_pw, 'owner_pw': owner_pw, 'permissions': int(permissions),
    }
    last = None
    for attempt in (dict(base), {k: v for k, v in base.items() if k != 'clean'}):
        try:
            doc.save(path, **attempt)
            return path
        except Exception as exc:
            last = exc
            try:
                if os.path.exists(path):
                    os.remove(path)
            except OSError:
                pass
    raise fail('SAVE_FAILED', '无法写出加密 PDF：%s' % last, '请检查磁盘空间与输出目录权限')


def verify_pdf(path, expected_pages=None):
    """Re-open a freshly written PDF and assert it is readable."""
    require_fitz()
    try:
        check = fitz.open(path)
    except Exception:
        raise fail('BAD_OUTPUT', '生成的 PDF 无法重新打开，文件可能已损坏', '请重试或更换参数')
    try:
        count = check.page_count
        if count <= 0:
            raise fail('BAD_OUTPUT', '生成的 PDF 没有页面', '请重试或更换参数')
        if expected_pages is not None and count != int(expected_pages):
            raise fail('BAD_OUTPUT', '生成的 PDF 页数不符（%d ≠ %d）' % (count, int(expected_pages)),
                       '请重试或更换参数')
        if count:
            check[0].get_pixmap(dpi=24)          # force a render to catch broken pages
        return count
    finally:
        try:
            check.close()
        except Exception:
            pass


def doc_meta(doc):
    try:
        return doc.metadata or {}
    except Exception:
        return {}


# --------------------------------------------------------------------------- #
# geometry / colours / sizes
# --------------------------------------------------------------------------- #

def parse_color(value, default=(0.0, 0.0, 0.0)):
    if value is None:
        return default
    if isinstance(value, (list, tuple)) and len(value) == 3:
        try:
            return tuple(clamp(float(c), 0.0, 1.0) for c in value)
        except (TypeError, ValueError):
            return default
    text = str(value).strip()
    if not text:
        return default
    if text.lower().startswith('rgb'):
        numbers = re.findall(r'[\d.]+', text)
        if len(numbers) >= 3:
            return tuple(clamp(float(n) / 255.0, 0.0, 1.0) for n in numbers[:3])
        return default
    if text.startswith('#'):
        text = text[1:]
    if len(text) == 3:
        text = ''.join(ch * 2 for ch in text)
    if re.fullmatch(r'[0-9a-fA-F]{6}', text):
        return tuple(int(text[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    return default


def color_hex(rgb):
    return '#%02x%02x%02x' % tuple(int(round(clamp(c, 0, 1) * 255)) for c in rgb)


def target_page_size(ctx, page=None):
    """Resolve ``sizePreset`` / ``customWidth`` / ``unit`` / ``orientation``."""
    preset = str(ctx.raw('sizePreset') or 'A4')
    unit = str(ctx.raw('unit') or 'mm').lower()
    if preset == 'custom':
        width = ctx.number('customWidth', 210.0)
        height = ctx.number('customHeight', 297.0)
        factor = {'mm': MM, 'in': INCH, 'px': PX96, 'pt': 1.0}.get(unit, MM)
        width_pt, height_pt = width * factor, height * factor
        if width_pt <= 1 or height_pt <= 1:
            raise fail('BAD_PARAMS', '自定义尺寸不合法', '宽度与高度都必须大于 0')
        if width_pt > 20000 or height_pt > 20000:
            raise fail('BAD_PARAMS', '自定义尺寸超出 PDF 支持范围', '请把尺寸控制在 20000pt 以内')
    else:
        if preset not in PAPER:
            raise fail('BAD_PARAMS', '不支持的纸张规格：%s' % preset, '请在参数面板重新选择纸张')
        width_pt, height_pt = PAPER[preset]
    orientation = str(ctx.raw('orientation') or 'auto').lower()
    if orientation == 'portrait':
        if width_pt > height_pt:
            width_pt, height_pt = height_pt, width_pt
    elif orientation == 'landscape':
        if width_pt < height_pt:
            width_pt, height_pt = height_pt, width_pt
    elif page is not None:
        source_landscape = page.rect.width > page.rect.height
        if source_landscape != (width_pt > height_pt):
            width_pt, height_pt = height_pt, width_pt
    return (round(width_pt, 3), round(height_pt, 3))


def preset_name(ctx):
    preset = str(ctx.raw('sizePreset') or 'A4')
    if preset == 'custom':
        return 'custom'
    return preset if preset in PAPER else 'A4'


def content_rect_for(width, height, margin_pt):
    rect = fitz.Rect(margin_pt, margin_pt, width - margin_pt, height - margin_pt)
    if rect.width < 8 or rect.height < 8:
        raise fail('BAD_PARAMS', '留白边距过大，页面已没有可用内容区域', '请减小留边距或换更大的纸张')
    return rect


def mm_rect(page, top, bottom, left, right):
    """Build a crop rectangle from the four manual margins (in points)."""
    rect = fitz.Rect(left, top, page.rect.width - right, page.rect.height - bottom)
    return rect


def union_rect(rects):
    valid = [r for r in rects if rect_ok(r)]
    if not valid:
        return None
    rect = fitz.Rect(valid[0])
    for other in valid[1:]:
        rect = rect | other
    return rect


def intersect_page_rect(page, rect):
    page_rect = page.rect
    result = fitz.Rect(rect) & page_rect
    return result if rect_ok(result) else None


def rect_ok(rect):
    """True when a rectangle is finite and non-empty (API-version tolerant)."""
    if rect is None:
        return False
    try:
        if rect.is_empty or rect.is_infinite:
            return False
    except AttributeError:
        if rect.width <= 0 or rect.height <= 0:
            return False
    try:
        if hasattr(rect, 'is_valid') and not rect.is_valid:
            return False
    except Exception:
        pass
    return True


# --------------------------------------------------------------------------- #
# text files, LibreOffice, page rendering
# --------------------------------------------------------------------------- #

def read_text_file(path):
    data = open(path, 'rb').read()
    for encoding in ('utf-8-sig', 'utf-8', 'gb18030', 'big5', 'latin-1'):
        try:
            return data.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode('utf-8', errors='replace')


def find_soffice():
    candidates = [
        os.environ.get('PDFW_SOFFICE'),
        '/Applications/LibreOffice.app/Contents/MacOS/soffice',
        '/usr/local/bin/soffice',
        '/opt/homebrew/bin/soffice',
        '/usr/bin/soffice',
    ]
    try:
        candidates.append(shutil.which('soffice'))
    except Exception:
        pass
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return candidate
    return None


def libreoffice_convert(src, out_dir, timeout=300):
    """Convert one Office file to PDF with headless LibreOffice; returns the PDF path."""
    soffice = find_soffice()
    if not soffice:
        raise fail('LIBREOFFICE_MISSING', '未找到 LibreOffice，无法把 Office 文件转成 PDF',
                   '请安装 LibreOffice，或先把文件另存为 PDF 再上传')
    os.makedirs(out_dir, exist_ok=True)
    profile = tempfile.mkdtemp(prefix='pdfw-lo-')
    command = [
        soffice,
        '-env:UserInstallation=file://' + profile,
        '--headless', '--norestore', '--nolockcheck', '--nodefault',
        '--convert-to', 'pdf', '--outdir', out_dir, src,
    ]
    try:
        proc = subprocess.run(command, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise fail('CONVERT_TIMEOUT', 'Office 文件转 PDF 超时（超过 %d 秒）' % timeout,
                   '请尝试减小文件体积或拆分成多个文件')
    except Exception as exc:
        raise fail('CONVERT_FAILED', 'Office 文件转 PDF 失败：%s' % exc, '请确认 LibreOffice 可正常启动')
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    stem = os.path.splitext(os.path.basename(src))[0]
    expected = os.path.join(out_dir, stem + '.pdf')
    if os.path.isfile(expected) and os.path.getsize(expected) > 0:
        return expected
    newest, newest_time = None, -1.0
    try:
        for entry in os.listdir(out_dir):
            if not entry.lower().endswith('.pdf'):
                continue
            candidate = os.path.join(out_dir, entry)
            try:
                stamp = os.path.getmtime(candidate)
            except OSError:
                continue
            if stamp > newest_time:
                newest, newest_time = candidate, stamp
    except OSError:
        pass
    if newest:
        return newest
    detail = ''
    try:
        detail = (proc.stderr or b'').decode('utf-8', errors='ignore').strip()[-300:]
    except Exception:
        pass
    raise fail('CONVERT_FAILED', 'Office 文件转 PDF 失败：%s' % (detail or '转换器没有输出 PDF'),
               '请确认文件未损坏，或先把它另存为 PDF 后上传')


def render_page_png(page, dpi=150, format_name='png', quality=88):
    """Render one page to encoded image bytes (never keeps more than one page)."""
    require_fitz()
    zoom = clamp(float(dpi), 12.0, 600.0) / 72.0
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    if format_name in ('jpg', 'jpeg'):
        if pix.n != 3:
            pix = fitz.Pixmap(fitz.csRGB, pix)
        data = pix.tobytes('jpeg', jpg_quality=int(clamp(quality, 5, 100)))
        return data, 'jpg', pix.width, pix.height
    data = pix.tobytes('png')
    return data, 'png', pix.width, pix.height


def content_bbox_pixels(page, threshold=245, dpi=72):
    """Detect the visible (non-white) box of a page, returned in page points."""
    Image = pil_image_module()
    zoom = dpi / 72.0
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csGRAY, alpha=False)
    width, height = pix.width, pix.height
    if width < 2 or height < 2:
        return None
    image = Image.frombytes('L', (width, height), bytes(pix.samples))
    # content becomes white (255), background black (0) -> getbbox of content
    binary = image.point(lambda value: 255 if value <= threshold else 0)
    box = binary.getbbox()
    if not box:
        return None
    left, top, right, bottom = box
    return fitz.Rect(left / zoom, top / zoom, right / zoom, bottom / zoom)


# --------------------------------------------------------------------------- #
# shared PDF building blocks
# --------------------------------------------------------------------------- #

def wrap_text(text, font, fontsize, max_width):
    """Greedy character wrap that also respects explicit newlines."""
    lines = []
    for paragraph in str(text).split('\n'):
        if not paragraph:
            lines.append('')
            continue
        current = ''
        for char in paragraph:
            trial = current + char
            if current and font.text_length(trial, fontsize) > max_width:
                lines.append(current)
                current = char
            else:
                current = trial
        if current:
            lines.append(current)
    return lines


def pdf_writer(out_path, page_size=None, fontname='china-s'):
    """Create a paginated PDF writer that wraps text with the built-in CJK font."""
    require_fitz()
    doc = fitz.open()
    width, height = page_size or PAPER['A4']
    margin = 56.0
    font = fitz.Font(fontname)
    state = {'page': doc.new_page(width=width, height=height), 'y': margin}

    def new_page():
        state['page'] = doc.new_page(width=width, height=height)
        state['y'] = margin

    def ensure(needed):
        if state['y'] + needed > height - margin:
            new_page()

    def add_text(text, size=11.0, color=(0, 0, 0), indent=0.0, space_before=0.0,
                 italic=False, line_height=1.6):
        wrapped = wrap_text(str(text), font, size, width - 2 * margin - indent)
        if space_before:
            state['y'] += space_before
        for line in wrapped:
            step = size * line_height
            ensure(step)
            if line:
                state['page'].insert_text(
                    (margin + indent, state['y'] + size),
                    line, fontname=fontname, fontsize=size, color=color)
            state['y'] += step

    def add_rule():
        state['y'] += 6
        ensure(2)
        state['page'].draw_line((margin, state['y']), (width - margin, state['y']),
                                color=(0.75, 0.75, 0.75), width=0.6)
        state['y'] += 8

    def finish():
        if doc.page_count == 0:
            doc.new_page(width=width, height=height)
        save_pdf(doc, out_path)
        pages = doc.page_count
        try:
            doc.close()
        except Exception:
            pass
        return pages

    return {'doc': doc, 'add_text': add_text, 'add_rule': add_rule, 'finish': finish,
            'page_size': (width, height), 'margin': margin}


# --------------------------------------------------------------------------- #
# shared table / docx helpers
# --------------------------------------------------------------------------- #

def page_tables(page):
    """Return the detected tables of one page (empty list when unsupported)."""
    if not hasattr(page, 'find_tables'):
        return []
    try:
        finder = page.find_tables()
        return list(getattr(finder, 'tables', []) or [])
    except Exception:
        return []


def table_rows(table):
    try:
        rows = table.extract()
    except Exception:
        return []
    cleaned = []
    for row in rows or []:
        cells = ['' if cell is None else str(cell).strip() for cell in row]
        if any(cells):
            cleaned.append(cells)
    return cleaned


CJK_RE = re.compile(r'[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]')


def has_cjk(text):
    return bool(CJK_RE.search(str(text or '')))


def _docx_apply_run(run, size=None, bold=None, italic=None, color=None, font_name=None):
    try:
        from docx.shared import Pt, RGBColor
        if size:
            run.font.size = Pt(clamp(float(size), 4.0, 72.0))
        if bold is not None:
            run.bold = bool(bold)
        if italic is not None:
            run.italic = bool(italic)
        if color is not None:
            run.font.color.rgb = RGBColor(*[int(clamp(c, 0.0, 1.0) * 255) for c in color])
        if font_name:
            run.font.name = font_name
            rpr = run._element.get_or_add_rPr()
            from docx.oxml.ns import qn
            rfonts = rpr.find(qn('w:rFonts'))
            if rfonts is None:
                from docx.oxml import OxmlElement
                rfonts = OxmlElement('w:rFonts')
                rpr.insert(0, rfonts)
            rfonts.set(qn('w:eastAsia'), font_name)
    except Exception:
        pass


def _docx_add_table(target, rows, max_cols=12):
    if not rows:
        return
    rows = [row[:max_cols] for row in rows]
    cols = max(len(row) for row in rows)
    if cols <= 0:
        return
    table = target.add_table(rows=len(rows), cols=cols)
    try:
        table.style = 'Table Grid'
    except Exception:
        pass
    for row_index, row in enumerate(rows):
        for col_index in range(cols):
            value = row[col_index] if col_index < len(row) else ''
            cell = table.cell(row_index, col_index)
            cell.text = ''
            paragraph = cell.paragraphs[0]
            run = paragraph.add_run(str(value))
            _docx_apply_run(run, size=9.5, bold=(row_index == 0))


def _docx_add_image(target, data, width_pt, left_indent_pt=None):
    """Insert one embedded image, converting exotic formats through Pillow."""
    from docx.shared import Pt
    payload = data
    suffix = None
    try:
        Image = pil_image_module()
        image = Image.open(io.BytesIO(data))
        image.load()
        kind = (image.format or '').upper()
        if kind not in ('PNG', 'JPEG', 'JPG', 'GIF', 'BMP', 'TIFF', 'WMF', 'EMF'):
            buffer = io.BytesIO()
            image.convert('RGB').save(buffer, 'PNG')
            payload = buffer.getvalue()
    except Exception:
        pass
    paragraph = target.add_paragraph()
    if left_indent_pt is not None:
        try:
            paragraph.paragraph_format.left_indent = Pt(max(0.0, float(left_indent_pt)))
        except Exception:
            pass
    run = paragraph.add_run()
    try:
        run.add_picture(io.BytesIO(payload), width=Pt(max(10.0, float(width_pt))))
    except Exception:
        try:
            Image = pil_image_module()
            image = Image.open(io.BytesIO(data)).convert('RGB')
            buffer = io.BytesIO()
            image.save(buffer, 'PNG')
            run.add_picture(io.BytesIO(buffer.getvalue()), width=Pt(max(10.0, float(width_pt))))
        except Exception:
            return False
    return True


def _needs_space(previous_char, next_char):
    if not previous_char or not next_char:
        return False
    if has_cjk(previous_char) or has_cjk(next_char):
        return False
    if previous_char in '，。、；：！？）」』】》':
        return False
    if next_char in '，。、；：！？）」』】》':
        return False
    return True


def _block_lines(block):
    lines = []
    for line in block.get('lines', []) or []:
        spans = [s for s in (line.get('spans') or []) if str(s.get('text') or '')]
        if spans:
            lines.append(spans)
    return lines


# --------------------------------------------------------------------------- #
# op: pdf2word
# --------------------------------------------------------------------------- #

def op_pdf2word(ctx):
    require_fitz()
    docx_module = lazy_import('docx', 'DOCX_MISSING', '缺少 python-docx，无法生成 Word 文档',
                              '请把 python-docx 安装到运行环境后重试')
    from docx.shared import Pt

    path, name = single_input(ctx)
    doc = open_pdf(path)
    layout = ctx.choice('layout', 'flow', ('flow', 'positioned'))
    keep_images = ctx.flag('keepImages', True)
    pages = parse_page_range(ctx.text('pageRange'), doc.page_count)
    base = base_of(name)

    target = docx_module.Document()
    section = target.sections[0]
    first_page = doc[pages[0]]
    if layout == 'positioned':
        section.page_width = Pt(first_page.rect.width)
        section.page_height = Pt(first_page.rect.height)
        section.left_margin = Pt(18)
        section.right_margin = Pt(18)
        section.top_margin = Pt(18)
        section.bottom_margin = Pt(18)
    else:
        section.page_width = Pt(PAPER['A4'][0])
        section.page_height = Pt(PAPER['A4'][1])
        section.left_margin = Pt(56)
        section.right_margin = Pt(56)
        section.top_margin = Pt(56)
        section.bottom_margin = Pt(56)
    content_width = first_page.rect.width - 36.0

    emitted = 0
    for position, pno in enumerate(pages):
        page = doc[pno]
        if position:
            target.add_page_break()
        tables = page_tables(page)
        table_rects = []
        for table in tables:
            try:
                table_rects.append(fitz.Rect(table.bbox))
            except Exception:
                continue
        elements = []
        for table in tables:
            try:
                elements.append((fitz.Rect(table.bbox), 'table', table))
            except Exception:
                continue
        try:
            blocks = (page.get_text('dict') or {}).get('blocks', [])
        except Exception:
            blocks = []
        for block in blocks:
            try:
                rect = fitz.Rect(block.get('bbox'))
            except Exception:
                continue
            in_table = False
            for table_rect in table_rects:
                centre = fitz.Point((rect.x0 + rect.x1) / 2.0, (rect.y0 + rect.y1) / 2.0)
                if table_rect.contains(centre) or table_rect.intersects(rect):
                    in_table = True
                    break
            if in_table and block.get('type') != 1:
                continue
            if block.get('type') == 1:
                if keep_images and block.get('image'):
                    elements.append((rect, 'image', block))
            elif block.get('lines'):
                elements.append((rect, 'text', block))
        elements.sort(key=lambda item: (round(item[0].y0, 1), round(item[0].x0, 1)))

        previous_bottom = None
        for rect, kind, payload in elements:
            if kind == 'table':
                _docx_add_table(target, table_rows(payload))
                previous_bottom = rect.y1
                emitted += 1
                continue
            if kind == 'image':
                width = min(rect.width if rect.width > 4 else content_width, content_width)
                indent = (rect.x0 - first_page.rect.x0) if layout == 'positioned' else None
                if _docx_add_image(target, payload['image'], width, indent):
                    emitted += 1
                previous_bottom = rect.y1
                continue
            lines = _block_lines(payload)
            if not lines:
                continue
            if layout == 'positioned':
                for line in lines:
                    try:
                        line_rect = fitz.Rect(line[0].get('bbox'))
                        for span in line[1:]:
                            line_rect = line_rect | fitz.Rect(span.get('bbox'))
                    except Exception:
                        continue
                    paragraph = target.add_paragraph()
                    paragraph.paragraph_format.left_indent = Pt(max(0.0, line_rect.x0 - first_page.rect.x0))
                    if previous_bottom is not None:
                        gap = line_rect.y0 - previous_bottom
                        if gap > 1.5:
                            paragraph.paragraph_format.space_before = Pt(min(gap, 60.0))
                    for span in line:
                        text = str(span.get('text') or '')
                        if not text:
                            continue
                        size = span.get('size') or 11.0
                        flags = int(span.get('flags') or 0)
                        color_int = int(span.get('color') or 0)
                        color = (((color_int >> 16) & 0xFF) / 255.0,
                                 ((color_int >> 8) & 0xFF) / 255.0,
                                 (color_int & 0xFF) / 255.0)
                        run = paragraph.add_run(text)
                        _docx_apply_run(run, size=size, bold=bool(flags & 16),
                                        italic=bool(flags & 2), color=color,
                                        font_name='宋体' if has_cjk(text) else 'Calibri')
                    previous_bottom = line_rect.y1
                    emitted += 1
            else:
                paragraph = target.add_paragraph()
                try:
                    paragraph.paragraph_format.space_after = Pt(6)
                    paragraph.paragraph_format.line_spacing = 1.15
                except Exception:
                    pass
                first_span = True
                previous_char = ''
                for line in lines:
                    for span in line:
                        text = str(span.get('text') or '')
                        if not text:
                            continue
                        if not first_span and _needs_space(previous_char, text[0]):
                            space_run = paragraph.add_run(' ')
                            _docx_apply_run(space_run, size=span.get('size') or 11.0)
                        size = span.get('size') or 11.0
                        flags = int(span.get('flags') or 0)
                        run = paragraph.add_run(text)
                        _docx_apply_run(run, size=size, bold=bool(flags & 16),
                                        italic=bool(flags & 2),
                                        font_name='宋体' if has_cjk(text) else 'Calibri')
                        previous_char = text[-1]
                        first_span = False
                emitted += 1
        page_progress(position, len(pages), '正在转换第 %d 页' % (pno + 1))

    if emitted == 0:
        target.add_paragraph('该 PDF 没有可提取的文字层（可能是扫描件）。可先使用「OCR 文字识别」生成文字层。')
    out = out_path(ctx, base, '_word', 'docx')
    try:
        target.save(out)
    except Exception as exc:
        raise fail('SAVE_FAILED', '无法写出 Word 文档：%s' % exc, '请检查输出目录权限与磁盘空间')
    doc.close()
    return [make_item(name, [output_record(out, 'docx')])]


# --------------------------------------------------------------------------- #
# op: pdf2excel
# --------------------------------------------------------------------------- #

_ILLEGAL_SHEET = re.compile(r'[\[\]:*?/\\]')


def _sheet_name(raw, workbook):
    name = _ILLEGAL_SHEET.sub('_', str(raw or 'Sheet')).strip() or 'Sheet'
    name = name[:31]
    existing = {ws.title for ws in workbook.worksheets}
    candidate = name
    index = 1
    while candidate in existing:
        index += 1
        suffix = '(%d)' % index
        candidate = name[:31 - len(suffix)] + suffix
    return candidate


def _clean_cell(value):
    if value is None:
        return ''
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    text = str(value).strip()
    if len(text) <= 15:
        if re.fullmatch(r'-?(?:0|[1-9]\d{0,13})', text):
            return int(text)
        if re.fullmatch(r'-?(?:0|[1-9]\d{0,11})\.\d{1,6}', text):
            return float(text)
    return text


def _text_grid(page):
    rows = []
    try:
        text = page.get_text('text') or ''
    except Exception:
        text = ''
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        cells = re.split(r'\s{2,}|\t', line.strip())
        rows.append([cell for cell in cells if cell != ''])
    return rows


def _write_sheet(worksheet, rows, header_bold=True):
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    if not rows:
        rows = [['（空）']]
    bold_font = Font(bold=True)
    header_fill = PatternFill('solid', fgColor='EEF2F8')
    width = max(len(row) for row in rows)
    for row_index, row in enumerate(rows, start=1):
        for col_index in range(1, width + 1):
            value = row[col_index - 1] if col_index - 1 < len(row) else ''
            cell = worksheet.cell(row=row_index, column=col_index, value=_clean_cell(value))
            cell.alignment = Alignment(vertical='top', wrap_text=True)
            if row_index == 1 and header_bold:
                cell.font = bold_font
                cell.fill = header_fill
    for col_index in range(1, width + 1):
        longest = 8
        for row in rows:
            if col_index - 1 < len(row):
                longest = max(longest, len(str(row[col_index - 1])))
        worksheet.column_dimensions[get_column_letter(col_index)].width = min(60.0, longest * 1.25 + 2)
    if header_bold:
        worksheet.freeze_panes = 'A2'


def op_pdf2excel(ctx):
    require_fitz()
    openpyxl = lazy_import('openpyxl', 'OPENPYXL_MISSING', '缺少 openpyxl，无法生成 Excel 文档',
                           '请把 openpyxl 安装到运行环境后重试')
    path, name = single_input(ctx)
    doc = open_pdf(path)
    split_by = ctx.choice('splitBy', 'table', ('table', 'page'))
    pages = parse_page_range(ctx.text('pageRange'), doc.page_count)
    base = base_of(name)

    workbook = openpyxl.Workbook()
    workbook.remove(workbook.active)
    sheets = 0
    for position, pno in enumerate(pages):
        page = doc[pno]
        tables = page_tables(page)
        try:
            if split_by == 'table' and tables:
                for table in tables:
                    rows = table_rows(table)
                    if not rows:
                        continue
                    sheets += 1
                    worksheet = workbook.create_sheet(_sheet_name('表%d' % sheets, workbook))
                    _write_sheet(worksheet, rows)
            else:
                sheets += 1
                worksheet = workbook.create_sheet(_sheet_name('第%d页' % (pno + 1), workbook))
                rows = []
                for table in tables:
                    rows.extend(table_rows(table))
                    rows.append([])
                if not [row for row in rows if any(cell != '' for cell in row)]:
                    rows = _text_grid(page)
                _write_sheet(worksheet, rows)
        except Exception as exc:
            ctx.warn('第 %d 页写入表格失败：%s' % (pno + 1, exc))
        page_progress(position, len(pages), '正在识别第 %d 页表格' % (pno + 1))

    if not workbook.worksheets:
        worksheet = workbook.create_sheet('说明')
        worksheet['A1'] = '未能从该 PDF 中识别到表格或文字'
        worksheet['A2'] = '处理时间：%s' % time.strftime('%Y-%m-%d %H:%M:%S')
    out = out_path(ctx, base, '_excel', 'xlsx')
    try:
        workbook.save(out)
    except Exception as exc:
        raise fail('SAVE_FAILED', '无法写出 Excel 文档：%s' % exc, '请检查输出目录权限与磁盘空间')
    doc.close()
    return [make_item(name, [output_record(out, 'xlsx')])]


# --------------------------------------------------------------------------- #
# op: pdf2ppt
# --------------------------------------------------------------------------- #

def op_pdf2ppt(ctx):
    require_fitz()
    pptx_module = lazy_import('pptx', 'PPTX_MISSING', '缺少 python-pptx，无法生成 PPT 文档',
                              '请把 python-pptx 安装到运行环境后重试')
    from pptx.util import Emu, Pt

    path, name = single_input(ctx)
    doc = open_pdf(path)
    layout = ctx.choice('layout', 'image', ('image', 'editable'))
    dpi = clamp(ctx.number('dpi', 144), 36, 300)
    pages = parse_page_range(ctx.text('pageRange'), doc.page_count)
    base = base_of(name)
    first = doc[pages[0]]

    presentation = pptx_module.Presentation()
    slide_width = Emu(int(first.rect.width * 12700))
    slide_height = Emu(int(first.rect.height * 12700))
    presentation.slide_width = slide_width
    presentation.slide_height = slide_height
    blank_layout = presentation.slide_layouts[6] if len(presentation.slide_layouts) > 6 else presentation.slide_layouts[-1]

    for position, pno in enumerate(pages):
        page = doc[pno]
        slide = presentation.slides.add_slide(blank_layout)
        if layout == 'image':
            data, _ext, _width, _height = render_page_png(page, dpi, 'png')
            slide.shapes.add_picture(io.BytesIO(data), 0, 0, width=slide_width, height=slide_height)
        else:
            page_width = page.rect.width
            page_height = page.rect.height
            try:
                blocks = (page.get_text('dict') or {}).get('blocks', [])
            except Exception:
                blocks = []
            for block in blocks:
                try:
                    rect = fitz.Rect(block.get('bbox'))
                except Exception:
                    continue
                if block.get('type') == 1 and block.get('image'):
                    width = max(8.0, rect.width)
                    height = max(8.0, rect.height)
                    try:
                        slide.shapes.add_picture(
                            io.BytesIO(block['image']),
                            Emu(int(rect.x0 * 12700)), Emu(int(rect.y0 * 12700)),
                            width=Emu(int(width * 12700)), height=Emu(int(height * 12700)))
                    except Exception:
                        continue
                    continue
                lines = _block_lines(block)
                if not lines:
                    continue
                text = '\n'.join(''.join(str(s.get('text') or '') for s in line) for line in lines)
                if not text.strip():
                    continue
                sizes = [float(s.get('size') or 11.0) for line in lines for s in line]
                font_size = clamp(max(sizes) if sizes else 11.0, 6.0, 96.0)
                box = slide.shapes.add_textbox(
                    Emu(int(rect.x0 * 12700)), Emu(int(rect.y0 * 12700)),
                    Emu(int(max(8.0, min(rect.width, page_width)) * 12700)),
                    Emu(int(max(8.0, min(rect.height, page_height)) * 12700)))
                frame = box.text_frame
                frame.word_wrap = True
                try:
                    frame.margin_left = 0
                    frame.margin_right = 0
                    frame.margin_top = 0
                    frame.margin_bottom = 0
                except Exception:
                    pass
                frame.text = text
                for paragraph in frame.paragraphs:
                    for run in paragraph.runs:
                        run.font.size = Pt(font_size)
                        run.font.name = '宋体' if has_cjk(text) else 'Calibri'
        page_progress(position, len(pages), '正在生成第 %d 张幻灯片' % (pno + 1))

    out = out_path(ctx, base, '_ppt', 'pptx')
    try:
        presentation.save(out)
    except Exception as exc:
        raise fail('SAVE_FAILED', '无法写出 PPT 文档：%s' % exc, '请检查输出目录权限与磁盘空间')
    doc.close()
    return [make_item(name, [output_record(out, 'pptx', None, len(pages))])]


# --------------------------------------------------------------------------- #
# op: pdf2image
# --------------------------------------------------------------------------- #

def op_pdf2image(ctx):
    require_fitz()
    path, name = single_input(ctx)
    doc = open_pdf(path)
    image_format = ctx.choice('format', 'png', ('png', 'jpg'))
    dpi = clamp(ctx.number('dpi', 150), 36, 600)
    quality = int(clamp(ctx.number('quality', 88), 5, 100))
    pages = parse_page_range(ctx.text('pageRange'), doc.page_count)
    base = base_of(name)
    outputs = []
    entries = []
    for position, pno in enumerate(pages):
        page = doc[pno]
        data, extension, _width, _height = render_page_png(page, dpi, image_format, quality)
        file_name = '%s-%03d.%s' % (base, position + 1, extension)
        target = unique_path(ctx.ensure_out_dir(), file_name)
        with open(target, 'wb') as handle:
            handle.write(data)
        record = output_record(target, 'image')
        outputs.append(record)
        entries.append((target, os.path.basename(target)))
        page_progress(position, len(pages), '正在导出第 %d 页图片' % (pno + 1))
    doc.close()
    if len(entries) > 1:
        archive = bundle_zip(ctx, entries, base, '_images')
        if archive:
            outputs.append(archive)
    return [make_item(name, outputs)]


# --------------------------------------------------------------------------- #
# op: pdf2text
# --------------------------------------------------------------------------- #

def op_pdf2text(ctx):
    require_fitz()
    path, name = single_input(ctx)
    doc = open_pdf(path)
    keep_breaks = ctx.flag('includePageBreaks', True)
    pages = parse_page_range(ctx.text('pageRange'), doc.page_count)
    base = base_of(name)
    chunks = []
    for position, pno in enumerate(pages):
        page = doc[pno]
        try:
            text = page.get_text('text') or ''
        except Exception:
            text = ''
        text = text.replace('\x00', '').rstrip()
        if keep_breaks:
            chunks.append('===== 第 %d 页 =====\n%s' % (pno + 1, text))
        else:
            chunks.append(text)
        page_progress(position, len(pages), '正在提取第 %d 页文字' % (pno + 1))
    body = ('\n\n'.join(chunks) if keep_breaks else '\n'.join(chunks)).strip() + '\n'
    out = out_path(ctx, base, '', 'txt')
    with open(out, 'w', encoding='utf-8') as handle:
        handle.write(body)
    doc.close()
    return [make_item(name, [output_record(out, 'text', None, len(pages))])]


# --------------------------------------------------------------------------- #
# op: toPDF (Office / image / text -> PDF)
# --------------------------------------------------------------------------- #

def image_to_pdf(ctx, src, page_size, tmpdir):
    Image = pil_image_module()
    require_fitz()
    try:
        image = Image.open(src)
        image.load()
    except Exception:
        raise fail('BAD_IMAGE', '无法读取图片文件：%s' % os.path.basename(src), '请换一张图片后重试')
    width_px, height_px = image.size
    if width_px < 1 or height_px < 1:
        raise fail('BAD_IMAGE', '图片尺寸无效', '请换一张图片后重试')
    if image.mode in ('RGBA', 'LA') or (image.mode == 'P' and 'transparency' in image.info):
        rgba = image.convert('RGBA')
        background = Image.new('RGB', rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.split()[-1])
        image = background
    elif image.mode not in ('RGB', 'L'):
        image = image.convert('RGB')
    buffer = io.BytesIO()
    if image.mode == 'RGB':
        image.save(buffer, 'JPEG', quality=92)
    else:
        image.save(buffer, 'PNG')
    data = buffer.getvalue()

    doc = fitz.open()
    if page_size in ('A4', 'Letter'):
        page_width, page_height = PAPER[page_size]
        page = doc.new_page(width=page_width, height=page_height)
        inner = fitz.Rect(36, 36, page_width - 36, page_height - 36)
        page.insert_image(inner, stream=data, keep_proportion=True)
    else:
        page_width = max(16.0, width_px * PX96)
        page_height = max(16.0, height_px * PX96)
        scale = min(1.0, 14000.0 / max(page_width, page_height))
        page_width, page_height = page_width * scale, page_height * scale
        page = doc.new_page(width=page_width, height=page_height)
        page.insert_image(page.rect, stream=data, keep_proportion=True)
    out = unique_path(tmpdir, sanitize_name(base_of(src)) + '.pdf')
    save_pdf(doc, out, garbage=2)
    doc.close()
    return out


def text_to_pdf(ctx, src, page_size, tmpdir):
    require_fitz()
    text = read_text_file(src)
    size = PAPER.get(page_size) if page_size in PAPER else PAPER['A4']
    out = unique_path(tmpdir, sanitize_name(base_of(src)) + '.pdf')
    writer = pdf_writer(out, size)
    writer['add_text'](text or '（空文件）', 11.0)
    writer['finish']()
    return out


def _counter_dir(tmpdir, prefix):
    for index in range(1, 100000):
        candidate = os.path.join(tmpdir, '%s-%d' % (prefix, index))
        if not os.path.exists(candidate):
            os.makedirs(candidate, exist_ok=True)
            return candidate
    raise fail('INTERNAL', '无法创建临时目录', '')


def any_to_pdf(ctx, path, name, page_size, tmpdir):
    extension = ext_of(name) or ext_of(path)
    if not os.path.isfile(path):
        raise fail('BAD_FILE', '输入文件不存在或已被清理', '请重新上传文件后重试')
    if extension == '.pdf':
        probe = open_pdf(path)
        probe.close()
        return path
    if extension in OFFICE_EXTS:
        return libreoffice_convert(path, _counter_dir(tmpdir, 'office'))
    if extension in IMAGE_EXTS:
        return image_to_pdf(ctx, path, page_size, _counter_dir(tmpdir, 'image'))
    if extension in TEXT_EXTS:
        return text_to_pdf(ctx, path, page_size, _counter_dir(tmpdir, 'text'))
    return libreoffice_convert(path, _counter_dir(tmpdir, 'office'))


def op_toPDF(ctx):
    require_fitz()
    pairs = input_paths(ctx)
    if not pairs:
        raise fail('NO_INPUT', '没有收到输入文件', '请重新上传文件后重试')
    combine = ctx.flag('combine', False)
    page_size = str(ctx.raw('pageSize') or 'auto')
    tmpdir = tempfile.mkdtemp(prefix='pdfw-topdf-')
    items = []
    converted = []
    try:
        for index, (path, name) in enumerate(pairs):
            try:
                pdf_path = any_to_pdf(ctx, path, name, page_size, tmpdir)
                converted.append((name, pdf_path))
                if not combine:
                    target = out_path(ctx, base_of(name), '', 'pdf')
                    shutil.copyfile(pdf_path, target)
                    pages = verify_pdf(target)
                    fit = _apply_size_cap(ctx, target)
                    record = pdf_record(ctx, target, pages)
                    _attach_fit(record, fit)
                    items.append(make_item(name, [record]))
            except Exception as exc:
                items.append(make_item(name, [], error_of(exc)))
            page_progress(index, len(pairs), '正在转换 %s' % os.path.basename(name))
        if combine:
            if not converted:
                items.append(make_item('合并文档.pdf', [],
                                       error_dict('CONVERT_FAILED', '所有文件都转换失败',
                                                  '请检查文件格式与 LibreOffice 是否可用')))
            else:
                merged = fitz.open()
                toc = []
                try:
                    for source_name, pdf_path in converted:
                        source = fitz.open(pdf_path)
                        start = merged.page_count
                        merged.insert_pdf(source)
                        toc.append([1, base_of(source_name)[:120], start + 1])
                        source.close()
                    if len(toc) > 1:
                        try:
                            merged.set_toc(toc)
                        except Exception as exc:
                            ctx.warn('书签写入失败：%s' % exc)
                    title = base_of(converted[0][0]) if len(converted) == 1 else '合并文档'
                    target = out_path(ctx, title, '', 'pdf')
                    pages = merged.page_count
                    save_pdf(merged, target)
                finally:
                    merged.close()
                fit = _apply_size_cap(ctx, target)
                record = pdf_record(ctx, target, pages)
                _attach_fit(record, fit)
                items.append(make_item(os.path.basename(target), [record]))
        return items
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# --------------------------------------------------------------------------- #
# op: merge
# --------------------------------------------------------------------------- #

def op_merge(ctx):
    require_fitz()
    pairs = input_paths(ctx)
    if not pairs:
        raise fail('NO_INPUT', '没有收到输入文件', '请重新上传文件后重试')
    add_bookmarks = ctx.flag('addBookmarks', True)
    password = ctx.password() or None
    merged = fitz.open()
    toc = []
    items = []
    succeeded = 0
    try:
        for index, (path, name) in enumerate(pairs):
            try:
                source = open_pdf(path, password)
            except Exception as exc:
                items.append(make_item(name, [], error_of(exc)))
                page_progress(index, len(pairs), '正在合并 %s' % os.path.basename(name))
                continue
            try:
                start = merged.page_count
                merged.insert_pdf(source)
                added = merged.page_count - start
                succeeded += 1
                if add_bookmarks:
                    toc.append([1, base_of(name)[:120], start + 1])
                    try:
                        for level, title, page in source.get_toc(simple=True):
                            if 1 <= int(page) <= added:
                                toc.append([min(int(level) + 1, 6), str(title)[:120], start + int(page)])
                    except Exception:
                        pass
            except Exception as exc:
                items.append(make_item(name, [], error_of(fail('MERGE_FAILED', '合并 %s 失败：%s' % (name, exc), ''))))
            finally:
                try:
                    source.close()
                except Exception:
                    pass
            page_progress(index, len(pairs), '正在合并 %s' % os.path.basename(name))
        if succeeded == 0:
            return [item for item in items if not item['ok']] or [
                make_item('合并结果.pdf', [], error_dict('MERGE_FAILED', '所有文件都无法读取', '请检查文件是否为有效 PDF'))]
        if add_bookmarks and toc:
            try:
                merged.set_toc(toc[:2000])
            except Exception as exc:
                ctx.warn('书签写入失败：%s' % exc)
        target = out_path(ctx, base_of(pairs[0][1]), '_merged', 'pdf')
        pages = merged.page_count
        save_pdf(merged, target)
        fit = _apply_size_cap(ctx, target)
        record = pdf_record(ctx, target, pages)
        _attach_fit(record, fit)
        items.insert(0, make_item('合并结果.pdf', [record]))
        return items
    finally:
        try:
            merged.close()
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# op: split
# --------------------------------------------------------------------------- #

def _group_label(group):
    if not group:
        return 'part'
    if group == list(range(group[0], group[-1] + 1)):
        return '%d-%d' % (group[0] + 1, group[-1] + 1)
    return '-'.join(str(index + 1) for index in group[:6])


def _insert_group(source, group):
    new_doc = fitz.open()
    runs = []
    for index in group:
        if not runs or index != runs[-1][1] + 1:
            runs.append([index, index])
        else:
            runs[-1][1] = index
    for start, end in runs:
        new_doc.insert_pdf(source, from_page=start, to_page=end)
    return new_doc


def _groups_by_size(doc, path, limit_bytes):
    page_count = doc.page_count
    try:
        total = float(os.path.getsize(path))
    except OSError:
        total = float(page_count) * 1024.0
    per_page = max(1024.0, total / float(max(1, page_count))) * 1.08
    groups = []
    current = []
    estimate = 0.0
    for index in range(page_count):
        current.append(index)
        estimate += per_page
        if estimate >= limit_bytes and len(current) > 1:
            groups.append(current)
            current = []
            estimate = 0.0
    if current:
        groups.append(current)
    return groups or [list(range(page_count))]


def op_split(ctx):
    require_fitz()
    path, name = single_input(ctx)
    doc = open_pdf(path)
    count = doc.page_count
    mode = ctx.choice('mode', 'ranges', ('ranges', 'every', 'size'))
    base = base_of(name)
    outputs = []
    try:
        if mode == 'ranges':
            groups = parse_range_groups(ctx.text('ranges', '1-1,2-'), count)
            labels = [_group_label(group) for group in groups]
        elif mode == 'every':
            per_file = clamp(ctx.integer('pagesPerFile', 1), 1, 500)
            groups = [list(range(start, min(start + per_file, count)))
                      for start in range(0, count, per_file)]
            labels = ['part%d' % (index + 1) for index in range(len(groups))]
        else:
            max_mb = clamp(ctx.number('maxSizeMB', 5), 0.05, 200)
            limit = max_mb * 1024.0 * 1024.0
            pending = _groups_by_size(doc, path, limit)
            groups, labels = [], []
            tempdir = tempfile.mkdtemp(prefix='pdfw-split-')
            try:
                guard = 0
                while pending and guard < 5000:
                    guard += 1
                    group = pending.pop(0)
                    new_doc = _insert_group(doc, group)
                    probe = unique_path(tempdir, 'probe-%d.pdf' % guard)
                    try:
                        save_pdf(new_doc, probe)
                        size = os.path.getsize(probe)
                    finally:
                        new_doc.close()
                    if size > limit and len(group) > 1:
                        try:
                            os.remove(probe)
                        except OSError:
                            pass
                        middle = len(group) // 2
                        pending.insert(0, group[middle:])
                        pending.insert(0, group[:middle])
                        continue
                    groups.append(group)
                    labels.append('part%d' % len(groups))
            finally:
                shutil.rmtree(tempdir, ignore_errors=True)
        if not groups:
            raise fail('BAD_RANGE', '没有可拆分的页面', '请检查页码/拆分参数')
        for position, group in enumerate(groups):
            new_doc = _insert_group(doc, group)
            try:
                target = out_path(ctx, base, '_' + labels[position], 'pdf')
                pages = new_doc.page_count
                save_pdf(new_doc, target)
            finally:
                new_doc.close()
            outputs.append(pdf_record(ctx, target, pages))
            page_progress(position, len(groups), '正在拆分第 %d 份' % (position + 1))
    finally:
        doc.close()
    return [make_item(name, outputs, None)]


# --------------------------------------------------------------------------- #
# op: compress
# --------------------------------------------------------------------------- #

def _resample_images(doc, max_dim, quality, ctx):
    """Re-encode oversized images as JPEG and patch their streams in place."""
    from PIL import Image
    resample = getattr(Image, 'Resampling', Image).LANCZOS
    seen = set()
    changed = 0
    for pno in range(doc.page_count):
        try:
            images = doc[pno].get_images(full=True)
        except Exception:
            continue
        for info in images:
            try:
                xref = int(info[0])
                soft_mask = int(info[1] or 0)
            except (IndexError, TypeError, ValueError):
                continue
            if xref in seen:
                continue
            seen.add(xref)
            if soft_mask:
                continue                       # keep transparency masks intact
            try:
                raw = doc.extract_image(xref)
            except Exception:
                continue
            width = int(raw.get('width') or 0)
            height = int(raw.get('height') or 0)
            if max(width, height) <= max_dim:
                continue
            try:
                image = Image.open(io.BytesIO(raw.get('image') or b''))
                image.load()
            except Exception:
                continue
            try:
                if image.mode in ('RGBA', 'LA', 'P'):
                    rgba = image.convert('RGBA')
                    background = Image.new('RGB', rgba.size, (255, 255, 255))
                    background.paste(rgba, mask=rgba.split()[-1])
                    image = background
                elif image.mode == 'L':
                    pass
                elif image.mode != 'RGB':
                    image = image.convert('RGB')
                factor = max_dim / float(max(width, height))
                new_size = (max(1, int(round(width * factor))), max(1, int(round(height * factor))))
                image = image.resize(new_size, resample)
                buffer = io.BytesIO()
                image.save(buffer, 'JPEG', quality=int(clamp(quality, 10, 95)), optimize=True)
                payload = buffer.getvalue()
                if len(payload) >= len(raw.get('image') or b''):
                    continue
                doc.update_stream(xref, payload, compress=0)
                keys = (
                    ('Width', str(new_size[0])),
                    ('Height', str(new_size[1])),
                    ('Filter', '/DCTDecode'),
                    ('ColorSpace', '/DeviceGray' if image.mode == 'L' else '/DeviceRGB'),
                    ('BitsPerComponent', '8'),
                    ('DecodeParms', 'null'),
                    ('SMask', 'null'),
                    ('Mask', 'null'),
                    ('Decode', 'null'),
                )
                for key, value in keys:
                    try:
                        doc.xref_set_key(xref, key, value)
                    except Exception:
                        pass
                changed += 1
            except Exception as exc:
                ctx.warn('第 %d 页图片重采样失败：%s' % (pno + 1, exc))
    return changed


def _largest_image_side(doc):
    """Largest raster dimension in the document, or 0 when it has no images."""
    largest = 0
    seen = set()
    for pno in range(doc.page_count):
        try:
            images = doc[pno].get_images(full=True)
        except Exception:
            continue
        for info in images:
            try:
                xref = int(info[0])
            except (IndexError, TypeError, ValueError):
                continue
            if xref in seen:
                continue
            seen.add(xref)
            try:
                raw = doc.extract_image(xref)
            except Exception:
                continue
            largest = max(largest, int(raw.get('width') or 0), int(raw.get('height') or 0))
    return largest


# Each pass is (absolute pixel cap, share of the largest image, JPEG quality).
# Starting mild keeps quality when the target is only slightly below the source;
# the later passes are progressively more aggressive for mail-size caps.
FIT_STEPS = (
    (3000, 0.90, 88),
    (2000, 0.65, 80),
    (1400, 0.48, 70),
    (950, 0.34, 58),
    (650, 0.24, 46),
    (450, 0.16, 34),
)


def _target_bytes(ctx):
    mb = clamp(ctx.number('targetSizeMB', 10), 0.05, 500)
    return int(round(mb * 1024 * 1024))


def _fit_pdf_to_target(ctx, path, target_bytes, password=None):
    """Shrink an already-written PDF to *target_bytes* where the content allows.

    Only raster images are resampled; text and vector art are left intact, so a
    target cap never turns a searchable document into a scan. If even the most
    aggressive pass cannot reach the target the smallest valid result is kept
    and the caller surfaces a warning instead of pretending the cap succeeded.
    """
    target_bytes = int(max(0, target_bytes or 0))
    try:
        before = os.path.getsize(path)
    except OSError:
        before = 0
    info = {
        'originalBytes': before,
        'targetBytes': target_bytes,
        'bytes': before,
        'targetReached': True,
        'passes': 0,
    }
    if target_bytes <= 0 or before <= target_bytes:
        return info

    try:
        probe = open_pdf(path, password)
        try:
            largest = _largest_image_side(probe)
        finally:
            probe.close()
    except Exception as exc:
        ctx.warn('无法检查图片以压缩输出：%s' % exc)
        info['targetReached'] = False
        return info

    if largest <= 0:
        info['targetReached'] = False
        ctx.warn('输出仍为 %s（目标 %s）：文档没有可降采样的图片，文字与矢量内容无法再压缩'
                 % (_fmt_bytes(before), _fmt_bytes(target_bytes)))
        return info

    steps = []
    for cap, share, quality in FIT_STEPS:
        dimension = int(min(cap, max(1, round(largest * share))))
        if steps and dimension >= steps[-1][0]:
            continue
        steps.append((dimension, quality))

    out_dir = ctx.ensure_out_dir()
    best_path = None
    best_size = before
    attempts = 0
    for index, (dimension, quality) in enumerate(steps):
        attempts += 1
        progress(0.93, '正在压缩到目标体积（第 %d 次）' % attempts)
        candidate = os.path.join(out_dir, '.fit-%d-%d.pdf' % (os.getpid(), index))
        try:
            if os.path.exists(candidate):
                os.remove(candidate)
            doc = open_pdf(path, password)
            try:
                _resample_images(doc, dimension, quality, ctx)
                save_pdf(doc, candidate)
            finally:
                doc.close()
            size = os.path.getsize(candidate)
        except Exception as exc:
            ctx.warn('第 %d 次自动压缩失败：%s' % (attempts, exc))
            try:
                if os.path.exists(candidate):
                    os.remove(candidate)
            except OSError:
                pass
            continue
        if size < best_size:
            if best_path:
                try:
                    os.remove(best_path)
                except OSError:
                    pass
            best_path = candidate
            best_size = size
        else:
            try:
                os.remove(candidate)
            except OSError:
                pass
        if best_size <= target_bytes:
            break

    if best_path:
        try:
            verify_pdf(best_path)
        except EngineError as exc:
            ctx.warn('压缩结果校验失败，保留原始输出：%s' % exc)
            try:
                os.remove(best_path)
            except OSError:
                pass
            best_path = None
    if best_path:
        try:
            os.replace(best_path, path)
        except OSError as exc:
            ctx.warn('写入压缩结果失败，保留原始输出：%s' % exc)
            try:
                os.remove(best_path)
            except OSError:
                pass
            best_path = None
    if best_path:
        info.update(bytes=best_size, targetReached=best_size <= target_bytes, passes=attempts)
        if info['targetReached']:
            progress(0.96, '已达到目标体积：%s' % _fmt_bytes(best_size))
        else:
            ctx.warn('无法压到目标体积 %s：最小 %s。文字型 PDF 的可压缩空间有限，已输出最小结果'
                     % (_fmt_bytes(target_bytes), _fmt_bytes(best_size)))
        return info

    info.update(bytes=before, targetReached=False, passes=attempts)
    ctx.warn('无法压到目标体积 %s：输出仍为 %s。文字型 PDF 的可压缩空间有限'
             % (_fmt_bytes(target_bytes), _fmt_bytes(before)))
    return info


def _attach_fit(record, fit):
    """Add the optional compression audit fields the client shows on an output."""
    if not fit:
        return record
    record['originalBytes'] = int(fit.get('originalBytes') or 0)
    record['targetBytes'] = int(fit.get('targetBytes') or 0)
    record['targetReached'] = bool(fit.get('targetReached'))
    return record


def _apply_size_cap(ctx, path):
    if not ctx.flag('limitSize', False):
        return None
    # The output is never encrypted, so never authenticate it with an input password.
    return _fit_pdf_to_target(ctx, path, _target_bytes(ctx), password=None)


def op_compress(ctx):
    require_fitz()
    path, name = single_input(ctx)
    mode = ctx.choice('mode', 'level', ('level', 'target'))
    try:
        before = os.path.getsize(path)
    except OSError:
        before = 0
    base = base_of(name)
    out = out_path(ctx, base, '_compressed', 'pdf')

    if mode == 'target':
        target_bytes = _target_bytes(ctx)
        # Validate the source first (including a password, if one was supplied),
        # then work on a copy so the staged upload is never modified.
        probe = open_pdf(path, ctx.password() or None)
        probe.close()
        progress(0.08, '正在准备压缩')
        shutil.copyfile(path, out)
        fit = _fit_pdf_to_target(ctx, out, target_bytes, password=ctx.password() or None)
        pages = verify_pdf(out)
        after = fit.get('bytes') or os.path.getsize(out)
        ctx.extra_meta['beforeBytes'] = before
        ctx.extra_meta['afterBytes'] = after
        ctx.extra_meta['ratio'] = round((after / before), 4) if before else None
        record = pdf_record(ctx, out, pages)
        _attach_fit(record, fit)
        progress(0.97, '压缩完成：%s → %s' % (_fmt_bytes(before), _fmt_bytes(after)))
        return [make_item(name, [record])]

    doc = open_pdf(path, ctx.password() or None)
    level = ctx.choice('level', 'medium', ('low', 'medium', 'high'))
    progress(0.08, '正在清理文档结构')
    try:
        if level != 'low':
            max_dim = 1600 if level == 'medium' else 1100
            quality = 80 if level == 'medium' else 58
            try:
                changed = _resample_images(doc, max_dim, quality, ctx)
                if changed:
                    progress(0.5, '已重采样 %d 张图片' % changed)
            except Exception as exc:
                ctx.warn('图片重采样失败，已改为无损压缩：%s' % exc)
        save_pdf(doc, out)
    finally:
        try:
            doc.close()
        except Exception:
            pass
    try:
        pages = verify_pdf(out)
    except EngineError:
        ctx.warn('图片采样后文件校验失败，已回退为无损压缩')
        fallback = open_pdf(path, ctx.password() or None)
        try:
            save_pdf(fallback, out)
        finally:
            fallback.close()
        pages = verify_pdf(out)
    try:
        after = os.path.getsize(out)
    except OSError:
        after = 0
    ctx.extra_meta['beforeBytes'] = before
    ctx.extra_meta['afterBytes'] = after
    ctx.extra_meta['ratio'] = round((after / before), 4) if before else None
    progress(0.95, '压缩完成：%s → %s' % (_fmt_bytes(before), _fmt_bytes(after)))
    return [make_item(name, [pdf_record(ctx, out, pages)])]


def _fmt_bytes(value):
    value = float(value or 0)
    if value >= 1024 * 1024:
        return '%.1f MB' % (value / 1048576.0)
    return '%.0f KB' % max(1.0, value / 1024.0)


# --------------------------------------------------------------------------- #
# op: encrypt / decrypt
# --------------------------------------------------------------------------- #

def op_encrypt(ctx):
    require_fitz()
    path, name = single_input(ctx)
    user_password = ctx.text('userPassword')
    if not user_password:
        raise fail('BAD_PARAMS', '必须设置打开密码', '请在参数面板填写打开密码后重试')
    owner_password = ctx.text('ownerPassword') or user_password
    permissions = int(getattr(fitz, 'PDF_PERM_ACCESSIBILITY', 0))
    if ctx.flag('allowPrint', True):
        permissions |= int(getattr(fitz, 'PDF_PERM_PRINT', 4))
        permissions |= int(getattr(fitz, 'PDF_PERM_PRINT_HQ', 0))
    if ctx.flag('allowModify', False):
        permissions |= int(getattr(fitz, 'PDF_PERM_MODIFY', 8))
    if ctx.flag('allowCopy', False):
        permissions |= int(getattr(fitz, 'PDF_PERM_COPY', 16))
    if ctx.flag('allowAnnotate', False):
        permissions |= int(getattr(fitz, 'PDF_PERM_ANNOTATE', 32))
    doc = open_pdf(path, ctx.password() or None)
    try:
        pages = doc.page_count
        out = out_path(ctx, base_of(name), '_encrypted', 'pdf')
        save_encrypted(doc, out, user_password, owner_password, permissions)
    finally:
        try:
            doc.close()
        except Exception:
            pass
    check = fitz.open(out)
    try:
        if not check.needs_pass:
            raise fail('ENCRYPT_FAILED', '加密失败，输出文件没有密码保护', '请重试或更换参数')
        if not check.authenticate(user_password):
            raise fail('ENCRYPT_FAILED', '加密失败，无法用设置的密码打开输出文件', '请重试')
    finally:
        check.close()
    progress(0.95, '加密完成')
    return [make_item(name, [pdf_record(ctx, out, pages)])]


def op_decrypt(ctx):
    require_fitz()
    path, name = single_input(ctx)
    password = ctx.text('password')
    doc = open_pdf(path, password)
    try:
        pages = doc.page_count
        out = out_path(ctx, base_of(name), '_decrypted', 'pdf')
        last = None
        for attempt in ({'encryption': fitz.PDF_ENCRYPT_NONE, 'garbage': 4, 'deflate': True, 'clean': True},
                        {'encryption': fitz.PDF_ENCRYPT_NONE, 'garbage': 4, 'deflate': True},
                        {'encryption': fitz.PDF_ENCRYPT_NONE}):
            try:
                doc.save(out, **attempt)
                last = None
                break
            except Exception as exc:
                last = exc
                try:
                    if os.path.exists(out):
                        os.remove(out)
                except OSError:
                    pass
        if last is not None:
            raise fail('SAVE_FAILED', '无法写出解密后的 PDF：%s' % last,
                       '若文档设置了权限密码，请改用权限密码重试')
    finally:
        try:
            doc.close()
        except Exception:
            pass
    check = fitz.open(out)
    try:
        if check.needs_pass:
            raise fail('DECRYPT_FAILED', '解密失败，输出文件仍受密码保护', '请确认密码类型与权限')
    finally:
        check.close()
    progress(0.95, '解密完成')
    return [make_item(name, [pdf_record(ctx, out, pages)])]


# --------------------------------------------------------------------------- #
# op: rotate / deletePages / extractPages / insertBlank
# --------------------------------------------------------------------------- #

def op_rotate(ctx):
    require_fitz()
    path, name = single_input(ctx)
    angle = int(ctx.choice('angle', '90', ('90', '180', '270')))
    doc = open_pdf(path, ctx.password() or None)
    try:
        pages = parse_page_range(ctx.text('pageRange'), doc.page_count)
        for position, pno in enumerate(pages):
            page = doc[pno]
            page.set_rotation((int(page.rotation or 0) + angle) % 360)
            page_progress(position, len(pages), '正在旋转第 %d 页' % (pno + 1))
        out = out_path(ctx, base_of(name), '_rotated', 'pdf')
        count = doc.page_count
        save_pdf(doc, out)
    finally:
        try:
            doc.close()
        except Exception:
            pass
    return [make_item(name, [pdf_record(ctx, out, count)])]


def op_deletePages(ctx):
    require_fitz()
    path, name = single_input(ctx)
    doc = open_pdf(path, ctx.password() or None)
    try:
        count = doc.page_count
        pages = parse_page_range(ctx.text('pageRange', '1'), count)
        if len(pages) >= count:
            raise fail('BAD_RANGE', '不能删除全部页面', '请至少保留一页后重试')
        doc.delete_pages(pages)
        out = out_path(ctx, base_of(name), '_deleted', 'pdf')
        remaining = doc.page_count
        save_pdf(doc, out)
    finally:
        try:
            doc.close()
        except Exception:
            pass
    progress(0.95, '已删除 %d 页' % len(pages))
    return [make_item(name, [pdf_record(ctx, out, remaining)])]


def op_extractPages(ctx):
    require_fitz()
    path, name = single_input(ctx)
    doc = open_pdf(path, ctx.password() or None)
    try:
        count = doc.page_count
        pages = parse_page_range(ctx.text('pageRange', '1'), count)
        selected = set(pages)
        mapping = {old: new for new, old in enumerate(pages)}
        try:
            toc = doc.get_toc(simple=True)
        except Exception:
            toc = []
        remapped = []
        for level, title, page in toc:
            try:
                page_index = int(page) - 1
            except (TypeError, ValueError):
                continue
            if page_index in mapping:
                remapped.append([int(level), str(title), mapping[page_index] + 1])
        doc.select(pages)
        if remapped:
            try:
                doc.set_toc(remapped)
            except Exception as exc:
                ctx.warn('提取页面后书签重建失败：%s' % exc)
        out = out_path(ctx, base_of(name), '_pages', 'pdf')
        remaining = doc.page_count
        save_pdf(doc, out)
    finally:
        try:
            doc.close()
        except Exception:
            pass
    progress(0.95, '已保留 %d 页' % len(pages))
    return [make_item(name, [pdf_record(ctx, out, remaining)])]


def op_insertBlank(ctx):
    require_fitz()
    path, name = single_input(ctx)
    doc = open_pdf(path, ctx.password() or None)
    try:
        count = doc.page_count
        after = clamp(ctx.integer('afterPage', 1), 0, count)
        amount = clamp(ctx.integer('count', 1), 1, 50)
        size_mode = ctx.choice('pageSize', 'same', ('same', 'A4', 'Letter'))
        if size_mode == 'same':
            reference = doc[after - 1] if after > 0 else doc[0]
            width, height = reference.rect.width, reference.rect.height
        else:
            width, height = PAPER[size_mode]
        for offset in range(amount):
            doc.new_page(pno=after + offset, width=width, height=height)
            progress(0.1 + 0.85 * (offset + 1) / amount, '正在插入第 %d 页空白页' % (offset + 1))
        out = out_path(ctx, base_of(name), '_blank', 'pdf')
        total = doc.page_count
        save_pdf(doc, out)
    finally:
        try:
            doc.close()
        except Exception:
            pass
    return [make_item(name, [pdf_record(ctx, out, total)])]


# --------------------------------------------------------------------------- #
# op: resize / batchResize (vector first, metadata preserved)
# --------------------------------------------------------------------------- #

def _derotate_copy(source):
    """Copy of ``source`` with page rotation baked out (for show_pdf_page)."""
    temp = fitz.open()
    temp.insert_pdf(source)
    for index in range(temp.page_count):
        if int(temp[index].rotation or 0) % 360:
            temp[index].set_rotation(0)
    return temp


def _show_source_page(dest_page, target_rect, source, pno, temp_doc, keep_proportion):
    rotation = int(source[pno].rotation or 0) % 360
    if rotation and temp_doc is not None:
        # show_pdf_page ignores /Rotate, so feed it a derotated page and rotate back
        dest_page.show_pdf_page(target_rect, temp_doc, pno,
                                keep_proportion=keep_proportion,
                                rotate=(360 - rotation) % 360)
    else:
        dest_page.show_pdf_page(target_rect, source, pno, keep_proportion=keep_proportion)


def _migrate_links(source_page, dest_page, mapper, ctx):
    created = 0
    try:
        links = source_page.get_links()
    except Exception:
        return 0
    for link in links:
        try:
            origin = link.get('from')
            if origin is None:
                continue
            new_rect = mapper(fitz.Rect(origin))
            if not rect_ok(new_rect):
                continue
            payload = {key: value for key, value in link.items() if key not in ('xref', 'id')}
            payload['from'] = new_rect
            dest_page.insert_link(payload)
            created += 1
        except Exception as exc:
            ctx.warn('链接重建失败：%s' % exc)
    return created


def _migrate_annotations(source_page, dest_page, mapper, ctx):
    created = 0
    try:
        annotations = list(source_page.annots() or [])
    except Exception:
        return 0
    for annotation in annotations:
        type_number, type_name = 0, 'Unknown'
        try:
            type_number = int(annotation.type[0])
            type_name = str(annotation.type[1])
            rect = mapper(fitz.Rect(annotation.rect))
            if not rect_ok(rect):
                continue
            content = str((annotation.info or {}).get('content') or '')
            fresh = None
            if type_number == int(fitz.PDF_ANNOT_TEXT):
                fresh = dest_page.add_text_annot(rect.tl, content)
            elif type_number == int(fitz.PDF_ANNOT_FREE_TEXT):
                fresh = dest_page.add_freetext_annot(rect, content)
            elif type_number == int(fitz.PDF_ANNOT_HIGHLIGHT):
                fresh = dest_page.add_highlight_annot(rect)
            elif type_number == int(fitz.PDF_ANNOT_UNDERLINE):
                fresh = dest_page.add_underline_annot(rect)
            elif type_number == int(fitz.PDF_ANNOT_STRIKE_OUT):
                fresh = dest_page.add_strikeout_annot(rect)
            elif type_number == int(fitz.PDF_ANNOT_SQUIGGLY):
                fresh = dest_page.add_squiggly_annot(rect)
            elif type_number == int(fitz.PDF_ANNOT_SQUARE):
                fresh = dest_page.add_rect_annot(rect)
            elif type_number == int(fitz.PDF_ANNOT_CIRCLE):
                fresh = dest_page.add_circle_annot(rect)
            elif type_number == int(fitz.PDF_ANNOT_LINE):
                fresh = dest_page.add_line_annot(rect.tl, rect.br)
            elif type_number == int(fitz.PDF_ANNOT_STAMP):
                fresh = dest_page.add_stamp_annot(rect)
            elif type_number == int(fitz.PDF_ANNOT_CARET):
                fresh = dest_page.add_caret_annot(rect.tl)
            else:
                ctx.warn('无法重建批注类型（%s），已跳过' % type_name)
                continue
            if fresh is None:
                continue
            info = dict(annotation.info or {})
            info.pop('id', None)
            try:
                fresh.set_info(info)
            except Exception:
                pass
            try:
                if annotation.colors:
                    fresh.set_colors(annotation.colors)
            except Exception:
                pass
            try:
                fresh.update()
            except Exception:
                pass
            created += 1
        except Exception as exc:
            ctx.warn('批注重建失败（%s）：%s' % (type_name, exc))
    return created


def _migrate_widgets(source_page, dest_page, mapper, ctx):
    try:
        widgets = list(source_page.widgets() or [])
    except Exception:
        return 0
    created = 0
    for widget in widgets:
        try:
            rect = mapper(fitz.Rect(widget.rect))
            field_type = int(getattr(widget, 'field_type', 0) or 0)
            fresh = dest_page.add_widget(field_type, widget.field_name or 'field',
                                         widget.field_value, rect=rect)
            if fresh is not None:
                try:
                    fresh.field_value = widget.field_value
                    fresh.update()
                except Exception:
                    pass
                created += 1
        except Exception:
            ctx.warn('表单字段无法重建：%s' % (getattr(widget, 'field_name', '') or ''))
    return created


def resize_document(ctx, source_path, source_name, doc=None, password=None):
    """Resize every selected page with show_pdf_page (fully vector)."""
    require_fitz()
    source = doc if doc is not None else open_pdf(source_path, password)
    owns_source = doc is None
    new_doc = None
    temp_doc = None
    try:
        count = source.page_count
        selected = set(parse_page_range(ctx.text('pageRange'), count))
        fit_mode = ctx.choice('fitMode', 'scale', ('scale', 'crop', 'stretch'))
        margin_pt = max(0.0, ctx.number('margin', 0.0)) * MM
        background = parse_color(ctx.raw('background') or '#ffffff', (1.0, 1.0, 1.0))
        keep_metadata = ctx.flag('keepMetadata', True)
        preset = preset_name(ctx)
        if any(int(source[index].rotation or 0) % 360 for index in selected):
            temp_doc = _derotate_copy(source)
        new_doc = fitz.open()
        for index in range(count):
            page = source[index]
            if index not in selected:
                new_doc.insert_pdf(source, from_page=index, to_page=index)
                continue
            page_width, page_height = target_page_size(ctx, page)
            dest = new_doc.new_page(width=page_width, height=page_height)
            if background != (1.0, 1.0, 1.0):
                dest.draw_rect(dest.rect, color=None, fill=background)
            content = content_rect_for(page_width, page_height, margin_pt)
            visual = page.rect
            if fit_mode == 'stretch':
                scale_x = content.width / visual.width
                scale_y = content.height / visual.height
                target = fitz.Rect(content)
                keep_proportion = False
            else:
                factor = max if fit_mode == 'crop' else min
                scale = factor(content.width / visual.width, content.height / visual.height)
                draw_w, draw_h = visual.width * scale, visual.height * scale
                offset_x = content.x0 + (content.width - draw_w) / 2.0
                offset_y = content.y0 + (content.height - draw_h) / 2.0
                target = fitz.Rect(offset_x, offset_y, offset_x + draw_w, offset_y + draw_h)
                scale_x = scale_y = scale
                keep_proportion = True
            _show_source_page(dest, target, source, index, temp_doc, keep_proportion)
            if keep_metadata:
                def mapper(source_rect, sx=scale_x, sy=scale_y, tx=target.x0, ty=target.y0):
                    return fitz.Rect(tx + source_rect.x0 * sx, ty + source_rect.y0 * sy,
                                     tx + source_rect.x1 * sx, ty + source_rect.y1 * sy)
                _migrate_links(page, dest, mapper, ctx)
                _migrate_annotations(page, dest, mapper, ctx)
                _migrate_widgets(page, dest, mapper, ctx)
            page_progress(index, count, '正在调整第 %d 页尺寸' % (index + 1))
        if keep_metadata:
            metadata = doc_meta(source)
            allowed = {key: value for key, value in metadata.items()
                       if key in ('title', 'author', 'subject', 'keywords', 'creator',
                                  'producer', 'creationDate', 'modDate', 'trapped')
                       and isinstance(value, str)}
            try:
                new_doc.set_metadata(allowed)
            except Exception as exc:
                ctx.warn('文档元信息迁移失败：%s' % exc)
            try:
                toc = source.get_toc(simple=True)
                if toc:
                    new_doc.set_toc([[int(level), str(title), int(page)] for level, title, page in toc])
            except Exception as exc:
                ctx.warn('书签迁移失败：%s' % exc)
            try:
                xml_metadata = source.get_xml_metadata()
                if xml_metadata:
                    new_doc.set_xml_metadata(xml_metadata)
            except Exception:
                pass
        out = out_path(ctx, base_of(source_name), '_' + preset, 'pdf')
        pages = new_doc.page_count
        save_pdf(new_doc, out)
        return out, pages
    finally:
        if new_doc is not None:
            try:
                new_doc.close()
            except Exception:
                pass
        if temp_doc is not None:
            try:
                temp_doc.close()
            except Exception:
                pass
        if owns_source:
            try:
                source.close()
            except Exception:
                pass


def op_resize(ctx):
    require_fitz()
    path, name = single_input(ctx)
    out, pages = resize_document(ctx, path, name, password=ctx.password() or None)
    progress(0.95, '页面尺寸调整完成')
    return [make_item(name, [pdf_record(ctx, out, pages)])]


def op_batchResize(ctx):
    require_fitz()
    pairs = input_paths(ctx)
    if not pairs:
        raise fail('NO_INPUT', '没有收到输入文件', '请重新上传文件后重试')
    password = ctx.password() or None
    bundle = ctx.flag('zipOutput', True)
    items = []
    entries = []
    for index, (path, name) in enumerate(pairs):
        try:
            source = open_pdf(path, password)
        except Exception as exc:
            items.append(make_item(name, [], error_of(exc)))
            page_progress(index, len(pairs), '正在处理第 %d 份文档' % (index + 1))
            continue
        try:
            out, pages = resize_document(ctx, path, name, doc=source, password=password)
            # Cap before bundling so the archive holds the capped files.
            fit = _apply_size_cap(ctx, out)
            record = pdf_record(ctx, out, pages)
            _attach_fit(record, fit)
            items.append(make_item(name, [record]))
            entries.append((out, os.path.basename(out)))
        except Exception as exc:
            items.append(make_item(name, [], error_of(exc)))
        finally:
            try:
                source.close()
            except Exception:
                pass
        page_progress(index, len(pairs), '正在处理第 %d 份文档' % (index + 1))
    if bundle and entries:
        archive = bundle_zip(ctx, entries, base_of(pairs[0][1]), '_batch')
        if archive:
            # keep one item per input: the archive rides on the first success
            for item in items:
                if item.get('ok'):
                    item['outputs'].append(archive)
                    break
    return items


# --------------------------------------------------------------------------- #
# op: crop (vector: CropBox + MediaBox, never rasterised)
# --------------------------------------------------------------------------- #

def op_crop(ctx):
    require_fitz()
    path, name = single_input(ctx)
    doc = open_pdf(path, ctx.password() or None)
    try:
        count = doc.page_count
        pages = parse_page_range(ctx.text('pageRange'), count)
        mode = ctx.choice('cropMode', 'auto', ('auto', 'manual'))
        uniform = ctx.flag('uniform', True)
        safety = max(0.0, ctx.number('safetyMargin', 2.0)) * MM
        threshold = int(clamp(ctx.number('threshold', 245), 0, 255))
        rects = {}
        for position, pno in enumerate(pages):
            page = doc[pno]
            rect = None
            if mode == 'manual':
                top = max(0.0, ctx.number('marginTop', 5.0)) * MM
                bottom = max(0.0, ctx.number('marginBottom', 5.0)) * MM
                left = max(0.0, ctx.number('marginLeft', 5.0)) * MM
                right = max(0.0, ctx.number('marginRight', 5.0)) * MM
                rect = intersect_page_rect(page, mm_rect(page, top, bottom, left, right))
            else:
                detected = content_bbox_pixels(page, threshold, 72)
                if detected is None:
                    ctx.warn('第 %d 页没有检测到内容，保持原样' % (pno + 1))
                    rect = fitz.Rect(page.rect)
                else:
                    rect = fitz.Rect(detected.x0 - safety, detected.y0 - safety,
                                     detected.x1 + safety, detected.y1 + safety)
                    rect = intersect_page_rect(page, rect)
            if rect is None or rect.width < 6 or rect.height < 6:
                ctx.warn('第 %d 页裁剪区域过小，保持原样' % (pno + 1))
                rect = fitz.Rect(page.rect)
            rects[pno] = rect
            page_progress(position, len(pages), '正在分析第 %d 页白边' % (pno + 1))
        if uniform and len(rects) > 1:
            common = union_rect(list(rects.values()))
            if common is not None:
                rects = {pno: fitz.Rect(common) for pno in rects}
        cropped = 0
        for position, pno in enumerate(pages):
            page = doc[pno]
            visual_rect = rects[pno]
            rotation = int(page.rotation or 0) % 360
            unrotated = (visual_rect * page.derotation_matrix).normalize() if rotation else fitz.Rect(visual_rect)
            media = page.mediabox
            clamped = (unrotated & media).normalize()
            if not rect_ok(clamped) or clamped.width < 6 or clamped.height < 6:
                ctx.warn('第 %d 页裁剪区域越界，保持原样' % (pno + 1))
                continue
            try:
                page.set_cropbox(clamped)
                page.set_mediabox(fitz.Rect(clamped.x0, media.y1 - clamped.y1,
                                            clamped.x1, media.y1 - clamped.y0))
                cropped += 1
            except Exception as exc:
                ctx.warn('第 %d 页裁剪失败：%s' % (pno + 1, exc))
            page_progress(position, len(pages), '正在裁剪第 %d 页' % (pno + 1))
        if cropped == 0:
            raise fail('CROP_FAILED', '没有页面被成功裁剪', '请调整裁剪边距或去除统一尺寸选项后重试')
        out = out_path(ctx, base_of(name), '_cropped', 'pdf')
        total = doc.page_count
        save_pdf(doc, out)
    finally:
        try:
            doc.close()
        except Exception:
            pass
    progress(0.95, '已裁剪 %d 页' % cropped)
    return [make_item(name, [pdf_record(ctx, out, total)])]


# --------------------------------------------------------------------------- #
# op: pageNumber
# --------------------------------------------------------------------------- #

def _page_label(label_format, number, total):
    if label_format == 'n-total':
        return '%d / %d' % (number, total)
    if label_format == 'page-n':
        return '第 %d 页' % number
    if label_format == 'dash-n-dash':
        return '- %d -' % number
    return str(number)


def op_pageNumber(ctx):
    require_fitz()
    path, name = single_input(ctx)
    doc = open_pdf(path, ctx.password() or None)
    try:
        count = doc.page_count
        pages = parse_page_range(ctx.text('pageRange'), count)
        position = ctx.choice('position', 'footer-center',
                              ('footer-center', 'footer-left', 'footer-right',
                               'header-center', 'header-left', 'header-right'))
        label_format = ctx.choice('format', 'n', ('n', 'n-total', 'page-n', 'dash-n-dash'))
        font_name = ctx.choice('fontFamily', 'china-s', ('china-s', 'helv', 'times'))
        font_size = clamp(ctx.number('fontSize', 10), 5, 72)
        start_number = ctx.integer('startNumber', 1)
        margin = clamp(ctx.number('margin', 12), 1, 120) * MM
        font = fitz.Font(font_name)
        for offset, pno in enumerate(pages):
            page = doc[pno]
            label = _page_label(label_format, start_number + offset, count)
            text_width = font.text_length(label, font_size)
            page_width, page_height = page.rect.width, page.rect.height
            if position.startswith('header'):
                baseline = margin + font_size * 0.85
            else:
                baseline = page_height - margin
            if position.endswith('left'):
                x = margin
            elif position.endswith('right'):
                x = page_width - margin - text_width
            else:
                x = (page_width - text_width) / 2.0
            point = fitz.Point(x, baseline)
            if int(page.rotation or 0) % 360:
                point = point * page.derotation_matrix
            try:
                page.insert_text(point, label, fontname=font_name, fontsize=font_size,
                                 color=(0, 0, 0), overlay=True)
            except Exception as exc:
                ctx.warn('第 %d 页页码写入失败：%s' % (pno + 1, exc))
            page_progress(offset, len(pages), '正在添加第 %d 页页码' % (pno + 1))
        out = out_path(ctx, base_of(name), '_numbered', 'pdf')
        total = doc.page_count
        save_pdf(doc, out)
    finally:
        try:
            doc.close()
        except Exception:
            pass
    progress(0.95, '页码添加完成')
    return [make_item(name, [pdf_record(ctx, out, total)])]


# --------------------------------------------------------------------------- #
# op: ocr (rapidocr; never pretends to succeed)
# --------------------------------------------------------------------------- #

_OCR_CACHE = None


def ocr_available():
    global _OCR_CACHE
    if _OCR_CACHE is None:
        try:
            import rapidocr_onnxruntime  # noqa: F401
            _OCR_CACHE = True
        except Exception:
            _OCR_CACHE = False
    return _OCR_CACHE


def ocr_engine():
    require_fitz()
    if not ocr_available():
        raise fail('OCR_UNAVAILABLE',
                   '当前环境没有可用的 OCR 引擎（未安装 rapidocr_onnxruntime）',
                   '请安装 rapidocr_onnxruntime，或改用带文字层的 PDF')
    try:
        from rapidocr_onnxruntime import RapidOCR
        return RapidOCR()
    except Exception as exc:
        raise fail('OCR_UNAVAILABLE', 'OCR 引擎初始化失败：%s' % exc, '请检查 OCR 运行库是否完整')


def _ocr_page(engine, page, dpi=200):
    """Recognise one page; returns boxes normalised to 0-1 with top-left origin."""
    require_fitz()
    zoom = clamp(dpi, 72, 400) / 72.0
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    if pix.width < 4 or pix.height < 4:
        return []
    result = None
    try:
        import numpy as np
        samples = pix.samples
        array = np.frombuffer(samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
        if pix.n == 4:
            array = array[:, :, :3]
        result, _elapse = engine(array)
    except ImportError:
        handle, temp_path = tempfile.mkstemp(suffix='.png', prefix='pdfw-ocr-')
        os.close(handle)
        try:
            with open(temp_path, 'wb') as stream:
                stream.write(pix.tobytes('png'))
            result, _elapse = engine(temp_path)
        finally:
            try:
                os.remove(temp_path)
            except OSError:
                pass
    items = []
    for entry in (result or []):
        try:
            box, text, score = entry[0], entry[1], entry[2]
        except (IndexError, TypeError):
            continue
        text = str(text or '').strip()
        if not text:
            continue
        try:
            xs = [float(point[0]) for point in box]
            ys = [float(point[1]) for point in box]
        except (TypeError, ValueError, IndexError):
            continue
        items.append({
            'text': text,
            'x0': min(xs) / float(pix.width),
            'y0': min(ys) / float(pix.height),
            'x1': max(xs) / float(pix.width),
            'y1': max(ys) / float(pix.height),
            'score': float(score or 0),
        })
    return items


def _ocr_lines(items):
    ordered = sorted(items, key=lambda item: (round(item['y0'], 3), item['x0']))
    lines = []
    current = []
    baseline = None
    for item in ordered:
        if baseline is None or abs(item['y0'] - baseline) <= 0.012:
            current.append(item)
            if baseline is None:
                baseline = item['y0']
        else:
            lines.append(' '.join(part['text'] for part in current))
            current = [item]
            baseline = item['y0']
    if current:
        lines.append(' '.join(part['text'] for part in current))
    return lines


def op_ocr(ctx):
    require_fitz()
    path, name = single_input(ctx)
    doc = open_pdf(path, ctx.password() or None)
    engine = ocr_engine()
    output_mode = ctx.choice('outputMode', 'pdf', ('pdf', 'txt'))
    language = ctx.choice('lang', 'ch', ('ch', 'en'))
    pages = parse_page_range(ctx.text('pageRange'), doc.page_count)
    base = base_of(name)
    progress(0.06, '正在准备 OCR 引擎')
    try:
        if output_mode == 'txt':
            chunks = []
            for position, pno in enumerate(pages):
                items = _ocr_page(engine, doc[pno])
                chunks.append('===== 第 %d 页 =====\n%s' % (pno + 1, '\n'.join(_ocr_lines(items))))
                page_progress(position, len(pages), '正在识别第 %d 页' % (pno + 1))
            out = out_path(ctx, base, '_ocr', 'txt')
            with open(out, 'w', encoding='utf-8') as handle:
                handle.write('\n\n'.join(chunks).strip() + '\n')
            outputs = [output_record(out, 'text', None, len(pages))]
        else:
            # add the invisible text layer straight onto the opened copy: no
            # second full document in memory, one page pixmap at a time.
            font = fitz.Font('china-s')
            for position, pno in enumerate(pages):
                page = doc[pno]
                items = _ocr_page(engine, page)
                page_width, page_height = page.rect.width, page.rect.height
                for item in items:
                    x0 = item['x0'] * page_width
                    y0 = item['y0'] * page_height
                    x1 = item['x1'] * page_width
                    y1 = item['y1'] * page_height
                    box_width = max(2.0, x1 - x0)
                    box_height = max(2.0, y1 - y0)
                    size = max(2.0, box_height * 0.82)
                    try:
                        natural = font.text_length(item['text'], size)
                        if natural > box_width > 0:
                            size = max(2.0, size * box_width / natural)
                    except Exception:
                        pass
                    point = fitz.Point(x0, min(page_height - 1.0, y0 + size * 0.85))
                    if int(page.rotation or 0) % 360:
                        point = point * page.derotation_matrix
                    try:
                        page.insert_text(point, item['text'], fontname='china-s',
                                         fontsize=size, render_mode=3, color=(0, 0, 0),
                                         overlay=True)
                    except Exception:
                        pass
                page_progress(position, len(pages), '正在生成第 %d 页文字层' % (pno + 1))
            out = out_path(ctx, base, '_ocr', 'pdf')
            total = doc.page_count
            save_pdf(doc, out)
            outputs = [pdf_record(ctx, out, total)]
    finally:
        try:
            doc.close()
        except Exception:
            pass
    progress(0.95, 'OCR 完成')
    return [make_item(name, outputs)]


# --------------------------------------------------------------------------- #
# op: extractImages
# --------------------------------------------------------------------------- #

def op_extractImages(ctx):
    require_fitz()
    path, name = single_input(ctx)
    doc = open_pdf(path, ctx.password() or None)
    base = base_of(name)
    min_pixels = int(clamp(ctx.number('minPixels', 0), 0, 20000))
    image_format = ctx.choice('format', 'original', ('original', 'png', 'jpg'))
    pages = parse_page_range(ctx.text('pageRange'), doc.page_count)
    outputs = []
    entries = []
    seen = set()
    counter = 0
    try:
        for position, pno in enumerate(pages):
            page = doc[pno]
            try:
                images = page.get_images(full=True)
            except Exception:
                images = []
            for info in images:
                try:
                    xref = int(info[0])
                except (IndexError, TypeError, ValueError):
                    continue
                if xref in seen:
                    continue
                seen.add(xref)
                try:
                    raw = doc.extract_image(xref)
                except Exception:
                    continue
                width = int(raw.get('width') or 0)
                height = int(raw.get('height') or 0)
                if min_pixels and min(width, height) < min_pixels:
                    continue
                data = raw.get('image') or b''
                if not data:
                    continue
                extension = (raw.get('ext') or 'png').lower()
                if image_format == 'original' and extension in ('png', 'jpg', 'jpeg', 'gif', 'bmp'):
                    out_ext = 'jpg' if extension == 'jpeg' else extension
                elif image_format == 'original' and extension in ('jpx', 'jp2', 'jbig2', 'ccitt'):
                    try:
                        Image = pil_image_module()
                        image = Image.open(io.BytesIO(data))
                        image.load()
                        buffer = io.BytesIO()
                        image.save(buffer, 'PNG')
                        data = buffer.getvalue()
                        out_ext = 'png'
                    except Exception as exc:
                        ctx.warn('第 %d 张图片格式无法转换：%s' % (counter + 1, exc))
                        continue
                else:
                    try:
                        Image = pil_image_module()
                        image = Image.open(io.BytesIO(data))
                        image.load()
                        if image_format == 'jpg':
                            if image.mode in ('RGBA', 'LA', 'P'):
                                rgba = image.convert('RGBA')
                                background = Image.new('RGB', rgba.size, (255, 255, 255))
                                background.paste(rgba, mask=rgba.split()[-1])
                                image = background
                            elif image.mode not in ('RGB', 'L'):
                                image = image.convert('RGB')
                            buffer = io.BytesIO()
                            image.save(buffer, 'JPEG', quality=90)
                            out_ext = 'jpg'
                        else:
                            buffer = io.BytesIO()
                            image.save(buffer, 'PNG')
                            out_ext = 'png'
                        data = buffer.getvalue()
                    except Exception as exc:
                        ctx.warn('第 %d 张图片转换失败：%s' % (counter + 1, exc))
                        continue
                counter += 1
                file_name = '%s-%03d.%s' % (base, counter, out_ext)
                target = unique_path(ctx.ensure_out_dir(), file_name)
                with open(target, 'wb') as handle:
                    handle.write(data)
                record = output_record(target, 'image')
                outputs.append(record)
                entries.append((target, os.path.basename(target)))
            page_progress(position, len(pages), '正在提取第 %d 页图片' % (pno + 1))
    finally:
        try:
            doc.close()
        except Exception:
            pass
    if not outputs:
        raise fail('NO_IMAGES', '该 PDF 中没有找到可提取的图片',
                   '请调低「过滤小于该边长」阈值，或确认文件是否包含位图')
    archive = bundle_zip(ctx, entries, base, '_images')
    if archive:
        outputs.append(archive)
    progress(0.95, '共提取 %d 张图片' % counter)
    return [make_item(name, outputs)]


# --------------------------------------------------------------------------- #
# op: extractToc
# --------------------------------------------------------------------------- #

def _infer_toc(doc):
    sizes = {}
    page_blocks = []
    for pno in range(doc.page_count):
        try:
            blocks = (doc[pno].get_text('dict') or {}).get('blocks', [])
        except Exception:
            blocks = []
        page_blocks.append(blocks)
        for block in blocks:
            if block.get('type') != 0:
                continue
            for line in block.get('lines', []) or []:
                for span in line.get('spans', []) or []:
                    text = str(span.get('text') or '').strip()
                    size = float(span.get('size') or 0)
                    if len(text) < 2 or size <= 0:
                        continue
                    key = round(size, 1)
                    sizes[key] = sizes.get(key, 0) + len(text)
    if not sizes:
        return []
    body_size = max(sizes.items(), key=lambda pair: pair[1])[0]
    headings = sorted([size for size in sizes if size >= body_size * 1.15], reverse=True)[:3]
    if not headings:
        return []
    entries = []
    for pno, blocks in enumerate(page_blocks):
        for block in blocks:
            if block.get('type') != 0:
                continue
            segments = []
            max_size = 0.0
            for line in block.get('lines', []) or []:
                spans = line.get('spans') or []
                piece = ''.join(str(span.get('text') or '') for span in spans).strip()
                if piece:
                    segments.append(piece)
                for span in spans:
                    max_size = max(max_size, float(span.get('size') or 0))
            title = ' '.join(segments).strip()
            if not title or len(title) > 100:
                continue
            rounded = round(max_size, 1)
            if rounded < headings[-1] - 0.05:
                continue
            level = 1
            for index, size in enumerate(headings):
                if abs(rounded - size) <= 0.2:
                    level = index + 1
                    break
            entries.append({'level': min(level, 3), 'title': title, 'page': pno + 1})
            if len(entries) >= 300:
                break
        if len(entries) >= 300:
            break
    return entries


def op_extractToc(ctx):
    require_fitz()
    path, name = single_input(ctx)
    doc = open_pdf(path, ctx.password() or None)
    base = base_of(name)
    export_format = ctx.choice('format', 'md', ('md', 'txt', 'json'))
    fallback = ctx.flag('fallbackHeadings', True)
    try:
        entries = []
        try:
            for item in doc.get_toc(simple=False) or []:
                level, title, page = item[0], item[1], item[2]
                entries.append({'level': int(level), 'title': str(title), 'page': int(page)})
        except Exception:
            entries = []
        if not entries and fallback:
            progress(0.15, '没有书签，正在按字号推断标题层级')
            entries = _infer_toc(doc)
        total_pages = doc.page_count
        title = str(doc_meta(doc).get('title') or base)
    finally:
        try:
            doc.close()
        except Exception:
            pass
    if export_format == 'json':
        body = json.dumps(entries, ensure_ascii=False, indent=2)
        extension = 'json'
        kind = 'json'
    elif export_format == 'txt':
        lines = [('  ' * max(0, entry['level'] - 1)) + '%s  …… 第 %d 页' % (entry['title'], entry['page'])
                 for entry in entries]
        body = ('目录：' + title + '\n\n' + ('\n'.join(lines) if lines else '（没有可用的目录条目）') + '\n')
        extension = 'txt'
        kind = 'text'
    else:
        lines = []
        for entry in entries:
            level = clamp(entry['level'], 1, 6)
            lines.append('%s %s  <sub>第 %d 页</sub>' % ('#' * level, entry['title'], entry['page']))
        body = '# %s · 目录\n\n%s\n' % (title, '\n'.join(lines) if lines else '（没有可用的目录条目）')
        extension = 'md'
        kind = 'md'
    out = out_path(ctx, base, '_toc', extension)
    with open(out, 'w', encoding='utf-8') as handle:
        handle.write(body)
    progress(0.9, '目录已导出')
    return [make_item(name, [output_record(out, kind, None, total_pages)])]


# --------------------------------------------------------------------------- #
# op: watermark
# --------------------------------------------------------------------------- #

def _prepare_watermark_image(path, opacity, rotation):
    Image = pil_image_module()
    try:
        image = Image.open(path)
        image.load()
    except Exception:
        raise fail('BAD_IMAGE', '无法读取水印图片：%s' % os.path.basename(path), '请换一张图片后重试')
    image = image.convert('RGBA')
    alpha = image.split()[-1].point(lambda value: int(value * clamp(opacity, 0.01, 1.0)))
    image.putalpha(alpha)
    if int(rotation) % 360:
        image = image.rotate(float(rotation), expand=True, resample=getattr(Image, 'Resampling', Image).BICUBIC)
    buffer = io.BytesIO()
    image.save(buffer, 'PNG')
    return buffer.getvalue()


def _watermark_centers(page_width, page_height, position, density):
    if position == 'center':
        return [(page_width / 2.0, page_height / 2.0)]
    if position == 'diagonal':
        return [(page_width * (index + 0.5) / density, page_height * (index + 0.5) / density)
                for index in range(density)]
    columns = max(1, int(round(math.sqrt(density))))
    rows = max(1, int(math.ceil(density / float(columns))))
    centers = []
    for row in range(rows):
        for column in range(columns):
            centers.append(((column + 0.5) * page_width / columns,
                            (row + 0.5) * page_height / rows))
    return centers[:max(density, 1)]


def _draw_text_watermark(page, text_value, font_size, color, opacity, rotation, position, density):
    font = fitz.Font('china-s')
    text_width = font.text_length(text_value, font_size)
    page_width, page_height = page.rect.width, page.rect.height
    for centre_x, centre_y in _watermark_centers(page_width, page_height, position, density):
        point = fitz.Point(centre_x - text_width / 2.0, centre_y + font_size * 0.35)
        morph = None
        if int(rotation) % 360:
            morph = (fitz.Point(centre_x, centre_y), fitz.Matrix(float(rotation)))
        if int(page.rotation or 0) % 360:
            point = point * page.derotation_matrix
        options = dict(fontname='china-s', fontsize=font_size, color=color,
                       overlay=True, morph=morph)
        try:
            page.insert_text(point, text_value, fill_opacity=opacity,
                             stroke_opacity=opacity, **options)
        except TypeError:
            blended = tuple(1.0 - (1.0 - channel) * opacity for channel in color)
            page.insert_text(point, text_value, color=blended, **options)


def _draw_image_watermark(page, image_bytes, scale_percent, position, density):
    Image = pil_image_module()
    image = Image.open(io.BytesIO(image_bytes))
    image.load()
    image_width, image_height = image.size
    page_width, page_height = page.rect.width, page.rect.height
    draw_width = page_width * clamp(scale_percent, 1, 100) / 100.0
    draw_height = draw_width * image_height / float(max(1, image_width))
    for centre_x, centre_y in _watermark_centers(page_width, page_height, position, density):
        rect = fitz.Rect(centre_x - draw_width / 2.0, centre_y - draw_height / 2.0,
                         centre_x + draw_width / 2.0, centre_y + draw_height / 2.0)
        if int(page.rotation or 0) % 360:
            rect = (rect * page.derotation_matrix).normalize()
        page.insert_image(rect, stream=image_bytes, keep_proportion=True, overlay=True)


def _watermark_one(ctx, path, name, settings):
    doc = open_pdf(path, ctx.password() or None)
    try:
        count = doc.page_count
        pages = parse_page_range(ctx.text('pageRange'), count)
        for position, pno in enumerate(pages):
            page = doc[pno]
            if settings['kind'] == 'text':
                _draw_text_watermark(page, settings['text'], settings['font_size'],
                                     settings['color'], settings['opacity'],
                                     settings['rotation'], settings['position'],
                                     settings['density'])
            else:
                _draw_image_watermark(page, settings['image'], settings['scale'],
                                      settings['position'], settings['density'])
            page_progress(position, len(pages), '正在给第 %d 页加水印' % (pno + 1))
        out = out_path(ctx, base_of(name), '_watermark', 'pdf')
        total = doc.page_count
        save_pdf(doc, out)
    finally:
        try:
            doc.close()
        except Exception:
            pass
    return pdf_record(ctx, out, total)


def op_watermark(ctx):
    require_fitz()
    pairs = input_paths(ctx)
    if not pairs:
        raise fail('NO_INPUT', '没有收到输入文件', '请重新上传文件后重试')
    kind = ctx.choice('kind', 'text', ('text', 'image'))
    settings = {
        'kind': kind,
        'text': ctx.text('text', '内部资料') or '内部资料',
        'font_size': clamp(ctx.number('fontSize', 48), 6, 200),
        'color': parse_color(ctx.raw('color') or '#808080', (0.5, 0.5, 0.5)),
        'scale': clamp(ctx.number('scale', 40), 2, 100),
        'position': ctx.choice('position', 'center', ('center', 'tiled', 'diagonal')),
        'opacity': clamp(ctx.number('opacity', 0.25), 0.01, 1.0),
        'rotation': ctx.number('rotation', 45),
        'density': int(clamp(ctx.number('density', 3), 1, 12)),
        'image': None,
    }
    pdf_targets = []
    image_sources = []
    for path, name in pairs:
        extension = ext_of(name) or ext_of(path)
        if extension in IMAGE_EXTS:
            image_sources.append((path, name))
        else:
            pdf_targets.append((path, name))
    if not pdf_targets:
        raise fail('NO_INPUT', '没有可添加水印的 PDF 文件', '请同时上传 PDF 文件')
    if kind == 'image':
        if not image_sources:
            raise fail('BAD_PARAMS', '图片水印需要额外上传一张图片', '请同时上传水印图片与要处理的 PDF')
        settings['image'] = _prepare_watermark_image(image_sources[0][0],
                                                     settings['opacity'], settings['rotation'])
    items = []
    for index, (path, name) in enumerate(pdf_targets):
        try:
            record = _watermark_one(ctx, path, name, settings)
            items.append(make_item(name, [record]))
        except Exception as exc:
            items.append(make_item(name, [], error_of(exc)))
        page_progress(index, len(pdf_targets), '正在处理 %s' % os.path.basename(name))
    return items


# --------------------------------------------------------------------------- #
# mode: env
# --------------------------------------------------------------------------- #

def mode_env():
    soffice = find_soffice()
    info = {
        'ok': True,
        'pymupdf': None,
        'libreoffice': bool(soffice),
        'soffice': soffice,
        'ocr': bool(ocr_available()),
        'ocrEngine': 'rapidocr' if ocr_available() else None,
        'python': platform.python_version(),
        'engine': ENGINE_VERSION,
    }
    if fitz is not None:
        version = getattr(fitz, 'version', None)
        if isinstance(version, (tuple, list)) and version:
            version = version[0]
        if not version:
            version = getattr(fitz, '__version__', None)
        info['pymupdf'] = str(version) if version else 'unknown'
    return info


# --------------------------------------------------------------------------- #
# mode: run
# --------------------------------------------------------------------------- #

OPS = {
    'pdf2word': op_pdf2word,
    'pdf2excel': op_pdf2excel,
    'pdf2ppt': op_pdf2ppt,
    'pdf2image': op_pdf2image,
    'pdf2text': op_pdf2text,
    'toPDF': op_toPDF,
    'merge': op_merge,
    'split': op_split,
    'compress': op_compress,
    'encrypt': op_encrypt,
    'decrypt': op_decrypt,
    'rotate': op_rotate,
    'deletePages': op_deletePages,
    'extractPages': op_extractPages,
    'insertBlank': op_insertBlank,
    'resize': op_resize,
    'batchResize': op_batchResize,
    'crop': op_crop,
    'pageNumber': op_pageNumber,
    'ocr': op_ocr,
    'extractImages': op_extractImages,
    'extractToc': op_extractToc,
    'watermark': op_watermark,
}


def mode_run(job):
    ctx = Ctx(job)
    require_fitz()
    ctx.ensure_out_dir()
    if not ctx.op:
        raise fail('BAD_JOB', '任务缺少 op 字段', '请重新提交任务')
    handler = OPS.get(ctx.op)
    if handler is None:
        raise fail('UNKNOWN_OP', 'PDF 引擎不支持该操作：%s' % ctx.op, '请升级插件后重试')
    started = time.time()
    progress(0.02, '正在读取文件')
    items = handler(ctx)
    if not isinstance(items, list):
        items = []
    total_pages = 0
    output_count = 0
    for item in items:
        for output in item.get('outputs') or []:
            output_count += 1
            try:
                total_pages += int(output.get('pages') or 0)
            except (TypeError, ValueError):
                pass
    meta = {
        'pages': total_pages,
        'outputs': output_count,
        'durationMs': int((time.time() - started) * 1000),
    }
    meta.update(ctx.extra_meta)
    if ctx.warnings:
        meta['warnings'] = ctx.warnings[:40]
    progress(0.99, '正在整理结果')
    return {'ok': True, 'items': items, 'meta': meta}


# --------------------------------------------------------------------------- #
# mode: text (readText, used by every AI operation)
# --------------------------------------------------------------------------- #

def mode_text(job):
    ctx = Ctx(job)
    require_fitz()
    path, name = single_input(ctx)
    doc = open_pdf(path, ctx.password() or None)
    try:
        pages = parse_page_range(ctx.text('pageRange'), doc.page_count)
        collected = []
        characters = 0
        empty_pages = []
        for position, pno in enumerate(pages):
            try:
                text = doc[pno].get_text('text') or ''
            except Exception:
                text = ''
            text = text.replace('\x00', '')
            if not text.strip():
                empty_pages.append(pno + 1)
            characters += len(text)
            collected.append({'page': pno + 1, 'text': text})
            page_progress(position, len(pages), '正在提取第 %d 页文字' % (pno + 1))
        return {
            'ok': True,
            'pages': collected,
            'chars': characters,
            'emptyPages': empty_pages,
            'count': doc.page_count,
            'name': name,
        }
    finally:
        try:
            doc.close()
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# mode: preview / probe
# --------------------------------------------------------------------------- #

def mode_preview(job):
    ctx = Ctx(job)
    require_fitz()
    path, _name = single_input(ctx)
    target = str(job.get('target') or '')
    if not target:
        raise fail('BAD_JOB', '预览任务缺少 target 字段', '')
    doc = open_pdf(path, ctx.password() or None)
    try:
        page_number = int(clamp(ctx.integer('page', 1), 1, doc.page_count))
        width = int(clamp(ctx.number('width', 900), 120, 2400))
        page = doc[page_number - 1]
        zoom = width / max(1.0, page.rect.width)
        dpi = clamp(zoom * 72.0, 24.0, 1500.0)
        pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72.0, dpi / 72.0), alpha=False)
        directory = os.path.dirname(os.path.abspath(target))
        if directory:
            os.makedirs(directory, exist_ok=True)
        pix.save(target)
        return {'ok': True, 'path': target, 'width': pix.width, 'height': pix.height,
                'page': page_number, 'count': doc.page_count}
    finally:
        try:
            doc.close()
        except Exception:
            pass


def mode_probe(job):
    ctx = Ctx(job)
    require_fitz()
    path, name = single_input(ctx)
    doc = open_pdf(path, ctx.password() or None)
    try:
        pages = []
        for index in range(doc.page_count):
            rect = doc[index].rect
            pages.append({'width': round(float(rect.width), 2), 'height': round(float(rect.height), 2)})
        return {'ok': True, 'count': doc.page_count, 'pages': pages, 'name': name}
    finally:
        try:
            doc.close()
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# mode: build (textDoc / tableDoc produced by the AI pipeline)
# --------------------------------------------------------------------------- #

def _normalise_segments(raw):
    segments = []
    if not isinstance(raw, list):
        return segments
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        segments.append({
            'page': entry.get('page'),
            'original': str(entry.get('original') or ''),
            'translated': str(entry.get('translated') or ''),
        })
    return segments


def build_text_doc(ctx):
    docx_module = lazy_import('docx', 'DOCX_MISSING', '缺少 python-docx，无法生成 Word 文档',
                              '请把 python-docx 安装到运行环境后重试')
    segments = _normalise_segments(ctx.raw('segments'))
    title = ctx.text('title', '') or '文档'
    output_format = str(ctx.raw('format') or 'pdf').lower()
    if output_format not in ('pdf', 'docx', 'txt'):
        output_format = 'pdf'
    bilingual = ctx.flag('bilingual', True)
    base = base_of(title)

    if output_format == 'pdf':
        out = out_path(ctx, base, '', 'pdf')
        writer = pdf_writer(out, PAPER['A4'])
        writer['add_text'](title, 19, color=(0.12, 0.23, 0.58))
        writer['add_rule']()
        total = max(1, len(segments))
        for index, segment in enumerate(segments):
            page_number = segment.get('page')
            original = segment.get('original') or ''
            translated = segment.get('translated') or ''
            if page_number is not None:
                writer['add_text']('第 %s 页' % page_number, 9.5, color=(0.45, 0.45, 0.45), space_before=10)
            if bilingual and original:
                writer['add_text'](original, 10.5, color=(0.3, 0.3, 0.3))
            if translated:
                writer['add_text'](translated, 10.5, color=(0.05, 0.05, 0.05),
                                   space_before=2 if (bilingual and original) else 0)
            page_progress(index, total, '正在排版第 %d 段' % (index + 1), 0.1, 0.9)
        pages = writer['finish']()
        return [pdf_record(ctx, out, pages)]

    if output_format == 'docx':
        document = docx_module.Document()
        document.add_heading(title, 0)
        for segment in segments:
            if segment.get('page') is not None:
                paragraph = document.add_paragraph()
                run = paragraph.add_run('第 %s 页' % segment['page'])
                _docx_apply_run(run, size=9.5, bold=True, color=(0.45, 0.45, 0.45))
            if bilingual and segment.get('original'):
                paragraph = document.add_paragraph()
                run = paragraph.add_run(segment['original'])
                _docx_apply_run(run, size=10.5, color=(0.35, 0.35, 0.35),
                                font_name='宋体' if has_cjk(segment['original']) else 'Calibri')
            if segment.get('translated'):
                paragraph = document.add_paragraph()
                run = paragraph.add_run(segment['translated'])
                _docx_apply_run(run, size=10.5,
                                font_name='宋体' if has_cjk(segment['translated']) else 'Calibri')
        if not segments:
            document.add_paragraph('（没有可输出的内容）')
        out = out_path(ctx, base, '', 'docx')
        try:
            document.save(out)
        except Exception as exc:
            raise fail('SAVE_FAILED', '无法写出 Word 文档：%s' % exc, '请检查输出目录权限与磁盘空间')
        return [output_record(out, 'docx')]

    chunks = [title, '']
    for segment in segments:
        if segment.get('page') is not None:
            chunks.append('===== 第 %s 页 =====' % segment['page'])
        if bilingual and segment.get('original'):
            chunks.append(segment['original'])
        if segment.get('translated'):
            chunks.append(segment['translated'])
        chunks.append('')
    if not segments:
        chunks.append('（没有可输出的内容）')
    out = out_path(ctx, base, '', 'txt')
    with open(out, 'w', encoding='utf-8') as handle:
        handle.write('\n'.join(chunks).strip() + '\n')
    return [output_record(out, 'text')]


def build_table_doc(ctx):
    docx_module = lazy_import('docx', 'DOCX_MISSING', '缺少 python-docx，无法生成 Word 文档',
                              '请把 python-docx 安装到运行环境后重试')
    headers = ctx.raw('headers')
    headers = [str(item) for item in headers] if isinstance(headers, list) else []
    raw_rows = ctx.raw('rows')
    rows = []
    if isinstance(raw_rows, list):
        for row in raw_rows:
            if isinstance(row, (list, tuple)):
                rows.append([str(cell) if cell is not None else '' for cell in row])
            else:
                rows.append([str(row)])
    title = ctx.text('title', '') or '信息提取结果'
    output_format = str(ctx.raw('format') or 'xlsx').lower()
    base = base_of(title)
    width = max([len(headers)] + [len(row) for row in rows] or [1])
    headers = headers + [''] * (width - len(headers))
    rows = [row + [''] * (width - len(row)) for row in rows]

    if output_format == 'md':
        lines = ['# %s' % title, '']
        lines.append('| ' + ' | '.join(cell.replace('|', '\\|') for cell in headers) + ' |')
        lines.append('| ' + ' | '.join('---' for _ in headers) + ' |')
        for row in rows:
            lines.append('| ' + ' | '.join(cell.replace('|', '\\|').replace('\n', ' ') for cell in row) + ' |')
        out = out_path(ctx, base, '', 'md')
        with open(out, 'w', encoding='utf-8') as handle:
            handle.write('\n'.join(lines) + '\n')
        return [output_record(out, 'md')]

    if output_format == 'docx':
        document = docx_module.Document()
        document.add_heading(title, 0)
        _docx_add_table(document, [headers] + rows)
        out = out_path(ctx, base, '', 'docx')
        try:
            document.save(out)
        except Exception as exc:
            raise fail('SAVE_FAILED', '无法写出 Word 文档：%s' % exc, '请检查输出目录权限与磁盘空间')
        return [output_record(out, 'docx')]

    openpyxl = lazy_import('openpyxl', 'OPENPYXL_MISSING', '缺少 openpyxl，无法生成 Excel 文档',
                           '请把 openpyxl 安装到运行环境后重试')
    workbook = openpyxl.Workbook()
    worksheet = workbook.active
    worksheet.title = _sheet_name(_ILLEGAL_SHEET.sub('_', title)[:31] or '数据', workbook)
    _write_sheet(worksheet, [headers] + rows)
    out = out_path(ctx, base, '', 'xlsx')
    try:
        workbook.save(out)
    except Exception as exc:
        raise fail('SAVE_FAILED', '无法写出 Excel 文档：%s' % exc, '请检查输出目录权限与磁盘空间')
    return [output_record(out, 'xlsx')]


def mode_build(job):
    ctx = Ctx(job)
    require_fitz()
    ctx.ensure_out_dir()
    kind = str(ctx.raw('kind') or job.get('op') or '')
    if kind == 'textDoc':
        outputs = build_text_doc(ctx)
    elif kind == 'tableDoc':
        outputs = build_table_doc(ctx)
    else:
        raise fail('BAD_PARAMS', '未知的 build 类型：%s' % kind, '')
    if not outputs:
        raise fail('NO_OUTPUT', '没有生成任何文档', '')
    return {'ok': True, 'outputs': outputs}


# --------------------------------------------------------------------------- #
# entry point
# --------------------------------------------------------------------------- #

def load_job(path):
    if not path or not os.path.isfile(path):
        raise fail('BAD_JOB', '找不到任务文件', '请重新提交任务')
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            content = json.load(handle)
    except Exception as exc:
        raise fail('BAD_JOB', '无法读取任务文件：%s' % exc, '')
    if not isinstance(content, dict):
        raise fail('BAD_JOB', '任务文件格式不正确', '')
    return content


def main(argv):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass
    mode = argv[1] if len(argv) > 1 else ''
    job_path = argv[2] if len(argv) > 2 else None
    try:
        if mode == 'env':
            result = mode_env()
        else:
            job = load_job(job_path)
            if mode == 'run':
                result = mode_run(job)
            elif mode == 'text':
                result = mode_text(job)
            elif mode == 'build':
                result = mode_build(job)
            elif mode == 'preview':
                result = mode_preview(job)
            elif mode == 'probe':
                result = mode_probe(job)
            else:
                raise fail('BAD_MODE', '未知的引擎模式：%s' % mode, '')
    except EngineError as exc:
        result = {'ok': False, 'error': exc.payload()}
    except Exception as exc:                       # crash guard: never leak a traceback to stdout
        traceback.print_exc(file=sys.stderr)
        result = {'ok': False, 'error': {
            'code': 'ENGINE_CRASH',
            'message': 'PDF 引擎内部错误：%s' % exc,
            'hint': '请重试，或换一个文件后重试',
        }}
    try:
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + '\n')
        sys.stdout.flush()
    except Exception:
        try:
            sys.stdout.write(json.dumps({'ok': False, 'error': {
                'code': 'ENGINE_CRASH', 'message': '结果序列化失败', 'hint': ''}}) + '\n')
            sys.stdout.flush()
        except Exception:
            pass
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
