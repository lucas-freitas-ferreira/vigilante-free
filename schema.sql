-- schema.sql — estrutura do banco no Supabase (PostgreSQL).
-- OBS.: o app cria estas tabelas sozinho ao iniciar. Este arquivo é opcional,
-- útil se você quiser criar tudo manualmente no SQL Editor do Supabase.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(191) NOT NULL UNIQUE,
  nome          VARCHAR(191),
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quotes (
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
  data_inicio  DATE,
  data_fim     DATE,
  cnpj         VARCHAR(18),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tabela_precos (
  id             SERIAL PRIMARY KEY,
  nome           VARCHAR(191) NOT NULL,
  valor_unitario NUMERIC(12,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS orcamento_itens (
  id             SERIAL PRIMARY KEY,
  orcamento_id   INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  nome           VARCHAR(191) NOT NULL,
  quantidade     INTEGER NOT NULL,
  valor_unitario NUMERIC(12,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory (
  id         SERIAL PRIMARY KEY,
  modelo     VARCHAR(191) NOT NULL,
  descricao  VARCHAR(255),
  total      INTEGER NOT NULL DEFAULT 0,
  preco      NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rentals (
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
);

CREATE TABLE IF NOT EXISTS contracts (
  id              SERIAL PRIMARY KEY,
  quote_id        INTEGER REFERENCES quotes(id) ON DELETE SET NULL,
  empresa         VARCHAR(191) NOT NULL,
  contato         VARCHAR(191),
  email           VARCHAR(191),
  servico         VARCHAR(120),
  valor           NUMERIC(12,2),
  data_inicio     DATE NOT NULL,
  data_vencimento DATE,
  status          VARCHAR(20) NOT NULL DEFAULT 'ativo',
  obs             TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
