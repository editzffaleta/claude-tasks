---
name: mapa-do-codigo
description: Faz o mapa do código de um app (um repositório ou vários lado a lado), um mapa interativo de nós e ligações em que cada subsistema, módulo, arquivo e rota HTTP tem um nome legível e uma descrição de uma linha, ligados pelos imports e chamadas HTTP entre eles, em vários níveis de zoom. Fica salvo como uma página autossuficiente, mapa-do-codigo/index.html, dentro do projeto. Use sempre que o usuário quiser visualizar, mapear, diagramar, documentar ou ter uma visão geral da arquitetura de um código, repositório ou monorepo, entender como o app funciona ou se conecta por dentro, conhecer um código que não conhece, ver como o frontend fala com o backend, ou atualizar um mapa que já existe, mesmo sem dizer "visualizar" ("faça o mapa do código", "atualize o mapa", "me mostra como esse app se encaixa", "make me a floorplan of this app", "map this codebase", "update the floorplan"). Use também antes de existir código: quando o usuário mandar um PRD, uma especificação ou a descrição de algo que quer construir e perguntar de que peças precisa ou como elas se encaixam, desenhe uma planta, o mesmo mapa planejado a partir do documento.
argument-hint: "[raiz-do-codigo] [--refresh]"
allowed-tools:
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/build.mjs *)
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/describe.mjs *)
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/open.mjs *)
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/plan.mjs *)
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/recent.mjs *)
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/refresh.mjs *)
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/scan.mjs *)
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/status.mjs *)
---

# Mapa do código

Você produz `mapa-do-codigo/` na raiz do código: um mapa do app que alguém novo consegue ler como um diagrama do sistema. Cada card mostra um nome humano e uma descrição de uma linha, com o caminho real em letra pequena embaixo.

- **Você escreve:** `arquitetura.json` (subsistemas, módulos, fluxos) e `descricoes/*.json` (um nome e uma descrição para cada arquivo e rota).
- **Gerados:** `grafo.json` e `index.html`.

Os scripts fazem o trabalho mecânico: achar os repositórios, ler imports e rotas, casar chamadas HTTP com endpoints, montar o layout e desenhar. O seu trabalho é a parte que só quem lê o código consegue fazer: decidir o que cada coisa *é* e dizer isso com clareza.

**Idioma.** Escreva em português do Brasil, natural e direto, todo texto que alguém vai ler no mapa: `project.summary`, `label` e `summary` dos nós, nomes e descrições de arquivos e rotas, flows, tour, notas, trabalho recente, suposições e perguntas de uma planta. Caminhos, ids, nomes de código e produtos (Stripe, Postgres) ficam como estão. Termos técnicos sem tradução consagrada (endpoint, frontend, backend, webhook, PRD, commit) podem ficar em inglês.

Mapa existente: !`node ${CLAUDE_SKILL_DIR}/scripts/status.mjs || true`
Argumentos: $ARGUMENTS

**No Codex** (ou em qualquer agente que deixou as duas linhas acima sem preencher): `${CLAUDE_SKILL_DIR}` em todos os comandos daqui quer dizer a pasta desta skill, a que contém este SKILL.md, então use o caminho dela. Rode você mesmo `node <essa pasta>/scripts/status.mjs` a partir da raiz do código para ver se já existe um mapa, e tire o caminho e o `--refresh` do pedido do usuário. Os scripts percebem que estão rodando no Codex, então a barra de perguntas do mapa e os prompts "Corrigir com" usam o Codex.

## Ainda não existe código? Desenhe uma planta

Se o usuário quer planejar algo que ainda não construiu ("aqui está meu PRD", "quero fazer um app que…", uma descrição longa de um sistema), faça uma **planta**: o mesmo mapa, planejado a partir do documento dele em vez de lido do código. Use este caminho quando ainda não há código do sistema, mesmo que a pasta tenha outras coisas. Se o código existe, faça um mapa normal.

