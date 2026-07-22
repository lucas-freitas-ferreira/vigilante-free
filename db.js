// Carrega variáveis do arquivo .env quando rodando localmente (no Render elas já vêm do ambiente).
require('dotenv').config();
// db.js — conexão com PostgreSQL (Supabase), schema, seed e camada de dados.
// Migrado de MySQL para Postgres. Um adaptador converte os placeholders
// nomeados (:nome) usados nas queries em posicionais ($1, $2...) do Postgres,
// então o restante do app continua igual.
const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');

// --- Type parsers: manter datas como texto e contagens/somas como número ---
types.setTypeParser(20,   (v) => (v === null ? null : parseInt(v, 10))); // int8/bigint (COUNT, SUM) -> number
types.setTypeParser(1082, (v) => v); // date        -> 'YYYY-MM-DD'
types.setTypeParser(1114, (v) => v); // timestamp   -> texto
types.setTypeParser(1184, (v) => v); // timestamptz -> texto

if (!process.env.DATABASE_URL) {
  console.warn('  ⚠  DATABASE_URL não definido — configure a string de conexão do Supabase.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase exige SSL. rejectUnauthorized:false aceita o certificado gerenciado deles.
  ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
  max: Number(process.env.DB_POOL_MAX || 8),
});

// Converte :nome -> $1,$2... e monta o array de valores na ordem correta.
function toPositional(sql, params) {
  const values = [];
  const text = sql.replace(/:(\w+)/g, (_, key) => {
    if (!(key in params)) throw new Error('Parâmetro ausente na query: ' + key);
    values.push(params[key]);
    return '$' + values.length;
  });
  return { text, values };
}

async function all(sql, params = {}) {
  const { text, values } = toPositional(sql, params);
  const r = await pool.query(text, values);
  return r.rows;
}
async function one(sql, params = {}) {
  const rows = await all(sql, params);
  return rows[0];
}
// Mantém compatibilidade com o código antigo: .insertId (via RETURNING id) e .rowCount.
async function run(sql, params = {}) {
  const { text, values } = toPositional(sql, params);
  const r = await pool.query(text, values);
  return {
    insertId: r.rows && r.rows[0] ? r.rows[0].id : undefined,
    rowCount: r.rowCount,
    rows: r.rows,
  };
}

