# Vigilante Free — Site + Painel de Gestão

Site institucional com formulário de orçamento funcional + painel administrativo (login protegido) para:

- **Orçamentos** — as solicitações do formulário do site caem no banco; dá para ver detalhes, mudar status e **gerar PDF** de cada pedido.
- **Protocolos / Contratos** — orçamentos aceitos viram contratação, com **início** e **data de vencimento**. O painel destaca contratos **vencidos** e **vencendo em até 30 dias** para ajudar na cobrança e renovação.
- **Estoque & Locação** — cadastro de modelos de aparelho (rádios HT) com quantidade total, e registro de **locações**: quantos aparelhos estão com cada empresa. O "em estoque" é calculado automaticamente (total − locados).

O site tem um botão **"Entrar"** no topo que leva ao painel (`/admin`).

## Stack
Node.js + Express · SQLite (arquivo, via `better-sqlite3`) · sessões (`express-session` + `connect-sqlite3`) · senhas com `bcryptjs` · PDF com `pdfkit` · views em EJS.

## Como rodar

```bash
npm install
npm start
```

Depois abra:
- Site: **http://localhost:3000**
- Painel: **http://localhost:3000/admin**

Na primeira execução é criado um usuário administrador e dados de exemplo de estoque. O login aparece no terminal:

```
login: admin   senha: admin123
```

> Troque a senha o quanto antes. Você pode definir outro login/senha antes do primeiro start com variáveis de ambiente:
> `ADMIN_USER`, `ADMIN_PASS`. Também dá para definir `PORT`, `SESSION_SECRET`.

## Estrutura
```
server.js            rotas (site, login, painel)
db.js                banco SQLite + schema + seed
lib/pdf.js           geração do PDF do orçamento
views/               telas do painel (EJS)
public/index.html    o site (v10) com o formulário ligado ao backend
public/admin.css     estilo do painel
data/                banco e sessões (criado ao rodar; não versionar)
```

## O que já funciona
- Formulário público → salva no banco → página de agradecimento.
- Botão "Entrar" no site → login do painel.
- Login/logout com sessão; todas as rotas `/admin/*` exigem autenticação.
- Lista/filtro/detalhe de orçamentos, mudança de status, exclusão, PDF por pedido.
- Protocolos: criar contrato a partir de um orçamento aceito (ou manualmente),
  editar valor/início/vencimento/status, filtros por situação e destaque de
  vencidos e vencendo em 30 dias no painel.
- Estoque: cadastrar modelo, registrar locação (com checagem de disponibilidade),
  marcar devolução (aparelhos voltam ao estoque), histórico.

## Antes de colocar em produção
- Trocar a senha padrão e definir `SESSION_SECRET` forte.
- Servir atrás de HTTPS e marcar o cookie como `secure`.
- Adicionar proteção CSRF nos formulários e rate-limit no login.
- Fazer backup do arquivo `data/vigilante.db`.
```
