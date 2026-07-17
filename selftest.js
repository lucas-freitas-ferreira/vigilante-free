// selftest.js — valida a aplicação contra o MySQL configurado (XAMPP).
// Requer o MySQL LIGADO. Roda: node selftest.js
const { Writable } = require('stream');
const path = require('path');
const ejs = require('ejs');
const bcrypt = require('bcryptjs');
const { init, repo, pool } = require('./db');
const { streamQuotePDF } = require('./lib/pdf');

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗ FALHOU:'} ${m}`); if (!c) fails++; };

// mesma lógica de vencimento do server
function annotate(rows) {
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  return rows.map(c => {
    let d = null, vencido = false, vencendo = false;
    if (c.data_vencimento) {
      d = Math.round((new Date(String(c.data_vencimento).slice(0, 10) + 'T00:00:00') - hoje) / 86400000);
      if (c.status === 'ativo') { vencido = d < 0; vencendo = d >= 0 && d <= 30; }
    }
    return { ...c, diasParaVencer: d, vencido, vencendo };
  });
}

(async () => {
  console.log('\n== CONEXÃO / INIT ==');
  await init();
  ok(true, 'init() conectou, criou schema e seed');

  console.log('\n== AUTENTICAÇÃO ==');
  const user = await repo.userByName('admin');
  ok(!!user, 'usuário admin existe');
  ok(bcrypt.compareSync('admin123', user.password_hash), 'senha confere (bcrypt)');

  console.log('\n== ORÇAMENTO ==');
  const r = await repo.insertQuote({ nome: 'Maria Teste', empresa: 'ACME', email: 'maria@teste.com',
    telefone: '1199', servico: 'Portaria', prazo: '2 meses', detalhes: '2 porteiros' });
  const q = await repo.getQuote(r.insertId);
  ok(q && q.status === 'novo', 'orçamento inserido com status novo');
  await repo.setQuoteStatus('em_analise', q.id);
  ok((await repo.getQuote(q.id)).status === 'em_analise', 'status atualiza');

  console.log('\n== PDF ==');
  const chunks = [];
  const res = new Writable({ write(c, e, cb) { chunks.push(c); cb(); } }); res.setHeader = () => {};
  await new Promise(rs => { res.on('finish', rs); streamQuotePDF(q, res); });
  const pdf = Buffer.concat(chunks);
  ok(pdf.slice(0, 5).toString() === '%PDF-', `PDF válido (${pdf.length} bytes)`);

  console.log('\n== ESTOQUE (SUM/tipos) ==');
  const inv = (await repo.inventoryView()).map(m => ({ ...m, total: Number(m.total), locados: Number(m.locados), em_estoque: Number(m.total) - Number(m.locados) }));
  ok(inv.length >= 3, `modelos: ${inv.length}`);
  ok(inv.every(m => Number.isFinite(m.em_estoque)), 'em_estoque é numérico (coerção do SUM funciona)');
  const dep = inv.find(m => m.modelo.includes('DEP450'));
  ok(dep && dep.locados === 20 && dep.em_estoque === 20, `DEP450: total ${dep.total} locados ${dep.locados} estoque ${dep.em_estoque}`);
  const disp = Number(dep.total) - Number((await repo.sumActiveForModel(dep.id)).s);
  ok(disp === 20, `disponível calculado = ${disp}`);

  console.log('\n== CONTRATOS / VENCIMENTO ==');
  const cr = await repo.insContract({ quote_id: null, empresa: 'Vencido SA', contato: 'x', email: '', servico: 'Portaria',
    valor: 5000, data_inicio: '2026-01-01', data_vencimento: '2026-01-10', obs: '' });
  const [venc] = annotate([await repo.getContract(cr.insertId)]);
  ok(venc.vencido, `contrato vencido detectado (dias=${venc.diasParaVencer})`);
  ok(Number(venc.valor) === 5000, `valor decimal lido corretamente (${venc.valor})`);

  console.log('\n== RENDER DAS TELAS (EJS, com dados reais) ==');
  const base = { flash: null, user: { username: 'admin', nome: 'Admin' }, path: '/admin' };
  const totais = await (async () => {
    const t = Number(inv.reduce((a, m) => a + m.total, 0)), l = Number(inv.reduce((a, m) => a + m.locados, 0));
    return { models: inv, totalAparelhos: t, totalLocados: l, totalEstoque: t - l };
  })();
  const stats = { ativos: 1, vencendo: 0, vencidos: 1 };
  const contratos = annotate(await repo.listContracts());
  const views = {
    'login.ejs': { ...base },
    'dashboard.ejs': { ...base, novos: 1, totalOrcamentos: 1, ultimos: [q], contratos: stats, totais },
    'orcamentos.ejs': { ...base, quotes: [q], status: '' },
    'orcamento_detail.ejs': { ...base, q },
    'protocolos.ejs': { ...base, contratos, stats, situacao: '' },
    'protocolo_detail.ejs': { ...base, c: contratos[0] },
    'estoque.ejs': { ...base, totais, modelos: inv, locacoes: await repo.activeRentals(), historico: await repo.historyRentals() },
  };
  for (const [file, data] of Object.entries(views)) {
    try { const html = await ejs.renderFile(path.join(__dirname, 'views', file), data);
      ok(html.length > 200, `${file} (${html.length} chars)`);
    } catch (e) { ok(false, `${file} — ERRO: ${e.message}`); }
  }

  console.log(`\n== RESULTADO: ${fails === 0 ? 'TODOS OS TESTES PASSARAM ✓' : fails + ' FALHA(S) ✗'} ==\n`);
  await pool.end();
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('ERRO FATAL:', e.code, e.message); process.exit(1); });
