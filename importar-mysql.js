// importar-mysql.js — copia os dados do seu MySQL (XAMPP) para o Supabase (Postgres).
// Rode UMA vez, na sua máquina, com o MySQL (XAMPP) ligado e o DATABASE_URL do Supabase.
//
//   npm install mysql2            (só para esta importação)
//   set DATABASE_URL=...          (a string do Supabase)
//   node importar-mysql.js
//
const mysql = require('mysql2/promise');
const { init, pool } = require('./db'); // usa a conexão Postgres/Supabase já configurada

const MYSQL = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'vigilante_free',
  dateStrings: true,
};

// Ordem respeita as chaves estrangeiras (tabelas "pai" antes das "filhas").
const TABELAS = ['users', 'quotes', 'tabela_precos', 'inventory', 'orcamento_itens', 'rentals', 'contracts'];

(async () => {
  console.log('→ Garantindo o schema no Supabase...');
  await init(); // cria as tabelas no Supabase se ainda não existirem

  console.log('→ Conectando no MySQL local...');
  const my = await mysql.createConnection(MYSQL);

  for (const t of TABELAS) {
    let rows;
    try { [rows] = await my.query('SELECT * FROM `' + t + '`'); }
    catch (e) { console.log(`- ${t}: pulada (${e.code || e.message})`); continue; }
    if (!rows.length) { console.log(`- ${t}: 0 linhas`); continue; }

    const cols = Object.keys(rows[0]);
    let ok = 0;
    for (const r of rows) {
      const vals = cols.map((c) => r[c]);
      const ph = cols.map((_, i) => '$' + (i + 1)).join(',');
      // ON CONFLICT DO NOTHING evita erro se a linha já existir (ex.: admin do seed)
      const res = await pool.query(
        `INSERT INTO ${t} (${cols.map((c) => '"' + c + '"').join(',')}) VALUES (${ph}) ON CONFLICT DO NOTHING`,
        vals
      );
      ok += res.rowCount;
    }
    // Reajusta a sequência do id para os próximos cadastros não colidirem.
    await pool.query(
      `SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 1), true)`
    );
    console.log(`✓ ${t}: ${ok} de ${rows.length} linha(s) importada(s)`);
  }

  await my.end();
  await pool.end();
  console.log('\n✔ Importação concluída.');
})().catch((e) => { console.error('✗ Erro na importação:', e.message); process.exit(1); });
