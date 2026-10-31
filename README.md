# Quadro de tarefas

Um gerenciador de projetos central para **todos** os seus projetos, inspirado no
[Taskosaur](https://github.com/taskosaur/taskosaur) e alimentado pelo Claude. Em qualquer projeto,
quando o Claude deixa algo para depois, encontra um bug que não corrigiu ou sugere um follow-up,
ele registra a tarefa aqui pelo MCP `tarefas`. Você acompanha tudo em http://localhost:4317.

Não tem dependências: usa só o Node 22.13+ (com o SQLite embutido, `node:sqlite`).

## Documentação

- **[docs/SISTEMA.md](docs/SISTEMA.md):** arquitetura, instalação e operação, conceitos e regras, guia de cada tela, automações, notificações, permissões, modelo de dados, API REST, segurança e solução de problemas.
- **[docs/MCP.md](docs/MCP.md):** referência completa do servidor MCP (24 ferramentas, resources, prompts/comandos, autocompletar, erros, protocolo e configuração).

## Funcionalidades

| Área | O que tem |
| --- | --- |
| Visualizações | Quadro kanban (arrastar entre e dentro das colunas), Lista (ordenável e agrupável), Calendário (arrastar para remarcar), Gantt (arrastar barras, setas de dependência), Dashboard |
| Planejamento | Início e prazo com destaque de atrasadas, subtarefas com progresso, dependências "bloqueada por" (sem ciclos), sprints (planejar, iniciar, concluir movendo pendentes), tarefas recorrentes |
| Execução | Timer e lançamentos manuais de tempo, estimativa × gasto, anexos (arrastar, clicar ou colar imagem), colunas personalizadas por projeto, tipos (tarefa, bug, história, épico), arquivar, ordem manual |
| Equipe | Login, convites por link, papéis (administrador/membro), responsáveis, notificações (no painel e no macOS) |
| Automação | Regras "quando X → faça Y" (status, prioridade, prazo chegando/vencido, comentário, atribuição) que valem para você, a equipe e o Claude |
| IA | O Claude usa o MCP em qualquer sessão; o painel também tem um chat que roda a CLI do Claude só com as ferramentas do quadro |

Atalhos no painel: `N` nova tarefa, `/` busca, `C` chat, `1`–`5` troca de visão, `Esc` fecha.

## Como funciona

```
Sessão do Claude (projeto A) ─┐
Sessão do Claude (projeto B) ─┼─ MCP stdio (src/mcp.js) ─┐
Chat do painel (claude -p)  ──┘                          ├─ data/tasks.db (SQLite, WAL)
Navegador ── painel + API REST (src/server.js) ──────────┘
                └─ agendador: avisos de prazo e automações por tempo
```

- **Projeto**: é o repositório git que contém o diretório onde o Claude está. Worktrees contam
  como o repositório principal. Projetos sem pasta podem ser criados pelo painel (ex.: "Pessoal").
- **Status e colunas**: toda tarefa tem uma categoria (a fazer, em andamento, bloqueada, concluída).
  Cada projeto pode ter colunas próprias dentro dessas categorias (ex.: "Revisão").
- **Sem duplicatas**: uma tarefa aberta com o mesmo título no mesmo lugar não é criada de novo.
- **Ao vivo**: o painel percebe gravações de qualquer processo e se atualiza em ~2s.
- **Automações e notificações** rodam em qualquer processo que grava (painel ou MCP), então valem
  também para o que o Claude faz. Mudanças feitas por automações não disparam outras automações.

### MCP

O MCP `tarefas` (versão 3.0) tem 24 ferramentas para tarefas, projetos, colunas, sprints, tempo,
anexos, visão geral, atividade, equipe, notificações, automações e configurações. Também tem
resources (`@tarefas:tarefas://tasks/12`) e 9 prompts que viram comandos no Claude Code, como
`/mcp__tarefas__proxima`, `/mcp__tarefas__planejar_sprint` e `/mcp__tarefas__relatorio`.
Referência completa em [docs/MCP.md](docs/MCP.md).

## Instalação

```bash
# 1. MCP disponível em todos os projetos
claude mcp add --scope user tarefas -- "$(command -v node)" --no-warnings ~/Developer/claude-tasks/src/mcp.js

# 2. Painel sempre ligado (launchd, inicia no login)
~/Developer/claude-tasks/bin/service.sh install
```

3. Instrução global em `~/.claude/CLAUDE.md` dizendo ao Claude para registrar pendências (já incluída).
4. No primeiro acesso a http://localhost:4317, crie a conta de administrador.
5. Chat do painel: precisa da CLI `claude` logada (rode `claude` no Terminal e use `/login`).

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

Depois convide as pessoas em **Equipe → Convidar pessoa** e envie o link. Para acesso pela
internet, coloque o painel atrás de um proxy com HTTPS (ex.: Tailscale ou Cloudflare Tunnel).

## Dados e backup

- Banco: `data/tasks.db` · anexos: `data/attachments/`.
- Antes de cada migração de esquema, um backup automático é salvo em `data/backup-v<versão>-<data>.db`.

## Desenvolvimento

```bash
npm start   # painel em http://localhost:4317
npm test    # testa MCP, hook e API com bancos temporários
```

Variáveis: `CLAUDE_TASKS_DB` (banco), `CLAUDE_TASKS_PORT` (padrão 4317), `CLAUDE_TASKS_HOST`
(padrão 127.0.0.1), `CLAUDE_TASKS_HOSTS` (hosts extras permitidos), `CLAUDE_BIN` (caminho da CLI
do Claude para o chat), `CLAUDE_TASKS_NO_OS_NOTIFY=1` (desliga notificações do macOS).
