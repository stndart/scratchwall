import PDFDocument from 'pdfkit';
import { formatBytes } from './media';
import type { Attachment, Memo, Space } from './types';

const MARGIN = 44;
const CONTENT_BOTTOM = 784;
const IMAGE_HEIGHT = 283;
const INK = '#182b38';
const MUTED = '#465c69';
const ACCENT = '#42664a';
const RULE = '#cfdad9';

interface SpacePdfOptions {
  space: Space;
  memos: Memo[];
  attachments: Attachment[];
  loadImage: (attachment: Attachment) => Promise<Blob>;
  fileLink: (attachment: Attachment) => string | undefined;
  signal: AbortSignal;
}

function imageMime(attachment: Attachment) {
  const mime = attachment.mimeType.split(';')[0].trim().toLowerCase();
  return mime.startsWith('image/') ? mime : undefined;
}

async function readImage(blob: Blob, mime: string) {
  const bitmap = await createImageBitmap(blob);
  try {
    let source = blob;
    if (mime !== 'image/png' && mime !== 'image/jpeg') {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Image conversion is unavailable');
      context.drawImage(bitmap, 0, 0);
      source = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((png) => png ? resolve(png) : reject(new Error('Image conversion failed'))),
      );
    }
    return { bytes: await source.arrayBuffer(), width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

function wrap(doc: PDFKit.PDFDocument, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\t/g, '    ').split(/\r\n?|\n/)) {
    let line = '';
    for (const token of paragraph.match(/\s+|\S+/gu) ?? []) {
      if (doc.widthOfString(line + token) <= width) {
        line += token;
        continue;
      }
      if (line.trim()) lines.push(line.trimEnd());
      line = '';
      if (!token.trim()) continue;
      for (const character of token) {
        if (doc.widthOfString(line + character) > width) {
          lines.push(line);
          line = '';
        }
        line += character;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export async function createSpacePdf({ space, memos, attachments, loadImage, fileLink, signal }: SpacePdfOptions): Promise<Blob> {
  const spaceMemos = memos.filter((memo) => memo.spaceId === space.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const fontResponse = await fetch(`${import.meta.env.BASE_URL}pdf-fonts/DejaVuSans.ttf`, { signal });
  if (!fontResponse.ok) throw new Error('Could not load the PDF font.');
  const font = await fontResponse.arrayBuffer();
  signal.throwIfAborted();

  const doc = new PDFDocument({
    autoFirstPage: false,
    size: 'A4',
    margin: MARGIN,
    // PDFKit 0.20 accepts a font buffer here. The declarations still require a path.
    // @ts-expect-error
    font,
    info: { Title: space.name, Subject: 'Scratchwall space export' },
  });
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const completed = new Promise<Blob>((resolve, reject) => {
    doc.on('data', (chunk: Uint8Array<ArrayBuffer>) => chunks.push(chunk));
    doc.once('end', () => resolve(new Blob(chunks, { type: 'application/pdf' })));
    doc.once('error', reject);
  });
  void completed.catch(() => {});

  const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'medium' });
  let page = 0;
  let y = 0;
  let right = 0;
  let width = 0;
  let memoLabel = '';
  function line(text: string, x: number, top: number, size: number, color = INK, link?: string) {
    doc.fontSize(size).fillColor(color).text(text, x, top, { lineBreak: false, link });
  }
  function divider(top: number) {
    doc.strokeColor(RULE).lineWidth(0.5).moveTo(MARGIN, top).lineTo(right, top).stroke();
  }
  function newPage(continued = false) {
    doc.addPage();
    page++;
    right = doc.page.width - MARGIN;
    width = right - MARGIN;
    divider(801);
    line('SCRATCHWALL  /  SPACE EXPORT', MARGIN, 806, 8, MUTED);
    const pageNumber = String(page);
    line(pageNumber, right - doc.widthOfString(pageNumber), 806, 8, MUTED);
    y = MARGIN;
    if (page > 1) {
      line('SCRATCHWALL', MARGIN, y, 13, ACCENT);
      y += 24;
    }
    if (continued) {
      divider(y);
      line(`${memoLabel}  /  CONTINUED`, MARGIN, y + 7, 9, ACCENT);
      y += 25;
    }
  }
  function reserve(height: number) {
    if (y + height > CONTENT_BOTTOM) newPage(true);
  }
  function rows(text: string, size: number) {
    return text ? wrap(doc.fontSize(size), text, width) : [];
  }
  function paragraph(text: string[], size: number, color = INK, link?: string) {
    const leading = size + 3;
    for (const row of text) {
      reserve(leading);
      line(row, MARGIN, y, size, color, link);
      y += leading;
    }
  }
  async function prepareImage(attachment: Attachment, mime: string) {
    signal.throwIfAborted();
    const blob = await loadImage(attachment);
    signal.throwIfAborted();
    const image = await readImage(blob, mime).catch(() => undefined);
    if (!image) return;
    const scale = Math.min(width / image.width, IMAGE_HEIGHT / image.height);
    return { bytes: image.bytes, width: image.width * scale, height: image.height * scale };
  }

  try {
    newPage();
    line('SCRATCHWALL SPACE EXPORT', MARGIN, y, 9, ACCENT);
    y += 20;
    paragraph(rows(space.name, 32), 32);
    y += 4;
    const fileCount = spaceMemos.reduce((count, memo) => count + memo.attachmentIds.length, 0);
    line(`${spaceMemos.length} memos  /  ${fileCount} attachments`, MARGIN, y, 10, MUTED);
    line(`Timestamps shown in ${date.resolvedOptions().timeZone}`, MARGIN, y + 17, 9, MUTED);
    y += 41;
    if (!spaceMemos.length) paragraph(['This space is empty.'], 11, MUTED);

    for (const [index, memo] of spaceMemos.entries()) {
      signal.throwIfAborted();
      const timestamp = date.format(new Date(memo.createdAt));
      const edited = memo.updatedAt !== memo.createdAt;
      const metaHeight = edited ? 38 : 24;
      const body = rows(memo.body, 11);
      const tags = rows(memo.tags.map((tag) => `#${tag}`).join('  '), 9);
      const files = memo.attachmentIds.map((id) => {
        const attachment = byId.get(id);
        if (!attachment || attachment.memoId !== memo.id) {
          throw new Error('Some attachment details are still syncing. Try again after sync finishes.');
        }
        return {
          attachment,
          mime: imageMime(attachment),
          caption: `${attachment.filename}  /  ${formatBytes(attachment.size)}`,
        };
      });
      const lead = files[0];
      const firstImage = lead?.mime ? await prepareImage(lead.attachment, lead.mime) : undefined;
      signal.throwIfAborted();
      const firstImageHeight = firstImage ? rows(lead.caption, 8.5).length * 12 + firstImage.height + 11 : 0;
      const memoHeight = metaHeight + body.length * 14 + tags.length * 12 + firstImageHeight;
      const minimumHeight = memoHeight <= CONTENT_BOTTOM - MARGIN - 24 ? memoHeight : metaHeight + 28;
      if (y + minimumHeight > CONTENT_BOTTOM) newPage();
      memoLabel = `MEMO ${String(index + 1).padStart(2, '0')}`;
      doc.outline.addItem(`${memoLabel} | ${timestamp}`);
      divider(y);
      line(memoLabel, MARGIN, y + 7, 9, ACCENT);
      doc.fontSize(9);
      line(timestamp, right - doc.widthOfString(timestamp), y + 7, 9, MUTED);
      if (edited) {
        const updated = `Updated ${date.format(new Date(memo.updatedAt))}`;
        line(updated, right - doc.widthOfString(updated), y + 21, 9, MUTED);
      }
      y += metaHeight;
      paragraph(body, 11);
      paragraph(tags, 9, ACCENT);
      for (const [ordinal, { attachment, mime, caption }] of files.entries()) {
        signal.throwIfAborted();
        const link = fileLink(attachment);
        if (!mime) {
          paragraph(rows(`${link ? 'File' : 'Local file'}: ${caption}`, 9), 9, MUTED, link);
          continue;
        }

        const image = ordinal === 0 ? firstImage : await prepareImage(attachment, mime);
        signal.throwIfAborted();
        if (!image) {
          paragraph(rows(`Image preview unavailable: ${caption}`, 9), 9, MUTED, link);
          continue;
        }

        const { width: w, height: h } = image;
        const x = (doc.page.width - w) / 2;
        const captionRows = rows(caption, 8.5);
        reserve(captionRows.length * 12 + h + 11);
        for (const row of captionRows) {
          line(row, MARGIN, y, 8.5, MUTED, link);
          y += 12;
        }
        doc.image(image.bytes, x, y, { width: w, height: h });
        doc.rect(x, y, w, h).strokeColor(RULE).lineWidth(0.5).stroke();
        y += h + 11;
      }
      y += 11;
    }

    signal.throwIfAborted();
    doc.end();
    return await completed;
  } catch (error) {
    doc.pause();
    chunks.length = 0;
    throw error;
  }
}