1. **Leia o material.** Um arquivo de PRD, uma mensagem colada ou um documento que ele indicar. Faça 2–3 perguntas só se algo fundamental estiver em aberto (quem usa, web ou celular, se alguém faz login, se há dinheiro envolvido); senão, decida e registre como suposição.
2. **Leia [referencias/planta.md](referencias/planta.md)**, depois [referencias/esquema.md](referencias/esquema.md) para o arquitetura.json.
3. **Escreva `mapa-do-codigo/plano.json`**: cada arquivo e endpoint planejado, o que cada tela chama, quais serviços externos e dados cada parte usa, quem pode usar cada endpoint, suas suposições e as perguntas em aberto. Se o PRD está só no chat, salve como `docs/prd.md` e use isso como `source`, para que o mapa e as próximas perguntas possam voltar a ele.
4. **Escreva `mapa-do-codigo/arquitetura.json`** como para um mapa de código (partes, nós externos para os serviços e dados que o plano.json cita, 1–3 flows para as principais histórias de usuário do PRD, um tour), com globs cobrindo os caminhos planejados. Linguagem simples para todo mundo, como no passo 4 abaixo.
5. **Rode `node ${CLAUDE_SKILL_DIR}/scripts/plan.mjs <raiz>`, depois o build.mjs** (passo 5 abaixo). Corrija o que eles apontarem até os dois saírem limpos. Pule o describe.mjs e o recent.mjs: nomes e descrições vêm do plano.json. Uma planta não acrescenta nada ao CLAUDE.local.md, porque ainda não há código para consultar.
6. **Mostre** com o open.mjs (passo 8).
7. **Relate** (no lugar do relato do passo 8): o endereço; a forma do sistema em 3–5 linhas; a stack que você escolheu; as principais suposições; e as perguntas e alertas da revisão da planta. Conte que cada parte tem **Construir isto com o Claude** (ou o Codex), com um pedido pronto para construir só aquela parte; que dá para trocar a barra de perguntas do mapa para **Alterar** e pedir acréscimos ou mudanças ("planeje também os reembolsos"), e o mapa se redesenha com o que mudou em destaque (o **Resolver no mapa** da revisão da planta preenche um pedido assim, então as perguntas em aberto só precisam da resposta); que o plano.json e o arquitetura.json são dele para editar ou para pedir que você mude; e que o mapa fica fora do git.

Para mudar uma planta, edite o plano.json e o arquitetura.json e rode o `refresh.mjs`, que a redesenha a partir do plano.json. Quando o código existir e o usuário quiser um mapa dele, rode `refresh.mjs <raiz> --from-code` e siga como num refresh. O plano.json continua onde está.

## Já existe um mapa? Atualize em vez de começar do zero

Se o status acima mostra um mapa existente, não comece de novo. Rode:

`node ${CLAUDE_SKILL_DIR}/scripts/refresh.mjs <raiz>`

Ele relê o código, compara as impressões digitais do conteúdo com o último build e faz a contabilidade sem gastar tokens:
- leva as descrições para arquivos e endpoints que foram movidos ou renomeados;
- tira as entradas de arquivos apagados;
- marca com uma nota `review` as entradas cujos exports ou rotas mudaram (edições dentro do corpo de funções não contam);
- refaz o build;
- mostra o que mudou e uma lista curta do que fazer em seguida.

Faça só o que essa lista pedir:
- acrescente globs para pastas novas que caíram em "não atribuídos";
- rode o describe.mjs (passo 6), que agora só gera fichas para os itens novos e marcados;
- revise os summaries dos módulos e os flows se a mudança foi grande.

Um refresh típico depois de algumas horas de trabalho é um punhado de entradas nas fichas. Depois marque o trabalho recente (passo 7), mostre e relate (passo 8). Mostre sempre, mesmo quando nada mudou: o usuário pediu para ver o mapa.

## Passo a passo (primeira vez)

A raiz do código é o argumento, se houver; senão, a pasta atual. Pode ser um único repositório ou uma pasta comum com vários (frontend + backend + infra e assim por diante). O scanner acha cada repositório git dentro dela e pula worktrees duplicadas.

1. **Varredura.**
   `node ${CLAUDE_SKILL_DIR}/scripts/scan.mjs <raiz>`
   Grava `mapa-do-codigo/.cache/scan.json` e mostra um resumo: repositórios, uma árvore do código com linhas, pontos de entrada, as ligações de import mais pesadas entre pastas, chamadas HTTP casadas com rotas entre repositórios, pacotes e hosts externos. Trabalhe a partir do resumo. Não leia o scan.json, que é grande.

