# MCP `tarefas` — Referência completa

> Servidor MCP 3.0 do Quadro de Tarefas · transporte stdio · protocolos 2024-11-05, 2025-03-26, 2025-06-18 e 2025-11-25

O MCP `tarefas` é a ponte entre o Claude e o quadro central de tarefas. Com ele, o Claude registra, consulta, organiza e conclui tarefas de **qualquer projeto**, gerencia sprints, colunas e automações, controla tempo, lê anexos e gera relatórios. Tudo vai para o mesmo banco do painel (http://localhost:4317).

A documentação do sistema como um todo (painel, regras de negócio, modelo de dados, API REST) está em [SISTEMA.md](SISTEMA.md).

## Sumário

1. [Visão geral](#1-visão-geral)
2. [Instalação e configuração](#2-instalação-e-configuração)
3. [Como o Claude usa o quadro](#3-como-o-claude-usa-o-quadro)
4. [Convenções](#4-convenções)
5. [Ferramentas](#5-ferramentas)
6. [Resources](#6-resources)
7. [Prompts (comandos de barra)](#7-prompts-comandos-de-barra)
8. [Autocompletar](#8-autocompletar)
9. [Erros](#9-erros)
10. [Protocolo](#10-protocolo)
11. [Segurança](#11-segurança)
12. [Solução de problemas](#12-solução-de-problemas)
13. [Histórico de versões](#13-histórico-de-versões)

---

## 1. Visão geral

| Capacidade | O que oferece |
| --- | --- |
| **Tools** (24) | Ações e consultas: tarefas, projetos, colunas, sprints, tempo, anexos, visão geral, atividade, equipe, notificações, automações, configurações |
| **Resources** | Conteúdo citável com `@` numa conversa: visão geral, minhas tarefas, quadro de cada projeto, qualquer tarefa |
| **Prompts** (9) | Fluxos prontos que viram comandos no Claude Code: `/mcp__tarefas__proxima`, `/mcp__tarefas__planejar_sprint`… |
| **Completions** | Autocompletar de projetos, tarefas e opções nos argumentos dos prompts e resources |
| **Instructions** | Regras de uso enviadas ao Claude ao conectar (quando registrar, como escrever, nunca excluir sem pedido) |

**Características:**

- **Sem dependências:** é um único processo Node (`src/mcp.js`), que o Claude Code inicia em cada sessão.
- **Grava direto no SQLite**, em modo WAL. Várias sessões e o painel podem gravar ao mesmo tempo, e o painel vê as mudanças em cerca de 2 s.
- **Mesmas regras do painel:** validação, duplicatas, automações e notificações também valem para o que o Claude faz.
- **Anotações em toda ferramenta:** `title`, `readOnlyHint`, `destructiveHint` e `openWorldHint: false`.

---

## 2. Instalação e configuração

### 2.1 Registrar no Claude Code

No escopo de usuário, para valer em todos os projetos:

```bash
claude mcp add --scope user tarefas -- "$(command -v node)" --no-warnings ~/Developer/claude-tasks/src/mcp.js
```

Com variáveis de ambiente (veja 2.3):

```bash
claude mcp add --scope user tarefas \
  -e CLAUDE_TASKS_USER=voce@exemplo.com \
  -- "$(command -v node)" --no-warnings ~/Developer/claude-tasks/src/mcp.js
```

> Use o caminho absoluto do `node`. Apps de interface (como o Claude Desktop) nem sempre têm `~/.local/bin` ou o nvm no `PATH`.

### 2.2 Verificar

```bash
claude mcp list          # tarefas: … - ✔ Connected
```

Dentro de uma sessão, o comando `/mcp` mostra o estado do servidor, as ferramentas, os resources e os prompts.

### 2.3 Variáveis de ambiente

| Variável | Padrão | Efeito no MCP |
| --- | --- | --- |
| `CLAUDE_TASKS_DB` | `data/tasks.db` do projeto | Qual banco usar |
| `CLAUDE_TASKS_USER` | — | Quem é "eu" (`me`): e-mail ou nome de um membro do quadro. Sem ela, se o quadro tem **uma única conta**, essa conta é "eu". |
| `CLAUDE_TASKS_PORT` | `4317` | Porta usada nos links devolvidos (`http://localhost:4317/?task=12`) |
| `CLAUDE_TASKS_NO_OS_NOTIFY` | — | Se definida, notificações criadas pelo MCP não aparecem no macOS |

**O que "eu" muda na prática:**

- **Tempo:** timers e tempo registrados pelo Claude contam para você e aparecem no painel como "Claude · Seu nome". O timer iniciado pelo Claude aparece no seu cabeçalho.
- **Filtros:** `assignee: "me"`, `assignees: ["me"]` e `to: ["me"]` passam a funcionar.
- **Resource:** `tarefas://my-tasks` mostra as suas tarefas.
- **Notificações:** `list_notifications` lê as suas.

### 2.4 Permissões

Na primeira chamada, o Claude Code pede permissão para cada ferramenta. Opções:

- **Na hora:** escolha "Sempre permitir".
- **Liberar tudo** em `~/.claude/settings.json`:

  ```json
  { "permissions": { "allow": ["mcp__tarefas"] } }
  ```

- **Liberar só as de leitura** e continuar perguntando nas demais:

  ```json
  {
    "permissions": {
      "allow": [
        "mcp__tarefas__list_tasks", "mcp__tarefas__get_task", "mcp__tarefas__list_projects",
        "mcp__tarefas__get_overview", "mcp__tarefas__get_activity", "mcp__tarefas__time_report",
        "mcp__tarefas__get_attachment", "mcp__tarefas__list_members"
      ]
    }
  }
  ```

- **Bloquear as destrutivas:** coloque `mcp__tarefas__delete_tasks` (e, se quiser, `mcp__tarefas__manage_project`) em `permissions.deny`.

### 2.5 Outros clientes MCP

Qualquer cliente que fale MCP por stdio funciona. Exemplo para o Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "tarefas": {
      "command": "/Users/voce/.local/bin/node",
      "args": ["--no-warnings", "/Users/voce/Developer/claude-tasks/src/mcp.js"],
      "env": { "CLAUDE_TASKS_USER": "voce@exemplo.com" }
    }
  }
}
```

Fora do Claude Code não existe "diretório da sessão". Por isso, informe sempre `project` ou `project_path` nas chamadas.

### 2.6 Atualizar

O código do MCP é lido quando a sessão começa. Depois de atualizar o projeto, **abra uma sessão nova** (ou rode `/mcp` → reconectar) para ter as ferramentas novas. Sessões antigas continuam funcionando com o banco atualizado.

---

## 3. Como o Claude usa o quadro

### 3.1 Regras enviadas ao conectar (`instructions`)

1. Registrar com `add_tasks` tudo que fica pendente: follow-ups sugeridos, bugs vistos e não corrigidos, etapas que ficaram para depois e o que o usuário pedir para "fazer depois". Não registrar o que vai terminar no mesmo turno.
2. Passar sempre `project_path` = diretório atual.
3. Consultar `list_tasks` antes de criar, e atualizar em vez de duplicar.
4. Títulos curtos e acionáveis; descrição suficiente para retomar do zero.
5. Quebrar trabalho grande em subtarefas (`parent_id`) e ordem (`blocked_by`); `due_date` só com prazo real.
6. Ao começar uma tarefa do quadro: status `doing` (e timer, se o usuário controla tempo). Travou: `blocked` com nota. Terminou: `complete_tasks` com nota.
7. Usar `get_overview` para "como estão as coisas?", `time_report` para perguntas de tempo e `get_attachment` para ver prints.
8. Nunca excluir sem pedido explícito; preferir arquivar.
9. Escrever em português do Brasil.

A instrução global em `~/.claude/CLAUDE.md` reforça os itens 1 a 5 como preferência do usuário.

### 3.2 Ciclo de vida típico

```
conversa ─▶ algo fica para depois ─▶ list_tasks (já existe?) ─▶ add_tasks
                                                                  │
outra sessão ─▶ hook SessionStart mostra as pendências ─▶ /mcp__tarefas__proxima
                                                                  │
            update_task status=doing ─▶ timer start ─▶ trabalho ─▶ complete_tasks (nota) ─▶ timer para
```

### 3.3 Exemplos de pedidos que o Claude resolve com o MCP

| Você diz | O Claude usa |
| --- | --- |
| "Anota isso para depois" | `list_tasks` + `add_tasks` |
| "O que tem pendente aqui?" | `list_tasks` ou o prompt `pendencias` |
| "Quebra essa feature em etapas" | `add_tasks` com `parent_id` e `blocked_by` |
| "Coloca as tarefas de UI na próxima sprint" | `manage_sprints` + `update_tasks` |
| "Quanto tempo gastei no SIRAC essa semana?" | `time_report` |
| "Olha o print que eu anexei na #12" | `get_task` + `get_attachment` |
| "Cria uma coluna Homologação" | `manage_columns` |
| "Toda tarefa bloqueada vira urgente" | `manage_automations` |
| "Me lembra de revisar isso" | `send_notification` ou `add_tasks` com prazo |
| "Como estão os projetos?" | `get_overview` |

---

## 4. Convenções

### 4.1 Resolução do projeto

Toda ferramenta que trabalha com projeto aceita:

| Parâmetro | Como resolve |
| --- | --- |
| `project_path` | Caminho absoluto. Sobe até a **raiz do repositório git**. Worktrees viram o repositório principal. Pastas sem git usam o próprio caminho. Se o projeto não existe, as ferramentas de escrita o criam com o nome da pasta. |
| `project` | Nome (sem diferenciar maiúsculas) ou id numérico. Se não existe, `add_tasks` cria um projeto sem pasta com esse nome. |
| nenhum | Ferramentas de escrita usam o **diretório da sessão** (`cwd` do processo MCP). Ferramentas de consulta, sem projeto, olham **todos** os projetos. |

`project_path` tem precedência sobre `project`.

### 4.2 Valores

| Tipo | Formato |
| --- | --- |
| Status | `todo`, `doing`, `blocked`, `done` (listagens também aceitam `open` = tudo menos done, e `all`) |
| Prioridade | `urgent`, `high`, `medium`, `low` |
| Tipo | `task`, `bug`, `story`, `epic` |
| Datas | `AAAA-MM-DD` no fuso local; `null` limpa o campo |
| Duração | `"45m"`, `"2h"`, `"1h30m"`, `"1,5h"`, `"1d"` (= 8h) ou número de minutos |
| Recorrência | `{ "freq": "daily\|weekly\|monthly\|yearly", "interval": 1, "until": "AAAA-MM-DD" }`; `null` remove |
| Sprint | id, nome, `"active"` (a ativa) ou `null` (backlog) |
| Coluna | nome (`"Revisão"`), id ou nome de status |
| Pessoas | nome, e-mail ou `"me"` |

### 4.3 Comportamentos importantes

- **Duplicatas:** `add_tasks` não cria uma tarefa se já existir uma **aberta** com o mesmo título no mesmo projeto e sob a mesma tarefa-mãe. Ela devolve `já existia: #id`.
- **Status × coluna:** informar `column` ajusta o `status` para a categoria da coluna. Informar só `status` coloca a tarefa na primeira coluna daquela categoria.
- **Prioridade e ordem:** mudar a prioridade reposiciona a tarefa na faixa dela. `position: top|bottom` move para o topo ou o fim da coluna.
- **Transações:** cada chamada é atômica; se um item falha, nada daquela chamada é gravado.
- **Autoria:** tudo que o MCP faz fica registrado como **Claude** no histórico. As tarefas criadas recebem `source = claude`, o que alimenta o selo ✳ no painel e o indicador "Registradas pelo Claude".
- **Automações:** mudanças do Claude disparam as regras do quadro.

### 4.4 Formato das tarefas nas respostas

As respostas em texto usam uma linha por tarefa:

```
#4 [história] [a fazer] [média] Zoom nas fotos (produto) · prazo 2026-11-12 (atrasada) · subtarefas 1/3 · bloqueada por 1 · sprint Sprint 1 · subtarefa de #2 — Loja
│   │          │         │      │              │          │                          │                  │               │                 │                  └ projeto (em listagens de vários)
│   │          │         │      │              │          │                          │                  │               │                 └ é subtarefa
│   │          │         │      │              │          │                          │                  │               └ sprint
│   │          │         │      │              │          │                          │                  └ bloqueadores ainda abertos
│   │          │         │      │              │          │                          └ progresso das subtarefas
│   │          │         │      │              │          └ prazo (e se está atrasada)
│   │          │         │      │              └ tags
│   │          │         │      └ título
│   │          │         └ prioridade
│   │          └ status
│   └ tipo (omitido quando é "tarefa")
└ id
```

`list_tasks`, `get_task`, `list_projects`, `time_report` e `get_overview` aceitam `format: "json"` para devolver dados estruturados.

---

## 5. Ferramentas

### 5.0 Índice

Legenda: 🔍 só leitura · ✏️ escreve · ⚠️ pode excluir

| Ferramenta | Título | Tipo |
| --- | --- | --- |
| [`add_tasks`](#add_tasks) | Adicionar tarefas | ✏️ |
| [`list_tasks`](#list_tasks) | Listar tarefas | 🔍 |
| [`get_task`](#get_task) | Ver tarefa | 🔍 |
| [`update_task`](#update_task) | Atualizar tarefa | ✏️ |
| [`update_tasks`](#update_tasks) | Atualizar várias tarefas | ✏️ |
| [`complete_tasks`](#complete_tasks) | Concluir tarefas | ✏️ |
| [`delete_tasks`](#delete_tasks) | Excluir tarefas | ⚠️ |
| [`add_comment`](#add_comment) | Comentar | ✏️ |
| [`list_projects`](#list_projects) | Listar projetos | 🔍 |
| [`manage_project`](#manage_project) | Gerenciar projeto | ⚠️ |
| [`manage_columns`](#manage_columns) | Gerenciar colunas | ⚠️ |
| [`manage_sprints`](#manage_sprints) | Gerenciar sprints | ⚠️ |
| [`timer`](#timer) | Timer | ✏️ |
| [`log_time`](#log_time) | Registrar tempo | ✏️ |
| [`time_report`](#time_report) | Relatório de tempo | 🔍 |
| [`attach_file`](#attach_file) | Anexar arquivo | ✏️ |
| [`get_attachment`](#get_attachment) | Ler anexo | 🔍 |
| [`get_overview`](#get_overview) | Visão geral | 🔍 |
| [`get_activity`](#get_activity) | Atividade recente | 🔍 |
| [`list_members`](#list_members) | Listar membros | 🔍 |
| [`send_notification`](#send_notification) | Enviar notificação | ✏️ |
| [`list_notifications`](#list_notifications) | Ver notificações | ✏️ |
| [`manage_automations`](#manage_automations) | Gerenciar automações | ⚠️ |
| [`manage_settings`](#manage_settings) | Configurações do quadro | ✏️ |

Nos exemplos abaixo, `/Users/voce/Developer/Loja` é um repositório git qualquer.

---

### Tarefas

#### `add_tasks`

Cria uma ou várias tarefas num projeto. É a ferramenta principal do registro automático de pendências.

| Parâmetro | Tipo | Obrig. | Descrição |
| --- | --- | --- | --- |
| `project_path` | string | | Caminho dentro do projeto (normalmente o diretório atual) |
| `project` | string | | Nome ou id do projeto |
| `tasks` | array | ✓ | Lista de tarefas (mínimo 1), cada uma com os campos abaixo |

Campos de cada item de `tasks`:

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `title` | string ✓ | Título curto e acionável (até 300 caracteres) |
| `description` | string | Contexto (Markdown) |
| `priority` | enum | Padrão `medium` |
| `status` | enum | Padrão `todo` |
| `column` | string | Coluna do quadro (ajusta o status) |
| `type` | enum | Padrão `task` |
| `tags` | string[] | Até 12 |
| `start_date`, `due_date` | data | |
| `estimate` | duração | |
| `parent_id` | integer | Cria como subtarefa (herda o projeto da mãe) |
| `blocked_by` | integer[] | Tarefas que precisam vir antes |
| `sprint` | string | id, nome ou `"active"` |
| `assignees` | string[] | Nomes, e-mails ou `"me"` |
| `recurrence` | objeto | Ver 4.2 |

**Exemplo**

```json
{
  "project_path": "/Users/voce/Developer/Loja",
  "tasks": [
    {
      "title": "Corrigir cálculo de frete",
      "type": "bug", "priority": "high", "tags": ["checkout"],
      "due_date": "2026-11-05", "estimate": "3h",
      "description": "Frete grátis não aplica acima de R$ 200.\n\n- Arquivo: `src/checkout/frete.ts`"
    },
    { "title": "Nova página de produto", "type": "story", "estimate": "2d" }
  ]
}
```

```
Projeto: Loja
criada: #1 [bug] [a fazer] [alta] Corrigir cálculo de frete (checkout) · prazo 2026-11-05
criada: #2 [história] [a fazer] [média] Nova página de produto
Quadro: http://localhost:4317/?project=1
```

**Subtarefas com ordem:**

```json
{ "project_path": "/Users/voce/Developer/Loja",
  "tasks": [ { "title": "Layout da galeria", "parent_id": 2, "estimate": "4h" },
             { "title": "Zoom nas fotos", "parent_id": 2, "blocked_by": [3] } ] }
```

```
Projeto: Loja
criada: #3 [a fazer] [média] Layout da galeria · subtarefa de #2
criada: #4 [a fazer] [média] Zoom nas fotos · bloqueada por 1 · subtarefa de #2
Quadro: http://localhost:4317/?project=1
```

**Erros comuns:**

- `"priority" deve ser um de: low, medium, high, urgent`
- `Tarefa-mãe #99 não encontrada`
- `#3 já depende de #4: isso criaria um ciclo`
- `Coluna "X" não existe. Colunas: …`
- `Membro "Fulano" não encontrado`

---

#### `list_tasks`

Lista tarefas com filtros. Sem projeto, lista todos os projetos, agrupados.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `project_path` / `project` | string | Limita a um projeto |
| `status` | enum | `open` (padrão), `all`, `todo`, `doing`, `blocked`, `done` |
| `query` | string | Busca em título, descrição e tags; `"#12"` busca pelo id |
| `due` | enum | `overdue`, `today`, `week` (próximos 7 dias), `any`, `none` |
| `sprint` | string | id, nome, `"active"` ou `"backlog"` (exige projeto) |
| `assignee` | string | Nome, e-mail ou `"me"` |
| `type` | enum | `task`, `bug`, `story`, `epic` |
| `column` | string | Só a coluna informada (exige projeto) |
| `parent_id` | integer | Só as subtarefas dessa tarefa |
| `include_subtasks` | boolean | Padrão `true` |
| `include_archived` | boolean | Padrão `false` |
| `sort` | enum | `board` (padrão: andamento → bloqueadas → a fazer → concluídas, depois ordem manual), `priority`, `due`, `updated`, `created` |
| `limit` | integer | 1–500, padrão 100 |
| `format` | enum | `text` (padrão) ou `json` |

```json
{ "project_path": "/Users/voce/Developer/Loja" }
```

```
Projeto: Loja · 4 tarefa(s)
#1 [bug] [a fazer] [alta] Corrigir cálculo de frete (checkout) · prazo 2026-11-05
#2 [história] [a fazer] [média] Nova página de produto · subtarefas 0/2
#3 [a fazer] [média] Layout da galeria · subtarefa de #2
#4 [a fazer] [média] Zoom nas fotos · bloqueada por 1 · subtarefa de #2
```

Com `format: "json"`, a resposta é `{ "total": n, "tasks": [ … ] }`. Cada tarefa traz:

- `id`, `title`, `project`, `project_id`, `status`, `column`, `priority`, `type`, `tags`;
- `start_date`, `due_date`, `overdue`, `estimate_minutes`, `spent_minutes`;
- `sprint`, `parent_id`, `subtasks {done,total}`, `open_blockers`, `assignees`, `recurrence`;
- `archived`, `source`, `created_at`, `updated_at`, `completed_at`, `url`.

---

#### `get_task`

Mostra uma tarefa completa: descrição, subtarefas, dependências (nos dois sentidos), anexos (com ids para `get_attachment`), tempo registrado e histórico.

| Parâmetro | Tipo | Obrig. | Descrição |
| --- | --- | --- | --- |
| `id` | integer | ✓ | |
| `format` | enum | | `text` ou `json` |

```json
{ "id": 2 }
```

```
#2 [história] [a fazer] [média] Nova página de produto · subtarefas 0/2
Projeto: Loja (/Users/voce/Developer/Loja) · coluna: A fazer
tempo 0m de 16h
Criada: 2026-10-31T23:17:36.585Z por claude · Atualizada: … · http://localhost:4317/?task=2

(sem descrição)

Subtarefas:
- #3 [a fazer] [média] Layout da galeria · subtarefa de #2
- #4 [a fazer] [média] Zoom nas fotos · bloqueada por 1 · subtarefa de #2
```

As seções "Bloqueada por", "Bloqueia", "Anexos (leia com get_attachment)", "Tempo registrado" e "Histórico" aparecem quando têm conteúdo. Em `json`, a resposta também traz `description`, `subtasks[]`, `blocked_by[]`, `blocking[]`, `attachments[]`, `time_entries[]` e `notes[]`.

---

#### `update_task`

Altera qualquer campo de uma tarefa. Também move entre projetos e colunas, reordena, arquiva e adiciona nota.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `id` | integer ✓ | |
| todos os campos de `add_tasks` | | `title`, `description`, `priority`, `status`, `column`, `type`, `tags` (substitui), `start_date`, `due_date`, `estimate`, `parent_id` (`null` desvincula), `blocked_by` (substitui), `sprint`, `assignees` (substitui), `recurrence` |
| `note` | string | Adiciona ao histórico |
| `archived` | boolean | Arquiva ou restaura |
| `add_tags` / `remove_tags` | string[] | Muda tags sem reescrever a lista |
| `add_blocked_by` / `remove_blocked_by` | integer[] | Muda dependências sem reescrever a lista |
| `project_path` / `project` | string | **Move** a tarefa (e as subtarefas) para outro projeto. Coluna e sprint são limpas. |
| `position` | `top` \| `bottom` | Topo ou fim da coluna |

```json
{ "id": 1, "status": "doing", "note": "Reproduzido: regra usa > em vez de >=" }
```

```
Atualizada: #1 [bug] [em andamento] [alta] Corrigir cálculo de frete (checkout) · prazo 2026-11-05 — Loja
```

Cada mudança relevante (status, prioridade, prazo, sprint, projeto, arquivamento, responsáveis) vira um evento no histórico.

---

#### `update_tasks`

Aplica a mesma mudança a várias tarefas numa única transação.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `ids` | integer[] ✓ | |
| `status`, `column`, `priority`, `type`, `start_date`, `due_date`, `sprint`, `assignees` | | Como em `update_task` |
| `note`, `archived`, `add_tags`, `remove_tags`, `add_blocked_by`, `remove_blocked_by`, `project_path`, `project` | | Como em `update_task` |

```json
{ "ids": [2, 3, 4], "sprint": "Sprint 1", "add_tags": ["produto"] }
```

```
Atualizadas 3 tarefa(s):
- #2 [história] [a fazer] [média] Nova página de produto (produto) · subtarefas 0/2 · sprint Sprint 1 — Loja
- #3 [a fazer] [média] Layout da galeria (produto) · sprint Sprint 1 · subtarefa de #2 — Loja
- #4 [a fazer] [média] Zoom nas fotos (produto) · bloqueada por 1 · sprint Sprint 1 · subtarefa de #2 — Loja
```

---

#### `complete_tasks`

Conclui tarefas. Para o timer de "eu" que estiver rodando nelas, registra o tempo (se informado) e adiciona a nota. Tarefas recorrentes geram a próxima ocorrência.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `ids` | integer[] ✓ | |
| `note` | string | O que foi feito (vai para o histórico de cada uma) |
| `time_spent` | duração | Tempo a registrar em cada tarefa |

```json
{ "ids": [1], "note": "Corrigido para >= e coberto por teste" }
```

```
concluída: #1 [bug] [concluída] [alta] Corrigir cálculo de frete (checkout) · prazo 2026-11-05 — Loja
```

Com uma tarefa recorrente, a linha termina com `→ próxima ocorrência #15`.

---

#### `delete_tasks`

Exclui **definitivamente** as tarefas, junto com subtarefas, histórico, tempo e arquivos anexados. O Claude só deve usar quando o usuário pedir explicitamente; arquivar é preferível.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `ids` | integer[] ✓ | |
| `confirm` | boolean ✓ | Precisa ser `true` |

```json
{ "ids": [4], "confirm": false }
```

```
Erro: Exclusão não confirmada: envie confirm: true (só quando o usuário pediu para excluir)
```

Com `confirm: true`, a resposta é `Excluídas: #4 Zoom nas fotos`. Ids de subtarefas que já foram excluídas junto com a mãe são ignorados.

---

#### `add_comment`

Adiciona um comentário (Markdown) ao histórico da tarefa. Os responsáveis são notificados.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `id` | integer ✓ | |
| `body` | string ✓ | |

Resposta: `Comentário adicionado em #12 Título.`

---

### Projetos, colunas e sprints

#### `list_projects`

Lista os projetos com contadores e colunas.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `include_archived` | boolean | Padrão `true` |
| `format` | enum | `text` ou `json` (inclui colunas e url) |

```
[1] Loja: 3 abertas (0 em andamento, 0 bloqueadas), 1 concluídas — /Users/voce/Developer/Loja
  colunas: A fazer → Em andamento → Revisão → Bloqueadas → Concluídas
```

Se houver tarefas atrasadas, a linha inclui `, N atrasadas`. Projetos arquivados aparecem com `(arquivado)`.

---

#### `manage_project`

Cria, edita, arquiva, desarquiva ou exclui projetos. Projetos de pasta são criados sozinhos por `add_tasks`; use `create` para projetos sem pasta.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `action` | enum ✓ | `create`, `update`, `archive`, `unarchive`, `delete` |
| `project_path` / `project` | string | Projeto-alvo (exceto create). Sem eles, o da pasta atual. |
| `name` | string | Nome (create) ou novo nome (update) |
| `description` | string | |
| `color` | string | Hex, ex.: `#2a78d6` |
| `confirm` | boolean | `true` obrigatório para `delete` |

```json
{ "action": "create", "name": "Pessoal", "description": "Coisas minhas", "color": "#2a78d6" }
```

```
Projeto criado: [6] Pessoal · http://localhost:4317/?project=6
```

`delete` remove o projeto com **todas** as tarefas e anexos.

---

#### `manage_columns`

Gerencia as colunas do quadro de um projeto. Cada coluna pertence a uma categoria de status. O projeto mantém ao menos uma coluna por categoria, e mudar a categoria de uma coluna muda o status das tarefas dela.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `action` | enum ✓ | `list`, `create`, `update`, `move`, `delete` |
| `project_path` / `project` | string | |
| `column` | string | Nome ou id da coluna (update, move, delete) |
| `name` | string | Nome (create) ou novo nome (update) |
| `status` | enum | Categoria (create, update). Padrão `doing`. |
| `color` | string | |
| `direction` | `left` \| `right` | Para `move` |

As 4 colunas padrão são virtuais; na primeira edição elas viram colunas reais automaticamente.

```json
{ "project_path": "/Users/voce/Developer/Loja", "action": "create", "name": "Revisão", "status": "doing" }
```

```
Colunas de Loja:
1. A fazer [a fazer] (id 1)
2. Em andamento [em andamento] (id 2)
3. Revisão [em andamento] (id 5)
4. Bloqueadas [bloqueada] (id 3)
5. Concluídas [concluída] (id 4)
```

---

#### `manage_sprints`

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `action` | enum ✓ | `list`, `show`, `create`, `update`, `start`, `complete`, `delete` |
| `project_path` / `project` | string | |
| `id` | integer | Sprint (show, update, start, complete, delete) |
| `name`, `goal` | string | |
| `start_date`, `end_date` | data | |
| `move_to` | integer | No `complete`: sprint que recebe as pendentes. Sem ele, vão para o backlog. |

**Regras:**

- Só uma sprint ativa por projeto.
- `start` sem data de início usa hoje.
- `complete` move as tarefas não concluídas e preenche o fim com hoje se estiver vazio.
- `delete` manda as tarefas para o backlog.
- `show` lista as tarefas da sprint.

```json
{ "project_path": "/Users/voce/Developer/Loja", "action": "create", "name": "Sprint 1",
  "goal": "Página de produto", "start_date": "2026-11-02", "end_date": "2026-11-13" }
```

```
Criada: #1 Sprint 1 [planejamento] 2026-11-02 → 2026-11-13 — Página de produto
```

Ao concluir:

```
Concluída: #1 Sprint 1 [concluída] … · 5/7 concluídas. 2 tarefa(s) pendente(s) movida(s) para o backlog.
```

---

### Tempo

#### `timer`

Timer por pessoa: iniciar um novo para o anterior. O tempo conta para "eu" (ver 2.3).

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `action` | enum ✓ | `start`, `stop`, `status` |
| `id` | integer | Tarefa (start, stop) |

```
Timer iniciado em #1 Corrigir cálculo de frete.
Timer parado. #1 soma 1h16m.
#1 Corrigir cálculo de frete: 12m desde 14:05          ← status
```

`complete_tasks` também para o timer da tarefa.

---

#### `log_time`

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `id` | integer ✓ | |
| `duration` | duração ✓ | |
| `date` | data | Padrão hoje |
| `note` | string | |

```json
{ "id": 1, "duration": "1h15m", "note": "investigação" }
```

```
Tempo registrado em #1. Total: 1h15m de 3h estimados.
```

---

#### `time_report`

Soma o tempo de um período (datas inclusivas, padrão os últimos 7 dias), agrupado.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `project_path` / `project` | string | Padrão: todos os projetos |
| `from`, `to` | data | `to` padrão hoje; `from` padrão `to − 6` |
| `group_by` | enum | `task` (padrão), `project`, `day`, `person` |
| `format` | enum | `json` traz `{from, to, total, groups[], entries[]}` |

```json
{ "project_path": "/Users/voce/Developer/Loja", "group_by": "task" }
```

```
Tempo de 2026-10-25 a 2026-10-31 · Loja: 1h16m em 2 registro(s)
- #1 Corrigir cálculo de frete (Loja): 1h16m (2)
```

---

### Anexos

#### `attach_file`

Anexa um arquivo do disco a uma tarefa (até 25 MB). Útil para prints, logs, relatórios e exports.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `id` | integer ✓ | Tarefa |
| `path` | string ✓ | Caminho absoluto |
| `name` | string | Nome exibido (padrão: o nome do arquivo) |

Resposta: `Anexado em #3: tela.png (id 7, 84 KB).`

---

#### `get_attachment`

Lê um anexo de volta. O comportamento depende do tipo:

| Tipo do arquivo | O que volta |
| --- | --- |
| PNG, JPEG, GIF, WebP até 5 MB | Bloco de **imagem** (o Claude vê a imagem) + metadados |
| Texto (`text/*`, JSON, CSV, Markdown, código…) até 200 KB | O conteúdo como texto |
| Outros | Metadados e o **caminho local**, para usar com a ferramenta Read |

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `id` | integer ✓ | Id do anexo (aparece em `get_task`) |

```
Anexo 2 da tarefa #5: log.txt (text/plain, 1 KB)
Arquivo local: /Users/voce/Developer/claude-tasks/data/attachments/5-1793…txt

----- conteúdo -----
erro na linha 42
```

---

### Visão geral e atividade

#### `get_overview`

Resumo de dashboard para um projeto ou para todos:

- totais e atrasadas;
- vencendo em 7 dias;
- concluídas, criadas e tempo nos últimos 7 dias;
- por projeto e por prioridade;
- sprint ativa;
- listas de atrasadas, próximos prazos, em andamento e bloqueadas.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `project_path` / `project` | string | Sem eles: todos os projetos |
| `format` | enum | `json` traz as estatísticas completas |

```
# Visão geral · Loja
Hoje: 2026-10-31

Abertas: 3 (0 em andamento, 0 bloqueadas) · Atrasadas: 0 · Vencem em 7 dias: 0
Últimos 7 dias: 1 concluídas, 4 criadas (4 pelo Claude), 1h16m registradas

## Por prioridade (abertas)
urgente: 0 · alta: 0 · média: 3 · baixa: 0
```

---

#### `get_activity`

Feed recente: criações, mudanças de status e outros eventos, comentários.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `project_path` / `project` | string | |
| `since` | data | A partir desta data |
| `limit` | integer | 1–200, padrão 30 |

```
2026-10-31 23:17 · Claude em andamento → concluída em #1 Corrigir cálculo de frete (Loja)
2026-10-31 23:17 · Claude comentou ("Corrigido para >= e coberto por teste") em #1 Corrigir cálculo de frete (Loja)
```

---

### Equipe e notificações

#### `list_members`

Lista os membros que podem ser responsáveis e indica quem é "me".

```
Bruno <bruno@exemplo.com> (admin) ← "me"
Ana <ana@exemplo.com>
```

---

#### `send_notification`

Cria uma notificação no sino do painel (e no macOS, se estiver ligado). O texto vai prefixado com "Claude:".

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `message` | string ✓ | |
| `task_id` | integer | Tarefa relacionada (clicar abre a tarefa) |
| `to` | string[] | Membros (nome, e-mail ou `"me"`). Padrão: todos. |

Resposta: `Notificação enviada (1 destinatário(s)).`

---

#### `list_notifications`

Lista as notificações de "eu".

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `unread_only` | boolean | Padrão `true` |
| `limit` | integer | 1–100, padrão 20 |
| `mark_read` | boolean | Marca as listadas como lidas |

```
2026-10-31 23:20 [nova] Vence amanhã: #48 Centralizar símbolos literais · http://localhost:4317/?task=48
```

---

### Automações e configurações

#### `manage_automations`

Regras "quando X → faça Y". Elas valem para mudanças de qualquer pessoa, inclusive do Claude. Mudanças feitas por regras não disparam outras regras. Detalhes em [SISTEMA.md § 6](SISTEMA.md#6-automações).

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `action` | enum ✓ | `list`, `create`, `update`, `enable`, `disable`, `delete` |
| `id` | integer | Regra (update, enable, disable, delete) |
| `name` | string | Obrigatório no create |
| `project_path` / `project` | string | Escopo: um projeto |
| `all_projects` | boolean | Escopo: todos (padrão no create sem projeto) |
| `trigger` | enum | `task_created`, `status_changed`, `priority_changed`, `comment_added`, `assigned`, `due_soon`, `overdue` |
| `conditions` | objeto | `to_status`, `from_status`, `priority[]`, `type[]`, `tag`, `by_claude`, `days` |
| `action_type` | enum | `set_status`, `set_priority`, `add_tag`, `remove_tag`, `add_comment`, `notify`, `set_due_in_days`, `move_to_active_sprint`, `assign` |
| `action_value` | string/número | Valor da ação. Textos aceitam `{id}`, `{titulo}`, `{projeto}`, `{prazo}`, `{status}`, `{prioridade}`. |
| `enabled` | boolean | |

```json
{ "action": "create", "name": "Bug novo → alta", "trigger": "task_created",
  "conditions": { "type": ["bug"] }, "action_type": "set_priority", "action_value": "high" }
```

```
Criada: #1 [ativa] Bug novo → alta — quando tarefa criada (tipo bug) → mudar prioridade "alta" · todos os projetos · executada 0x
```

**Restrição:** não é possível usar o gatilho `status_changed` junto com a ação `set_status`, porque isso geraria um ciclo.

---

#### `manage_settings`

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `action` | enum ✓ | `get` ou `update` |
| `notify_macos` | boolean | Notificações também no macOS |
| `due_soon_days` | integer 0–30 | Antecedência dos avisos de prazo |
| `chat_model` | `sonnet` \| `opus` \| `haiku` | Modelo do chat do painel |

```
Notificações do macOS: ligadas
Avisar prazos com 1 dia(s) de antecedência
Modelo do chat do painel: sonnet
```

---

## 6. Resources

Resources são documentos Markdown somente leitura que você cita numa conversa. No Claude Code, digite `@` e escolha, ou escreva diretamente:

```
@tarefas:tarefas://overview
@tarefas:tarefas://projects/4
@tarefas:tarefas://tasks/47
```

### 6.1 Resources fixos (`resources/list`)

| URI | Conteúdo |
| --- | --- |
| `tarefas://overview` | Visão geral de todos os projetos (o mesmo texto de `get_overview`) |
| `tarefas://my-tasks` | Tarefas abertas atribuídas a "eu" |
| `tarefas://projects/{id}` | Um item por projeto não arquivado: o quadro do projeto |

### 6.2 Templates (`resources/templates/list`)

| Template | Conteúdo |
| --- | --- |
| `tarefas://tasks/{id}` | Tarefa completa (o mesmo texto de `get_task`) |
| `tarefas://projects/{id}` | Quadro: pasta, link, sprints abertas, cada coluna com as tarefas abertas (subtarefas recuadas) e as 10 concluídas mais recentes |
| `tarefas://projects/{id}/overview` | Visão geral do projeto |

Exemplo (`tarefas://projects/1`):

```markdown
# Loja
Pasta: /Users/voce/Developer/Loja
http://localhost:4317/?project=1

Sprint planejada: Sprint 1 (0/3 concluídas) — Página de produto

## A fazer (3)
- #2 [história] [a fazer] [média] Nova página de produto (produto) · subtarefas 0/2 · sprint Sprint 1
  - #3 [a fazer] [média] Layout da galeria (produto) · sprint Sprint 1 · subtarefa de #2
  - #4 [a fazer] [média] Zoom nas fotos (produto) · bloqueada por 1 · sprint Sprint 1 · subtarefa de #2

## Em andamento (0)

## Revisão (0)

## Bloqueadas (0)

## Concluídas recentemente
- #1 [bug] [concluída] [alta] Corrigir cálculo de frete (checkout) · prazo 2026-11-05
```

Um URI inexistente devolve o erro JSON-RPC `-32002` ("Resource não encontrado").

---

## 7. Prompts (comandos de barra)

No Claude Code, os prompts viram comandos `/mcp__tarefas__<nome>`. Os argumentos vão depois do comando, separados por espaço, e o Claude Code sugere valores (veja a [seção 8](#8-autocompletar)). Cada prompt **já embute os dados do quadro** de que precisa, então o Claude começa a trabalhar sem consultas extras.

Quando o argumento `projeto` é omitido, o prompt usa o projeto da pasta da sessão. Nos prompts em que isso faz sentido, sem projeto ele olha todos os projetos.

| Comando | Argumentos | O que faz |
| --- | --- | --- |
| `/mcp__tarefas__pendencias` | `projeto?` | Resume o que está aberto (por prioridade, destacando atrasadas, bloqueadas e em andamento) e sugere a próxima tarefa. Não altera nada. |
| `/mcp__tarefas__proxima` | `projeto?` | Escolhe a tarefa mais importante **sem bloqueios** (prefere continuar o que está em andamento), marca como `doing`, inicia o timer, lê os detalhes e começa o trabalho |
| `/mcp__tarefas__registrar_pendencias` | — | Revisa a conversa inteira e registra no quadro tudo que ficou para depois, sem duplicar, e conclui o que foi resolvido |
| `/mcp__tarefas__concluir` | `tarefa` ✓, `resumo?` | Conclui a tarefa com nota do que foi feito na sessão (e tempo, se souber). Avisa se há subtarefas abertas. |
| `/mcp__tarefas__quebrar_tarefa` | `tarefa` ✓ | Divide a tarefa em subtarefas (30 min a 1 dia) com descrição, estimativa e ordem por dependências |
| `/mcp__tarefas__planejar_sprint` | `projeto?`, `dias?` (padrão 14), `objetivo?` | Cria a sprint, escolhe as tarefas por prioridade, prazo, dependências e estimativa, move as escolhidas e **pergunta antes de iniciar** |
| `/mcp__tarefas__triagem` | `projeto?` | Corrige prioridade, tipo e tags; aponta duplicatas (sem excluir), descrições vagas e dependências faltando |
| `/mcp__tarefas__relatorio` | `periodo?` (`hoje`, `semana`, `mes`), `projeto?` | Relatório com Resumo, Concluído, Em andamento, Atrasado/bloqueado, Tempo, Riscos e Próximos passos |
| `/mcp__tarefas__revisar_prazos` | `projeto?` | Propõe novas datas e repriorização para atrasadas e vencendo e aponta conflitos. **Só aplica depois que você confirma.** |

**Exemplos:**

```
/mcp__tarefas__pendencias SIRAC
/mcp__tarefas__concluir 47 corrigido o cálculo e adicionado teste
/mcp__tarefas__planejar_sprint AlphaClaim 10 "entregar o fluxo de sinistro"
/mcp__tarefas__relatorio semana
```

O argumento `tarefa` aceita `47`, `#47` ou `47 Título…` (vale o primeiro número). Argumentos obrigatórios ausentes, ou projetos e tarefas inexistentes, retornam o erro `-32602`.

---

## 8. Autocompletar

O servidor implementa `completion/complete`. O Claude Code usa isso para sugerir valores enquanto você digita os argumentos:

| Onde | Argumento | Sugestões |
| --- | --- | --- |
| Prompts | `projeto` | Nomes dos projetos não arquivados que contêm o texto digitado |
| Prompts | `tarefa` | `"<id> <título>"` das tarefas abertas cujo id começa com o texto ou cujo título o contém |
| Prompts | `periodo` | `hoje`, `semana`, `mes` |
| Prompts | `dias` | `7`, `10`, `14`, `21`, `30` |
| Resource `tarefas://tasks/{id}` | `id` | Ids das tarefas abertas |
| Resource `tarefas://projects/{id}` | `id` | Ids dos projetos (filtra por id ou nome) |

Cada resposta traz no máximo 100 valores, com `total` e `hasMore`.

---

## 9. Erros

| Situação | Como volta |
| --- | --- |
| Erro de validação ou de regra numa ferramenta (campo inválido, tarefa inexistente, ciclo, exclusão sem `confirm`…) | Resultado normal com `isError: true` e o texto `Erro: <mensagem>`. O Claude lê a mensagem e corrige a chamada. |
| Ferramenta desconhecida | Erro JSON-RPC `-32602` |
| Prompt desconhecido, argumento obrigatório faltando, projeto ou tarefa inválidos no prompt | `-32602` |
| Resource inexistente | `-32002` |
| Método não suportado | `-32601` |
| JSON inválido na entrada | `-32700` |
| Falha inesperada | `-32603` |

As mensagens de erro são em português e dizem o que fazer. Por exemplo: `Coluna "QA" não existe. Colunas: A fazer, Em andamento, Bloqueadas, Concluídas`.

---

## 10. Protocolo

- **Transporte:** stdio, com uma mensagem JSON-RPC 2.0 por linha. O stdout é exclusivo do protocolo; avisos vão para o stderr.
- **Versões:** o servidor responde com a versão pedida pelo cliente, se for uma das suportadas; senão, com `2025-11-25`.
- **Métodos suportados:**

| Método | Resposta |
| --- | --- |
| `initialize` | `protocolVersion`, `capabilities`, `serverInfo` (`tarefas` 3.0.0), `instructions` |
| `notifications/initialized` | (notificação, sem resposta) |
| `ping` | `{}` |
| `tools/list` | `tools[]` com `name`, `title`, `description`, `inputSchema`, `annotations` |
| `tools/call` | `content[]` (texto ou imagem), `isError?` |
| `resources/list` | `resources[]` |
| `resources/templates/list` | `resourceTemplates[]` |
| `resources/read` | `contents[]` (`text/markdown`) |
| `prompts/list` | `prompts[]` com `arguments[]` |
| `prompts/get` | `description`, `messages[]` |
| `completion/complete` | `completion { values, total, hasMore }` |
| `logging/setLevel` | `{}` (aceito; o servidor não emite logs pelo protocolo) |

Capacidades anunciadas:

```json
{
  "tools": { "listChanged": false },
  "resources": { "subscribe": false, "listChanged": false },
  "prompts": { "listChanged": false },
  "completions": {}
}
```

### 10.1 Testar manualmente

```bash
cd ~/Developer/claude-tasks
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"teste","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_overview","arguments":{}}}' \
  | node --no-warnings src/mcp.js
```

Use `CLAUDE_TASKS_DB=/tmp/teste.db` para não mexer no banco real.

### 10.2 Organização do código

| Arquivo | Conteúdo |
| --- | --- |
| `src/mcp.js` | Protocolo: leitura de linhas, roteamento de métodos, `instructions` |
| `src/mcp/context.js` | Store compartilhado (com o motor de automações ligado), `me()`, resolução de projeto e pessoas, formatadores (`describeTask`, `projectBoard`, `overviewText`, `taskJson`) |
| `src/mcp/tools.js` | As 24 ferramentas: esquema, anotações e `run()` |
| `src/mcp/resources.js` | Resources fixos, templates e leitura |
| `src/mcp/prompts.js` | Os 9 prompts e o autocompletar |

**Para adicionar uma ferramenta:** crie a entrada em `TOOLS` (com `title`, `description` em inglês para o modelo, `inputSchema`, `annotations` e `run`), coloque a regra de negócio no `Store` e acrescente um teste em `test/mcp.test.js`.

---

## 11. Segurança

- **Local.** O MCP roda como processo do seu usuário e lê e grava o arquivo do banco diretamente. Não há autenticação, porque quem consegue iniciar processos no Mac já tem acesso ao arquivo.
- **Sem rede.** O servidor não acessa a internet (`openWorldHint: false` em todas as ferramentas). Os links devolvidos apontam para o painel local.
- **Exclusões.** `delete_tasks` e `manage_project` com `delete` exigem `confirm: true`, e as `instructions` proíbem excluir sem pedido explícito. As ferramentas que podem excluir são marcadas com `destructiveHint: true`, e você pode negá-las em `permissions.deny`.
- **Sem gestão de acesso.** Não existem ferramentas para criar convites, mudar papéis ou senhas. Isso fica só no painel, com login.
- **Arquivos.** `attach_file` lê o caminho indicado (até 25 MB) com as permissões do seu usuário. `get_attachment` só lê arquivos que já estão em `data/attachments`.
- **Chat do painel.** Usa este mesmo MCP com `--strict-mcp-config` e `--tools ""`, ou seja, sem acesso a arquivos ou terminal.

---

## 12. Solução de problemas

| Sintoma | O que verificar |
| --- | --- |
| `claude mcp list` não mostra `tarefas` | Registre de novo (2.1). Confira o escopo com `claude mcp get tarefas`. |
| "Failed to connect" | Rode o comando registrado no Terminal. Erros de Node aparecem ali. Confirme o Node 22.13+ (`node -v`) e o caminho absoluto. |
| Ferramentas antigas ou faltando | A sessão começou antes da atualização: abra uma nova ou use `/mcp` → reconectar |
| Tarefas caem no projeto errado | O Claude passou outro `project_path`, ou a pasta não está dentro do repositório que você imaginava. Mova com `update_task` + `project`. |
| `Não sei quem é "eu"` | O quadro tem 0 ou várias contas e `CLAUDE_TASKS_USER` não está definida (2.3) |
| `Membro "X" não encontrado` | Use `list_members`. A busca aceita nome exato, e-mail ou primeiro nome. |
| O painel não mostra o que o Claude gravou | Confira se ambos usam o mesmo banco (`CLAUDE_TASKS_DB`) e se o painel está "ao vivo" |
| Notificação do macOS não aparece | Configuração `notify_macos` (`manage_settings`) ou as permissões de notificação do macOS para o `osascript` |
| Imagem de `get_attachment` não aparece | Formato fora de PNG, JPEG, GIF ou WebP, ou arquivo acima de 5 MB. Use o caminho com Read. |

---

## 13. Histórico de versões

| Versão | Mudanças |
| --- | --- |
| **3.0** | +14 ferramentas: `update_tasks`, `delete_tasks`, `add_comment`, `manage_project`, `manage_columns`, `timer`, `time_report`, `get_attachment`, `get_overview`, `get_activity`, `send_notification`, `list_notifications`, `manage_automations`, `manage_settings`. Anotações e títulos em todas. `format: json`. Novos parâmetros: `add_tags`/`remove_tags`, `add_blocked_by`/`remove_blocked_by`, `position`, `time_spent`, filtros `column`/`parent_id`/`sort`. "me" (`CLAUDE_TASKS_USER`). Resources, templates, 9 prompts e autocompletar. |
| 2.0 | Prazos, subtarefas, dependências, sprints (`manage_sprints`), recorrência, tempo (`log_time`), anexos (`attach_file`), equipe (`list_members`), automações disparadas pelo MCP |
| 1.0 | `add_tasks`, `list_tasks`, `get_task`, `update_task`, `complete_tasks`, `list_projects` |
