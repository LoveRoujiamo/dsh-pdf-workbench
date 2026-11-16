#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""End-to-end selftest for ``pdf_engine.py``.

Run it through the helper script (it locates the interpreter for you)::

    bash scripts/verify.sh

or by hand::

    PYROOT=$DSH_HOME/dsh-runtimes/<runtime>/dependencies/python
    cd pdf-workbench
    PYTHONHOME="$PYROOT" PDFW_PYLIB="$PWD/engine/runtime/pylib" \
      engine/runtime/python/bin/python3.12 engine/selftest.py

The script generates its own fixtures with PyMuPDF (mixed Chinese/English text,
a ruled table, an embedded image, bookmarks, a hyperlink, annotations), then
drives the engine exactly the way the Host does — a child process with a
job.json — and asserts on the returned JSON plus every produced artefact.

Exit code is 0 only when every check passes.
"""

import io
import os
import re
import sys
import json
import time
import shutil
import zipfile
import tempfile
import subprocess
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.join(HERE, 'pdf_engine.py')
# engine/runtime/pylib for a checkout; PDFW_PYLIB wins for an installed package.
PYLIB = os.environ.get('PDFW_PYLIB') or os.path.join(HERE, 'runtime', 'pylib')
sys.path.insert(0, PYLIB)

try:
    import pymupdf as fitz                 # noqa: E402
except ImportError:                        # pragma: no cover
    try:
        import fitz                        # noqa: E402
    except ImportError:
        sys.stderr.write(
            'PyMuPDF is not importable by this interpreter.\n'
            'Run `bash scripts/bootstrap.sh` first, then `bash scripts/verify.sh`,\n'
            'or set PDFW_PYLIB to the directory holding pymupdf.\n')
        raise SystemExit(2)
from PIL import Image                      # noqa: E402

PYTHON = sys.executable
WORK = tempfile.mkdtemp(prefix='pdfw-selftest-')
ENV = dict(os.environ)
ENV['PYTHONPATH'] = PYLIB + (os.pathsep + ENV['PYTHONPATH'] if ENV.get('PYTHONPATH') else '')
ENV['PYTHONIOENCODING'] = 'utf-8'
ENV['PYTHONUNBUFFERED'] = '1'

RESULTS = []
COUNTER = [0]


# --------------------------------------------------------------------------- #
# tiny assertion / reporting helpers
# --------------------------------------------------------------------------- #

def expect(condition, message):
    if not condition:
        raise AssertionError(message)


def fmt_size(value):
    value = float(value or 0)
    if value >= 1024 * 1024:
        return '%.1f MB' % (value / 1048576.0)
    if value >= 1024:
        return '%.1f KB' % (value / 1024.0)
    return '%d B' % value


def record(name, ok, detail='', elapsed=0.0, size=0):
    RESULTS.append({'name': name, 'ok': ok, 'detail': detail,
                    'elapsed': elapsed, 'size': size})
    mark = '\u2713' if ok else '\u2717'
    sys.stdout.write('%s %-38s %7.2fs %9s  %s\n'
                     % (mark, name, elapsed, fmt_size(size), detail))
    sys.stdout.flush()


def test(name, function):
    started = time.time()
    try:
        detail, size = function()
        record(name, True, detail, time.time() - started, size)
    except AssertionError as exc:
        record(name, False, str(exc), time.time() - started, 0)
    except Exception as exc:                        # noqa: BLE001 - report, keep going
        record(name, False, '%s: %s' % (type(exc).__name__, exc), time.time() - started, 0)
        if os.environ.get('PDFW_SELFTEST_VERBOSE'):
            traceback.print_exc()


# --------------------------------------------------------------------------- #
# engine driver
# --------------------------------------------------------------------------- #

def run_engine(mode, body, timeout=900):
    """Spawn the engine like the Host does and return its parsed result."""
    COUNTER[0] += 1
    if body is None:
        job_path = os.path.join(WORK, 'unused-env-%d.json' % COUNTER[0])
        command = [PYTHON, ENGINE, mode, job_path]
    else:
        job_path = os.path.join(WORK, 'job-%04d-%s.json' % (COUNTER[0], mode))
        with open(job_path, 'w', encoding='utf-8') as handle:
            json.dump(body, handle, ensure_ascii=False)
        command = [PYTHON, ENGINE, mode, job_path]
    started = time.time()
    proc = subprocess.run(command, capture_output=True, text=True,
                          timeout=timeout, env=ENV, cwd=HERE)
    elapsed = time.time() - started
    lines = [line for line in (proc.stdout or '').strip().splitlines() if line.strip()]
    expect(len(lines) == 1,
           'engine stdout must be exactly one JSON line, got %r (stderr tail: %r)'
           % (proc.stdout[:400], (proc.stderr or '')[-400:]))
    try:
        result = json.loads(lines[0])
    except json.JSONDecodeError as exc:
        raise AssertionError('engine stdout is not JSON: %s (%r)' % (exc, lines[0][:400]))
    expect(isinstance(result, dict), 'engine result is not an object')
    return {'result': result, 'elapsed': elapsed, 'stderr': proc.stderr or ''}


def input_entries(paths):
    entries = []
    for path in paths:
        entries.append({'path': os.path.abspath(path),
                        'name': os.path.basename(path),
                        'size': os.path.getsize(path)})
    return entries


def run_op(op, params, inputs=None, tag=None, timeout=900):
    tag = tag or ('%s-%d' % (op, COUNTER[0]))
    out_dir = os.path.join(WORK, 'out', re.sub(r'[^A-Za-z0-9_.-]', '_', tag))
    os.makedirs(out_dir, exist_ok=True)
    body = {'op': op, 'params': params,
            'inputs': input_entries(inputs if inputs is not None else [SAMPLE]),
            'outDir': out_dir}
    report = run_engine('run', body, timeout=timeout)
    return report, out_dir


def ok_result(report, label):
    result = report['result']
    expect(result.get('ok') is True,
           '%s: engine returned ok=false -> %s' % (label, result.get('error')))
    expect(bool(result.get('items')), '%s: engine returned no items' % label)
    return result


def outputs_of(result):
    outputs = []
    for item in result.get('items') or []:
        for output in item.get('outputs') or []:
            outputs.append(output)
    return outputs


def outputs_with_kind(result, kind):
    return [output for output in outputs_of(result) if output.get('kind') == kind]


def total_bytes(outputs):
    return sum(int(output.get('bytes') or 0) for output in outputs)


def open_output_pdf(path, expected_pages=None):
    expect(os.path.isfile(path), 'output PDF is missing: %s' % path)
    expect(os.path.getsize(path) > 200, 'output PDF is suspiciously small: %s' % path)
    try:
        doc = fitz.open(path)
    except Exception as exc:
        raise AssertionError('cannot re-open output PDF %s: %s' % (path, exc))
    expect(doc.page_count > 0, 'output PDF has no pages: %s' % path)
    if expected_pages is not None:
        expect(doc.page_count == expected_pages,
               'expected %d pages, got %d (%s)' % (expected_pages, doc.page_count, path))
    return doc


def expect_vector_text(path):
    doc = open_output_pdf(path)
    try:
        text = ''.join(doc[index].get_text() for index in range(min(doc.page_count, 3)))
    finally:
        doc.close()
    expect(len(text.strip()) > 0,
           'text layer is empty — the page was probably rasterised: %s' % path)
    return text


# --------------------------------------------------------------------------- #
# fixtures
# --------------------------------------------------------------------------- #

SAMPLE = os.path.join(WORK, 'sample.pdf')
SECOND = os.path.join(WORK, 'second.pdf')
SCANNED = os.path.join(WORK, 'scanned.pdf')
BROKEN = os.path.join(WORK, 'broken.pdf')
ROTATED = os.path.join(WORK, 'rotated.pdf')
BIG_IMAGE = os.path.join(WORK, 'bigimage.pdf')
FIX_PNG = os.path.join(WORK, 'watermark.png')
FIX_TXT = os.path.join(WORK, 'notes.txt')
FIX_DOCX = os.path.join(WORK, 'office.docx')


def build_sample_pdf(path):
    doc = fitz.open()

    page = doc.new_page(width=595, height=842)
    page.insert_text((60, 92), 'PDF 全能工具台 测试文档', fontname='china-s', fontsize=22)
    page.insert_text((60, 122), 'Test Document for the PDF Workbench engine',
                     fontname='helv', fontsize=13)
    body = ('这是一段中英文混排的正文，用于验证文字提取、排版与转换质量。\n'
            'The quick brown fox jumps over the lazy dog 0123456789.\n'
            '第二段落：合同金额为人民币壹万元整，签署日期为 2026 年 11 月 16 日。')
    page.insert_textbox(fitz.Rect(60, 150, 535, 300), body,
                        fontname='china-s', fontsize=11.5, lineheight=1.4)
    page.insert_text((60, 340), 'https://example.com/pdf-workbench',
                     fontname='helv', fontsize=11, color=(0.1, 0.2, 0.7))
    page.insert_link({'kind': fitz.LINK_URI,
                      'from': fitz.Rect(58, 328, 300, 346),
                      'uri': 'https://example.com/pdf-workbench'})
    note = page.add_text_annot(fitz.Point(540, 170), '批注：请核对此条款')
    note.set_info({'content': '批注：请核对此条款', 'title': '审阅人'})
    note.update()
    picture = Image.new('RGB', (240, 160), (235, 242, 255))
    for x in range(20, 220, 40):
        for y in range(20, 140, 40):
            picture.paste((90, 120, 200), (x, y, x + 26, y + 26))
    buffer = io.BytesIO()
    picture.save(buffer, 'PNG')
    page.insert_image(fitz.Rect(330, 380, 530, 500), stream=buffer.getvalue())

    page2 = doc.new_page(width=595, height=842)
    page2.insert_text((60, 80), '第二章 数据表 Data Table', fontname='china-s', fontsize=16)
    x0, y0, cw, ch = 60, 110, 150, 32
    rows = [['甲方 Party A', '乙方 Party B', '金额 Amount'],
            ['北京示例科技有限公司', '上海示例贸易有限公司', '10000'],
            ['广州样例信息技术有限公司', '深圳样例物流有限公司', '25000']]
    for index in range(len(rows) + 1):
        page2.draw_line((x0, y0 + index * ch), (x0 + 3 * cw, y0 + index * ch),
                        color=(0.3, 0.3, 0.3))
    for index in range(4):
        page2.draw_line((x0 + index * cw, y0), (x0 + index * cw, y0 + len(rows) * ch),
                        color=(0.3, 0.3, 0.3))
    for row_index, row in enumerate(rows):
        for column_index, value in enumerate(row):
            page2.insert_text((x0 + column_index * cw + 6, y0 + row_index * ch + 21),
                              value, fontname='china-s', fontsize=10.5)

    page3 = doc.new_page(width=595, height=842)
    page3.insert_text((60, 90), '第三章 结论 Conclusion', fontname='china-s', fontsize=16)
    page3.insert_textbox(
        fitz.Rect(60, 120, 535, 400),
        '本测试文档由 PDF 引擎自测脚本自动生成。\n'
        'This paragraph exists so extraction and conversion assertions are meaningful. '
        '中文与英文混排 second line of the conclusion.',
        fontname='china-s', fontsize=11.5)

    # the internal link needs its target page to exist, so add it last
    doc[0].insert_link({'kind': fitz.LINK_GOTO,
                        'from': fitz.Rect(58, 350, 200, 368),
                        'page': 1, 'to': fitz.Point(0, 0)})

    doc.set_toc([[1, '第一章 概述', 1],
                 [2, '1.1 背景', 1],
                 [1, '第二章 数据', 2],
                 [1, '第三章 结论', 3]])
    doc.set_metadata({'title': '测试合同 Sample Contract',
                      'author': 'PDF Workbench Selftest',
                      'subject': 'engine selftest fixture',
                      'keywords': 'pdf, selftest, 中文'})
    doc.save(path, garbage=4, deflate=True)
    doc.close()


def build_second_pdf(path):
    doc = fitz.open()
    for index in range(2):
        page = doc.new_page(width=595, height=842)
        page.insert_text((60, 100), '附录 %d Appendix %d' % (index + 1, index + 1),
                         fontname='china-s', fontsize=18)
        page.insert_textbox(fitz.Rect(60, 140, 520, 300),
                            '附加文档内容 supplemental content %d' % index,
                            fontname='china-s', fontsize=11)
    doc.set_toc([[1, '附录', 1]])
    doc.save(path, garbage=4, deflate=True)
    doc.close()


def build_scanned_pdf(path):
    source = fitz.open()
    page = source.new_page(width=595, height=400)
    page.insert_text((60, 120), '扫描件识别测试 发票号 76891234',
                     fontname='china-s', fontsize=22)
    page.insert_text((60, 180), 'Invoice Total 1,234.56 CNY', fontname='helv', fontsize=16)
    png = page.get_pixmap(dpi=200).tobytes('png')
    source.close()
    image_only = fitz.open()
    target = image_only.new_page(width=595, height=400)
    target.insert_image(target.rect, stream=png)
    image_only.save(path, garbage=4, deflate=True)
    image_only.close()


def build_rotated_pdf(path):
    doc = fitz.open()
    page = doc.new_page(width=300, height=500)
    page.insert_text((30, 60), 'ROTATED 旋转页面', fontname='china-s', fontsize=18)
    page.set_rotation(90)
    doc.save(path, garbage=4, deflate=True)
    doc.close()


def build_big_image_pdf(path):
    image = Image.new('RGB', (2000, 2000), (30, 60, 90))
    pixels = image.load()
    for x in range(0, 2000, 17):
        for y in range(0, 2000, 23):
            pixels[x, y] = ((x * 7) % 255, (y * 13) % 255, ((x + y) * 3) % 255)
    buffer = io.BytesIO()
    image.save(buffer, 'JPEG', quality=95)
    doc = fitz.open()
    page = doc.new_page(width=400, height=400)
    page.insert_image(fitz.Rect(20, 20, 380, 380), stream=buffer.getvalue())
    doc.save(path, deflate=True)
    doc.close()


def build_image_fixture(path):
    image = Image.new('RGBA', (240, 120), (0, 0, 0, 0))
    for x in range(0, 240, 24):
        for y in range(0, 120, 24):
            image.paste((31, 58, 147, 200), (x, y, x + 18, y + 18))
    image.save(path)


def build_text_fixture(path):
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write('纯文本转 PDF 测试\nPlain text to PDF fixture.\n第二行第二行。\n')


def build_docx_fixture(path):
    import docx
    document = docx.Document()
    document.add_heading('Office 转 PDF 测试', 0)
    document.add_paragraph('这是一份由 python-docx 生成的测试文档 hello world。')
    table = document.add_table(rows=2, cols=2)
    table.cell(0, 0).text = '甲方'
    table.cell(0, 1).text = '乙方'
    table.cell(1, 0).text = 'A 公司'
    table.cell(1, 1).text = 'B 公司'
    document.save(path)


def build_fixtures():
    build_sample_pdf(SAMPLE)
    build_second_pdf(SECOND)
    build_scanned_pdf(SCANNED)
    build_rotated_pdf(ROTATED)
    build_big_image_pdf(BIG_IMAGE)
    build_image_fixture(FIX_PNG)
    build_text_fixture(FIX_TXT)
    build_docx_fixture(FIX_DOCX)
    with open(BROKEN, 'wb') as handle:
        handle.write(b'%PDF-1.7\nthis is definitely not a valid pdf body\n' * 40)


def render_bbox(page, dpi=72):
    """Bounding box of the non-white pixels of a rendered page (in pixels)."""
    pix = page.get_pixmap(dpi=dpi)
    samples = pix.samples
    n = pix.n
    width, height = pix.width, pix.height
    min_x, min_y, max_x, max_y = width, height, -1, -1
    for y in range(height):
        row = y * width * n
        for x in range(width):
            offset = row + x * n
            if samples[offset] < 200 or samples[offset + 1] < 200 or samples[offset + 2] < 200:
                if x < min_x:
                    min_x = x
                if x > max_x:
                    max_x = x
                if y < min_y:
                    min_y = y
                if y > max_y:
                    max_y = y
    return (min_x, min_y, max_x, max_y, width, height)


# --------------------------------------------------------------------------- #
# tests: env / probe / preview / text
# --------------------------------------------------------------------------- #

def t_env():
    report = run_engine('env', None)
    result = report['result']
    expect(result.get('ok') is True, 'env mode failed: %s' % result)
    expect(result.get('pymupdf'), 'env reports no PyMuPDF')
    return ('pymupdf=%s libreoffice=%s ocr=%s (%s)'
            % (result.get('pymupdf'), result.get('libreoffice'),
               result.get('ocr'), result.get('ocrEngine'))), 0


def t_probe():
    report = run_engine('probe', {
        'op': 'probe', 'params': {},
        'inputs': input_entries([SAMPLE]), 'outDir': WORK})
    result = report['result']
    expect(result.get('ok') is True, 'probe failed: %s' % result)
    expect(result.get('count') == 3, 'probe count=%r' % result.get('count'))
    pages = result.get('pages') or []
    expect(len(pages) == 3, 'probe returned %d page sizes' % len(pages))
    expect(abs(pages[0]['width'] - 595.0) < 1.0, 'probe page width %r' % pages[0])
    return 'count=3 width=%.1f height=%.1f' % (pages[0]['width'], pages[0]['height']), 0


def t_preview():
    target = os.path.join(WORK, 'preview-page1.png')
    report = run_engine('preview', {
        'op': 'preview', 'params': {'page': 1, 'width': 600},
        'inputs': input_entries([SAMPLE]), 'outDir': WORK, 'target': target})
    result = report['result']
    expect(result.get('ok') is True, 'preview failed: %s' % result)
    expect(os.path.isfile(target), 'preview PNG was not written')
    image = Image.open(target)
    image.load()
    expect(abs(image.size[0] - 600) <= 8,
           'preview width %d is not close to the requested 600' % image.size[0])
    return 'png=%dx%d' % image.size, os.path.getsize(target)


def t_text_mode():
    report = run_engine('text', {
        'op': 'readText', 'params': {'pageRange': ''},
        'inputs': input_entries([SAMPLE]), 'outDir': WORK})
    result = report['result']
    expect(result.get('ok') is True, 'text mode failed: %s' % result)
    pages = result.get('pages') or []
    expect(len(pages) == 3, 'text mode returned %d pages' % len(pages))
    expect(result.get('chars', 0) > 100, 'text mode chars=%r' % result.get('chars'))
    expect(result.get('emptyPages') == [], 'text mode emptyPages=%r' % result.get('emptyPages'))
    expect('甲方' in (pages[1].get('text') or ''), 'page 2 text lost the table content')
    expect(pages[0].get('page') == 1, 'page numbers must be 1-based')
    # pageRange must be honoured
    report = run_engine('text', {
        'op': 'readText', 'params': {'pageRange': '3'},
        'inputs': input_entries([SAMPLE]), 'outDir': WORK})
    subset = report['result']
    expect(subset.get('ok') is True, 'text mode pageRange failed: %s' % subset)
    expect(len(subset.get('pages') or []) == 1, 'pageRange=3 should return one page')
    expect(subset['pages'][0]['page'] == 3, 'pageRange=3 returned page %r' % subset['pages'][0]['page'])
    return 'chars=%d pages=3 (range honoured)' % result.get('chars'), 0


# --------------------------------------------------------------------------- #
# tests: conversions
# --------------------------------------------------------------------------- #

def t_pdf2word_flow():
    report, _out = run_op('pdf2word', {'layout': 'flow', 'keepImages': True, 'pageRange': ''},
                          tag='pdf2word-flow')
    result = ok_result(report, 'pdf2word flow')
    outputs = outputs_with_kind(result, 'docx')
    expect(len(outputs) == 1, 'pdf2word produced %d docx files' % len(outputs))
    path = outputs[0]['path']
    import docx
    document = docx.Document(path)
    text = '\n'.join(paragraph.text for paragraph in document.paragraphs)
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                text += '\n' + cell.text
    expect(len(document.paragraphs) >= 3, 'docx has only %d paragraphs' % len(document.paragraphs))
    expect('PDF 全能工具台' in text, 'docx lost the Chinese title: %r' % text[:160])
    expect('甲方' in text, 'docx lost the table text')
    expect(len(document.tables) >= 1, 'docx did not create a table')
    inline_images = len(document.inline_shapes)
    expect(inline_images >= 1, 'docx kept no image')
    return ('paragraphs=%d tables=%d images=%d'
            % (len(document.paragraphs), len(document.tables), inline_images)), total_bytes(outputs)


def t_pdf2word_positioned():
    report, _out = run_op('pdf2word', {'layout': 'positioned', 'keepImages': True, 'pageRange': '1-2'},
                          tag='pdf2word-positioned')
    result = ok_result(report, 'pdf2word positioned')
    outputs = outputs_with_kind(result, 'docx')
    expect(len(outputs) == 1, 'pdf2word positioned produced %d files' % len(outputs))
    import docx
    document = docx.Document(outputs[0]['path'])
    text = '\n'.join(paragraph.text for paragraph in document.paragraphs)
    expect('第二章' in text, 'positioned docx lost page 2 content')
    indents = [paragraph.paragraph_format.left_indent
               for paragraph in document.paragraphs
               if paragraph.paragraph_format.left_indent]
    return 'paragraphs=%d indented=%d' % (len(document.paragraphs), len(indents)), total_bytes(outputs)


def t_pdf2excel():
    report, _out = run_op('pdf2excel', {'splitBy': 'table', 'pageRange': ''}, tag='pdf2excel')
    result = ok_result(report, 'pdf2excel')
    outputs = outputs_with_kind(result, 'xlsx')
    expect(len(outputs) == 1, 'pdf2excel produced %d xlsx files' % len(outputs))
    import openpyxl
    workbook = openpyxl.load_workbook(outputs[0]['path'])
    expect(len(workbook.worksheets) >= 1, 'xlsx has no worksheets')
    values = []
    for worksheet in workbook.worksheets:
        for row in worksheet.iter_rows(values_only=True):
            values.extend(str(cell) for cell in row if cell not in (None, ''))
    joined = ' | '.join(values)
    expect('甲方' in joined, 'xlsx lost the table header, got: %r' % joined[:200])
    expect(any('10000' in value for value in values), 'xlsx lost numeric cell 10000')
    # fallback path: a page without tables must still produce a sheet, not an error
    report, _out = run_op('pdf2excel', {'splitBy': 'page', 'pageRange': '1,3'}, tag='pdf2excel-page')
    result = ok_result(report, 'pdf2excel by page')
    expect(len(outputs_with_kind(result, 'xlsx')) == 1, 'pdf2excel by page failed')
    return 'sheets=%d cells=%d' % (len(workbook.worksheets), len(values)), total_bytes(outputs)


def t_pdf2ppt():
    report, _out = run_op('pdf2ppt', {'layout': 'image', 'dpi': 96, 'pageRange': ''},
                          tag='pdf2ppt-image')
    result = ok_result(report, 'pdf2ppt image')
    outputs = outputs_with_kind(result, 'pptx')
    expect(len(outputs) == 1, 'pdf2ppt produced %d pptx files' % len(outputs))
    from pptx import Presentation
    presentation = Presentation(outputs[0]['path'])
    expect(len(presentation.slides) == 3, 'pptx has %d slides' % len(presentation.slides))
    pictures = sum(1 for slide in presentation.slides for shape in slide.shapes
                   if shape.shape_type == 13 or getattr(shape, 'image', None))
    expect(pictures >= 3, 'pptx image mode placed %d pictures' % pictures)
    report, _out = run_op('pdf2ppt', {'layout': 'editable', 'pageRange': '1'},
                          tag='pdf2ppt-editable')
    result = ok_result(report, 'pdf2ppt editable')
    outputs2 = outputs_with_kind(result, 'pptx')
    editable = Presentation(outputs2[0]['path'])
    text_shapes = sum(1 for slide in editable.slides for shape in slide.shapes if shape.has_text_frame)
    return 'slides=%d pictures=%d editableTextShapes=%d' % (
        len(presentation.slides), pictures, text_shapes), total_bytes(outputs + outputs2)


def t_pdf2image():
    report, _out = run_op('pdf2image', {'format': 'jpg', 'dpi': 96, 'quality': 80, 'pageRange': ''},
                          tag='pdf2image')
    result = ok_result(report, 'pdf2image')
    images = outputs_with_kind(result, 'image')
    archives = outputs_with_kind(result, 'zip')
    expect(len(images) == 3, 'pdf2image produced %d images' % len(images))
    expect(len(archives) == 1, 'pdf2image did not bundle a zip')
    for output in images:
        image = Image.open(output['path'])
        image.load()
        expect(image.size[0] > 400, 'page image too small: %r' % (image.size,))
    with zipfile.ZipFile(archives[0]['path']) as archive:
        names = archive.namelist()
    expect(len(names) == 3, 'zip contains %d entries' % len(names))
    return 'images=3 zip=%d entries' % len(names), total_bytes(images + archives)


def t_pdf2text():
    report, _out = run_op('pdf2text', {'includePageBreaks': True, 'pageRange': ''},
                          tag='pdf2text')
    result = ok_result(report, 'pdf2text')
    outputs = outputs_with_kind(result, 'text')
    expect(len(outputs) == 1, 'pdf2text produced %d txt files' % len(outputs))
    body = open(outputs[0]['path'], encoding='utf-8').read()
    expect('PDF 全能工具台' in body, 'txt lost the title')
    expect('第 1 页' in body, 'txt lost page markers')
    expect('第三章' in body, 'txt lost page 3')
    return 'chars=%d' % len(body), total_bytes(outputs)


def t_toPDF():
    report, _out = run_op('toPDF', {'combine': False, 'pageSize': 'auto'},
                          inputs=[FIX_DOCX, FIX_PNG, FIX_TXT], tag='toPDF-single')
    result = ok_result(report, 'toPDF single')
    items = result['items']
    expect(len(items) == 3, 'toPDF returned %d items for 3 inputs' % len(items))
    for item in items:
        expect(item.get('ok') is True, 'toPDF item failed: %s (%s)'
               % (item.get('input'), item.get('error')))
        for output in item.get('outputs') or []:
            doc = open_output_pdf(output['path'])
            doc.close()
    single_outputs = outputs_of(result)
    expect(len(single_outputs) == 3, 'toPDF single produced %d outputs' % len(single_outputs))
    report, _out = run_op('toPDF', {'combine': True, 'pageSize': 'A4'},
                          inputs=[FIX_DOCX, FIX_PNG, FIX_TXT], tag='toPDF-combined')
    result = ok_result(report, 'toPDF combine')
    combined = outputs_of(result)
    expect(len(combined) == 1, 'toPDF combine produced %d outputs' % len(combined))
    doc = open_output_pdf(combined[0]['path'])
    pages = doc.page_count
    toc = doc.get_toc()
    doc.close()
    expect(pages >= 3, 'combined PDF has only %d pages' % pages)
    expect(len(toc) >= 2, 'combined PDF has no bookmarks')
    return 'single=3 pdfs, combined pages=%d bookmarks=%d' % (pages, len(toc)), total_bytes(
        single_outputs + combined)


# --------------------------------------------------------------------------- #
# tests: edit operations
# --------------------------------------------------------------------------- #

def t_merge():
    report, _out = run_op('merge', {'addBookmarks': True}, inputs=[SAMPLE, SECOND], tag='merge')
    result = ok_result(report, 'merge')
    outputs = outputs_with_kind(result, 'pdf')
    expect(len(outputs) == 1, 'merge produced %d PDFs' % len(outputs))
    doc = open_output_pdf(outputs[0]['path'], expected_pages=5)
    toc = doc.get_toc()
    first_page = doc[0].get_text()
    last_page = doc[4].get_text()
    doc.close()
    expect('PDF 全能工具台' in first_page, 'merged file lost the first document')
    expect('附录' in last_page, 'merged file lost the second document')
    expect(len(toc) >= 2, 'merged file has only %d bookmark entries' % len(toc))
    return 'pages=5 bookmarks=%d' % len(toc), total_bytes(outputs)


def t_split_ranges():
    report, _out = run_op('split', {'mode': 'ranges', 'ranges': '1-2,3-'}, tag='split-ranges')
    result = ok_result(report, 'split ranges')
    outputs = outputs_with_kind(result, 'pdf')
    expect(len(outputs) == 2, 'split ranges produced %d files' % len(outputs))
    counts = []
    for output in outputs:
        doc = open_output_pdf(output['path'])
        counts.append(doc.page_count)
        doc.close()
    expect(sorted(counts) == [1, 2], 'split range page counts %r' % (counts,))
    return 'files=2 page_counts=%r' % (counts,), total_bytes(outputs)


def t_split_every():
    report, _out = run_op('split', {'mode': 'every', 'pagesPerFile': 1}, tag='split-every')
    result = ok_result(report, 'split every')
    outputs = outputs_with_kind(result, 'pdf')
    expect(len(outputs) == 3, 'split every produced %d files' % len(outputs))
    for output in outputs:
        doc = open_output_pdf(output['path'])
        expect(doc.page_count == 1, 'split every chunk has %d pages' % doc.page_count)
        doc.close()
    return 'files=3 pages_each=1', total_bytes(outputs)


def t_split_size():
    report, _out = run_op('split', {'mode': 'size', 'maxSizeMB': 0.2}, tag='split-size')
    result = ok_result(report, 'split size')
    outputs = outputs_with_kind(result, 'pdf')
    expect(len(outputs) >= 1, 'split size produced no files')
    total = 0
    for output in outputs:
        doc = open_output_pdf(output['path'])
        total += doc.page_count
        doc.close()
        expect(os.path.getsize(output['path']) <= 0.2 * 1024 * 1024 * 1.25,
               'split size chunk larger than the limit: %d bytes' % os.path.getsize(output['path']))
    expect(total == 3, 'split size lost pages: %d != 3' % total)
    return 'files=%d total_pages=3' % len(outputs), total_bytes(outputs)


def t_compress():
    details = []
    size = 0
    before_after = []
    for level in ('low', 'medium', 'high'):
        report, _out = run_op('compress', {'level': level, 'preserveText': True},
                              tag='compress-%s' % level)
        result = ok_result(report, 'compress %s' % level)
        outputs = outputs_with_kind(result, 'pdf')
        expect(len(outputs) == 1, 'compress %s produced %d PDFs' % (level, len(outputs)))
        doc = open_output_pdf(outputs[0]['path'], expected_pages=3)
        text = doc[0].get_text().strip()
        doc.close()
        expect(text, 'compress %s lost the text layer' % level)
        meta = result.get('meta') or {}
        expect(meta.get('beforeBytes') is not None, 'compress %s has no meta.beforeBytes' % level)
        expect(meta.get('afterBytes') is not None, 'compress %s has no meta.afterBytes' % level)
        before_after.append('%s:%d->%d' % (level, meta['beforeBytes'], meta['afterBytes']))
        size += total_bytes(outputs)
    return ' '.join(before_after), size


def t_compress_images():
    report, _out = run_op('compress', {'level': 'high', 'preserveText': True},
                          inputs=[BIG_IMAGE], tag='compress-high-image')
    result = ok_result(report, 'compress high on image-heavy PDF')
    outputs = outputs_with_kind(result, 'pdf')
    expect(len(outputs) == 1, 'compress high produced %d PDFs' % len(outputs))
    before = os.path.getsize(BIG_IMAGE)
    after = int(outputs[0].get('bytes') or 0)
    expect(after < before,
           'high compression did not shrink an image-heavy PDF (%d -> %d)' % (before, after))
    doc = open_output_pdf(outputs[0]['path'], expected_pages=1)
    images = doc[0].get_images(full=True)
    doc.close()
    expect(images, 'compressed PDF lost its image')
    max_side = max(int(images[0][2]), int(images[0][3]))
    expect(max_side <= 1200,
           'high level did not downsample the image (%d px, expected <= 1200)' % max_side)
    report, _out = run_op('compress', {'level': 'medium', 'preserveText': True},
                          inputs=[BIG_IMAGE], tag='compress-medium-image')
    result = ok_result(report, 'compress medium on image-heavy PDF')
    outputs2 = outputs_with_kind(result, 'pdf')
    doc = open_output_pdf(outputs2[0]['path'], expected_pages=1)
    images2 = doc[0].get_images(full=True)
    doc.close()
    max_side2 = max(int(images2[0][2]), int(images2[0][3])) if images2 else 0
    expect(max_side2 <= 1600,
           'medium level did not downsample the image (%d px, expected <= 1600)' % max_side2)
    return ('high: %s -> %s (%dpx) medium: %dpx'
            % (fmt_size(before), fmt_size(after), max_side, max_side2)), total_bytes(outputs + outputs2)


def t_encrypt():
    global ENCRYPTED
    report, _out = run_op('encrypt', {
        'userPassword': 'selftest-pw', 'ownerPassword': 'owner-pw',
        'allowPrint': True, 'allowModify': False, 'allowCopy': True, 'allowAnnotate': False},
        tag='encrypt')
    result = ok_result(report, 'encrypt')
    outputs = outputs_with_kind(result, 'pdf')
    expect(len(outputs) == 1, 'encrypt produced %d PDFs' % len(outputs))
    ENCRYPTED = outputs[0]['path']
    doc = fitz.open(ENCRYPTED)
    expect(doc.needs_pass == 1, 'encrypted output is not password protected')
    expect(doc.authenticate('definitely-wrong') == 0, 'wrong password unexpectedly worked')
    expect(doc.authenticate('selftest-pw') > 0, 'correct password did not open the file')
    pages = doc.page_count
    doc.close()
    # a missing password must be a NEED_PASSWORD failure, not a crash
    report, _out = run_op('pdf2text', {'includePageBreaks': True, 'pageRange': ''},
                          inputs=[ENCRYPTED], tag='encrypt-need-password')
    failure = report['result']
    expect(failure.get('ok') is False, 'encrypted input without password did not fail')
    expect((failure.get('error') or {}).get('code') == 'NEED_PASSWORD',
           'expected NEED_PASSWORD, got %r' % (failure.get('error'),))
    doc = fitz.open(ENCRYPTED)
    doc.authenticate('selftest-pw')
    permissions = int(doc.permissions)
    doc.close()
    expect(permissions & 4, 'print permission bit missing (permissions=%d)' % permissions)
    expect(permissions & 16, 'copy permission bit missing (permissions=%d)' % permissions)
    expect(not (permissions & 8), 'modify permission should be denied (permissions=%d)' % permissions)
    # a missing open password is a parameter error, not a silent unencrypted file
    report, _out = run_op('encrypt', {'userPassword': ''}, tag='encrypt-no-password')
    failure = report['result']
    expect(failure.get('ok') is False, 'encrypt without a password must not succeed')
    expect((failure.get('error') or {}).get('code') == 'BAD_PARAMS',
           'expected BAD_PARAMS, got %r' % (failure.get('error'),))
    return ('pages=%d needs_pass=1 NEED_PASSWORD honoured permissions=%d'
            % (pages, permissions)), total_bytes(outputs)


def t_decrypt():
    expect(os.path.isfile(ENCRYPTED), 'encrypt test did not produce a fixture')
    report, _out = run_op('decrypt', {'password': 'selftest-pw'},
                          inputs=[ENCRYPTED], tag='decrypt')
    result = ok_result(report, 'decrypt')
    outputs = outputs_with_kind(result, 'pdf')
    expect(len(outputs) == 1, 'decrypt produced %d PDFs' % len(outputs))
    doc = fitz.open(outputs[0]['path'])
    expect(doc.needs_pass == 0, 'decrypted output still needs a password')
    expect(doc.page_count == 3, 'decrypted output page count %d' % doc.page_count)
    doc.close()
    report, _out = run_op('decrypt', {'password': 'wrong-password'},
                          inputs=[ENCRYPTED], tag='decrypt-wrong')
    failure = report['result']
    expect(failure.get('ok') is False, 'decrypt with a wrong password did not fail')
    expect((failure.get('error') or {}).get('code') == 'WRONG_PASSWORD',
           'expected WRONG_PASSWORD, got %r' % (failure.get('error'),))
    return 'verified decrypt + WRONG_PASSWORD', total_bytes(outputs)


def t_rotate():
    report, _out = run_op('rotate', {'angle': '90', 'pageRange': '1'}, tag='rotate')
    result = ok_result(report, 'rotate')
    outputs = outputs_with_kind(result, 'pdf')
    doc = open_output_pdf(outputs[0]['path'], expected_pages=3)
    rotations = [doc[index].rotation for index in range(3)]
    text = doc[0].get_text()
    doc.close()
    expect(rotations[0] == 90, 'page 1 rotation is %r, expected 90' % rotations[0])
    expect(rotations[1] == 0, 'page 2 should be untouched, rotation=%r' % rotations[1])
    expect(text.strip(), 'rotate lost the text layer')
    return 'rotations=%r' % (rotations,), total_bytes(outputs)


def t_delete_pages():
    report, _out = run_op('deletePages', {'pageRange': '1'}, tag='deletePages')
    result = ok_result(report, 'deletePages')
    outputs = outputs_with_kind(result, 'pdf')
    doc = open_output_pdf(outputs[0]['path'], expected_pages=2)
    text = doc[0].get_text()
    doc.close()
    expect('第二章' in text, 'deletePages removed the wrong page (first page is now %r)' % text[:80])
    # deleting every page must be rejected, not silently produce an empty file
    report, _out = run_op('deletePages', {'pageRange': ''}, tag='deletePages-all')
    failure = report['result']
    expect(failure.get('ok') is False, 'deleting every page did not fail')
    expect((failure.get('error') or {}).get('code') == 'BAD_RANGE',
           'expected BAD_RANGE, got %r' % (failure.get('error'),))
    return 'pages=2 + BAD_RANGE guarded', total_bytes(outputs)


def t_extract_pages():
    report, _out = run_op('extractPages', {'pageRange': '2-3'}, tag='extractPages')
    result = ok_result(report, 'extractPages')
    outputs = outputs_with_kind(result, 'pdf')
    doc = open_output_pdf(outputs[0]['path'], expected_pages=2)
    first = doc[0].get_text()
    doc.close()
    expect('第二章' in first, 'extractPages kept the wrong pages: %r' % first[:80])
    return 'pages=2 first=%r' % first.strip()[:18], total_bytes(outputs)


def t_insert_blank():
    report, _out = run_op('insertBlank', {'afterPage': 1, 'count': 1, 'pageSize': 'same'},
                          tag='insertBlank')
    result = ok_result(report, 'insertBlank')
    outputs = outputs_with_kind(result, 'pdf')
    doc = open_output_pdf(outputs[0]['path'], expected_pages=4)
    blank_text = doc[1].get_text().strip()
    first_is_blank = not blank_text
    size = (doc[1].rect.width, doc[1].rect.height)
    doc.close()
    expect(first_is_blank, 'inserted page is not blank: %r' % blank_text[:60])
    expect(abs(size[0] - 595) < 1.0 and abs(size[1] - 842) < 1.0,
           'inserted page size %r does not match the source page' % (size,))
    return 'pages=4 blank_page_size=%.0fx%.0f' % size, total_bytes(outputs)


def t_resize():
    details = []
    size_total = 0
    for fit_mode in ('scale', 'crop', 'stretch'):
        report, _out = run_op('resize', {
            'sizePreset': 'A4', 'fitMode': fit_mode, 'orientation': 'auto',
            'margin': 0, 'background': '#ffffff', 'keepMetadata': True, 'pageRange': ''},
            tag='resize-%s' % fit_mode)
        result = ok_result(report, 'resize %s' % fit_mode)
        outputs = outputs_with_kind(result, 'pdf')
        expect(len(outputs) == 1, 'resize %s produced %d PDFs' % (fit_mode, len(outputs)))
        path = outputs[0]['path']
        doc = open_output_pdf(path, expected_pages=3)
        for index in range(3):
            width, height = doc[index].rect.width, doc[index].rect.height
            expect(abs(width - 595.276) < 1.0 and abs(height - 841.89) < 1.0,
                   'resize %s page %d is %.2fx%.2f, expected A4 595.28x841.89'
                   % (fit_mode, index + 1, width, height))
        text = doc[0].get_text()
        expect(len(text.strip()) > 0, 'resize %s rasterised the page (text layer empty)' % fit_mode)
        toc = doc.get_toc()
        expect(len(toc) >= 1, 'resize %s lost the bookmarks' % fit_mode)
        links = doc[0].get_links()
        expect(len(links) >= 1, 'resize %s lost the hyperlinks' % fit_mode)
        doc.close()
        details.append('%s(A4 ok, text, toc=%d, links=%d)' % (fit_mode, len(toc), len(links)))
        size_total += total_bytes(outputs)
    # forced orientation swaps the paper dimensions
    report, _out = run_op('resize', {
        'sizePreset': 'A4', 'fitMode': 'scale', 'orientation': 'landscape',
        'margin': 0, 'keepMetadata': False, 'pageRange': '1'}, tag='resize-landscape')
    result = ok_result(report, 'resize landscape')
    outputs = outputs_with_kind(result, 'pdf')
    doc = open_output_pdf(outputs[0]['path'], expected_pages=3)
    width, height = doc[0].rect.width, doc[0].rect.height
    doc.close()
    expect(abs(width - 841.89) < 1.0 and abs(height - 595.276) < 1.0,
           'landscape page is %.2fx%.2f, expected 841.89x595.28' % (width, height))
    details.append('landscape(ok)')
    size_total += total_bytes(outputs)
    return ' | '.join(details), size_total


def t_batch_resize():
    report, _out = run_op('batchResize', {
        'sizePreset': 'A4', 'fitMode': 'scale', 'orientation': 'auto',
        'margin': 0, 'background': '#ffffff', 'keepMetadata': True,
        'zipOutput': True, 'pageRange': ''},
        inputs=[SAMPLE, BROKEN], tag='batchResize', timeout=1200)
    result = ok_result(report, 'batchResize')
    items = result['items']
    expect(len(items) == 2, 'batchResize returned %d items (expected one per input)' % len(items))
    ok_items = [item for item in items if item.get('ok')]
    failed_items = [item for item in items if not item.get('ok')]
    expect(len(ok_items) == 1, 'batchResize successful items=%d, expected 1' % len(ok_items))
    expect(len(failed_items) == 1, 'batchResize failed items=%d, expected 1' % len(failed_items))
    failure = failed_items[0]
    expect((failure.get('error') or {}).get('code') == 'BAD_PDF',
           'failed batch item should report BAD_PDF, got %r' % (failure.get('error'),))
    expect(failure.get('input') == os.path.basename(BROKEN),
           'failed batch item is attributed to %r' % failure.get('input'))
    archives = [output for output in outputs_of(result) if output.get('kind') == 'zip']
    expect(len(archives) == 1, 'batchResize did not bundle a zip archive')
    with zipfile.ZipFile(archives[0]['path']) as archive:
        names = archive.namelist()
    expect(len(names) == 1, 'batch zip should hold the 1 successful file, has %d' % len(names))
    resized = [output for output in outputs_of(result) if output.get('kind') == 'pdf']
    doc = open_output_pdf(resized[0]['path'], expected_pages=3)
    dims = (doc[0].rect.width, doc[0].rect.height)
    doc.close()
    return ('batch ok, failed=BAD_PDF, zip=%d, A4=%.0fx%.0f'
            % (len(names), dims[0], dims[1])), total_bytes(outputs_of(result))


def t_crop():
    report, _out = run_op('crop', {
        'cropMode': 'auto', 'uniform': True, 'safetyMargin': 2,
        'threshold': 245, 'pageRange': ''}, tag='crop-auto')
    result = ok_result(report, 'crop auto')
    outputs = outputs_with_kind(result, 'pdf')
    doc = open_output_pdf(outputs[0]['path'], expected_pages=3)
    width, height = doc[0].rect.width, doc[0].rect.height
    text = doc[0].get_text()
    doc.close()
    expect(width < 594.0 or height < 841.0,
           'crop did not shrink the page: %.1fx%.1f' % (width, height))
    expect(text.strip(), 'crop lost the page content (text layer empty)')
    report, _out = run_op('crop', {
        'cropMode': 'manual', 'uniform': False,
        'marginTop': 20, 'marginBottom': 20, 'marginLeft': 20, 'marginRight': 20,
        'pageRange': '1'}, tag='crop-manual')
    result = ok_result(report, 'crop manual')
    outputs2 = outputs_with_kind(result, 'pdf')
    doc = open_output_pdf(outputs2[0]['path'], expected_pages=3)
    manual_w, manual_h = doc[0].rect.width, doc[0].rect.height
    manual_text = doc[0].get_text()
    doc.close()
    expect(abs(manual_w - (595.276 - 2 * 20 * 72 / 25.4)) < 1.5,
           'manual crop width %.2f is off' % manual_w)
    expect(manual_text.strip(), 'manual crop lost the content')
    return ('auto=%.0fx%.0f manual=%.0fx%.0f (text kept)'
            % (width, height, manual_w, manual_h)), total_bytes(outputs + outputs2)


def t_page_number():
    report, _out = run_op('pageNumber', {
        'position': 'footer-center', 'format': 'n-total', 'fontFamily': 'china-s',
        'fontSize': 10, 'startNumber': 1, 'margin': 12, 'pageRange': ''},
        tag='pageNumber')
    result = ok_result(report, 'pageNumber')
    outputs = outputs_with_kind(result, 'pdf')
    doc = open_output_pdf(outputs[0]['path'], expected_pages=3)
    texts = [doc[index].get_text() for index in range(3)]
    doc.close()
    expect('1 / 3' in texts[0], 'page 1 number missing, text tail: %r' % texts[0][-80:])
    expect('3 / 3' in texts[2], 'page 3 number missing, text tail: %r' % texts[2][-80:])
    expect('PDF 全能工具台' in texts[0], 'pageNumber damaged the original content')
    return 'footer n-total rendered on all pages', total_bytes(outputs)


def t_resize_range_subset():
    report, _out = run_op('resize', {
        'sizePreset': 'A4', 'fitMode': 'scale', 'orientation': 'auto',
        'margin': 0, 'keepMetadata': True, 'pageRange': '2'}, tag='resize-range')
    result = ok_result(report, 'resize pageRange')
    outputs = outputs_with_kind(result, 'pdf')
    doc = open_output_pdf(outputs[0]['path'], expected_pages=3)
    sizes = [(doc[index].rect.width, doc[index].rect.height) for index in range(3)]
    images = [len(doc[index].get_images(full=True)) for index in range(3)]
    text = doc[1].get_text().strip()
    doc.close()
    expect(abs(sizes[0][0] - 595.0) < 1.0 and abs(sizes[0][1] - 842.0) < 1.0,
           'page 1 outside the range was resized: %r' % (sizes[0],))
    expect(abs(sizes[2][0] - 595.0) < 1.0 and abs(sizes[2][1] - 842.0) < 1.0,
           'page 3 outside the range was resized: %r' % (sizes[2],))
    expect(abs(sizes[1][0] - 595.276) < 1.0 and abs(sizes[1][1] - 841.89) < 1.0,
           'page 2 inside the range is %r, expected A4' % (sizes[1],))
    expect(text, 'resized page lost its text layer')
    expect(images[1] == 0, 'resize rasterised the page (embedded image count %d)' % images[1])
    return 'page2=A4, pages 1/3 untouched, vector kept', total_bytes(outputs)


def t_resize_rotated():
    report, _out = run_op('resize', {
        'sizePreset': 'A4', 'fitMode': 'scale', 'orientation': 'auto',
        'margin': 0, 'background': '#ffffff', 'keepMetadata': True, 'pageRange': ''},
        inputs=[ROTATED], tag='resize-rotated')
    result = ok_result(report, 'resize rotated source')
    outputs = outputs_with_kind(result, 'pdf')
    doc = open_output_pdf(outputs[0]['path'], expected_pages=1)
    page = doc[0]
    width, height = page.rect.width, page.rect.height
    expect(abs(width - 841.89) < 1.0 and abs(height - 595.276) < 1.0,
           'rotated page resized to %.2fx%.2f, expected A4 landscape 841.89x595.28'
           % (width, height))
    text = page.get_text()
    expect(text.strip(), 'resize on a rotated page lost the text layer')
    got = render_bbox(page)
    doc.close()
    source = fitz.open(ROTATED)
    original = render_bbox(source[0])
    source.close()
    scale = min(width / 500.0, height / 300.0)
    offset_x = (width - 500.0 * scale) / 2.0
    offset_y = (height - 300.0 * scale) / 2.0
    for index in range(4):
        expected = original[index] * scale + (offset_x if index % 2 == 0 else offset_y)
        expect(abs(got[index] - expected) <= 3.0,
               'rotated content is misplaced: got %r, expected %.1f from original %r'
               % (got[:4], expected, original[:4]))
    return ('rotated page -> %.0fx%.0f, content aligned within 3pt'
            % (width, height)), total_bytes(outputs)


def t_crop_rotated():
    margin = 20 * 72.0 / 25.4
    report, _out = run_op('crop', {
        'cropMode': 'manual', 'uniform': False,
        'marginTop': 20, 'marginBottom': 20, 'marginLeft': 20, 'marginRight': 20,
        'pageRange': ''}, inputs=[ROTATED], tag='crop-rotated')
    result = ok_result(report, 'crop rotated source')
    outputs = outputs_with_kind(result, 'pdf')
    doc = open_output_pdf(outputs[0]['path'], expected_pages=1)
    width, height = doc[0].rect.width, doc[0].rect.height
    text = doc[0].get_text()
    doc.close()
    expect(abs(width - (500.0 - 2 * margin)) < 2.0,
           'rotated manual crop width %.2f, expected %.2f' % (width, 500.0 - 2 * margin))
    expect(abs(height - (300.0 - 2 * margin)) < 2.0,
           'rotated manual crop height %.2f, expected %.2f' % (height, 300.0 - 2 * margin))
    expect(text.strip(), 'crop on a rotated page lost the content')
    return 'rotated crop -> %.0fx%.0f, content kept' % (width, height), total_bytes(outputs)


def t_text_scanned():
    report = run_engine('text', {
        'op': 'readText', 'params': {'pageRange': ''},
        'inputs': input_entries([SCANNED]), 'outDir': WORK})
    result = report['result']
    expect(result.get('ok') is True, 'text mode on a scanned PDF failed: %s' % result)
    expect(result.get('chars') == 0,
           'scanned PDF should yield 0 characters, got %r' % result.get('chars'))
    expect(result.get('emptyPages') == [1],
           'emptyPages should be [1], got %r' % (result.get('emptyPages'),))
    expect(len(result.get('pages') or []) == 1, 'expected one page entry')
    return 'chars=0 emptyPages=[1] (Host can suggest OCR)', 0


def t_naming_safety():
    out_dir = os.path.join(WORK, 'out', 'naming')
    os.makedirs(out_dir, exist_ok=True)
    entry = {'path': SAMPLE, 'name': '合同 文档.pdf', 'size': os.path.getsize(SAMPLE)}
    body = {'op': 'pdf2text', 'params': {'includePageBreaks': True, 'pageRange': ''},
            'inputs': [entry], 'outDir': out_dir}
    first = run_engine('run', body)['result']
    expect(first.get('ok') is True, 'naming run 1 failed: %s' % first.get('error'))
    second = run_engine('run', body)['result']
    expect(second.get('ok') is True, 'naming run 2 failed: %s' % second.get('error'))
    first_name = first['items'][0]['outputs'][0]['name']
    second_name = second['items'][0]['outputs'][0]['name']
    expect(first_name != second_name,
           'same output name reused (%r) — de-duplication is broken' % first_name)
    expect('-1' in second_name, 'second output should carry a -1 suffix, got %r' % second_name)
    real_out = os.path.realpath(out_dir)
    for result in (first, second):
        path = os.path.realpath(result['items'][0]['outputs'][0]['path'])
        expect(path.startswith(real_out + os.sep), 'output escaped outDir: %s' % path)
    # path traversal / control characters in the uploaded name must be neutralised
    hostile = {'path': SAMPLE, 'name': '../../evil\x01name.pdf', 'size': os.path.getsize(SAMPLE)}
    body = {'op': 'pdf2text', 'params': {'includePageBreaks': True, 'pageRange': ''},
            'inputs': [hostile], 'outDir': out_dir}
    hostile_result = run_engine('run', body)['result']
    expect(hostile_result.get('ok') is True,
           'hostile file name broke the engine: %s' % hostile_result.get('error'))
    output = hostile_result['items'][0]['outputs'][0]
    path = os.path.realpath(output['path'])
    expect(path.startswith(real_out + os.sep), 'path traversal escaped outDir: %s' % path)
    expect('/' not in output['name'] and '\\' not in output['name'],
           'output name still contains a path separator: %r' % output['name'])
    expect(all(ord(ch) >= 32 for ch in output['name']),
           'output name still contains control characters: %r' % output['name'])
    return 'collision -> -1, traversal neutralised (%r)' % output['name'], 0


# --------------------------------------------------------------------------- #
# tests: extraction & enhancement
# --------------------------------------------------------------------------- #

def t_extract_images():
    report, _out = run_op('extractImages', {'minPixels': 0, 'format': 'original', 'pageRange': ''},
                          tag='extractImages')
    result = ok_result(report, 'extractImages')
    images = outputs_with_kind(result, 'image')
    archives = outputs_with_kind(result, 'zip')
    expect(len(images) >= 1, 'extractImages found %d images' % len(images))
    expect(len(archives) == 1, 'extractImages did not produce a zip')
    for output in images:
        image = Image.open(output['path'])
        image.load()
        expect(image.size[0] >= 8, 'extracted image too small %r' % (image.size,))
    with zipfile.ZipFile(archives[0]['path']) as archive:
        expect(len(archive.namelist()) == len(images),
               'zip entries %d != images %d' % (len(archive.namelist()), len(images)))
    # minPixels filter must be able to exclude everything
    report, _out = run_op('extractImages', {'minPixels': 1999, 'format': 'png', 'pageRange': ''},
                          tag='extractImages-filter')
    failure = report['result']
    expect(failure.get('ok') is False, 'minPixels filter should have excluded every image')
    expect((failure.get('error') or {}).get('code') == 'NO_IMAGES',
           'expected NO_IMAGES, got %r' % (failure.get('error'),))
    return 'images=%d zip ok + NO_IMAGES filter' % len(images), total_bytes(images + archives)


def t_extract_toc():
    report, _out = run_op('extractToc', {'format': 'md', 'fallbackHeadings': True}, tag='extractToc-md')
    result = ok_result(report, 'extractToc md')
    outputs = [output for output in outputs_of(result) if output.get('kind') == 'md']
    expect(len(outputs) == 1, 'extractToc produced %d md files' % len(outputs))
    body = open(outputs[0]['path'], encoding='utf-8').read()
    expect('第一章' in body and '第二章' in body, 'outline lost entries: %r' % body[:200])
    expect('## ' in body, 'markdown heading depth missing')
    report, _out = run_op('extractToc', {'format': 'json', 'fallbackHeadings': True},
                          tag='extractToc-json')
    result = ok_result(report, 'extractToc json')
    outputs2 = [output for output in outputs_of(result) if output.get('kind') == 'json']
    expect(len(outputs2) == 1, 'extractToc json produced no file')
    entries = json.load(open(outputs2[0]['path'], encoding='utf-8'))
    expect(isinstance(entries, list) and len(entries) >= 3,
           'json outline has %r entries' % (len(entries) if isinstance(entries, list) else entries,))
    expect(all('level' in entry and 'title' in entry and 'page' in entry for entry in entries),
           'json outline entries are missing keys')
    return 'md+json outlines (%d entries)' % len(entries), total_bytes(outputs + outputs2)


def t_watermark_text():
    report, _out = run_op('watermark', {
        'kind': 'text', 'text': '内部资料', 'fontSize': 48, 'color': '#808080',
        'position': 'center', 'opacity': 0.25, 'rotation': 45, 'pageRange': ''},
        tag='watermark-text')
    result = ok_result(report, 'watermark text')
    outputs = outputs_with_kind(result, 'pdf')
    expect(len(outputs) == 1, 'watermark text produced %d PDFs' % len(outputs))
    doc = open_output_pdf(outputs[0]['path'], expected_pages=3)
    texts = [doc[index].get_text() for index in range(3)]
    doc.close()
    expect(all('内部资料' in text for text in texts), 'watermark missing on some pages')
    expect('PDF 全能工具台' in texts[0], 'watermark damaged the original text')
    # catalog.js declares the default watermark text as {zh, en}; the engine
    # must accept that shape instead of rendering a dict repr
    report, _out = run_op('watermark', {
        'kind': 'text', 'text': {'zh': '内部资料', 'en': 'CONFIDENTIAL'},
        'fontSize': 40, 'color': '#808080', 'position': 'center', 'opacity': 0.3,
        'rotation': 0, 'pageRange': '1'}, tag='watermark-localized')
    result = ok_result(report, 'watermark localized default')
    localized_outputs = outputs_with_kind(result, 'pdf')
    doc = open_output_pdf(localized_outputs[0]['path'], expected_pages=3)
    localized_text = doc[0].get_text()
    doc.close()
    expect('内部资料' in localized_text,
           'localized {zh,en} watermark default was not coerced: %r' % localized_text[:120])
    expect('{zh' not in localized_text and "{'zh'" not in localized_text,
           'watermark rendered a dict repr')

    report, _out = run_op('watermark', {
        'kind': 'text', 'text': '内部资料', 'fontSize': 30, 'position': 'tiled',
        'density': 4, 'opacity': 0.2, 'rotation': 30, 'pageRange': '1'},
        tag='watermark-tiled')
    result = ok_result(report, 'watermark tiled')
    expect(len(outputs_with_kind(result, 'pdf')) == 1, 'tiled watermark failed')
    return 'center + tiled watermarks ok', total_bytes(outputs)


def t_watermark_image():
    report, _out = run_op('watermark', {
        'kind': 'image', 'scale': 30, 'position': 'tiled', 'opacity': 0.3,
        'rotation': 0, 'density': 4, 'pageRange': '1'},
        inputs=[SAMPLE, FIX_PNG], tag='watermark-image')
    result = ok_result(report, 'watermark image')
    outputs = outputs_with_kind(result, 'pdf')
    expect(len(outputs) == 1, 'image watermark produced %d PDFs' % len(outputs))
    doc = open_output_pdf(outputs[0]['path'], expected_pages=3)
    images = len(doc[0].get_images(full=True))
    doc.close()
    expect(images >= 2, 'image watermark was not embedded (images=%d)' % images)
    return 'image watermark embedded (images=%d)' % images, total_bytes(outputs)


def t_ocr():
    report = run_engine('env', None)
    ocr_ready = bool(report['result'].get('ocr'))
    if not ocr_ready:
        report, _out = run_op('ocr', {'outputMode': 'pdf', 'lang': 'ch', 'pageRange': '1'},
                              inputs=[SCANNED], tag='ocr-unavailable')
        failure = report['result']
        expect(failure.get('ok') is False, 'OCR should fail when unavailable')
        expect((failure.get('error') or {}).get('code') == 'OCR_UNAVAILABLE',
               'expected OCR_UNAVAILABLE, got %r' % (failure.get('error'),))
        return 'OCR unavailable in this environment; OCR_UNAVAILABLE returned (never faked)', 0
    report, _out = run_op('ocr', {'outputMode': 'pdf', 'lang': 'ch', 'pageRange': ''},
                          inputs=[SCANNED], tag='ocr-pdf', timeout=1200)
    result = ok_result(report, 'ocr pdf')
    outputs = outputs_with_kind(result, 'pdf')
    expect(len(outputs) == 1, 'ocr produced %d PDFs' % len(outputs))
    doc = open_output_pdf(outputs[0]['path'], expected_pages=1)
    text = doc[0].get_text().strip()
    doc.close()
    expect(len(text) >= 4, 'OCR PDF has no recognisable text layer (%r)' % text[:80])
    report, _out = run_op('ocr', {'outputMode': 'txt', 'lang': 'ch', 'pageRange': ''},
                          inputs=[SCANNED], tag='ocr-txt', timeout=1200)
    result = ok_result(report, 'ocr txt')
    txt_outputs = outputs_with_kind(result, 'text')
    expect(len(txt_outputs) == 1, 'ocr txt produced %d files' % len(txt_outputs))
    body = open(txt_outputs[0]['path'], encoding='utf-8').read()
    expect(len(body.strip()) >= 4, 'OCR txt is empty')
    return 'ocr pdf chars=%d, txt chars=%d' % (len(text), len(body)), total_bytes(outputs + txt_outputs)


# --------------------------------------------------------------------------- #
# tests: build mode
# --------------------------------------------------------------------------- #

def run_build(params, tag):
    out_dir = os.path.join(WORK, 'out', 'build-' + tag)
    os.makedirs(out_dir, exist_ok=True)
    body = {'op': params.get('kind'), 'params': params, 'inputs': [], 'outDir': out_dir}
    report = run_engine('build', body)
    result = report['result']
    expect(result.get('ok') is True, 'build %s failed: %s' % (tag, result.get('error')))
    return result


def t_build_text_doc():
    segments = [{'page': 1, 'original': '第一段原文 original one',
                 'translated': 'First translated paragraph 第一段译文'},
                {'page': 2, 'original': '第二段原文 original two',
                 'translated': 'Second translated paragraph 第二段译文'}]
    size = 0
    result = run_build({'kind': 'textDoc', 'format': 'pdf', 'title': '翻译对照文档',
                        'segments': segments, 'bilingual': True}, 'textdoc-pdf')
    outputs = [output for output in result.get('outputs') or [] if output.get('kind') == 'pdf']
    expect(len(outputs) == 1, 'build textDoc pdf produced no PDF')
    doc = open_output_pdf(outputs[0]['path'])
    text = ''.join(doc[index].get_text() for index in range(doc.page_count))
    doc.close()
    expect('第一段原文' in text and '第一段译文' in text, 'bilingual PDF lost content: %r' % text[:120])
    expect('第 1 页' in text, 'bilingual PDF lost page markers')
    size += total_bytes(outputs)
    result = run_build({'kind': 'textDoc', 'format': 'docx', 'title': '翻译对照文档',
                        'segments': segments, 'bilingual': True}, 'textdoc-docx')
    outputs = [output for output in result.get('outputs') or [] if output.get('kind') == 'docx']
    expect(len(outputs) == 1, 'build textDoc docx produced no DOCX')
    import docx
    document = docx.Document(outputs[0]['path'])
    joined = '\n'.join(paragraph.text for paragraph in document.paragraphs)
    expect('第二段译文' in joined, 'bilingual DOCX lost the translation')
    size += total_bytes(outputs)
    result = run_build({'kind': 'textDoc', 'format': 'txt', 'title': '翻译对照文档',
                        'segments': segments, 'bilingual': False}, 'textdoc-txt')
    outputs = [output for output in result.get('outputs') or [] if output.get('kind') == 'text']
    expect(len(outputs) == 1, 'build textDoc txt produced no TXT')
    body = open(outputs[0]['path'], encoding='utf-8').read()
    expect('First translated paragraph' in body, 'target-only TXT lost the translation')
    size += total_bytes(outputs)
    return 'textDoc pdf+docx+txt ok', size


def t_build_table_doc():
    params = {'kind': 'tableDoc', 'title': '信息提取结果',
              'headers': ['甲方', '乙方', '金额'],
              'rows': [['北京示例科技有限公司', '上海示例贸易有限公司', '10000'],
                       ['广州样例信息技术有限公司', '深圳样例物流有限公司', '25000']]}
    size = 0
    result = run_build(dict(params, format='xlsx'), 'tabledoc-xlsx')
    outputs = [output for output in result.get('outputs') or [] if output.get('kind') == 'xlsx']
    expect(len(outputs) == 1, 'build tableDoc xlsx produced no XLSX')
    import openpyxl
    workbook = openpyxl.load_workbook(outputs[0]['path'])
    rows = list(workbook.worksheets[0].iter_rows(values_only=True))
    expect(len(rows) == 3, 'xlsx should have 3 rows, got %d' % len(rows))
    expect(rows[0][0] == '甲方', 'xlsx header lost: %r' % (rows[0],))
    size += total_bytes(outputs)
    result = run_build(dict(params, format='docx'), 'tabledoc-docx')
    outputs = [output for output in result.get('outputs') or [] if output.get('kind') == 'docx']
    expect(len(outputs) == 1, 'build tableDoc docx produced no DOCX')
    import docx
    document = docx.Document(outputs[0]['path'])
    expect(len(document.tables) == 1, 'docx table missing')
    size += total_bytes(outputs)
    result = run_build(dict(params, format='md'), 'tabledoc-md')
    outputs = [output for output in result.get('outputs') or [] if output.get('kind') == 'md']
    expect(len(outputs) == 1, 'build tableDoc md produced no MD')
    body = open(outputs[0]['path'], encoding='utf-8').read()
    expect('| 甲方 |' in body, 'markdown table lost the header: %r' % body[:120])
    size += total_bytes(outputs)
    return 'tableDoc xlsx+docx+md ok', size


# --------------------------------------------------------------------------- #
# tests: robustness
# --------------------------------------------------------------------------- #

def t_bad_pdf():
    report, _out = run_op('pdf2text', {'includePageBreaks': True, 'pageRange': ''},
                          inputs=[BROKEN], tag='bad-pdf')
    failure = report['result']
    expect(failure.get('ok') is False, 'a corrupt PDF must not succeed')
    expect((failure.get('error') or {}).get('code') == 'BAD_PDF',
           'expected BAD_PDF, got %r' % (failure.get('error'),))
    # the engine must still print exactly one JSON line for bad input (checked in run_engine)
    return 'BAD_PDF returned for corrupt input', 0


def t_bad_range():
    report, _out = run_op('extractPages', {'pageRange': 'abc'}, tag='bad-range')
    failure = report['result']
    expect(failure.get('ok') is False, 'a malformed page range must not succeed')
    expect((failure.get('error') or {}).get('code') == 'BAD_RANGE',
           'expected BAD_RANGE, got %r' % (failure.get('error'),))
    return 'BAD_RANGE returned for malformed ranges', 0


def t_unknown_op():
    report, _out = run_op('notAnOperation', {}, tag='unknown-op')
    failure = report['result']
    expect(failure.get('ok') is False, 'an unknown op must not succeed')
    expect((failure.get('error') or {}).get('code') == 'UNKNOWN_OP',
           'expected UNKNOWN_OP, got %r' % (failure.get('error'),))
    return 'UNKNOWN_OP returned', 0


def t_input_untouched():
    expect(os.path.isfile(SAMPLE), 'sample fixture vanished')
    digest = hash(open(SAMPLE, 'rb').read())
    doc = fitz.open(SAMPLE)
    pages = doc.page_count
    doc.close()
    expect(pages == 3, 'sample fixture changed on disk (pages=%d)' % pages)
    return 'fixture intact (hash %d)' % (digest % 100000), 0


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass
    print('PDF engine selftest')
    print('  engine : %s' % ENGINE)
    print('  python : %s' % PYTHON)
    print('  work   : %s' % WORK)
    print('  pymupdf: %s' % (str(getattr(fitz, 'version', '?')),))
    print('-' * 96)
    started = time.time()
    try:
        build_fixtures()
    except Exception as exc:
        print('failed to build fixtures: %s' % exc)
        traceback.print_exc()
        return 1
    print('fixtures: sample(3p table image bookmarks links annots), second(2p), '
          'scanned(1p image-only), office.docx, image.png, text.txt, broken.pdf')
    print('-' * 96)

    test('mode/env', t_env)
    test('mode/probe', t_probe)
    test('mode/preview', t_preview)
    test('mode/text (readText)', t_text_mode)
    test('op/pdf2word (flow)', t_pdf2word_flow)
    test('op/pdf2word (positioned)', t_pdf2word_positioned)
    test('op/pdf2excel', t_pdf2excel)
    test('op/pdf2ppt', t_pdf2ppt)
    test('op/pdf2image', t_pdf2image)
    test('op/pdf2text', t_pdf2text)
    test('op/toPDF', t_toPDF)
    test('op/merge', t_merge)
    test('op/split (ranges)', t_split_ranges)
    test('op/split (every)', t_split_every)
    test('op/split (size)', t_split_size)
    test('op/compress (low/medium/high)', t_compress)
    test('op/compress (image resampling)', t_compress_images)
    test('op/encrypt', t_encrypt)
    test('op/decrypt', t_decrypt)
    test('op/rotate', t_rotate)
    test('op/deletePages', t_delete_pages)
    test('op/extractPages', t_extract_pages)
    test('op/insertBlank', t_insert_blank)
    test('op/resize (scale/crop/stretch)', t_resize)
    test('op/resize (pageRange subset)', t_resize_range_subset)
    test('op/resize (rotated source)', t_resize_rotated)
    test('op/batchResize (one bad input)', t_batch_resize)
    test('op/crop (auto/manual)', t_crop)
    test('op/crop (rotated source)', t_crop_rotated)
    test('mode/text (scanned page)', t_text_scanned)
    test('robustness/file naming', t_naming_safety)
    test('op/pageNumber', t_page_number)
    test('op/extractImages', t_extract_images)
    test('op/extractToc', t_extract_toc)
    test('op/watermark (text)', t_watermark_text)
    test('op/watermark (image)', t_watermark_image)
    test('op/ocr', t_ocr)
    test('mode/build (textDoc)', t_build_text_doc)
    test('mode/build (tableDoc)', t_build_table_doc)
    test('robustness/bad pdf', t_bad_pdf)
    test('robustness/bad range', t_bad_range)
    test('robustness/unknown op', t_unknown_op)
    test('robustness/input untouched', t_input_untouched)

    elapsed = time.time() - started
    passed = [item for item in RESULTS if item['ok']]
    failed = [item for item in RESULTS if not item['ok']]
    print('-' * 96)
    print('total: %d   passed: %d   failed: %d   duration: %.1fs'
          % (len(RESULTS), len(passed), len(failed), elapsed))
    if failed:
        print('failures:')
        for item in failed:
            print('  \u2717 %s — %s' % (item['name'], item['detail']))
        print('work dir kept for inspection: %s' % WORK)
        return 1
    print('ALL GREEN \u2713')
    if os.environ.get('PDFW_SELFTEST_KEEP'):
        print('work dir kept: %s' % WORK)
    else:
        shutil.rmtree(WORK, ignore_errors=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
