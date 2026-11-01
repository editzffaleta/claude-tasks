# Quadro de tarefas

Um gerenciador de projetos central para **todos** os seus projetos, inspirado no
[Taskosaur](https://github.com/taskosaur/taskosaur) e alimentado pelo Claude. Em qualquer projeto,
quando o Claude deixa algo para depois, encontra um bug que não corrigiu ou sugere um follow-up,
ele registra a tarefa aqui pelo MCP `tarefas`. Você e a equipe acompanham tudo em http://localhost:4317.

Roda só com o Node 22.13+ (SQLite embutido, `node:sqlite`), sem dependências obrigatórias, no Mac
(launchd) ou no Docker.

## Documentação

- **[docs/SISTEMA.md](docs/SISTEMA.md):** arquitetura, instalação (launchd e Docker), conceitos e regras, papéis e permissões, guia de cada tela, automações, notificações, e-mail, importação, chat, modelo de dados, migrações, segurança e solução de problemas.
- **[docs/MCP.md](docs/MCP.md):** referência do servidor MCP 4.1 (36 ferramentas, resources, prompts, permissões, Docker).
- **[docs/MAPA.md](docs/MAPA.md):** guia do Mapa do código: instalação, primeiro mapa, plantas, cada botão do mapa, integração com o quadro, privacidade e solução de problemas.
- **API REST:** documento OpenAPI 3.1 em `/api/openapi.json` e referência navegável em http://localhost:4317/docs/api.

## Funcionalidades

| Área | O que tem |
| --- | --- |
| Estrutura | Organizações → workspaces aninháveis → projetos; prefixo por projeto (tarefas `WEB-12`), status, prioridade, datas, imagem e visibilidade privada, interna ou pública |
| Visualizações | Quadro kanban, Lista (agrupável, com ações em lote), Calendário, Gantt (dependências FS/SS/FF/SF), Dashboard (portfólio, carga, alocação, burndown, velocidade…), Atividade e busca universal ⌘K |
| Tarefas | 5 prioridades, tipos, labels coloridas, campos personalizados, story points, estimativa original e restante, relator, observadores, subtarefas, anexos, timer e lançamentos de tempo, recorrência (dias da semana, dia do mês, último dia, trimestral, até N vezes) |
| Fluxo e sprints | Colunas por projeto, transições permitidas, modelos de workflow; sprints com conclusão, cancelamento, burndown e velocidade |
| Equipe | Papéis de conta (administrador, membro, visualizador) e por projeto/workspace/organização (dono, gerente, membro, visualizador); convites por link ou e-mail; comentários em conversa com @menções; links públicos de leitura |
| Notificações e e-mail | Por tipo e canal (painel, e-mail, macOS); SMTP para convites, senha e avisos; caixa de entrada IMAP por projeto (e-mail vira tarefa, resposta vira comentário) |
| Automação | Regras "quando X → faça Y" com 11 gatilhos (inclusive sprint e projeto) e 12 ações (inclusive mover de coluna/sprint e enviar e-mail), que valem para você, a equipe e o Claude |
| Importação | CSV (ida e volta), Jira (CSV e API) e Trello (JSON e API), com sincronizações salvas |
| IA | O Claude usa o MCP em qualquer sessão; o painel tem um chat com a CLI do Claude Code (sua assinatura), a API da Anthropic ou qualquer API compatível com OpenAI (OpenRouter, Ollama…) |
| Mapa do código | Plugin para Claude Code e Codex que desenha um mapa interativo do código de cada projeto (partes, arquivos, endpoints, telas e ligações, em português simples), com verificação de saúde, fluxos, perguntas e trabalho recente; aba no painel, tarefas presas aos arquivos que citam e tarefas criadas a partir do mapa ([guia](docs/MAPA.md)) |
| Operação | Tempo real (SSE), 5 idiomas, preferências por pessoa, painel de administração com backups e manutenção, segredos cifrados, Docker e CI |

Atalhos no painel: `⌘K` busca e comandos, `N` nova tarefa, `/` filtro, `C` chat, `1`–`5` troca de visão, `Esc` fecha.

## Como funciona

```
Sessão do Claude (projeto A) ─┐
Sessão do Claude (projeto B) ─┼─ MCP stdio (src/mcp.js) ─┐
Chat do painel (CLI ou API) ──┘                          ├─ data/tasks.db (SQLite, WAL)
Navegador ── painel + API REST + SSE (src/server.js) ────┘
                └─ agendador: avisos de prazo, automações por tempo, caixas de entrada
```

- **Projeto**: é o repositório git que contém o diretório onde o Claude está. Worktrees contam
  como o repositório principal. Projetos sem pasta podem ser criados pelo painel (ex.: "Pessoal").
- **Sem duplicatas**: uma tarefa aberta com o mesmo título no mesmo lugar não é criada de novo.
- **Ao vivo**: o painel percebe gravações de qualquer processo (inclusive do MCP) em menos de um segundo.
- **Automações e notificações** rodam em qualquer processo que grava (painel ou MCP), então valem
  também para o que o Claude faz.

## Instalação

### No Mac (launchd)

```bash
# 1. MCP disponível em todos os projetos
claude mcp add --scope user tarefas -- "$(command -v node)" --no-warnings ~/Developer/claude-tasks/src/mcp.js

# 2. Painel sempre ligado (launchd, inicia no login)
~/Developer/claude-tasks/bin/service.sh install
```

3. Instrução global em `~/.claude/CLAUDE.md` dizendo ao Claude para registrar pendências (já incluída).
4. No primeiro acesso a http://localhost:4317, crie a conta de administrador.
5. Chat do painel: precisa da CLI `claude` logada (rode `claude` no Terminal e use `/login`), ou
   configure a API da Anthropic (rode `npm install` para o SDK opcional) ou uma API compatível com
   OpenAI em Configurações → IA do chat.
6. Opcional: e-mail (SMTP) em Configurações → E-mail.

### Docker

```bash
docker compose up -d        # http://localhost:4317, dados no volume "tarefas-data"
```

- Ajuste `CLAUDE_TASKS_HOSTS` no `docker-compose.yml` com o `host:porta` usado no navegador
  (ou `*` atrás de um proxy que valida o domínio).
- A CLI do Claude Code não existe no contêiner: no chat, use o provedor da Anthropic ou um
  compatível com OpenAI.
- O MCP continua rodando onde o Claude Code roda e precisa do mesmo banco: monte uma pasta do host
  como `/data` e aponte `CLAUDE_TASKS_DB` para ela (seguro em Linux) ou use
  `docker exec -i <contêiner> node --no-warnings src/mcp.js` como comando do MCP (melhor no Mac).
  Detalhes em [docs/SISTEMA.md](docs/SISTEMA.md#34-docker).

### Opcional: Mapa do código

Um mapa interativo do código de cada projeto, que aparece na aba **Mapa do código** do painel. Instale o plugin uma vez:

```bash
claude plugin marketplace add ~/Developer/claude-tasks
claude plugin install mapa-do-codigo@claude-tasks
```

Depois, numa sessão nova do Claude Code na pasta do projeto, peça "faça o mapa do código deste projeto" (e, mais tarde, "atualize o mapa do código"). No Codex, use `codex plugin marketplace add ~/Developer/claude-tasks` e instale "Mapa do código" em Plugins. Tudo sobre o mapa em [docs/MAPA.md](docs/MAPA.md).

### Opcional: pendências no início de cada sessão

Adicione em `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "/Users/zffaleta/.local/bin/node --no-warnings /Users/zffaleta/Developer/claude-tasks/bin/session-start.js",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

## Usar em equipe

Por padrão o painel só aceita conexões deste Mac. Para outras pessoas acessarem pela rede,
rode o servidor ouvindo em todas as interfaces e liste os endereços permitidos:

```bash
CLAUDE_TASKS_HOST=0.0.0.0 CLAUDE_TASKS_HOSTS=meumac.local:4317,192.168.0.10:4317 npm start
```

Depois preencha **Configurações → Endereço público do painel**, organize os projetos em
**Organizações** e convide as pessoas em **Equipe → Convidar pessoa** (o link é copiado e, com SMTP,
pode ir por e-mail). Papéis por projeto, workspace ou organização definem quem vê e quem edita cada
projeto. Para acesso pela internet, coloque o painel atrás de um proxy com HTTPS (ex.: Tailscale ou
Cloudflare Tunnel).

## Dados e backup

- Pasta `data/`: banco `tasks.db`, `attachments/`, `avatars/` e `secret.key` (chave dos segredos
  cifrados; guarde junto com o banco).
- Antes de cada migração de esquema, um backup automático é salvo em `data/backup-v<versão>-<data>.db`.
  Backups manuais, download e manutenção ficam em **Administração**.

## Desenvolvimento

```bash
npm start   # painel em http://localhost:4317
npm test    # 237 testes: os do quadro (API, MCP, e-mail, permissões, funcionalidades, mapa) e os do plugin do mapa
npm run i18n:check   # confere os dicionários de idiomas do painel (scripts/i18n.js)
npm run mcp # servidor MCP no terminal
```

Variáveis principais: `CLAUDE_TASKS_DB` (banco), `CLAUDE_TASKS_PORT` (padrão 4317),
`CLAUDE_TASKS_HOST` (padrão 127.0.0.1), `CLAUDE_TASKS_HOSTS` (hosts extras permitidos ou `*`),
`CLAUDE_TASKS_USER` e `CLAUDE_TASKS_ENFORCE` (quem é "eu" no MCP e se as permissões valem),
`CLAUDE_TASKS_JIRA_HOSTS` (hosts do Jira), `CLAUDE_BIN` (CLI do Claude para o chat) e
`CLAUDE_TASKS_NO_OS_NOTIFY=1` (desliga notificações do macOS). Lista completa em
[docs/SISTEMA.md](docs/SISTEMA.md#36-variáveis-de-ambiente).

A CI (`.github/workflows/ci.yml`) roda os testes no Node 22 e 24, confere os dicionários e a sintaxe
do painel e constrói e testa a imagem Docker.
