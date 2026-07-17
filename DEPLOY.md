# Publicar o Vigilante Free (Supabase + GitHub + Render)

O app foi migrado de MySQL para **PostgreSQL (Supabase)**. Ele cria as tabelas e o
usuário admin sozinho na primeira vez que sobe. Siga as 3 partes abaixo.

---

## Parte 1 — Banco de dados no Supabase

1. Crie conta em https://supabase.com e clique em **New project**.
2. Defina uma **senha do banco** (guarde bem) e escolha a região **South America (São Paulo)**.
3. Espere o projeto provisionar. No topo, clique em **Connect**.
4. Na janela, escolha a aba **Session pooler** (recomendado para o Render, que é um
   servidor sempre ligado) e copie a string. Ela tem este formato:
   ```
   postgresql://postgres.SEU_REF:[SUA-SENHA]@aws-0-sa-east-1.pooler.supabase.com:5432/postgres
   ```
   Troque `[SUA-SENHA]` pela senha do passo 2. **Essa string é o seu `DATABASE_URL`.**

> As tabelas são criadas automaticamente pelo app. (Se quiser criá-las à mão, há o
> arquivo `schema.sql` — cole no **SQL Editor** do Supabase. É opcional.)

---

## Parte 2 — Publicar no GitHub

O projeto já tem `.gitignore` configurado (não sobe `node_modules` nem `.env`).

**Pelo terminal**, dentro da pasta do projeto:
```bash
git init
git add .
git commit -m "Vigilante Free - versao inicial"
```
Crie um repositório **vazio** em https://github.com/new (pode ser privado). Depois:
```bash
git remote add origin https://github.com/SEU_USUARIO/vigilante-free.git
git branch -M main
git push -u origin main
```
> Prefere sem terminal? Instale o **GitHub Desktop**, clique em *Add Local Repository*,
> aponte para a pasta e use *Publish repository*.

⚠️ **Nunca** suba o arquivo `.env` (com senhas). O `.gitignore` já bloqueia isso.

---

## Parte 3 — Publicar no Render

1. Crie conta em https://render.com (pode entrar com o GitHub).
2. **New +** → **Web Service** → conecte seu repositório do GitHub.
3. Configure:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free
4. Em **Environment**, adicione as variáveis (aba *Environment* → *Add Environment Variable*):
   | Chave | Valor |
   |-------|-------|
   | `DATABASE_URL` | a string do Supabase (Parte 1) |
   | `SESSION_SECRET` | um valor aleatório longo* |
   | `ADMIN_USER` | o login do painel (ex.: `admin`) |
   | `ADMIN_PASS` | **uma senha forte sua** |
   | `NODE_ENV` | `production` |

   \* Gere um segredo com: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
5. Clique em **Create Web Service**. O Render instala, sobe o app e cria as tabelas.
   Em ~1–2 min você recebe uma URL `https://vigilante-free.onrender.com`.
6. Acesse `SUA_URL/admin` e entre com o `ADMIN_USER` / `ADMIN_PASS` que você definiu.

> **Deploys automáticos:** cada `git push` para a branch `main` re-publica sozinho.

---

## Observações importantes

- **Senha do admin:** o login padrão só é criado se ainda não existir usuário. Defina
  `ADMIN_PASS` ANTES do primeiro deploy para já nascer com senha forte. (Se subir com a
  padrão, troque depois direto no banco.)
- **Plano Free do Render:** o serviço "dorme" após ~15 min sem acesso e demora alguns
  segundos para acordar no primeiro acesso. Para produção séria, o plano pago evita isso.
- **Sessão de login:** fica salva no próprio Postgres (tabela `session`), então o login
  não cai quando o Render reinicia/re-publica.
- **Rodar localmente:** crie um arquivo `.env` (copie de `.env.example`) com o
  `DATABASE_URL` do Supabase e rode `npm install` e depois `npm start`.

---

## O que mudou nesta migração (resumo técnico)

- `db.js` reescrito de `mysql2` para `pg` (PostgreSQL), com um adaptador que converte os
  placeholders `:nome` em `$1, $2...` — o resto do código continua igual.
- Tipos convertidos (`SERIAL`, `TIMESTAMPTZ`, `NUMERIC`), datas retornam como texto.
- Sessão passou a ser gravada no Postgres (`connect-pg-simple`).
- `package.json`: saiu `mysql2`, entraram `pg` e `connect-pg-simple`.
- Novos arquivos: `.gitignore`, `.env.example`, `schema.sql`, `render.yaml`, `DEPLOY.md`.