2. **Leia o contrato.** Leia [referencias/esquema.md](referencias/esquema.md) (o formato do arquitetura.json) e [referencias/escolhendo-limites.md](referencias/escolhendo-limites.md) (como dividir um código num bom mapa).

3. **Explore só o necessário.** Leia READMEs, manifestos (package.json, pyproject, go.mod, docker-compose, configurações de deploy) e pontos de entrada, depois passe os olhos em 1–2 arquivos de cada subsistema candidato até conseguir escrever um resumo de uma frase para cada um. Você está atrás da forma do sistema, não de uma revisão de código.

4. **Escreva `mapa-do-codigo/arquitetura.json`.** Mire em:
   - 3–9 nós no nível de cima;
   - 3–12 filhos em cada nó grande;
   - globs cobrindo mais de 90% dos arquivos de código;
   - nós externos para os bancos de dados e serviços de terceiros com que o código realmente fala;
   - edges só para o que a varredura não enxerga (filas, cron, webhooks, chamadas entre serviços por URLs configuradas em variáveis de ambiente);
   - 1–3 flows que expliquem os principais trabalhos do sistema;
   - um `tour`: 3–8 paradas narradas para o tour "Comece aqui" (veja abaixo).

   Todo nó precisa de um `summary`.

   **Público.** Quem abre este mapa costuma ser o dono do app, muitas vezes alguém não técnico que o construiu com IA. A menos que o usuário peça um mapa para desenvolvedores, deixe `"audience"` sem valor ou com `"everyone"`, e escreva cada `project.summary`, `label`/`summary` de nó e descrição de arquivo e rota em linguagem simples, em português do Brasil (veja "Linguagem simples" em referencias/escrevendo-descricoes.md). Use rótulos curtos como "Servidor principal" em vez de "Shop API (Flask)". Os caminhos e o método/URL continuam visíveis nos cards, então as descrições só precisam dizer para que a coisa serve.

   **Tour.** Acrescente `"tour": [{ "node": "<id do nó ou caminho do arquivo>", "title": "…", "note": "…" }]`, com as paradas na ordem em que alguém novo deveria ver: o que é o app, os apps que as pessoas usam, o servidor principal, os serviços de fora, e terminando no arquivo de uma tela importante. Escreva títulos e notas em palavras simples, para quem nunca leu o código. O primeiro flow entra no fim automaticamente, como "veja um pedido de verdade". Sem tour, um é montado a partir dos summaries dos nós e do primeiro flow, então bons summaries e pelo menos um flow fazem diferença.

5. **Build e correções.**
   `node ${CLAUDE_SKILL_DIR}/scripts/build.mjs <raiz>`
   Ele valida tudo e aponta cada problema ("você quis dizer …", arquivos não atribuídos por pasta, globs ambíguos). Corrija e rode de novo até sair limpo e os não atribuídos ficarem abaixo de ~10%.

   **Nada do que o Mapa do código faz vai para o git.** `mapa-do-codigo/` tem o próprio `.gitignore`, que ignora a pasta inteira, então os arquivos versionados do projeto não mudam. Se o git já rastreia arquivos ali, o build mostra o comando `git rm -r --cached` para deixar de rastreá-los; repasse ao usuário em vez de rodar.

   **Um recado para as próximas sessões, só se o usuário quiser.** No Claude Code, o build pode manter um bloco curto e marcado no `CLAUDE.local.md` do projeto, as notas pessoais e fora do git do Claude Code, carregadas no início de cada sessão como o CLAUDE.md. O bloco avisa às próximas sessões do Claude Code aqui que o mapa existe e como consultá-lo com `mapa-do-codigo/consulta.mjs`, para que comecem pelo mapa em vez de procurar no código do zero. Como isso muda o jeito de trabalhar das próximas sessões, o build nunca o acrescenta sozinho: a linha `CLAUDE.LOCAL.MD` do build diz `não adicionado`, e você oferece no seu relato (passo 8). Só quando o usuário disser sim, rode `node ${CLAUDE_SKILL_DIR}/scripts/build.mjs <raiz> --claude-md`. Depois que o bloco existe, todo build o mantém em dia. O build põe o `CLAUDE.local.md` na lista de ignorados local do repositório (`.git/info/exclude`, não o `.gitignore`), reescreve só o próprio bloco e o tira do `CLAUDE.md` se uma versão antiga o pôs lá. Para tirar, o usuário apaga o bloco, ou põe `<!-- mapa-do-codigo:desligado -->` no CLAUDE.local.md para ele não voltar. No Codex o build pula isso: o Codex não tem um arquivo de notas pessoal e fora do git (o AGENTS.md é compartilhado com o time), então não acrescente nada lá também.

