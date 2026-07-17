// lib/pdf.js — geração do PDF do orçamento com pdfkit.
// Reconstruído: monta um PDF A4 com cabeçalho da empresa, dados do cliente,
// itens (buscados do banco) e total. Exporta streamQuotePDF(q, res).

const PDFDocument = require('pdfkit');

// Acesso opcional aos itens do orçamento (via camada de dados do projeto).
let repo = null;
try { repo = require('../db').repo; } catch (e) { repo = null; }

const AMBER = '#D98A1F';
const INK   = '#1A1D21';
const MUT   = '#6E7883';
const LINE  = '#D7DBE0';

function brMoney(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return '—';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Converte 'YYYY-MM-DD' ou 'YYYY-MM-DD HH:MM:SS' em 'DD/MM/YYYY' (com hora se houver).
function fmtDate(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return String(s);
  let out = m[3] + '/' + m[2] + '/' + m[1];
  if (m[4]) out += ' ' + m[4] + ':' + m[5];
  return out;
}

// Formata CNPJ (14) ou CPF (11) para exibição.
function fmtDoc(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return v || '';
}

async function streamQuotePDF(q, res) {
  let itens = [];
  try {
    if (repo && repo.getOrcamentoItens) itens = await repo.getOrcamentoItens(q.id);
  } catch (e) { itens = []; }

  const doc = new PDFDocument({ size: 'A4', margin: 50 });

  try {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="orcamento-${String(q.id).padStart(4, '0')}.pdf"`
    );
    doc.pipe(res);

    const left  = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;

    // Cabeçalho
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(20).text('VIGILANTE FREE', left, 50);
    doc.fillColor(AMBER).font('Helvetica-Bold').fontSize(10).text('GRUPO DE SEGURANÇA', left, 74);
    doc.fillColor(MUT).font('Helvetica').fontSize(9)
      .text('Orçamento de serviços', left, 50, { width, align: 'right' })
      .text('No ' + String(q.id).padStart(4, '0'), { width, align: 'right' })
      .text(fmtDate(q.created_at), { width, align: 'right' });

    doc.moveTo(left, 100).lineTo(right, 100).strokeColor(LINE).lineWidth(1).stroke();

    // Dados do cliente
    let y = 118;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text('Cliente', left, y);
    y += 20;

    const rows = [
      ['Empresa', q.empresa || '—'],
      ...(q.cnpj ? [['CNPJ/CPF', fmtDoc(q.cnpj)]] : []),
      ['Contato', q.nome || '—'],
      ['E-mail', q.email || '—'],
      ['Telefone', q.telefone || '—'],
      ['Serviço', q.servico || '—'],
      ['Prazo', q.prazo || '—'],
    ];
    doc.fontSize(10);
    rows.forEach(function (r) {
      doc.fillColor(MUT).font('Helvetica').text(r[0], left, y, { width: 110 });
      doc.fillColor(INK).font('Helvetica').text(String(r[1]), left + 110, y, { width: width - 110 });
      y += 18;
    });

    // Período do orçamento — sempre exibido (início e fim).
    doc.fillColor(MUT).font('Helvetica').text('Período', left, y, { width: 110 });
    doc.fillColor(INK).font('Helvetica').text(
      'Início: ' + (fmtDate(q.data_inicio) || '—') + '        Fim: ' + (fmtDate(q.data_fim) || '—'),
      left + 110, y, { width: width - 110 }
    );
    y += 18;

    if (q.detalhes) {
      y += 4;
      doc.fillColor(MUT).font('Helvetica').text('Detalhes', left, y, { width: 110 });
      doc.fillColor(INK).text(String(q.detalhes), left + 110, y, { width: width - 110 });
      y = doc.y + 4;
    }

    // Itens
    y += 16;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text('Itens do orçamento', left, y);
    y += 22;

    const colItem = left;         const wItem = 245;
    const colQtd  = left + 250;   const wQtd  = 45;
    const colVal  = left + 300;   const wVal  = 90;
    const colSub  = left + 400;   const wSub  = 95;

    doc.fontSize(9).fillColor(MUT).font('Helvetica-Bold');
    doc.text('ITEM', colItem, y, { width: wItem });
    doc.text('QTD', colQtd, y, { width: wQtd, align: 'right' });
    doc.text('VALOR UNIT.', colVal, y, { width: wVal, align: 'right' });
    doc.text('SUBTOTAL', colSub, y, { width: wSub, align: 'right' });
    y += 14;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).lineWidth(0.7).stroke();
    y += 8;

    doc.font('Helvetica').fontSize(10);
    let total = 0;
    if (itens && itens.length) {
      itens.forEach(function (it) {
        if (y > doc.page.height - 130) { doc.addPage(); y = 60; }
        const qtd = Number(it.quantidade) || 0;
        const val = Number(it.valor_unitario) || 0;
        const sub = qtd * val; total += sub;

        doc.fillColor(INK).text(String(it.nome || ''), colItem, y, { width: wItem });
        const itemBottom = doc.y;
        doc.text(String(qtd), colQtd, y, { width: wQtd, align: 'right' });
        doc.text(brMoney(val), colVal, y, { width: wVal, align: 'right' });
        doc.text(brMoney(sub), colSub, y, { width: wSub, align: 'right' });
        y = Math.max(itemBottom, y + 16) + 3;
      });
    } else {
      doc.fillColor(MUT).text('Nenhum item lançado neste orçamento.', colItem, y);
      y += 18;
    }

    // Total
    y += 6;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).lineWidth(0.7).stroke();
    y += 12;
    const totalValor = (q.valor_total && Number(q.valor_total) > 0) ? Number(q.valor_total) : total;
    doc.font('Helvetica-Bold').fontSize(12);
    doc.fillColor(MUT).text('TOTAL', colVal, y, { width: wVal, align: 'right' });
    doc.fillColor(AMBER).text(brMoney(totalValor), colSub, y, { width: wSub, align: 'right' });

    // Rodapé
    if (q.responsavel) {
      doc.font('Helvetica').fontSize(9).fillColor(MUT)
        .text('Responsavel: ' + q.responsavel, left, doc.page.height - 82, { width, lineBreak: false });
    }
    doc.font('Helvetica').fontSize(8).fillColor(MUT)
      .text('Grupo Vigilante Free · contato@vigilantefree.com · (11) 2495-7258',
        left, doc.page.height - 66, { width, align: 'center', lineBreak: false });

    doc.end();
  } catch (err) {
    try { doc.end(); } catch (e) { /* ignore */ }
    if (!res.headersSent) res.status(500).send('Erro ao gerar PDF.');
  }
}

module.exports = { streamQuotePDF };
