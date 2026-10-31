# Quadro de Tarefas — Documentação do sistema

> Versão 2 do esquema de dados · MCP 3.0 · Node 22.13+ · sem dependências externas

Este documento descreve o sistema inteiro: o que ele faz, como está organizado, como instalar e operar, como usar cada tela, as regras de negócio, o modelo de dados, a API REST e a segurança. A referência completa do servidor MCP (as ferramentas que o Claude usa) está em [MCP.md](MCP.md).

## Sumário

1. [Visão geral](#1-visão-geral)
2. [Arquitetura](#2-arquitetura)
3. [Instalação e operação](#3-instalação-e-operação)
4. [Conceitos](#4-conceitos)
5. [Guia do painel](#5-guia-do-painel)
6. [Automações](#6-automações)
7. [Notificações](#7-notificações)
8. [Usuários, permissões e equipe](#8-usuários-permissões-e-equipe)
9. [Integração com o Claude](#9-integração-com-o-claude)
10. [Modelo de dados](#10-modelo-de-dados)
11. [API REST](#11-api-rest)
12. [Segurança](#12-segurança)
13. [Desenvolvimento e testes](#13-desenvolvimento-e-testes)
14. [Solução de problemas](#14-solução-de-problemas)
15. [Limitações conhecidas](#15-limitações-conhecidas)

---

## 1. Visão geral

O Quadro de Tarefas é um gerenciador de projetos **local e central**: um único quadro com as pendências de todos os seus projetos. A ideia central é que **o Claude alimenta o quadro sozinho**. Em qualquer sessão do Claude Code, quando um trabalho deixa algo para depois, o Claude registra a tarefa no projeto certo. Você acompanha, organiza e prioriza pelo painel web.

Ele foi inspirado no [Taskosaur](https://github.com/taskosaur/taskosaur), com as seguintes diferenças de propósito:

| | Taskosaur | Quadro de Tarefas |
| --- | --- | --- |
| Infraestrutura | NestJS + Next.js + PostgreSQL + Redis (Docker) | Node puro + SQLite embutido, sem dependências |
| IA | Chat no app com chave de API própria | O Claude Code usa o quadro via MCP em qualquer projeto; chat no painel usa a sua assinatura via CLI |
| Origem das tarefas | Cadastradas no app | Registradas automaticamente pelo Claude enquanto trabalha, além do cadastro manual |
| Projeto | Criado no app | Detectado pela pasta git em que o Claude está |

### Principais capacidades

- **Visões:** quadro kanban, lista, calendário, Gantt e dashboard.
- **Planejamento:** prazos, datas de início, subtarefas, dependências, sprints e tarefas recorrentes.
- **Execução:** timer e lançamentos de tempo, estimativas, anexos, colunas personalizadas, tipos, arquivamento e ordem manual.
- **Equipe:** contas, convites, papéis, responsáveis e notificações.
- **Automação:** regras "quando X → faça Y".
- **IA:** MCP com 24 ferramentas, resources e prompts; chat no painel.

---

## 2. Arquitetura

### 2.1 Componentes

```
┌──────────────────────────┐   stdio (JSON-RPC)   ┌───────────────────────┐
│ Sessão do Claude Code    │ ───────────────────▶ │ src/mcp.js            │──┐
│ (um processo MCP por     │                      │ ferramentas, resources│  │
│  sessão aberta)          │                      │ prompts, completions  │  │
└──────────────────────────┘                      └───────────────────────┘  │
                                                                             │  node:sqlite
┌──────────────────────────┐   HTTP + cookie      ┌───────────────────────┐  │  (modo WAL)
│ Navegador                │ ───────────────────▶ │ src/server.js         │──┼──▶ data/tasks.db
│ public/ (SPA sem build)  │ ◀─── polling 2s ──── │ API REST + estáticos  │  │    data/attachments/
└──────────────────────────┘                      │ agendador (60 s)      │  │
                                                  │ chat: spawn claude -p │──┘
                                                  └───────────────────────┘
          ▲                                                   │
          └──────── launchd mantém o servidor ligado ─────────┘

Hook SessionStart (bin/session-start.js) ── lê o banco e injeta as pendências no início da sessão
```

- **Banco único.** Todos os processos abrem o mesmo arquivo SQLite em modo WAL, com `busy_timeout` de 5 s. Isso permite várias sessões do Claude e o painel gravarem ao mesmo tempo.
- **Sem servidor obrigatório para o Claude.** O MCP grava direto no banco. O painel só é necessário para visualizar e para tarefas agendadas (avisos de prazo e automações por tempo).
- **Atualização ao vivo.** O painel consulta `/api/version` a cada 2 s. A versão combina o `PRAGMA data_version` do SQLite, que muda quando outro processo grava, com um contador de gravações do próprio servidor.
- **Motor de regras em todo processo.** Automações e notificações são ligadas por `attachEngine(store)` tanto no MCP quanto no servidor. Por isso, uma mudança feita pelo Claude também dispara as regras.

### 2.2 Tecnologias

| Camada | Escolha | Por quê |
| --- | --- | --- |
| Runtime | Node 22.13+ (ES modules) | Já instalado; traz `node:sqlite` e `node:test` |
| Banco | SQLite via `node:sqlite` (WAL) | Arquivo único, multiprocesso, zero dependência |
| Servidor HTTP | `node:http` | Simples; sem framework |
| Front-end | HTML + CSS + JS modules nativos | Sem etapa de build; abre direto no navegador |
| MCP | JSON-RPC sobre stdio, implementado à mão | Sem SDK; controle total do protocolo |
| Senhas | `crypto.scrypt` + `timingSafeEqual` | Nativo do Node |
| Serviço | launchd (LaunchAgent do usuário) | Inicia no login e reinicia se cair |

### 2.3 Estrutura de pastas

```
claude-tasks/
├── bin/
│   ├── service.sh            instala/remove o LaunchAgent do painel
│   └── session-start.js      hook SessionStart do Claude Code
├── docs/
│   ├── SISTEMA.md            este documento
│   └── MCP.md                referência do servidor MCP
├── public/                   painel (servido como arquivos estáticos)
│   ├── index.html            casca da página
│   ├── styles.css            tema claro/escuro, todos os componentes, responsivo
│   └── js/
│       ├── main.js           boot, login, troca de visões, atalhos, polling
│       ├── state.js          estado global, rota na URL, filtros, carregamento
│       ├── api.js            fetch, upload, streaming NDJSON, toasts
│       ├── util.js           datas, durações, markdown, ícones, cores
│       ├── ui.js             diálogos, confirmações, menus flutuantes
│       ├── shell.js          barra lateral, cabeçalho, abas, filtros, notificações, timer
│       ├── auth.js           primeiro acesso, login, aceite de convite
│       ├── board.js          visão Quadro (kanban, arrastar e soltar)
│       ├── list.js           visão Lista (ordenar, agrupar, subtarefas aninhadas)
│       ├── calendar.js       visão Calendário (arrastar para remarcar)
│       ├── gantt.js          visão Gantt (barras, dependências, arrastar)
│       ├── dashboard.js      Dashboard (indicadores e gráficos)
│       ├── drawer.js         painel de detalhes da tarefa
│       ├── taskform.js       diálogo de nova tarefa
│       ├── sprints.js        gerenciador de sprints
│       ├── automations.js    página de automações
│       ├── team.js           páginas Equipe e Minha conta
│       ├── settings.js       configurações do projeto e gerais
│       └── chat.js           chat com o Claude
├── src/
│   ├── db.js                 Store: esquema, migrações, projetos, colunas, sprints,
│   │                         tarefas, notas, dependências, recorrência, eventos
│   ├── store/
│   │   ├── team.js           usuários, sessões, convites, responsáveis, notificações
│   │   ├── work.js           tempo (timer e lançamentos) e anexos
│   │   └── insights.js       configurações, estatísticas, relatório de tempo,
│   │                         atividade, automações (cadastro), chat
│   ├── engine.js             motor de automações, notificações e tick agendado
│   ├── util.js               validação, datas, durações, recorrência, rótulos
│   ├── server.js             servidor HTTP: API REST, estáticos, chat, agendador
│   ├── mcp.js                servidor MCP (protocolo)
│   └── mcp/
│       ├── context.js        store do MCP, "me", formatadores
│       ├── tools.js          as 24 ferramentas
│       ├── resources.js      resources e templates
│       └── prompts.js        prompts e autocompletar
├── test/
│   ├── api.test.js           sobe o servidor real e testa a API
│   └── mcp.test.js           conversa com o MCP real via stdio
├── data/                     (ignorada pelo git) banco, anexos, backups, log
└── package.json
```

### 2.4 Camada de dados (`Store`)

`src/db.js` define a classe `Store`, que estende `EventEmitter`. Os métodos de `src/store/*.js` são adicionados por mixin (`Object.assign(Store.prototype, …)`).

- **Transações reentrantes.** `store.transaction(fn)` abre `BEGIN IMMEDIATE` só na chamada mais externa; chamadas aninhadas reutilizam a transação.
- **Eventos após o COMMIT.** As mutações enfileiram eventos com `queue()`, e eles só são emitidos depois que a transação externa confirma. Os eventos são:

| Evento | Quando | Payload |
| --- | --- | --- |
| `task.created` | tarefa criada (inclusive por recorrência) | `{ task, actor }` |
| `task.updated` | algum campo mudou | `{ task, before, changes, actor }` |
| `task.commented` | comentário adicionado | `{ task, note, actor }` |
| `task.assigned` | pessoa adicionada como responsável | `{ task_id, user_id, actor }` |
| `notification` | notificação criada | `{ task_id, body }` |

- **Ator.** Toda gravação recebe quem fez: `{ author: 'claude' }`, `{ author: 'user', user_id }`, `{ author: 'automação' }` ou, no legado, `'você'`. Esse valor alimenta o histórico, a autoria e a regra que evita cascata de automações.

### 2.5 Migrações

O esquema é versionado por `PRAGMA user_version`. Ao abrir o banco, `migrate()` faz o seguinte:

1. Se a versão do banco é menor que a do código **e já existem dados**, salva antes um backup com `VACUUM INTO data/backup-v<versão>-<timestamp>.db`.
2. Aplica as migrações pendentes dentro de um `BEGIN IMMEDIATE`, o que evita corrida entre processos.
3. Atualiza `user_version`.

| Versão | Conteúdo |
| --- | --- |
| 1 | Projetos, tarefas e notas (quadro original) |
| 2 | Usuários, sessões, convites, colunas, sprints, dependências, responsáveis, tempo, anexos, notificações, automações, configurações, chat. Novos campos em tarefas, projetos e notas. Só **adiciona** tabelas e colunas, sem reconstruir nada. |

---

## 3. Instalação e operação

### 3.1 Requisitos

- macOS (o serviço usa launchd e as notificações usam `osascript`; o restante roda em qualquer sistema).
- Node.js 22.13 ou mais novo (`node:sqlite` sem flag).
- Claude Code (CLI), para o MCP e o chat do painel.

### 3.2 Instalação

```bash
# 1. MCP disponível em todos os projetos
claude mcp add --scope user tarefas -- "$(command -v node)" --no-warnings ~/Developer/claude-tasks/src/mcp.js

# 2. Painel sempre ligado (launchd)
~/Developer/claude-tasks/bin/service.sh install
```

Depois:

1. **Instrução global.** Em `~/.claude/CLAUDE.md`, a seção "Quadro de tarefas" diz ao Claude para registrar pendências sozinho. Veja a [seção 9](#9-integração-com-o-claude).
2. **Primeiro acesso.** Abra http://localhost:4317 e crie a conta de administrador.
3. **Chat do painel (opcional).** Rode `claude` no Terminal e faça `/login`.
4. **Hook SessionStart (opcional).** Veja a [seção 9.3](#93-hook-sessionstart).

### 3.3 Serviço (launchd)

`bin/service.sh install` cria `~/Library/LaunchAgents/com.claude-tasks.dashboard.plist` com:

- `RunAtLoad`: inicia no login.
- `KeepAlive`: reinicia se o processo cair, com `ThrottleInterval` de 30 s.
- Saída e erros vão para `data/server.log`.

| Ação | Comando |
| --- | --- |
| Instalar / reinstalar | `bin/service.sh install` |
| Remover | `bin/service.sh uninstall` |
| Reiniciar (após atualizar o código) | `launchctl kickstart -k gui/$(id -u)/com.claude-tasks.dashboard` |
| Ver estado | `launchctl print gui/$(id -u)/com.claude-tasks.dashboard` |
| Ver log | `tail -f data/server.log` |

O `install` mata qualquer processo que já esteja ouvindo na porta antes de registrar o serviço.

### 3.4 Atualizar o sistema

1. Atualize o código (por exemplo, `git pull`).
2. Reinicie o serviço com `launchctl kickstart -k …`. Se houver migração nova, ela roda nesse momento, com backup automático.
3. Sessões do Claude já abertas continuam com o MCP antigo até serem reabertas. Elas seguem funcionando com o banco novo, só que sem as ferramentas novas.

### 3.5 Variáveis de ambiente

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `CLAUDE_TASKS_DB` | `data/tasks.db` | Caminho do banco. Os anexos ficam em `attachments/` ao lado dele. |
| `CLAUDE_TASKS_PORT` | `4317` | Porta do painel. Também compõe os links que o MCP devolve. |
| `CLAUDE_TASKS_HOST` | `127.0.0.1` | Interface onde o painel escuta. Use `0.0.0.0` para rede. |
| `CLAUDE_TASKS_HOSTS` | — | Hosts extras aceitos no cabeçalho `Host`/`Origin` (ex.: `meumac.local:4317`). |
| `CLAUDE_TASKS_USER` | — | (MCP) Quem é "eu" para o Claude: e-mail ou nome de um membro. |
| `CLAUDE_BIN` | `~/.local/bin/claude`, Homebrew… | Caminho da CLI usada pelo chat do painel. |
| `CLAUDE_TASKS_NO_OS_NOTIFY` | — | Se definida, nunca mostra notificações do macOS (usado nos testes). |

### 3.6 Dados e backup

| Item | Local |
| --- | --- |
| Banco | `data/tasks.db` (mais `-wal` e `-shm` enquanto aberto) |
| Anexos | `data/attachments/<tarefa>-<timestamp>-<aleatório>.<ext>` |
| Backups de migração | `data/backup-v<versão>-<timestamp>.db` |
| Log do serviço | `data/server.log` |

**Backup manual com o sistema rodando:**

```bash
sqlite3 ~/Developer/claude-tasks/data/tasks.db ".backup '$HOME/backup-tarefas.db'"
tar czf ~/backup-anexos.tgz -C ~/Developer/claude-tasks/data attachments
```

**Restaurar:** pare o serviço (`bin/service.sh uninstall`), substitua `data/tasks.db` pelo backup, apague os arquivos `-wal`/`-shm` e reinstale o serviço.

### 3.7 Usar em equipe (rede)

Por padrão o painel só aceita conexões deste Mac. Para outras pessoas acessarem:

```bash
CLAUDE_TASKS_HOST=0.0.0.0 CLAUDE_TASKS_HOSTS=meumac.local:4317,192.168.0.10:4317 npm start
```

Para deixar isso permanente no serviço, adicione um bloco `EnvironmentVariables` no plist gerado. Para acesso pela internet, use um túnel com HTTPS (Tailscale, Cloudflare Tunnel) em vez de expor a porta. O cookie de sessão não é `Secure`, porque o painel serve HTTP.

---

## 4. Conceitos

### 4.1 Projeto

- **Projeto de pasta.** É identificado pelo caminho da **raiz do repositório git** que contém o diretório de trabalho. Subpastas pertencem ao mesmo projeto. Worktrees (`.git` em arquivo apontando para `…/.git/worktrees/x`) são resolvidas para o repositório principal. Pastas sem git usam o próprio caminho.
- **Projeto sem pasta.** É criado pelo nome, pelo painel ou por `manage_project`/`project: "Nome"` no MCP. Por exemplo, "Pessoal".
- **Criação automática.** Quando o Claude registra a primeira tarefa numa pasta nova, o projeto é criado com o nome da pasta.
- **Campos:** nome, descrição, cor (usada no quadro, no calendário e no Gantt) e arquivado. Projetos arquivados vão para a seção "Arquivados" da barra lateral.

### 4.2 Tarefa

| Campo | Descrição |
| --- | --- |
| `id` | Número global e único (`#12`), igual em todos os projetos |
| Título e descrição | A descrição aceita Markdown simples: parágrafos, listas, `código`, **negrito**, links e imagens |
| Status | Categoria: `todo` (a fazer), `doing` (em andamento), `blocked` (bloqueada), `done` (concluída) |
| Coluna | Coluna do quadro dentro da categoria (ver 4.3) |
| Prioridade | `urgent`, `high`, `medium`, `low` |
| Tipo | `task` (tarefa), `bug`, `story` (história), `epic` (épico) |
| Tags | Até 12 rótulos livres |
| Início e prazo | Datas `AAAA-MM-DD` no fuso local |
| Estimativa | Minutos. Aceita `90m`, `2h`, `1h30m`, `1,5h` e `1d` (= 8h) |
| Sprint | Uma sprint do mesmo projeto, ou backlog |
| Tarefa-mãe | Torna a tarefa uma subtarefa |
| Responsáveis | Zero ou mais membros |
| Recorrência | Diária, semanal, mensal ou anual, a cada N, até uma data |
| Arquivada | Some do quadro e das listas, mas continua no banco |
| Origem | `claude`, `user`, `automação` ou `você` (legado) |

**Atrasada** é toda tarefa não concluída com prazo anterior a hoje.

**Duplicatas.** Ao criar, se já existe uma tarefa **aberta e não arquivada** com o mesmo título (sem diferenciar maiúsculas), no mesmo projeto e sob a mesma tarefa-mãe, a existente é devolvida no lugar de uma nova.

### 4.3 Status × colunas

- Toda tarefa tem uma das 4 **categorias** de status.
- Um projeto sem colunas próprias usa as 4 colunas padrão ("A fazer", "Em andamento", "Bloqueadas", "Concluídas"). Elas são virtuais: não existem no banco.
- Ao criar a primeira coluna própria, as 4 padrão viram linhas reais na tabela `columns` e passam a ser editáveis.
- Cada coluna pertence a uma categoria. Mover uma tarefa para uma coluna ajusta o status dela.
- Uma tarefa sem `column_id` aparece na **primeira coluna da sua categoria**.
- Mudar só o status, sem informar coluna, limpa a coluna da tarefa.
- O projeto precisa manter **ao menos uma coluna por categoria**. O sistema impede excluir a última ou mudar a categoria dela.
- Mudar a categoria de uma coluna muda o status de todas as tarefas dela.
- A visão "Todas as tarefas" sempre mostra as 4 categorias, seja qual for a coluna.

### 4.4 Ordem (rank)

Cada tarefa tem um `rank` numérico usado para ordenar dentro da coluna:

- **Ao criar:** `faixa_da_prioridade × 10¹⁰ + segundos desde 1970`, com faixas urgente = 1, alta = 2, média = 3 e baixa = 4. Assim, urgentes ficam em cima e, dentro da mesma prioridade, as mais antigas primeiro.
- **Arrastar** no quadro define o rank como o ponto médio entre os vizinhos.
- **Mudar a prioridade** recalcula o rank para a nova faixa.
- A coluna **Concluídas** é ordenada por data de conclusão, da mais recente para a mais antiga.

Ordem geral das listagens: em andamento, bloqueadas, a fazer e concluídas; dentro de cada grupo, pelo rank.

### 4.5 Subtarefas

- Uma subtarefa é uma tarefa completa com `parent_id`, sempre no mesmo projeto da tarefa-mãe.
- O sistema impede ciclos: uma tarefa não pode ser mãe de si mesma nem de um ancestral.
- Mover a tarefa-mãe de projeto leva as subtarefas junto.
- Excluir a tarefa-mãe exclui as subtarefas.
- O card da mãe mostra o progresso (`2/5`). No quadro, as subtarefas ficam ocultas por padrão (filtro "Mostrar subtarefas no quadro"). Na lista e no Gantt elas aparecem recuadas sob a mãe.

### 4.6 Dependências

- "A é **bloqueada por** B" significa que B precisa terminar antes de A.
- O sistema impede ciclos: não é possível adicionar uma dependência que faria B depender de A, direta ou indiretamente.
- Dependências entre projetos diferentes são permitidas.
- O card mostra o ícone de bloqueio enquanto houver bloqueadores abertos (`open_blockers > 0`).
- No Gantt, as dependências aparecem como setas. A seta fica tracejada e vermelha quando a tarefa dependente começa antes do bloqueador terminar.

### 4.7 Sprints

- Pertencem a um projeto e têm nome, objetivo, início e fim.
- O status passa por `planning` → `active` → `completed`.
- **Uma sprint ativa por projeto.** Iniciar uma segunda sprint gera erro.
- Iniciar uma sprint sem data de início preenche a data de hoje.
- Concluir uma sprint move as tarefas não concluídas para outra sprint (aberta e do mesmo projeto) ou para o backlog, e preenche o fim com hoje se estiver vazio.
- Excluir uma sprint manda as tarefas dela para o backlog.

### 4.8 Recorrência

Ao **concluir** uma tarefa recorrente, o sistema cria a próxima ocorrência assim:

1. O próximo prazo é calculado a partir do prazo atual (ou de hoje, se a tarefa não tem prazo), avançando a frequência × intervalo.
2. Se o resultado ainda está no passado, o cálculo avança até hoje ou depois.
3. Meses curtos são respeitados: 31/jan + 1 mês = 28 ou 29/fev.
4. Se existe data final (`until`) e o próximo prazo passa dela, a recorrência termina.
5. Se a tarefa tinha início, a distância entre início e prazo se mantém.
6. A nova tarefa copia título, descrição, prioridade, tipo, tags, estimativa, tarefa-mãe e responsáveis. Ela começa como "a fazer", fora de sprint, com origem `automação`.
7. A original guarda `recurrence_next_id`, então reabrir e concluir de novo não duplica a próxima.

### 4.9 Tempo

- **Timer:** um por pessoa. Iniciar um timer para o anterior da mesma pessoa. Parar arredonda para minutos, com mínimo de 1.
- **Lançamento manual:** duração, data e nota.
- **Gasto:** soma dos lançamentos mais o tempo corrido dos timers rodando.
- O tempo registrado pelo Claude conta para a pessoa que está usando o Claude (ver `CLAUDE_TASKS_USER` em [MCP.md](MCP.md)) e aparece como "Claude · Nome".
- O card mostra `gasto/estimado`, em vermelho quando passa da estimativa.

### 4.10 Anexos

- Até 25 MB por arquivo. O nome é saneado e o arquivo é gravado com nome único.
- Imagens, PDFs e vídeos abrem no navegador; os demais tipos são baixados.
- É possível colar uma imagem na descrição ou no comentário. Ela é anexada e o Markdown `![nome](/api/attachments/ID)` é inserido no texto.
- Excluir uma tarefa ou um projeto apaga também os arquivos dos anexos.

### 4.11 Histórico (atividade)

Cada tarefa tem uma linha do tempo formada por:

- **Comentários** (`kind = note`).
- **Eventos** (`kind = event`), gerados automaticamente:
  - mudança de status, prioridade, prazo, sprint ou projeto;
  - arquivar e desarquivar;
  - atribuições;
  - anexos;
  - automações executadas;
  - recorrência.

O dashboard e a ferramenta `get_activity` juntam esse histórico com as criações de tarefas.

---

## 5. Guia do painel

### 5.1 Acesso

| Situação | Tela |
| --- | --- |
| Nenhuma conta existe | **Crie sua conta**: a primeira vira administrador. Notificações antigas, do modo sem contas, passam para ela. |
| Há contas e você não entrou | **Entrar** com e-mail e senha |
| Link `/?invite=TOKEN` | **Aceitar convite**: cria a conta com o papel do convite. Se o convite tem e-mail, o campo fica travado. |

A sessão dura 90 dias. Uma requisição sem sessão válida recarrega o painel na tela de login.

### 5.2 Estrutura da tela

- **Barra lateral:**
  - Dashboard, Todas as tarefas e Minhas tarefas (só aparece com mais de um membro).
  - Projetos, com contadores de abertas e alerta vermelho de atrasadas, e o botão `+` para criar projeto.
  - Arquivados, recolhível.
  - Rodapé: Automações, Equipe, Configurações, seu nome (menu com Minha conta e Sair) e o indicador "ao vivo".
- **Cabeçalho:** nome e pasta do projeto, menu `⋯` do projeto, timer em execução, sino de notificações, botão do chat e **Nova tarefa**.
- **Barra de ferramentas:** abas (Quadro, Lista, Calendário, Gantt, Dashboard), seletor de sprint (dentro de um projeto), busca e Filtros.
- **Menu do projeto `⋯`:** Configurações do projeto, Sprints, Copiar caminho, Arquivar/Desarquivar e Excluir (só administrador).

A URL guarda o estado (`?project=4&view=gantt&sprint=2&task=47`), então links abrem direto na tarefa.

### 5.3 Busca e filtros

- **Busca:** título, descrição, tags, nome do projeto e `#id`.
- **Filtros:**
  - prioridade, tipo e responsável (eu, sem responsável ou pessoa);
  - prazo (atrasadas, vencem hoje, próximos 7 dias, sem prazo);
  - "Mostrar subtarefas no quadro" e "Incluir tarefas arquivadas".
- O botão Filtros mostra quantos filtros estão ativos.
- Filtros e busca valem para Quadro, Lista, Calendário e Gantt.
- O seletor de sprint mostra todas as sprints, o backlog (sem sprint) ou uma sprint específica.
- O painel carrega as tarefas abertas e as concluídas nos **últimos 60 dias**.

### 5.4 Quadro

- **Colunas:** dentro de um projeto, as colunas dele; em "Todas as tarefas", as 4 categorias.
- **Card:**
  - prioridade, tipo, `#id`;
  - ícones de bloqueada, timer rodando e recorrente;
  - selo do Claude, quando foi ele que criou;
  - avatares dos responsáveis e tarefa-mãe;
  - chips de projeto, prazo (vermelho se atrasada, âmbar se hoje ou em breve) e tags;
  - subtarefas, comentários, anexos e tempo.
- **Arrastar** entre colunas muda coluna e status; dentro da coluna, muda a ordem. Uma linha mostra onde o card vai cair.
- O `+` no topo da coluna cria uma tarefa já nela.
- **Teclado:** `Enter` ou `Espaço` num card abre o detalhe.

### 5.5 Lista

- Tabela com conclusão rápida (círculo), tarefa, projeto, status, responsáveis, prazo, sprint, tempo e "atualizada".
- **Ordenar:** clique no cabeçalho (clique de novo inverte).
- **Agrupar por:** projeto, status, prioridade, prazo (atrasadas, hoje, 7 dias, 30 dias, mais tarde, sem prazo), responsável, sprint ou tipo. Os grupos podem ser recolhidos.
- Subtarefas aparecem recuadas logo abaixo da mãe.

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
- **Arrastar:**
  - o meio da barra move início e prazo juntos;
  - a borda esquerda muda o início;
  - a borda direita muda o prazo;
  - uma etiqueta mostra as datas durante o arraste;
  - um clique sem arrastar abre a tarefa.
- **Setas:** dependências; vermelhas e tracejadas quando há conflito de datas.
- **Sem datas:** seção recolhível. Clicar num dia da linha agenda a tarefa (início no dia clicado, prazo 2 dias depois).

### 5.8 Dashboard

Disponível para todos os projetos (barra lateral) ou para um projeto (aba).

- **Indicadores:**
  - abertas, com quantas estão em andamento e bloqueadas;
  - atrasadas;
  - vencem em 7 dias;
  - concluídas nos últimos 7 dias;
  - registradas pelo Claude nos últimos 7 dias;
  - tempo registrado nos últimos 7 dias.
- Os indicadores "Abertas", "Atrasadas" e "Vencem em 7 dias" são clicáveis e abrem a lista já filtrada.
- **Criadas × concluídas por semana:** barras agrupadas das últimas 8 semanas (semana começando na segunda), com legenda, valores ao passar o mouse e "Ver como tabela".
- **Sprint ativa:** percentual e progresso (só dentro de um projeto).
- **Abertas por projeto** ou **por coluna:** barras horizontais com o valor no fim. Clicar num projeto abre o quadro dele.
- **Abertas por prioridade** e **Tempo registrado (7 dias)** por projeto.
- **Próximos prazos** (10) e **Atividade recente** (20).

### 5.9 Detalhe da tarefa

O detalhe abre ao clicar numa tarefa, em qualquer visão, e fecha com `Esc`.

- **Cabeçalho:**
  - tipo, `#id`, projeto (clique para abrir o quadro dele) e tarefa-mãe;
  - **Copiar para o Claude:** gera um pedido pronto para colar numa sessão;
  - menu `⋯`: adicionar subtarefa, timer, copiar link, arquivar e excluir.
- **Título:** editável no lugar. `Enter` salva.
- **Campos:**
  - status/coluna, prioridade, tipo;
  - responsáveis (o `+` abre a lista de membros);
  - início, prazo (com alerta), estimativa, sprint, projeto (mover);
  - recorrência ("a cada N"), tags e pasta.
- **Descrição:** clique para editar (Markdown). `⌘↵` ou `Esc` conclui. Dá para colar imagens.
- **Subtarefas:** barra de progresso, círculo para concluir, clique para abrir e campo para adicionar (`Enter`).
- **Dependências:** "Bloqueada por", com campo que aceita `#id` ou o título (com sugestões) e `×` para remover; abaixo, "Bloqueia".
- **Tempo:**
  - iniciar ou parar o timer;
  - gasto × estimado, com barra;
  - "Registrar manualmente" (duração, data, nota);
  - lista de registros com botão de apagar.
- **Anexos:** miniaturas de imagens e lista de arquivos. Adicione pelo botão, arrastando arquivos para o painel ou colando.
- **Atividade:** linha do tempo e campo de comentário (`⌘↵` envia).
- **Rodapé:** Concluir/Reabrir, a recorrência, Arquivar e Excluir.

Enquanto você digita, as atualizações ao vivo só renovam as listas do detalhe e não apagam o que está sendo escrito.

### 5.10 Nova tarefa

Abre com `N` ou com o botão. Os campos são:

- título, descrição, projeto (ou "+ Novo projeto…");
- status/coluna, prioridade, tipo;
- início, prazo, estimativa;
- sprint (aparece se o projeto tem sprints abertas);
- tags, repetição e responsáveis.

Ao abrir a partir do `+` de uma coluna ou de um dia do calendário, o campo correspondente já vem preenchido. Dentro de um filtro de sprint, a sprint também vem preenchida. `⌘↵` cria.

### 5.11 Sprints

Abre pelo menu do projeto ou pela engrenagem ao lado do seletor de sprint.

- Criar com nome, objetivo, início e fim.
- Para cada sprint: Ver tarefas, Iniciar, Concluir (escolhendo para onde vão as pendentes), Editar e Excluir.

### 5.12 Automações, Equipe e Configurações

- **Automações:** lista de regras com chave liga/desliga, descrição legível e estatística de execução. Há 5 modelos prontos e um editor completo (ver [seção 6](#6-automações)). Só o administrador cria e edita.
- **Equipe:**
  - lista de membros, com papel editável pelo administrador e botão de remover;
  - convites: gerar link com e-mail opcional e papel (o link é copiado automaticamente), lista de pendentes e revogação.
- **Minha conta:** nome, e-mail, cor e troca de senha (exige a senha atual).
- **Configurações:**
  - com um projeto aberto: nome, descrição, cor e **editor de colunas** (renomear, mudar categoria, mover com ← →, excluir, adicionar);
  - gerais (administrador): notificações do macOS, antecedência dos avisos de prazo e modelo do chat.

### 5.13 Notificações e timer

- **Sino:** contador de não lidas e painel com as últimas 50. Clicar numa notificação abre a tarefa e a marca como lida. Há também "Marcar todas como lidas".
- **Timer no cabeçalho:** tempo corrido ao vivo e título da tarefa. Clique para abrir a tarefa; `■` para parar.

### 5.14 Chat com o Claude

O botão ✦ ou a tecla `C` abrem o painel do chat à direita.

- **Como funciona:** o servidor executa a CLI do Claude Code (`claude -p`) com só as ferramentas do MCP `tarefas`, sem acesso a arquivos ou terminal. A resposta chega em streaming e mostra quais ferramentas foram usadas.
- **Contexto:** o projeto aberto no painel, quem está falando e a data de hoje.
- **Continuidade:** a conversa continua (`--resume`) até você clicar em `+` (Nova conversa).
- **Resultado:** o quadro se atualiza sozinho com o que o Claude mudar.
- **Requisito:** a CLI precisa estar logada. Se não estiver, o chat explica como resolver.

### 5.15 Atalhos de teclado

| Tecla | Ação |
| --- | --- |
| `N` | Nova tarefa |
| `/` | Focar a busca |
| `C` | Abrir/fechar o chat |
| `1` a `5` | Quadro, Lista, Calendário, Gantt, Dashboard |
| `Esc` | Sai do campo, fecha o detalhe, menus, painéis e barra lateral |
| `⌘↵` | Confirma diálogos, envia comentário, conclui edição da descrição |
| `Enter` | No título, tags e estimativa: salva. Em subtarefa ou dependência: adiciona. |

### 5.16 Celular e tema

- **Celular:**
  - abaixo de 820 px, a barra lateral vira gaveta (☰);
  - as colunas do quadro passam a rolar na horizontal, com encaixe;
  - as abas mostram só ícones, exceto a ativa;
  - o cabeçalho fica compacto.
- **Tema:** claro e escuro seguem o sistema operacional.
- **Acessibilidade:** respeita "reduzir movimento" do sistema.

---

## 6. Automações

Uma regra tem **escopo** (todos os projetos ou um projeto), **gatilho**, **condições** opcionais e **uma ação**.

### 6.1 Gatilhos

| Gatilho | Dispara quando | Momento |
| --- | --- | --- |
| `task_created` | uma tarefa é criada | imediato |
| `status_changed` | o status muda | imediato |
| `priority_changed` | a prioridade muda | imediato |
| `comment_added` | alguém comenta | imediato |
| `assigned` | alguém é adicionado como responsável | imediato |
| `due_soon` | o prazo está a até N dias (condição `days`, padrão 1) | agendador, 1×/min |
| `overdue` | o prazo passou | agendador, 1×/min |

### 6.2 Condições

| Condição | Significado |
| --- | --- |
| `to_status` | (status_changed) novo status |
| `from_status` | (status_changed) status anterior |
| `priority` | prioridade atual está na lista |
| `type` | tipo está na lista |
| `tag` | a tarefa tem essa tag |
| `by_claude` | a tarefa foi criada pelo Claude |
| `days` | (due_soon) antecedência em dias |

### 6.3 Ações

| Ação | Valor |
| --- | --- |
| `set_status` | `todo`, `doing`, `blocked` ou `done` |
| `set_priority` | `urgent`, `high`, `medium` ou `low` |
| `add_tag` / `remove_tag` | a tag |
| `add_comment` | texto (aceita variáveis) |
| `notify` | texto (aceita variáveis). Vai para os responsáveis ou, sem responsáveis, para todos. |
| `set_due_in_days` | número de dias a partir de hoje |
| `move_to_active_sprint` | — |
| `assign` | nome ou e-mail do membro (é adicionado aos responsáveis) |

As variáveis aceitas em textos são `{id}`, `{titulo}`, `{projeto}`, `{prazo}`, `{status}` e `{prioridade}`.

### 6.4 Regras de execução

- **Vale para todos.** A regra roda tanto no processo do painel quanto no MCP, então mudanças feitas pelo Claude também a disparam.
- **Sem cascata.** Mudanças feitas por automações (ator `automação`) **não** disparam outras automações. Tarefas criadas por recorrência também não disparam `task_created`.
- **Proteção contra ciclo.** Não é permitido criar uma regra com gatilho `status_changed` e ação `set_status`.
- **Gatilhos por tempo uma vez só.** `due_soon` e `overdue` disparam **uma vez por tarefa por regra** (tabela `automation_fired`).
- **Registro.** Cada execução grava um evento "automação “Nome”" no histórico da tarefa e incrementa o contador da regra.
- **Falhas isoladas.** Uma ação que falha é registrada no log e não interrompe as outras regras.

### 6.5 Modelos prontos

1. **Bloqueou → prioridade alta** (`status_changed` para bloqueada → `set_priority high`)
2. **Avisar 1 dia antes do prazo** (`due_soon` com 1 dia → `notify`)
3. **Atrasou → tag "atrasada"** (`overdue` → `add_tag atrasada`)
4. **Bug novo → prioridade alta** (`task_created`, tipo bug → `set_priority high`)
5. **Tarefa do Claude → sprint ativa** (`task_created`, por Claude → `move_to_active_sprint`)

---

## 7. Notificações

| Origem | Quem recebe | Quando |
| --- | --- | --- |
| Atribuição | a pessoa atribuída, exceto se ela mesma se atribuiu | ao atribuir |
| Comentário | os responsáveis da tarefa, exceto quem comentou | ao comentar |
| Prazo chegando | responsáveis ou, sem responsáveis, todos | até `due_soon_days` antes do prazo (padrão 1) |
| Atrasada | responsáveis ou todos | prazo passou |
| Automação `notify` | responsáveis ou todos | quando a regra dispara |
| Claude (`send_notification`) | quem o Claude indicar, ou todos | sob pedido |

- **Sem repetição.** Os avisos de prazo têm uma chave única (`due:<tarefa>:<prazo>` ou `overdue:<tarefa>:<prazo>`), então saem uma vez por tarefa e prazo. Se o prazo mudar, o aviso volta a valer para a nova data.
- **macOS.** Com "Mostrar também como notificação do macOS" ligado, cada notificação nova também aparece na Central de Notificações (via `osascript`).
- **Agendador.** O servidor roda o `tick` 5 s depois de iniciar e depois a cada 60 s. O `tick` gera os avisos de prazo e roda as automações por tempo.

---

## 8. Usuários, permissões e equipe

### 8.1 Papéis

| Ação | Administrador | Membro |
| --- | --- | --- |
| Ver e editar tarefas, comentar, anexar, tempo | ✓ | ✓ |
| Criar e editar projetos, colunas e sprints | ✓ | ✓ |
| Excluir projeto | ✓ | — |
| Criar, editar e excluir automações | ✓ | — (vê a lista) |
| Mudar configurações gerais | ✓ | — (vê) |
| Convidar e revogar convites | ✓ | — |
| Mudar papel e remover membros | ✓ | — |
| Editar o próprio perfil e a senha | ✓ | ✓ |

O sistema sempre mantém **ao menos um administrador** e não permite remover a própria conta.

### 8.2 Contas e sessões

- **Senha:** mínimo de 8 caracteres, armazenada como `scrypt$salt$hash` (salt de 16 bytes, hash de 64 bytes).
- **E-mail:** único, sem diferenciar maiúsculas.
- **Sessão:** token aleatório de 32 bytes no cookie `tk_session` (HttpOnly, SameSite=Lax), válido por 90 dias. Sessões expiradas são limpas a cada novo login.
- **"Visto por último":** atualizado no máximo a cada 10 minutos.

### 8.3 Convites

- Token aleatório, válido por **14 dias** e de **uso único**.
- Pode ser travado num e-mail.
- Leva um papel (membro ou administrador).
- O link tem o formato `http://<host>:4317/?invite=<token>`.

---

## 9. Integração com o Claude

### 9.1 MCP `tarefas`

Servidor MCP local (stdio) registrado no escopo de usuário. Ele está disponível em todas as sessões do Claude Code de qualquer projeto. Tem 24 ferramentas, resources, prompts (comandos `/mcp__tarefas__…`) e autocompletar. **Referência completa: [MCP.md](MCP.md).**

### 9.2 Instrução global (`~/.claude/CLAUDE.md`)

Diz ao Claude, em todas as sessões, para:

- registrar pendências com `add_tasks` passando `project_path`, sem perguntar antes e avisando numa linha;
- mudar para `doing` ao começar uma tarefa do quadro e usar `complete_tasks` com nota ao terminar;
- conferir `list_tasks` antes de criar, para não duplicar;
- escrever títulos curtos e descrições com contexto para retomar;
- quebrar trabalho grande em subtarefas e dependências, com prazo só quando houver prazo real.

O próprio MCP também envia instruções equivalentes ao conectar, no campo `instructions` do `initialize`.

### 9.3 Hook SessionStart

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
            "command": "/Users/zffaleta/.local/bin/node --no-warnings /Users/zffaleta/Developer/claude-tasks/bin/session-start.js",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

### 9.4 Chat do painel

`POST /api/chat` executa:

```
claude -p "<mensagem>" --output-format stream-json --verbose --model <sonnet|opus|haiku>
       --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{"tarefas":…}}'
       --allowedTools mcp__tarefas --append-system-prompt "<contexto>" [--resume <sessão>]
```

- **Isolamento:** `--tools ""` desliga todas as ferramentas internas (arquivos, terminal, web), e `--strict-mcp-config` carrega só o MCP do quadro.
- **Diretório e banco:** o processo roda em `data/`, com `CLAUDE_TASKS_DB` apontando para o mesmo banco.
- **Um envio por vez:** cada pessoa tem uma conversa ativa; um segundo envio simultâneo recebe 409.
- **Histórico:** fica em `chat_messages`, com as últimas 60 mensagens. O id da sessão da CLI é guardado em `settings` (`chat_session:<usuário>`) para continuar a conversa.
- **Falhas:** mensagens "sintéticas" da CLI, como login expirado, viram um erro legível e não entram no histórico.
- **Cancelamento:** fechar a conexão encerra o processo da CLI.

---

## 10. Modelo de dados

Datas e horas são ISO 8601 em UTC (`created_at` etc.). Datas de calendário (`start_date`, `due_date`) são `AAAA-MM-DD` no fuso local. JSON é guardado como texto.

### projects
| Coluna | Tipo | Notas |
| --- | --- | --- |
| id | INTEGER PK | |
| name | TEXT | |
| path | TEXT UNIQUE | raiz do repositório; NULL em projetos sem pasta |
| description | TEXT | |
| color | TEXT | hex; NULL = cor derivada do nome |
| archived_at | TEXT | |
| created_at | TEXT | |

### tasks
| Coluna | Tipo | Notas |
| --- | --- | --- |
| id | INTEGER PK | número global |
| project_id | → projects | ON DELETE CASCADE |
| title, description | TEXT | |
| status | TEXT | CHECK todo/doing/blocked/done |
| priority | TEXT | CHECK low/medium/high/urgent |
| type | TEXT | CHECK task/bug/story/epic |
| tags | TEXT (JSON) | lista |
| source | TEXT | claude / user / automação / você |
| parent_id | → tasks | CASCADE |
| sprint_id | → sprints | SET NULL |
| column_id | → columns | SET NULL |
| start_date, due_date | TEXT | AAAA-MM-DD |
| estimate_minutes | INTEGER | |
| rank | REAL | ordem na coluna |
| recurrence | TEXT (JSON) | `{freq, interval, until?}` |
| recurrence_next_id | INTEGER | próxima ocorrência já criada |
| archived_at | TEXT | |
| created_by | → users | SET NULL |
| created_at, updated_at, completed_at | TEXT | |

### notes (histórico)
| Coluna | Notas |
| --- | --- |
| task_id → tasks (CASCADE) | |
| kind | `note` (comentário) ou `event` |
| author | claude / user / automação / você |
| user_id → users | quem, quando é uma pessoa |
| body, created_at | |

### columns
`id, project_id → projects (CASCADE), name, status (categoria), color, position`

### sprints
`id, project_id → projects (CASCADE), name, goal, status (planning/active/completed), start_date, end_date, created_at, completed_at`

### dependencies
`task_id → tasks, blocked_by → tasks` (PK composta, ambos CASCADE, CHECK task_id ≠ blocked_by), `created_at`

### assignees
`task_id → tasks, user_id → users` (PK composta, CASCADE)

### time_entries
`id, task_id → tasks (CASCADE), user_id → users (SET NULL), author, started_at, ended_at (NULL = rodando), minutes, note, created_at`

### attachments
`id, task_id → tasks (CASCADE), name, stored (nome do arquivo), mime, size, author, user_id, created_at`

### users / sessions / invites
- `users`: `id, name, email (UNIQUE NOCASE), password_hash, role (admin/member), color, created_at, last_seen_at`
- `sessions`: `token PK, user_id → users (CASCADE), created_at, expires_at`
- `invites`: `token PK, email, role, created_by, created_at, expires_at, used_at, used_by`

### notifications
`id, user_id → users (CASCADE; NULL = modo sem contas), task_id → tasks (CASCADE), key (deduplicação), body, read_at, created_at`

### automations / automation_fired
- `automations`: `id, project_id (NULL = todos), name, trigger, conditions (JSON), action (JSON {type, value}), enabled, run_count, last_run_at, created_at`
- `automation_fired`: `(automation_id, task_id)` PK, `fired_at`, usada pelos gatilhos por tempo

### settings
`key PK, value (JSON)`. As chaves são `notify_macos` (padrão true), `due_soon_days` (1), `chat_model` ("sonnet") e `chat_session:<usuário>`.

### chat_messages
`id, user_id, role (user/assistant), body, tools (JSON), created_at`

### Índices
Os índices cobrem os acessos mais comuns:

- `tasks(project_id, status)`, `tasks(parent_id)`, `tasks(sprint_id)`, `tasks(due_date)`
- `notes(task_id)`, `dependencies(blocked_by)`, `time_entries(task_id)`, `attachments(task_id)`
- `notifications(user_id, read_at)`, `notifications(key)`

---

## 11. API REST

Base: `http://localhost:4317/api`.

**Regras gerais:**

- **Formato:** requisições e respostas em JSON, exceto upload, download de anexo e chat.
- **Erros:** `{ "error": "mensagem" }`, com 400 (validação), 401 (sem login), 403 (permissão, origem ou host), 404, 409 (conflito), 413 (corpo grande) ou 415 (Content-Type).
- **Autenticação:** cookie `tk_session`. As rotas marcadas como públicas não exigem login.
- **POST e PATCH:** exigem `Content-Type: application/json` (exceto upload) e, se houver `Origin`, que ele seja um host permitido.

### 11.1 Autenticação e convites (públicas)

| Método | Rota | Corpo | Resposta |
| --- | --- | --- | --- |
| GET | `/auth/me` | — | `{ user \| null, setup, unread }`. `setup: true` = nenhuma conta ainda |
| POST | `/auth/setup` | `{ name, email, password }` | `{ user }` + cookie. 409 se já existe conta |
| POST | `/auth/login` | `{ email, password }` | `{ user }` + cookie |
| POST | `/auth/logout` | — | `{ ok }` e apaga o cookie |
| GET | `/invites/:token` | — | `{ email, role }` ou 400 se inválido ou expirado |
| POST | `/invites/:token/accept` | `{ name, email, password }` | `{ user }` + cookie |

### 11.2 Quadro e tarefas

| Método | Rota | Corpo / parâmetros | Resposta |
| --- | --- | --- | --- |
| GET | `/version` | — | `{ version, unread }` |
| GET | `/state` | `?project=ID&archived=1` | `{ version, projects, tasks, dependencies, users, columns, sprints, timers, unread, today }`. As tarefas incluem as abertas e as concluídas nos últimos 60 dias. |
| GET | `/tasks/:id` | — | tarefa + `notes, subtasks, blockers, blocking, time_entries, attachments, columns, assignees, sprints` |
| POST | `/tasks` | campos da tarefa + `project_id` ou `project_name` | tarefa criada |
| PATCH | `/tasks/:id` | qualquer campo (ver abaixo) | tarefa atualizada |
| DELETE | `/tasks/:id` | — | `{ ok }` |
| POST | `/tasks/:id/notes` | `{ body }` | `{ ok }` |
| POST | `/tasks/:id/blockers` | `{ blocked_by }` | `{ ok }` |
| DELETE | `/tasks/:id/blockers/:bid` | — | `{ ok }` |

**Campos aceitos em POST e PATCH de tarefa:**

- `title`, `description`, `status`, `priority`, `type`, `tags` (lista ou texto separado por vírgulas);
- `column` (id, nome ou status), `start_date`, `due_date`;
- `estimate` (texto) ou `estimate_minutes`;
- `parent_id`, `sprint` ou `sprint_id` (id, nome, `"active"`, `null`);
- `assignees` (ids, nomes ou e-mails) ou `assignee_ids`;
- `blocked_by` (lista, substitui), `recurrence` (`{freq, interval, until}` ou `null`);
- `rank`, `archived` (bool), `project_id` (mover).

### 11.3 Tempo e anexos

| Método | Rota | Corpo | Resposta |
| --- | --- | --- | --- |
| POST | `/tasks/:id/timer` | `{ action: "start" \| "stop" }` | `{ timers }` (seus timers rodando) |
| POST | `/tasks/:id/time` | `{ duration, date?, note? }` | `{ ok }` |
| DELETE | `/time/:id` | — | `{ ok }` |
| POST | `/tasks/:id/attachments` | **corpo binário**. Cabeçalhos `X-Filename` (URI-encoded) e `Content-Type`. Exige `Origin`. | anexo |
| GET | `/attachments/:id` | — | o arquivo (`inline` para imagens, PDF e vídeo; senão `attachment`) |
| DELETE | `/attachments/:id` | — | `{ ok }` |

### 11.4 Projetos, colunas e sprints

| Método | Rota | Corpo | Resposta |
| --- | --- | --- | --- |
| POST | `/projects` | `{ name, description?, color? }` | projeto |
| PATCH | `/projects/:id` | `{ name?, description?, color?, archived? }` | projeto |
| DELETE | `/projects/:id` | — (**admin**) | `{ ok }` |
| GET | `/projects/:id/columns` | — | colunas (virtuais com `id: null` se não há próprias) |
| POST | `/projects/:id/columns` | `{ name, status, color? }` | coluna |
| PATCH | `/columns/:id` | `{ name?, status?, color?, move?: "left" \| "right" }` | coluna |
| DELETE | `/columns/:id` | — | `{ ok }` |
| GET | `/projects/:id/sprints` | — | sprints com `total` e `done` |
| POST | `/projects/:id/sprints` | `{ name?, goal?, start_date?, end_date? }` | sprint |
| PATCH | `/sprints/:id` | mesmos campos | sprint |
| POST | `/sprints/:id/start` | `{}` | sprint |
| POST | `/sprints/:id/complete` | `{ move_to?: id }` | `{ sprint, moved, moved_to }` |
| DELETE | `/sprints/:id` | — | `{ ok }` |

### 11.5 Dashboard, automações, equipe, notificações e configurações

| Método | Rota | Corpo | Resposta |
| --- | --- | --- | --- |
| GET | `/stats` | `?project=ID` | `{ totals, weeks, byPriority, byProject, timeByProject, upcoming, sprint, activity }` |
| GET | `/automations` | — | regras |
| POST | `/automations` | `{ name, project_id?, trigger, conditions?, action: {type, value}, enabled? }` (**admin**) | regra |
| PATCH | `/automations/:id` | mesmos campos (**admin**) | regra |
| DELETE | `/automations/:id` | — (**admin**) | `{ ok }` |
| GET | `/users` | — | membros |
| PATCH | `/users/:id` | `{ name?, email?, color?, role? (admin), password?, current_password? (própria conta) }` | membro |
| DELETE | `/users/:id` | — (**admin**, não a própria conta) | `{ ok }` |
| GET | `/invites` | — (**admin**) | convites pendentes |
| POST | `/invites` | `{ email?, role }` (**admin**) | convite com `token` |
| DELETE | `/invites/:token` | — (**admin**) | `{ ok }` |
| GET | `/notifications` | — | `{ items, unread }` |
| POST | `/notifications/read` | `{ ids: [..] \| "all" }` | `{ unread }` |
| GET | `/settings` | — | `{ notify_macos, due_soon_days, chat_model }` |
| PATCH | `/settings` | mesmos campos (**admin**) | configurações |

### 11.6 Chat

| Método | Rota | Corpo | Resposta |
| --- | --- | --- | --- |
| GET | `/chat` | — | `{ messages }` |
| DELETE | `/chat` | — | `{ ok }` (nova conversa) |
| POST | `/chat` | `{ message, project_id? }` | **NDJSON em streaming**, uma linha por evento |

Os eventos do streaming são:

- `{"type":"tool","name":"add_tasks"}`
- `{"type":"text","text":"…"}`
- `{"type":"error","message":"…"}`
- `{"type":"done"}`

---

## 12. Segurança

| Ameaça | Proteção |
| --- | --- |
| Acesso de outras máquinas | O servidor escuta só em `127.0.0.1` por padrão |
| DNS rebinding | Cabeçalho `Host` precisa estar na lista permitida (`localhost:4317`, `127.0.0.1:4317` e `CLAUDE_TASKS_HOSTS`); senão, 403 |
| CSRF (outro site chamando a API) | POST, PATCH e DELETE com `Origin` de fora são recusados. JSON obrigatório força preflight CORS (que o servidor não responde). Upload exige `Origin`. Cookie `SameSite=Lax`. |
| Senhas | scrypt com salt por usuário; comparação em tempo constante |
| Sessões | token de 256 bits, `HttpOnly`, expira em 90 dias |
| Anexos maliciosos | download com `X-Content-Type-Options: nosniff` e `Content-Security-Policy: default-src 'none'; sandbox`. SVG e HTML nunca abrem inline. Nome saneado e arquivo gravado com nome gerado. |
| XSS no Markdown | todo texto é escapado antes da formatação; links e imagens só aceitam `http(s):` ou `/api/attachments/` |
| Chat | a CLI roda sem ferramentas internas (`--tools ""`) e só com o MCP do quadro |
| MCP | roda localmente, com o mesmo usuário do sistema, sem autenticação (quem pode rodar processos no Mac já pode ler o banco). Exclusões exigem `confirm: true`. Não há ferramenta para criar convites ou mudar papéis. |
| Perda de dados | backup automático antes de cada migração; transações em toda gravação |

---

## 13. Desenvolvimento e testes

```bash
npm start   # painel em http://localhost:4317 (use outra porta para não brigar com o serviço)
npm test    # 16 testes: API real (servidor numa porta livre) e MCP real (stdio), com bancos temporários
```

- **Rodar em paralelo ao serviço:** `CLAUDE_TASKS_DB=/tmp/teste.db CLAUDE_TASKS_PORT=4318 npm start`.
- **Front-end sem build:** edite `public/` e recarregue a página.
- **Servidor:** depois de mudar `src/`, reinicie o servidor (ou o serviço).
- **Nova migração:** adicione uma função ao fim de `MIGRATIONS` em `src/db.js`, sem nunca alterar as anteriores. O backup é feito automaticamente.
- **Convenções:**
  - código e comentários em português;
  - validação no `Store` (`ValidationError` vira 400 na API e `isError` no MCP);
  - toda gravação dentro de `store.transaction`.

---

## 14. Solução de problemas

| Sintoma | Causa provável | O que fazer |
| --- | --- | --- |
| O painel não abre | serviço parado | `launchctl print gui/$(id -u)/com.claude-tasks.dashboard`; veja `data/server.log`; `bin/service.sh install` |
| "A porta 4317 já está em uso" | outro processo na porta | `lsof -iTCP:4317 -sTCP:LISTEN` e encerre-o, ou mude a porta |
| Painel mostra "sem conexão" | servidor caiu ou está reiniciando | aguarde o launchd (até 30 s) ou veja o log |
| O Claude não registra tarefas | MCP não carregado na sessão | `claude mcp list` (deve mostrar `tarefas … ✔ Connected`); abra uma **nova** sessão; confira `~/.claude/CLAUDE.md` |
| Ferramentas novas não aparecem | sessão aberta antes da atualização | reabra a sessão |
| Toda chamada pede permissão | permissão do MCP | escolha "Sempre permitir" ou adicione `"mcp__tarefas"` em `permissions.allow` do `~/.claude/settings.json` |
| Tarefa foi para o projeto errado | `project_path` diferente | mova pelo detalhe (campo Projeto) ou com `update_task` `project` |
| Chat: "A CLI do Claude não está logada" | OAuth expirado | `claude` no Terminal → `/login` |
| Chat: "Não encontrei a CLI do Claude" | binário fora do caminho padrão | defina `CLAUDE_BIN` no serviço |
| Sem notificações do macOS | desligadas nas Configurações ou nos Ajustes do Sistema | ligue em Configurações; permita "Script Editor/osascript" em Ajustes → Notificações |
| "database is locked" | gravação muito longa concorrente | raro (há espera de 5 s); tente de novo |
| Esqueci a senha (única conta) | — | um administrador pode redefinir; sem nenhum, pare o serviço e rode `sqlite3 data/tasks.db "DELETE FROM sessions; DELETE FROM users;"` para refazer o primeiro acesso (as tarefas são mantidas) |

---

## 15. Limitações conhecidas

- **Sem tempo real por WebSocket:** a atualização é por polling a cada 2 s.
- **Painel sem paginação:** carrega as tarefas abertas mais as concluídas nos últimos 60 dias (até 5000). Concluídas mais antigas só aparecem pelo MCP (`list_tasks status: done`) ou pela busca na API.
- **Sem envio de e-mail:** convites são links para copiar e notificações ficam no painel e no macOS.
- **Sem importação de Jira ou Trello** (fora do escopo escolhido).
- **Sem campos personalizados e sem observadores** ("watchers").
- **Chat:** depende da CLI do Claude Code instalada e logada no mesmo Mac do servidor.
- **Fuso horário:** as datas de calendário usam o fuso do Mac que roda o servidor e o MCP.
