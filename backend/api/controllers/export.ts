import { FastifyRequest, FastifyReply } from 'fastify';
import PDFDocument from 'pdfkit';
import { PassThrough } from 'stream';
import { db } from '../../services/db';

const TEAL = '#065f46';

function writeTableHeader(doc: PDFKit.PDFDocument, columns: string[], colWidths: number[]) {
  doc.font('Helvetica-Bold').fontSize(9).fillColor(TEAL);
  let x = doc.page.margins.left;
  columns.forEach((col, i) => {
    doc.text(col, x, doc.y, { width: colWidths[i], lineBreak: false });
    x += colWidths[i];
  });
  doc.moveDown(0.5);
  doc.moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor(TEAL).stroke();
  doc.moveDown(0.3);
}

function writeTableRow(doc: PDFKit.PDFDocument, cells: string[], colWidths: number[]) {
  doc.font('Helvetica').fontSize(8).fillColor('#111827');
  let x = doc.page.margins.left;
  cells.forEach((cell, i) => {
    doc.text(cell ?? '-', x, doc.y, { width: colWidths[i], lineBreak: false });
    x += colWidths[i];
  });
  doc.moveDown(0.4);
}

function beginPdfReply(reply: FastifyReply, filename: string): PDFKit.PDFDocument {
  const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
  const stream = new PassThrough();

  doc.on('error', (error) => {
    stream.destroy(error);
  });
  doc.pipe(stream);

  reply
    .type('application/pdf')
    .header('Content-Disposition', `attachment; filename="${filename}"`)
    .send(stream);

  return doc;
}

export const ExportController = {
  contactsPdf: async (request: FastifyRequest, reply: FastifyReply) => {
    const contacts = await db.contact.findMany({
      where: { organization_id: request.user.org_id, status: { not: 'archived' } },
      orderBy: { first_name: 'asc' },
      select: { first_name: true, last_name: true, phone: true, email: true, company: true, status: true },
    });

    const doc = beginPdfReply(reply, 'contacts.pdf');

    doc.font('Helvetica-Bold').fontSize(16).fillColor(TEAL).text('Contacts', { align: 'left' });
    doc.fontSize(9).fillColor('#6b7280').text(`Exported ${new Date().toLocaleDateString()}  -  ${contacts.length} records`);
    doc.moveDown(1);

    const colWidths = [130, 100, 110, 170, 100, 70];
    writeTableHeader(doc, ['Name', 'Phone', 'Email', 'Company', 'Status', ''], colWidths);

    for (const c of contacts) {
      if (doc.y > doc.page.height - 80) doc.addPage();
      writeTableRow(doc, [
        `${c.first_name} ${c.last_name ?? ''}`.trim(),
        c.phone ?? '',
        c.email ?? '',
        c.company ?? '',
        c.status,
        '',
      ], colWidths);
    }

    doc.end();
    return reply;
  },

  dealsPdf: async (request: FastifyRequest, reply: FastifyReply) => {
    const deals = await db.deal.findMany({
      where: { organization_id: request.user.org_id, status: { not: 'archived' } },
      orderBy: { created_at: 'desc' },
      select: {
        title: true,
        value: true,
        currency: true,
        expected_close: true,
        status: true,
        stage: { select: { name: true } },
      },
    });

    const doc = beginPdfReply(reply, 'deals.pdf');

    doc.font('Helvetica-Bold').fontSize(16).fillColor(TEAL).text('Deals', { align: 'left' });
    doc.fontSize(9).fillColor('#6b7280').text(`Exported ${new Date().toLocaleDateString()}  -  ${deals.length} records`);
    doc.moveDown(1);

    const colWidths = [180, 90, 70, 120, 100, 70];
    writeTableHeader(doc, ['Title', 'Value', 'Currency', 'Stage', 'Close Date', 'Status'], colWidths);

    for (const d of deals) {
      if (doc.y > doc.page.height - 80) doc.addPage();
      writeTableRow(doc, [
        d.title,
        d.value != null ? String(Number(d.value).toLocaleString()) : '',
        d.currency ?? '',
        d.stage?.name ?? '',
        d.expected_close ? d.expected_close.toLocaleDateString() : '',
        d.status,
      ], colWidths);
    }

    doc.end();
    return reply;
  },
};
