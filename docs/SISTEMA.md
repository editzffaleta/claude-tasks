# Quadro de Tarefas — Documentação do sistema

> Versão 5 do esquema de dados · MCP 4.2.0 com 36 ferramentas · Node 22.13+ · sem dependências obrigatórias

Este documento descreve o sistema inteiro: o que ele faz, como está organizado, como instalar e operar (inclusive no Docker), como usar cada tela, as regras de negócio, as permissões, o modelo de dados, a API REST e a segurança. A referência completa do servidor MCP (as ferramentas que o Claude usa) está em [MCP.md](MCP.md), e o guia do Mapa do código (o mapa interativo do código de cada projeto) está em [MAPA.md](MAPA.md). A referência interativa da API REST fica no próprio painel, em `/docs/api`.

## Sumário

1. [Visão geral](#1-visão-geral)
2. [Arquitetura](#2-arquitetura)
3. [Instalação e operação](#3-instalação-e-operação)
4. [Conceitos](#4-conceitos)
5. [Guia do painel](#5-guia-do-painel)
6. [Automações](#6-automações)
7. [Notificações](#7-notificações)
8. [Usuários, papéis e permissões](#8-usuários-papéis-e-permissões)
9. [E-mail](#9-e-mail)
10. [Importação e exportação](#10-importação-e-exportação)
11. [Integração com o Claude](#11-integração-com-o-claude), inclusive o [Mapa do código](#115-mapa-do-código)
12. [Modelo de dados](#12-modelo-de-dados)
13. [Migrações e backups](#13-migrações-e-backups)
14. [API REST](#14-api-rest)
15. [Segurança](#15-segurança)
16. [Desenvolvimento e testes](#16-desenvolvimento-e-testes)
17. [Solução de problemas](#17-solução-de-problemas)
18. [Limitações conhecidas](#18-limitações-conhecidas)

---

## 1. Visão geral

O Quadro de Tarefas é um gerenciador de projetos **central**: um único quadro com as pendências de todos os seus projetos. A ideia central é que **o Claude alimenta o quadro sozinho**. Em qualquer sessão do Claude Code, quando um trabalho deixa algo para depois, o Claude registra a tarefa no projeto certo. Você e a equipe acompanham, organizam e priorizam pelo painel web.

Ele foi inspirado no [Taskosaur](https://github.com/taskosaur/taskosaur) e hoje tem paridade com ele nas funções de gestão (organizações, workspaces, papéis, workflows, campos personalizados, e-mail, importação), com estas diferenças de propósito:

| | Taskosaur | Quadro de Tarefas |
| --- | --- | --- |
| Infraestrutura | NestJS + Next.js + PostgreSQL + Redis (Docker) | Node puro + SQLite embutido, sem dependências obrigatórias; launchd no Mac ou Docker |
| IA | Chat no app com chave de API própria | O Claude Code usa o quadro via MCP em qualquer projeto; o chat do painel usa a sua assinatura (CLI) ou uma chave de API (Anthropic ou compatível com OpenAI) |
| Origem das tarefas | Cadastradas no app | Registradas pelo Claude enquanto trabalha, cadastradas no painel, recebidas por e-mail ou importadas (CSV, Jira, Trello) |
| Projeto | Criado no app | Detectado pela pasta git em que o Claude está, ou criado no painel |

### Principais capacidades

- **Estrutura:** organizações → workspaces aninháveis → projetos, com papéis (dono, gerente, membro, visualizador) em cada nível e visibilidade privada, interna ou pública.
- **Visões:** quadro kanban, lista (com ações em lote), calendário, Gantt (com tipos de dependência), dashboard (indicadores, portfólio, carga, alocação, burndown, velocidade e mais) e página de atividade.
- **Planejamento:** prazos, datas de início, subtarefas, dependências FS/SS/FF/SF, sprints (com cancelamento, burndown e velocidade), recorrência avançada, story points e estimativa original/restante.
- **Fluxo:** colunas por projeto, transições permitidas entre colunas e modelos de workflow reaproveitáveis.
- **Dados da tarefa:** 5 prioridades, tipos, labels coloridas, campos personalizados, relator, observadores, código por projeto (`WEB-12`), anexos, tempo.
- **Colaboração:** comentários em conversa com @menções, notificações por tipo e canal (painel, e-mail, macOS), links públicos de leitura.
- **E-mail:** SMTP para convites, senha, notificações e automações; caixa de entrada IMAP por projeto que transforma e-mails em tarefas.
- **Automação:** regras "quando X → faça Y" com 11 gatilhos e 12 ações, inclusive enviar e-mail e mover de sprint.
- **IA:** MCP com 36 ferramentas, resources e 9 prompts; chat no painel com três provedores.
- **Mapa do código:** plugin para Claude Code e Codex que desenha um mapa interativo do código de cada projeto, com verificação de saúde, telas, fluxos e trabalho recente; o quadro mostra o mapa numa aba, liga as tarefas aos arquivos e cria tarefas a partir dele. A **Simulação** leva o sistema do mapa ao simulador Breakscale e mostra onde ele quebra quando o tráfego sobe, com cada gargalo virando tarefa ([MAPA.md](MAPA.md)).
- **Operação:** tempo real (SSE), busca universal ⌘K, 5 idiomas, painel de administração com backups, API REST documentada em OpenAPI 3.1, Docker e CI.

---

## 2. Arquitetura

### 2.1 Componentes

```
┌──────────────────────────┐   stdio (JSON-RPC)   ┌────────────────────────┐
│ Sessão do Claude Code    │ ───────────────────▶ │ src/mcp.js             │──┐
│ (um processo MCP por     │                      │ ferramentas, resources │  │
│  sessão aberta)          │                      │ prompts, completions   │  │
└──────────────────────────┘                      └────────────────────────┘  │
                                                                              │  node:sqlite
┌──────────────────────────┐   HTTP + cookie      ┌────────────────────────┐  │  (modo WAL)
│ Navegador                │ ───────────────────▶ │ src/server.js          │──┼──▶ data/tasks.db
│ public/ (SPA sem build)  │ ◀── SSE /api/events ─│ API REST + estáticos   │  │    data/attachments/
└──────────────────────────┘    (ou polling 3 s)  │ tempo real (SSE)       │  │    data/avatars/
                                                  │ agendador (60 s)       │  │    data/secret.key
┌──────────────────────────┐                      │ chat (CLI ou API)      │──┘
│ Link público /s/<token>  │ ───── sem login ───▶ │                        │
└──────────────────────────┘                      └───────────┬────────────┘
                                                              │
                     SMTP (envio) · IMAP (caixas de entrada) · Jira/Trello (importação)
                     · API da Anthropic ou compatível com OpenAI (chat)

Hook SessionStart (bin/session-start.js) ── lê o banco e injeta as pendências no início da sessão
```

- **Banco único.** Todos os processos abrem o mesmo arquivo SQLite em modo WAL, com `busy_timeout` de 5 s e chaves estrangeiras ligadas. Várias sessões do Claude e o painel gravam ao mesmo tempo.
- **Sem servidor obrigatório para o Claude.** O MCP grava direto no banco. O servidor do painel é necessário para visualizar e para o que é agendado: avisos de prazo, automações por tempo e sincronização das caixas de entrada.
- **Motor de regras em todo processo.** Automações e notificações são ligadas por `attachEngine(store)` tanto no MCP quanto no servidor. Uma mudança feita pelo Claude também dispara as regras e as notificações.
- **Front-end sem build.** O painel é feito de módulos JS nativos. As páginas maiores (dashboard, atividade, administração etc.) são carregadas sob demanda.
- **Mapa do código.** O servidor também atende `/mapa/<id>/`, onde serve o mapa gerado na pasta do projeto com o núcleo do servidor do próprio plugin (ver [seção 11.5](#115-mapa-do-código)).

### 2.2 Tecnologias

| Camada | Escolha | Por quê |
| --- | --- | --- |
| Runtime | Node 22.13+ (ES modules) | Traz `node:sqlite` e `node:test`; a CI testa no Node 22 e 24 |
| Banco | SQLite via `node:sqlite` (WAL) | Arquivo único, multiprocesso, zero dependência |
| Servidor HTTP | `node:http` | Simples; sem framework |
| Tempo real | Server-Sent Events, com polling de reserva | Funciona atrás de proxies comuns; sem WebSocket |
| Front-end | HTML + CSS + JS modules nativos | Sem etapa de build |
| MCP | JSON-RPC sobre stdio, implementado à mão | Sem SDK; controle total do protocolo |
| E-mail | Clientes SMTP, IMAP e MIME próprios (`src/mail/`) | Sem dependências; TLS direto ou STARTTLS |
| Segredos | AES-256-GCM com chave em `data/secret.key` | Senhas e chaves fora do banco em texto puro |
| Senhas | `crypto.scrypt` + `timingSafeEqual` | Nativo do Node |
| Chat por API | `@anthropic-ai/sdk` (dependência **opcional**) ou `fetch` (compatível com OpenAI) | Só é necessário para o provedor `anthropic` |
| Serviço | launchd (LaunchAgent) ou Docker | Inicia sozinho e reinicia se cair |
| API | OpenAPI 3.1 gerado em `src/openapi.js` | Documentação navegável em `/docs/api` |

### 2.3 Estrutura de pastas

```
claude-tasks/
├── .claude-plugin/marketplace.json   este repositório como marketplace do Claude Code (claude-tasks)
├── .agents/plugins/marketplace.json  o mesmo marketplace para o Codex
├── .github/workflows/ci.yml  testes (Node 22 e 24), sintaxe do painel, build e teste do contêiner
├── bin/
│   ├── service.sh            instala/remove o LaunchAgent do painel
│   └── session-start.js      hook SessionStart do Claude Code
├── docs/
│   ├── SISTEMA.md            este documento
│   ├── MCP.md                referência do servidor MCP
│   └── MAPA.md               guia do Mapa do código
├── mapa/                     plugin Mapa do código (Claude Code e Codex), port do Floorplan 0.6.0
│   ├── .claude-plugin/plugin.json · .codex-plugin/plugin.json   manifestos do plugin
│   ├── LICENSE · AVISO.md    licença MIT do original e aviso da adaptação
│   ├── skills/mapa-do-codigo/
│   │   ├── SKILL.md          o roteiro que o Claude e o Codex seguem
│   │   ├── scripts/          Node sem dependências: varredura, montagem, descrições,
│   │   │                     atualização, plantas, trabalho recente, abrir
│   │   ├── assets/           visualizador, servidor e consulta copiados para cada projeto;
│   │   │                     vendor/ com o elkjs e as fontes
│   │   └── referencias/      formatos e guias de escrita que a IA lê
│   └── test/                 testes do plugin (rodam no npm test)
├── public/                   painel (servido como arquivos estáticos)
│   ├── index.html            casca do painel
│   ├── share.html            página do link público (/s/<token>)
│   ├── api-docs.html         visualizador da API (/docs/api)
│   ├── styles.css            tema claro/escuro e componentes base
│   ├── css/                  app.css, dashboard.css, project-settings.css, pages.css
│   └── js/
│       ├── main.js           boot, idioma e tema, rotas entre visões, atalhos, tempo real
│       ├── state.js          estado, rota na URL, filtros, permissões no cliente, SSE/polling
│       ├── api.js            fetch, upload, streaming NDJSON, toasts
│       ├── i18n.js           idiomas: t() e tn(); dicionários em i18n/<idioma>.js
│       ├── util.js           datas, durações, markdown, ícones, cores, rótulos
│       ├── ui.js             diálogos, confirmações, menus flutuantes
│       ├── editor.js         barra de formatação Markdown e autocompletar de @menções
│       ├── shell.js          barra lateral, cabeçalho, abas, filtros, notificações, timer
│       ├── palette.js        paleta de comandos e busca universal (⌘K)
│       ├── auth.js           primeiro acesso, login, convite, esqueci e redefinir senha
│       ├── board.js          visão Quadro (kanban)
│       ├── list.js           visão Lista (ordenar, agrupar, ações em lote)
│       ├── calendar.js       visão Calendário
│       ├── gantt.js          visão Gantt
│       ├── dashboard.js      Dashboard (indicadores e gráficos)
│       ├── activity.js       página Atividade
│       ├── drawer.js         detalhe da tarefa
│       ├── taskform.js       diálogo de nova tarefa
│       ├── triage.js         triagem guiada das tarefas novas
│       ├── sprints.js        gerenciador de sprints
│       ├── projectsettings.js configurações do projeto
│       ├── organizations.js  organizações, workspaces e papéis
│       ├── automations.js    página de automações
│       ├── team.js           páginas Equipe e Minha conta
│       ├── settings.js       configurações gerais
│       ├── admin.js          página Administração
│       ├── share.js          página pública de leitura
│       ├── mapa.js           aba Mapa do código
│       └── chat.js           chat com o Claude
├── src/
│   ├── db.js                 Store: esquema, migrações, projetos, colunas, transições, sprints,
│   │                         tarefas, comentários, dependências, recorrência
│   ├── util.js               validação, datas, durações, recorrência, constantes e rótulos
│   ├── secret.js             cifra AES-256-GCM (chave em data/secret.key)
│   ├── store/
│   │   ├── team.js           usuários, sessões, convites, senha, preferências, avatares,
│   │   │                     responsáveis, notificações
│   │   ├── org.js            organizações, workspaces, membros, permissões, links públicos,
│   │   │                     comandos para o painel
│   │   ├── meta.js           labels, campos personalizados, observadores, workflows, busca
│   │   ├── work.js           tempo (timer e lançamentos) e anexos
│   │   └── insights.js       configurações, dashboard, relatório de tempo, atividade,
│   │                         automações (cadastro), chat
│   ├── engine.js             motor de automações, notificações (painel, macOS, e-mail) e tick
│   ├── mailer.js             envio de e-mail: layout HTML, envio em segundo plano, teste
│   ├── mail/
│   │   ├── smtp.js           cliente SMTP (TLS direto ou STARTTLS, AUTH PLAIN/LOGIN)
│   │   ├── imap.js           cliente IMAP (busca não lidas)
│   │   └── mime.js           monta e lê mensagens MIME
│   ├── inbox.js              caixa de entrada por projeto (e-mail → tarefa)
│   ├── importers.js          CSV, Jira (CSV e API), Trello (JSON e API), sincronizações
│   ├── chat.js               chat do painel: claude-cli, anthropic, openai
│   ├── mapa.js               Mapa do código no quadro: rota /mapa/<id>/, situação, tarefas
│   │                         ligadas aos arquivos, tarefas criadas pelo mapa, consulta
│   ├── openapi.js            documento OpenAPI 3.1 (/api/openapi.json)
│   ├── routes.js             rotas da API REST e guardas de permissão
│   ├── server.js             HTTP: Host/Origin, cookies, SSE, estáticos, agendador
│   ├── mcp.js                servidor MCP (protocolo e instructions)
│   └── mcp/
│       ├── context.js        store do MCP, "eu", permissões (ENFORCE), formatadores
│       ├── tools.js          24 ferramentas originais (ampliadas)
│       ├── tools-extra.js    11 ferramentas da paridade com o Taskosaur e a code_map
│       ├── resources.js      resources e templates
│       └── prompts.js        prompts e autocompletar
├── test/
│   ├── api.test.js           sobe o servidor real e testa a API
│   ├── mcp.test.js           conversa com o MCP real via stdio
│   ├── mail.test.js          SMTP, IMAP e MIME contra servidores falsos
│   ├── permissions.test.js   papéis, visibilidade, links públicos, SSE, senha
│   ├── features.test.js      prefixos, prioridades, labels, campos, workflows, recorrência,
│   │                         importação, caixa de entrada, segredos, busca
│   └── mapa.test.js          Mapa do código no quadro: página, permissões, tarefas e consulta
├── Dockerfile · docker-compose.yml · .dockerignore
├── data/                     (ignorada pelo git) banco, anexos, avatares, secret.key, backups, log
├── package.json              scripts e a dependência opcional @anthropic-ai/sdk
└── package-lock.json
```

### 2.4 Camada de dados (`Store`)

`src/db.js` define a classe `Store`, que estende `EventEmitter`. Os métodos de `src/store/*.js` são adicionados por mixin (`Object.assign(Store.prototype, …)`).

- **Transações reentrantes.** `store.transaction(fn)` abre `BEGIN IMMEDIATE` só na chamada mais externa; chamadas aninhadas reutilizam a transação.
- **Eventos após o COMMIT.** As mutações enfileiram eventos com `queue()`, e eles só são emitidos depois que a transação externa confirma:

| Evento | Quando | Payload |
| --- | --- | --- |
| `task.created` | tarefa criada (inclusive por recorrência, e-mail ou importação) | `{ task, actor }` |
| `task.updated` | algum campo da tarefa mudou | `{ task, before, changes, actor }` |
| `task.commented` | comentário criado, ou editado com menções novas | `{ task, note, actor, mentions, edited? }` |
| `task.assigned` | pessoa adicionada como responsável | `{ task_id, user_id, actor }` |
| `sprint.started` | sprint iniciada | `{ sprint, actor }` |
| `sprint.completed` | sprint concluída (não dispara no cancelamento) | `{ sprint, moved, actor }` |
| `project.created` | projeto criado | `{ project, actor }` |
| `notification` | notificação entregue (emitido direto, não enfileirado) | `{ task_id, body, type, delivered }` |

- **Ator.** Toda gravação recebe quem fez: `{ author: 'claude' }`, `{ author: 'user', user_id }`, `{ author: 'automação' }`, `{ author: 'e-mail' }` (caixa de entrada), `{ author: 'ia' }` (chat com provedor compatível com OpenAI) ou, no legado, `'você'`. Esse valor alimenta o histórico, a origem da tarefa e a regra que evita cascata de automações.
- **Segredos.** `store.secret(texto)` cifra e `store.reveal(valor)` decifra com a chave de `secret.key`, na pasta do banco.

### 2.5 Tempo real

- **Servidor.** `GET /api/events` abre um fluxo SSE. A cada 700 ms o servidor compara `store.version()` — que junta o `PRAGMA data_version` do SQLite (muda quando **outro** processo grava, como o MCP) com um contador de gravações do próprio servidor — e avisa todas as abas abertas.
- **Eventos:** `hello` (`{ version, unread }`, na conexão), `change` (`{ version }`), `unread` (`{ unread }`) e `ui` (comando do Claude para abrir algo na tela, ver `show_in_dashboard` em [MCP.md](MCP.md)). Um comentário `: ping` sai a cada 25 s para manter a conexão, e o cabeçalho `x-accel-buffering: no` desliga o buffer do nginx.
- **Cliente.** Ao receber `change`, o painel recarrega `/api/state`. Se o SSE falhar 4 vezes seguidas, passa a consultar `/api/version` e `/api/ui-commands` a cada 3 s. O indicador "ao vivo" no rodapé da barra lateral vira "sem conexão" quando nada responde.
- **Comandos para o painel** (`ui_commands`) valem por 2 minutos e são entregues uma única vez, à primeira aba aberta da pessoa indicada (ou de qualquer pessoa, quando o comando não tem dono).
- **Edição em andamento.** As páginas com formulário (configurações, equipe, automações etc.) não são redesenhadas pelas atualizações ao vivo, e o detalhe da tarefa não apaga o que está sendo digitado.

---

## 3. Instalação e operação

### 3.1 Requisitos

- **Instalação nativa:** macOS para o serviço (launchd) e as notificações do sistema (`osascript`); o restante roda em qualquer sistema. Node.js 22.13 ou mais novo.
- **Docker:** qualquer sistema com Docker; a imagem usa `node:22-alpine`.
- **Claude Code (CLI):** para o MCP e para o chat do painel no provedor padrão (`claude-cli`).
- **Opcional:** servidor SMTP (e-mails), caixa IMAP (e-mail → tarefa), chave da API da Anthropic ou de um provedor compatível com OpenAI (chat sem a CLI).

### 3.2 Instalação no Mac (launchd)

```bash
# 1. MCP disponível em todos os projetos
claude mcp add --scope user tarefas -- "$(command -v node)" --no-warnings ~/Developer/claude-tasks/src/mcp.js

# 2. Painel sempre ligado (launchd)
~/Developer/claude-tasks/bin/service.sh install

# 3. (Opcional) SDK da Anthropic, só para o chat com chave de API
cd ~/Developer/claude-tasks && npm install
```

Depois:

1. **Instrução global.** Em `~/.claude/CLAUDE.md`, a seção "Quadro de tarefas" diz ao Claude para registrar pendências sozinho. Veja a [seção 11](#11-integração-com-o-claude).
2. **Primeiro acesso.** Abra http://localhost:4317 e crie a conta de administrador.
3. **Chat do painel (opcional).** Rode `claude` no Terminal e faça `/login`, ou configure outro provedor em Configurações → IA do chat.
4. **E-mail (opcional).** Configure o SMTP em Configurações → E-mail (veja a [seção 9](#9-e-mail)).
5. **Hook SessionStart (opcional).** Veja a [seção 11.3](#113-hook-sessionstart).

### 3.3 Serviço (launchd)

`bin/service.sh install` cria `~/Library/LaunchAgents/com.claude-tasks.dashboard.plist` com:

- `RunAtLoad`: inicia no login.
- `KeepAlive`: reinicia se o processo cair, com `ThrottleInterval` de 30 s.
- Saída e erros vão para `data/server.log`.
- O Node usado é o da variável `NODE` ou o primeiro `node` do `PATH`.

| Ação | Comando |
| --- | --- |
| Instalar / reinstalar | `bin/service.sh install` |
| Remover | `bin/service.sh uninstall` |
| Reiniciar (após atualizar o código) | `launchctl kickstart -k gui/$(id -u)/com.claude-tasks.dashboard` |
| Ver estado | `launchctl print gui/$(id -u)/com.claude-tasks.dashboard` |
| Ver log | `tail -f data/server.log` |

O `install` mata qualquer processo que já esteja ouvindo na porta antes de registrar o serviço.

**App para Mac.** `app/macos/build.sh --install` monta o **Quadro de Tarefas.app** (Swift, AppKit e WebKit, sem dependências) e o instala em `~/Applications`. O app abre o painel num `WKWebView` com armazenamento persistente (o login fica guardado, separado do navegador) e:

- antes de abrir, confere o painel (`GET /api/auth/me`; qualquer resposta HTTP conta). Sem resposta, roda `launchctl kickstart gui/<uid>/com.claude-tasks.dashboard`; se o serviço não está registrado, roda `bin/service.sh install` com o `NODE` e um `PATH` completo, e espera até 20 s;
- abre no navegador padrão os links de outros endereços, salva downloads em `~/Downloads` (respostas com `Content-Disposition: attachment` ou que o WebKit não exibe) e abre em nova janela os links do próprio quadro com `target="_blank"`;
- tem menus em português (Editar, Visualizar com `⌘R`, `⌘0`, `⌘+` e `⌘-`, Janela e Ajuda, com **Abrir o log do servidor**), sem usar as teclas dos atalhos do painel.

O `build.sh` grava no `Info.plist` o endereço do painel (`ClaudeTasksURL`, de `CLAUDE_TASKS_URL` ou `CLAUDE_TASKS_PORT`), a pasta do repositório (`ClaudeTasksRepo`) e o Node (`ClaudeTasksNode`), desenha o ícone (`app/macos/Icone/gerar-icone.swift`) e assina o app localmente (ad hoc). `CLAUDE_TASKS_URL` no ambiente do app passa por cima do `Info.plist`, e `QUADRO_FOTO=<arquivo.png>` (com `QUADRO_FOTO_SAIR=1`) salva uma foto da janela depois de abrir, para testes sem olhar a tela.

### 3.4 Docker

```bash
docker compose up -d        # http://localhost:4317
docker compose logs -f      # log do servidor
```

O que a imagem faz (`Dockerfile`):

- Parte de `node:22-alpine`, instala só a dependência opcional (`npm ci --omit=dev`, que traz o SDK da Anthropic) e copia `src/`, `public/` e `bin/`.
- Define `CLAUDE_TASKS_HOST=0.0.0.0`, `CLAUDE_TASKS_PORT=4317`, `CLAUDE_TASKS_DB=/data/tasks.db` e `CLAUDE_TASKS_NO_OS_NOTIFY=1`.
- Roda como o usuário `node`, com os dados no volume `/data` (banco, anexos, avatares, `secret.key` e backups).
- Tem `HEALTHCHECK` em `GET /api/auth/me` a cada 30 s.

O `docker-compose.yml` publica a porta 4317, reinicia sozinho (`unless-stopped`) e guarda os dados no volume nomeado `tarefas-data`. Ajustes comuns:

- **Outro endereço ou porta.** `CLAUDE_TASKS_HOSTS` precisa listar o `host:porta` que aparece na barra do navegador (ex.: `8080:4317` no mapeamento exige `localhost:8080`). Atrás de um proxy reverso que já valida o domínio, use `"*"`.
- **Links nos e-mails.** Preencha Configurações → Geral → Endereço público do painel.
- **Chat.** A CLI do Claude Code **não existe no contêiner**: escolha o provedor `anthropic` (chave da API) ou `openai` (OpenAI, OpenRouter, Ollama, LM Studio) em Configurações → IA do chat. No Docker Desktop, um Ollama rodando no Mac fica em `http://host.docker.internal:11434/v1`.
- **Notificações do macOS** não existem no contêiner; use o painel e o e-mail.

**Ligando o MCP ao painel em contêiner.** O MCP continua rodando onde o Claude Code roda e precisa abrir **o mesmo arquivo** de banco que o servidor. Há duas formas:

| | Como | Cuidados |
| --- | --- | --- |
| **1. MCP local, banco montado** | Troque o volume por uma pasta do host (`- ~/tarefas-data:/data`) e registre o MCP local com `-e CLAUDE_TASKS_DB=$HOME/tarefas-data/tasks.db`. | A pasta precisa ser gravável pelo usuário `node` do contêiner (uid 1000). Em **Linux** é seguro (mesmo kernel). No **Docker Desktop (Mac/Windows)** a pasta passa por uma camada de compartilhamento com a VM, e o SQLite em modo WAL depende de memória compartilhada entre processos: prefira a opção 2. |
| **2. MCP dentro do contêiner** | Registre como comando do MCP: `claude mcp add --scope user tarefas -- docker exec -i <contêiner> node --no-warnings src/mcp.js` (o nome aparece em `docker ps`; com o compose padrão é algo como `claude-tasks-tarefas-1`). | O contêiner não enxerga as pastas do Mac: a detecção da raiz git não funciona (cada `project_path` vira o próprio caminho), e `attach_file`, `export_tasks` e `import_tasks` leem e gravam caminhos **dentro** do contêiner. Para "eu", use `docker exec -i -e CLAUDE_TASKS_USER=voce@exemplo.com …`. |

O hook `bin/session-start.js` também precisa ler o banco: funciona direto na opção 1; na opção 2, rode-o com `docker exec -i <contêiner> node --no-warnings bin/session-start.js`.

### 3.5 Atualizar o sistema

1. Atualize o código (por exemplo, `git pull`) e, se usar o chat por API da Anthropic, `npm install`.
2. Reinicie o serviço com `launchctl kickstart -k …` (ou `docker compose up -d --build`). Se houver migração nova, ela roda nesse momento, com backup automático (veja a [seção 13](#13-migrações-e-backups)).
3. Sessões do Claude já abertas continuam com o MCP antigo até serem reabertas. Elas seguem funcionando com o banco novo, só que sem as ferramentas novas.

### 3.6 Variáveis de ambiente

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `CLAUDE_TASKS_DB` | `data/tasks.db` | Caminho do banco. Anexos (`attachments/`), avatares (`avatars/`), backups e `secret.key` ficam na mesma pasta. |
| `CLAUDE_TASKS_PORT` | `4317` | Porta do painel. Também compõe os links que o MCP devolve e o endereço padrão dos e-mails. |
| `CLAUDE_TASKS_HOST` | `127.0.0.1` | Interface onde o painel escuta. Use `0.0.0.0` para rede (a imagem Docker já usa). |
| `CLAUDE_TASKS_HOSTS` | — | Hosts extras aceitos nos cabeçalhos `Host`/`Origin`, separados por vírgula (ex.: `meumac.local:4317`). `*` aceita qualquer um: use só atrás de um proxy que já valida o domínio. |
| `CLAUDE_TASKS_NO_OS_NOTIFY` | — | Se definida, nunca mostra notificações do macOS (testes e Docker). |
| `CLAUDE_TASKS_USER` | — | (MCP) Quem é "eu" para o Claude: e-mail ou nome de um membro. |
| `CLAUDE_TASKS_ENFORCE` | — | (MCP) Se definida (ex.: `1`), as ferramentas respeitam as permissões de "eu". Sem ela, o MCP local tem acesso total. |
| `CLAUDE_TASKS_JIRA_HOSTS` | `*.atlassian.net` | Hosts permitidos na importação pela API do Jira, separados por vírgula. Aceita `*.dominio` e `*` (qualquer). |
| `CLAUDE_BIN` | `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude` ou `claude` | Caminho da CLI usada pelo chat no provedor `claude-cli`. |
| `NODE` | `command -v node` | (Só `bin/service.sh`) Node usado pelo LaunchAgent. |

### 3.7 Dados e backup

| Item | Local |
| --- | --- |
| Banco | `data/tasks.db` (mais `-wal` e `-shm` enquanto aberto) |
| Anexos | `data/attachments/<tarefa>-<timestamp>-<aleatório>.<ext>` |
| Avatares | `data/avatars/<user\|project\|organization>-<id>-<timestamp>.<ext>` |
| Chave dos segredos | `data/secret.key` (modo 0600) |
| Backups | `data/backup-v<versão>-<timestamp>.db` (migrações) e `data/backup-manual-<data>.db` (Administração) |
| Log do serviço | `data/server.log` |

> Guarde o `secret.key` junto com o banco. Sem ele, as senhas de SMTP e IMAP, as chaves de API e os tokens das sincronizações não podem ser lidos: o painel continua funcionando, mas esses segredos precisam ser preenchidos de novo (veja [Solução de problemas](#17-solução-de-problemas)).

**Backup pelo painel:** Administração → Backups → Criar backup agora (gera uma cópia consistente com `VACUUM INTO`); dá para baixar e excluir cada cópia.

**Backup manual com o sistema rodando:**

```bash
sqlite3 ~/Developer/claude-tasks/data/tasks.db ".backup '$HOME/backup-tarefas.db'"
tar czf ~/backup-arquivos.tgz -C ~/Developer/claude-tasks/data attachments avatars secret.key
```

**Restaurar:** pare o serviço (`bin/service.sh uninstall` ou `docker compose stop`), substitua `data/tasks.db` pelo backup, apague os arquivos `-wal`/`-shm`, devolva anexos, avatares e `secret.key` e inicie de novo.

### 3.8 Usar em equipe (rede)

Por padrão o painel só aceita conexões deste Mac. Para outras pessoas acessarem:

```bash
CLAUDE_TASKS_HOST=0.0.0.0 CLAUDE_TASKS_HOSTS=meumac.local:4317,192.168.0.10:4317 npm start
```

- Para deixar isso permanente no serviço, adicione um bloco `EnvironmentVariables` no plist gerado.
- Preencha **Configurações → Endereço público do painel** com o endereço que as pessoas usam: ele vai nos links de convites, e-mails e links públicos.
- Para acesso pela internet, use HTTPS (Tailscale, Cloudflare Tunnel ou um proxy reverso) em vez de expor a porta. Atrás de um proxy que repassa `X-Forwarded-Proto: https`, o cookie de sessão passa a ser `Secure`; se o proxy já valida o domínio, `CLAUDE_TASKS_HOSTS=*` evita listar cada nome.

---

## 4. Conceitos

### 4.1 Organizações, workspaces e projetos

```
Organização ──┬── Workspace "Geral"
              │      ├── Projeto A
              │      └── Workspace "Mobile" (aninhado)
              │             └── Projeto B
              └── Workspace "Clientes"
                     └── Projeto C
```

- **Organização:** nome, descrição, site, cor, imagem e arquivamento. Toda organização nasce com um workspace "Geral". O sistema mantém ao menos uma organização, e só exclui uma organização sem projetos (os workspaces e os papéis dela somem junto).
- **Workspace:** pertence a uma organização e pode ficar dentro de outro workspace da mesma organização (sem ciclos). Tem nome, descrição, cor, posição e arquivamento. Excluir um workspace sobe os projetos e sub-workspaces dele para o workspace de cima (ou para outro da organização) e apaga os papéis dados nele; o último workspace de uma organização com conteúdo não pode ser excluído.
- **Projeto:** fica num workspace. Projetos novos vão para o workspace escolhido ou, sem escolha, para o primeiro workspace ativo. Nas configurações do projeto dá para deixá-lo "Sem workspace"; aí ele não herda papéis de workspace nem de organização.
- **Na migração 3**, o quadro ganhou a organização "Minha organização" com o workspace "Geral", e todos os projetos existentes foram para lá.
- **Papéis em cascata:** um papel dado na organização ou num workspace vale para todos os projetos dentro dele, inclusive nos sub-workspaces (veja a [seção 8](#8-usuários-papéis-e-permissões)).

### 4.2 Projeto

- **Projeto de pasta.** É identificado pelo caminho da **raiz do repositório git** que contém o diretório de trabalho. Subpastas pertencem ao mesmo projeto. Worktrees (`.git` em arquivo apontando para `…/.git/worktrees/x`) são resolvidas para o repositório principal. Pastas sem git usam o próprio caminho.
- **Projeto sem pasta.** É criado pelo nome, pelo painel ou por `manage_project`/`project: "Nome"` no MCP. Por exemplo, "Pessoal".
- **Criação automática.** Quando o Claude registra a primeira tarefa numa pasta nova, o projeto é criado com o nome da pasta.
- **Ao criar**, o projeto recebe as colunas e transições do [workflow padrão](#44-status-colunas-e-workflows), se houver um. Quem cria pelo painel (sem ser administrador) vira **dono** do projeto.

| Campo | Descrição |
| --- | --- |
| Nome, descrição | Até 120 caracteres no nome |
| Cor e imagem | A cor aparece no quadro, no calendário e no Gantt. A imagem (PNG, JPEG, WebP ou GIF até 2 MB) substitui o selo colorido. |
| Prefixo (`key`) | 2 a 10 letras ou números, começando por letra (ex.: `WEB`). Único no quadro. Com prefixo, as tarefas ganham código `WEB-12`. |
| Status | `planning` (planejamento), `active` (ativo, padrão), `on_hold` (em espera), `completed` (concluído), `cancelled` (cancelado) |
| Prioridade | As mesmas 5 das tarefas; padrão `medium` |
| Início e fim | O fim não pode ser antes do início. O dashboard destaca projetos com fim vencido. |
| Workspace | Onde o projeto fica |
| Visibilidade | `private`, `internal` (padrão) ou `public` (ver 4.18) |
| Arquivado | Projetos arquivados vão para a seção "Arquivados" da barra lateral |

### 4.3 Tarefa

| Campo | Descrição |
| --- | --- |
| `id` | Número global e único (`#12`), igual em todos os projetos |
| `number` e código | Número sequencial dentro do projeto. Com prefixo, o código é `PREFIXO-número` (`WEB-12`). Mover a tarefa de projeto dá a ela (e às subtarefas) um número novo. |
| Título e descrição | A descrição aceita Markdown: parágrafos, títulos (`#` a `####`), listas, listas de tarefas (`- [ ]`/`- [x]`), citações, blocos de código, `código`, **negrito**, *itálico*, ~~riscado~~, links, imagens, links automáticos e @menções |
| Status | Categoria: `todo` (a fazer), `doing` (em andamento), `blocked` (bloqueada), `done` (concluída) |
| Coluna | Coluna do quadro dentro da categoria (ver 4.4) |
| Prioridade | `urgent` (urgente), `high` (alta), `medium` (média), `low` (baixa), `lowest` (mínima) |
| Tipo | `task` (tarefa), `bug`, `story` (história), `epic` (épico) |
| Labels (tags) | Até 12 nomes; as [labels](#411-labels) dão cor e descrição a eles |
| Início e prazo | Datas `AAAA-MM-DD` no fuso local |
| Story points | Número de 0 a 1000 (aceita decimais) |
| Estimativa original e restante | Minutos. Aceitam `90m`, `2h`, `1h30m`, `1,5h` e `1d` (= 8h) |
| Sprint | Uma sprint do mesmo projeto, ou backlog |
| Tarefa-mãe | Torna a tarefa uma subtarefa |
| Responsáveis | Zero ou mais membros |
| Relator | Quem pediu ou reportou. Padrão: quem criou (no MCP, "eu") |
| Observadores | Quem acompanha a tarefa sem ser responsável |
| Campos personalizados | Valores dos [campos](#412-campos-personalizados) do projeto |
| Recorrência | Ver 4.9 |
| Arquivada | Some do quadro e das listas, mas continua no banco |
| Origem | `claude`, `user`, `automação`, `e-mail`, `ia` ou `você` (legado) |
| Origem externa | `external_source` + `external_id` (Jira, Trello, CSV, e-mail): evita duplicar na reimportação |

**Atrasada** é toda tarefa não concluída com prazo anterior a hoje.

**Duplicatas.** Ao criar, se já existe uma tarefa **aberta e não arquivada** com o mesmo título (sem diferenciar maiúsculas), no mesmo projeto e sob a mesma tarefa-mãe, a existente é devolvida no lugar de uma nova. Tarefas com origem externa são casadas pelo id externo.

**Referências.** Onde se informa uma tarefa (tarefa-mãe, dependências, busca, MCP), valem `12`, `#12` e o código `WEB-12`.

### 4.4 Status, colunas e workflows

**Colunas**

- Toda tarefa tem uma das 4 **categorias** de status.
- Um projeto sem colunas próprias usa as 4 colunas padrão ("A fazer", "Em andamento", "Bloqueadas", "Concluídas"). Elas são virtuais: não existem no banco. Ao criar a primeira coluna própria (ou definir transições), as 4 padrão viram linhas reais e passam a ser editáveis.
- Cada coluna pertence a uma categoria. Mover uma tarefa para uma coluna ajusta o status dela. Uma tarefa sem coluna aparece na **primeira coluna da sua categoria**, e mudar só o status, sem informar coluna, limpa a coluna da tarefa.
- O projeto precisa manter **ao menos uma coluna por categoria**: o sistema impede excluir a última ou mudar a categoria dela. Mudar a categoria de uma coluna muda o status de todas as tarefas dela.
- A visão "Todas as tarefas" sempre mostra as 4 categorias, seja qual for a coluna.

**Transições permitidas**

- Sem transições cadastradas, qualquer movimento vale.
- Com transições, a tarefa só pode ir da coluna atual para as colunas listadas como destino a partir dela (ficar na mesma coluna sempre vale). O sistema recusa o resto com `Transição não permitida: "A fazer" → "Concluídas". A partir de "A fazer" só pode ir para: …`.
- A regra vale para quem arrasta no quadro, para mudanças de status e coluna pela API, pelo MCP e pelas automações. Ao mover a tarefa para **outro projeto**, a regra não é aplicada.
- O detalhe da tarefa e o `get_task` mostram para onde ela pode ir.

**Modelos de workflow**

- Um workflow é um modelo com colunas (nome, categoria, cor) e transições, guardado na tabela `workflows`.
- **Salvar do projeto:** copia as colunas e transições atuais de um projeto como modelo.
- **Aplicar num projeto:** troca as colunas do projeto pelas do modelo. Cada tarefa vai para a coluna de mesmo nome e mesma categoria; sem correspondente, fica na primeira coluna da categoria dela.
- **Padrão:** um workflow pode ser marcado como padrão; ele é aplicado a todo projeto novo.
- Todo modelo precisa ter ao menos uma coluna por categoria.

### 4.5 Ordem (rank)

Cada tarefa tem um `rank` numérico usado para ordenar dentro da coluna:

- **Ao criar:** `faixa_da_prioridade × 10¹⁰ + segundos desde 1970`, com faixas urgente = 1, alta = 2, média = 3, baixa = 4 e mínima = 5. Assim, urgentes ficam em cima e, dentro da mesma prioridade, as mais antigas primeiro.
- **Arrastar** no quadro define o rank como o ponto médio entre os vizinhos.
- **Mudar a prioridade** recalcula o rank para a nova faixa.
- A coluna **Concluídas** é ordenada por data de conclusão, da mais recente para a mais antiga.

Ordem geral das listagens: em andamento, bloqueadas, a fazer e concluídas; dentro de cada grupo, pelo rank.

### 4.6 Subtarefas

- Uma subtarefa é uma tarefa completa com `parent_id`, sempre no mesmo projeto da tarefa-mãe.
- O sistema impede ciclos: uma tarefa não pode ser mãe de si mesma nem de um ancestral.
- Mover a tarefa-mãe de projeto leva as subtarefas junto (com numeração nova). Mover uma subtarefa sozinha para outro projeto a desvincula da mãe.
- Excluir a tarefa-mãe exclui as subtarefas.
- O card da mãe mostra o progresso (`2/5`). No quadro, as subtarefas ficam ocultas por padrão (filtro "Mostrar subtarefas no quadro"). Na lista e no Gantt elas aparecem recuadas sob a mãe.

### 4.7 Dependências

"A depende de B" (A é **bloqueada por** B) tem um tipo:

| Tipo | Sigla | Significado | Conta como bloqueio aberto |
| --- | --- | --- | --- |
| `finish_start` (padrão) | FS | B termina → A começa | enquanto B não está concluída |
| `start_start` | SS | B começa → A começa | enquanto B ainda está "a fazer" |
| `finish_finish` | FF | B termina → A termina | não (só planejamento) |
| `start_finish` | SF | B começa → A termina | não (só planejamento) |

- O sistema impede ciclos, seja qual for o tipo: não é possível adicionar uma dependência que faria B depender de A, direta ou indiretamente.
- Dependências entre projetos diferentes são permitidas; pela API, é preciso ter ao menos leitura no projeto da outra tarefa.
- O card mostra o ícone de bloqueio enquanto houver bloqueios abertos (`open_blockers > 0`). Nada impede mudar o status de uma tarefa bloqueada: o bloqueio é informativo.
- No Gantt, cada tipo liga a ponta certa das barras (fim → início, início → início etc.). A seta fica tracejada e vermelha quando as datas conflitam com o tipo e a tarefa dependente não está concluída.

### 4.8 Sprints

- Pertencem a um projeto e têm nome, objetivo, início e fim.
- O status passa por `planning` → `active` → `completed`, ou termina em `cancelled`.
- **Uma sprint ativa por projeto.** Iniciar uma segunda gera erro. Sprints concluídas ou canceladas não podem ser iniciadas de novo.
- **Iniciar** sem data de início preenche a data de hoje.
- **Concluir** move as tarefas não concluídas para outra sprint aberta do mesmo projeto ou para o backlog, preenche o fim com hoje se estiver vazio e guarda o **compromisso** da sprint: quantas tarefas e quantos pontos ela tinha no momento (`committed_tasks`, `committed_points`).
- **Cancelar** faz o mesmo movimento das pendentes, mas registra a sprint como cancelada: ela não dispara o gatilho "sprint concluída" e não entra na velocidade.
- **Excluir** manda as tarefas para o backlog.
- **Velocidade** (dashboard do projeto): as últimas 6 sprints concluídas, com pontos e tarefas concluídos contra o planejado (o compromisso guardado; em sprints antigas, sem compromisso, o total atual).
- **Burndown** (dashboard do projeto, sprint ativa): pontos restantes por dia — ou tarefas, se nenhuma tarefa da sprint tem pontos — contra a linha ideal. Sem data de fim, considera 14 dias a partir do início.
- Nas referências a sprint (API, MCP, automações), valem o id, o nome, `"active"` (a ativa), `"next"` (a próxima planejada) e `null`/`"backlog"`.

### 4.9 Recorrência

Uma regra de recorrência é `{ freq, interval, weekdays?, monthday?, until?, count? }`:

| Campo | Valores | Efeito |
| --- | --- | --- |
| `freq` | `daily`, `weekly`, `monthly`, `quarterly`, `yearly` | Frequência |
| `interval` | 1 a 365 (padrão 1) | A cada N unidades |
| `weekdays` | lista de 0 (domingo) a 6 (sábado) | Só semanal: dias marcados. Ao virar a semana, pula `interval − 1` semanas. |
| `monthday` | 1 a 31 ou `"last"` | Só mensal e trimestral: dia do mês (limitado ao último dia de meses curtos) ou o último dia |
| `until` | data | Não cria ocorrências depois dela |
| `count` | 1 a 1000 | Total de ocorrências; a tarefa guarda em `n` qual é a atual |

Ao **concluir** uma tarefa recorrente, o sistema cria a próxima ocorrência assim:

1. O próximo prazo é calculado a partir do prazo atual (ou de hoje, se não há prazo). Se ainda cair no passado, o cálculo avança até hoje ou depois.
2. Sem `monthday`, meses curtos são respeitados: 31/jan + 1 mês = 28 ou 29/fev.
3. Se o próximo prazo passa de `until`, ou se `n` já chegou a `count`, a recorrência termina (com um evento no histórico).
4. Se a tarefa tinha início, a distância entre início e prazo se mantém.
5. A nova tarefa copia título, descrição, prioridade, tipo, labels, estimativa original, pontos, relator, tarefa-mãe, responsáveis, observadores e campos personalizados. Ela começa "a fazer", fora de sprint e de coluna, com origem `automação`, e não dispara o gatilho "tarefa criada".
6. A original guarda `recurrence_next_id`, então reabrir e concluir de novo não duplica a próxima.

### 4.10 Estimativas, pontos e tempo

- **Estimativa original** (`estimate_minutes`): o esforço previsto. **Estimativa restante** (`remaining_minutes`): quanto falta, atualizado à mão. **Gasto**: soma dos lançamentos mais o tempo corrido dos timers.
- **Story points:** tamanho ágil. Alimentam os pontos em aberto do dashboard, a carga por pessoa (medida em pontos), o burndown e a velocidade.
- **Timer:** um por pessoa. Iniciar um timer para o anterior da mesma pessoa. Parar arredonda para minutos, com mínimo de 1.
- **Lançamento manual:** duração, data e nota.
- O tempo registrado pelo Claude conta para a pessoa que está usando o Claude (ver `CLAUDE_TASKS_USER` em [MCP.md](MCP.md)) e aparece como "Claude · Nome".
- O card mostra `gasto/estimado`, em vermelho quando passa da estimativa.

### 4.11 Labels

- As tarefas guardam os nomes das labels em `tags`. Uma **label** cadastrada dá **cor e descrição** a um nome.
- Uma label pode ser **do projeto** ou **global** (de todos os projetos). Quando há as duas com o mesmo nome, vale a do projeto. Nomes sem label cadastrada ganham uma cor derivada do nome.
- Nomes de até 40 caracteres, únicos no mesmo escopo. Sem cor escolhida, a label recebe uma da paleta.
- **Renomear** uma label renomeia o nome nas tarefas que o usam (no projeto dela, ou em todos, se for global). **Excluir** remove o nome das tarefas.
- A lista de labels mostra quantas tarefas usam cada uma.

### 4.12 Campos personalizados

| Tipo | Valor aceito |
| --- | --- |
| `text` | texto (até 2000 caracteres) |
| `number` | número (aceita vírgula decimal) |
| `date` | `AAAA-MM-DD` |
| `boolean` | `true`, `1`, `"sim"` (o resto é falso) |
| `select` | uma das opções (sem diferenciar maiúsculas) |
| `multi_select` | lista de opções (ou texto separado por vírgulas) |
| `user` | id, e-mail ou nome de um membro |
| `url` | endereço começando com `http://` ou `https://` |

- Um campo é **do projeto** ou **global**. Campos de seleção precisam de opções (até 50).
- O campo pode ser marcado como **obrigatório**: o painel destaca com `*`, mas o servidor não impede salvar sem valor.
- Os valores são informados pelo nome ou id do campo (`{ "Cliente": "ACME" }`); valor vazio apaga. Excluir o campo apaga os valores.
- Os valores aparecem no detalhe da tarefa, no `get_task`, na exportação CSV e são copiados pela recorrência.

### 4.13 Responsáveis, relator e observadores

- **Responsáveis:** quem faz. Recebem a notificação de atribuição.
- **Relator:** quem pediu. Padrão: quem criou a tarefa; em e-mails recebidos, o remetente, se for membro.
- **Observadores:** quem acompanha. Qualquer pessoa com leitura no projeto pode clicar em **Acompanhar** no detalhe da tarefa.
- **Quem acompanha** uma tarefa (para notificações e e-mails de automação) = responsáveis + observadores + relator.

### 4.14 Comentários

- **Conversa:** um comentário pode responder a outro. As respostas ficam num nível só: responder a uma resposta pendura na mesma conversa.
- **Menções:** `@Nome` ou `@PrimeiroNome` (sem diferenciar maiúsculas) notifica a pessoa citada, se ela puder ver o projeto. O editor sugere nomes ao digitar `@`.
- **Editar:** o autor ou quem gerencia o projeto. O comentário fica marcado como "editado" (`edited_at`). Menções acrescentadas na edição notificam só as pessoas novas.
- **Excluir:** o autor ou quem gerencia o projeto. Excluir um comentário exclui as respostas dele.
- Comentários do Claude (sem pessoa) só podem ser editados ou excluídos por gerentes e donos.

### 4.15 Anexos

- Até 25 MB por arquivo. O nome é saneado e o arquivo é gravado com nome único.
- Imagens, PDFs e vídeos MP4/MOV abrem no navegador; os demais tipos são baixados.
- É possível colar uma imagem na descrição ou no comentário. Ela é anexada e o Markdown `![nome](/api/attachments/ID)` é inserido no texto.
- E-mails recebidos pela caixa de entrada trazem os anexos para a tarefa.
- Excluir uma tarefa ou um projeto apaga também os arquivos dos anexos.

### 4.16 Histórico (atividade)

Cada tarefa tem uma linha do tempo formada por:

- **Comentários** (`kind = note`), com respostas.
- **Eventos** (`kind = event`), gerados automaticamente: mudança de status, prioridade, prazo, sprint, projeto ou relator; arquivar e desarquivar; atribuições; anexos; automações executadas; recorrência.

A página Atividade, o dashboard e a ferramenta `get_activity` juntam esse histórico com as criações de tarefas.

### 4.17 Links públicos

- Um **link público** (`/s/<token>`) mostra uma tarefa ou um projeto **sem login e só para leitura**.
- **Tarefa:** quem pode editar a tarefa cria o link; em projetos **privados**, só gerentes e donos. A página mostra título, código, status, coluna, prioridade, tipo, labels, datas, pontos, responsáveis (só os nomes), descrição, subtarefas, anexos e comentários.
- **Projeto:** exige visibilidade **pública** e papel de gerente ou dono. A página mostra as colunas e as tarefas de primeiro nível abertas e concluídas nos últimos 30 dias, em quadro ou lista, com filtro.
- O link pode ter validade (1 a 3650 dias) ou não expirar, e pode ser revogado a qualquer momento.
- Os dados públicos não incluem e-mails nem tempo registrado. Anexos abrem por uma rota pública que confere o link.
- Se o projeto deixa de ser público, os links dele param de funcionar (e voltam a valer se ele ficar público de novo; para cortar de vez, revogue).

### 4.18 Visibilidade

| Visibilidade | Quem vê |
| --- | --- |
| `private` (privado) | Só quem tem papel no projeto, no workspace (ou acima) ou na organização, e os administradores |
| `internal` (interno, padrão) | Todas as contas do quadro |
| `public` (público) | Todas as contas do quadro, e dá para gerar link público do projeto |

O papel de cada pessoa num projeto visível vem da [seção 8](#8-usuários-papéis-e-permissões).

---

## 5. Guia do painel

### 5.1 Acesso

| Situação | Tela |
| --- | --- |
| Nenhuma conta existe | **Crie sua conta**: a primeira vira administrador. Notificações antigas, do modo sem contas, passam para ela. |
| Há contas e você não entrou | **Entrar** com e-mail e senha |
| Link `/?invite=TOKEN` | **Aceitar convite**: cria a conta com o papel do convite (e o papel no projeto, se o convite tiver um). Se o convite tem e-mail, o campo fica travado. |
| **Esqueci a senha** | Pede o e-mail. Se houver conta e o SMTP estiver configurado, chega um link; sem SMTP, a tela explica que um administrador precisa gerar o link. |
| Link `/?reset=TOKEN` | **Criar nova senha**: troca a senha, encerra as outras sessões e entra |

A sessão dura 90 dias. Uma requisição sem sessão válida recarrega o painel na tela de login. Contas desativadas não entram.

### 5.2 Estrutura da tela

- **Barra lateral:**
  - Botão **Buscar ou ir para… ⌘K** (paleta de comandos).
  - Dashboard, Todas as tarefas, Minhas tarefas (só aparece com mais de um membro) e Atividade.
  - Projetos, com contadores de abertas, alerta vermelho de atrasadas, cadeado nos privados e o botão `+` para criar projeto (não aparece para visualizadores). Com mais de um workspace, os projetos são agrupados por organização › workspace › sub-workspace; cada grupo pode ser recolhido e clicar no workspace filtra as tarefas dele (e dos sub-workspaces).
  - Arquivados, recolhível.
  - Rodapé: Automações, Equipe, Organizações, Configurações e Administração (só administradores), seu nome (menu com Minha conta e preferências, Documentação da API e Sair) e o indicador "ao vivo".
- **Cabeçalho** (primeira linha): nome do projeto, prefixo, selo de visibilidade (privado/público), menu `⋯` do projeto e, na mesma linha, a pasta ou a descrição (a pasta some abaixo de 1200 px); à direita, timer em execução, sino de notificações, botão do chat e **Nova tarefa** (os dois últimos somem para quem só lê).
- **Barra de ferramentas** (segunda linha): abas (Quadro, Lista, Calendário, Gantt, Dashboard e, em projetos com pasta, [Mapa do código](#115-mapa-do-código)) à esquerda; à direita, seletor de sprint com engrenagem (dentro de um projeto), filtro de texto, os filtros ativos como chips com `×` (até três) e Filtros.
- **Faixa de novidades:** veja a [seção 5.4](#54-quadro).
- **Menu do projeto `⋯`:** Configurações do projeto, Sprints, Link público de leitura (projetos públicos, gerentes), Exportar CSV, Copiar caminho e, para donos, Arquivar/Desarquivar e Excluir.

A URL guarda o estado (`?project=4&view=gantt&sprint=2&task=47`, ou `?workspace=3`), então links abrem direto na tarefa.

### 5.3 Busca, filtros e paleta ⌘K

- **Filtro de texto** (`/`): título, descrição, labels, nome do projeto, `#id` e código (`WEB-12`), nas visões de tarefas.
- **Filtros:**
  - prioridade, tipo, responsável (eu, sem responsável ou pessoa) e label;
  - prazo (atrasadas, vencem hoje, próximos 7 dias, sem prazo);
  - "Mostrar subtarefas no quadro" e "Incluir tarefas arquivadas".
- O botão Filtros mostra quantos filtros estão ativos. Filtros e texto valem para Quadro, Lista, Calendário e Gantt.
- O seletor de sprint mostra todas as sprints, o backlog (sem sprint) ou uma sprint específica (com a marca de ativa, concluída ou cancelada).
- O painel carrega as tarefas abertas e as concluídas nos **últimos 60 dias**.
- **Paleta ⌘K** (também `Ctrl+K` ou `K`): busca universal no servidor — tarefas (também pelo código), comentários, projetos, sprints, labels, pessoas e workspaces, só dos projetos que você pode ver (labels globais ou desses projetos; workspaces que contêm algum deles) — a partir de 2 letras, mais atalhos para as ações e páginas (nova tarefa, novo projeto, chat, cada visão, Atividade, Automações, Equipe, Organizações, configurações, Administração, Minha conta, Documentação da API). Setas navegam, `Enter` abre, `Esc` fecha. Escolher uma label filtra por ela; uma pessoa abre a lista das tarefas dela; um workspace filtra os projetos dele.

### 5.4 Quadro

- **Colunas:** dentro de um projeto, as colunas dele; em "Todas as tarefas" ou num workspace, as 4 categorias.
- **Card:**
  - prioridade, tipo, `#id` ou código;
  - ícones de bloqueada, timer rodando e recorrente;
  - selo do Claude ou do e-mail, quando a tarefa veio deles;
  - avatares dos responsáveis e tarefa-mãe;
  - chips de projeto, prazo (vermelho se atrasada, âmbar se hoje ou em breve), pontos e labels coloridas;
  - subtarefas, comentários, anexos e tempo gasto/estimado.
- **Arrastar** entre colunas muda coluna e status; dentro da coluna, muda a ordem. Uma linha mostra onde o card vai cair. Se o fluxo do projeto não permite ir para uma coluna, ela é marcada e o movimento é recusado.
- O `+` no topo da coluna cria uma tarefa já nela.
- **Teclado:**
  - `Enter` ou `Espaço` num card abre o detalhe;
  - as setas andam entre os cards (para cima e para baixo na coluna, para os lados entre colunas);
  - `Shift` + setas levam o card junto: `←`/`→` mudam de coluna (respeitando o fluxo do projeto) e `↑`/`↓` mudam a ordem;
  - o foco continua no mesmo card quando o quadro se atualiza ao vivo.
- **Desfazer:** toda mudança de coluna, arrastando ou pelo teclado, mostra um aviso ("LOJ-2 movida para Em andamento") com o botão **Desfazer**, que volta a coluna, o status e a ordem anteriores.
- **Novidades desde a última visita:**
  - o painel guarda no navegador quando você esteve nele pela última vez (`tk_last_visit`); recarregar a página não conta como uma visita nova, só abrir o painel de novo numa aba nova;
  - tarefas abertas criadas depois disso ganham uma brasa (filete laranja) na borda e o selo **Nova**, até você abrir a tarefa (as vistas ficam em `tk_seen`);
  - uma faixa no topo do Quadro, da Lista, do Calendário e do Gantt resume: "5 tarefas novas desde ontem às 18:40 · 3 registradas pelo Claude · em 2 projetos", com **Revisar as novas** (a triagem guiada, abaixo), **Ver só as novas** (vira um filtro, com chip na barra), **Marcar como vistas** e `×` para dispensar até a próxima visita.
- **Triagem guiada:** **Revisar as novas**, na faixa ou na paleta ⌘K, mostra uma tarefa nova por vez, da mais antiga para a mais recente, só das que você pode editar:
  - título, descrição, projeto, tipo e quem registrou, com um contador ("2 de 5") e uma barra de progresso;
  - `1` a `5` escolhem a prioridade (Urgente a Mínima), `I` atribui a você, `S` põe na sprint ativa do projeto (o botão só aparece se houver uma) e `D` abre o prazo; a mudança vale na hora, como no detalhe da tarefa;
  - `Enter` aceita (tira a tarefa das novidades e vai para a próxima), `→` pula, `←` volta, `Backspace` arquiva (com **Desfazer**, tecla `Z`), `O` abre o detalhe completo e `Esc` fecha;
  - no fim, um resumo com o que foi aceito, arquivado e pulado: "Triagem zerada", ou **Revisar as puladas** se sobrou alguma.
- **O Claude à vista:** tarefas que o Claude registrou mostram "✳ Claude" no card (e "Registrada pelo Claude" no detalhe).
- **Brasa viva:** quando uma tarefa muda por fora (o Claude pelo MCP, outra pessoa, uma automação), o card (ou a linha, na Lista) acende uma brasa que se apaga em 4 segundos. Assim dá para ver o quadro reagir enquanto o Claude trabalha.

### 5.5 Lista

- Tabela com seleção, conclusão rápida (círculo), tarefa, projeto, status, responsáveis, prazo, sprint (dentro de um projeto), pontos, tempo e "atualizada".
- **Ordenar:** clique no cabeçalho (clique de novo inverte).
- **Agrupar por:** projeto, status, prioridade, prazo (atrasadas, hoje, 7 dias, 30 dias, mais tarde, sem prazo), responsável, sprint, tipo ou label. Os grupos podem ser recolhidos.
- Subtarefas aparecem recuadas logo abaixo da mãe.
- **Exportar CSV** baixa todas as tarefas do projeto aberto (ou de todos os projetos visíveis), sem os filtros da tela.
- **Ações em lote:** marque tarefas (ou "Selecionar todas") e use a barra que aparece:

| Ação | Efeito |
| --- | --- |
| Status | Muda o status de todas |
| Prioridade | Muda a prioridade |
| Responsável | Troca os responsáveis por uma pessoa, ou deixa sem responsável |
| Sprint | Move para uma sprint aberta ou para o backlog (só dentro de um projeto) |
| Label | Acrescenta uma label, mantendo as que cada tarefa já tem |
| Arquivar | Arquiva todas |
| Excluir | Exclui todas, após confirmação (exige gerente ou dono nos projetos) |

As mudanças em lote acontecem numa única transação: se uma tarefa não pode ser alterada, nenhuma é.

### 5.6 Calendário

- Mês com início no domingo. Cada tarefa aparece no dia do prazo, com a cor do projeto. Atrasadas ficam destacadas; concluídas, riscadas.
- Até 4 tarefas por dia; o resto fica em "+N mais".
- **Arrastar** para outro dia muda o prazo. Se a tarefa tem início, ele se move junto para manter a duração.
- **Sem prazo:** lista lateral de tarefas abertas sem data. Arraste uma delas para um dia para agendar.
- Clicar num dia vazio, ou no `+`, cria uma tarefa com aquele prazo.

### 5.7 Gantt

- Uma linha por tarefa com datas, com a barra indo do início ao prazo.
- Tarefa só com prazo vira um **marco** (losango). Tarefa só com início vira uma barra de 1 dia.
- O preenchimento da barra mostra o progresso das subtarefas, ou 100% se estiver concluída.
- **Zoom:** dias, semanas ou meses. Fins de semana sombreados (no zoom de dias), linha de "hoje" e botão Hoje.
- **Agrupamento:** por projeto em "Todas as tarefas"; dentro de um projeto, subtarefas recuadas.
- **Arrastar:** o meio da barra move início e prazo juntos; a borda esquerda muda o início; a borda direita muda o prazo; uma etiqueta mostra as datas durante o arraste; um clique sem arrastar abre a tarefa.
- **Setas:** dependências, saindo e chegando na ponta que o tipo indica (FS, SS, FF, SF), com o tipo no texto de ajuda; vermelhas e tracejadas quando há conflito de datas.
- **Sem datas:** seção recolhível. Clicar num dia da linha agenda a tarefa (início no dia clicado, prazo 2 dias depois).

### 5.8 Dashboard

Disponível para todos os projetos (barra lateral) ou para um projeto (aba). Os dados respeitam os projetos que você pode ver.

- **Indicadores:** abertas, em andamento, bloqueadas, atrasadas, vencem em 7 dias, concluídas nos últimos 7 dias, bugs abertos, pontos em aberto e tempo registrado nos últimos 7 dias. Atrasadas, vencem em 7 dias e bugs abertos abrem a Lista já filtrada; abertas, em andamento, bloqueadas e pontos abrem o Quadro. Nos gráficos, clicar numa barra de prioridade, tipo ou pessoa abre a Lista filtrada, e numa linha de projeto (abertas, portfólio, tempo) abre o quadro dele.
- **Gráficos** (cada um com valores ao passar o mouse e, onde cabe, "Ver como tabela"):

| Gráfico | Todos os projetos | Um projeto |
| --- | --- | --- |
| Criadas × concluídas por semana (8 semanas) | ✓ | ✓ |
| Qualidade · bugs abertos × corrigidos por semana | ✓ | ✓ |
| Abertas por prioridade e por tipo | ✓ | ✓ |
| Abertas por projeto (clique abre o quadro) | ✓ | — |
| Abertas por coluna | — | ✓ |
| Portfólio: status, progresso e prazo de cada projeto | ✓ | — |
| Progresso do projeto | — | ✓ |
| Carga por pessoa (tarefas ou pontos, por status) | ✓ | ✓ |
| Tempo por pessoa · 30 dias | ✓ | ✓ |
| Tempo por projeto · 7 dias | ✓ | — |
| Alocação · pessoas × projetos (mapa de calor) | ✓ | — |
| Sprint ativa com burndown (restante × ideal) | — | ✓ |
| Velocidade (planejado × concluído nas últimas 6 sprints) | — | ✓ |
| Próximos prazos (10) | ✓ | ✓ |
| Atividade recente (20), com "Ver toda a atividade" | ✓ | ✓ |

### 5.9 Detalhe da tarefa

O detalhe abre ao clicar numa tarefa, em qualquer visão, e fecha com `Esc`. Para quem só lê, ele aparece marcado "somente leitura" e sem controles de edição.

- **Cabeçalho:**
  - tipo, `#id`/código, projeto (clique abre o quadro dele) e tarefa-mãe;
  - **Acompanhar** (vira observador e recebe as notificações);
  - **Copiar para o Claude:** gera um pedido pronto para colar numa sessão ("Pegue a tarefa #12 do quadro… leia os detalhes com get_task e trabalhe nela");
  - menu `⋯`: adicionar subtarefa, timer, copiar link, criar link público de leitura, arquivar e excluir.
- **Título:** editável no lugar. `Enter` salva.
- **Campos:**
  - status/coluna (as colunas fora do fluxo aparecem como "transição não permitida"), prioridade, tipo;
  - responsáveis, relator e observadores;
  - labels (com "Nova label…" e "Gerenciar labels e cores");
  - início, prazo (com alerta), pontos, estimativa original e restante;
  - sprint, projeto (mover), recorrência (frequência, a cada N, dias da semana, dia do mês ou último, até uma data ou N vezes) e pasta;
  - campos personalizados do projeto.
- **Descrição:** clique para editar, com barra de formatação (negrito, itálico, título, listas, lista de tarefas, citação, código, link, menção), atalhos `⌘B`, `⌘I`, `⌘K` e autocompletar de `@`. `⌘↵` ou `Esc` conclui. Dá para colar imagens.
- **Subtarefas:** barra de progresso, círculo para concluir, clique para abrir e campo para adicionar (`Enter`).
- **Dependências:** "Depende de", com campo que aceita `#id`, código ou título (com sugestões), escolha do tipo e `×` para remover; abaixo, "Bloqueia".
- **Tempo:** iniciar ou parar o timer; gasto × estimado e restante, com barra; "Registrar manualmente" (duração, data, nota); lista de registros com botão de apagar.
- **Anexos:** miniaturas de imagens e lista de arquivos. Adicione pelo botão, arrastando arquivos para o painel ou colando.
- **Links públicos:** os links ativos da tarefa, com validade, copiar e revogar.
- **Atividade:** alterna entre "Tudo" e só os comentários; cada comentário tem Responder, Editar e Excluir (para quem pode); campo de comentário com formatação e `@` (`⌘↵` envia).
- **Rodapé:** Concluir/Reabrir, Arquivar/Desarquivar e Excluir.

Enquanto você digita, as atualizações ao vivo só renovam as listas do detalhe e não apagam o que está sendo escrito.

### 5.10 Nova tarefa

Abre com `N`, com o botão ou pela paleta. Os campos são:

- título, descrição, projeto (ou "+ Novo projeto…");
- status/coluna, prioridade, tipo;
- início, prazo, estimativa, pontos;
- sprint (aparece se o projeto tem sprints abertas);
- labels, repetição e responsáveis.

Ao abrir a partir do `+` de uma coluna ou de um dia do calendário, o campo correspondente já vem preenchido. Dentro de um filtro de sprint, a sprint também vem preenchida. `⌘↵` cria.

### 5.11 Sprints

Abre pelo menu do projeto ou pela engrenagem ao lado do seletor de sprint.

- Criar com nome, objetivo, início e fim.
- Cada sprint mostra o progresso em tarefas e pontos, e tem Ver tarefas, Iniciar, Concluir (escolhendo para onde vão as pendentes), Cancelar sprint (idem; fica registrada como cancelada e não entra na velocidade), Editar e Excluir.

### 5.12 Configurações do projeto

Abre pelo menu `⋯` do projeto ou pela paleta ⌘K. Sem projeto aberto (por exemplo, num link `?view=project-settings`), a página pede para escolher um. Uma navegação à esquerda leva às seções abaixo. Quem só lê vê tudo desabilitado, com o aviso de que só gerentes e donos mudam as configurações.

| Seção | O que tem |
| --- | --- |
| **Geral** | Imagem do projeto (enviar, trocar, remover; PNG, JPEG, WebP ou GIF até 2 MB), nome, descrição, cor, **prefixo das tarefas** (com prévia do código; trocar o prefixo muda o código de todas, e os números continuam), status, prioridade, início e fim, workspace (ou "Sem workspace") e **visibilidade** (só donos mudam). Projetos de pasta mostram a pasta ligada. |
| **Membros** | Explicação de quem tem acesso conforme a visibilidade e o que cada papel permite. Lista das pessoas com papel direto no projeto (papel da conta, papel no projeto, remover); só donos dão ou tiram o papel de dono. "Adicionar pessoa" escolhe entre as contas que ainda não estão na lista (com filtro quando são muitas) e o papel. Um papel definido aqui substitui o da conta, inclusive para menos; papéis no workspace ou na organização também valem, e prevalece o maior. |
| **Fluxo de trabalho** | **Colunas do quadro:** renomear no lugar (`Enter` confirma), mudar a categoria, mover ← →, excluir (as tarefas vão para a primeira coluna da mesma categoria) e adicionar. **Transições permitidas:** matriz "De ↓ · Para →" com uma caixa por par de colunas; sem nenhuma marcada, qualquer movimento vale; "Liberar tudo" remove as restrições. **Modelos de workflow:** lista com colunas e número de transições; Aplicar (substitui colunas e transições, com confirmação); excluir modelo (administradores); "Salvar o fluxo deste projeto como modelo", com nome, descrição e, para administradores, "Usar como padrão para projetos novos". |
| **Labels** | Labels do projeto e labels globais, com cor, descrição e quantas tarefas usam cada uma. Criar e editar têm prévia, paleta e seletor de cor livre. Excluir avisa quantas tarefas perdem a tag. Labels globais só são editadas por administradores. |
| **Campos personalizados** | Campos do projeto e globais, com tipo, opções e marca de obrigatório. Criar e editar: nome, tipo (não muda depois), opções (uma por linha, até 50), obrigatório e, para administradores, "campo global". Excluir apaga os valores nas tarefas. |
| **Caixa de entrada** | Aviso quando o SMTP não está configurado (a caixa funciona, mas a resposta automática não sai). Como funciona, última verificação e último erro. Formulário: ativa, endereço, servidor IMAP, porta, TLS, usuário, senha (fica salva se não mexer), pasta, intervalo; tipo, prioridade, coluna e responsável das tarefas criadas; resposta automática com mensagem e assinatura. Botões **Testar conexão**, **Verificar agora** e **Remover caixa** (apaga regras e histórico; as tarefas ficam). **Regras** (ordem, condições, ações, parar, ativa/pausada) e **Últimos e-mails** (remetente, assunto, resultado com link para a tarefa, data). Detalhes na [seção 9.2](#92-caixa-de-entrada-imap--tarefas). |
| **Importar e exportar** | Resultado da última importação (criadas, atualizadas, ignoradas e erros). **Exportar:** baixar o CSV do projeto. **Importar arquivo:** CSV (com a tabela de colunas aceitas e as regras de conversão) ou JSON do Trello. **Importar do Jira** (endereço, e-mail, token, JQL) e **do Trello** (quadro, chave, token), cada um com "Salvar para sincronizar de novo depois". **Sincronizações salvas:** origem, última vez, resultado, Rodar e excluir. Veja a [seção 10](#10-importação-e-exportação). |
| **Links públicos** | Só em projetos públicos. Gerar link com validade em dias (vazio = sem limite; o link é copiado), e a lista dos links ativos com quem criou, validade, copiar, abrir e revogar. |
| **Zona de perigo** | Arquivar/desarquivar e excluir o projeto (com todas as tarefas, comentários, anexos, colunas, labels, campos e a caixa de entrada). Só donos e administradores. |

### 5.13 Organizações

Página para administradores e para donos e gerentes de organização (os demais veem a estrutura).

- **Organizações:** criar (administradores), editar (nome, descrição, site, cor), trocar ou remover a imagem, arquivar/restaurar e excluir (só sem projetos).
- **Workspaces e projetos:** árvore de workspaces com os projetos de cada um; criar workspace ou sub-workspace, editar e mover ("Dentro de"), arquivar/restaurar, excluir, "Ver tarefas deste workspace" e mover um projeto para outro workspace. Ao mover um projeto, quem tem papel no destino passa a ter esse papel nele; os papéis dados direto no projeto continuam.
- **Membros:** em cada organização e workspace, "Ver membros" lista quem tem papel ali, com troca de papel, "Tirar o papel" e "Adicionar pessoa…".
- A página lembra a regra: papéis valem para tudo o que está dentro, vale o papel mais alto e administradores têm acesso total.

### 5.14 Atividade

Feed de tudo o que aconteceu nos projetos que você pode ver: tarefas criadas, comentários e alterações, de pessoas, do Claude, de automações e do e-mail.

- **Filtros:** texto (título ou conteúdo), projeto, quem (uma pessoa, Claude, automações ou e-mail), tipo (tarefas criadas, comentários, alterações) e período (de/até). "Limpar" e "Atualizar".
- Os itens são agrupados por dia (Hoje, Ontem, datas) e abrem a tarefa. Textos longos se expandem com um clique.
- "Carregar mais" busca as páginas seguintes.

### 5.15 Automações

- Lista de regras com chave liga/desliga, descrição legível (gatilho, condições, ação, escopo) e estatística de execução.
- 7 modelos prontos e um editor completo (ver [seção 6](#6-automações)).
- Administradores criam regras para todos os projetos; gerentes e donos criam e editam regras dos próprios projetos. Os demais só veem as regras dos projetos visíveis.

### 5.16 Equipe

- **Membros:** nome, papel da conta, "visto por último" e situação. O administrador muda o papel da conta (administrador, membro, visualizador), gera link para redefinir a senha, desativa/reativa (bloqueia o acesso e mantém o histórico) e remove.
- **Convidar pessoa:** e-mail opcional (trava o convite nesse e-mail), papel da conta, projeto opcional com o papel no projeto e "Enviar por e-mail" (com SMTP configurado). O link é copiado automaticamente.
- **Convites pendentes:** e-mail, papel, projeto, validade, copiar link e revogar.

### 5.17 Minha conta e preferências

- **Perfil:** foto (trocar ou remover), nome, e-mail e cor.
- **Preferências:** idioma (ou o padrão do quadro), tema (igual ao sistema, claro ou escuro), visão inicial ("Abrir em": Quadro, Lista, Calendário, Gantt ou Dashboard) e **Atalhos de uma tecla** (N, C, K, / e 1 a 5; desligados, as dicas de tecla somem e ⌘K continua valendo).
- **Notificações:** matriz com os 9 tipos de notificação nas linhas e os canais **No painel**, **E-mail** e **macOS** nas colunas. A coluna de e-mail fica desabilitada enquanto o SMTP não estiver configurado. O sino tem um atalho para esta tela.
- **Senha:** trocar (exige a senha atual).

### 5.18 Configurações gerais

Só administradores; os demais são levados às próprias preferências.

- **Geral:** endereço público do painel (usado nos links de convites, e-mails e links públicos), idioma padrão do quadro, antecedência dos avisos de prazo (0 a 30 dias) e notificações do macOS neste computador.
- **E-mail (SMTP):** servidor, porta, TLS direto (465; desmarcado = STARTTLS na 587), usuário, senha, remetente e "Permitir login sem criptografia (só para servidores na rede local)". Mostra o último erro de envio e tem "Enviar e-mail de teste para mim". Veja a [seção 9](#9-e-mail).
- **IA do chat do painel:** provedor (Claude Code com a sua assinatura, API da Anthropic ou compatível com OpenAI), modelo, endereço da API e chave. Veja a [seção 11.4](#114-chat-do-painel).

As senhas e chaves aparecem mascaradas (`••••••••`); deixar o campo como está mantém o valor salvo.

### 5.19 Administração

Só administradores.

- **Números:** pessoas, organizações, workspaces, projetos, tarefas, comentários, anexos, automações e caixas de entrada.
- **Sistema:** versão, Node.js, há quanto tempo está no ar, pasta de dados (com copiar caminho), tamanho do banco e dos anexos, e-mail configurado ou não, provedor do chat e o último erro de envio de e-mail.
- **Atalhos:** Equipe, Organizações, Configurações e Documentação da API.
- **Backups:** criar backup agora, baixar e excluir cada cópia (inclusive as automáticas das migrações).
- **Manutenção:** "Compactar o banco" (`VACUUM` e checkpoint do WAL; o quadro fica parado enquanto roda) e "Limpar dados vencidos" (sessões expiradas, convites vencidos não usados, links de senha usados ou vencidos, comandos antigos do painel e notificações lidas há mais de 90 dias).
- **Contas:** pessoa, papel, situação e visto por último, com link de senha e desativar/reativar.

### 5.20 Notificações e timer

- **Sino:** contador de não lidas e painel com as últimas 50, cada uma com a marca do tipo. Clicar numa notificação abre a tarefa e a marca como lida. Há também "Marcar todas como lidas" e o atalho "Preferências de notificação".
- **Timer no cabeçalho:** tempo corrido ao vivo e título da tarefa. Clique para abrir a tarefa; `■` para parar.

### 5.21 Chat com o Claude

O botão ✦ ou a tecla `C` abrem o painel do chat à direita (não aparece para visualizadores).

- **Como funciona:** o assistente usa as ferramentas do MCP do quadro para consultar e alterar tarefas, e pode abrir coisas na sua tela (`show_in_dashboard`). A resposta chega em streaming e mostra quais ferramentas foram usadas.
- **Contexto:** o projeto aberto no painel (se você puder vê-lo), quem está falando e a data de hoje.
- **Continuidade:** a conversa continua até você clicar em `+` (Nova conversa).
- **Resultado:** o quadro se atualiza sozinho com o que o assistente mudar.
- **Provedores e requisitos:** veja a [seção 11.4](#114-chat-do-painel).

### 5.22 Modo somente leitura

Para contas **visualizador** (que são visualizadoras em todos os projetos, mesmo com um papel maior dado num deles) e para quem tem papel de visualizador num projeto:

- o painel esconde Nova tarefa, o chat, o `+` de projetos e os controles de edição (no projeto em que o papel é só de leitura);
- o detalhe da tarefa aparece como "somente leitura", mas ainda dá para **Acompanhar** a tarefa;
- o servidor confere tudo de novo e responde 403 a qualquer tentativa de escrita.

### 5.23 Página pública (`/s/<token>`)

- Abre sem login, com o aviso "Somente leitura" e sem ser indexada por buscadores (`noindex`).
- **Tarefa:** cabeçalho com código, status e prioridade; campos; descrição em Markdown; subtarefas; anexos; comentários em conversa.
- **Projeto:** visualização em **Quadro** ou **Lista**, filtro de texto e as tarefas abertas e concluídas nos últimos 30 dias.
- Link revogado, expirado ou de projeto que deixou de ser público mostra "Link inválido ou expirado".

### 5.24 Idiomas

- O painel está em **português** (padrão) e pode ser usado em **inglês, espanhol, francês e alemão**. As traduções ficam em `public/js/i18n/<idioma>.js` (`en`, `es`, `fr`, `de`), dicionários cujas chaves são os próprios textos em português.
- **Ordem de escolha:** o idioma da pessoa (Minha conta) > o idioma padrão do quadro (Configurações) > português.
- Um texto sem tradução aparece em português. No console do navegador, `window.__i18nMissing` lista os textos que faltam no idioma atual.
- Textos gerados pelo servidor (mensagens de erro, notificações, e-mails, eventos do histórico) e as respostas do MCP continuam em português.

### 5.25 Atalhos de teclado

| Tecla | Ação |
| --- | --- |
| `⌘K` / `Ctrl+K` / `K` | Paleta de comandos e busca universal |
| `N` | Nova tarefa (não para visualizadores) |
| `/` | Focar o filtro de texto |
| `C` | Abrir/fechar o chat (não para visualizadores) |
| `1` a `5` | Quadro, Lista, Calendário, Gantt, Dashboard |
| Setas | No quadro: andam entre os cards |
| `Shift` + setas | No quadro: levam o card focado para outra coluna (`←`/`→`) ou outra posição (`↑`/`↓`) |
| `Esc` | Sai do campo, fecha a paleta, o detalhe, menus, painéis e a barra lateral |
| `⌘↵` | Confirma diálogos, envia comentário, conclui edição da descrição |
| `⌘B` / `⌘I` / `⌘K` | No editor: negrito, itálico, link |
| `Enter` | No título, labels e estimativa: salva. Em subtarefa ou dependência: adiciona. |
| Setas, `Home`, `End`, inicial do nome | Num menu: andam pelos itens (`Tab` e `Esc` fecham e devolvem o foco ao botão) |
| `1` a `5`, `I`, `S`, `D`, `O`, `Z`, `Enter`, `Backspace`, `←`, `→` | Na triagem guiada: veja a [seção 5.4](#54-quadro) |

Os atalhos de uma tecla (`K`, `N`, `/`, `C` e `1` a `5`) podem ser desligados em **Minha conta → Preferências**. Os de dentro de um componente com foco (cards, menus, triagem) continuam valendo.

### 5.26 Celular, tema e acessibilidade

- **Celular:** abaixo de 820 px, a barra lateral vira gaveta (☰); as abas ganham uma linha própria e os controles ficam embaixo; as colunas do quadro ocupam a largura da tela e rolam na horizontal, com encaixe; o detalhe da tarefa ocupa a tela inteira e os diálogos sobem de baixo, como folhas.
- **Tema:** igual ao sistema, claro ou escuro (escolha em Minha conta).
- **Visual ("Brasa"):** papel grafite quente nos dois temas, Inter para o texto e JetBrains Mono só para códigos e caminhos (as duas servidas pelo próprio painel, em `public/fonts/`, então funciona offline). O laranja é reservado para ação, lugar atual, hoje e o que o Claude acabou de tocar; prioridades usam barras em tinta e só a urgente fica vermelha. Os tokens ficam no começo de `public/styles.css`.
- **Acessibilidade:**
  - contraste conferido (WCAG AA): texto com pelo menos 4,5:1 sobre cada superfície e ícones e bordas de controle com pelo menos 3:1, nos dois temas;
  - foco visível em todos os campos e botões; o detalhe da tarefa é um diálogo (`role="dialog"`) que recebe o foco no título ao abrir, fica inerte quando fechado e devolve o foco ao card ou à linha que o abriu;
  - erros são anunciados na hora (`role="alert"`); os outros avisos, quando o leitor de tela puder;
  - menus têm `role="menu"`, abrem com o foco no primeiro item e o botão indica `aria-haspopup` e `aria-expanded`; os painéis de Filtros e Notificações são diálogos leves, com o foco dentro, e `Esc` devolve o foco ao botão;
  - a paleta é um combobox com lista (`aria-activedescendant`, opções agrupadas por seção) e anuncia o número de resultados; as abas são navegação, com `aria-current`;
  - respeita "reduzir movimento" do sistema (sem deslocamentos, transições curtas, brasa parada); gráficos têm "Ver como tabela"; os cards se movem pelo teclado.

---

## 6. Automações

Uma regra tem **escopo** (todos os projetos ou um projeto), **gatilho**, **condições** opcionais e **uma ação**. Administradores criam regras globais; gerentes e donos criam regras nos próprios projetos (e não podem movê-las para projetos que não gerenciam nem torná-las globais).

### 6.1 Gatilhos

| Gatilho | Dispara quando | Momento |
| --- | --- | --- |
| `task_created` | uma tarefa é criada | imediato |
| `task_updated` | algum campo da tarefa muda (condição `field` para um campo específico) | imediato |
| `status_changed` | o status muda | imediato |
| `priority_changed` | a prioridade muda | imediato |
| `comment_added` | alguém comenta (não em edições) | imediato |
| `assigned` | alguém é adicionado como responsável | imediato |
| `due_soon` | o prazo está a até N dias (condição `days`, padrão 1) | agendador, 1×/min |
| `overdue` | o prazo passou | agendador, 1×/min |
| `sprint_started` | uma sprint do escopo é iniciada | imediato |
| `sprint_completed` | uma sprint do escopo é concluída (não no cancelamento) | imediato |
| `project_created` | um projeto é criado | imediato |

**Gatilhos sem tarefa:**

- Em `sprint_started` e `sprint_completed`, as ações de aviso (`notify`, `send_email`) saem **uma vez**; as ações de tarefa valem para **cada tarefa aberta da sprint** que passar nas condições.
- Em `project_created` só valem ações de aviso, e a regra precisa ser global.

### 6.2 Condições

| Condição | Significado |
| --- | --- |
| `to_status` | (status_changed) novo status |
| `from_status` | (status_changed) status anterior |
| `field` | (task_updated) só quando este campo mudou: `title`, `description`, `status`, `priority`, `type`, `tags`, `due_date`, `start_date`, `story_points`, `estimate_minutes`, `sprint_id`, `column_id`, `reporter_id` (nomes das colunas no banco; também `remaining_minutes`, `project_id`, `parent_id`, `recurrence`, `archived_at`, `rank`) |
| `priority` | prioridade atual está na lista |
| `type` | tipo está na lista |
| `tag` | a tarefa tem essa label |
| `by_claude` | a tarefa foi criada pelo Claude |
| `days` | (due_soon) antecedência em dias |

Responsáveis, observadores e campos personalizados não geram mudança de campo: trocar só eles não dispara `task_updated`.

### 6.3 Ações

| Ação | Valor |
| --- | --- |
| `set_status` | `todo`, `doing`, `blocked` ou `done` |
| `set_column` | nome ou id da coluna (o projeto precisa de colunas próprias) |
| `set_priority` | `lowest`, `low`, `medium`, `high` ou `urgent` |
| `add_tag` / `remove_tag` | a label |
| `add_comment` | texto (aceita variáveis) |
| `notify` | texto (aceita variáveis). Vai para quem acompanha a tarefa ou, sem ninguém (ou sem tarefa), para todos. |
| `send_email` | texto do e-mail (aceita variáveis), mais `to` e `subject` (ver abaixo) |
| `set_due_in_days` | número de dias a partir de hoje |
| `move_to_active_sprint` | — |
| `move_to_sprint` | nome ou id da sprint, `active` ou `next` (a próxima planejada) |
| `assign` | nome ou e-mail do membro (é adicionado aos responsáveis) |

**`send_email`:**

- `to`: `followers` (padrão: responsáveis, observadores e relator), `assignees` (só responsáveis) ou endereços separados por vírgula. Sem tarefa (gatilhos de sprint e projeto), `followers` e `assignees` viram todos os membros.
- `subject`: assunto com variáveis; padrão `[#id] título` (ou o nome da regra, sem tarefa).
- O e-mail leva o botão "Abrir no quadro". Sem SMTP configurado, a regra fica salva mas não envia.

**Variáveis** aceitas nos textos e assuntos:

| Variável | Valor |
| --- | --- |
| `{id}` | `#12` |
| `{ref}` | código (`WEB-12`) ou `#12` |
| `{titulo}` | título da tarefa |
| `{projeto}` | nome do projeto |
| `{prazo}` | prazo ou "sem prazo" |
| `{status}` | status (rótulo) |
| `{prioridade}` | prioridade (rótulo) |
| `{sprint}` | nome da sprint (do gatilho de sprint ou da tarefa) |

**Combinações recusadas:** gatilho `status_changed` com ação `set_status` (ciclo); `project_created` com ação de tarefa; gatilhos de sprint com `set_due_in_days` ou `move_to_active_sprint`.

### 6.4 Regras de execução

- **Vale para todos.** A regra roda tanto no processo do painel quanto no MCP, então mudanças feitas pelo Claude também a disparam. Os gatilhos por tempo (`due_soon`, `overdue`) rodam só no agendador do servidor do painel.
- **Sem cascata.** Mudanças feitas por automações (ator `automação`) **não** disparam outras automações. Tarefas criadas por recorrência também não disparam `task_created`.
- **Fluxo do projeto.** `set_status` e `set_column` respeitam as transições permitidas; uma ação recusada é registrada no log e não interrompe as outras regras.
- **Gatilhos por tempo uma vez só.** `due_soon` e `overdue` disparam **uma vez por tarefa por regra** (tabela `automation_fired`).
- **Registro.** Cada execução grava um evento "automação “Nome”" no histórico da tarefa e incrementa o contador da regra.
- **Falhas isoladas.** Uma ação que falha é registrada no log e não interrompe as outras regras.

### 6.5 Modelos prontos

1. **Bloqueou → prioridade alta** (`status_changed` para bloqueada → `set_priority high`)
2. **Avisar 1 dia antes do prazo** (`due_soon` com 1 dia → `notify` "Vence logo: {ref} {titulo} ({prazo})")
3. **Atrasou → label "atrasada"** (`overdue` → `add_tag atrasada`)
4. **Bug novo → prioridade alta** (`task_created`, tipo bug → `set_priority high`)
5. **Tarefa do Claude → sprint ativa** (`task_created`, por Claude → `move_to_active_sprint`)
6. **Sprint terminou → avisar a equipe** (`sprint_completed` → `notify` "A sprint {sprint} de {projeto} terminou")
7. **Concluída → e-mail para quem acompanha** (`status_changed` para concluída → `send_email` para `followers`)

---

## 7. Notificações

### 7.1 Tipos e destinatários

| Tipo | Origem | Quem recebe | Quando |
| --- | --- | --- | --- |
| `assigned` | Atribuição | a pessoa atribuída, exceto se ela mesma se atribuiu | ao atribuir |
| `comment` | Comentário | quem acompanha a tarefa, exceto quem comentou e quem foi mencionado | ao comentar (não em edições) |
| `mention` | @menção | as pessoas citadas que podem ver o projeto, exceto quem escreveu | ao comentar, ou ao editar acrescentando a menção |
| `status` | Mudança de status | quem acompanha, exceto quem mudou | ao mudar (não quando a mudança é de uma automação) |
| `due` | Prazo chegando | responsáveis e observadores ou, sem ninguém, todos | até `due_soon_days` antes do prazo (padrão 1) |
| `overdue` | Atrasada | responsáveis e observadores ou todos | prazo passou |
| `automation` | Automação `notify` | quem acompanha ou todos | quando a regra dispara |
| `claude` | Avisos do Claude (`send_notification`) | quem o Claude indicar, ou todos | sob pedido |
| `system` | Avisos gerais do sistema (tipo padrão) | conforme o aviso | — |

"Quem acompanha" = responsáveis + observadores + relator.

### 7.2 Canais

Cada pessoa escolhe, por tipo, em Minha conta → Notificações:

| Canal | Padrão | Observações |
| --- | --- | --- |
| **No painel** (sino) | ligado | Guarda a notificação na lista do sino |
| **E-mail** | desligado | Exige SMTP configurado. Assunto `[#id] título`, texto da notificação e botão para abrir a tarefa; cabeçalho `X-Quadro-Tipo` com o tipo. |
| **macOS** | ligado | Exige "Permitir notificações do macOS" nas Configurações gerais. Aparece na Central de Notificações (via `osascript`) do Mac em que roda o processo que criou a notificação. Não existe no Docker. |

### 7.3 Regras

- **Sem repetição.** Os avisos de prazo têm uma chave única (`due:<tarefa>:<prazo>` ou `overdue:<tarefa>:<prazo>`), então saem uma vez por tarefa e prazo, em todos os canais. Se o prazo mudar, o aviso volta a valer para a nova data. Quando a pessoa desligou o canal "No painel" para esse tipo, o aviso é gravado **escondido** (`hidden = 1`) só para servir de controle: ele não aparece no sino nem conta como não lido, e o e-mail ou o macOS não se repetem.
- **Agendador.** O servidor do painel roda o `tick` 5 s depois de iniciar e depois a cada 60 s. O `tick` gera os avisos de prazo, roda as automações por tempo e sincroniza as caixas de entrada vencidas. O MCP não roda o agendador.
- **E-mails em segundo plano.** O envio não segura a requisição. Uma falha vai para o log e para "último erro de envio", mostrado nas Configurações e na Administração.

---

## 8. Usuários, papéis e permissões

### 8.1 Papel da conta

| Ação | Administrador | Membro | Visualizador |
| --- | --- | --- | --- |
| Papel nos projetos sem papel explícito | dono em todos, inclusive privados | membro nos internos e públicos | visualizador nos internos e públicos |
| Criar projetos (vira dono) | ✓ | ✓ | — |
| Usar o chat do painel | ✓ | ✓ | — |
| Labels, campos e automações globais | ✓ | — | — |
| Modelos de workflow (criar, editar, excluir, marcar padrão) | ✓ | — | — |
| Criar e excluir organizações | ✓ | — | — |
| Convidar, mudar papel de conta, desativar, remover, gerar link de senha | ✓ | — | — |
| Configurações gerais e Administração | ✓ | — | — |
| Editar o próprio perfil, foto, preferências e senha | ✓ | ✓ | ✓ |

O sistema sempre mantém **ao menos um administrador ativo** e não permite remover nem desativar a própria conta.

### 8.2 Papéis por escopo e papel efetivo

- Papéis: **dono** (`owner`), **gerente** (`manager`), **membro** (`member`) e **visualizador** (`viewer`).
- Podem ser dados no **projeto**, num **workspace** (vale para os projetos dele e dos sub-workspaces) ou na **organização** (vale para todos os projetos dela).
- **Papel efetivo** num projeto = o **mais alto** entre o papel no projeto, nos workspaces da cadeia (o do projeto e os de cima) e na organização.
- **Sem papel explícito:** projetos privados ficam invisíveis; nos internos e públicos vale o papel da conta (visualizador para contas visualizadoras, membro para as demais).
- **Administradores** são sempre donos.
- Um papel explícito substitui o da conta, inclusive para menos (uma conta membro com papel de visualizador num projeto só lê ali). **Contas visualizadoras** ficam como visualizador em todos os projetos, mesmo com um papel maior dado no projeto, no workspace ou na organização.
- **Processos locais** (MCP no seu Mac, hook) têm acesso total, a menos que `CLAUDE_TASKS_ENFORCE` esteja definida (ver [seção 11.1](#111-mcp-tarefas)).

### 8.3 O que cada nível permite no projeto

| Ação | Visualizador | Membro | Gerente | Dono |
| --- | --- | --- | --- | --- |
| Ver o projeto, tarefas, comentários, anexos, colunas, sprints, membros, dashboard, atividade e a configuração da caixa de entrada (sem senha); exportar CSV; acompanhar tarefas | ✓ | ✓ | ✓ | ✓ |
| Criar e editar tarefas: campos, arrastar, mover, subtarefas, dependências, tempo, anexos | — | ✓ | ✓ | ✓ |
| Comentar; editar e excluir os próprios comentários | — | ✓ | ✓ | ✓ |
| Criar e revogar link público de uma tarefa (em projeto privado, criar exige gerente) | — | ✓ | ✓ | ✓ |
| Excluir tarefas (uma ou em lote) | — | — | ✓ | ✓ |
| Editar e excluir comentários de outras pessoas | — | — | ✓ | ✓ |
| Editar o projeto: nome, descrição, cor, imagem, prefixo, status, prioridade, datas, workspace | — | — | ✓ | ✓ |
| Colunas, transições, aplicar workflow, salvar o fluxo do projeto como workflow | — | — | ✓ | ✓ |
| Sprints: criar, editar, iniciar, concluir, cancelar, excluir | — | — | ✓ | ✓ |
| Labels, campos e automações do projeto | — | — | ✓ | ✓ |
| Importar (CSV, Jira, Trello) e sincronizações; caixa de entrada (configurar, regras, sincronizar) | — | — | ✓ | ✓ |
| Link público do projeto (exige visibilidade pública) | — | — | ✓ | ✓ |
| Dar e tirar papéis no projeto (exceto o de dono) | — | — | ✓ | ✓ |
| Dar ou tirar o papel de dono; arquivar/desarquivar; mudar a visibilidade; excluir o projeto | — | — | — | ✓ |

### 8.4 Organizações e workspaces

- **Gerenciar** uma organização (editar, imagem, membros, criar/editar/mover/arquivar/excluir workspaces e dar papéis neles) é para administradores e para **donos e gerentes da organização**.
- Dar ou tirar o papel de **dono** exige ser dono no mesmo nível: dono do projeto (para papéis no projeto) ou **dono da organização** (para papéis na organização e nos workspaces dela). Administradores sempre podem. A regra vale na API e no MCP.
- Criar e excluir organizações é só para administradores.
- As listas de membros de organizações e workspaces podem ser vistas por qualquer conta.

### 8.5 Contas e sessões

- **Senha:** mínimo de 8 caracteres, armazenada como `scrypt$salt$hash` (salt de 16 bytes, hash de 64 bytes).
- **E-mail:** único, sem diferenciar maiúsculas.
- **Sessão:** token aleatório de 32 bytes no cookie `tk_session` (HttpOnly, SameSite=Lax e `Secure` sob HTTPS), válido por 90 dias. Sessões expiradas são limpas a cada novo login.
- **Desativar** uma conta encerra as sessões dela e bloqueia o login; tarefas e histórico continuam. Trocar a senha de outra pessoa (administrador) também encerra as sessões dela.
- **Remover** uma conta tira a pessoa de responsáveis e observadores; as tarefas continuam.
- **"Visto por último":** atualizado no máximo a cada 10 minutos.
- **Avatar:** PNG, JPEG, WebP ou GIF até 2 MB.

### 8.6 Convites e redefinição de senha

- **Convite:** token aleatório, válido por **14 dias** e de **uso único**. Pode ser travado num e-mail, leva um papel de conta e, opcionalmente, um projeto com o papel nele (padrão membro). O link é `<endereço público>/?invite=<token>`; com SMTP, pode ir por e-mail.
- **Redefinição de senha:** link `<endereço público>/?reset=<token>`, válido por **2 horas** e de uso único. Sai pelo "Esqueci a senha" (por e-mail; a resposta é a mesma exista ou não a conta) ou por um administrador (Equipe ou Administração), que recebe o link para copiar e, com SMTP, o envia por e-mail. Redefinir encerra todas as sessões da pessoa.

---

## 9. E-mail

### 9.1 SMTP (envio)

Configure em **Configurações → E-mail (SMTP)**:

| Campo | Observações |
| --- | --- |
| Servidor e porta | Padrão 587 (ou 465 com TLS direto) |
| TLS direto | Marcado: TLS desde a conexão (465). Desmarcado: STARTTLS quando o servidor oferece (587). |
| Usuário e senha | A senha é cifrada no banco e mascarada na tela (para Gmail e afins, use uma senha de app) |
| Remetente | Ex.: `Quadro de tarefas <tarefas@exemplo.com>`; sem ele, vale o usuário |
| Permitir login sem criptografia | Só para servidores na rede local. Sem isso, a senha nunca é enviada sem TLS, exceto para `localhost` |

- **Teste:** "Enviar e-mail de teste para mim" confere a conexão e o login e manda uma mensagem para o e-mail do administrador.
- **Usos:** convites, redefinição de senha, notificações por e-mail, automações "Enviar e-mail" e respostas automáticas da caixa de entrada.
- **Formato:** texto e HTML simples, com o botão de link para o painel. Os links usam o **endereço público do painel** (Configurações → Geral) ou, sem ele, `http://localhost:<porta>`.
- **Falhas:** o último erro fica visível nas Configurações e na Administração, e some no próximo envio bem-sucedido.

### 9.2 Caixa de entrada (IMAP → tarefas)

Cada projeto pode ter **uma** caixa de entrada, configurada em Configurações do projeto ou pelo MCP (`manage_inbox`):

| Campo | Padrão | Observações |
| --- | --- | --- |
| Ativa | sim | Pausar mantém a configuração |
| Endereço | — | O e-mail que as pessoas usam (só exibição) |
| Servidor IMAP, porta, TLS | porta 993, TLS ligado | Sem TLS, a senha vai sem criptografia (escolha explícita) |
| Usuário e senha | — | A senha é cifrada no banco |
| Pasta | `INBOX` | Aceita nomes acentuados |
| Tipo, prioridade, coluna e responsável padrão | tarefa, média, —, — | Valores das tarefas criadas |
| Resposta automática | desligada | Texto com `{id}`, `{titulo}` e `{link}`, mais assinatura; exige SMTP |
| Sincronizar a cada | 5 min | De 1 a 1440 minutos |

**Como cada e-mail é tratado:**

1. Mensagens já vistas (mesmo `Message-ID`) são ignoradas.
2. **Resposta a uma tarefa:** se o assunto tem `[#12]` e a tarefa 12 é deste projeto, o texto (sem a parte citada, como "Em … escreveu:" e linhas com `>`) vira **comentário** na tarefa, e os anexos vão junto. Se o remetente é membro do quadro, o comentário sai em nome dele; senão, "**Nome <e-mail>** respondeu por e-mail".
3. **E-mail novo:** vira tarefa com título = assunto (sem `Re:`, `Fwd:` etc.), descrição = texto + "— Recebido por e-mail de …", label `e-mail`, relator = remetente (se for membro), origem `e-mail` e os anexos.
4. **Regras** (em ordem): condições "remetente contém", "assunto contém" e "texto contém" (todas precisam bater, sem diferenciar maiúsculas); ações ignorar, prioridade, tipo, labels (acrescenta), responsável e coluna; "parar" encerra as regras seguintes.
5. **Resposta automática:** com SMTP e a opção ligada, responde ao remetente com `Re: [#id] título` (assim a resposta dele volta como comentário). Endereços `no-reply`, `mailer-daemon` e `postmaster` não recebem.

**Sincronização:** o agendador do servidor busca até 50 mensagens não lidas por vez nas caixas cujo intervalo venceu e as marca como lidas. Há também "Testar conexão" e "Verificar agora" (pelo MCP, `manage_inbox` com `sync`). O histórico das últimas mensagens (tarefa, comentário, ignorada ou erro) e o último erro aparecem na configuração.

### 9.3 Esqueci a senha

Veja a [seção 8.6](#86-convites-e-redefinição-de-senha). Sem SMTP, a tela de login avisa que é preciso pedir o link a um administrador.

---

## 10. Importação e exportação

Importar exige ser gerente ou dono do projeto de destino. Reimportar **atualiza** as tarefas já trazidas (casadas pelo id externo), em vez de duplicar.

### 10.1 Exportar CSV

- No menu do projeto, na Lista, em `GET /api/export.csv?project=ID&status=…` ou pelo MCP (`export_tasks`).
- UTF-8 com BOM (abre direto no Excel), separador vírgula, linhas `CRLF`.
- Colunas: ID, Código, Título, Descrição, Projeto, Status, Coluna, Prioridade, Tipo, Tags, Responsáveis, Relator, Início, Prazo, Estimativa, Gasto, Story points, Sprint, Tarefa-mãe, Criada em, Concluída em e os campos personalizados (do projeto, ou os globais quando há vários projetos).

### 10.2 Importar CSV (genérico ou exportado do Jira)

- Separador detectado sozinho (`,` ou `;`). A primeira linha é o cabeçalho, reconhecido em português ou inglês, sem diferenciar acentos:

| Campo | Cabeçalhos aceitos |
| --- | --- |
| Título (obrigatório) | título, title, summary, resumo, nome, name, task, tarefa |
| Descrição | descrição, description, detalhes, details |
| Status | status, estado, coluna, column, situação |
| Prioridade | prioridade, priority |
| Tipo | tipo, type, issue type, tipo de item |
| Labels | tags, labels, etiquetas, rótulos, label |
| Responsáveis | responsável, responsáveis, assignee, assignees, atribuído a |
| Relator | relator, reporter |
| Prazo / início | prazo, due date, due, vencimento, data limite / início, start date, start, data de início |
| Estimativa | estimativa, original estimate, estimate, tempo estimado |
| Pontos | story points, pontos, story point estimate, points |
| Sprint | sprint (criada se não existir) |
| Id externo | issue key, key, chave, id externo, external id |
| Tarefa-mãe | parent, parent id, tarefa-mãe, tarefa mãe, parent summary |

- **Valores:** status vira categoria pelo nome (ex.: "Done", "Concluído" → concluída; "In Progress", "Revisão", "QA" → em andamento; "Bloqueado", "Aguardando" → bloqueada); prioridades como Highest/Blocker/Critical → urgente, Major → alta, Minor → baixa, Trivial → mínima; datas `AAAA-MM-DD` ou `DD/MM/AAAA`; responsáveis e relator só entram se forem membros do quadro.
- **CSV do Jira** é reconhecido pelos cabeçalhos "Issue key"/"Issue Type"; a estimativa vem em segundos.
- **Reimportar um CSV exportado daqui:** quando ID e "Criada em" batem com uma tarefa do mesmo projeto, ela é atualizada.
- Linhas com erro não param a importação; o resultado traz `{ created, updated, skipped, errors[] }`.

### 10.3 Jira (API)

- Informe o site (`https://empresa.atlassian.net`), o e-mail da conta, um token de API e, opcionalmente, um JQL (padrão `ORDER BY created DESC`).
- Só `https` e hosts permitidos por `CLAUDE_TASKS_JIRA_HOSTS` (padrão `*.atlassian.net`; para um Jira próprio, acrescente o host).
- Busca até 4000 issues (40 páginas de 100) em `/rest/api/3/search/jql`. A descrição (ADF) vira texto; a tarefa-mãe vem da chave `parent`.

### 10.4 Trello (arquivo JSON ou API)

- **Arquivo:** exporte o quadro em Menu → Imprimir, exportar e compartilhar → Exportar como JSON e envie o arquivo.
- **API:** chave e token do Trello e o link (ou id) do quadro.
- **Mapeamento:** cada lista aberta vira uma coluna (categoria adivinhada pelo nome); labels viram labels do projeto com as cores do Trello; cartões viram tarefas (prazo, início, labels, membros que existirem no quadro); cartões arquivados viram tarefas arquivadas; "dueComplete" vira concluída; itens de checklist viram subtarefas (concluídas ou não).

### 10.5 Sincronizações salvas

- Ao importar pela API do Jira ou do Trello, marque **Salvar** para guardar a conexão (o token fica cifrado).
- Em Configurações do projeto, cada sincronização mostra o último resultado e pode ser **rodada de novo** (reimporta e atualiza) ou excluída.
- A sincronização é manual: não há repetição automática.

---

## 11. Integração com o Claude

### 11.1 MCP `tarefas`

Servidor MCP local (stdio) registrado no escopo de usuário, disponível em todas as sessões do Claude Code de qualquer projeto. Tem 36 ferramentas, resources, 9 prompts (comandos `/mcp__tarefas__…`) e autocompletar. **Referência completa: [MCP.md](MCP.md).**

- **Quem é "eu":** `CLAUDE_TASKS_USER` (e-mail ou nome) ou, se o quadro tem uma única conta, essa conta.
- **Permissões:** por padrão o MCP local tem acesso total (como o próprio arquivo do banco). Com `CLAUDE_TASKS_ENFORCE=1`, as ferramentas aplicam as permissões de "eu"; se "eu" não puder ser identificado, não há restrição.

### 11.2 Instrução global (`~/.claude/CLAUDE.md`)

Diz ao Claude, em todas as sessões, para:

- registrar pendências com `add_tasks` passando `project_path`, sem perguntar antes e avisando numa linha;
- mudar para `doing` ao começar uma tarefa do quadro e usar `complete_tasks` com nota ao terminar;
- conferir `list_tasks` antes de criar, para não duplicar;
- escrever títulos curtos e descrições com contexto para retomar;
- quebrar trabalho grande em subtarefas e dependências, com prazo só quando houver prazo real.

O próprio MCP também envia instruções equivalentes ao conectar, no campo `instructions` do `initialize`.

### 11.3 Hook SessionStart

`bin/session-start.js` é chamado pelo Claude Code ao abrir, limpar (`/clear`) ou compactar uma sessão. Ele:

1. lê o `cwd` da sessão pelo stdin;
2. resolve o projeto (sem criar);
3. devolve `hookSpecificOutput.additionalContext` com até 15 tarefas abertas daquele projeto.

Assim o Claude já começa sabendo o que está pendente. Ele nunca bloqueia a sessão: qualquer erro é ignorado. Para instalar, adicione em `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "/Users/voce/.local/bin/node --no-warnings /Users/voce/Developer/claude-tasks/bin/session-start.js",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

### 11.4 Chat do painel

`POST /api/chat` responde em NDJSON e usa o provedor escolhido em Configurações → IA do chat:

| Provedor | Configuração | Como roda |
| --- | --- | --- |
| `claude-cli` (padrão) | Modelo: Sonnet, Opus ou Haiku. Nada mais: usa a CLI do Claude Code instalada no computador do servidor e o seu login. | Executa `claude -p` com só o MCP do quadro (abaixo), com as permissões de quem conversa. |
| `anthropic` | Chave da API da Anthropic (cifrada), modelo (padrão `claude-opus-5-5`) e endereço opcional. Exige `npm install` (dependência opcional `@anthropic-ai/sdk`); a imagem Docker já traz. | Chama a API pelo SDK oficial e executa as ferramentas do MCP **no próprio servidor**, com as permissões de quem conversa. Se o modelo recusar por política, a API pode repetir a chamada num modelo alternativo. |
| `openai` | Endereço (padrão `https://api.openai.com/v1`; OpenRouter, Ollama, LM Studio…), modelo (obrigatório) e chave (opcional para servidores locais). | Chama `/chat/completions` com as ferramentas no formato de funções e as executa no próprio servidor, com as permissões de quem conversa. Mudanças ficam com o autor `ia`. Imagens de anexos não são repassadas ao modelo. |

**Provedor `claude-cli`:**

```
claude -p "<mensagem>" --output-format stream-json --verbose --model <sonnet|opus|haiku>
       --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{"tarefas":…}}'
       --allowedTools mcp__tarefas --append-system-prompt "<contexto>" [--resume <sessão>]
```

- **Isolamento:** `--tools ""` desliga todas as ferramentas internas (arquivos, terminal, web), e `--strict-mcp-config` carrega só o MCP do quadro.
- **Diretório e banco:** o processo roda em `data/`, com `CLAUDE_TASKS_DB` apontando para o mesmo banco e `CLAUDE_TASKS_USER` com o e-mail de quem conversa (tempo, "minhas tarefas" e notificações ficam com essa pessoa).
- **Permissões:** o MCP filho também recebe `CLAUDE_TASKS_ENFORCE=1`, então as ferramentas aplicam os papéis de quem conversa, como nos outros dois provedores (veja a [seção 15](#15-segurança)).
- **Continuidade:** o id da sessão da CLI fica em `settings` (`chat_session:<usuário>`) e a conversa continua com `--resume`.
- **Falhas:** mensagens "sintéticas" da CLI, como login expirado, viram um erro legível ("A CLI do Claude não está logada…") e não entram no histórico.

**Comum aos três:**

- **Quem usa:** qualquer conta logada, exceto visualizadores (403). Nos três provedores, o assistente só vê e muda o que a pessoa pode ver e mudar.
- **Um envio por vez:** cada pessoa tem uma conversa ativa; um segundo envio simultâneo recebe 409.
- **Histórico:** fica em `chat_messages` (o painel mostra as últimas 60 mensagens; os provedores de API recebem as últimas 20 como contexto). "Nova conversa" apaga o histórico e a sessão da CLI.
- **Passos:** os provedores de API fazem até 15 rodadas de ferramentas por mensagem.
- **Cancelamento:** fechar a conexão encerra o processo da CLI.

### 11.5 Mapa do código

O Mapa do código é um plugin para Claude Code e Codex que desenha um mapa interativo do código de um projeto: partes, arquivos, endpoints, telas e as ligações entre eles, com nomes e descrições em português simples, verificação de saúde, fluxos e trabalho recente. É uma tradução e adaptação do [Floorplan](https://github.com/haydenschmitty/floorplan) 0.6.0 (MIT). O quadro mostra o mapa na aba **Mapa do código**, liga as tarefas aos arquivos e cria tarefas a partir dele. **Guia de uso completo: [MAPA.md](MAPA.md).**

| Peça | Onde | Papel |
| --- | --- | --- |
| Plugin | `mapa/` (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `skills/mapa-do-codigo/`) | O skill que o Claude e o Codex seguem, os scripts Node sem dependências (varredura, montagem, descrições, atualização, plantas) e os arquivos copiados para cada projeto (visualizador, servidor, consulta) |
| Marketplaces | `.claude-plugin/marketplace.json` (marketplace `claude-tasks`, plugin `mapa-do-codigo`, fonte `./mapa`) e `.agents/plugins/marketplace.json` (Codex) | Instalação a partir desta pasta: `claude plugin marketplace add ~/Developer/claude-tasks` e `claude plugin install mapa-do-codigo@claude-tasks` |
| Mapa gerado | `<projeto>/mapa-do-codigo/` | `index.html`, `grafo.json`, `arquitetura.json`, `descricoes/`, `servidor.mjs`, `servidor-nucleo.mjs`, `consulta.mjs` e outros ([MAPA.md § 9](MAPA.md#9-arquivos-no-seu-projeto)); a pasta se ignora no git |
| Integração | `src/mapa.js` | Rota `/mapa/<id>/`, situação do mapa, tarefas ligadas aos arquivos, tarefas criadas pelo mapa e consulta |
| Aba | `public/js/mapa.js` | A aba no painel, só em projetos com pasta: instruções quando não há mapa, ou o mapa num iframe com **Pedir atualização ao Claude** e **Abrir em outra aba**, e a **Simulação** (gargalos, cenários, ocupação, premissas) |
| Simulação | `mapa/skills/mapa-do-codigo/scripts/breakscale.mjs` e `scripts/lib/breakscale*.mjs` | Rascunho do modelo do Breakscale a partir do mapa, simulação pelo pacote `breakscale-mcp` (MCP por stdio, ou HTTP com `--remoto`), leitura do resultado e escolha dos gargalos ([MAPA.md § 7.7](MAPA.md#77-simulação-no-breakscale)) |
| MCP | `code_map` em `src/mcp/tools-extra.js` | Consulta ao mapa, só leitura ([MCP.md](MCP.md#code_map)) |
| Testes | `mapa/test/*.test.mjs` (plugin) e `test/mapa.test.js` (integração) | Rodam no `npm test` |

**Como o quadro serve o mapa.**

- `src/server.js` entrega os caminhos `/mapa/…` a `handleMapRoute` antes dos arquivos estáticos. Sem sessão, redireciona para `/`; `/mapa/<id>` ganha a barra final (301). Projeto inexistente ou sem leitura mostra "Mapa não encontrado" (404), sem dizer qual dos dois.
- O mapa é lido da pasta `mapa-do-codigo/` dentro de `projects.path`. Sem pasta, sem a pasta no disco ou sem `index.html`, a página explica o que falta e a API da página responde 404.
- A página e a API dela usam `createMapServer({ root, mapDir, skillDir })` de `mapa/skills/mapa-do-codigo/assets/servidor-nucleo.mjs`, o mesmo núcleo do servidor autônomo (`node mapa-do-codigo/servidor.mjs`). Há um núcleo por projeto, recriado se a pasta do projeto muda e fechado no desligamento do servidor (`closeMapServers`).
- `core.page({ board })` injeta em `window.FLOORPLAN_SERVER` o token da página e `board: { projectId, projectName, canEdit, canManage }`. Sem gestão, a chave **Alterar** da planta vem desligada. A API do núcleo exige o token (`x-floorplan-token`) e a mesma origem; uma cópia exportada não leva `board`.
- `/mapa/<id>/api/*` vai para `core.handle(…, { allowAsk, allowChange, allowFlows, user })` (rotas `ask`, `cancel`, `flows`, `plan/undo`, `export`, `events`, `status` e `health`), exceto `api/quadro/tarefas`, que é do quadro. Com `user`, o **Parar** de cada pessoa só interrompe as perguntas dela. Fora `GET` e `HEAD`, todo pedido exige `Origin` permitido (403).
- Cabeçalhos da página: `X-Frame-Options: SAMEORIGIN` (o painel a mostra num iframe), `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` e `Referrer-Policy: same-origin`.
- O iframe e o painel conversam por `postMessage` da mesma origem. O painel trata `mapa:abrir-tarefa` (abre o detalhe da tarefa) e `mapa:tarefa-criada` (recarrega o quadro); o mapa trata `mapa:tarefas-mudaram` (busca as tarefas de novo) e também as busca ao voltar a ficar visível. Fora do iframe, abrir uma tarefa abre `/?task=<id>` numa aba nova.
- A aba não é redesenhada pelas atualizações ao vivo do quadro. O próprio mapa se recarrega quando `index.html` muda (o núcleo observa o arquivo e avisa as abas pelo stream de eventos).
- `grafo.json` é lido com cache pela data de modificação.

**Permissões** (papel efetivo no projeto, [seção 8](#8-usuários-papéis-e-permissões)):

| Ação | Exige |
| --- | --- |
| Ver o mapa, Saúde, telas e fluxos; ver as tarefas ligadas; exportar; `GET /api/projects/:id/mapa` e `/mapa/consulta`; `code_map` | leitura |
| Criar tarefas pelo mapa; pedir novos fluxos (`allowFlows`) | edição |
| Perguntar ao mapa (`allowAsk`) | edição, e conta que não seja visualizadora |
| Alterar a planta e desfazer (`allowChange`) | gestão |

As perguntas rodam a CLI do Claude Code (ou o Codex) **no computador do quadro**, na pasta do projeto e com o login de quem mantém o quadro, sempre com ferramentas só de leitura. No Docker não há CLI, então perguntar não funciona; o resto do mapa funciona se a pasta do projeto estiver montada no contêiner no mesmo caminho (o `Dockerfile` copia `mapa/` para a imagem, sem `mapa/test`).

**Tarefas ligadas aos arquivos** (`tasksOnMap`). Entram as tarefas do projeto abertas ou concluídas nos últimos 14 dias (até 2000). No título e na descrição, trechos com cara de caminho de arquivo (`src/db.js`, `db.js:120`, `web/app/page.tsx`) são comparados com os arquivos de `grafo.json`, sem diferenciar maiúsculas: um caminho com pasta liga ao arquivo igual e aos que terminam com `/<caminho>`; só o nome do arquivo liga quando um único arquivo do mapa tem esse nome. Tarefas criadas pelo mapa com origem `card` ou `construir` também ficam presas ao cartão de origem (lido do `external_id`), e as de um gargalo da simulação, ao cartão `n:<componente>`, quando o componente é uma parte do mapa. `GET /mapa/<id>/api/quadro/tarefas` devolve `{ tasks: [{ id, ref, title, status, priority, done, files, cards }] }`, só com as tarefas que citam algum arquivo ou têm cartão de origem. O mapa conta nos selos só as abertas.

**Tarefas criadas pelo mapa** (`taskFromMap`). `POST /mapa/<id>/api/quadro/tarefas` recebe `{ title, description, priority, tags, origin: { kind, id } }`, com `kind` em `saude`, `revisao`, `construir`, `simulacao` ou `card`:

- grava `external_source = 'mapa'` e `external_id = '<kind>:<id>'`. Para `saude`, `revisao`, `construir` e `simulacao`, se já existe uma tarefa do projeto com essa origem (aberta ou não), devolve ela com `duplicate: true`; para `card` não há essa trava (o `external_id` ganha um sufixo `#<momento>`), então um cartão pode ter várias tarefas. A regra geral de título duplicado vale em todos os casos;
- tipo `bug` para `saude` com prioridade `high` e `task` nos demais casos; label `mapa` mais até 6 labels enviadas; prioridade enviada ou `medium`;
- o ator é a pessoa logada (`{ author: 'user', user_id }`), então automações e notificações rodam como em qualquer tarefa criada no painel;
- exige edição no projeto (403) e título (400).

**Código do projeto.** O quadro nunca executa código que esteja na pasta de um projeto: a pasta pode ter vindo de qualquer lugar (um clone, por exemplo), e o quadro roda com a sua conta. O núcleo usa o código de consulta do próprio plugin (`querySource`, de `mapa/skills/mapa-do-codigo/assets/graph-query.js`), e a consulta da API e da `code_map` roda a CLI do plugin apontando para os dados do projeto (`MAPA_GRAFO_DIR`). Da pasta do projeto, o quadro só lê dados: `index.html`, `grafo.json` e os arquivos de fluxos e da planta. O `servidor.mjs` e o `consulta.mjs` gravados ali servem só para usar o mapa fora do quadro.

**Simulação no Breakscale** (`readSimulation`, `simulationFile`, `simulationTasks`, `taskFromSimulation`). O `breakscale.mjs` do plugin grava `mapa-do-codigo/simulacao.json` (esquema `mapa/simulacao@1`) e `simulacao.breakscale`; o quadro só lê, nunca simula. O resultado é lido com cache pela data de modificação e passa por uma limpeza campo a campo: só as chaves esperadas, textos com tamanho máximo, números finitos, `severidade` em `alta`/`media`/`baixa`, e links só se começarem com `https://breakscale.tech/` (os outros viram `null`). `GET /api/projects/:id/mapa/simulacao` devolve isso mais `tarefas` (id do gargalo → tarefa), ou 404; `…/simulacao/arquivo` entrega o `.breakscale` como anexo, só se o JSON tiver `app: "breakscale"`. `POST …/simulacao/tarefas` (`{ ids }` ou `{ id }`, até 100, edição no projeto) cria cada tarefa por `taskFromMap` com origem `simulacao`: uma por gargalo (`duplicate: true` na repetição), título, porquê, sugestão e link tirados do arquivo gravado (nunca do pedido), prioridade `high`/`medium`/`low` pela urgência, label `simulação`. Gargalo desconhecido dá 404. Uma tarefa de gargalo fica presa ao cartão `n:<componente>` do mapa quando o id do componente é uma parte do mapa. `mapStatus` ganha `simulation: { generated_at, scenarios, bottlenecks, urgent }` (ou `null`).

**Consulta** (`queryMap`). `GET /api/projects/:id/mapa/consulta?arg=…` (até 6 `arg`) e a `code_map` rodam a CLI de consulta do plugin sobre o `mapa-do-codigo/grafo.json` do projeto, com limite de 30 s, e devolvem o texto (`{ text }` na API). `GET /api/projects/:id/mapa` devolve a situação: `available`, `reason`, `exists`, `folder`, `generated_at`, `agent`, `blueprint`, `files`, `parts`, `screens`, `endpoints`, `health: { total, high }` e `recent`.

---

## 12. Modelo de dados

Datas e horas são ISO 8601 em UTC (`created_at` etc.). Datas de calendário (`start_date`, `due_date`) são `AAAA-MM-DD` no fuso local. JSON é guardado como texto. As chaves estrangeiras estão ligadas (`PRAGMA foreign_keys = ON`).

### organizations / workspaces / memberships
- `organizations`: `id, name, description, website, color, avatar, archived_at, created_at`
- `workspaces`: `id, organization_id → organizations (CASCADE), parent_id → workspaces (CASCADE), name, description, color, position, archived_at, created_at`
- `memberships`: `(scope, scope_id, user_id)` PK, `scope` (`organization`/`workspace`/`project`), `user_id → users (CASCADE)`, `role` (`owner`/`manager`/`member`/`viewer`), `created_at`. Sem chave estrangeira para o escopo: os papéis são apagados à mão ao excluir projeto, workspace ou organização.

### projects
| Coluna | Tipo | Notas |
| --- | --- | --- |
| id | INTEGER PK | |
| name, description | TEXT | |
| path | TEXT UNIQUE | raiz do repositório; NULL em projetos sem pasta |
| color, avatar | TEXT | hex (NULL = cor derivada do nome); arquivo em `avatars/` |
| workspace_id | → workspaces | SET NULL |
| key | TEXT | prefixo; índice único sem diferenciar maiúsculas |
| status | TEXT | CHECK planning/active/on_hold/completed/cancelled |
| priority | TEXT | CHECK lowest/low/medium/high/urgent |
| visibility | TEXT | CHECK private/internal/public |
| start_date, end_date | TEXT | AAAA-MM-DD |
| next_number | INTEGER | próximo número de tarefa no projeto |
| archived_at, created_at | TEXT | |

### tasks
| Coluna | Tipo | Notas |
| --- | --- | --- |
| id | INTEGER PK | número global |
| project_id | → projects | CASCADE |
| number | INTEGER | sequencial no projeto; índice único `(project_id, number)` |
| title, description | TEXT | |
| status | TEXT | CHECK todo/doing/blocked/done |
| priority | TEXT | CHECK lowest/low/medium/high/urgent |
| type | TEXT | CHECK task/bug/story/epic |
| tags | TEXT (JSON) | lista de nomes |
| source | TEXT | claude / user / automação / e-mail / ia / você |
| parent_id | → tasks | CASCADE |
| sprint_id | → sprints | SET NULL |
| column_id | → columns | SET NULL |
| reporter_id | → users | SET NULL |
| start_date, due_date | TEXT | AAAA-MM-DD |
| estimate_minutes, remaining_minutes | INTEGER | estimativa original e restante |
| story_points | REAL | |
| rank | REAL | ordem na coluna |
| recurrence | TEXT (JSON) | `{freq, interval, weekdays?, monthday?, until?, count?, n?}` |
| recurrence_next_id | INTEGER | próxima ocorrência já criada |
| external_source, external_id | TEXT | jira/trello/csv/email + id; índice único quando há id |
| archived_at | TEXT | |
| created_by | → users | SET NULL |
| created_at, updated_at, completed_at | TEXT | |

### notes (histórico e comentários)
| Coluna | Notas |
| --- | --- |
| task_id → tasks (CASCADE) | |
| kind | `note` (comentário) ou `event` |
| author | claude / user / automação / e-mail / ia / você |
| user_id → users (SET NULL) | quem, quando é uma pessoa |
| parent_id → notes (CASCADE) | comentário respondido |
| body, created_at, edited_at | |

### columns / column_transitions / workflows
- `columns`: `id, project_id → projects (CASCADE), name, status (categoria), color, position`
- `column_transitions`: `(from_column_id, to_column_id)` PK, ambos `→ columns (CASCADE)`, `project_id → projects (CASCADE)`
- `workflows`: `id, name, description, columns (JSON [{name, status, color}]), transitions (JSON [[índice_de, índice_para]]), is_default, created_at`

### sprints
`id, project_id → projects (CASCADE), name, goal, status (planning/active/completed/cancelled), start_date, end_date, created_at, completed_at, committed_tasks, committed_points`

### dependencies
`task_id → tasks, blocked_by → tasks` (PK composta, ambos CASCADE, CHECK task_id ≠ blocked_by), `type` (finish_start/start_start/finish_finish/start_finish), `created_at`

### assignees / task_watchers
`(task_id → tasks, user_id → users)` PK composta, ambos CASCADE

### labels / custom_fields / task_field_values
- `labels`: `id, project_id → projects (CASCADE; NULL = global), name, color, description, created_at`; índice único `(projeto, nome)` sem diferenciar maiúsculas
- `custom_fields`: `id, project_id → projects (CASCADE; NULL = global), name, type (text/number/date/boolean/select/multi_select/user/url), options (JSON), required, position, created_at`
- `task_field_values`: `(task_id → tasks, field_id → custom_fields)` PK, ambos CASCADE, `value` (JSON)

### time_entries
`id, task_id → tasks (CASCADE), user_id → users (SET NULL), author, started_at, ended_at (NULL = rodando), minutes, note, created_at`

### attachments
`id, task_id → tasks (CASCADE), name, stored (nome do arquivo), mime, size, author, user_id, created_at`

### shares
`token PK, kind (task/project), target_id, created_by → users (SET NULL), created_at, expires_at (NULL = sem validade), revoked_at`

### users / sessions / invites / password_resets / user_settings
- `users`: `id, name, email (UNIQUE NOCASE), password_hash, role (admin/member/viewer), color, avatar, disabled_at, created_at, last_seen_at`
- `sessions`: `token PK, user_id → users (CASCADE), created_at, expires_at`
- `invites`: `token PK, email, role (admin/member/viewer), project_id → projects (CASCADE), project_role (owner/manager/member/viewer), created_by, created_at, expires_at, used_at, used_by`
- `password_resets`: `token PK, user_id → users (CASCADE), created_at, expires_at, used_at`
- `user_settings`: `(user_id → users (CASCADE), key)` PK, `value` (JSON). Chaves: `language`, `theme`, `default_view`, `notify` (`{ tipo: { app, email, os } }`)

### notifications
`id, user_id → users (CASCADE; NULL = modo sem contas), task_id → tasks (CASCADE), key (deduplicação), type, body, hidden (1 = guardada só para não repetir o aviso; fora do sino e da contagem), read_at, created_at`

### automations / automation_fired
- `automations`: `id, project_id (NULL = todos), name, trigger, conditions (JSON), action (JSON {type, value, to?, subject?}), enabled, run_count, last_run_at, created_at`
- `automation_fired`: `(automation_id, task_id)` PK, `fired_at`, usada pelos gatilhos por tempo

### inboxes / inbox_rules / inbox_messages
- `inboxes`: `id, project_id → projects (UNIQUE, CASCADE), enabled, address, imap_host, imap_port, imap_secure, imap_user, imap_pass (cifrada), mailbox, default_type, default_priority, default_column_id, default_assignee_id, auto_reply, auto_reply_template, signature, sync_minutes, last_sync_at, last_error, created_at`
- `inbox_rules`: `id, inbox_id → inboxes (CASCADE), name, position, enabled, conditions (JSON), actions (JSON), stop, created_at`
- `inbox_messages`: `id, inbox_id → inboxes (CASCADE), uid, message_id, from_address, from_name, subject, received_at, status (task/comment/ignored/error), task_id → tasks (SET NULL), error, created_at`; índice único `(inbox_id, message_id)`

### external_syncs
`id, project_id → projects (CASCADE), kind (jira/trello), config (JSON; token cifrado), last_sync_at, last_result (JSON), created_at`

### ui_commands
`id, user_id → users (CASCADE), command (JSON), created_at, consumed_at`: pedidos do Claude para abrir algo no painel

### settings
`key PK, value (JSON)`. Chaves: `notify_macos` (true), `due_soon_days` (1), `chat_model` ("sonnet"), `base_url`, `default_language` ("pt"), `smtp_host`, `smtp_port` (587), `smtp_secure`, `smtp_user`, `smtp_pass` (cifrada), `smtp_from`, `smtp_allow_insecure`, `smtp_last_error`, `ai_provider` ("claude-cli"), `ai_base_url`, `ai_api_key` (cifrada), `ai_model` e `chat_session:<usuário>`.

### chat_messages
`id, user_id, role (user/assistant), body, tools (JSON), created_at`

### Índices
Os índices cobrem os acessos mais comuns:

- `tasks(project_id, status)`, `tasks(parent_id)`, `tasks(sprint_id)`, `tasks(due_date)`, `tasks(project_id, number)` único, `tasks(external_source, external_id)` único parcial
- `projects(key)` único parcial, `labels(projeto, nome)` único, `inbox_messages(inbox_id, message_id)` único parcial
- `notes(task_id)`, `dependencies(blocked_by)`, `time_entries(task_id)`, `attachments(task_id)`
- `notifications(user_id, read_at)`, `notifications(key)`

---

## 13. Migrações e backups

### 13.1 Como as migrações rodam

O esquema é versionado por `PRAGMA user_version`. Ao abrir o banco, `migrate()` faz o seguinte:

1. Se a versão do banco é menor que a do código **e já existem dados**, salva antes um backup com `VACUUM INTO data/backup-v<versão atual>-<timestamp>.db`.
2. Se alguma migração pendente **reconstrói tabelas**, desliga as chaves estrangeiras (`PRAGMA foreign_keys = OFF`, que só vale fora de transação). Sem isso, o `DROP TABLE` apagaria em cascata.
3. Aplica **todas** as migrações pendentes dentro de um único `BEGIN IMMEDIATE`, o que evita corrida entre processos.
4. Nas reconstruções, roda `PRAGMA foreign_key_check` antes do COMMIT e aborta (ROLLBACK) se houver referência quebrada.
5. Atualiza `user_version`, confirma e religa as chaves estrangeiras.

| Versão | Conteúdo |
| --- | --- |
| 1 | Projetos, tarefas e notas (quadro original) |
| 2 | Usuários, sessões, convites, colunas, sprints, dependências, responsáveis, tempo, anexos, notificações, automações, configurações, chat. Novos campos em tarefas, projetos e notas. Só **adiciona** tabelas e colunas. |
| 3 | Paridade com o Taskosaur. **Reconstrói** `users` (papel `viewer`, avatar, desativação), `invites` (papel `viewer`, projeto e papel no projeto), `sprints` (status `cancelled`) e `tasks` (número por projeto, prioridade `lowest`, relator, estimativa restante, pontos, origem externa), porque o SQLite não altera `CHECK` de tabela existente. Numera as tarefas por projeto. Cria organizações ("Minha organização"), workspaces ("Geral") e papéis, e põe todos os projetos no workspace "Geral". Acrescenta aos projetos workspace, prefixo, status, prioridade, visibilidade, datas, imagem e próximo número; aos comentários, resposta e edição; às dependências, o tipo; às notificações, o tipo. Cria labels, campos personalizados e valores, observadores, workflows, transições, links públicos, preferências por usuário, redefinição de senha, caixas de entrada (com regras e mensagens), sincronizações externas e comandos para o painel. |
| 4 | Guarda o compromisso das sprints ao concluir (`committed_tasks`, `committed_points`), para a velocidade não mostrar planejado = feito. |
| 5 | `notifications.hidden`: avisos com chave guardados escondidos quando a pessoa desligou o canal "No painel", para o e-mail e o macOS não se repetirem a cada minuto. |

### 13.2 Backups

| Tipo | Arquivo | Quando |
| --- | --- | --- |
| Antes de migrar | `backup-v<versão>-<timestamp>.db` | Automático, a cada atualização com migração |
| Manual | `backup-manual-<data e hora>.db` | Administração → Criar backup agora (`POST /api/admin/backup`) |

Os dois tipos aparecem em Administração → Backups, onde podem ser baixados e excluídos. Para restaurar, siga a [seção 3.7](#37-dados-e-backup). Lembre que os backups do banco não incluem anexos, avatares nem o `secret.key`.

---

## 14. API REST

Base: `http://localhost:4317/api`. A referência completa, com todos os campos, respostas e exemplos, é gerada pelo próprio servidor:

- **Documento OpenAPI 3.1:** `GET /api/openapi.json` (público).
- **Visualizador:** `/docs/api` no painel (também em Minha conta → Documentação da API e na paleta ⌘K). `/api/docs` redireciona para lá.

### 14.1 Regras gerais

- **Formato:** requisições e respostas em JSON, exceto uploads, downloads, exportação CSV, chat (NDJSON) e eventos (SSE).
- **Erros:** `{ "error": "mensagem" }`, com 400 (validação), 401 (sem login), 403 (permissão, origem ou host), 404, 409 (conflito), 413 (corpo grande), 415 (Content-Type) ou 502 (falha de um servidor externo: SMTP, IMAP, Jira, Trello).
- **Autenticação:** cookie `tk_session`. As rotas públicas não exigem login.
- **POST, PATCH e PUT:** exigem `Content-Type: application/json` (exceto uploads) e, se houver `Origin`, que ele seja um host permitido. JSON até 1 MB.
- **Uploads** (anexos, avatares, importação de CSV e de arquivo do Trello): corpo binário até 26 MB, cabeçalho `Content-Type` e `Origin` obrigatório; anexos usam `X-Filename` (URI-encoded).
- **Permissões:** cada rota confere o papel no projeto (seção 8). Projeto inexistente é 404 até para administradores.

### 14.2 Rotas por área

| Área | Rotas principais | Quem pode |
| --- | --- | --- |
| Autenticação | `GET /auth/me`, `POST /auth/setup`, `POST /auth/login`, `POST /auth/logout`, `POST /auth/forgot`, `GET`/`POST /auth/reset/:token`, `GET /invites/:token`, `POST /invites/:token/accept` | público |
| Links públicos e avatares | `GET /public/:token`, `GET /public/:token/attachments/:id`, `GET /avatars/:arquivo` | público |
| Sessão e tempo real | `GET /version`, `GET /events` (SSE), `GET /ui-commands`, `GET`/`PATCH /me/settings`, `POST`/`DELETE /me/avatar` | login |
| Quadro e busca | `GET /state?project=&archived=1`, `GET /search?q=` | leitura (filtra os projetos visíveis) |
| Tarefas | `GET`/`PATCH`/`DELETE /tasks/:id`, `POST /tasks`, `POST /tasks/bulk`, `POST /tasks/:id/notes`, `POST`/`DELETE /tasks/:id/blockers[/:bid]`, `POST /tasks/:id/watch` | leitura / edição / gestão (excluir) |
| Comentários | `PATCH`/`DELETE /notes/:id` | autor ou gestão |
| Tempo e anexos | `POST /tasks/:id/timer`, `POST /tasks/:id/time`, `DELETE /time/:id`, `GET /time-report`, `POST /tasks/:id/attachments`, `GET`/`DELETE /attachments/:id` | edição (leitura para baixar e relatório) |
| Links públicos | `POST /tasks/:id/shares`, `GET`/`POST /projects/:id/shares`, `DELETE /shares/:token` | edição (tarefa) / gestão (projeto) |
| Projetos | `POST /projects`, `PATCH`/`DELETE /projects/:id`, `POST /projects/:id/avatar`, `GET`/`POST /projects/:id/members` | conta não visualizadora / gestão / dono |
| Colunas e fluxo | `GET`/`POST /projects/:id/columns`, `PATCH`/`DELETE /columns/:id`, `GET`/`PUT /projects/:id/transitions`, `POST /projects/:id/workflow` | leitura / gestão |
| Sprints | `GET`/`POST /projects/:id/sprints`, `PATCH`/`DELETE /sprints/:id`, `POST /sprints/:id/start`, `/complete`, `/cancel` | leitura / gestão |
| Labels e campos | `GET`/`POST /labels`, `PATCH`/`DELETE /labels/:id`, `GET`/`POST /fields`, `PATCH`/`DELETE /fields/:id` | gestão (do projeto) / admin (globais) |
| Exportação e importação | `GET /export.csv`, `POST /projects/:id/import/csv`, `/import/trello-file`, `/import/jira`, `/import/trello`, `GET /projects/:id/syncs`, `POST /syncs/:id/run`, `DELETE /syncs/:id` | leitura (exportar) / gestão |
| Caixa de entrada | `GET`/`PUT`/`DELETE /projects/:id/inbox`, `POST /projects/:id/inbox/test`, `/sync`, `POST`/`PATCH`/`DELETE /projects/:id/inbox/rules[/:id]` | leitura / gestão |
| Workflows | `GET`/`POST /workflows`, `POST /workflows/from-project/:id`, `PATCH`/`DELETE /workflows/:id` | admin (salvar do projeto: gestão) |
| Organizações e workspaces | `GET`/`POST /organizations`, `PATCH`/`DELETE /organizations/:id`, `POST /organizations/:id/avatar`, `GET`/`POST /organizations/:id/members`, `GET`/`POST /workspaces`, `PATCH`/`DELETE /workspaces/:id`, `GET`/`POST /workspaces/:id/members` | admin / gestão da organização |
| Dashboard e atividade | `GET /stats?project=`, `GET /activity?project=&user=&author=&kind=&since=&until=&q=&limit=&offset=` | leitura |
| Automações | `GET`/`POST /automations`, `PATCH`/`DELETE /automations/:id` | gestão (do projeto) / admin (globais) |
| Equipe | `GET`/`POST /users`, `PATCH`/`DELETE /users/:id`, `POST /users/:id/reset-link`, `POST /users/:id/avatar`, `GET`/`POST /invites`, `DELETE /invites/:token` | admin (o próprio perfil: a pessoa) |
| Notificações | `GET /notifications`, `POST /notifications/read` | login |
| Configurações | `GET`/`PATCH /settings`, `POST /settings/test-email` | login para ler (resumo) / admin |
| Administração | `GET /admin/overview`, `POST /admin/backup`, `GET`/`DELETE /admin/backups/:arquivo`, `POST /admin/maintenance` (`vacuum` ou `cleanup`) | admin |
| Chat | `GET`/`DELETE /chat`, `POST /chat` (NDJSON) | login, exceto visualizadores |
| Mapa do código | `GET /projects/:id/mapa` (situação), `GET /projects/:id/mapa/consulta?arg=…` (consulta, até 6 `arg`) | leitura |
| Documentação | `GET /openapi.json` | público |

Fora de `/api`, a página do mapa de cada projeto fica em `/mapa/:id/`, com a API própria em `/mapa/:id/api/…` (perguntar, fluxos, planta, exportar e `quadro/tarefas`), com login e as permissões da [seção 11.5](#115-mapa-do-código).

### 14.3 Campos de tarefa (POST e PATCH)

- `title`, `description`, `status`, `priority`, `type`, `tags` (lista ou texto separado por vírgulas);
- `column` (id, nome ou status), `start_date`, `due_date`;
- `estimate`/`estimate_minutes`, `remaining`/`remaining_minutes`, `story_points`;
- `parent_id` (id ou código), `sprint` ou `sprint_id` (id, nome, `"active"`, `"next"`, `null`);
- `assignees` (ids, nomes ou e-mails) ou `assignee_ids`, `watchers`, `reporter`/`reporter_id`;
- `fields` (`{ "nome ou id": valor }`; vazio apaga);
- `blocked_by` (lista de ids/códigos ou `{ id, type }`; substitui), `recurrence` (objeto da seção 4.9 ou `null`);
- `rank`, `archived` (bool), `project_id` (mover).

`POST /tasks/bulk` recebe `{ ids, patch }` ou `{ ids, delete: true }`.

### 14.4 Streams

- **Chat (`POST /chat`):** uma linha JSON por evento: `{"type":"tool","name":"add_tasks"}`, `{"type":"text","text":"…"}`, `{"type":"error","message":"…"}` e, no fim, `{"type":"done"}`.
- **Eventos (`GET /events`):** `hello`, `change`, `unread` e `ui`, como na [seção 2.5](#25-tempo-real).

---

## 15. Segurança

| Ameaça | Proteção |
| --- | --- |
| Acesso de outras máquinas | O servidor escuta só em `127.0.0.1` por padrão |
| DNS rebinding | O cabeçalho `Host` precisa estar na lista permitida (`localhost:<porta>`, `127.0.0.1:<porta>` e `CLAUDE_TASKS_HOSTS`); senão, 403. `*` desliga a conferência: use só atrás de um proxy que valida o domínio. |
| CSRF (outro site chamando a API) | POST, PATCH, PUT e DELETE com `Origin` de fora são recusados. JSON obrigatório força preflight CORS (que o servidor não responde). Uploads exigem `Origin`. Cookie `SameSite=Lax`. |
| Sessão interceptada | Cookie `HttpOnly`; `Secure` quando a conexão é HTTPS ou o proxy informa `X-Forwarded-Proto: https` |
| Senhas | scrypt com salt por usuário; comparação em tempo constante; "Esqueci a senha" não revela se o e-mail existe |
| Segredos no banco | Senhas de SMTP e IMAP, chaves de API e tokens de sincronização cifrados com AES-256-GCM; a chave fica em `data/secret.key` (0600), fora do banco. A API devolve só `••••••••`. |
| Permissões | Conferidas no servidor em toda rota (papel efetivo por projeto); o painel só esconde o que não pode. Referências cruzadas (mover para outro projeto, tarefa-mãe, dependências) exigem acesso ao outro projeto. Busca, menções e listas respeitam os projetos visíveis. |
| Links públicos | Token aleatório de 144 bits, só leitura, sem e-mails nem tempo; validade e revogação; projeto só enquanto for público; tarefa de projeto privado só por gerentes e donos; página `noindex` |
| Anexos maliciosos | Download com `X-Content-Type-Options: nosniff` e `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`. Só imagens, PDF e vídeo abrem inline. Nome saneado e arquivo gravado com nome gerado. |
| XSS no Markdown | Todo texto é escapado antes da formatação; links e imagens só aceitam `http(s):`, `mailto:`, `/api/attachments/` e `/api/public/` |
| Páginas do painel | `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin` |
| SSRF na importação | Jira só por `https` e hosts de `CLAUDE_TASKS_JIRA_HOSTS`; Trello só `api.trello.com`; redirecionamentos recusados |
| E-mail | A senha SMTP/IMAP não é enviada sem TLS (exceto para `localhost` ou por escolha explícita) |
| Chat | Nos três provedores, as ferramentas aplicam as permissões de quem conversa (`claude-cli`: o MCP filho recebe `CLAUDE_TASKS_USER` e `CLAUDE_TASKS_ENFORCE=1`; `anthropic` e `openai`: ferramentas executadas no servidor com essa pessoa). A CLI roda sem ferramentas internas (`--tools ""`) e só com o MCP do quadro. Visualizadores não usam o chat. |
| MCP | Roda localmente, com o mesmo usuário do sistema, sem autenticação (quem pode rodar processos no Mac já pode ler o banco). Exclusões exigem `confirm: true`. `CLAUDE_TASKS_ENFORCE` aplica as permissões de "eu". Não há ferramenta para convites, papéis de conta ou senhas. |
| Mapa do código | Página e API com o login e os papéis do quadro; gravações exigem `Origin` permitido; a página só abre em iframe da mesma origem (`SAMEORIGIN`); perguntas e alterações de planta rodam a IA com ferramentas só de leitura, e só o servidor grava os arquivos do plano. Detalhes na [seção 11.5](#115-mapa-do-código) e em [MAPA.md § 10](MAPA.md#10-privacidade-e-segurança). |
| Perda de dados | Backup automático antes de cada migração, backup manual pela Administração, transações em toda gravação, conferência de chaves estrangeiras nas reconstruções |

Não há limite de tentativas de login: em rede aberta, mantenha o painel atrás de um proxy ou VPN.

---

## 16. Desenvolvimento e testes

```bash
npm start   # painel em http://localhost:4317 (use outra porta para não brigar com o serviço)
npm test    # 237 testes: 67 do quadro em 6 arquivos (test/, com bancos temporários) e 170 do plugin do Mapa do código em 19 arquivos (mapa/test/)
npm run i18n:check   # confere os dicionários do painel (scripts/i18n.js)
npm run mcp # servidor MCP no terminal (stdio)
```

| Arquivo | O que testa |
| --- | --- |
| `test/api.test.js` | Servidor real numa porta livre: primeiro acesso, Host/Origin, quadro completo, convites, automações |
| `test/mcp.test.js` | MCP real via stdio: lista das 36 ferramentas e anotações, tarefas, projetos, sprints, tempo, anexos, resources, prompts, erros e o hook |
| `test/mail.test.js` | SMTP (AUTH, recusas, TLS obrigatório), IMAP (literais, limites, login) e MIME (codificações, multipart, anexos) contra servidores falsos |
| `test/permissions.test.js` | Projetos privados, referências cruzadas, dono × gerente, automações de gerente, visualizador, comentários e menções, links públicos, workspaces aninhados, SSE, redefinição de senha |
| `test/features.test.js` | Prefixos, 5 prioridades e pontos, labels, campos, transições, workflows, dependências, recorrência, velocidade, CSV, Jira, Trello, caixa de entrada, segredos, busca |
| `test/mapa.test.js` | Mapa do código no quadro: situação sem e com mapa, login e iframe, visualizador e projeto privado, tarefas ligadas aos arquivos, tarefa da Saúde sem duplicar, várias tarefas presas a um cartão, permissões de perguntar e da planta, consulta pela API |
| `mapa/test/*.test.mjs` | O plugin: leitura de código por linguagem e framework, Saúde e segredos, telas, plantas e alterações, servidor e perguntas (com CLIs falsas), exportação, celular e toque, tema, manifestos e marketplaces (`release.test.mjs`) e a cadeia de suprimentos (`supply-chain.test.mjs`: sem hooks, MCP, dependências nem pedidos para fora, e só os programas permitidos) |

- **Rodar em paralelo ao serviço:** `CLAUDE_TASKS_DB=/tmp/teste.db CLAUDE_TASKS_PORT=4318 npm start`.
- **Front-end sem build:** edite `public/` e recarregue a página.
- **Servidor:** depois de mudar `src/`, reinicie o servidor (ou o serviço).
- **Nova migração:** adicione ao fim de `MIGRATIONS` em `src/db.js`, sem nunca alterar as anteriores. Use uma função para só adicionar, ou `{ rebuild: true, run }` quando precisar reconstruir tabelas (com as chaves estrangeiras desligadas e conferidas). O backup é feito automaticamente.
- **Nova rota:** acrescente a operação em `src/openapi.js` (toda rota precisa estar documentada lá).
- **Textos do painel:** use `t('Texto em português')` e acrescente a tradução nos dicionários de `public/js/i18n/`. `npm run i18n:check` (`scripts/i18n.js`) extrai as chaves do código e falha se faltar alguma num idioma; `node scripts/i18n.js --strict` também acusa chaves sobrando e `--keys` lista as chaves por arquivo.
- **CI** (`.github/workflows/ci.yml`): em todo push e pull request, `npm ci` e `npm test` no Node 22 e 24, a conferência dos dicionários (`npm run i18n:check`), `node --check` em todos os arquivos do painel e dos dicionários, e build da imagem Docker com um teste de fumaça (`/api/auth/me` e `/api/openapi.json`).
- **Convenções:**
  - código e comentários em português;
  - validação no `Store` (`ValidationError` vira 400 na API e `isError` no MCP; `ForbiddenError` vira 403);
  - toda gravação dentro de `store.transaction`.

---

## 17. Solução de problemas

| Sintoma | Causa provável | O que fazer |
| --- | --- | --- |
| O painel não abre | serviço parado | `launchctl print gui/$(id -u)/com.claude-tasks.dashboard`; veja `data/server.log`; `bin/service.sh install` |
| "A porta 4317 já está em uso" | outro processo na porta | `lsof -iTCP:4317 -sTCP:LISTEN` e encerre-o, ou mude a porta |
| `{"error":"Host não permitido"}` | o endereço usado não está na lista | acrescente o `host:porta` em `CLAUDE_TASKS_HOSTS` (ou `*` atrás de um proxy que valida o domínio) |
| Painel mostra "sem conexão" | servidor caiu, está reiniciando ou um proxy corta o SSE | aguarde o launchd (até 30 s) ou veja o log; atrás de proxy o painel cai sozinho para polling |
| O Claude não registra tarefas | MCP não carregado na sessão | `claude mcp list` (deve mostrar `tarefas … ✔ Connected`); abra uma **nova** sessão; confira `~/.claude/CLAUDE.md` |
| Ferramentas novas não aparecem | sessão aberta antes da atualização | reabra a sessão |
| Toda chamada pede permissão | permissão do MCP | escolha "Sempre permitir" ou adicione `"mcp__tarefas"` em `permissions.allow` do `~/.claude/settings.json` |
| Tarefa foi para o projeto errado | `project_path` diferente | mova pelo detalhe (campo Projeto) ou com `update_task` `project` |
| "Transição não permitida" | o fluxo do projeto não permite esse movimento | veja as transições em Configurações do projeto → Fluxo, ou mova por uma coluna intermediária |
| Chat: "A CLI do Claude não está logada" | OAuth expirado | `claude` no Terminal → `/login` |
| Chat: "Não encontrei a CLI do Claude" | binário fora do caminho padrão, ou servidor no Docker | defina `CLAUDE_BIN` no serviço; no Docker, troque o provedor para `anthropic` ou `openai` |
| Chat: "O SDK da Anthropic não está instalado" | dependência opcional ausente | `npm install` na pasta do quadro |
| E-mails não chegam | SMTP mal configurado | Configurações → E-mail → "Enviar e-mail de teste"; veja o último erro de envio (também na Administração) |
| Links dos e-mails apontam para `localhost` | endereço público vazio | preencha Configurações → Geral → Endereço público do painel |
| Caixa de entrada não cria tarefas | IMAP falhando ou caixa pausada | Configurações do projeto → Caixa de entrada: "Testar conexão", veja o último erro e se está ativa; a sincronização só roda com o servidor do painel ligado |
| Importação do Jira: "Host … não permitido" | Jira fora do `*.atlassian.net` | acrescente o host em `CLAUDE_TASKS_JIRA_HOSTS` |
| Depois de restaurar, e-mail, caixas de entrada, chat por API ou sincronizações param, e o log mostra "segredo ilegível (data/secret.key mudou?)" | `secret.key` diferente do usado para cifrar | devolva o `secret.key` original; sem ele, os segredos são lidos como vazios (o painel funciona): preencha de novo a senha do SMTP, a chave da API, as senhas IMAP das caixas e refaça as sincronizações salvas |
| Sem notificações do macOS | desligadas nas Configurações, na sua matriz de notificações ou nos Ajustes do Sistema | ligue em Configurações e em Minha conta; permita "Script Editor/osascript" em Ajustes → Notificações |
| "database is locked" | gravação muito longa concorrente | raro (há espera de 5 s); tente de novo |
| Migração: "A migração deixou referências quebradas" | banco com dados inconsistentes | nada foi alterado (ROLLBACK); restaure o backup `backup-v<versão>-…` se precisar e corrija as linhas citadas |
| Aba Mapa do código vazia, ou Perguntar não funciona no mapa | mapa feito fora da raiz do projeto, CLI não encontrada pelo serviço ou papel sem edição | veja [MAPA.md § 11](MAPA.md#11-solução-de-problemas) |
| Esqueci a senha (única conta) | — | com SMTP, use "Esqueci a senha"; sem SMTP e sem outro administrador, pare o serviço e rode `sqlite3 data/tasks.db "DELETE FROM sessions; DELETE FROM users;"` para refazer o primeiro acesso (as tarefas são mantidas) |

---

## 18. Limitações conhecidas

- **Painel sem paginação:** carrega as tarefas abertas mais as concluídas nos últimos 60 dias (até 5000). Concluídas mais antigas aparecem pela busca, pela atividade, pela exportação e pelo MCP (`list_tasks status: done`).
- **Agendador só no servidor do painel:** sem ele ligado, não há avisos de prazo, automações por tempo nem sincronização das caixas de entrada (o MCP não roda o agendador).
- **Chat `claude-cli`:** depende da CLI do Claude Code instalada e logada no mesmo computador do servidor (não funciona no Docker).
- **Sincronizações do Jira e do Trello** são manuais (sem repetição automática) e só importam: mudanças feitas aqui não voltam para lá.
- **Campos obrigatórios** são só destacados no painel; o servidor não exige valor.
- **Idiomas:** só o painel é traduzido; mensagens do servidor, e-mails, notificações e respostas do MCP são em português.
- **Login sem limite de tentativas.**
- **Fuso horário:** as datas de calendário usam o fuso do computador que roda o servidor e o MCP.
- **Mapa do código:** só para projetos com pasta no computador do quadro; perguntar ao mapa depende da CLI do Claude Code ou do Codex nesse computador (não funciona no Docker), com o login de quem mantém o quadro.