6. **Descreva cada arquivo e rota.**
   `node ${CLAUDE_SKILL_DIR}/scripts/describe.mjs <raiz>`
   Ele grava uma ficha por módulo (`mapa-do-codigo/.cache/worksheets/<chave>.md`) e um esqueleto para preencher (`mapa-do-codigo/descricoes/<chave>.json`). Cada ficha traz um resumo de cada arquivo (docstrings, definições, o que ele usa e o que o usa) e de cada rota (handler, docstring), o que basta para descrever a maioria dos arquivos sem abri-los.
   - Leia antes [referencias/escrevendo-descricoes.md](referencias/escrevendo-descricoes.md).
   - **Mais de ~150 arquivos:** divida as fichas entre subagentes em paralelo, se você tiver, ~100–150 arquivos cada, agrupados por área (rotas do backend, serviços, scripts, testes, telas). Passe a cada um as chaves das fichas, a raiz do código e o guia de escrita, e diga que edite só os próprios arquivos `descricoes/<chave>.json`, sem mudar as chaves, e que escreva em português do Brasil.
   - **Códigos menores:** faça você mesmo.

   Depois rode o build de novo. A linha `DESCRIÇÕES` do build mostra quantos arquivos e endpoints já têm descrição. Leve os dois a 100%: rode o describe.mjs de novo e ele lista só o que ainda falta.

