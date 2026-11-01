# MCP `tarefas` — Referência completa

> Servidor MCP 4.0.0 do Quadro de Tarefas · 35 ferramentas · transporte stdio · protocolos 2024-11-05, 2025-03-26, 2025-06-18 e 2025-11-25

O MCP `tarefas` é a ponte entre o Claude e o quadro central de tarefas. Com ele, o Claude registra, consulta, organiza e conclui tarefas de **qualquer projeto**, gerencia sprints, colunas, fluxos, labels, campos, membros, workspaces, automações e caixas de entrada, controla tempo, lê anexos, cria links públicos, importa e exporta tarefas e gera relatórios. Tudo vai para o mesmo banco do painel (http://localhost:4317).

A documentação do sistema como um todo (painel, regras de negócio, permissões, modelo de dados, API REST) está em [SISTEMA.md](SISTEMA.md).

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
| **Tools** (35) | Tarefas, comentários, projetos, colunas e fluxos, sprints, tempo, anexos, visão geral, atividade, busca, equipe e papéis, organizações e workspaces, labels, campos personalizados, links públicos, notificações, automações, caixa de entrada, importação e exportação, configurações e "abrir no painel" |
| **Resources** | Conteúdo citável com `@` numa conversa: visão geral, minhas tarefas, quadro de cada projeto, qualquer tarefa |
| **Prompts** (9) | Fluxos prontos que viram comandos no Claude Code: `/mcp__tarefas__proxima`, `/mcp__tarefas__planejar_sprint`… |
| **Completions** | Autocompletar de projetos, tarefas e opções nos argumentos dos prompts e resources |
| **Instructions** | Regras de uso enviadas ao Claude ao conectar (quando registrar, como escrever, nunca excluir sem pedido) |

**Características:**

- **Sem dependências:** é um único processo Node (`src/mcp.js`), que o Claude Code inicia em cada sessão.
- **Grava direto no SQLite**, em modo WAL. Várias sessões e o painel podem gravar ao mesmo tempo, e o painel vê as mudanças em menos de um segundo (tempo real por SSE).
- **Mesmas regras do painel:** validação, duplicatas, fluxo de colunas, automações e notificações também valem para o que o Claude faz.
- **Permissões opcionais:** por padrão o MCP local tem acesso total; com `CLAUDE_TASKS_ENFORCE` ele aplica os papéis de quem está usando (ver [2.4](#24-quem-é-eu-e-permissões-do-quadro)).
- **Anotações em toda ferramenta:** `title`, `readOnlyHint`, `destructiveHint` e `openWorldHint` (`true` só em `import_tasks` e `manage_inbox`, que falam com servidores externos).

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
| `CLAUDE_TASKS_DB` | `data/tasks.db` do projeto | Qual banco usar (a `secret.key` e os anexos ficam na mesma pasta) |
| `CLAUDE_TASKS_USER` | — | Quem é "eu" (`me`): e-mail ou nome de um membro do quadro. Sem ela, se o quadro tem **uma única conta**, essa conta é "eu". |
| `CLAUDE_TASKS_ENFORCE` | — | Se definida (ex.: `1`), as ferramentas aplicam as permissões de "eu" |
| `CLAUDE_TASKS_PORT` | `4317` | Porta usada nos links devolvidos (`http://localhost:4317/?task=12`) |
| `CLAUDE_TASKS_JIRA_HOSTS` | `*.atlassian.net` | Hosts permitidos em `import_tasks` com `source: "jira_api"` |
| `CLAUDE_TASKS_NO_OS_NOTIFY` | — | Se definida, notificações criadas pelo MCP não aparecem no macOS |

### 2.4 Quem é "eu" e permissões do quadro

**"Eu"** é, nesta ordem: a pessoa conversando no chat do painel (provedores de API), a conta de `CLAUDE_TASKS_USER` ou a única conta do quadro. O que "eu" muda:

- **Tempo:** timers e tempo registrados pelo Claude contam para você e aparecem no painel como "Claude · Seu nome". O timer iniciado pelo Claude aparece no seu cabeçalho.
- **Filtros e pessoas:** `"me"` passa a funcionar em `assignee`, `assignees`, `watchers`, `reporter`, `to` e `user`.
- **Relator:** tarefas criadas pelo Claude têm você como relator, se outro não for informado.
- **Resource:** `tarefas://my-tasks` mostra as suas tarefas.
- **Notificações e painel:** `list_notifications` lê as suas; `show_in_dashboard` abre as coisas na sua tela; links públicos ficam no seu nome.

**Permissões.** Por padrão, o MCP local tem **acesso total** ao quadro (como o próprio arquivo do banco, que o seu usuário já pode ler). As ferramentas aplicam os papéis de "eu" (dono, gerente, membro, visualizador; ver [SISTEMA.md § 8](SISTEMA.md#8-usuários-papéis-e-permissões)) quando:

| Situação | Permissões |
| --- | --- |
| Sessão do Claude Code sem `CLAUDE_TASKS_ENFORCE` | acesso total |
| Sessão com `CLAUDE_TASKS_ENFORCE=1` e "eu" identificado | papéis de "eu" |
| `CLAUDE_TASKS_ENFORCE=1`, mas "eu" não identificado | acesso total (defina `CLAUDE_TASKS_USER`) |
| Chat do painel com provedor `anthropic` ou `openai` (ferramentas rodam dentro do servidor) | papéis de quem conversa |
| Chat do painel com provedor `claude-cli` (a CLI inicia este MCP com `CLAUDE_TASKS_USER` e `CLAUDE_TASKS_ENFORCE=1`) | papéis de quem conversa |

Com as permissões ativas:

- listagens e buscas (`list_projects`, `list_tasks`, `search`, `time_report`, `get_activity`, `get_overview`, `export_tasks`, `manage_automations` com `list`) mostram só os projetos visíveis; na busca, labels só globais ou de projetos visíveis e workspaces só os que contêm algum projeto visível;
- cada ferramenta exige o nível indicado na coluna **Acesso** do [índice](#50-índice) (leitura, edição, gestão ou dono, no projeto da tarefa);
- visualizadores não criam projetos (nem pela criação automática de `project_path`), não enviam notificações e, em `list_members`, veem só os nomes (sem e-mails nem papéis);
- sem projeto informado, as ferramentas de escrita **não** usam a pasta da sessão: informe `project` ou `project_path`.

Os resources (`tarefas://…`) e os prompts seguem a mesma regra: projetos invisíveis não aparecem nas listas e, lidos diretamente, respondem como inexistentes.

### 2.5 Permissões no Claude Code

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
        "mcp__tarefas__get_attachment", "mcp__tarefas__list_members", "mcp__tarefas__search"
      ]
    }
  }
  ```

- **Bloquear as que excluem:** coloque em `permissions.deny` as ferramentas marcadas com ⚠️ no [índice](#50-índice) (no mínimo `mcp__tarefas__delete_tasks` e `mcp__tarefas__manage_project`).

### 2.6 Outros clientes MCP

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

### 2.7 Com o painel no Docker

O MCP roda onde o Claude Code roda e precisa abrir o mesmo arquivo de banco do servidor. Duas formas (detalhes em [SISTEMA.md § 3.4](SISTEMA.md#34-docker)):

1. **MCP local, banco montado.** Monte uma pasta do host como `/data` no contêiner e registre o MCP local apontando para ela:

   ```bash
   claude mcp add --scope user tarefas -e CLAUDE_TASKS_DB=$HOME/tarefas-data/tasks.db \
     -- "$(command -v node)" --no-warnings ~/Developer/claude-tasks/src/mcp.js
   ```

   Seguro em Linux. No Docker Desktop (Mac/Windows), o compartilhamento de pastas com a VM não garante a memória compartilhada que o SQLite em modo WAL usa: prefira a opção 2.

2. **MCP dentro do contêiner.** Use o próprio contêiner como comando do MCP (o nome aparece em `docker ps`):

   ```bash
   claude mcp add --scope user tarefas -- docker exec -i -e CLAUDE_TASKS_USER=voce@exemplo.com \
     claude-tasks-tarefas-1 node --no-warnings src/mcp.js
   ```

   Dentro do contêiner, as pastas do Mac não existem: a raiz git não é detectada (cada `project_path` vira o próprio caminho; passe a raiz do repositório), e `attach_file`, `export_tasks` e `import_tasks` usam caminhos do contêiner.

### 2.8 Atualizar

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
| "Coloca as tarefas de UI na próxima sprint" | `manage_sprints` + `update_tasks` com `sprint: "next"` |
| "Quanto tempo gastei no SIRAC essa semana?" | `time_report` |
| "Olha o print que eu anexei na WEB-12" | `get_task` + `get_attachment` |
| "Cria uma coluna Homologação e só deixa ir para Concluídas a partir dela" | `manage_columns` (`create` e `set_transitions`) |
| "Toda tarefa bloqueada vira urgente" | `manage_automations` |
| "Me lembra de revisar isso" | `send_notification` ou `add_tasks` com prazo |
| "Como estão os projetos?" | `get_overview` |
| "Procura tudo sobre checkout" | `search` |
| "Mostra a #12 no painel" | `show_in_dashboard` |
| "Responde a Ana no comentário dela" | `get_task` + `add_comment` com `reply_to` |
| "Cria um campo Cliente e preenche ACME na #12" | `manage_fields` + `update_task` com `fields` |
| "Dá acesso de gerente à Ana no projeto Loja" | `manage_members` |
| "Gera um link para o cliente ver essa tarefa" | `share_link` |
| "Importa o board do Trello" | `import_tasks` |
| "Exporta as tarefas abertas em CSV" | `export_tasks` |
| "Faz os e-mails de suporte@ virarem tarefas" | `manage_inbox` |

---

## 4. Convenções

### 4.1 Resolução do projeto

Toda ferramenta que trabalha com projeto aceita:

| Parâmetro | Como resolve |
| --- | --- |
| `project_path` | Caminho absoluto. Sobe até a **raiz do repositório git**. Worktrees viram o repositório principal. Pastas sem git usam o próprio caminho. Se o projeto não existe, as ferramentas de escrita o criam com o nome da pasta. |
| `project` | Nome (sem diferenciar maiúsculas), id numérico ou prefixo (`WEB`). Se não existe, `add_tasks` cria um projeto sem pasta com esse nome. |
| nenhum | Ferramentas de escrita usam o **diretório da sessão** (`cwd` do processo MCP), exceto com permissões ativas. Ferramentas de consulta, sem projeto, olham **todos** os projetos. |

`project_path` tem precedência sobre `project`.

### 4.2 Valores

| Tipo | Formato |
| --- | --- |
| Tarefa | id (`12`), `"#12"` ou código do projeto (`"WEB-12"`) nos parâmetros que aceitam texto (`get_task`, `add_comment`, `share_link`, `show_in_dashboard`) |
| Status | `todo`, `doing`, `blocked`, `done` (listagens também aceitam `open` = tudo menos done, e `all`) |
| Prioridade | `urgent`, `high`, `medium`, `low`, `lowest` |
| Tipo | `task`, `bug`, `story`, `epic` |
| Datas | `AAAA-MM-DD` no fuso local; `null` limpa o campo |
| Duração | `"45m"`, `"2h"`, `"1h30m"`, `"1,5h"`, `"1d"` (= 8h) ou número de minutos |
| Story points | número de 0 a 1000 (aceita decimais); `null` limpa |
| Recorrência | `{ "freq": "daily\|weekly\|monthly\|quarterly\|yearly", "interval": 1, "weekdays": [1,3], "monthday": 15 \| "last", "until": "AAAA-MM-DD", "count": 10 }`; só `freq` é obrigatório; `weekdays` (0 = domingo) vale no semanal e `monthday` no mensal/trimestral; `null` remove |
| Dependência | id da tarefa ou `{ "id": 12, "type": "finish_start\|start_start\|finish_finish\|start_finish" }` (padrão `finish_start`) |
| Sprint | id, nome, `"active"` (a ativa), `"next"` (a próxima planejada) ou `null` (backlog) |
| Coluna | nome (`"Revisão"`), id ou nome de status |
| Pessoas | nome, e-mail ou `"me"` |
| Campos personalizados | `{ "Nome do campo ou id": valor }`; valor `null` apaga (tipos em [SISTEMA.md § 4.12](SISTEMA.md#412-campos-personalizados)) |
| Papel | `owner`, `manager`, `member`, `viewer` |

### 4.3 Comportamentos importantes

- **Duplicatas:** `add_tasks` não cria uma tarefa se já existir uma **aberta** com o mesmo título no mesmo projeto e sob a mesma tarefa-mãe. Ela devolve `já existia: #id`.
- **Status × coluna:** informar `column` ajusta o `status` para a categoria da coluna. Informar só `status` coloca a tarefa na primeira coluna daquela categoria.
- **Fluxo:** se o projeto tem transições cadastradas, mudar a coluna ou o status para um destino fora do fluxo falha com `Transição não permitida: … só pode ir para: …`. `get_task` mostra para onde a tarefa pode ir.
- **Prioridade e ordem:** mudar a prioridade reposiciona a tarefa na faixa dela. `position: top|bottom` move para o topo ou o fim da coluna.
- **Transações:** cada chamada é atômica; se um item falha, nada daquela chamada é gravado.
- **Autoria:** tudo que o MCP faz fica registrado como **Claude** no histórico. As tarefas criadas recebem `source = claude`, o que alimenta o selo ✳ no painel e o indicador "Registradas pelo Claude". No chat do painel com provedor compatível com OpenAI, o autor é `ia`.
- **Automações e notificações:** mudanças do Claude disparam as regras do quadro, e comentários com `@Nome` notificam as pessoas citadas.

### 4.4 Formato das tarefas nas respostas

As respostas em texto usam uma linha por tarefa:

```
#4 LOJA-4 [história] [a fazer] [média] Zoom nas fotos (produto) · prazo 2026-11-12 (atrasada) · 3 pts · subtarefas 1/3 · bloqueada por 1 · sprint Sprint 1 · subtarefa de #2 — Loja
│  │      │          │         │      │              │          │                          │       │                │               │                 │                  └ projeto (em listagens de vários)
│  │      │          │         │      │              │          │                          │       │                │               │                 └ é subtarefa
│  │      │          │         │      │              │          │                          │       │                │               └ sprint
│  │      │          │         │      │              │          │                          │       │                └ bloqueios ainda abertos
│  │      │          │         │      │              │          │                          │       └ progresso das subtarefas
│  │      │          │         │      │              │          │                          └ story points
│  │      │          │         │      │              │          └ prazo (e se está atrasada)
│  │      │          │         │      │              └ labels
│  │      │          │         │      └ título
│  │      │          │         └ prioridade
│  │      │          └ status
│  │      └ tipo (omitido quando é "tarefa")
│  └ código do projeto (só com prefixo)
└ id
```

Tarefas arquivadas terminam com `· arquivada`. `list_tasks`, `get_task`, `list_projects`, `time_report` e `get_overview` aceitam `format: "json"` para devolver dados estruturados.

### 4.5 Ferramentas assíncronas

`import_tasks` (APIs do Jira e do Trello) e `manage_inbox` (IMAP) falam com servidores externos e podem levar alguns segundos. O servidor aguarda o fim da execução antes de responder ao `tools/call` e continua atendendo outras mensagens enquanto isso; por isso as respostas podem chegar fora de ordem (o cliente as casa pelo `id`).

---

## 5. Ferramentas

### 5.0 Índice

Legenda: 🔍 só leitura · ✏️ escreve · ⚠️ pode excluir. **Acesso** é o nível exigido no projeto quando as permissões estão ativas (ver [2.4](#24-quem-é-eu-e-permissões-do-quadro)).

| Ferramenta | Título | Tipo | Acesso |
| --- | --- | --- | --- |
| [`add_tasks`](#add_tasks) | Adicionar tarefas | ✏️ | edição |
| [`list_tasks`](#list_tasks) | Listar tarefas | 🔍 | leitura |
| [`get_task`](#get_task) | Ver tarefa | 🔍 | leitura |
| [`update_task`](#update_task) | Atualizar tarefa | ✏️ | edição (e no destino, ao mover) |
| [`update_tasks`](#update_tasks) | Atualizar várias tarefas | ✏️ | edição |
| [`complete_tasks`](#complete_tasks) | Concluir tarefas | ✏️ | edição |
| [`delete_tasks`](#delete_tasks) | Excluir tarefas | ⚠️ | gestão |
| [`add_comment`](#add_comment) | Comentar | ✏️ | edição |
| [`manage_comment`](#manage_comment) | Editar ou excluir comentário | ⚠️ | edição + autor (ou gestão) |
| [`list_projects`](#list_projects) | Listar projetos | 🔍 | leitura (lista só os visíveis) |
| [`manage_project`](#manage_project) | Gerenciar projeto | ⚠️ | gestão; visibilidade, arquivar e excluir: dono |
| [`manage_columns`](#manage_columns) | Gerenciar colunas | ⚠️ | gestão (`list`: leitura) |
| [`manage_sprints`](#manage_sprints) | Gerenciar sprints | ⚠️ | gestão (`list`/`show`: leitura); a sprint precisa ser do projeto |
| [`manage_labels`](#manage_labels) | Gerenciar labels | ⚠️ | gestão; globais: admin |
| [`manage_fields`](#manage_fields) | Gerenciar campos personalizados | ⚠️ | gestão; globais: admin |
| [`timer`](#timer) | Timer | ✏️ | edição |
| [`log_time`](#log_time) | Registrar tempo | ✏️ | edição |
| [`time_report`](#time_report) | Relatório de tempo | 🔍 | leitura |
| [`attach_file`](#attach_file) | Anexar arquivo | ✏️ | edição |
| [`get_attachment`](#get_attachment) | Ler anexo | 🔍 | leitura |
| [`get_overview`](#get_overview) | Visão geral | 🔍 | leitura |
| [`get_activity`](#get_activity) | Atividade recente | 🔍 | leitura |
| [`search`](#search) | Busca universal | 🔍 | leitura |
| [`list_members`](#list_members) | Listar membros | 🔍 | — (visualizador vê só nomes) |
| [`manage_members`](#manage_members) | Gerenciar membros e papéis | ✏️ | gestão do projeto ou da organização; papel de dono: dono |
| [`manage_workspaces`](#manage_workspaces) | Gerenciar organizações e workspaces | ⚠️ | gestão da organização; criar e excluir organização: admin |
| [`share_link`](#share_link) | Link público | ✏️ | tarefa: edição (criar em projeto privado: gestão); projeto: gestão |
| [`send_notification`](#send_notification) | Enviar notificação | ✏️ | não visualizador |
| [`list_notifications`](#list_notifications) | Ver notificações | ✏️ | — |
| [`manage_automations`](#manage_automations) | Gerenciar automações | ⚠️ | gestão no projeto da regra; globais: admin (`list`: só as visíveis) |
| [`manage_inbox`](#manage_inbox) | Caixa de entrada por e-mail | ✏️ | gestão (`get`/`messages`: leitura) |
| [`import_tasks`](#import_tasks) | Importar tarefas | ✏️ | gestão |
| [`export_tasks`](#export_tasks) | Exportar tarefas | ✏️ | leitura |
| [`show_in_dashboard`](#show_in_dashboard) | Abrir no painel | ✏️ | leitura |
| [`manage_settings`](#manage_settings) | Configurações do quadro | ✏️ | admin (`get`: livre) |

Nos exemplos abaixo, `/Users/voce/Developer/Loja` é um repositório git qualquer.

---

### Tarefas

#### `add_tasks`

Cria uma ou várias tarefas num projeto. É a ferramenta principal do registro automático de pendências.

| Parâmetro | Tipo | Obrig. | Descrição |
| --- | --- | --- | --- |
| `project_path` | string | | Caminho dentro do projeto (normalmente o diretório atual) |
| `project` | string | | Nome, id ou prefixo do projeto |
| `tasks` | array | ✓ | Lista de tarefas (mínimo 1), cada uma com os campos abaixo |

Campos de cada item de `tasks`:

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `title` | string ✓ | Título curto e acionável (até 300 caracteres) |
| `description` | string | Contexto (Markdown) |
| `priority` | enum | `lowest` a `urgent`. Padrão `medium` |
| `status` | enum | Padrão `todo` |
| `column` | string | Coluna do quadro (ajusta o status) |
| `type` | enum | Padrão `task` |
| `tags` | string[] | Labels, até 12 |
| `start_date`, `due_date` | data | |
| `estimate` | duração | Estimativa original |
| `remaining` | duração | Estimativa restante |
| `story_points` | número | |
| `parent_id` | integer | Cria como subtarefa (herda o projeto da mãe) |
| `blocked_by` | array | Tarefas que precisam vir antes: ids ou `{ id, type }` (ver 4.2) |
| `sprint` | string | id, nome, `"active"` ou `"next"` |
| `assignees` | string[] | Responsáveis: nomes, e-mails ou `"me"` |
| `watchers` | string[] | Observadores: nomes, e-mails ou `"me"` |
| `reporter` | string | Relator. Padrão: "eu" |
| `fields` | objeto | Valores de campos personalizados, por nome ou id |
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
    { "title": "Nova página de produto", "type": "story", "estimate": "2d", "story_points": 5 }
  ]
}
```

```
Projeto: Loja
criada: #1 [bug] [a fazer] [alta] Corrigir cálculo de frete (checkout) · prazo 2026-11-05
criada: #2 [história] [a fazer] [média] Nova página de produto · 5 pts
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

**Recorrência, observadores e campos:**

```json
{ "project": "Loja",
  "tasks": [ { "title": "Conferir pedidos parados", "assignees": ["me"], "watchers": ["Ana"],
               "recurrence": { "freq": "weekly", "weekdays": [1, 4] }, "due_date": "2026-11-02",
               "fields": { "Cliente": "ACME" } } ] }
```

**Erros comuns:**

- `"priority" deve ser um de: lowest, low, medium, high, urgent`
- `Tarefa-mãe #99 não encontrada`
- `#3 já depende de #4: isso criaria um ciclo`
- `Coluna "X" não existe. Colunas: …`
- `Membro "Fulano" não encontrado (veja list_members)`
- `Campo "X" não existe neste projeto`

---

#### `list_tasks`

Lista tarefas com filtros. Sem projeto, lista todos os projetos (visíveis), agrupados.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `project_path` / `project` | string | Limita a um projeto |
| `status` | enum | `open` (padrão), `all`, `todo`, `doing`, `blocked`, `done` |
| `query` | string | Busca em título, descrição e labels; `"#12"` busca pelo id e `"WEB-12"` pelo código |
| `due` | enum | `overdue`, `today`, `week` (próximos 7 dias), `any`, `none` |
| `sprint` | string | id, nome, `"active"`, `"next"` ou `"backlog"` (exige projeto) |
| `assignee` | string | Responsável: nome, e-mail ou `"me"` |
| `reporter` | string | Relator: nome, e-mail ou `"me"` |
| `watcher` | string | Tarefas que essa pessoa acompanha, ou `"me"` |
| `tag` | string | Só tarefas com esta label |
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
#2 [história] [a fazer] [média] Nova página de produto · 5 pts · subtarefas 0/2
#3 [a fazer] [média] Layout da galeria · subtarefa de #2
#4 [a fazer] [média] Zoom nas fotos · bloqueada por 1 · subtarefa de #2
```

Com `format: "json"`, a resposta é `{ "total": n, "tasks": [ … ] }`. Cada tarefa traz:

- `id`, `ref`, `title`, `project`, `project_id`, `status`, `column`, `priority`, `type`, `tags`;
- `start_date`, `due_date`, `overdue`, `estimate_minutes`, `remaining_minutes`, `spent_minutes`, `story_points`;
- `sprint`, `parent_id`, `subtasks {done,total}`, `open_blockers`, `assignees`, `watchers`, `reporter`, `fields`, `recurrence`;
- `archived`, `source`, `created_at`, `updated_at`, `completed_at`, `url`.

---

#### `get_task`

Mostra uma tarefa completa: descrição, campos, subtarefas, dependências (nos dois sentidos, com o tipo), anexos (com ids para `get_attachment`), tempo registrado e histórico com os ids dos comentários.

| Parâmetro | Tipo | Obrig. | Descrição |
| --- | --- | --- | --- |
| `id` | integer ou string | ✓ | `12`, `"#12"` ou `"WEB-12"` |
| `format` | enum | | `text` ou `json` |

```json
{ "id": "LOJA-2" }
```

```
#2 LOJA-2 [história] [em andamento] [média] Nova página de produto · 5 pts · subtarefas 0/2
Projeto: Loja (/Users/voce/Developer/Loja) · coluna: Em andamento
tempo 1h10m de 16h · restante 12h · 5 story points · responsáveis: Bruno · relator: Bruno · observadores: Ana
Campos: Cliente = ACME
Pode ir para: Revisão, Bloqueadas
Criada: 2026-10-31T23:17:36.585Z por claude · Atualizada: … · http://localhost:4317/?task=2

(sem descrição)

Subtarefas:
- #3 LOJA-3 [a fazer] [média] Layout da galeria · subtarefa de #2
- #4 LOJA-4 [a fazer] [média] Zoom nas fotos · bloqueada por 1 · subtarefa de #2

Histórico:
- 2026-10-31 23:18 Claude · a fazer → em andamento
- 2026-10-31 23:20 Claude [comentário 15]: Começando pelo layout da galeria
  ↳ 2026-10-31 23:25 Ana [comentário 16, editado]: @Claude usa o componente novo
```

- "Pode ir para" só aparece quando o projeto tem transições cadastradas.
- As seções "Bloqueada por", "Bloqueia" (com o tipo quando não é termina → começa), "Anexos (leia com get_attachment)", "Tempo registrado" e "Histórico" aparecem quando têm conteúdo. Respostas aparecem com `↳`.
- Em `json`, a resposta é a de `list_tasks` mais `description`, `subtasks[]`, `blocked_by[]` e `blocking[]` (com `type`), `attachments[]`, `time_entries[]` e `notes[]` (sem os ids dos comentários: use o texto para pegá-los).

---

#### `update_task`

Altera qualquer campo de uma tarefa. Também move entre projetos e colunas, reordena, arquiva e adiciona nota.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `id` | integer ✓ | |
| todos os campos de `add_tasks` | | `title`, `description`, `priority`, `status`, `column`, `type`, `tags` (substitui), `start_date`, `due_date`, `estimate`, `remaining`, `story_points`, `parent_id` (`null` desvincula), `blocked_by` (substitui), `sprint`, `assignees` (substitui), `watchers` (substitui), `reporter`, `fields` (mescla; `null` apaga um valor), `recurrence` |
| `note` | string | Adiciona ao histórico (como comentário) |
| `archived` | boolean | Arquiva ou restaura |
| `add_tags` / `remove_tags` | string[] | Muda labels sem reescrever a lista |
| `add_blocked_by` / `remove_blocked_by` | integer[] | Muda dependências sem reescrever a lista. As que já existem mantêm o tipo; as novas entram como `finish_start` (para outro tipo, use `blocked_by` com `{ id, type }`). |
| `project_path` / `project` | string | **Move** a tarefa (e as subtarefas) para outro projeto, com numeração nova. Coluna e sprint são limpas. |
| `position` | `top` \| `bottom` | Topo ou fim da coluna |

```json
{ "id": 1, "status": "doing", "remaining": "2h", "note": "Reproduzido: regra usa > em vez de >=" }
```

```
Atualizada: #1 [bug] [em andamento] [alta] Corrigir cálculo de frete (checkout) · prazo 2026-11-05 — Loja
```

Cada mudança relevante (status, prioridade, prazo, sprint, projeto, relator, arquivamento, responsáveis) vira um evento no histórico.

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
- #2 [história] [a fazer] [média] Nova página de produto (produto) · 5 pts · subtarefas 0/2 · sprint Sprint 1 — Loja
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

Com uma tarefa recorrente, a linha termina com `→ próxima ocorrência #15`. Se o fluxo do projeto não permite ir para a coluna de concluídas a partir da coluna atual, a chamada falha com o erro de transição.

---

#### `delete_tasks`

Exclui **definitivamente** as tarefas, junto com subtarefas, histórico, tempo, links públicos e arquivos anexados. O Claude só deve usar quando o usuário pedir explicitamente; arquivar é preferível.

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

### Comentários

#### `add_comment`

Adiciona um comentário (Markdown) ao histórico da tarefa. Quem acompanha a tarefa é notificado, e `@Nome` notifica as pessoas citadas que podem ver o projeto.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `id` | integer ou string ✓ | Tarefa: `12`, `"#12"` ou `"WEB-12"` |
| `body` | string ✓ | Markdown. `@Nome` ou `@PrimeiroNome` menciona alguém |
| `reply_to` | integer | Id do comentário respondido (aparece em `get_task` como `[comentário N]`). Responder a uma resposta pendura na mesma conversa. |

```json
{ "id": "LOJA-2", "body": "@Ana pode revisar o layout?", "reply_to": 16 }
```

Resposta: `Comentário adicionado em #2 Nova página de produto.`

---

#### `manage_comment`

Edita ou exclui um comentário. Com as permissões ativas, só o autor ou quem gerencia o projeto pode mudar comentários de outras pessoas.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `action` | enum ✓ | `edit` ou `delete` |
| `id` | integer ✓ | Id do comentário (veja `get_task`) |
| `body` | string | Novo texto (`edit`) |
| `confirm` | boolean | `true` obrigatório para `delete` |

```json
{ "action": "edit", "id": 15, "body": "Começando pelo layout da galeria (@Ana revisa)" }
```

```
Comentário 15 editado em #2.
```

- A edição marca o comentário como "editado". Menções acrescentadas notificam só as pessoas novas.
- `delete` exclui também as respostas: `Comentário 15 excluído de #2.`
- Só vale para comentários; eventos do histórico não podem ser editados.

---

### Projetos, colunas e sprints

#### `list_projects`

Lista os projetos com contadores e colunas.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `include_archived` | boolean | Padrão `true` |
| `format` | enum | `text` ou `json` (inclui todos os campos do projeto, workspace, colunas e url) |

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
| `key` | string ou null | Prefixo do código das tarefas (2 a 10 letras/números, começando por letra): `"WEB"` gera `WEB-1`, `WEB-2`… |
| `status` | enum | `planning`, `active`, `on_hold`, `completed`, `cancelled` |
| `priority` | enum | `lowest` a `urgent` |
| `visibility` | enum | `private` (só membros), `internal` (padrão: todas as contas), `public` (também permite link público do projeto) |
| `start_date`, `end_date` | data | Início e fim do projeto |
| `workspace` | string | Nome ou id do workspace onde criar ou para onde mover |
| `confirm` | boolean | `true` obrigatório para `delete` |

```json
{ "action": "create", "name": "Pessoal", "description": "Coisas minhas", "color": "#2a78d6", "key": "PES" }
```

```
Projeto criado: [6] Pessoal (PES) · http://localhost:4317/?project=6
```

```json
{ "action": "update", "project": "Loja", "key": "LOJA", "status": "active", "visibility": "private", "workspace": "Clientes" }
```

```
Projeto atualizado: [1] Loja (LOJA) · active · private
```

- `delete` remove o projeto com **todas** as tarefas, anexos, papéis e links públicos.
- Com as permissões ativas, `update` exige gestão, e mudar a `visibility` exige ser dono; `archive`, `unarchive` e `delete` exigem ser dono; visualizadores não criam projetos.

---

#### `manage_columns`

Gerencia as colunas e o fluxo do quadro de um projeto. Cada coluna pertence a uma categoria de status. O projeto mantém ao menos uma coluna por categoria, e mudar a categoria de uma coluna muda o status das tarefas dela.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `action` | enum ✓ | `list`, `create`, `update`, `move`, `delete`, `set_transitions`, `save_workflow`, `apply_workflow`, `list_workflows` |
| `project_path` / `project` | string | (todas, menos `list_workflows`) |
| `column` | string | Nome ou id da coluna (update, move, delete) |
| `name` | string | Nome (create) ou novo nome (update) |
| `status` | enum | Categoria (create, update). Padrão `doing`. |
| `color` | string | |
| `direction` | `left` \| `right` | Para `move` |
| `transitions` | array | `set_transitions`: pares `[de, para]` com nomes de colunas, ex.: `[["A fazer","Em andamento"],["Em andamento","Revisão"]]`. Lista vazia = qualquer movimento vale. Substitui as transições atuais. |
| `workflow` | string | `apply_workflow`: nome ou id do modelo. `save_workflow`: nome do modelo novo. |
| `default` | boolean | `save_workflow`: usar o modelo em todo projeto novo |

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
Transições: livres
```

```json
{ "project": "Loja", "action": "set_transitions",
  "transitions": [["A fazer", "Em andamento"], ["Em andamento", "Revisão"], ["Revisão", "Concluídas"], ["Revisão", "Em andamento"]] }
```

```
…
Transições permitidas: A fazer → Em andamento; Em andamento → Revisão; Revisão → Concluídas; Revisão → Em andamento
```

- `save_workflow` (só administradores, com permissões ativas) responde `Workflow salvo: [2] Fluxo com revisão (padrão para projetos novos)`.
- `apply_workflow` troca as colunas do projeto pelas do modelo; cada tarefa vai para a coluna de mesmo nome e categoria, ou para a primeira da categoria.
- `list_workflows` lista os modelos: `[2] Fluxo com revisão (padrão): A fazer → Em andamento → Revisão → Bloqueadas → Concluídas · 4 transições`.

---

#### `manage_sprints`

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `action` | enum ✓ | `list`, `show`, `create`, `update`, `start`, `complete`, `cancel`, `delete` |
| `project_path` / `project` | string | |
| `id` | integer | Sprint (show, update, start, complete, cancel, delete) |
| `name`, `goal` | string | |
| `start_date`, `end_date` | data | |
| `move_to` | integer | No `complete` e no `cancel`: sprint que recebe as pendentes. Sem ele, vão para o backlog. |

**Regras:**

- Só uma sprint ativa por projeto; sprints concluídas ou canceladas não podem ser iniciadas de novo.
- `start` sem data de início usa hoje.
- `complete` move as tarefas não concluídas, preenche o fim com hoje se estiver vazio e guarda o compromisso (tarefas e pontos) para a velocidade.
- `cancel` move as pendentes do mesmo jeito, mas registra a sprint como cancelada: não dispara a automação "sprint concluída" e não entra na velocidade.
- `delete` manda as tarefas para o backlog.
- `show` lista as tarefas da sprint; `list` mostra o progresso de cada uma.
- O `id` precisa ser de uma sprint do projeto informado (senão: `Sprint não encontrada neste projeto`).

```json
{ "project_path": "/Users/voce/Developer/Loja", "action": "create", "name": "Sprint 1",
  "goal": "Página de produto", "start_date": "2026-11-02", "end_date": "2026-11-13" }
```

```
Criada: #1 Sprint 1 [planejamento] 2026-11-02 → 2026-11-13 — Página de produto
```

Ao concluir ou cancelar:

```
Concluída: #1 Sprint 1 [concluída] 2026-11-02 → 2026-11-13 — Página de produto. 2 tarefa(s) pendente(s) movida(s) para o backlog.
Cancelada: #2 Sprint 2 [cancelada] 2026-11-16 → 2026-11-27. 3 tarefa(s) movida(s) para Sprint 3.
```

---

### Labels e campos personalizados

#### `manage_labels`

Labels são as tags com cor e descrição. Labels sem projeto valem para todos os projetos. Renomear uma label renomeia a tag em todas as tarefas que a usam; excluir remove a tag das tarefas.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `action` | enum ✓ | `list`, `create`, `update`, `delete` |
| `project_path` / `project` | string | Projeto. Em `list`, mostra as do projeto e as globais; em `update`/`delete`, informe o projeto para achar uma label do projeto. Sem projeto, a label criada é global. |
| `global` | boolean | `create`: label para todos os projetos (admin) |
| `label` | string | Nome ou id da label existente (update, delete) |
| `name` | string | Nome (create) ou novo nome (update), até 40 caracteres |
| `color` | string | Hex, ex.: `#e34948`. Sem cor, usa uma da paleta. |
| `description` | string | |

```json
{ "action": "create", "project": "Loja", "name": "checkout", "color": "#eb6834", "description": "Fluxo de compra" }
```

```
Label criado: [3] checkout #eb6834
```

`list`:

```
[3] checkout #eb6834 · 4 tarefa(s) — Fluxo de compra
[1] urgente-cliente #e34948 (todos os projetos) · 2 tarefa(s)
```

`update` responde `Label atualizado: <nome> <cor>` e `delete`, `Label "checkout" excluído e removido das tarefas.` Para usar uma label numa tarefa, passe o nome em `tags`/`add_tags`.

---

#### `manage_fields`

Campos personalizados por projeto (ou globais): `text`, `number`, `date`, `boolean`, `select`, `multi_select`, `user` e `url`. Os valores vão nas tarefas pelo parâmetro `fields` de `add_tasks`/`update_task`.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `action` | enum ✓ | `list`, `create`, `update`, `delete` |
| `project_path` / `project` | string | Projeto (como em `manage_labels`) |
| `global` | boolean | `create`: campo para todos os projetos (admin) |
| `field` | string | Nome ou id do campo existente (update, delete) |
| `name` | string | Nome (até 60 caracteres) |
| `type` | enum | Tipo (create; não muda depois) |
| `options` | string[] | Opções de `select`/`multi_select` (obrigatórias, até 50) |
| `required` | boolean | Marca como obrigatório (o painel destaca; o servidor não exige) |

```json
{ "action": "create", "project": "Loja", "name": "Cliente", "type": "select", "options": ["ACME", "Globex"], "required": true }
```

```
Campo criado: [1] Cliente (select)
```

```json
{ "id": 12, "fields": { "Cliente": "acme", "Valor": 1200 } }
```

(no `update_task`: o valor de seleção é casado sem diferenciar maiúsculas; `null` apaga.)

`list` mostra `[1] Cliente (select: ACME | Globex) obrigatório` e, nos globais, `· todos os projetos`. `delete` apaga o campo e os valores nas tarefas.

---

### Tempo

#### `timer`

Timer por pessoa: iniciar um novo para o anterior. O tempo conta para "eu" (ver 2.4).

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
| `format` | enum | `json` traz `{from, to, total, groups[], entries[], project}` |

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

### Visão geral, atividade e busca

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
| `format` | enum | `json` traz as estatísticas completas do dashboard (por tipo, portfólio, carga, alocação, burndown, velocidade…) |

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

#### `search`

Busca universal (a mesma da paleta ⌘K do painel): tarefas (também pelo código `WEB-12`, inclusive concluídas e arquivadas), comentários, projetos, sprints, labels, pessoas e workspaces. Com as permissões ativas, só aparece o que está em projetos visíveis (labels globais ou desses projetos; workspaces que contêm algum deles).

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `query` | string ✓ | Texto, `#12` ou `WEB-12` |
| `limit` | integer | Por grupo, 1–30, padrão 8 |

```json
{ "query": "frete" }
```

```
## Tarefas
- #1 [bug] [concluída] [alta] Corrigir cálculo de frete (checkout) · prazo 2026-11-05 — Loja
## Comentários
- em #1 Corrigir cálculo de frete: "Frete grátis não aplica acima de R$ 200"
## Projetos
- [1] Loja (LOJA)
```

Sem resultados: `Nada encontrado para "frete".`

---

### Equipe, papéis e organizações

#### `list_members`

Lista os membros que podem ser responsáveis e indica quem é "me". Com as permissões ativas, um visualizador recebe só os nomes.

```
Bruno <bruno@exemplo.com> (admin) ← "me"
Ana <ana@exemplo.com>
```

---

#### `manage_members`

Lista ou define quem tem qual papel (dono, gerente, membro, visualizador) num projeto, workspace ou organização. Papéis em workspace e organização valem para os projetos de dentro; vale o papel mais alto.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `action` | enum ✓ | `list`, `set`, `remove` |
| `scope` | enum | `project` (padrão), `workspace` ou `organization` |
| `project_path` / `project` | string | Projeto (scope `project`; sem eles, o da pasta atual) |
| `target` | string | Nome ou id do workspace ou da organização (outros escopos) |
| `user` | string | Pessoa: nome, e-mail ou `"me"` (set, remove) |
| `role` | enum | `owner`, `manager`, `member`, `viewer` (set; padrão `member`) |

```json
{ "action": "set", "project": "Loja", "user": "ana@exemplo.com", "role": "manager" }
```

```
Membros do projeto Loja:
- Ana <ana@exemplo.com>: gerente
- Bruno <bruno@exemplo.com>: dono
```

- Sem ninguém com papel: `Ninguém com papel explícito no projeto Loja (vale o papel da conta de cada pessoa).`
- Com permissões ativas: no projeto, `list` exige leitura e `set`/`remove`, gestão; em workspaces e organizações, `set`/`remove` exigem ser administrador ou dono/gerente da organização.
- Dar ou tirar o papel de **dono** exige ser dono do projeto (no escopo `project`) ou dono da organização (nos escopos `workspace` e `organization`), ou administrador: `Só donos podem dar ou tirar o papel de dono`. É a mesma regra da API (`store.assertOwnerChange`).
- Convites, papéis de conta (administrador, membro, visualizador) e senhas ficam só no painel.

---

#### `manage_workspaces`

Lista, cria, edita ou exclui organizações e workspaces (aninháveis). Os projetos ficam nos workspaces; para mover um projeto, use `manage_project` com `workspace`.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `action` | enum ✓ | `list`, `create`, `update`, `delete` |
| `kind` | enum | `workspace` (padrão) ou `organization` |
| `target` | string | Nome ou id do workspace/organização existente (update, delete) |
| `name`, `description`, `color` | string | |
| `organization` | string | `create` de workspace: organização (padrão: a primeira) |
| `parent` | string ou null | Workspace-pai (aninhar); `null` leva para o topo |
| `website` | string | Site da organização |

`list` mostra a árvore:

```
# [1] Minha organização
- [1] Geral (3 projeto(s))
  - [3] Mobile (1 projeto(s))
- [2] Clientes (2 projeto(s))
```

```json
{ "action": "create", "name": "Mobile", "organization": "Minha organização", "parent": "Geral" }
```

```
Workspace criado: [3] Mobile em Minha organização
```

- Organização nova já nasce com o workspace "Geral": `Organização criada: [2] Cliente X (com o workspace "Geral")`.
- Excluir um workspace sobe os projetos e sub-workspaces dele um nível: `Workspace "Mobile" excluído (projetos e sub-workspaces subiram um nível).`
- Só dá para excluir uma organização sem projetos, e o quadro mantém ao menos uma.
- Com permissões ativas, criar e excluir organização exigem administrador; o resto, administrador ou dono/gerente da organização.

---

### Compartilhamento e notificações

#### `share_link`

Cria, lista ou revoga um link público **somente leitura** (`/s/<token>`) de uma tarefa ou de um projeto. Quem tiver o link vê sem login.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `action` | enum ✓ | `create`, `list`, `revoke` |
| `task_id` | integer ou string | Tarefa a compartilhar. Sem ela, vale o projeto. |
| `project_path` / `project` | string | Projeto a compartilhar (precisa ter visibilidade `public`) |
| `days` | integer ou null | Validade em dias (1 a 3650); omita para não expirar |
| `token` | string | `revoke`: o token do link |

```json
{ "action": "create", "task_id": "LOJA-2", "days": 7 }
```

```
Link público: http://localhost:4317/s/9vQm1xT0aZk3LbE2sPq7Rw8u (expira em 2026-11-07)
```

- Os links usam o endereço público do painel (Configurações → Geral) quando ele está preenchido.
- `list` mostra os links ativos: `http://localhost:4317/s/… · criado 2026-10-31 · expira 2026-11-07`.
- Projeto não público: `Para compartilhar um projeto inteiro, mude a visibilidade dele para "public" (manage_project).`
- Criar link de uma tarefa de projeto **privado** exige papel de gerente ou dono (com as permissões ativas).
- O que a página mostra está em [SISTEMA.md § 4.17](SISTEMA.md#417-links-públicos).

---

#### `send_notification`

Cria uma notificação no sino do painel (e no macOS e no e-mail, conforme as preferências de cada pessoa). O texto vai prefixado com "Claude:".

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `message` | string ✓ | |
| `task_id` | integer | Tarefa relacionada (clicar abre a tarefa) |
| `to` | string[] | Membros (nome, e-mail ou `"me"`). Padrão: todos. |

Resposta: `Notificação enviada (1 destinatário(s)).` A notificação é gravada com o tipo `claude`, então segue a preferência "Avisos do Claude" de cada pessoa.

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

#### `show_in_dashboard`

Abre uma tarefa, um projeto ou uma visão na tela do painel de "eu", se estiver aberto (o pedido chega em tempo real e vale por 2 minutos). Use quando o usuário pedir para "mostrar" ou "abrir" algo.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `task_id` | integer ou string | Tarefa a abrir (também abre o projeto dela) |
| `project_path` / `project` | string | Projeto a abrir |
| `view` | enum | `board`, `list`, `calendar`, `gantt`, `dashboard`, `activity` |

```json
{ "task_id": 12, "view": "board" }
```

```
Pedido enviado ao painel: tarefa #12. Se o painel não estiver aberto: http://localhost:4317/?task=12
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
| `trigger` | enum | `task_created`, `task_updated`, `status_changed`, `priority_changed`, `comment_added`, `assigned`, `due_soon`, `overdue`, `sprint_started`, `sprint_completed`, `project_created` |
| `conditions` | objeto | `to_status`, `from_status`, `priority[]`, `type[]`, `tag`, `by_claude`, `days` (due_soon), `field` (task_updated: nome da coluna no banco, ex.: `due_date`, `sprint_id`, `story_points`) |
| `action_type` | enum | `set_status`, `set_column`, `set_priority`, `add_tag`, `remove_tag`, `add_comment`, `notify`, `send_email`, `set_due_in_days`, `move_to_active_sprint`, `move_to_sprint`, `assign` |
| `action_value` | string/número | Valor da ação: status, nome da coluna, prioridade, label, texto, dias, pessoa ou sprint (`"active"`, `"next"`, nome ou id). Textos aceitam `{id}`, `{ref}`, `{titulo}`, `{projeto}`, `{prazo}`, `{status}`, `{prioridade}`, `{sprint}`. |
| `email_to` | string | `send_email`: `"followers"` (padrão: responsáveis, observadores e relator), `"assignees"` ou e-mails separados por vírgula |
| `email_subject` | string | `send_email`: assunto (aceita as mesmas variáveis) |
| `enabled` | boolean | |

```json
{ "action": "create", "name": "Bug novo → alta", "trigger": "task_created",
  "conditions": { "type": ["bug"] }, "action_type": "set_priority", "action_value": "high" }
```

```
Criada: #1 [ativa] Bug novo → alta — quando tarefa criada (tipo bug) → mudar prioridade "alta" · todos os projetos · executada 0x
```

```json
{ "action": "create", "name": "Concluída → e-mail", "project": "Loja", "trigger": "status_changed",
  "conditions": { "to_status": "done" }, "action_type": "send_email",
  "action_value": "{ref} {titulo} foi concluída.", "email_to": "followers", "email_subject": "[{ref}] concluída" }
```

```
Criada: #2 [ativa] Concluída → e-mail — quando status mudou (para concluída) → enviar e-mail "{ref} {titulo} foi concluída." · Loja · executada 0x
```

**Restrições:** `status_changed` não combina com `set_status` (ciclo); `project_created` só aceita `notify` e `send_email`; gatilhos de sprint não aceitam `set_due_in_days` nem `move_to_active_sprint`. Com permissões ativas, regras de um projeto exigem gestão nele (também para mover uma regra para outro projeto), regras globais exigem administrador, e `list` mostra só as regras globais e as dos projetos visíveis, como na API.

---

#### `manage_inbox`

Configura a caixa de entrada IMAP de um projeto (e-mails viram tarefas; respostas com `[#12]` no assunto viram comentários), mostra as mensagens recebidas ou sincroniza na hora. As regras, a coluna e o responsável padrão ficam no painel (Configurações do projeto). Funcionamento completo em [SISTEMA.md § 9.2](SISTEMA.md#92-caixa-de-entrada-imap--tarefas).

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `action` | enum ✓ | `get`, `configure`, `sync`, `messages` |
| `project_path` / `project` | string | |
| `enabled` | boolean | Ativa ou pausa |
| `address` | string | E-mail da caixa, mostrado às pessoas |
| `imap_host`, `imap_port`, `imap_secure` | string, integer, boolean | Servidor; porta padrão 993; TLS padrão ligado |
| `imap_user`, `imap_pass` | string | Login (a senha é cifrada; omita para manter a atual) |
| `mailbox` | string | Pasta. Padrão `INBOX` |
| `default_priority`, `default_type` | string | Valores das tarefas criadas |
| `auto_reply` | boolean | Responder ao remetente (exige SMTP) |
| `auto_reply_template` | string | Texto com `{id}`, `{titulo}` e `{link}` |
| `sync_minutes` | integer | Intervalo de sincronização, 1 a 1440 (padrão 5) |

```json
{ "action": "configure", "project": "Loja", "address": "suporte@loja.com", "imap_host": "imap.gmail.com",
  "imap_user": "suporte@loja.com", "imap_pass": "senha-de-app", "default_type": "bug", "auto_reply": true }
```

```
Caixa de entrada ativa · suporte@loja.com
IMAP: suporte@loja.com@imap.gmail.com:993 (TLS) · pasta INBOX · a cada 5 min
Novas tarefas: tipo bug, prioridade medium · resposta automática ligada
Última sincronização: nunca
```

- `sync` (assíncrona) busca até 50 mensagens não lidas: `Sincronizado: 2 tarefa(s) e 1 comentário(s) novos, 0 ignorada(s), 0 erro(s).`
- `messages` lista as últimas 30: `- 2026-10-31T14:02 Cliente ACME: Erro no checkout → task #31`.
- A sincronização periódica roda no servidor do painel, não no MCP.

---

### Importação e exportação

#### `import_tasks`

Importa tarefas para um projeto. Reimportar **atualiza** as tarefas já trazidas (casadas pelo id externo) em vez de duplicar. Mapeamento completo em [SISTEMA.md § 10](SISTEMA.md#10-importação-e-exportação).

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `project_path` / `project` | string | Projeto de destino (criado se for uma pasta nova) |
| `source` | enum ✓ | `csv` (genérico ou exportado do Jira), `trello_file` (JSON exportado), `jira_api`, `trello_api` |
| `path` | string | `csv` e `trello_file`: caminho absoluto do arquivo |
| `site` | string | `jira_api`: `https://empresa.atlassian.net` (hosts de `CLAUDE_TASKS_JIRA_HOSTS`) |
| `email` | string | `jira_api`: e-mail da conta |
| `token` | string | `jira_api`: token da API · `trello_api`: token |
| `jql` | string | `jira_api`: filtro, ex.: `project = WEB AND statusCategory != Done` |
| `board` | string | `trello_api`: link ou id do quadro |
| `key` | string | `trello_api`: chave da API |
| `save` | boolean | Fontes de API: salva a conexão (token cifrado) para sincronizar de novo pelo painel |

```json
{ "project": "Loja", "source": "csv", "path": "/Users/voce/Downloads/jira-export.csv" }
```

```
Importação em Loja: 10 criada(s), 2 atualizada(s), 0 ignorada(s)
http://localhost:4317/?project=1
```

Linhas com problema não param a importação: a resposta lista até 20 erros (`linha 7: …`). As fontes de API são assíncronas.

---

#### `export_tasks`

Exporta tarefas em CSV (abre no Excel e no Google Sheets) ou JSON.

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `project_path` / `project` | string | Sem eles: todos os projetos (visíveis) |
| `status` | enum | `all` (padrão), `open`, `todo`, `doing`, `blocked`, `done` |
| `format` | enum | `csv` (padrão) ou `json` (as tarefas completas, como no banco) |
| `path` | string | Caminho absoluto do arquivo a gravar (recomendado para exportações grandes) |

```json
{ "project": "Loja", "status": "open", "path": "/Users/voce/Desktop/loja.csv" }
```

```
12 tarefa(s) exportada(s) para /Users/voce/Desktop/loja.csv
```

Sem `path`, o conteúdo volta na resposta, cortado em 60 000 caracteres. Por poder gravar arquivo, a ferramenta não é marcada como só leitura.

---

#### `manage_settings`

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `action` | enum ✓ | `get` ou `update` |
| `notify_macos` | boolean | Notificações também no macOS |
| `due_soon_days` | integer 0–30 | Antecedência dos avisos de prazo |
| `chat_model` | `sonnet` \| `opus` \| `haiku` | Modelo do chat do painel no provedor `claude-cli` |

```
Notificações do macOS: ligadas
Avisar prazos com 1 dia(s) de antecedência
Modelo do chat do painel: sonnet
```

E-mail (SMTP), provedor de IA, idioma padrão e endereço público ficam no painel (Configurações).

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
| `tarefas://tasks/{id}` | Tarefa completa (o mesmo texto de `get_task`, com campos, relator, observadores e ids dos comentários) |
| `tarefas://projects/{id}` | Quadro: pasta, link, sprints abertas, cada coluna com as tarefas abertas (subtarefas recuadas) e as 10 concluídas mais recentes |
| `tarefas://projects/{id}/overview` | Visão geral do projeto |

Exemplo (`tarefas://projects/1`):

```markdown
# Loja
Pasta: /Users/voce/Developer/Loja
http://localhost:4317/?project=1

Sprint planejada: Sprint 1 (0/3 concluídas) — Página de produto

## A fazer (3)
- #2 [história] [a fazer] [média] Nova página de produto (produto) · 5 pts · subtarefas 0/2 · sprint Sprint 1
  - #3 [a fazer] [média] Layout da galeria (produto) · sprint Sprint 1 · subtarefa de #2
  - #4 [a fazer] [média] Zoom nas fotos (produto) · bloqueada por 1 · sprint Sprint 1 · subtarefa de #2

## Em andamento (0)

## Revisão (0)

## Bloqueadas (0)

## Concluídas recentemente
- #1 [bug] [concluída] [alta] Corrigir cálculo de frete (checkout) · prazo 2026-11-05
```

Um URI inexistente devolve o erro JSON-RPC `-32002` ("Resource não encontrado"). Os resources não aplicam as permissões de `CLAUDE_TASKS_ENFORCE`.

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
| `/mcp__tarefas__triagem` | `projeto?` | Corrige prioridade, tipo e labels; aponta duplicatas (sem excluir), descrições vagas e dependências faltando |
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
| Erro de validação, de regra ou de permissão numa ferramenta (campo inválido, tarefa inexistente, ciclo, transição não permitida, exclusão sem `confirm`, papel insuficiente…) | Resultado normal com `isError: true` e o texto `Erro: <mensagem>`. O Claude lê a mensagem e corrige a chamada. |
| Falha de um servidor externo (IMAP, Jira, Trello) | `isError: true` com a mensagem do servidor (ex.: `Erro: Jira respondeu 401: …`) |
| Ferramenta desconhecida | Erro JSON-RPC `-32602` |
| Prompt desconhecido, argumento obrigatório faltando, projeto ou tarefa inválidos no prompt | `-32602` |
| Resource inexistente | `-32002` |
| Método não suportado | `-32601` |
| JSON inválido na entrada | `-32700` |
| Falha inesperada | `-32603` |

As mensagens de erro são em português e dizem o que fazer. Por exemplo: `Coluna "QA" não existe. Colunas: A fazer, Em andamento, Bloqueadas, Concluídas` ou `Seu papel neste projeto é só de leitura`.

---

## 10. Protocolo

- **Transporte:** stdio, com uma mensagem JSON-RPC 2.0 por linha. O stdout é exclusivo do protocolo; avisos vão para o stderr.
- **Versões:** o servidor responde com a versão pedida pelo cliente, se for uma das suportadas; senão, com `2025-11-25`.
- **Concorrência:** cada linha é tratada assim que chega; ferramentas assíncronas (4.5) respondem quando terminam, então as respostas podem sair fora de ordem.
- **Métodos suportados:**

| Método | Resposta |
| --- | --- |
| `initialize` | `protocolVersion`, `capabilities`, `serverInfo` (`tarefas` 4.0.0, título "Quadro de tarefas"), `instructions` |
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
  | CLAUDE_TASKS_DB=/tmp/teste.db node --no-warnings src/mcp.js
```

Use sempre `CLAUDE_TASKS_DB=/tmp/teste.db` (ou outro banco descartável) para não mexer no banco real.

### 10.2 Organização do código

| Arquivo | Conteúdo |
| --- | --- |
| `src/mcp.js` | Protocolo: leitura de linhas, roteamento de métodos (com ferramentas assíncronas), `instructions` |
| `src/mcp/context.js` | Store compartilhado (com o motor de automações ligado), `me()`, permissões (`actingUser`, `guardProject`, `guardTask`, `visible`), resolução de projeto e pessoas, formatadores (`describeTask`, `projectBoard`, `overviewText`, `taskJson`) |
| `src/mcp/tools.js` | As 24 ferramentas originais (ampliadas): esquema, anotações e `run()` |
| `src/mcp/tools-extra.js` | As 11 ferramentas da paridade: comentários, labels, campos, membros, workspaces, links, busca, importação, exportação, painel e caixa de entrada |
| `src/mcp/resources.js` | Resources fixos, templates e leitura |
| `src/mcp/prompts.js` | Os 9 prompts e o autocompletar |

**Para adicionar uma ferramenta:** crie a entrada em `TOOLS` ou `EXTRA_TOOLS` (com `title`, `description` em inglês para o modelo, `inputSchema`, `annotations` e `run`), coloque a regra de negócio no `Store`, confira a permissão com `guardProject`/`guardTask`, acrescente-a à lista de `test/mcp.test.js` e um teste do comportamento.

---

## 11. Segurança

- **Local.** O MCP roda como processo do seu usuário e lê e grava o arquivo do banco diretamente. Não há autenticação, porque quem consegue iniciar processos no Mac já tem acesso ao arquivo. Para aplicar os papéis de quem usa, defina `CLAUDE_TASKS_USER` e `CLAUDE_TASKS_ENFORCE=1` (ver [2.4](#24-quem-é-eu-e-permissões-do-quadro)).
- **Rede.** A maioria das ferramentas não sai da máquina, mas `import_tasks` (APIs do Jira e do Trello) e `manage_inbox` (`sync`, IMAP) acessam servidores externos e são marcadas com `openWorldHint: true`. O Jira só é acessado por `https` e nos hosts de `CLAUDE_TASKS_JIRA_HOSTS`. Os links devolvidos apontam para o painel.
- **Exclusões.** `delete_tasks`, `manage_project` (`delete`) e `manage_comment` (`delete`) exigem `confirm: true`, e as `instructions` proíbem excluir sem pedido explícito. As ferramentas que podem excluir são marcadas com `destructiveHint: true`, e você pode negá-las em `permissions.deny`.
- **Acesso.** `manage_members` dá e tira papéis em projetos, workspaces e organizações (o papel de dono, só quem é dono). Não existem ferramentas para criar convites, mudar o papel da conta ou senhas: isso fica só no painel, com login.
- **Links públicos.** `share_link` cria endereços que qualquer pessoa abre sem login (só leitura, sem e-mails nem tempo). Revogue com `action: "revoke"`.
- **Segredos.** Senhas de IMAP e tokens de sincronização passados às ferramentas são cifrados no banco (AES-256-GCM, chave em `data/secret.key`) e nunca voltam nas respostas.
- **Arquivos.** `attach_file`, `import_tasks` (`path`) e `export_tasks` (`path`) leem e gravam no caminho indicado com as permissões do seu usuário. `get_attachment` só lê arquivos que já estão em `data/attachments`.
- **Chat do painel.** Com o provedor `claude-cli`, usa este mesmo MCP com `--strict-mcp-config` e `--tools ""` (sem acesso a arquivos ou terminal), iniciado com `CLAUDE_TASKS_USER` e `CLAUDE_TASKS_ENFORCE=1`. Com os provedores de API, as ferramentas rodam dentro do servidor. Nos três casos valem as permissões de quem conversa.

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
| `Seu papel neste projeto é só de leitura` / `Você não tem acesso a este projeto` | As permissões estão ativas (2.4) e "eu" não tem o papel necessário; peça o papel a um gerente ou rode sem `CLAUDE_TASKS_ENFORCE` |
| `Informe o projeto (project ou project_path)` | Com permissões ativas, a pasta da sessão não é usada: passe o projeto |
| `Transição não permitida: …` | O fluxo do projeto restringe os movimentos; veja `manage_columns` `list` ou `get_task` ("Pode ir para") |
| O painel não mostra o que o Claude gravou | Confira se ambos usam o mesmo banco (`CLAUDE_TASKS_DB`) e se o painel está "ao vivo" |
| `show_in_dashboard` não abre nada | O painel precisa estar aberto com a conta de "eu", e o pedido vale por 2 minutos |
| `import_tasks`: `Host … não permitido` | Acrescente o host do Jira em `CLAUDE_TASKS_JIRA_HOSTS` na configuração do MCP |
| `manage_inbox` `sync` falha | Veja `manage_inbox` `get` (último erro); confira host, porta, TLS e a senha de app |
| Notificação do macOS não aparece | Configuração `notify_macos` (`manage_settings`), a matriz de notificações da pessoa ou as permissões de notificação do macOS para o `osascript` |
| Imagem de `get_attachment` não aparece | Formato fora de PNG, JPEG, GIF ou WebP, ou arquivo acima de 5 MB. Use o caminho com Read. |

---

## 13. Histórico de versões

| Versão | Mudanças |
| --- | --- |
| **4.0** (paridade com o Taskosaur) | +11 ferramentas: `manage_comment`, `manage_labels`, `manage_fields`, `manage_members`, `manage_workspaces`, `share_link`, `search`, `export_tasks`, `import_tasks`, `show_in_dashboard`, `manage_inbox`. Novos campos nas tarefas: prioridade `lowest`, `story_points`, `remaining`, `reporter`, `watchers`, `fields`, dependências com tipo, recorrência com `weekdays`/`monthday`/`count` e frequência `quarterly`, sprint `"next"`, códigos `WEB-12`. Filtros `reporter`, `watcher`, `tag`. `add_comment` com `reply_to` e menções. `manage_project` com prefixo, status, prioridade, visibilidade, datas e workspace. `manage_columns` com transições e workflows. `manage_sprints` com `cancel`. `manage_automations` com 4 gatilhos (`task_updated`, `sprint_started`, `sprint_completed`, `project_created`), 3 ações (`set_column`, `send_email`, `move_to_sprint`), condição `field` e variáveis `{ref}`/`{sprint}`. Permissões com `CLAUDE_TASKS_ENFORCE` e no chat do painel (os três provedores), com as mesmas regras da API. `send_notification` com o tipo `claude`. Ferramentas assíncronas. `openWorldHint: true` em `import_tasks` e `manage_inbox`; `export_tasks` deixa de ser só leitura. |
| **3.0** | +14 ferramentas: `update_tasks`, `delete_tasks`, `add_comment`, `manage_project`, `manage_columns`, `timer`, `time_report`, `get_attachment`, `get_overview`, `get_activity`, `send_notification`, `list_notifications`, `manage_automations`, `manage_settings`. Anotações e títulos em todas. `format: json`. Novos parâmetros: `add_tags`/`remove_tags`, `add_blocked_by`/`remove_blocked_by`, `position`, `time_spent`, filtros `column`/`parent_id`/`sort`. "me" (`CLAUDE_TASKS_USER`). Resources, templates, 9 prompts e autocompletar. |
| 2.0 | Prazos, subtarefas, dependências, sprints (`manage_sprints`), recorrência, tempo (`log_time`), anexos (`attach_file`), equipe (`list_members`), automações disparadas pelo MCP |
| 1.0 | `add_tasks`, `list_tasks`, `get_task`, `update_task`, `complete_tasks`, `list_projects` |
