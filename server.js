// server.js — Site público + painel de gestão (Grupo Vigilante Free) — MySQL/XAMPP
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const { init, repo, pool } = require('./db');
const { streamQuotePDF } = require('./lib/pdf');
const PgSession = require('connect-pg-simple')(session);

const app = express();
const PORT = process.env.PORT || 3000;
// Render/Vercel ficam atrás de um proxy HTTPS — necessário para o cookie "secure".
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new PgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'troque-este-segredo-em-producao',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8, httpOnly: true, sameSite: 'lax', secure: 'auto' }
}));

app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.user = req.session.user || null;
  res.locals.path = req.path;
  next();
});
function flash(req, type, msg) { req.session.flash = { type, msg }; }

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function inventoryTotals() {
  const models = (await repo.inventoryView()).map(m => {
    const total = Number(m.total), locados = Number(m.locados);
    return { ...m, total, locados, em_estoque: total - locados };
  });
  const totalAparelhos = models.reduce((a, m) => a + m.total, 0);
  const totalLocados = models.reduce((a, m) => a + m.locados, 0);
  return { models, totalAparelhos, totalLocados, totalEstoque: totalAparelhos - totalLocados };
}

// Extrai o número de dias de um prazo textual ("30 dias" -> 30).
function prazoEmDias(prazo) {
  const m = String(prazo || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
// Soma dias a uma data 'YYYY-MM-DD' e devolve 'YYYY-MM-DD'.
function somaDias(dataStr, dias) {
  if (!dataStr || !dias) return null;
  const d = new Date(dataStr + 'T00:00:00Z');
  if (isNaN(d)) return null;
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function annotateContracts(rows) {
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const DIA = 86400000;
  return rows.map(c => {
    let diasParaVencer = null, vencido = false, vencendo = false;
    if (c.data_vencimento) {
      const venc = new Date(String(c.data_vencimento).slice(0, 10) + 'T00:00:00');
      diasParaVencer = Math.round((venc - hoje) / DIA);
      if (c.status === 'ativo') {
        vencido = diasParaVencer < 0;
        vencendo = diasParaVencer >= 0 && diasParaVencer <= 5;
      }
    }
    return { ...c, diasParaVencer, vencido, vencendo };
  });
}
async function contractStats() {
  const anot = annotateContracts(await repo.listContracts());
  return {
    ativos: anot.filter(c => c.status === 'ativo').length,
    vencendo: anot.filter(c => c.vencendo).length,
    vencidos: anot.filter(c => c.vencido).length,
  };
}

function requireAuth(req, res, next) {
  if (req.session.user) return next();
  return res.redirect('/admin/login');
}

// Disponibiliza a contagem de orçamentos "em aberto" para o menu lateral (badge de notificação).
app.use('/admin', wrap(async (req, res, next) => {
  if (req.session.user) {
    try { res.locals.orcAbertos = (await repo.countQuotesOpen()).c; }
    catch (e) { res.locals.orcAbertos = 0; }
  }
  next();
}));

// ================= ROTAS PÚBLICAS =================

// --- Consulta de CNPJ com vários provedores em cascata (tolerante a falhas) ---
// O endpoint da BrasilAPI depende do minha-receita e cai com frequência; por isso
// tentamos provedores alternativos até um responder. Todos são gratuitos e sem chave.
function fmtTelBR(raw) {
  const t = String(raw || '').replace(/\D/g, '');
  if (t.length === 11) return `(${t.slice(0, 2)}) ${t.slice(2, 7)}-${t.slice(7)}`;
  if (t.length === 10) return `(${t.slice(0, 2)}) ${t.slice(2, 6)}-${t.slice(6)}`;
  return String(raw || '').trim();
}
function montaEndereco(o) {
  return [o.logradouro, o.numero, o.complemento, o.bairro,
    (o.municipio && o.uf) ? `${o.municipio}/${o.uf}` : o.municipio, o.cep]
    .filter(Boolean).join(', ');
}
// BrasilAPI e Minha Receita usam os mesmos nomes de campo; a ReceitaWS usa outros.
function parseReceitaFederal(d) {
  if (!d || (!d.razao_social && !d.nome_fantasia)) return null;
  return {
    empresa: d.nome_fantasia || d.razao_social || '',
    razao_social: d.razao_social || '', nome_fantasia: d.nome_fantasia || '',
    email: String(d.email || '').toLowerCase(), telefone: fmtTelBR(d.ddd_telefone_1),
    endereco: montaEndereco(d), situacao: d.descricao_situacao_cadastral || ''
  };
}
const CNPJ_PROVIDERS = [
  { nome: 'brasilapi',    url: (c) => `https://brasilapi.com.br/api/cnpj/v1/${c}`, parse: parseReceitaFederal },
  { nome: 'minhareceita', url: (c) => `https://minhareceita.org/${c}`,             parse: parseReceitaFederal },
  { nome: 'receitaws',    url: (c) => `https://receitaws.com.br/v1/cnpj/${c}`,
    parse: (d) => (d && d.status !== 'ERROR' && (d.nome || d.fantasia)) ? {
      empresa: d.fantasia || d.nome || '',
      razao_social: d.nome || '', nome_fantasia: d.fantasia || '',
      email: String(d.email || '').toLowerCase(), telefone: fmtTelBR(d.telefone),
      endereco: montaEndereco(d), situacao: d.situacao || ''
    } : null },
];
async function consultaCnpj(cnpj) {
  let notFound = false;
  for (const p of CNPJ_PROVIDERS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    try {
      const r = await fetch(p.url(cnpj), { signal: ctrl.signal, headers: { accept: 'application/json' } });
      if (r.status === 404) { notFound = true; continue; }
      if (!r.ok) continue;
      const norm = p.parse(await r.json());
      if (norm) return { ok: true, data: { cnpj, ...norm } };
      notFound = true; // respondeu mas sem dados de empresa
    } catch (e) { /* timeout/rede: tenta o próximo */ }
    finally { clearTimeout(timer); }
  }
  return { ok: false, notFound };
}

app.get('/api/cnpj/:cnpj', wrap(async (req, res) => {
  const cnpj = String(req.params.cnpj || '').replace(/\D/g, '');
  if (cnpj.length !== 14) return res.status(400).json({ erro: 'Informe um CNPJ com 14 dígitos.' });
  const out = await consultaCnpj(cnpj);
  if (out.ok) return res.json(out.data);
  if (out.notFound) return res.status(404).json({ erro: 'CNPJ não encontrado na base pública.' });
  return res.status(502).json({ erro: 'Não foi possível consultar agora. Tente de novo em instantes ou preencha manualmente.' });
}));

app.post('/orcamento', wrap(async (req, res) => {
  const { nome, empresa, email, telefone, servico, prazo, detalhes, cnpj, data_inicio } = req.body;
  const ajax = (req.get('X-Requested-With') === 'fetch') || (req.get('accept') || '').includes('application/json');
  const doc = (cnpj || '').replace(/\D/g, '');
  // Documento (CNPJ com 14 ou CPF com 11 dígitos) agora é obrigatório.
  if (!nome || !email || !servico || (doc.length !== 11 && doc.length !== 14)) {
    const msg = 'Preencha nome, e-mail, serviço e um CNPJ ou CPF válido.';
    if (ajax) return res.status(400).json({ erro: msg });
    flash(req, 'erro', msg);
    return res.redirect('/#orcamento');
  }
  // Data prevista de início + prazo => data de fim (vencimento do futuro contrato).
  const dataInicio = (data_inicio || '').trim() || null;
  const dataFim = somaDias(dataInicio, prazoEmDias(prazo));
  const dadosCliente = {
    nome: nome.trim(), empresa: (empresa || '').trim(), email: email.trim(),
    telefone: (telefone || '').trim(), cnpj: doc.slice(0, 14),
  };
  await repo.insertQuote({
    ...dadosCliente, servico, prazo: (prazo || '').trim(),
    detalhes: (detalhes || '').trim(),
    data_inicio: dataInicio,
    data_fim: dataFim
  });
  // Alimenta o cadastro de clientes com o que foi preenchido no orçamento.
  try { await repo.upsertCliente(dadosCliente); } catch (e) { /* não bloqueia o pedido */ }
  if (ajax) return res.json({ ok: true });
  res.redirect('/obrigado');
}));

app.get('/obrigado', (req, res) => {
  res.type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
  <title>Pedido recebido — Vigilante Free</title></head>
  <body><h1>Pedido de orçamento recebido!</h1><a href="/">Voltar ao site</a></body></html>`);
});

// ================= LOGIN =================
app.get('/admin/login', (req, res) => {
  if (req.session.user) return res.redirect('/admin');
  res.render('login');
});

app.post('/admin/login', wrap(async (req, res) => {
  const { username, senha } = req.body;
  const user = await repo.userByName((username || '').trim());
  if (!user || !bcrypt.compareSync(senha || '', user.password_hash)) {
    flash(req, 'erro', 'Usuário ou senha inválidos.');
    return res.redirect('/admin/login');
  }
  req.session.user = { id: user.id, username: user.username, nome: user.nome };
  res.redirect('/admin');
}));

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// ================= PAINEL =================
app.get('/admin', requireAuth, wrap(async (req, res) => {
  const t = await inventoryTotals();
  res.render('dashboard', {
    novos: (await repo.countQuotesNew()).c,
    totalOrcamentos: (await repo.countQuotes()).c,
    totais: t,
    contratos: await contractStats(),
    ultimos: (await repo.listQuotes()).slice(0, 5),
  });
}));

// ---- Orçamentos ----
app.get('/admin/orcamentos', requireAuth, wrap(async (req, res) => {
  const status = req.query.status;
  const quotes = status ? await repo.listQuotesByStatus(status) : await repo.listQuotes();
  res.render('orcamentos', { quotes, status: status || '' });
}));

// Novo orçamento manual (formulário). Aceita ?cliente=ID para pré-preencher a partir de um cliente.
app.get('/admin/orcamentos/novo', requireAuth, wrap(async (req, res) => {
  let cliente = null;
  if (req.query.cliente) cliente = await repo.getCliente(req.query.cliente);
  res.render('orcamento_novo', { cliente });
}));

app.post('/admin/orcamentos/novo', requireAuth, wrap(async (req, res) => {
  const { nome, empresa, email, telefone, cnpj, servico, prazo, detalhes, responsavel, data_inicio } = req.body;
  if (!(nome || empresa) || !servico) {
    flash(req, 'erro', 'Informe ao menos um contato/empresa e o serviço.');
    return res.redirect('/admin/orcamentos/novo');
  }
  const doc = (cnpj || '').replace(/\D/g, '').slice(0, 14);
  const dataInicio = (data_inicio || '').trim() || null;
  const dataFim = somaDias(dataInicio, prazoEmDias(prazo));
  const dadosCliente = {
    nome: (nome || '').trim(), empresa: (empresa || '').trim(), email: (email || '').trim(),
    telefone: (telefone || '').trim(), cnpj: doc,
  };
  const r = await repo.insertQuoteManual({
    ...dadosCliente, servico: servico.trim(), prazo: (prazo || '').trim(),
    detalhes: (detalhes || '').trim(), responsavel: (responsavel || '').trim() || null,
    data_inicio: dataInicio, data_fim: dataFim,
  });
  try { await repo.upsertCliente(dadosCliente); } catch (e) { /* segue */ }
  flash(req, 'ok', 'Orçamento criado. Agora monte os itens e valores.');
  res.redirect('/admin/orcamentos/' + r.insertId);
}));

// Duplicar um orçamento existente (cabeçalho + itens) — cria uma cópia com status "novo".
app.post('/admin/orcamentos/:id/duplicar', requireAuth, wrap(async (req, res) => {
  const novoId = await repo.duplicateQuote(req.params.id);
  if (!novoId) return res.status(404).send('Orçamento não encontrado');
  flash(req, 'ok', 'Orçamento duplicado. Você está vendo a cópia.');
  res.redirect('/admin/orcamentos/' + novoId);
}));

app.get('/admin/orcamentos/:id', requireAuth, wrap(async (req, res) => {
  const q = await repo.getQuote(req.params.id);
  if (!q) return res.status(404).send('Orçamento não encontrado');
  
  const precos = await repo.getCatalogoOrcamento();
  const itens = await repo.getOrcamentoItens(req.params.id);

  // Catálogo combinado: serviços da tabela de preços + aparelhos do estoque com preço.
  res.render('orcamento_detail', { orcamento: q, tabelaPrecos: precos, itens });
}));

app.post('/admin/orcamentos/:id/salvar', requireAuth, wrap(async (req, res) => {
  const { responsavel, valor_total, itens_json, data_inicio, data_fim, observacoes } = req.body;
  await repo.saveOrcamento(req.params.id, responsavel, valor_total, JSON.parse(itens_json || '[]'), data_inicio || null, data_fim || null, (observacoes || '').trim());
  flash(req, 'ok', 'Orçamento atualizado com sucesso!');
  res.redirect('/admin/orcamentos/' + req.params.id);
}));

app.post('/admin/orcamentos/:id/status', requireAuth, wrap(async (req, res) => {
  await repo.setQuoteStatus(req.body.status, req.params.id);
  flash(req, 'ok', 'Status atualizado.');
  res.redirect('/admin/orcamentos/' + req.params.id);
}));

app.post('/admin/orcamentos/:id/excluir', requireAuth, wrap(async (req, res) => {
  await repo.delQuote(req.params.id);
  flash(req, 'ok', 'Orçamento excluído.');
  res.redirect('/admin/orcamentos');
}));

app.get('/admin/orcamentos/:id/pdf', requireAuth, wrap(async (req, res) => {
  const q = await repo.getQuote(req.params.id);
  if (!q) return res.status(404).send('Orçamento não encontrado');
  streamQuotePDF(q, res);
}));

// ---- Estoque / Locação ----
app.get('/admin/estoque', requireAuth, wrap(async (req, res) => {
  const t = await inventoryTotals();
  res.render('estoque', {
    totais: t,
    locacoes: await repo.activeRentals(),
    historico: await repo.historyRentals(),
    modelos: t.models,
  });
}));

app.post('/admin/estoque/modelo', requireAuth, wrap(async (req, res) => {
  const { modelo, descricao, numero_serie, total, preco } = req.body;
  const qtd = parseInt(total, 10);
  if (!modelo || isNaN(qtd) || qtd < 0) {
    flash(req, 'erro', 'Informe o modelo e uma quantidade válida.');
    return res.redirect('/admin/estoque');
  }
  const valor = preco ? parseFloat(String(preco).replace(',', '.')) : 0;
  await repo.insInv(modelo.trim(), (descricao || '').trim(), qtd, Number.isFinite(valor) ? valor : 0, (numero_serie || '').trim());
  flash(req, 'ok', 'Modelo adicionado ao estoque.');
  res.redirect('/admin/estoque');
}));

// Editar um modelo do estoque.
app.post('/admin/estoque/modelo/:id/editar', requireAuth, wrap(async (req, res) => {
  const inv = await repo.getInv(req.params.id);
  if (!inv) { flash(req, 'erro', 'Modelo não encontrado.'); return res.redirect('/admin/estoque'); }
  const { modelo, descricao, numero_serie, total, preco } = req.body;
  const qtd = parseInt(total, 10);
  if (!modelo || isNaN(qtd) || qtd < 0) {
    flash(req, 'erro', 'Informe o modelo e uma quantidade válida.');
    return res.redirect('/admin/estoque');
  }
  // Não deixa reduzir o total abaixo do que já está locado.
  const jaLocados = Number((await repo.sumActiveForModel(inv.id)).s);
  if (qtd < jaLocados) {
    flash(req, 'erro', `Não é possível definir o total como ${qtd}: há ${jaLocados} unidade(s) locada(s).`);
    return res.redirect('/admin/estoque');
  }
  const valor = preco ? parseFloat(String(preco).replace(',', '.')) : 0;
  await repo.updInv(inv.id, modelo.trim(), (descricao || '').trim(), qtd, Number.isFinite(valor) ? valor : 0, (numero_serie || '').trim());
  flash(req, 'ok', 'Modelo atualizado.');
  res.redirect('/admin/estoque');
}));

app.post('/admin/estoque/modelo/:id/excluir', requireAuth, wrap(async (req, res) => {
  await repo.delInv(req.params.id);
  flash(req, 'ok', 'Modelo removido.');
  res.redirect('/admin/estoque');
}));

app.post('/admin/estoque/locacao', requireAuth, wrap(async (req, res) => {
  const { inventory_id, empresa, contato, quantidade, data_prevista, obs } = req.body;
  const inv = await repo.getInv(inventory_id);
  const qtd = parseInt(quantidade, 10);
  if (!inv || !empresa || isNaN(qtd) || qtd <= 0) {
    flash(req, 'erro', 'Dados de locação incompletos.');
    return res.redirect('/admin/estoque');
  }
  const jaLocados = Number((await repo.sumActiveForModel(inv.id)).s);
  const disponivel = Number(inv.total) - jaLocados;
  if (qtd > disponivel) {
    flash(req, 'erro', `Estoque insuficiente: só há ${disponivel} unidade(s) de ${inv.modelo} disponível(is).`);
    return res.redirect('/admin/estoque');
  }
  await repo.insRental({
    inventory_id: inv.id, empresa: empresa.trim(), contato: (contato || '').trim(),
    quantidade: qtd, data_prevista: data_prevista || null, obs: (obs || '').trim()
  });
  flash(req, 'ok', `${qtd} unidade(s) de ${inv.modelo} locada(s) para ${empresa}.`);
  res.redirect('/admin/estoque');
}));

app.post('/admin/estoque/locacao/:id/devolver', requireAuth, wrap(async (req, res) => {
  await repo.returnRental(req.params.id);
  flash(req, 'ok', 'Locação marcada como devolvida — aparelhos retornaram ao estoque.');
  res.redirect('/admin/estoque');
}));

app.post('/admin/estoque/locacao/:id/excluir', requireAuth, wrap(async (req, res) => {
  await repo.delRental(req.params.id);
  flash(req, 'ok', 'Registro de locação removido.');
  res.redirect('/admin/estoque');
}));

// ---- Protocolos / Contratos ----
app.get('/admin/protocolos', requireAuth, wrap(async (req, res) => {
  const filtro = req.query.situacao || '';
  let lista = annotateContracts(await repo.listContracts());
  if (filtro === 'vencendo') lista = lista.filter(c => c.vencendo);
  else if (filtro === 'vencidos') lista = lista.filter(c => c.vencido);
  else if (filtro === 'ativos') lista = lista.filter(c => c.status === 'ativo');
  else if (filtro === 'enviado') lista = lista.filter(c => c.status === 'enviado');
  else if (filtro === 'pago') lista = lista.filter(c => c.status === 'pago');
  else if (filtro === 'encerrados') lista = lista.filter(c => c.status !== 'ativo' && c.status !== 'enviado' && c.status !== 'pago');
  res.render('protocolos', { contratos: lista, stats: await contractStats(), situacao: filtro });
}));

app.post('/admin/orcamentos/:id/contrato', requireAuth, wrap(async (req, res) => {
  const q = await repo.getQuote(req.params.id);
  if (!q) return res.status(404).send('Orçamento não encontrado');
  const hoje = new Date().toISOString().slice(0, 10);
  const r = await repo.insContract({
    quote_id: q.id, empresa: q.empresa || q.nome, contato: q.nome, email: q.email,
    servico: q.servico,
    // Puxa o valor total do orçamento, se houver.
    valor: (q.valor_total && Number(q.valor_total) > 0) ? q.valor_total : null,
    // Herda as datas do orçamento: início -> data_inicio; fim -> data_vencimento (término).
    data_inicio: q.data_inicio || hoje,
    data_vencimento: q.data_fim || null,
    obs: q.detalhes || null
  });
  await repo.setQuoteStatus('fechado', q.id);
  flash(req, 'ok', 'Contrato criado a partir do orçamento com as datas herdadas. Revise valor e vencimento se necessário.');
  res.redirect('/admin/protocolos/' + r.insertId);
}));

app.post('/admin/protocolos', requireAuth, wrap(async (req, res) => {
  const { empresa, contato, email, servico, valor, data_inicio, data_vencimento, obs } = req.body;
  if (!empresa || !data_inicio) {
    flash(req, 'erro', 'Informe ao menos empresa e data de início.');
    return res.redirect('/admin/protocolos');
  }
  const r = await repo.insContract({
    quote_id: null, empresa: empresa.trim(), contato: (contato || '').trim(),
    email: (email || '').trim(), servico: (servico || '').trim(),
    valor: valor ? parseFloat(String(valor).replace(',', '.')) : null,
    data_inicio, data_vencimento: data_vencimento || null, obs: (obs || '').trim()
  });
  flash(req, 'ok', 'Contrato registrado.');
  res.redirect('/admin/protocolos/' + r.insertId);
}));

app.get('/admin/protocolos/:id', requireAuth, wrap(async (req, res) => {
  const c = await repo.getContract(req.params.id);
  if (!c) return res.status(404).send('Contrato não encontrado');
  res.render('protocolo_detail', { c: annotateContracts([c])[0] });
}));

app.post('/admin/protocolos/:id', requireAuth, wrap(async (req, res) => {
  const c = await repo.getContract(req.params.id);
  if (!c) return res.status(404).send('Contrato não encontrado');
  const { empresa, contato, email, servico, valor, data_inicio, data_vencimento, data_pagamento, status, obs } = req.body;
  await repo.updateContract({
    id: c.id, empresa: (empresa || c.empresa).trim(), contato: (contato || '').trim(),
    email: (email || '').trim(), servico: (servico || '').trim(),
    valor: valor ? parseFloat(String(valor).replace(',', '.')) : null,
    data_inicio: data_inicio || c.data_inicio, data_vencimento: data_vencimento || null,
    data_pagamento: data_pagamento || null,
    status: status || c.status, obs: (obs || '').trim()
  });
  flash(req, 'ok', 'Contrato atualizado.');
  res.redirect('/admin/protocolos/' + c.id);
}));

app.post('/admin/protocolos/:id/excluir', requireAuth, wrap(async (req, res) => {
  await repo.delContract(req.params.id);
  flash(req, 'ok', 'Contrato excluído.');
  res.redirect('/admin/protocolos');
}));

// ---- APIs de autocomplete (sugestões ao digitar) ----
app.get('/admin/api/clientes/suggest', requireAuth, wrap(async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (q.length < 1) return res.json([]);
  const clientes = await repo.listClientes();
  const matches = clientes.filter(c => {
    return (c.empresa || '').toLowerCase().includes(q)
      || (c.nome || '').toLowerCase().includes(q)
      || (c.cnpj || '').includes(q.replace(/\D/g, ''));
  }).slice(0, 3).map(c => ({
    id: c.id,
    empresa: c.empresa || '',
    nome: c.nome || '',
    cnpj: c.cnpj || '',
    email: c.email || '',
    telefone: c.telefone || ''
  }));
  res.json(matches);
}));

app.get('/admin/api/contratos/suggest', requireAuth, wrap(async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (q.length < 1) return res.json([]);
  const contratos = await repo.listContracts();
  const matches = contratos.filter(c =>
    (c.empresa || '').toLowerCase().includes(q)
    || (c.contato || '').toLowerCase().includes(q)
  ).slice(0, 3).map(c => ({ id: c.id, empresa: c.empresa, contato: c.contato || '' }));
  res.json(matches);
}));

app.get('/admin/api/estoque/suggest', requireAuth, wrap(async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const campo = req.query.campo || 'modelo';
  if (q.length < 1) return res.json([]);
  const t = await inventoryTotals();
  const seen = new Set();
  const matches = [];
  t.models.forEach(m => {
    let val = '';
    if (campo === 'modelo') val = m.modelo || '';
    else if (campo === 'descricao') val = m.descricao || '';
    else if (campo === 'serie') val = m.numero_serie || '';
    if (val.toLowerCase().includes(q) && !seen.has(val)) {
      seen.add(val);
      matches.push({ valor: val, modelo: m.modelo });
    }
  });
  res.json(matches.slice(0, 3));
}));

// ---- Clientes ----
app.get('/admin/clientes', requireAuth, wrap(async (req, res) => {
  res.render('clientes', { clientes: await repo.listClientes() });
}));

app.get('/admin/clientes/:id', requireAuth, wrap(async (req, res) => {
  const cliente = await repo.getCliente(req.params.id);
  if (!cliente) return res.status(404).send('Cliente não encontrado');
  const orcamentos = await repo.quotesByCliente(cliente);
  res.render('cliente_detail', { cliente, orcamentos });
}));

app.post('/admin/clientes/:id', requireAuth, wrap(async (req, res) => {
  const cliente = await repo.getCliente(req.params.id);
  if (!cliente) return res.status(404).send('Cliente não encontrado');
  const { empresa, nome, email, telefone, cnpj, endereco, obs } = req.body;
  await repo.updateCliente({
    id: cliente.id,
    cnpj: (cnpj || '').replace(/\D/g, '').slice(0, 14),
    empresa: (empresa || '').trim(), nome: (nome || '').trim(),
    email: (email || '').trim(), telefone: (telefone || '').trim(),
    endereco: (endereco || '').trim(), obs: (obs || '').trim(),
  });
  flash(req, 'ok', 'Cliente atualizado.');
  res.redirect('/admin/clientes/' + cliente.id);
}));

app.post('/admin/clientes/:id/excluir', requireAuth, wrap(async (req, res) => {
  await repo.delCliente(req.params.id);
  flash(req, 'ok', 'Cliente removido do cadastro.');
  res.redirect('/admin/clientes');
}));

app.use((err, req, res, next) => {
  console.error('Erro na requisição:', err.message);
  res.status(500).send('Ocorreu um erro no servidor. Verifique o terminal.');
});

init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n  Vigilante Free rodando em  http://localhost:${PORT}`);
      console.log(`  Painel de gestão em        http://localhost:${PORT}/admin\n`);
    });
  })
  .catch((err) => {
    console.error('\n  ✗ Não foi possível conectar ao banco de dados (Supabase/PostgreSQL).');
    console.error('    Verifique a variável DATABASE_URL.', err.message);
    process.exit(1);
  });