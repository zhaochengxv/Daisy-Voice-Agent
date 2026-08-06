import path from "node:path";
import fs from "node:fs";
import { findPython, runPythonCode, hasPythonLibrary, pythonLibMissingHint, pythonMissingHint } from "./pythonRuntime";
import { log } from "./logger";

/**
 * Python 文件处理技能层（跨平台，macos.ts 与 windows.ts 共用）。
 *
 * 用 PyMuPDF / pdfplumber / openpyxl / pdf2docx 承载 PDF 编辑、PDF→Excel、
 * Excel 读取等复杂文档工作流——这些都是 macOS/Windows 各自免费方案里
 * 质量最接近专业软件的 Python 库（GitHub 生态调研结论）。缺解释器或库时
 * 返回可执行的安装引导，让 LLM 一步到位，不再反复探测环境。
 */

export interface PyResult {
  ok: boolean;
  output?: string;
  /** 缺解释器 / 缺库 / 业务失败等分类，便于上层决定文案 */
  missingPython?: boolean;
  missingLibs?: string[];
  /** 落盘校验时输出文件大小 */
  written?: string;
}

/** 统一执行入口：找到解释器 + 检查依赖 + 跑脚本 + 组装结果 */
async function withPython(
  libs: string[],
  run: (exe: string) => Promise<{ stdout: string; stderr: string }>,
  scriptName: string
): Promise<PyResult> {
  const env = await findPython();
  if (!env) {
    log(`withPython(${scriptName}): no python interpreter`);
    return { ok: false, missingPython: true };
  }
  const missing: string[] = [];
  for (const lib of libs) {
    if (!(await hasPythonLibrary(env.exe, lib))) missing.push(lib);
  }
  if (missing.length) {
    log(`withPython(${scriptName}): missing libs ${missing.join(",")}`);
    return { ok: false, missingLibs: missing };
  }
  try {
    const { stdout, stderr } = await run(env.exe);
    const merged = stdout.trim() + (stderr.trim() ? `\nstderr: ${stderr.trim()}` : "");
    return { ok: true, output: merged };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`withPython(${scriptName}) failed: ${msg}`);
    return { ok: false, output: `Python 执行失败: ${msg}` };
  }
}

/** 解析 PyResult 为面向 LLM 的中文文案 */
export function pyResultMessage(r: PyResult, okPrefix: string): string {
  if (r.missingPython) return pythonMissingHint(r.missingLibs);
  if (r.missingLibs) return pythonLibMissingHint("", r.missingLibs);
  if (r.ok && r.output) {
    // 脚本内部业务失败（NO_TABLES 等）由脚本输出体现
    return `${okPrefix}（${r.output}）`;
  }
  if (r.output) return r.output;
  return okPrefix;
}

/** 校验输出文件确实落盘（存在且非空） */
function checkWritten(dst: string): string | null {
  try {
    const st = fs.statSync(dst);
    if (st.isFile() && st.size > 0) return null;
  } catch {
    // 不存在 → 走下方文案
  }
  return `输出文件「${path.basename(dst)}」未成功写入磁盘`;
}

/**
 * PDF 编辑（PyMuPDF）：find / fill / delete / replace。
 * 与 macOS 原生实现等价，Windows 从此不再降级。
 */
