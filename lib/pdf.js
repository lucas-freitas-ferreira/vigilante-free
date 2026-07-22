// lib/pdf.js — geração do PDF do orçamento no layout de "Ordem de Serviço"
// (segue o modelo em papel da Vigilante Free). Exporta streamQuotePDF(q, res).

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

// Acesso opcional aos itens do orçamento (via camada de dados do projeto).
let repo = null;
try { repo = require('../db').repo; } catch (e) { repo = null; }

// ===== Dados fixos do prestador (papel timbrado) — edite aqui se mudar. =====
const EMPRESA = {
  nome: 'VIGILANTE FREE PLUS',
  razao: 'VIGILANTE FREE UNIPESSOAL LTDA',
  endereco: 'AV Paulista, 1471 - CONJ 511 SALA 02 - BELA VISTA - São Paulo - SP - CEP: 01311-092',
  cnpj: 'CNPJ: 46.196.099/0001-40   IE: ISENTO',
  telefone: '(11) 94747-3971',
  email: 'xavier@vigilantefree.com',
};
const LOGO_PATH = path.join(__dirname, '..', 'public', 'logo.png');

// ===== Paleta / medidas =====
const INK = '#1A1D21';
const MUT = '#6E7883';
const SOFT = '#9AA2AB';
const LINE = '#C9CDD3';
const AMBER = '#C8891A';

function brMoney(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return '—';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function fmtDate(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(s);
  return m[3] + '/' + m[2] + '/' + m[1];
}
function hojeBR() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear();
}
function fmtDoc(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return v || '';
}

// Desenha o cabeçalho (data + "Ordem de serviço Nº" + papel timbrado). Retorna o y final.
function drawHeader(doc, q, left, right, width) {
  const osNum = String(q.id).padStart(3, '0');
  let y = 42;

  // Linha superior: data + "Aos cuidados de" à esquerda, "Ordem de serviço N" à direita.
  const cuidados = (q.responsavel || q.nome || '').trim();
  doc.font('Helvetica').fontSize(9).fillColor(MUT)
    .text(hojeBR() + '     ' + (cuidados ? 'Aos cuidados de ' + cuidados : ''), left, y, { width: width * 0.6, lineBreak: false });
  doc.font('Helvetica').fontSize(10).fillColor(MUT)
    .text('Ordem de serviço', left, y - 6, { width, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(16).fillColor(INK)
    .text('Nº ' + osNum, left, doc.y + 1, { width, align: 'right' });

  y = 66;
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(INK).stroke();

  // Papel timbrado: logo + dados da empresa; telefone/e-mail à direita.
  y += 14;
  const logoY = y;
  try {
    if (fs.existsSync(LOGO_PATH)) doc.image(LOGO_PATH, left, logoY, { fit: [54, 58] });
  } catch (e) { /* sem logo, segue */ }

  const tx = left + 66;
  const tw = width - 66 - 170; // reserva a faixa da direita p/ telefone/e-mail
  doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(EMPRESA.nome, tx, y, { width: tw });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUT).text(EMPRESA.endereco, tx, doc.y + 1, { width: tw });
  doc.fillColor(SOFT).fontSize(8).text(EMPRESA.razao, tx, doc.y + 3, { width: tw });
  doc.fillColor(SOFT).fontSize(8).text(EMPRESA.cnpj, tx, doc.y + 1, { width: tw });

  // Direita: telefone (bold) + e-mail
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
    .text(EMPRESA.telefone, left, y, { width, align: 'right' });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUT)
    .text(EMPRESA.email, left, y + 24, { width, align: 'right' });

  y = Math.max(doc.y, logoY + 58) + 8;
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1.4).strokeColor(INK).stroke();
  doc.moveTo(left, y + 2.5).lineTo(right, y + 2.5).lineWidth(0.6).strokeColor(INK).stroke();
  return y + 12;
}

// Caixa de rótulo à direita (Data de início / Previsão de entrega).
function labelValue(doc, label, value, x, y, w) {
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(label, x, y, { width: w });
  doc.font('Helvetica').fontSize(9.5).fillColor(MUT).text(value || '—', x, doc.y + 1, { width: w });
}

function sectionBar(doc, title, left, right, width, y) {
  doc.moveTo(left, y).lineTo(right, y).lineWidth(0.8).strokeColor(LINE).stroke();
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(title, left, y + 8, { width });
  const yy = doc.y + 6;
  doc.moveTo(left, yy).lineTo(right, yy).lineWidth(0.8).strokeColor(LINE).stroke();
  return yy + 10;
}