7. **Marque o trabalho recente.** O mapa destaca o que acabou de ser trabalhado: esses cards ganham uma etiqueta verde de "Alterado"/"Novo", as partes que os contêm mostram "N alterados", passar o mouse mostra a sua nota, e um botão **Trabalho recente** junta todos num quadro só. Faça isso em toda criação e toda atualização, porque substitui os destaques anteriores.
   `node ${CLAUDE_SKILL_DIR}/scripts/recent.mjs <raiz>`
   Ele lista o que mudou desde o mapa anterior, as mudanças ainda sem commit e os commits recentes, cada um casado com o card em que aparece. O *porquê* vem de você:
   - **O que conta.** O trabalho feito nesta conversa, por você ou pelos seus subagentes, é a fonte principal. Apoie-se no que você sabe dele. Se você não fez nada aqui (uma sessão nova), use o que o recent.mjs mostra que está claramente em andamento: mudanças sem commit e os últimos commits. Se não houver nada, escreva `{ "tasks": [] }` para limpar os destaques antigos.
   - **Escreva `mapa-do-codigo/trabalho-recente.json`.** Use uma tarefa por coisa que o usuário pediu: `title` (2–5 palavras), `request` (o que ele pediu, nas palavras dele, encurtado), `summary` (1–2 frases sobre o que foi feito para isso e em que pé está, incluindo o que foi apagado, porque arquivos apagados não podem ser destacados). Depois acrescente `items`: os cards que mudaram, como caminho de arquivo, id de nó ou `"MÉTODO /caminho"`, com `change` (`"new"` ou `"changed"`) e uma `note`.
   - **Toda nota responde "o que isso tem a ver com o que ele pediu?"** Em uma ou duas frases simples, diga o que mudou neste card e por que o pedido precisava disso. Por exemplo: "Agora reconhece pedidos ao servidor cujo endereço é montado antes numa variável, e por isso as telas de pedidos e de estoque não mostravam nenhuma chamada ao servidor." Não: "Adicionados os helpers flattenTemplates e variableUse".
   - **Destaque o que importou.** Escolha os arquivos e endpoints cujo comportamento mudou para este pedido, geralmente 3–15. Pule testes e edições de passagem, a menos que sejam o ponto. Um arquivo com um endpoint alterado pode listar os dois.
   - **Deixe as palavras do código de fora, a menos que o público seja de desenvolvedores.** Nunca ponha segredos nas notas.

   Formato: [referencias/esquema.md#trabalho-recente](referencias/esquema.md#trabalho-recente). Depois rode o build.mjs. A linha `TRABALHO RECENTE` diz quantos cards ficaram em destaque e avisa sobre refs que não estão no mapa.

8. **Mostre e depois relate.** Sempre que fizer ou atualizar um mapa do código, termine colocando-o na frente do usuário:
   `node ${CLAUDE_SKILL_DIR}/scripts/open.mjs <raiz>`
   - Ele inicia o servidor do mapa em segundo plano (ou reaproveita o que já está rodando para este mapa) e abre o mapa no navegador. Abas já abertas recarregam no lugar em vez de abrir uma nova.
   - Ele mostra o endereço, se as perguntas funcionam (se a CLI do Claude Code ou o Codex foi encontrado) e como parar o servidor. O servidor também para sozinho umas duas horas depois que a última aba fecha.
   - **No Codex**, rode o open.mjs fora do sandbox (peça permissão elevada): o servidor precisa continuar rodando depois que o comando termina, e as perguntas precisam da rede para chegar ao Codex. Se isso não for permitido, passe ao usuário `node mapa-do-codigo/servidor.mjs` para ele rodar no próprio terminal, a partir da raiz do código.
   - Se você tem um navegador dentro do app ou uma ferramenta de preview, passe `--no-open` e abra lá o endereço mostrado, para o mapa aparecer ao lado da conversa.
   - Se esta é uma máquina remota ou sem tela, em que o usuário não alcança o 127.0.0.1, pule o open.mjs e diga a ele para rodar `node mapa-do-codigo/servidor.mjs` na própria máquina, ou ofereça o caminho do app do Claude (seção 9).

   Depois, **relate.** Dê o endereço e descreva a arquitetura que você mapeou em 3–5 linhas, em português do Brasil, incluindo o que for surpreendente: ciclos, arquivos que fazem tudo, áreas mortas, subsistemas acoplados demais. Sempre mencione os **itens importantes da Saúde** (`graph.health`; a saída do build e o grafo.json listam). Senhas e chaves escritas no código e endpoints pelos quais qualquer pessoa altera dados são coisas que o dono precisa saber. Nunca repita o valor de um segredo. Diga que o `arquitetura.json` e a pasta `descricoes/` são dele para editar, e que depois de mais trabalho ele pode só pedir para "atualizar o mapa do código", o que relê só o que mudou. Dê essas palavras simples em vez de um comando: no Claude Code o comando do plugin é `/mapa-do-codigo:mapa-do-codigo` (`/mapa-do-codigo` como skill pessoal), e no Codex é `$mapa-do-codigo`. Na primeira vez, diga numa linha que o mapa fica fora do git. No Claude Code, quando o build disse `não adicionado` na linha `CLAUDE.LOCAL.MD`, termine perguntando uma vez se as próximas sessões do Claude Code neste projeto devem usar o mapa: você acrescentaria um recado curto ao CLAUDE.local.md pessoal e fora do git dele. Acrescente (`build.mjs <raiz> --claude-md`) só se ele disser sim, e não pergunte de novo nas próximas atualizações se ele disse não. Numa atualização, comece pelo que mudou em relação ao que ele pediu (fica em destaque em **Trabalho recente**).

### Projeto no quadro de tarefas

Quando o projeto está no quadro de tarefas do usuário (o MCP `tarefas` está disponível e `list_projects` mostra uma pasta igual à raiz do código), depois de fazer ou atualizar o mapa:
- ofereça transformar em tarefas os problemas importantes da Saúde (ou, numa planta, as perguntas em aberto da revisão da planta). Se ele aceitar, crie uma tarefa por problema com `add_tasks` (passando `project_path` com a raiz do código), com um título curto e acionável e, na descrição, os arquivos e linhas, o risco e a correção segura, nunca o valor de um segredo. Antes, confira com `list_tasks` para não duplicar o que já está no quadro;
- ou lembre que a aba **Mapa do código** do projeto no quadro mostra o mesmo mapa, e que cada problema da Saúde tem lá **Criar tarefa no quadro**.

Nunca crie tarefas sem dizer. Se você criar, avise numa linha quais foram criadas.

## 9. Abrindo o mapa e fazendo perguntas

O mapa tem uma barra de perguntas flutuante. O usuário digita uma pergunta e o agente responde com texto e um quadro de resposta: os cards relevantes, as ligações entre eles, uma nota em cada card e, se fizer sentido, um passo a passo. Há duas formas de alimentá-la. A tela é a mesma nas duas.

- **CLI do Claude Code ou Codex (o melhor).** O servidor do mapa (`mapa-do-codigo/servidor.mjs`, iniciado pelo open.mjs no passo 8) serve o mapa em http://127.0.0.1:4378, ou na próxima porta livre. Cada pergunta roda com o login do próprio usuário, dentro do código, só lendo, então as respostas podem citar o código de verdade:
  - **Claude Code:** `claude -p` com o mapa (via `mapa-do-codigo/consulta.mjs`) mais Read/Grep/Glob no código. O servidor acha o `claude` no PATH ou em `~/.local/bin`.
  - **Codex:** `codex exec` no sandbox só de leitura do Codex, sem nada salvo no histórico do Codex dele. O servidor acha o `codex` no PATH ou a CLI que vem com o app do Codex.

  Ele usa o agente que fez o mapa e, se esse não estiver instalado, o outro. `--engine claude|codex` força um, `--claude <caminho>` ou `--codex <caminho>` aponta para uma instalação fora do comum, e `--model <nome>` escolhe o modelo (o open.mjs repassa todos). As respostas vêm em português do Brasil. O usuário também pode rodar `node mapa-do-codigo/servidor.mjs` quando quiser, e parar um que esteja em segundo plano com `node mapa-do-codigo/servidor.mjs --stop`.
- **Quadro de tarefas.** Se o projeto está no quadro, a aba **Mapa do código** do projeto mostra o mesmo mapa, com as mesmas perguntas, sem precisar do servidor separado.
- **App do Claude.** Se você está rodando no app do Claude (a ferramenta Artifact está disponível), ofereça publicar o mapa para ele abrir lá e fazer perguntas com a própria conta do Claude. As respostas então vêm só do mapa (nomes, descrições, ligações, endpoints), não do código, e a barra de perguntas mostra uma dica para instalar a CLI e ter uma experiência melhor. Para publicar:
  1. `node ${CLAUDE_SKILL_DIR}/scripts/build.mjs <raiz> --artifact`. Isso grava `mapa-do-codigo/artefato.html` sem o caminho absoluto desta máquina.
  2. Publique esse arquivo com a ferramenta Artifact, `capabilities: {"sample": {}}`, e mantenha o mesmo caminho de arquivo nas próximas publicações para o endereço não mudar.
  3. Depois de cada refresh, refaça com `--artifact` e publique de novo.

  Publicar envia o mapa (caminhos, nomes, descrições, estrutura), não o código, para a conta privada dele no claude.ai. Diga isso antes de publicar.
- **Nenhum dos dois:** `mapa-do-codigo/index.html` ainda abre direto no navegador. A barra de perguntas explica o que falta.

### Compartilhando uma cópia

Quando o usuário quiser mandar o mapa para alguém (um colega, um cliente, alguém sem Claude nem Codex), exporte. Uma exportação é o mesmo arquivo HTML único, sem a barra de perguntas, sem os prompts para o Claude ou o Codex, sem links para o editor, sem o caminho da pasta desta máquina e sem os remotes do git. O botão **Exportar** do mapa faz isso pelo navegador; daqui, rode:

```
node mapa-do-codigo/servidor.mjs --export [<arquivo>] [--include flows,notes,recent,health]
```

Ele grava `mapa-do-codigo/<projeto>-mapa.html`, a menos que receba um arquivo. `--include` tem como padrão `flows,notes` (os fluxos e o tour, as notas presas a arquivos); `recent` acrescenta o trabalho recente e `health` acrescenta a verificação de saúde, ou a revisão da planta numa planta. Deixe a saúde de fora a menos que o usuário peça, e se pedir, diga que ela lista os endpoints que qualquer pessoa pode usar e onde há segredos no código (nunca os valores), então ele só deve mandar para pessoas de confiança. Qualquer exportação mostra como o app se encaixa (cada parte, arquivo e endpoint, com nomes e descrições), mas não o código.

### O que mais o mapa entrega (automático)

- **Saúde.** Um botão no topo, com a contagem de problemas importantes, abre uma lista em linguagem simples dos problemas que a varredura achou:
  - senhas e chaves de API escritas no código ou num `.env` que foi para o git;
  - chaves secretas em variáveis que chegam ao navegador (`NEXT_PUBLIC_`, `VITE_` e afins);
  - tabelas do Supabase sem row-level security, e políticas que deixam qualquer pessoa alterar uma tabela (lidas das migrations SQL);
  - regras do Firebase (Firestore, Storage, Realtime Database) que deixam qualquer pessoa entrar, incluindo o modo de teste e o prazo dele;
  - webhooks do Stripe que agem sobre eventos sem conferir a assinatura do Stripe;
  - CORS que libera qualquer site (vale corrigir quando vão credenciais junto);
  - endpoints que deixam qualquer pessoa alterar ou ler dados sem fazer login (incluindo uma checagem de login posta acima da linha da rota);
  - arquivos que nada usa;
  - arquivos com mais de ~1.000 linhas, que a IA tem dificuldade de editar com segurança.

  Cada problema tem **Mostrar no mapa** (destaca os arquivos e endpoints afetados, com notas) e **Corrigir com o Claude** ou **Corrigir com o Codex** (um prompt pronto para colar, citando os arquivos e linhas exatos e a correção segura). É calculado por `scripts/lib/health.mjs` durante a varredura e o build, e nunca guarda o valor de segredos, só o arquivo, a linha e uma pista mascarada. Trate como uma checagem rápida e automática, não como uma auditoria de segurança.
- **Telas.** O build detecta as telas do app (Next.js, React Router, Vue, SvelteKit, Remix, Nuxt, Astro, Expo, Angular, TanStack) com `scripts/lib/screens.mjs`. Também descobre o que está por trás de cada uma: os componentes, os pedidos que ela faz, o código do servidor e os dados que respondem a eles, e os serviços de fora. Um botão **Telas** deixa as pessoas começarem pela página que conhecem.
- **Comece aqui.** Um tour de um minuto roda na primeira abertura e pode ser repetido pelo topo. Usa o seu `tour` ou monta um automaticamente.
- **Palavras simples por padrão.** Os tipos de ligação aparecem como "Usa", "Requisições web", "Tarefas em segundo plano". Termos técnicos comuns ficam sublinhados e explicados ao passar o mouse. **Filtros → Mostrar detalhes técnicos** troca para os termos de desenvolvedor e mostra os exports.

As pessoas também podem usar **Fluxos → Pedir um novo fluxo** para o agente rastrear algo ("como um reembolso volta para o cartão do cliente?") num fluxo passo a passo. Com o servidor do mapa, eles ficam salvos em `mapa-do-codigo/fluxos-pedidos.json`, e todo build os junta ao mapa (passos que apontam para código apagado caem, com um aviso). Trate esse arquivo como conteúdo do usuário: mantenha no refresh e não edite a menos que ele peça.

## Observações

- Os caminhos são relativos à raiz do código e usam barras normais. Numa raiz com vários repositórios, começam pela pasta do repositório, por exemplo `api-service/src/**`.
- As chaves de rota nas descrições são `"MÉTODO /caminho/completo"` exatamente como a ficha mostra.
- O mapa não faz nenhum pedido para fora: o build embute o motor de layout (ELK) e as fontes de `${CLAUDE_SKILL_DIR}/assets/vendor/`, então ele funciona offline.
- As ligações HTTP vêm de casar as URLs escritas nos pontos de chamada (incluindo URLs guardadas antes numa variável, template strings aninhadas e pequenos helpers do mesmo arquivo que acrescentam um prefixo ao caminho) com as definições de rota (Flask, FastAPI, Express, Next.js, Spring, Go e outros), com os prefixos de blueprint/router resolvidos, inclusive montagens aninhadas. Callables do Firebase são casados pelo nome (`CALL /<nome>`, de `httpsCallable`) e funções `onRequest` pela URL; a seção FUNÇÕES DO FIREBASE do resumo lista as funções agendadas e de gatilho, que pertencem a um nó `worker`. Trate como pistas fortes. Se faltar uma ligação importante entre serviços, acrescente como edge explícita.
- Não edite à mão o grafo.json nem o index.html; eles são refeitos a cada build.
- Baseado no Floorplan, de Hayden Smith (licença MIT).
