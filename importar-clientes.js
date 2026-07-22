// importar-clientes.js — Importa clientes do arquivo locacao_clientes.json para o banco (tabela clientes).
// Uso: node importar-clientes.js
// O script faz upsert por CNPJ/CPF: se o documento já existe no cadastro, atualiza; senão, insere.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { init, repo, one, run } = require('./db');

const FILE = path.join(__dirname, 'locacao_clientes.json');

async function importar() {
  await init();
  const dados = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  let inseridos = 0, atualizados = 0, erros = 0;

  for (const d of dados) {
    try {
      const cnpj = (d.documento_numero_limpo || '').trim();
      const empresa = (d.razao_social || '').trim();
      const nome = (d.nome_cliente_apelido || d.responsavel || '').trim();
      const email = (d.emails && d.emails.length) ? d.emails[0].trim() : '';
      const telefone = (d.telefones && d.telefones.length) ? d.telefones[0] : '';
      const local = (d.local || '').trim();
      const tipoUso = (d.tipo_uso || '').trim();
      const obs = [
        tipoUso ? 'Tipo: ' + tipoUso : '',
        local ? 'Local: ' + local : '',
        d.modelo_equipamento ? 'Equip.: ' + d.modelo_equipamento : '',
        d.observacoes || '',
        d.observacao_extra || '',
      ].filter(Boolean).join(' | ');

      // Verifica se já existe pelo CNPJ/CPF
      let existente = null;
      if (cnpj) {
        existente = await one('SELECT * FROM clientes WHERE cnpj = :cnpj', { cnpj });
      }
      if (!existente && email) {
        existente = await one("SELECT * FROM clientes WHERE (cnpj IS NULL OR cnpj = '') AND email = :email", { email });
      }

      if (existente) {
        await run(`UPDATE clientes SET
            cnpj     = COALESCE(NULLIF(:cnpj,''), cnpj),
            empresa  = COALESCE(NULLIF(:empresa,''), empresa),
            nome     = COALESCE(NULLIF(:nome,''), nome),
            email    = COALESCE(NULLIF(:email,''), email),
            telefone = COALESCE(NULLIF(:telefone,''), telefone),
            endereco = COALESCE(NULLIF(:endereco,''), endereco),
            obs      = COALESCE(NULLIF(:obs,''), obs),
            updated_at = now()
          WHERE id = :id`,
          { id: existente.id, cnpj, empresa, nome, email, telefone, endereco: local, obs });
        atualizados++;
        console.log(`  ✓ Atualizado: ${empresa || nome} (${cnpj || 'sem doc'})`);
      } else {
        await run(`INSERT INTO clientes (cnpj, empresa, nome, email, telefone, endereco, obs)
            VALUES (:cnpj,:empresa,:nome,:email,:telefone,:endereco,:obs) RETURNING id`,
          { cnpj: cnpj || null, empresa: empresa || null, nome: nome || null,
            email: email || null, telefone: telefone || null, endereco: local || null, obs: obs || null });
        inseridos++;
        console.log(`  + Inserido:   ${empresa || nome} (${cnpj || 'sem doc'})`);
      }
    } catch (e) {
      erros++;
      console.error(`  ✗ Erro no registro ${d.numero_registro}: ${e.message}`);
    }
  }

  console.log(`\n  Concluído: ${inseridos} inseridos, ${atualizados} atualizados, ${erros} erros.`);
  process.exit(0);
}

importar().catch(e => { console.error('Erro fatal:', e); process.exit(1); });
