import { crc32 } from 'node:zlib';
import type { TaskView } from '../jobs/engine.ts';
import type { Question } from '../modules/protocol.ts';
import type { ImageInput } from './ai.ts';
import { badRequest } from '../core/errors.ts';

export const xml = (s: unknown) => String(s ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
const csvCell = (s: unknown) => '"' + String(s ?? '').replace(/^[=+@\-\t\r]/, (c) => "'" + c).replace(/"/g, '""') + '"';
export function csv(rows: Record<string, unknown>[]): string {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return '\uFEFF' + [columns.map(csvCell).join(','), ...rows.map((r) => columns.map((k) => csvCell(typeof r[k] === 'object' ? JSON.stringify(r[k]) : r[k])).join(','))].join('\r\n');
}

const operationName: Record<string, string> = { study: '课程学习', trial: '短时试跑', review: '每日复习', answer: '作业与考试', mastery: '掌握度练习', meeting: '见面课', qa: '回答课程问题', ask: '发布课程提问' };
const statusName: Record<string, string> = { queued: '排队中', running: '执行中', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已停止' };
type Report = { task: TaskView; workflow?: any; events: Array<{ kind: string; detail: string; created_at: number }> };
function answerText(q: Question, answer: string[] = []): string {
  if (q.kind === 'judge') return answer[0] === 'true' ? '正确' : answer[0] === 'false' ? '错误' : '未填写';
  if (['single', 'multiple'].includes(q.kind)) return answer.map((id) => { const index = q.options.findIndex((o) => o.id === id); return index >= 0 ? `${String.fromCharCode(65 + index)}. ${q.options[index]!.text}` : id; }).join('；');
  return answer.join('；') || '未填写';
}
function records(report: Report): any[] {
  const w = report.workflow;
  const complete = w?.records ?? [];
  return w?.attempt && !complete.some((r: any) => r.attempt?.id === w.attempt.id) ? [...complete, { attempt: w.attempt, answers: w.answers, explanations: w.explanations, confirmed: false }] : complete;
}
export function markdown(report: Report, publicUrl: string): string {
  const parts = [`# ${report.task.course_name}`, '', `任务：${operationName[report.task.operation] ?? report.task.operation} · ${statusName[report.task.state] ?? report.task.state}`, '', report.task.detail, ''];
  for (const record of records(report)) {
    parts.push(`## ${record.attempt.name}`, '', `提交：${record.confirmed ? '平台已确认' : '尚未确认'}${record.score == null ? '' : ` · 得分 ${record.score}`}`, '');
    record.attempt.questions.forEach((q: Question, i: number) => {
      parts.push(`### ${i + 1}. ${q.text}`, '', ...q.options.map((o, index) => `${String.fromCharCode(65 + index)}. ${o.text}`), '', `答案：${answerText(q, record.answers?.[q.id])}`, '');
      if (q.correct_answer?.length) parts.push(`平台公开答案：${answerText(q, q.correct_answer)}`, '');
      const explanation = q.explanation || record.explanations?.[q.id];
      if (explanation) parts.push(`解析：${explanation}`, '');
      (q.images ?? []).forEach((url, n) => parts.push(`![题图 ${n + 1}](${new URL(url, publicUrl).href})`, ''));
    });
  }
  parts.push('## 执行记录', '', ...report.events.map((e) => `- ${new Date(e.created_at * 1000).toISOString()} · ${e.detail}`));
  return parts.join('\n');
}

/** 生成不压缩的标准 ZIP；Word 文件无需外部运行时依赖。 */
export function zip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name); const crc = crc32(file.data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt32LE(crc, 14); header.writeUInt32LE(file.data.length, 18); header.writeUInt32LE(file.data.length, 22); header.writeUInt16LE(name.length, 26);
    const index = Buffer.alloc(46); index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6); index.writeUInt16LE(0x800, 8); index.writeUInt32LE(crc, 16); index.writeUInt32LE(file.data.length, 20); index.writeUInt32LE(file.data.length, 24); index.writeUInt16LE(name.length, 28); index.writeUInt32LE(offset, 42);
    local.push(header, name, file.data); central.push(index, name); offset += header.length + name.length + file.data.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const paragraph = (text: string, style = '') => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;

export async function word(report: Report, publicUrl: string, loadImage: (url: string) => Promise<ImageInput>): Promise<Buffer> {
  const paragraphs = [paragraph(report.task.course_name, 'Title'), paragraph(`${operationName[report.task.operation] ?? report.task.operation} · ${statusName[report.task.state] ?? report.task.state}`), paragraph(report.task.detail)];
  const files: Array<{ name: string; data: Buffer }> = [];
  const relationships: string[] = [];
  let bytes = 0;
  let imageCount = 0;
  for (const record of records(report)) {
    paragraphs.push(paragraph(record.attempt.name, 'Heading1'), paragraph((record.confirmed ? '提交结果已由平台确认' : '提交结果尚未确认') + (record.score == null ? '' : ` · 得分 ${record.score}`)));
    for (const [i, q] of (record.attempt.questions as Question[]).entries()) {
      paragraphs.push(paragraph(`${i + 1}. ${q.text}`, 'Heading2'));
      q.options.forEach((o, j) => paragraphs.push(paragraph(`${String.fromCharCode(65 + j)}. ${o.text}`)));
      paragraphs.push(paragraph(`答案：${answerText(q, record.answers?.[q.id])}`));
      if (q.correct_answer?.length) paragraphs.push(paragraph(`平台公开答案：${answerText(q, q.correct_answer)}`));
      const explanation = q.explanation || record.explanations?.[q.id]; if (explanation) paragraphs.push(paragraph(`解析：${explanation}`));
      for (const url of q.images ?? []) {
        try {
          if (bytes > 20_000_000 || imageCount >= 50) throw new Error('图片达到导出上限');
          const image = await loadImage(url); const data = Buffer.from(image.data, 'base64');
          if (!['image/png', 'image/jpeg'].includes(image.mime)) throw new Error('图片格式不适合嵌入 Word');
          const n = ++imageCount; const ext = image.mime === 'image/png' ? 'png' : 'jpg'; bytes += data.length;
          files.push({ name: `word/media/image${n}.${ext}`, data });
          relationships.push(`<Relationship Id="img${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${n}.${ext}"/>`);
          let pixels = { width: 600, height: 400 };
          if (ext === 'png' && data.length > 24) pixels = { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
          else if (ext === 'jpg') {
            for (let offset = 2; offset + 9 < data.length;) {
              if (data[offset] !== 0xff) break;
              const marker = data[offset + 1]!; const length = data.readUInt16BE(offset + 2);
              if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker)) { pixels = { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) }; break; }
              if (length < 2) break; offset += length + 2;
            }
          }
          const scale = Math.min(4_572_000 / Math.max(1, pixels.width), 5_000_000 / Math.max(1, pixels.height), 9525);
          const width = Math.round(Math.max(1, pixels.width) * scale), height = Math.round(Math.max(1, pixels.height) * scale);
          paragraphs.push(`<w:p><w:r><w:drawing><wp:inline><wp:extent cx="${width}" cy="${height}"/><wp:docPr id="${n}" name="题图 ${n}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="题图 ${n}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="img${n}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`);
        } catch { paragraphs.push(paragraph(`题图无法嵌入，请在登录站点后打开：${new URL(url, publicUrl).href}`)); }
      }
    }
  }
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${paragraphs.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;
  const styles = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="等线"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>${[['Title', 36], ['Heading1', 30], ['Heading2', 24]].map(([id, size]) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id}"/><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`).join('')}</w:styles>`;
  const parts: Record<string, string> = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="doc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': document, 'word/styles.xml': styles,
    'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${relationships.join('')}</Relationships>`,
  };
  for (const [name, value] of Object.entries(parts)) files.push({ name, data: Buffer.from(value) });
  return zip(files);
}

export async function exportReport(report: Report, format: string, publicUrl: string, loadImage: (url: string) => Promise<ImageInput>) {
  if (format === 'json') return { type: 'application/json', data: Buffer.from(JSON.stringify(report, null, 2)), extension: 'json' };
  if (format === 'md') return { type: 'text/markdown; charset=utf-8', data: Buffer.from(markdown(report, publicUrl)), extension: 'md' };
  if (format === 'csv') return { type: 'text/csv; charset=utf-8', data: Buffer.from(csv([...records(report).flatMap((r) => r.attempt.questions.map((q: Question) => ({ 类型: '题目', 试卷: r.attempt.name, 题号: q.id, 题干: q.text, 选项: q.options.map((o) => `${o.id}. ${o.text}`).join('；'), 答案: answerText(q, r.answers?.[q.id]), 平台公开答案: answerText(q, q.correct_answer), 解析: q.explanation || r.explanations?.[q.id] || '', 提交: r.confirmed ? '平台已确认' : '尚未确认', 成绩: r.score ?? '' }))), ...report.events.map((e) => ({ 类型: e.kind, 内容: e.detail, 时间: new Date(e.created_at * 1000).toISOString() }))])), extension: 'csv' };
  if (format === 'docx') return { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: await word(report, publicUrl, loadImage), extension: 'docx' };
  throw badRequest('导出格式须为 md、docx、json 或 csv');
}