export async function editPdfViaPython(
  source: string, target: string, operation: string,
  opts: { query?: string; anchor?: string; text?: string; color?: string; fontsize?: number; mode?: string; replaceWith?: string } = {}
): Promise<PyResult> {
  const script = `import sys, json
import fitz
src, dst, op = sys.argv[1], sys.argv[2], sys.argv[3]
o = json.loads(sys.argv[4])
doc = fitz.open(src)
count = 0
if op == "find":
    query = o.get("query") or ""
    hits = []
    for pno in range(len(doc)):
        page = doc[pno]
        try:
            rects = page.search_for(query)
        except Exception:
            rects = []
        for r in rects:
            hits.append("页%d (%.0f,%.0f,%.0f,%.0f)" % (pno + 1, r.x0, r.y0, r.x1, r.y1))
    print(("找到 %d 处" % len(hits)) if hits else "未找到")
    for x in hits[:30]:
        print(x)
elif op == "fill":
    anchor = o.get("anchor") or ""
    text = o.get("text") or ""
    color_hex = (o.get("color") or "FF0000").upper()
    cr = int(color_hex[0:2], 16) / 255
    cg = int(color_hex[2:4], 16) / 255
    cb = int(color_hex[4:6], 16) / 255
    fontsize = o.get("fontsize") or 11
    fn = "helv" if all(ord(c) < 128 for c in text) else "china-s"
    for pno in range(len(doc)):
        page = doc[pno]
        rects = page.search_for(anchor)
        for rect in rects:
            point = fitz.Point(rect.x1 + 1, rect.y1 - 2)
            maxw = page.rect.width - point.x - 10
            if maxw < 20:
                maxw = 200
            fs = fontsize
            while fs > 6 and fitz.get_text_length(text, fontname=fn, fontsize=fs) > maxw:
                fs -= 0.5
            page.insert_text(point, text, fontname=fn, fontsize=fs, color=(cr, cg, cb))
            count += 1
    doc.save(dst)
    print("已填入 %d 处" % count)
elif op == "delete":
    mode = o.get("mode") or "text"
    if mode == "color":
        color_hex = (o.get("color") or "FF0000").upper()
        target_int = int(color_hex, 16)
        for pno in range(len(doc)):
            page = doc[pno]
            d = page.get_text("dict")
            rects = []
            for block in d.get("blocks", []):
                for line in block.get("lines", []):
                    for span in line.get("spans", []):
                        if span.get("color") == target_int:
                            rects.append(fitz.Rect(span["bbox"]))
            for r in rects:
                page.add_redact_annot(r, fill=(1, 1, 1))
            if rects:
                page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
                count += len(rects)
    else:
        target = o.get("text") or o.get("query") or ""
        for pno in range(len(doc)):
            page = doc[pno]
            rects = page.search_for(target)
            for r in rects:
                page.add_redact_annot(r, fill=(1, 1, 1))
            if rects:
                page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
                count += len(rects)
    doc.save(dst)
    print("已删除 %d 处" % count)
elif op == "replace":
    find_text = o.get("query") or o.get("anchor") or ""
    new_text = o.get("replaceWith") or o.get("text") or ""
    color_hex = (o.get("color") or "000000").upper()
    cr = int(color_hex[0:2], 16) / 255
    cg = int(color_hex[2:4], 16) / 255
    cb = int(color_hex[4:6], 16) / 255
    fn = "helv" if all(ord(c) < 128 for c in new_text) else "china-s"
    for pno in range(len(doc)):
        page = doc[pno]
        rects = page.search_for(find_text)
        for r in rects:
            page.add_redact_annot(r, fill=(1, 1, 1))
        if rects:
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
            for r in rects:
                point = fitz.Point(r.x0, r.y1 - 2)
                page.insert_text(point, new_text, fontname=fn, fontsize=11, color=(cr, cg, cb))
                count += 1
    doc.save(dst)
    print("已替换 %d 处" % count)
else:
    print("未知操作: " + op)
`;
  return withPython(["fitz"], async (exe) => {
    const { stdout, stderr } = await runPythonCode(exe, script, [source, target, operation, JSON.stringify(opts)], 60000);
    return { stdout, stderr };
  }, "editPdf");
}

/**
 * PDF → Excel：pdfplumber 逐页提取表格，openpyxl 写入 xlsx（每表一 sheet）。
 * 覆盖「财报/报表类 PDF 转 Excel」复杂工作流。
 */