// Postgres suporta ADD COLUMN IF NOT EXISTS — migração simples para bancos antigos.
async function ensureColumn(table, column, definition) {
  await run(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
}

async function createSchema() {
  await run(`CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(191) NOT NULL UNIQUE,
    nome          VARCHAR(191),
    password_hash VARCHAR(255) NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  await run(`CREATE TABLE IF NOT EXISTS quotes (
    id           SERIAL PRIMARY KEY,
    nome         VARCHAR(191) NOT NULL,
    empresa      VARCHAR(191),
    email        VARCHAR(191) NOT NULL,
    telefone     VARCHAR(60),
    servico      VARCHAR(120) NOT NULL,
    prazo        VARCHAR(120),
    detalhes     TEXT,
    status       VARCHAR(20) NOT NULL DEFAULT 'novo',
    responsavel  VARCHAR(191),
    valor_total  NUMERIC(12,2) DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await ensureColumn('quotes', 'responsavel', 'VARCHAR(191)');
  await ensureColumn('quotes', 'valor_total', 'NUMERIC(12,2) DEFAULT 0');
  await ensureColumn('quotes', 'data_inicio', 'DATE');
  await ensureColumn('quotes', 'data_fim', 'DATE');
  await ensureColumn('quotes', 'cnpj', 'VARCHAR(18)');
  await ensureColumn('quotes', 'observacoes', 'TEXT');

  await run(`CREATE TABLE IF NOT EXISTS tabela_precos (
    id              SERIAL PRIMARY KEY,
    nome            VARCHAR(191) NOT NULL,
    valor_unitario  NUMERIC(12,2) NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS orcamento_itens (
    id             SERIAL PRIMARY KEY,
    orcamento_id   INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    nome           VARCHAR(191) NOT NULL,
    quantidade     INTEGER NOT NULL,
    valor_unitario NUMERIC(12,2) NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS inventory (
    id           SERIAL PRIMARY KEY,
    modelo       VARCHAR(191) NOT NULL,
    descricao    VARCHAR(255),
    numero_serie VARCHAR(255),
    total        INTEGER NOT NULL DEFAULT 0,
    preco        NUMERIC(12,2) NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await ensureColumn('inventory', 'preco', 'NUMERIC(12,2) NOT NULL DEFAULT 0');
  await ensureColumn('inventory', 'numero_serie', 'VARCHAR(255)');

  await run(`CREATE TABLE IF NOT EXISTS rentals (
    id            SERIAL PRIMARY KEY,
    inventory_id  INTEGER NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
    empresa       VARCHAR(191) NOT NULL,
    contato       VARCHAR(191),
    quantidade    INTEGER NOT NULL,
    data_inicio   DATE NOT NULL,
    data_prevista DATE,
    status        VARCHAR(20) NOT NULL DEFAULT 'ativa',
    obs           VARCHAR(255),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  await run(`CREATE TABLE IF NOT EXISTS contracts (
    id              SERIAL PRIMARY KEY,
    quote_id        INTEGER REFERENCES quotes(id) ON DELETE SET NULL,
    empresa         VARCHAR(191) NOT NULL,
    contato         VARCHAR(191),
    email           VARCHAR(191),
    servico         VARCHAR(120),
    valor           NUMERIC(12,2),
    data_inicio     DATE NOT NULL,
    data_vencimento DATE,
    data_pagamento  DATE,
    status          VARCHAR(20) NOT NULL DEFAULT 'ativo',
    obs             TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await ensureColumn('contracts', 'data_pagamento', 'DATE');
  // Cadastro de clientes — alimentado automaticamente pelas informações dos orçamentos.
  await run(`CREATE TABLE IF NOT EXISTS clientes (
    id           SERIAL PRIMARY KEY,
    cnpj         VARCHAR(18),
    empresa      VARCHAR(191),
    nome         VARCHAR(191),
    email        VARCHAR(191),
    telefone     VARCHAR(60),
    endereco     VARCHAR(255),
    obs          TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // Índices para o upsert por documento/e-mail (parciais: só quando há valor).
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS clientes_cnpj_uidx ON clientes (cnpj) WHERE cnpj IS NOT NULL AND cnpj <> ''`);
}

async function seed() {
  const uc = await one('SELECT COUNT(*) AS c FROM users');
  if (!uc || uc.c === 0) {
    const username = process.env.ADMIN_USER || 'admin';
    const senha = process.env.ADMIN_PASS || 'admin123';
    const hash = bcrypt.hashSync(senha, 10);
    await run('INSERT INTO users (username, nome, password_hash) VALUES (:u, :n, :h)',
      { u: username, n: 'Administrador', h: hash });
  }

  const pc = await one('SELECT COUNT(*) AS c FROM tabela_precos');
  if (!pc || pc.c === 0) {
    await run('INSERT INTO tabela_precos (nome, valor_unitario) VALUES (:n, :v)', { n: 'Instalação Câmera', v: 150.00 });
    await run('INSERT INTO tabela_precos (nome, valor_unitario) VALUES (:n, :v)', { n: 'Manutenção Mensal', v: 300.00 });
  }
}

async function init() {
  await createSchema();
  await seed();
}

const repo = {
  // Usuários
  userByName: (u) => one('SELECT * FROM users WHERE username = :u', { u }),

  // Orçamentos
  insertQuote: (d) => run(`INSERT INTO quotes (nome, empresa, email, telefone, servico, prazo, detalhes, cnpj, data_inicio, data_fim)
                            VALUES (:nome,:empresa,:email,:telefone,:servico,:prazo,:detalhes,:cnpj,:data_inicio,:data_fim)`, d),
  listQuotes: () => all('SELECT * FROM quotes ORDER BY created_at DESC, id DESC'),
  listQuotesByStatus: (s) => all('SELECT * FROM quotes WHERE status = :s ORDER BY created_at DESC, id DESC', { s }),
  getQuote: (id) => one('SELECT * FROM quotes WHERE id = :id', { id }),
  setQuoteStatus: (status, id) => run('UPDATE quotes SET status = :status WHERE id = :id', { status, id }),
  delQuote: (id) => run('DELETE FROM quotes WHERE id = :id', { id }),
  countQuotesNew: () => one("SELECT COUNT(*) AS c FROM quotes WHERE status = 'novo'"),
  countQuotes: () => one('SELECT COUNT(*) AS c FROM quotes'),
  // "Em aberto" = tudo que ainda não foi fechado nem perdido.
  countQuotesOpen: () => one("SELECT COUNT(*) AS c FROM quotes WHERE status NOT IN ('fechado','perdido')"),

  // Cria um orçamento manualmente pelo painel (mesma base do formulário público).
  insertQuoteManual: (d) => run(`INSERT INTO quotes (nome, empresa, email, telefone, servico, prazo, detalhes, cnpj, data_inicio, data_fim, responsavel, status)
                            VALUES (:nome,:empresa,:email,:telefone,:servico,:prazo,:detalhes,:cnpj,:data_inicio,:data_fim,:responsavel,'novo') RETURNING id`, d),

  // Duplica um orçamento (cabeçalho + itens). Retorna o id do novo orçamento.
  duplicateQuote: async (id) => {
    const orig = await one('SELECT * FROM quotes WHERE id = :id', { id });
    if (!orig) return null;
    const novo = await run(`INSERT INTO quotes (nome, empresa, email, telefone, servico, prazo, detalhes, cnpj, data_inicio, data_fim, responsavel, valor_total, status)
        VALUES (:nome,:empresa,:email,:telefone,:servico,:prazo,:detalhes,:cnpj,:data_inicio,:data_fim,:responsavel,:valor_total,'novo') RETURNING id`,
      { nome: orig.nome, empresa: orig.empresa, email: orig.email, telefone: orig.telefone,
        servico: orig.servico, prazo: orig.prazo, detalhes: orig.detalhes, cnpj: orig.cnpj,
        data_inicio: orig.data_inicio, data_fim: orig.data_fim, responsavel: orig.responsavel,
        valor_total: orig.valor_total });
    const novoId = novo.insertId;
    const itens = await all('SELECT * FROM orcamento_itens WHERE orcamento_id = :id', { id });
    for (const it of itens) {
      await run('INSERT INTO orcamento_itens (orcamento_id, nome, quantidade, valor_unitario) VALUES (:id,:nome,:qtd,:val)',
        { id: novoId, nome: it.nome, qtd: it.quantidade, val: it.valor_unitario });
    }
    return novoId;
  },

  // Catálogo de orçamento (tabela de preços + estoque com preço)
  getPrecos: () => all('SELECT * FROM tabela_precos ORDER BY nome'),
  getCatalogoOrcamento: () => all(`
    SELECT nome, valor_unitario, 'servico' AS origem FROM tabela_precos
    UNION ALL
    SELECT modelo AS nome, preco AS valor_unitario, 'estoque' AS origem
      FROM inventory WHERE preco > 0
    ORDER BY nome`),
  getOrcamentoItens: (orcamentoId) => all('SELECT * FROM orcamento_itens WHERE orcamento_id = :id', { id: orcamentoId }),
  saveOrcamento: async (id, responsavel, valorTotal, itens, dataInicio, dataFim, observacoes) => {
    await run('UPDATE quotes SET responsavel = :r, valor_total = :v, data_inicio = :di, data_fim = :df, observacoes = :obs WHERE id = :id',
      { r: responsavel, v: valorTotal, di: dataInicio || null, df: dataFim || null, obs: observacoes || null, id });
    await run('DELETE FROM orcamento_itens WHERE orcamento_id = :id', { id });
    for (const item of itens) {
      await run('INSERT INTO orcamento_itens (orcamento_id, nome, quantidade, valor_unitario) VALUES (:id, :nome, :qtd, :val)',
        { id, nome: item.nome, qtd: item.quantidade, val: item.valor_unitario });
    }
  },

  // Estoque
  insInv: (modelo, descricao, total, preco, numeroSerie) => run('INSERT INTO inventory (modelo, descricao, total, preco, numero_serie) VALUES (:m,:d,:t,:p,:ns)', { m: modelo, d: descricao, t: total, p: preco || 0, ns: numeroSerie || null }),
  updInv: (id, modelo, descricao, total, preco, numeroSerie) => run('UPDATE inventory SET modelo=:m, descricao=:d, total=:t, preco=:p, numero_serie=:ns WHERE id=:id', { id, m: modelo, d: descricao, t: total, p: preco || 0, ns: numeroSerie || null }),
  delInv: (id) => run('DELETE FROM inventory WHERE id = :id', { id }),
  getInv: (id) => one('SELECT * FROM inventory WHERE id = :id', { id }),
  inventoryView: () => all(`SELECT i.*, COALESCE((SELECT SUM(r.quantidade) FROM rentals r
      WHERE r.inventory_id = i.id AND r.status = 'ativa'), 0) AS locados
      FROM inventory i ORDER BY i.modelo`),
  sumActiveForModel: (id) => one("SELECT COALESCE(SUM(quantidade),0) AS s FROM rentals WHERE inventory_id = :id AND status = 'ativa'", { id }),

  // Locações
  insRental: (d) => run(`INSERT INTO rentals (inventory_id, empresa, contato, quantidade, data_inicio, data_prevista, obs)
                         VALUES (:inventory_id,:empresa,:contato,:quantidade,CURRENT_DATE,:data_prevista,:obs)`, d),
  activeRentals: () => all(`SELECT r.*, i.modelo FROM rentals r JOIN inventory i ON i.id = r.inventory_id
                            WHERE r.status = 'ativa' ORDER BY r.empresa, i.modelo`),
  historyRentals: () => all(`SELECT r.*, i.modelo FROM rentals r JOIN inventory i ON i.id = r.inventory_id
                             WHERE r.status = 'devolvida' ORDER BY r.created_at DESC`),
  returnRental: (id) => run("UPDATE rentals SET status = 'devolvida' WHERE id = :id", { id }),
  delRental: (id) => run('DELETE FROM rentals WHERE id = :id', { id }),

  // Contratos
  insContract: (d) => run(`INSERT INTO contracts (quote_id, empresa, contato, email, servico, valor, data_inicio, data_vencimento, obs)
                            VALUES (:quote_id,:empresa,:contato,:email,:servico,:valor,:data_inicio,:data_vencimento,:obs) RETURNING id`, d),
  listContracts: () => all(`SELECT * FROM contracts ORDER BY
                            CASE status WHEN 'ativo' THEN 0 ELSE 1 END,
                            (data_vencimento IS NULL), data_vencimento ASC, id DESC`),
  getContract: (id) => one('SELECT * FROM contracts WHERE id = :id', { id }),
  updateContract: (d) => run(`UPDATE contracts SET empresa=:empresa, contato=:contato, email=:email,
                              servico=:servico, valor=:valor, data_inicio=:data_inicio,
                              data_vencimento=:data_vencimento, data_pagamento=:data_pagamento, status=:status, obs=:obs WHERE id=:id`, d),
  delContract: (id) => run('DELETE FROM contracts WHERE id = :id', { id }),

  // Clientes — cadastro alimentado pelas informações preenchidas nos orçamentos.
  listClientes: () => all(`SELECT c.*,
      (SELECT COUNT(*) FROM quotes q WHERE (c.cnpj IS NOT NULL AND c.cnpj <> '' AND q.cnpj = c.cnpj)
                                        OR ((c.cnpj IS NULL OR c.cnpj = '') AND q.email = c.email)) AS orcamentos
      FROM clientes c ORDER BY COALESCE(NULLIF(c.empresa,''), c.nome)`),
  getCliente: (id) => one('SELECT * FROM clientes WHERE id = :id', { id }),
  quotesByCliente: (c) => all(`SELECT * FROM quotes
      WHERE (:cnpj <> '' AND cnpj = :cnpj) OR (:cnpj = '' AND email = :email)
      ORDER BY created_at DESC, id DESC`, { cnpj: c.cnpj || '', email: c.email || '' }),
  updateCliente: (d) => run(`UPDATE clientes SET cnpj=:cnpj, empresa=:empresa, nome=:nome, email=:email,
      telefone=:telefone, endereco=:endereco, obs=:obs, updated_at=now() WHERE id=:id`, d),
  delCliente: (id) => run('DELETE FROM clientes WHERE id = :id', { id }),
  // Cria ou atualiza um cliente a partir dos dados de um orçamento.
  // Casa por CNPJ/CPF quando houver documento; senão, por e-mail. Só sobrescreve campos com valor.
  upsertCliente: async (d) => {
    const cnpj = (d.cnpj || '').trim();
    const email = (d.email || '').trim();
    let existente = null;
    if (cnpj) existente = await one('SELECT * FROM clientes WHERE cnpj = :cnpj', { cnpj });
    if (!existente && email) existente = await one("SELECT * FROM clientes WHERE (cnpj IS NULL OR cnpj = '') AND email = :email", { email });
    if (existente) {
      await run(`UPDATE clientes SET
          cnpj     = COALESCE(NULLIF(:cnpj,''), cnpj),
          empresa  = COALESCE(NULLIF(:empresa,''), empresa),
          nome     = COALESCE(NULLIF(:nome,''), nome),
          email    = COALESCE(NULLIF(:email,''), email),
          telefone = COALESCE(NULLIF(:telefone,''), telefone),
          endereco = COALESCE(NULLIF(:endereco,''), endereco),
          updated_at = now()
        WHERE id = :id`,
        { id: existente.id, cnpj, empresa: d.empresa || '', nome: d.nome || '',
          email, telefone: d.telefone || '', endereco: d.endereco || '' });
      return existente.id;
    }
    const r = await run(`INSERT INTO clientes (cnpj, empresa, nome, email, telefone, endereco)
        VALUES (:cnpj,:empresa,:nome,:email,:telefone,:endereco) RETURNING id`,
      { cnpj: cnpj || null, empresa: d.empresa || null, nome: d.nome || null,
        email: email || null, telefone: d.telefone || null, endereco: d.endereco || null });
    return r.insertId;
  },
};

module.exports = { pool, init, seed, all, one, run, repo };