async function streamQuotePDF(q, res) {
  let itens = [];
  try { if (repo && repo.getOrcamentoItens) itens = await repo.getOrcamentoItens(q.id); }
  catch (e) { itens = []; }

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  try {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `inline; filename="ordem-servico-${String(q.id).padStart(3, '0')}.pdf"`);
    doc.pipe(res);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;
    const bottom = doc.page.height - doc.page.margins.bottom;

    // ---------- PÁGINA 1 ----------
    let y = drawHeader(doc, q, left, right, width);

    // Caixa do cliente (empresa/cnpj/endereço + contato + datas à direita).
    const boxTop = y;
    const boxPadX = 14, boxPadY = 12;
    const rightColW = 150;
    const cx = left + boxPadX;
    const cInnerW = width - boxPadX * 2 - rightColW - 14;

    let cy = boxTop + boxPadY;
    doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(q.empresa || q.nome || '—', cx, cy, { width: cInnerW });
    cy = doc.y + 1;
    if (q.cnpj) { doc.font('Helvetica').fontSize(8.5).fillColor(SOFT).text('CNPJ/CPF: ' + fmtDoc(q.cnpj), cx, cy, { width: cInnerW }); cy = doc.y + 4; }
    // Contato (telefone / e-mail)
    const contato = [q.telefone, q.email].filter(Boolean).join('     ');
    if (contato) { doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(contato, cx, cy, { width: cInnerW }); cy = doc.y + 2; }
    if (q.servico) { doc.font('Helvetica').fontSize(8.5).fillColor(MUT).text('Serviço: ' + q.servico, cx, cy, { width: cInnerW }); cy = doc.y; }

    // Coluna direita: Data de início / Previsão de entrega
    const rx = right - boxPadX - rightColW;
    let ry = boxTop + boxPadY;
    labelValue(doc, 'Data de início', fmtDate(q.data_inicio), rx, ry, rightColW);
    ry = doc.y + 8;
    labelValue(doc, 'Previsão de entrega', fmtDate(q.data_fim), rx, ry, rightColW);

    const boxBottom = Math.max(cy, doc.y) + boxPadY;
    doc.roundedRect(left, boxTop, width, boxBottom - boxTop, 4).lineWidth(0.8).strokeColor(LINE).stroke();
    y = boxBottom + 16;

    // Cabeçalho de equipamento (Serviço | Prazo | Nº do orçamento)
    const col1 = left, col2 = left + width * 0.42, col3 = left + width * 0.68;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK);
    doc.text('Serviço contratado', col1, y);
    doc.text('Prazo', col2, y);
    doc.text('Nº do orçamento', col3, y);
    doc.font('Helvetica').fontSize(9.5).fillColor(MUT);
    const yv = doc.y + 1;
    doc.text(q.servico || '—', col1, yv, { width: width * 0.40 });
    const hEq = doc.y;
    doc.text(q.prazo || '—', col2, yv, { width: width * 0.24 });
    doc.text(String(q.id).padStart(4, '0'), col3, yv, { width: width * 0.30 });
    y = Math.max(hEq, doc.y) + 12;

    // Detalhes informados (bloco de texto livre)
    if (q.detalhes) {
      doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(String(q.detalhes), left, y, { width });
      y = doc.y + 10;
    }

    // Aviso padrão de manutenção (como no modelo).
    doc.font('Helvetica-Bold').fontSize(8).fillColor(AMBER).text(
      'MANUTENÇÃO NA OBRA TEM O CUSTO DE R$150,00. CONSERTOS NA EMPRESA CONTRATADA NÃO TERÃO CUSTO SE NÃO CONSTATADO MAU USO.',
      left, y, { width });
    y = doc.y + 14;

    // Guarda de espaço: abre nova página (com cabeçalho) se não couber "need" pontos.
    const ensure = (need) => { if (y > bottom - need) { doc.addPage(); y = drawHeader(doc, q, left, right, width); } };

    // ----- Seção: Problema ou defeito apresentado (área em branco, como no modelo) -----
    ensure(70);
    y = sectionBar(doc, 'Problema ou defeito apresentado', left, right, width, y);
    y += 34;

    // ----- Seção: Serviço que será apresentado (itens + total) -----
    ensure(120);
    y = sectionBar(doc, 'Serviço que será apresentado', left, right, width, y);

    // Cabeçalho da tabela de itens
    const cItem = left, wItem = width - 260;
    const cQtd = left + width - 260, wQtd = 50;
    const cVal = left + width - 200, wVal = 95;
    const cSub = left + width - 100, wSub = 100;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUT);
    doc.text('ITEM', cItem, y, { width: wItem });
    doc.text('QTD', cQtd, y, { width: wQtd, align: 'right' });
    doc.text('VALOR UNIT.', cVal, y, { width: wVal, align: 'right' });
    doc.text('SUBTOTAL', cSub, y, { width: wSub, align: 'right' });
    y += 12;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.6).strokeColor(LINE).stroke();
    y += 7;

    doc.font('Helvetica').fontSize(9.5);
    let total = 0;
    if (itens && itens.length) {
      itens.forEach((it) => {
        ensure(60);
        const qtd = Number(it.quantidade) || 0;
        const val = Number(it.valor_unitario) || 0;
        const sub = qtd * val; total += sub;
        doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(String(it.nome || ''), cItem, y, { width: wItem });
        const rowBottom = doc.y;
        doc.text(String(qtd), cQtd, y, { width: wQtd, align: 'right' });
        doc.text(brMoney(val), cVal, y, { width: wVal, align: 'right' });
        doc.text(brMoney(sub), cSub, y, { width: wSub, align: 'right' });
        y = Math.max(rowBottom, y + 14) + 4;
      });
    } else {
      doc.fillColor(MUT).text('Nenhum item lançado neste orçamento.', cItem, y);
      y += 16;
    }

    // Total
    ensure(40);
    y += 4;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.6).strokeColor(LINE).stroke();
    y += 10;
    const totalValor = (q.valor_total && Number(q.valor_total) > 0) ? Number(q.valor_total) : total;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(MUT).text('TOTAL', cVal, y, { width: wVal, align: 'right' });
    doc.fillColor(AMBER).text(brMoney(totalValor), cSub, y, { width: wSub, align: 'right' });

    // ---------- PÁGINA FINAL — Observações + assinatura ----------
    doc.addPage();
    y = drawHeader(doc, q, left, right, width);

    // Caixa "Observações" — imprime o texto se houver, senão deixa em branco
    const obsText = (q.observacoes || '').trim();
    function obsBox(yTop, minH, text) {
      if (text) {
        // Mede a altura necessária para o texto
        const textTop = yTop + 26;
        const textW = width - 24;
        const textH = doc.font('Helvetica').fontSize(9.5).heightOfString(text, { width: textW });
        const boxH = Math.max(minH, textH + 40);
        doc.roundedRect(left, yTop, width, boxH, 4).lineWidth(0.8).strokeColor(LINE).stroke();
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(MUT).text('Observações:', left + 12, yTop + 10);
        doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(text, left + 12, textTop, { width: textW });
        return boxH;
      } else {
        doc.roundedRect(left, yTop, width, minH, 4).lineWidth(0.8).strokeColor(LINE).stroke();
        doc.font('Helvetica').fontSize(9.5).fillColor(MUT).text('Observações:', left + 12, yTop + 10);
        return minH;
      }
    }
    const obs1H = obsBox(y, 96, obsText);
    y += obs1H + 20;

    // Separador tracejado
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.8).dash(4, { space: 3 }).strokeColor(SOFT).stroke().undash();
    y += 18;

    // Linha de assinatura / data / horas / Nº da OS
    const boxH = 92;
    doc.roundedRect(left, y, width, boxH, 4).lineWidth(0.8).strokeColor(LINE).stroke();
    const iy = y + 16;
    doc.font('Helvetica').fontSize(9.5).fillColor(INK)
      .text('Data ____/____/______        Hora de entrada: __________        Hora de saída: __________', left + 14, iy);
    // Nº da OS à direita
    doc.font('Helvetica').fontSize(10).fillColor(INK)
      .text('Nº da OS ', left, iy - 2, { width: width - 14, align: 'right', continued: true })
      .font('Helvetica-Bold').fontSize(13).text(String(q.id).padStart(3, '0'));
    // Linha de assinatura
    const sy = y + boxH - 26;
    const sigW = 280, sigX = left + 30;
    doc.moveTo(sigX, sy).lineTo(sigX + sigW, sy).lineWidth(0.8).strokeColor(INK).stroke();
    doc.font('Helvetica').fontSize(9).fillColor(MUT).text('Assinatura do cliente', sigX, sy + 4, { width: sigW, align: 'center' });
    y += boxH + 18;

    // Segunda caixa "Observações" (em branco para preenchimento manual)
    const obs2H = obsBox(y, 84, '');
    y += obs2H;

    // Rodapé discreto (posicionado com folga para não transbordar a página)
    doc.font('Helvetica').fontSize(7.5).fillColor(SOFT).text(
      'Grupo Vigilante Free · ' + EMPRESA.email + ' · ' + EMPRESA.telefone,
      left, Math.min(y + 22, bottom - 16), { width, align: 'center', lineBreak: false });

    doc.end();
  } catch (err) {
    try { doc.end(); } catch (e) { /* ignore */ }
    if (!res.headersSent) res.status(500).send('Erro ao gerar PDF.');
  }
}

module.exports = { streamQuotePDF };