export async function pdfToExcelViaPython(source: string, target: string): Promise<PyResult> {
  const script = `import sys
try:
    import pdfplumber
    import openpyxl
except ImportError as e:
    print("MISSING_LIBS:" + e.name)
    sys.exit(0)
src, dst = sys.argv[1], sys.argv[2]
wb = openpyxl.Workbook()
default = wb.active
sheet_count = 0
total_rows = 0
try:
    with pdfplumber.open(src) as pdf:
        for pi, page in enumerate(pdf.pages):
            try:
                tables = page.extract_tables()
            except Exception:
                tables = []
            for ti, table in enumerate(tables):
                ws = default if sheet_count == 0 else wb.create_sheet()
                ws.title = ("P%dT%d" % (pi + 1, ti + 1))[:31]
                for row in table:
                    ws.append(["" if c is None else str(c) for c in row])
                total_rows += len(table)
                sheet_count += 1
except Exception as e:
    print("PDF_READ_ERR:" + str(e))
    sys.exit(0)
if sheet_count == 0:
    print("NO_TABLES")
    sys.exit(0)
try:
    wb.save(dst)
except Exception as e:
    print("SAVE_ERR:" + str(e))
    sys.exit(0)
print("OK:sheets=%d rows=%d" % (sheet_count, total_rows))
`;
  return withPython(["pdfplumber", "openpyxl"], async (exe) => {
    const { stdout, stderr } = await runPythonCode(exe, script, [source, target], 90000);
    return { stdout, stderr };
  }, "pdfToExcel");
}

/** Excel 读取摘要（openpyxl）：所有 sheet 转 JSON 文本，供 LLM 分析 */
export async function readExcelViaPython(source: string, maxRows = 200): Promise<PyResult> {
  const script = `import sys, json
try:
    import openpyxl
except ImportError:
    print("MISSING_LIBS:openpyxl")
    sys.exit(0)
src = sys.argv[1]
max_rows = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 200
try:
    wb = openpyxl.load_workbook(src, read_only=True, data_only=True)
except Exception as e:
    print("READ_ERR:" + str(e))
    sys.exit(0)
out = []
for ws in wb.worksheets:
    rows = []
    i = 0
    try:
        for row in ws.iter_rows(values_only=True):
            if i >= max_rows:
                rows.append(["..."])
                break
            rows.append([("" if v is None else (str(int(v)) if isinstance(v, float) and v.is_integer() else str(v))) for v in row])
            i += 1
    except Exception:
        pass
    out.append({"sheet": ws.title, "row_count": ws.max_row, "rows": rows})
print(json.dumps(out, ensure_ascii=False))
`;
  return withPython(["openpyxl"], async (exe) => {
    const { stdout, stderr } = await runPythonCode(exe, script, [source, String(maxRows)], 60000);
    return { stdout, stderr };
  }, "readExcel");
}

/**
 * 通用 Python 脚本执行（run_python 工具）：让 LLM 用 Python 完成任意复杂逻辑，
 * 如 pandas 数据分析、文件批处理、数据转换等。
 */
export async function runPythonViaScript(code: string, args: string[] = []): Promise<PyResult> {
  const env = await findPython();
  if (!env) return { ok: false, missingPython: true };
  try {
    const { stdout, stderr } = await runPythonCode(env.exe, code, args, 90000);
    const merged = stdout.trim() + (stderr.trim() ? `\nstderr: ${stderr.trim()}` : "");
    return { ok: true, output: merged };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, output: `Python 执行失败: ${msg}` };
  }
}

/**
 * PDF → 文本（PyMuPDF）。扫描版（无文本层）提取结果为 0 字节时返回明确提示。
 */
export async function extractPdfTextViaPython(source: string, target: string): Promise<PyResult> {
  const script = `import sys, os
try:
    import fitz
except ImportError:
    print("MISSING_LIBS:fitz")
    sys.exit(0)
src, dst = sys.argv[1], sys.argv[2]
try:
    doc = fitz.open(src)
    text = "\\n".join(page.get_text() for page in doc)
    with open(dst, "w", encoding="utf-8") as f:
        f.write(text)
    size = os.path.getsize(dst)
    print("OK:%d" % size)
except Exception as e:
    print("ERR:" + str(e))
`;
  return withPython(["fitz"], async (exe) => {
    const { stdout, stderr } = await runPythonCode(exe, script, [source, target], 60000);
    return { stdout, stderr };
  }, "extractPdfText");
}

/**
 * PDF → DOCX（pdf2docx，保留版面/表格/图片）。比 Word COM 打开 PDF 可靠得多
 * （真机日志：Word 打开扫描 PDF 直接失败）。
 */
export async function pdfToDocxViaPython(source: string, target: string): Promise<PyResult> {
  const script = `import sys, logging
logging.disable(logging.INFO)
try:
    from pdf2docx import Converter
except ImportError:
    print("MISSING_LIBS:pdf2docx")
    sys.exit(0)
src, dst = sys.argv[1], sys.argv[2]
try:
    cv = Converter(src)
    cv.convert(dst)
    cv.close()
    import os
    print("OK:%d" % os.path.getsize(dst))
except Exception as e:
    print("ERR:" + str(e))
`;
  return withPython(["pdf2docx"], async (exe) => {
    const { stdout, stderr } = await runPythonCode(exe, script, [source, target], 120000);
    return { stdout, stderr };
  }, "pdfToDocx");
}

/** 辅助：确认输出文件已落盘 */
export { checkWritten };

/** 面向 LLM 的 edit_pdf 中文文案（find 返回坐标，其余返回保存信息） */
export async function editPdfText(
  source: string, target: string, operation: string,
  opts: { query?: string; anchor?: string; text?: string; color?: string; fontsize?: number; mode?: string; replaceWith?: string } = {}
): Promise<string> {
  const r = await editPdfViaPython(source, target, operation, opts);
  if (r.missingPython) return pythonMissingHint();
  if (r.missingLibs) return pythonLibMissingHint("", r.missingLibs);
  if (r.ok && r.output) {
    if (operation === "find") return r.output;
    return `已编辑 PDF，保存至「${path.basename(target)}」（${r.output}）`;
  }
  return r.output || "PDF 编辑失败";
}

/** 面向 LLM 的 pdf_to_excel 中文文案 */
export async function pdfToExcelText(source: string, target: string): Promise<string> {
  const r = await pdfToExcelViaPython(source, target);
  if (r.missingPython) return pythonMissingHint(["pdfplumber", "openpyxl"]);
  if (r.missingLibs) return pythonLibMissingHint("", r.missingLibs);
  if (r.ok && r.output) {
    const m = /OK:sheets=(\d+) rows=(\d+)/.exec(r.output);
    if (m) return `已从 PDF 提取 ${m[1]} 个表格（共 ${m[2]} 行），保存至「${path.basename(target)}」`;
    if (r.output.includes("NO_TABLES")) return `未在「${path.basename(source)}」中检测到可提取的表格。`;
    return r.output;
  }
  return r.output || `PDF 转 Excel 失败`;
}

/** 面向 LLM 的 read_excel 中文文案：表格数据原样透出 */
export async function readExcelText(source: string, maxRows = 200): Promise<string> {
  const r = await readExcelViaPython(source, maxRows);
  if (r.missingPython) return pythonMissingHint(["openpyxl"]);
  if (r.missingLibs) return pythonLibMissingHint("", r.missingLibs);
  if (r.ok && r.output) {
    if (r.output.startsWith("READ_ERR:")) return `读取 Excel 失败：${r.output.slice(9)}`;
    return r.output;
  }
  return r.output || `读取 Excel 失败`;
}

/** 面向 LLM 的 run_python 中文文案 */
export async function runPythonText(code: string, args: string[] = []): Promise<string> {
  const r = await runPythonViaScript(code, args);
  if (r.missingPython) return pythonMissingHint();
  if (r.ok && r.output) return r.output;
  return r.output || "Python 执行失败";
}
