# Mapa do código

> Plugin para Claude Code e Codex · integrado ao Quadro de Tarefas · tradução e adaptação do [Floorplan](https://github.com/haydenschmitty/floorplan) 0.6.0, de Hayden Smith (licença MIT)

**Veja como o seu app se encaixa de verdade.** O Claude (ou o Codex) lê o código do projeto e desenha um mapa interativo dele. Cada parte, arquivo e requisição web ganha um nome e uma descrição em português simples, e todas as ligações entre eles aparecem no mapa. O mapa fica na pasta do projeto, abre no navegador e também aparece numa aba do quadro, ligado às tarefas.

Este documento é o guia de uso. A arquitetura do módulo dentro do quadro está em [SISTEMA.md § 11.5](SISTEMA.md#115-mapa-do-código) e a ferramenta MCP `code_map` em [MCP.md](MCP.md#code_map).

## Sumário

1. [O que é e para quem é](#1-o-que-é-e-para-quem-é)
2. [Instalação](#2-instalação)
3. [O primeiro mapa](#3-o-primeiro-mapa)
4. [Manter o mapa atualizado](#4-manter-o-mapa-atualizado)
5. [Planejar o que ainda não existe (planta)](#5-planejar-o-que-ainda-não-existe-planta)
6. [Usando o mapa](#6-usando-o-mapa)
7. [Integração com o quadro](#7-integração-com-o-quadro)
8. [Como funciona](#8-como-funciona)
9. [Arquivos no seu projeto](#9-arquivos-no-seu-projeto)
10. [Privacidade e segurança](#10-privacidade-e-segurança)
11. [Solução de problemas](#11-solução-de-problemas)
12. [Créditos e licenças](#12-créditos-e-licenças)

---

## 1. O que é e para quem é

Você fez um app, provavelmente com bastante ajuda de IA, e ele funciona. Mas se alguém pergunta "o que acontece quando um cliente finaliza a compra?" ou "o que quebra se eu mudar isto?", a resposta honesta costuma ser *não faço ideia*.

O Mapa do código é o diagrama que ninguém desenhou. Peça ao Claude Code ou ao Codex e, alguns minutos depois, você tem um mapa para explorar, fazer perguntas e manter em dia enquanto trabalha.

- **Para quem constrói:** entender o app que você fez, nas suas palavras, sem precisar ler o código.
- **Para equipes:** apresentar o projeto a alguém em minutos, da visão geral até o arquivo exato.
- **Para trabalhar com IA:** depois de cada mudança que o Claude ou o Codex faz, ver exatamente quais partes foram tocadas e por quê.
- **Para o quadro:** as tarefas que citam arquivos aparecem nos cartões desses arquivos, e um problema encontrado no mapa vira tarefa com um clique.

O que ele oferece:

- **Um mapa em vários níveis de zoom.** Comece pelo app inteiro e entre numa parte, num grupo de arquivos, num arquivo e nos endpoints dele. Cada visão mostra quem usa aquilo e o que aquilo usa.
- **Português simples em todo lugar.** "Recebe pagamentos com cartão no checkout", não "wrapper da API do Stripe". Termos técnicos são explicados ao passar o mouse, e um filtro mostra a visão de desenvolvedor.
- **Ligações reais, mesmo entre repositórios.** Ele segue os imports e liga cada requisição web do frontend ao endpoint do servidor que a responde, mesmo em repositórios separados.
- **Comece por uma tela.** Escolha uma página que você conhece e veja tudo o que está por trás dela.
- **Pergunte ao mapa.** "Como um reembolso volta para o cartão do cliente?" vem com uma resposta e um minimapa só com as peças envolvidas, passo a passo.
- **Saúde.** Pega os erros clássicos de apps feitos com IA: chaves no código, tabelas abertas, webhooks falsificáveis, endpoints sem login. Cada item vem com uma correção pronta para colar. É uma verificação, não uma auditoria.
- **Trabalho recente.** Os cartões que a IA acabou de mudar ficam verdes, cada um com uma nota de como a mudança atende ao que você pediu.
- **Sempre atual, sempre seu.** As atualizações releem só o que mudou, e um mapa aberto se recarrega sozinho. Tudo roda no seu computador e nada vai para o git.

E mais: **fluxos** guiados que você pede em palavras simples, o tour **Comece aqui**, **Exportar** para mandar uma cópia em um único arquivo HTML, layout para **celular e tablet**, busca, atalhos de teclado e ações no botão direito em todo cartão.

> **Para quem o texto é escrito:** o mapa, os nomes e as descrições são em português do Brasil e, por padrão, escritos para o dono do app, não para um engenheiro. Se a equipe prefere termos técnicos, peça "reescreva o mapa do código para desenvolvedores".

---

## 2. Instalação

### 2.1 Requisitos

- **Claude Code** (a aba Code do app Claude ou a CLI no Terminal) **ou Codex** (o app ou a CLI, entrando com a conta do ChatGPT).
- **[Node.js](https://nodejs.org) 18 ou mais novo** para os scripts do plugin. Confira com `node --version`. O quadro em si pede o Node 22.13+, então quem já roda o quadro está coberto.
- **Recomendado no Claude Code: a [CLI do Claude Code](https://code.claude.com/docs/en/overview)**, mesmo que você use mais o app. Com ela, a barra de perguntas do mapa consegue ler o seu código de verdade ao responder. O Codex não precisa de nada extra.
- O mapa roda com o plano que você já tem, sem chaves de API.

O plugin fica neste repositório, na pasta [`mapa/`](../mapa/). O próprio repositório é o marketplace de onde ele é instalado.

### 2.2 No Claude Code

Rode uma vez, em qualquer Terminal:

```bash
claude plugin marketplace add ~/Developer/claude-tasks
claude plugin install mapa-do-codigo@claude-tasks
```

O primeiro comando adiciona este repositório como fonte de plugins (o marketplace `claude-tasks`). O segundo instala o plugin `mapa-do-codigo` para todos os seus projetos. O app e a CLI compartilham as configurações, então ele aparece nos dois.

**Abra uma sessão nova** depois de instalar: plugins carregam quando a sessão começa.

> No app Claude, você também encontra plugins pelo botão **+** ao lado da caixa de mensagem (**Add plugins** ou **Plugins → Browse plugins**). A lista mostra os plugins dos marketplaces que você já adicionou.

### 2.3 No Codex

Rode uma vez no Terminal, com a [CLI do Codex](https://developers.openai.com/codex/cli):

```bash
codex plugin marketplace add ~/Developer/claude-tasks
codex plugin add mapa-do-codigo@claude-tasks
```

Se preferir o app, rode só o primeiro comando e depois, no app do Codex, abra **Plugins**, encontre **Mapa do código** (no marketplace "Quadro de tarefas (claude-tasks)") e clique em **+** para instalar. O app e a CLI compartilham os plugins, então instalar num vale para os dois. Abra uma conversa nova depois de instalar.

A barra de perguntas do mapa usa o seu próprio login do Codex, sem chave de API.

### 2.4 Atualizar e remover

**Atualizar.** O plugin é instalado da pasta do quadro, então ele se atualiza junto com ela. Depois de atualizar a pasta `~/Developer/claude-tasks`, abra uma sessão nova.

- **Claude Code:** um plugin instalado de uma pasta local roda direto dela. Não há passo de atualização.
- **Codex:** o Codex copia o plugin para o cache dele ao instalar. Depois de atualizar a pasta, rode de novo `codex plugin add mapa-do-codigo@claude-tasks` e abra uma conversa nova.

**Remover:**

```bash
claude plugin uninstall mapa-do-codigo@claude-tasks
# no Codex:
codex plugin remove mapa-do-codigo@claude-tasks
```

Depois apague a pasta `mapa-do-codigo/` dos projetos em que você usou o mapa (e, se usou o Claude Code, a seção do mapa no `CLAUDE.local.md`, veja a [seção 9.3](#93-claudelocalmd)). A aba **Mapa do código** do quadro volta a mostrar as instruções de instalação.

---

## 3. O primeiro mapa

1. **Abra o projeto.** No app Claude, escolha a pasta do projeto na linha abaixo da caixa de mensagem antes de mandar a primeira mensagem. No Codex, abra a pasta do projeto. No Terminal, rode `claude` ou `codex` dentro da pasta.

   Se o app está dividido em vários repositórios (por exemplo `web/` e `api/` lado a lado), abra a pasta que contém todos. O mapa junta os repositórios e liga as requisições entre eles.

2. **Peça:**

   > Faça o mapa do código deste projeto.

   No Claude Code você também pode escolher **mapa-do-codigo** no menu **/** (o comando é `/mapa-do-codigo:mapa-do-codigo`). No Codex, digite `$mapa-do-codigo`.

3. **Deixe trabalhar.** O que acontece:
   - Uma varredura lista todos os arquivos, imports, endpoints e requisições web. Leva segundos e não gasta tokens.
   - O Claude (ou o Codex) lê os READMEs, os arquivos de configuração e os pontos de entrada, e decide quais são as partes principais do app e para que serve cada uma.
   - Ele escreve um nome e uma descrição de uma linha para cada arquivo e endpoint. No Claude Code, projetos com mais de uns 150 arquivos são divididos entre ajudantes em paralelo.
   - O mapa é montado e conferido: ligações, problemas de Saúde e telas.

   Um app pequeno leva alguns minutos; um grande, mais. Você pode ser perguntado se permite rodar os scripts do mapa (`node …`): permita. O Codex também pede para iniciar o servidor do mapa fora do sandbox, para que o mapa continue rodando e a barra de perguntas alcance o Codex.

4. **Explore.** O mapa abre sozinho, no navegador do app ou no seu navegador. Na primeira vez roda o tour **Comece aqui**, de um minuto. A resposta do Claude resume como o app se encaixa e aponta o que a Saúde encontrou de sério.

Se o projeto está no quadro, o mapa também aparece na aba **Mapa do código** dele (veja a [seção 7](#7-integração-com-o-quadro)).

### Coisas para experimentar

| Peça ao Claude Code ou ao Codex | Pergunte ao mapa |
| --- | --- |
| "Faça o mapa do código deste projeto" | "O que acontece quando alguém faz um pedido?" |
| "Atualize o mapa do código" | "Onde a gente fala com o Stripe?" |
| "Corrija os problemas importantes da Saúde do mapa" | "Se eu mudar a tabela de usuários, o que quebra?" |
| "Adicione um fluxo mostrando como um usuário novo se cadastra" | "Quais arquivos cuidam do login?" |
| "Reescreva o mapa do código para desenvolvedores" | "O que mudamos para os reembolsos?" |
| "Exporte o mapa do código para eu mandar para a equipe" | |

### Abrir o mapa por conta própria

O mapa é uma pasta no projeto. Você pode:

```bash
node mapa-do-codigo/servidor.mjs
```

que serve o mapa em http://127.0.0.1:4378 com a barra de perguntas funcionando, ou dar dois cliques em `mapa-do-codigo/index.html`, onde tudo funciona menos as perguntas. Se o projeto está no quadro, ele também abre pela aba **Mapa do código**, sem precisar de servidor nenhum.

Quando o Claude abre o mapa para você, o servidor fica rodando em segundo plano e para sozinho duas horas depois que você fecha a última aba. Para parar antes:

```bash
node mapa-do-codigo/servidor.mjs --stop
```

---

## 4. Manter o mapa atualizado

Depois que você (ou a IA) mexeu no código:

> Atualize o mapa do código.

O plugin varre de novo e compara com o último mapa. Arquivos movidos mantêm suas descrições, os apagados somem, e só o que é novo ou mudou de propósito é reescrito. Por isso a atualização é rápida e barata. Um mapa já aberto no navegador (ou na aba do quadro) se recarrega sozinho, e os cartões que acabaram de mudar ficam verdes em **Trabalho recente**.

Na aba do quadro, o botão **Pedir atualização ao Claude** copia esse pedido para você colar numa sessão do Claude Code na pasta do projeto.

---

## 5. Planejar o que ainda não existe (planta)

Tudo acima é o trabalho principal do mapa: mostrar código que já existe. Ele tem um segundo uso, para quando ainda não há código: desenhar uma **planta** do app a partir de um PRD, de uma especificação ou de uma descrição do que você quer construir. Abra a pasta onde o app vai nascer (pode estar vazia), compartilhe o documento e peça:

> Aqui está o meu PRD. Faça o mapa do código do que a gente precisaria construir.

Você recebe uma **planta**: o mesmo tipo de mapa, com cada parte, arquivo, endpoint e tela de que o app precisaria, como eles se ligam e os serviços externos de que dependem. Os cartões têm contorno tracejado, para ficar claro que é um plano. A resposta diz qual stack o Claude ou o Codex escolheu, o que ele assumiu e quais perguntas o PRD deixa em aberto.

No mapa:

- **Revisão** lista o que o plano ainda precisa decidir, como endpoints que qualquer um poderia usar ou perguntas em aberto. **Resolver no mapa** resolve um item: numa pergunta, é só digitar a resposta.
- Mude a chave da barra de perguntas de **Perguntar** para **Alterar** para mexer no plano ("planeje também os reembolsos"). O mapa se redesenha com o que mudou em destaque, e **Desfazer** volta atrás.
- Cada parte tem **Construir isto com o Claude** (ou com o Codex), um pedido pronto para construir só aquela parte.
- No quadro, cada parte também tem **Criar tarefa para construir**, e cada item da Revisão tem **Criar tarefa no quadro** (veja a [seção 7.3](#73-criar-tarefas-pelo-mapa)).

Quando o código existir, peça ao Claude ou ao Codex para "mapear o código de verdade agora", e a planta vira um mapa normal. Detalhes em [8.5](#85-plantas).

---

## 6. Usando o mapa

O mapa é um quadro de cartões ligados por linhas. Cada cartão é uma parte do app: uma área grande como "Servidor principal", um grupo de arquivos, um arquivo ou um endpoint (um endereço que o servidor atende). As linhas mostram o que usa o quê.

### 6.1 Navegação

| Para… | Faça |
| --- | --- |
| entrar num cartão | dois cliques nele, ou selecione e aperte **Enter** |
| voltar um nível | **Backspace**, a seta de voltar ou o caminho (breadcrumbs) no topo |
| mover o mapa | arraste o fundo |
| aproximar e afastar | role, ou **+** / **−** |
| ver tudo na tela | **F**, ou o botão de ajustar à tela no canto inferior esquerdo |
| achar qualquer coisa | **/** ou **Ctrl/⌘ K**, e digite um nome, arquivo ou endereço |
| ver detalhes | clique num cartão; o painel da direita se preenche |
| mostrar ou esconder o painel | **P**, ou o botão do painel no canto superior direito |
| fechar um menu, parar um fluxo, limpar a seleção | **Esc** |

Os detalhes dos cartões se simplificam conforme você afasta: as descrições somem e os títulos crescem, para o mapa continuar legível de longe.

### 6.2 No celular ou tablet

- **Arraste** com um dedo para mover e **pince** com dois para dar zoom.
- **Toque num cartão** para ver os detalhes numa folha na parte de baixo. **Abrir**, na folha, entra no cartão. Tocar no vazio, entrar, subir um nível ou **Esc** fecham a folha.
- A barra do topo quebra em duas linhas e os botões mostram só os ícones. No celular, os botões de zoom ficam na linha de cima, e a descrição abaixo do título se dobra em uma linha, com **Mais** para ler o resto.

Com mouse, numa janela de 1000 px ou mais, nada muda. (O suporte a celular e tablet do original foi feito por [@menachem-kurkus](https://github.com/menachem-kurkus).)

### 6.3 Cartões

- **Título e descrição:** um nome em português simples e uma linha sobre o que aquilo faz.
- **Rodapé:** à esquerda, quanto há dentro (grupos, arquivos ou endpoints). À direita, uma etiqueta verde quando faz parte do trabalho recente.
- **Cartões de endpoint** mostram o método e o endereço (`POST /api/pedidos`) acima do nome.
- **Um pontinho âmbar** depois do título indica uma nota presa àquele arquivo.
- **Tarefas do quadro:** quando o mapa é aberto pelo quadro, um selo no rodapé mostra quantas tarefas abertas citam aquele arquivo, ou os arquivos de dentro daquela parte (veja a [seção 7.2](#72-tarefas-ligadas-aos-arquivos)).
- **Cartões em forma de pílula nas bordas** de uma visão são coisas de fora dela. Os colchetes acima de cada coluna dizem qual lado é qual:
  - **Usado por:** partes de fora que usam ou chamam esta.
  - **Dentro de ‹nome›:** do que esta parte é feita.
  - **Usa:** partes de fora de que ela depende, como um banco de dados ou o Stripe.

  Dois cliques numa pílula levam até ela.

Pare o mouse sobre um cartão por um instante para ver que tipo de coisa ele é, onde fica e qual o tamanho. Pare sobre uma linha para ver o que ela carrega, por exemplo quais endpoints uma tela chama.

### 6.4 Painel lateral

Clique em qualquer coisa para vê-la no painel: a descrição completa, do que faz parte, o que tem dentro, **Usado por** e **Depende de**, os endpoints e botões para abrir ou perguntar sobre aquilo. Sem nada selecionado, o painel descreve a visão atual, ou o app inteiro no nível de cima. No quadro, o painel também tem a seção **Tarefas do quadro** (veja a [seção 7.2](#72-tarefas-ligadas-aos-arquivos)).

Arraste a borda esquerda do painel para mudar a largura.

### 6.5 Botões do cabeçalho

#### Saúde

Mostra quantos problemas importantes existem e abre uma lista, em linguagem simples, do que a varredura encontrou:

- senhas e chaves escritas no código ou num arquivo `.env` que vai para o git;
- chaves secretas em configurações que o navegador recebe, como uma chave da OpenAI numa variável `VITE_` ou `NEXT_PUBLIC_`;
- tabelas do Supabase com a segurança por linha (RLS) desligada, e regras de banco que deixam qualquer um mudar uma tabela;
- regras do Firebase (Firestore, Storage, Realtime Database) que deixam qualquer um ler ou mudar os dados ou arquivos, inclusive as do "modo de teste" e quando elas expiram;
- webhooks do Stripe que agem sobre pagamentos sem conferir a assinatura do Stripe, ou seja, qualquer um poderia forjar um;
- servidores que aceitam chamadas de qualquer site (CORS aberto), marcados como importantes quando cookies de login vão junto;
- endpoints que deixam qualquer um mudar ou ler dados sem entrar na conta (inclusive quando a verificação de login está no lugar errado);
- frontend apontando para `localhost`, que só funciona no seu computador;
- arquivos que nada usa;
- arquivos com mais de umas 1.000 linhas, que a IA tem dificuldade de editar com segurança.

Cada item tem **Mostrar no mapa**, que destaca os arquivos e endpoints afetados com notas, e **Corrigir com o Claude** (ou **Corrigir com o Codex**, num mapa feito no Codex), que copia um pedido pronto com os arquivos, as linhas e a correção segura. No quadro, cada item tem ainda **Criar tarefa no quadro**.

**É uma verificação rápida e automática, não uma auditoria de segurança.** Ela pega os erros mais comuns, não todos. A Saúde nunca guarda nem mostra o valor de um segredo, só onde ele está (veja a [seção 10.3](#103-segredos)). Numa planta, este botão vira **Revisão** (veja a [seção 6.7](#67-plantas-no-mapa)).

Os itens vêm em três grupos: **Corrija primeiro**, **Vale corrigir logo** e **Bom arrumar quando der**.

#### Trabalho recente

Aparece quando o Claude ou o Codex acabou de mudar coisas. Ele reúne os cartões alterados num só quadro, com o que você pediu, um resumo do que foi feito e uma nota em cada cartão. No resto do mapa, os cartões alterados ganham um anel verde e uma etiqueta **Alterado** ou **Novo**, e as partes que os contêm mostram **N alterados**, para você seguir o verde de cima para baixo.

#### Telas

Todas as páginas do app que o mapa detectou. Escolha uma para ver tudo o que está por trás dela: os componentes, as requisições que ela faz, o código do servidor que responde, os dados que elas tocam e os serviços externos.

#### Exportar

Salva uma cópia do mapa para mandar para qualquer pessoa: alguém da equipe, um cliente, alguém sem Claude nem Codex. É um único arquivo HTML que abre em qualquer navegador, sem instalar nada.

A cópia tem o mapa inteiro, a busca, as telas, o tour e os fluxos, mas **não tem**: a barra de perguntas, os pedidos **Corrigir com…** e **Construir isto com…**, os links para o editor, nem nada sobre o seu computador, como o caminho da pasta ou os endereços dos repositórios (que podem carregar um token de acesso). Também não tem nada do quadro: nem as tarefas, nem os botões de criar tarefa. Um selo **Exportado em ‹data›** fica ao lado do título, e um link discreto, "Mapa do código · baseado no Floorplan", leva ao projeto original.

Você escolhe o que entra:

- **Fluxos e o tour** (inclusive os que você pediu) e **Notas presas aos arquivos**: ligados por padrão;
- **Trabalho recente**: desligado por padrão;
- **Verificação de saúde** (ou **Revisão da planta**, numa planta): desligada por padrão. A Saúde lista os endpoints que qualquer um pode usar e onde há segredos no código (nunca os valores), então só inclua para quem você confia.

Só aparecem as opções que o mapa tem. Toda cópia mostra como o app se encaixa (cada parte, arquivo e endpoint, com nomes e descrições, e os nomes das funções lá dentro), mas **não o código-fonte**. O botão **Baixar** salva o arquivo `<projeto>-mapa.html`. Exportar precisa do servidor do mapa (o autônomo ou o do quadro); num mapa aberto direto do arquivo, o botão mostra o comando para rodar. Você também pode pedir ao Claude ou ao Codex para "exportar o mapa do código", ou rodar:

```bash
node mapa-do-codigo/servidor.mjs --export [arquivo] [--include flows,notes,recent,health]
```

#### Comece aqui

Repete o tour de um minuto que roda na primeira vez que você abre um mapa.

#### Fluxos

Passeios guiados pelas tarefas principais do app, como "Finalizar compra" ou "Cadastro". Um fluxo percorre o quadro passo a passo, com uma narração em cada parada. Use **←** / **→** ou os botões da barra do fluxo para avançar e voltar, e **Esc** para parar.

**Pedir um novo fluxo** deixa você descrever um em palavras simples ("como um reembolso volta para o cartão do cliente?"), e o Claude ou o Codex segue o caminho pelo código. Os fluxos pedidos ficam salvos junto com o mapa.

#### Filtros

- **Mostrar conexões:** liga e desliga os tipos de linha (Usa, Requisições web, Chamadas, Eventos, Tarefas em segundo plano, Lê e grava dados, Configurações).
- **Mostrar detalhes técnicos:** troca para os termos de desenvolvedor (Importações, HTTP, RPC, Filas, Dados) e mostra o que cada arquivo exporta.
- **Destacar trabalho recente:** desliga os destaques verdes, para um mapa limpo.
- **Mostrar tarefas do quadro:** liga e desliga os selos de tarefas nos cartões (só no mapa aberto pelo quadro).

### 6.6 Perguntar ao mapa

Digite na barra de perguntas, embaixo, e aperte **Enter**. O Claude ou o Codex responde em poucas frases e mostra um **quadro de resposta**: só os cartões envolvidos, como eles se ligam, uma nota curta em cada um e um passo a passo numerado quando a resposta é uma sequência. Enquanto ele responde, o botão de enviar vira **Parar**. Sugestões de próximas perguntas aparecem abaixo da resposta. **Voltar ao mapa** leva de volta para onde você estava.

- **Botão direito → Perguntar sobre isto**, em qualquer cartão ou linha, junta aquele item à pergunta como contexto.
- O rótulo na barra mostra quem está respondendo. **Claude Code** é a CLI do Claude Code e **Codex** é o Codex, os dois rodando no seu computador e capazes de ler o código-fonte. **Claude** quer dizer que o mapa foi aberto no app Claude, que responde só com o que está no mapa.
- Se nenhum estiver disponível, a barra explica o que falta. Veja a [seção 11](#11-solução-de-problemas).
- No quadro, perguntar exige permissão de edição no projeto (veja a [seção 7.4](#74-permissões)).

### 6.7 Plantas no mapa

Uma planta funciona como um mapa de código, com algumas diferenças:

- **Cartões tracejados e o selo Planta** ao lado do título mostram que é um plano. Sem nada selecionado, o painel diz de qual documento ela foi planejada, a stack e as suposições feitas.
- **Revisão** no lugar da Saúde. É uma revisão do desenho do plano: endpoints que qualquer um poderia usar para mudar dados, endpoints sem decisão sobre quem pode usá-los, perguntas que o PRD deixa em aberto e peças que nada liga. Cada item tem **Mostrar no mapa** e **Resolver no mapa**, que muda a barra para **Alterar** e preenche um pedido para resolvê-lo. Numa pergunta em aberto, escreva a resposta depois de "Minha resposta:" e aperte **Enter**. (Quando o mapa não está sendo servido, o botão vira **Resolver com o Claude** ou **Resolver com o Codex**, um pedido para colar.) No quadro, cada item também tem **Criar tarefa no quadro**.
- **Quem pode usar:** o painel de um endpoint diz se qualquer pessoa, pessoas com login (e quais), a sua equipe ou outro serviço pode usá-lo.
- **Construir:** toda parte e todo arquivo têm **Construir isto com o Claude** (ou com o Codex), que mostra um pedido para construir só aquela peça do jeito que o plano descreve (arquivos, endpoints, do que depende e as perguntas em aberto), pronto para copiar. No quadro, há também **Criar tarefa para construir**, que registra esse pedido como tarefa.
- **Perguntar e Alterar:** a barra tem uma chave. **Perguntar** responde a partir do plano e do PRD. **Alterar** aceita pedidos como "planeje também os reembolsos" ou "tire a página de administração". Leva alguns minutos; depois o mapa se redesenha, os cartões novos e alterados ficam em destaque como trabalho recente, e um resumo oferece **Mostrar N mudanças**, **Desfazer** e sugestões de próximas mudanças. No quadro, **Alterar** e **Desfazer** exigem permissão de gestão no projeto.

### 6.8 Menus do botão direito

| Em | Você tem |
| --- | --- |
| um cartão | Abrir (numa pílula de fora: Ir para ‹nome›) · Mostrar no mapa (num quadro de resposta) · Perguntar sobre isto · Mostrar detalhes · Criar tarefa sobre isto (no quadro) · Copiar caminho (ou Copiar endpoint) · Copiar nome · Abrir no editor |
| uma linha | Perguntar sobre esta conexão · Mostrar detalhes · Ir para ‹origem› · Ir para ‹destino› |
| o fundo | Ajustar à tela · Subir um nível · Voltar à visão geral · Buscar · Perguntar sobre esta visão |

**Abrir no editor** abre o arquivo no VS Code (ou em outro editor que aceite links `vscode://`) na linha certa.

---

## 7. Integração com o quadro

O quadro serve o mapa de cada projeto que tem pasta no computador, com o mesmo login e as mesmas permissões do painel. Não é preciso rodar o servidor do mapa: o quadro já faz esse papel.

### 7.1 A aba Mapa do código

- Aparece ao lado de Quadro, Lista, Calendário, Gantt e Dashboard, **só em projetos com pasta** (o mapa é gerado dentro dela). Projetos criados pelo painel sem pasta, como "Pessoal", não têm a aba.
- **Sem mapa ainda:** a aba explica como instalar o plugin, mostra o pedido para fazer na pasta do projeto (com botões de copiar) e tem **Conferir de novo**.
- **Com mapa:** uma barra mostra se é uma planta, quantos arquivos, telas e endpoints o mapa tem, quando foi atualizado e quantos problemas importantes a Saúde achou. Abaixo, o mapa inteiro, igual ao do navegador.
- **Pedir atualização ao Claude** copia "Atualize o mapa do código deste projeto" para colar numa sessão do Claude Code na pasta do projeto.
- **Abrir em outra aba** abre o mapa sozinho, em `/mapa/<id do projeto>/`, ainda com o login do quadro.
- Quando o Claude refaz o mapa, ele se recarrega sozinho dentro da aba.

### 7.2 Tarefas ligadas aos arquivos

Uma tarefa que cita o caminho de um arquivo no título ou na descrição aparece presa ao cartão desse arquivo. Não é preciso marcar nada: basta escrever o caminho, como o Claude já costuma fazer ao registrar pendências.

- **Caminhos com pasta** (`src/pedidos.js`, `web/app/page.tsx`) ligam ao arquivo com esse caminho e a qualquer arquivo cujo caminho termine com ele (`src/pedidos.js` também liga `web/src/pedidos.js`).
- **Só o nome do arquivo** (`stripe.js`) liga apenas quando há um único arquivo com esse nome no mapa.
- Número de linha no fim (`db.js:120`) é ignorado, assim como maiúsculas e minúsculas.
- Tarefas criadas pelo próprio mapa sobre um cartão (**Criar tarefa sobre isto**) ou uma peça da planta (**Criar tarefa para construir**) ficam presas a esse cartão, mesmo sem citar caminho nenhum.
- Entram as tarefas abertas e as concluídas nos últimos 14 dias.

No mapa:

- **Selo no cartão:** quantas tarefas **abertas** citam o arquivo. As partes e pastas mostram as tarefas dos arquivos de dentro, contando cada tarefa uma vez só. Parando o mouse sobre o cartão, aparecem as três primeiras.
- **Painel lateral:** a seção **Tarefas do quadro** lista as abertas e até cinco concluídas, com o código e o status. **Abrir no quadro** abre o detalhe da tarefa no painel em volta do mapa (ou numa aba nova, se o mapa foi aberto sozinho).
- **Filtros → Mostrar tarefas do quadro** esconde e mostra os selos.
- Os selos se atualizam quando você cria uma tarefa pelo mapa e quando volta para o mapa depois de um tempo em outra aba.

### 7.3 Criar tarefas pelo mapa

| Onde | Botão | A tarefa criada |
| --- | --- | --- |
| Item da **Saúde** | Criar tarefa no quadro | label `saúde`; os problemas importantes viram bug com prioridade alta, os demais, tarefa comum de prioridade média; na descrição, o problema, o pedido pronto para corrigir com o Claude (ou o Codex) e onde ele está |
| Item da **Revisão** (planta) | Criar tarefa no quadro | label `revisão`, com a decisão em aberto, o pedido pronto para resolvê-la e as peças envolvidas |
| Parte ou arquivo de uma planta | Criar tarefa para construir | "Construir ‹nome›", label `construir`, com o pedido de **Construir isto** na descrição |
| Parte, pasta, arquivo, endpoint ou função (botão direito ou painel lateral) | Criar tarefa sobre isto | um título que você escolhe (já vem com o nome do cartão) e uma descrição com o cartão e onde ele fica |

- Toda tarefa criada pelo mapa ganha também a label `mapa` e é registrada em seu nome. Depois de criar, o botão vira "Tarefa ‹código› criada", com link para ela.
- **Sem duplicatas:** o mesmo problema da Saúde (ou o mesmo item da Revisão, a mesma peça a construir) vira uma tarefa só. Clicar de novo mostra "A tarefa ‹código› já existia", mesmo que ela já tenha sido concluída. Sobre um cartão qualquer, dá para criar quantas tarefas quiser. Em todos os casos vale a regra geral do quadro: não se cria uma tarefa aberta com o mesmo título no mesmo projeto.
- A tarefa nova já aparece no mapa: presa ao cartão de onde saiu e, como a descrição cita os caminhos, aos cartões desses arquivos.
- Criar tarefas exige permissão de edição no projeto.

Também dá para pedir na conversa: depois de fazer ou atualizar o mapa de um projeto que está no quadro, o Claude oferece transformar os problemas importantes da Saúde (ou, numa planta, as perguntas em aberto da Revisão) em tarefas, com `add_tasks` do MCP `tarefas`. Ele confere antes o que já está no quadro, nunca põe o valor de um segredo na descrição e só cria se você aceitar.

### 7.4 Permissões

O mapa segue os papéis do projeto (veja [SISTEMA.md § 8](SISTEMA.md#8-usuários-papéis-e-permissões)):

| Ação no mapa | Visualizador | Membro | Gerente | Dono |
| --- | --- | --- | --- | --- |
| Ver o mapa, buscar, telas, fluxos, tour, Saúde e as tarefas ligadas; exportar uma cópia | ✓ | ✓ | ✓ | ✓ |
| Perguntar ao mapa e pedir novos fluxos | — | ✓ | ✓ | ✓ |
| Criar tarefas pelo mapa | — | ✓ | ✓ | ✓ |
| Alterar a planta (**Alterar** e **Desfazer**) | — | — | ✓ | ✓ |

- Contas visualizadoras nunca perguntam ao mapa, nem com um papel maior no projeto.
- Projetos privados: quem não é membro não vê nem a página do mapa.
- **Quem paga as perguntas:** no quadro, cada pergunta roda a IA no computador onde o quadro está, na pasta do projeto, com a conta do Claude Code (ou do Codex) de quem mantém o quadro. Por isso só quem pode editar o projeto pergunta.

### 7.5 Ferramenta MCP `code_map`

Qualquer sessão do Claude com o MCP `tarefas` (e o chat do painel) pode consultar o mapa de um projeto sem abrir o navegador:

- `status`: se há mapa, quando e por quem foi feito, quantas partes, arquivos, endpoints e telas, e os avisos da Saúde;
- `overview`: o sistema de relance: as partes, os fluxos e o trabalho recente;
- `find`: acha partes, arquivos, endpoints e símbolos (funções, classes) por nome ou texto;
- `show`: um item com o que o usa e o que ele usa;
- `path`: o caminho entre dois itens.

É só leitura e responde em português (o `status` em texto, as outras ações com o JSON do mapa). Referência completa em [MCP.md](MCP.md#code_map).

### 7.6 API

| Rota | O que faz | Quem pode |
| --- | --- | --- |
| `GET /api/projects/:id/mapa` | Situação do mapa: `available`, `exists`, `folder`, `generated_at`, `agent`, `blueprint`, `files`, `parts`, `screens`, `endpoints`, `health` (`total`, `high`) e `recent` | leitura |
| `GET /api/projects/:id/mapa/consulta?arg=find&arg=pedidos` | Consulta ao mapa, como a `code_map` (até 6 `arg`); responde `{ "text": "…" }` | leitura |
| `GET /mapa/:id/` | A página do mapa, com login | leitura |
| `GET /mapa/:id/api/quadro/tarefas` | Tarefas ligadas aos arquivos | leitura |
| `POST /mapa/:id/api/quadro/tarefas` | Cria uma tarefa a partir do mapa | edição |

As demais rotas em `/mapa/:id/api/` são a API própria da página do mapa (perguntar, fluxos, planta, exportar) e seguem a tabela da [seção 7.4](#74-permissões).

---

## 8. Como funciona

O trabalho é dividido entre scripts e a IA em que você roda o plugin, o Claude Code ou o Codex. Os scripts fazem tudo o que é mecânico: achar os arquivos, ler o código, ligar requisições a endpoints, desenhar o mapa. São Node.js puro, sem dependências, e não gastam tokens. A IA faz o que só quem lê o código consegue: decidir o que as partes do app *são* e explicar isso com clareza.

```
status: já existe mapa? ── não ─▶ varredura ─▶ a IA escreve arquitetura.json ─▶ montagem
          │                                                                       │
          └── sim ─▶ atualização (varre de novo e aproveita o que não mudou) ─────┤
                                                                                  ▼
                        abrir o mapa ◀── a IA marca o trabalho recente ◀── a IA descreve cada arquivo e endpoint
```

### 8.1 As etapas

1. **Varredura.** O plugin acha todos os repositórios git dentro da pasta indicada (um repositório, um monorepo ou vários lado a lado), ignorando worktrees duplicadas. Ele lista os arquivos pelo git, então o seu `.gitignore` é respeitado, e extrai de cada arquivo: os **imports**, resolvidos até os arquivos de verdade (aliases do TypeScript, pacotes Python, módulos Go, crates Rust, pacotes da JVM); as **definições exportadas** e seus comentários de documentação; os **endpoints** que o servidor define; as **requisições web** que o código faz; e **impressões digitais** do conteúdo, para as próximas atualizações saberem o que mudou.
2. **A IA descreve o sistema.** O Claude ou o Codex lê o resumo da varredura, os READMEs, os arquivos de configuração e os pontos de entrada, e escreve `arquitetura.json`: as partes principais do app, cada uma com um resumo; os serviços externos com que ele realmente fala (bancos, pagamentos, e-mail); as ligações que a varredura não vê, como filas, tarefas agendadas e webhooks; alguns fluxos guiados e o tour Comece aqui.
3. **Montagem.** O script de montagem confere tudo o que a IA escreveu e aponta os problemas pelo nome ("você quis dizer …"). Ele coloca cada arquivo na parte mais profunda cujos padrões combinam com ele, liga as partes (pelos imports, pelas requisições ligadas a endpoints e pelas ligações explícitas da IA), roda a **Saúde**, detecta as **telas** e grava `grafo.json` e o `index.html` autossuficiente.
4. **A IA descreve cada arquivo.** Para cada parte sai uma ficha com o resumo de cada arquivo e endpoint: o que define, os comentários, o que usa e quem o usa. A IA preenche um nome e uma descrição para cada item em `descricoes/`. Em projetos grandes, o Claude Code divide as fichas entre ajudantes em paralelo. Por padrão tudo é escrito para o dono do app, não para um engenheiro: o que cada coisa faz para o negócio, em palavras do dia a dia.
5. **Trabalho recente.** A cada criação ou atualização, a IA registra em `trabalho-recente.json` o que acabou de ser feito. O script lista os fatos (o que mudou desde o último mapa, mudanças ainda não commitadas e commits recentes, cada um ligado ao seu cartão) e a IA acrescenta o *porquê*: o que você pediu e como cada mudança atende ao pedido. Os destaques anteriores são substituídos a cada vez.
6. **Abrir.** O servidor local do mapa sobe em segundo plano e abre o navegador. Se ele já está rodando para este mapa, é reaproveitado, e as abas abertas se recarregam no lugar.

O mapa se desenha no próprio navegador com o [ELK](https://eclipse.dev/elk/), então a montagem é rápida.

### 8.2 Ligando requisições a endpoints

As linhas mais úteis do mapa ligam as requisições de uma tela ao código do servidor que as responde, muitas vezes entre repositórios. Para isso o plugin:

- **acha os endpoints** em Express, Koa, Hono, Next.js (arquivos de rota e API routes), Firebase Cloud Functions, Flask, FastAPI, Django, Go (net/http, Gin, Echo, chi, Fiber), Actix, Axum e Spring;
- **resolve prefixos**: blueprints do Flask registrados com `url_prefix` e routers do Express montados com `app.use('/api/usuarios', usuariosRouter)`, inclusive routers dentro de routers e montagens com middleware na frente;
- **acha as requisições** feitas com `fetch`, axios, ky, `requests` e parecidos, inclusive endereços montados numa variável antes (`const url = …; api.get(url)`), template strings com partes aninhadas e pequenos helpers do mesmo arquivo que acrescentam um prefixo, como `chamar('/definicoes')`;
- **trata o Firebase pelo nome**: uma função `onCall` aparece como `CALL /aprovarItem` e recebe as chamadas `httpsCallable(functions, 'aprovarItem')` (inclusive por um helper seu); uma `onRequest` é um endpoint comum em `/<nome>`; funções agendadas e de gatilho ficam para a IA posicionar no mapa;
- **liga** os dois lados. Quando a requisição só traz parte do endereço, porque a URL base está numa configuração, o plugin aprende o caminho base de cada cliente e prefere as ligações que combinam com ele.

É reconhecimento de padrões, não um compilador: pega a maioria das ligações, mas não todas. Se faltar uma importante, peça para acrescentá-la ao mapa, e ela fica registrada como ligação explícita.

### 8.3 Linguagens e frameworks

- **Linguagens:** TypeScript e JavaScript (inclusive arquivos Vue, Svelte e Astro), Python, Go, Rust, Java, Kotlin, Scala e Groovy, com suporte mais leve para outras.
- **Endpoints:** Express, Koa, Hono, Next.js, Firebase Cloud Functions, Flask, FastAPI, Django, net/http, Gin, Echo, chi e Fiber do Go, Actix, Axum e Spring.
- **Telas:** Next.js, React Router, Vue, SvelteKit, Remix, Nuxt, Astro, Expo, Angular e TanStack.

### 8.4 Atualizações

A atualização varre de novo e compara com a última montagem usando a impressão digital de cada arquivo:

- **conteúdo exato**, que percebe edições, renomeações e mudanças de pasta;
- **assinatura**: o que o arquivo exporta, seus endpoints e comentários de documentação. Edições dentro do corpo das funções não contam.

Com isso ela leva as descrições junto para arquivos e endpoints movidos ou renomeados, descarta as entradas de arquivos apagados e marca para revisão as entradas cuja assinatura mudou. Depois monta de novo. A IA só precisa descrever o que é novo ou foi marcado, e conferir a estrutura se a mudança foi grande.

### 8.5 Plantas

Uma planta é o caminho inverso: um mapa de algo que ainda não foi construído. A IA lê o PRD ou a descrição e escreve `plano.json`: cada arquivo e endpoint de que o sistema precisaria, qual tela chama qual endpoint, quais partes usam serviços externos e o banco, e quem pode usar cada endpoint. Ele também guarda a stack escolhida, as suposições e as perguntas em aberto.

O plano vira o mesmo tipo de varredura que o código gera, então a montagem, as telas, os fluxos, o tour e as perguntas funcionam igual. As diferenças:

- os cartões são tracejados e o quadro tem o selo **Planta**;
- a Saúde vira a **Revisão** do plano;
- cada parte tem **Construir isto com o Claude** (ou com o Codex);
- as perguntas são respondidas a partir do plano e do PRD, porque não há código para ler;
- **Alterar** recebe pedidos como "planeje também os reembolsos": a IA devolve o plano atualizado, o servidor do mapa confere (mandando os problemas de volta uma vez), salva e redesenha o mapa com as mudanças em destaque. **Desfazer** volta ao plano anterior. A IA continua só lendo: quem grava é o servidor, e só `plano.json`, `arquitetura.json` e `trabalho-recente.json`.

Atualizar uma planta a redesenha a partir de `plano.json`. Quando o código existir, o mapa passa a ser feito a partir do código, e `plano.json` continua lá.

### 8.6 Perguntas

O servidor do mapa responde cada pergunta com a IA do seu computador, na pasta do projeto:

- **Claude Code:** roda `claude -p` só com ferramentas de leitura: ler e buscar arquivos e o `mapa-do-codigo/consulta.mjs`, que consulta o mapa.
- **Codex:** roda `codex exec` no sandbox somente leitura do Codex, com as mesmas consultas. Essas execuções não ficam no seu histórico do Codex, então uma pergunta seguinte leva junto as últimas perguntas e respostas.

Ele usa quem fez o mapa e, se esse não estiver instalado, o outro. Nos dois casos a resposta vem com texto e os cartões a mostrar, então ela pode citar código de verdade. No app Claude, o mapa pergunta ao Claude pelo próprio app, com as mesmas consultas mas sem acesso ao código-fonte.

As mesmas consultas ajudam as sessões comuns do Claude Code: se você aceitar depois do primeiro mapa, a seção que o plugin acrescenta ao `CLAUDE.local.md` diz a elas para consultar o mapa antes de vasculhar o código do zero. Você também pode usar a consulta direto no Terminal:

```bash
node mapa-do-codigo/consulta.mjs visao-geral          # ou overview
node mapa-do-codigo/consulta.mjs buscar "pagamento"   # ou find; --tipo arquivo|modulo|endpoint|simbolo
node mapa-do-codigo/consulta.mjs mostrar f:src/pedidos.js   # ou show; aceita também "POST /api/pedidos"
node mapa-do-codigo/consulta.mjs caminho f:web/src/checkout.tsx "POST /api/pedidos"   # ou path
```

Toda resposta é JSON, com ids. Pelo quadro, a ferramenta MCP [`code_map`](#75-ferramenta-mcp-code_map) faz o mesmo.

---

## 9. Arquivos no seu projeto

O plugin grava em exatamente dois lugares do seu projeto: a pasta `mapa-do-codigo/` e (no Claude Code, só se você aceitar) uma seção curta no `CLAUDE.local.md`. Nenhum dos dois vai para o git, e nada mais no projeto é tocado.

### 9.1 A pasta `mapa-do-codigo/`

| Arquivo | O que é | Pode editar? |
| --- | --- | --- |
| `index.html` | O mapa: uma página autossuficiente | Não. Refeito a cada montagem |
| `grafo.json` | Tudo o que o mapa mostra, como dados | Não. Refeito a cada montagem |
| `arquitetura.json` | As partes do app, os serviços externos, as ligações extras, os fluxos e o tour | **Sim** |
| `descricoes/*.json` | O nome e a descrição de cada arquivo e endpoint, um arquivo por parte | **Sim** |
| `plano.json` | Só em plantas: os arquivos, endpoints e telas planejados, quem pode usar cada endpoint, a stack, as suposições e as perguntas em aberto. Nomes e descrições ficam aqui em vez de `descricoes/` | **Sim** |
| `trabalho-recente.json` | O que acabou de ser feito, e por quê. Substituído a cada atualização | Raramente. A IA escreve |
| `fluxos-pedidos.json` | Fluxos pedidos pelo mapa | Só para apagar um |
| `servidor.mjs` | Serve o mapa localmente e responde às perguntas pela CLI do Claude Code ou pelo Codex | Não |
| `servidor-nucleo.mjs` | O núcleo do servidor, o mesmo que o quadro usa para servir o mapa | Não |
| `consulta.mjs` | Consulta o mapa pela linha de comando; o Claude, o Codex e o quadro também usam | Não |
| `artefato.html` | Uma cópia para abrir no app Claude, só se você pediu | Não |
| `<projeto>-mapa.html` | Uma cópia exportada, só se você exportou pelo Claude ou pelo Codex (o botão Exportar baixa o arquivo em vez disso) | Não |
| `.cache/` | A varredura, as fichas de descrição, o que mudou na última atualização (`mudancas.json`), o endereço do servidor em execução e, numa planta, as últimas 20 versões do plano para o **Desfazer** (`history/`) | Não. Pode apagar, mas aí o Desfazer não tem para onde voltar |
| `.gitignore` | Mantém a pasta inteira fora do git | Não |

### 9.2 Editar nomes e estrutura

Suas edições em `arquitetura.json` e `descricoes/` são mantidas em todas as atualizações. Você pode:

- renomear uma parte ou reescrever uma descrição;
- mudar arquivos de parte alterando os padrões em `paths`;
- acrescentar uma ligação que a varredura não viu;
- prender uma nota a um arquivo;
- acrescentar ou mudar fluxos e o tour.

Ou só peça ao Claude ou ao Codex ("troque 'Servidor principal' por 'API da loja' no mapa do código").

Uma planta se edita do mesmo jeito, por `plano.json` e `arquitetura.json`, ou pelo próprio mapa com **Alterar**. Os formatos estão nas referências do plugin: [`esquema.md`](../mapa/skills/mapa-do-codigo/referencias/esquema.md) (arquitetura e trabalho recente), [`planta.md`](../mapa/skills/mapa-do-codigo/referencias/planta.md) (plano), [`escolhendo-limites.md`](../mapa/skills/mapa-do-codigo/referencias/escolhendo-limites.md) (como dividir o código em partes) e o guia de estilo dos nomes e descrições, [`escrevendo-descricoes.md`](../mapa/skills/mapa-do-codigo/referencias/escrevendo-descricoes.md).

### 9.3 `CLAUDE.local.md`

No Claude Code, depois do primeiro mapa, o Claude pergunta se as próximas sessões do projeto devem usá-lo. Só se você aceitar, o plugin acrescenta uma seção curta e marcada nesse arquivo, dizendo às próximas sessões que o mapa existe e como consultá-lo. O `CLAUDE.local.md` é o arquivo de notas pessoais do projeto no Claude Code, carregado no início de cada sessão como o `CLAUDE.md`. O plugin:

- cria o arquivo se você não tiver um;
- só reescreve a própria seção, entre `<!-- mapa-do-codigo:inicio -->` e `<!-- mapa-do-codigo:fim -->`, e a mantém atual a cada atualização (uma seção antiga do Floorplan, entre `<!-- floorplan:start -->` e `<!-- floorplan:end -->`, é trocada pela nova);
- coloca o arquivo na lista de ignorados particular do seu clone, `.git/info/exclude`.

Para tirar, apague a seção. Para ela não voltar, coloque `<!-- mapa-do-codigo:desligado -->` em qualquer lugar do `CLAUDE.local.md`.

Uma planta não acrescenta seção, porque ainda não há código para consultar. O Claude oferece quando o mapa passa para o código de verdade. No Codex esse arquivo não é tocado: o Codex não tem um arquivo de notas pessoal fora do git (o `AGENTS.md` é compartilhado com a equipe).

### 9.4 Fora do git

- **`mapa-do-codigo/`** tem o próprio `.gitignore`, que ignora tudo na pasta, inclusive ele mesmo. O seu `.gitignore` não muda e a pasta nunca aparece no `git status`.
- **`CLAUDE.local.md`** fica em `.git/info/exclude`, a lista de ignorados de cada clone, que nunca é commitada. Se o projeto já ignora o arquivo, nada é acrescentado.

O mapa é pessoal de cada clone: quem da equipe instalar o plugin faz o seu. A exceção é o quadro, que mostra o mapa da pasta registrada do projeto a todos que podem ver o projeto (veja a [seção 7.4](#74-permissões)). Se uma pasta `mapa-do-codigo/` foi commitada antes, ignorá-la não tira os arquivos do git; a montagem mostra o comando que faz isso mantendo os arquivos no disco:

```bash
git rm -r --cached mapa-do-codigo
```

---

## 10. Privacidade e segurança

### 10.1 O que roda onde

| Parte | Onde roda | O que envia |
| --- | --- | --- |
| Varredura, montagem e atualizações | no seu computador (Node.js) | nada |
| Escrever nomes e descrições | o Claude ou o Codex, pela sua sessão | os arquivos que ele lê, como em qualquer outra tarefa |
| O mapa | o seu navegador | nada. O motor de layout e as fontes vêm dentro do arquivo, então funciona offline |
| O servidor do mapa (`servidor.mjs`) | no seu computador, ouvindo só em `127.0.0.1` | nada por conta própria |
| O mapa dentro do quadro | o servidor do quadro, com o login e as permissões dele | nada por conta própria |
| Perguntar (CLI do Claude Code) | uma sessão `claude -p` no computador, com a sua conta (no quadro, a de quem mantém o quadro) | a pergunta e os arquivos que o Claude decidir ler |
| Perguntar (Codex) | um `codex exec` no computador, com o seu login do ChatGPT, fora do seu histórico do Codex | a pergunta e os arquivos que o Codex decidir ler |
| Alterar uma planta pelo mapa | igual a perguntar; depois o servidor grava só os arquivos do plano | o pedido e os arquivos que a IA decidir ler |
| Perguntar (app Claude) | a sua conta no claude.ai | o mapa (nomes, descrições, estrutura), nunca o código-fonte. O Claude pergunta antes de publicar |
| Exportar uma cópia | no seu computador: o servidor monta um arquivo HTML | nada. Você decide quem recebe o arquivo. Ele leva o mapa, mais a Saúde ou o trabalho recente só se você marcar, e nunca o caminho da pasta, os endereços dos repositórios ou o código-fonte |

O plugin não tem analytics nem telemetria, não tem dependências para instalar nem scripts de instalação, e **não faz nenhuma chamada de rede por conta própria**. (O original tinha uma lista de espera opcional do "Floorplan Cloud"; ela foi removida nesta versão.) Os poucos links do mapa para documentação só abrem quando você clica.

### 10.2 O servidor local e o quadro

**Servidor autônomo (`node mapa-do-codigo/servidor.mjs`):**

- Ouve só em `127.0.0.1`, então outras máquinas da rede não o alcançam.
- Cada início cria um token aleatório, que só a página do mapa servida por ele recebe. Perguntar e salvar fluxos exigem esse token, e esses pedidos são recusados quando vêm de outro site.
- Só responde a `127.0.0.1` e `localhost` na própria porta, então um site que aponte o domínio dele para o seu computador (DNS rebinding) não consegue carregar o mapa nem o token.
- Para sozinho duas horas depois que a última aba fecha; `--stop` para na hora.

**Dentro do quadro (`/mapa/<id>/`):**

- Usa o login do painel: sem sessão, volta para a tela de entrada. Projetos privados continuam invisíveis para quem não é membro.
- Os pedidos que não são simples leituras (perguntar, fluxos, planta, exportar, criar tarefas) exigem a origem do próprio painel, como o resto da API. Os da API do mapa exigem também o token aleatório da página, como no servidor autônomo.
- As permissões da [seção 7.4](#74-permissões) são conferidas no servidor.
- A página só pode ser mostrada em iframe pelo próprio painel (`X-Frame-Options: SAMEORIGIN`).
- Se o quadro está aberto para a rede (veja "Usar em equipe" no [README](../README.md#usar-em-equipe)), os membros do projeto veem o mapa pela rede, com essas mesmas regras.

**A IA só lê:**

- No Claude Code, as perguntas rodam com ferramentas **somente leitura**: ler arquivos, buscar e o script de consulta do mapa. Não editam arquivos nem rodam outros comandos.
- No Codex, rodam no sandbox **somente leitura** do Codex.
- Numa planta, os pedidos de **Alterar** rodam do mesmo jeito. A IA responde com o plano atualizado, e o próprio servidor grava, depois de conferir, só `plano.json`, `arquitetura.json` e `trabalho-recente.json`, guardando as versões antigas para o Desfazer.

### 10.3 Segredos

A Saúde procura senhas, chaves de API e chaves privadas no código, e arquivos `.env` que iriam para o git. Quando acha um, registra só o arquivo, a linha, o tipo de segredo e uma pista mascarada, como "começa com “AKIA…”, 20 caracteres". **O valor do segredo nunca é guardado no mapa, impresso nem enviado a lugar nenhum**, e o Claude é instruído a nunca repeti-lo. Para saber o tipo de alguns tokens, a Saúde decodifica a parte do meio deles (base64) e assim pula os que são públicos por natureza; o token em si nunca é guardado nem mostrado.

A verificação é uma primeira passada útil, não uma auditoria de segurança.

### 10.4 O que o plugin faz no seu computador

Plugins do Claude Code e do Codex podem rodar código no seu computador, então vale perguntar. O plugin:

- **não tem hooks** (código que roda sozinho em eventos de toda sessão) **nem servidores MCP** (a ferramenta `code_map` é do MCP `tarefas` do quadro, não do plugin);
- **não tem dependências nem scripts de instalação**: nada vem do npm;
- **nunca baixa nada nem roda código da internet**: sem `eval`, sem carregar código em tempo de execução, sem conteúdo codificado escondido;
- **nunca muda o seu código**: grava só a pasta `mapa-do-codigo/` e, no Claude Code e só se você aceitar, a seção marcada do `CLAUDE.local.md`.

Os programas que ele roda:

| Programa | Quando | Para quê |
| --- | --- | --- |
| `git` | varredura | Só leitura: quais arquivos são versionados, o branch e o commit atuais, o que mudou desde o último mapa |
| `which` (ou `where`, no Windows) | ao iniciar o servidor do mapa | Achar a CLI do Claude Code ou do Codex |
| `claude` ou `codex` | quando você pergunta ao mapa | Responder, só lendo: `claude -p` limitado a ler arquivos e ao script de consulta, ou `codex exec --sandbox read-only` |
| `node` | o tempo todo | Rodar os próprios scripts do plugin |
| `open`, `xdg-open` ou `cmd /c start` | ao abrir o mapa | Abrir o endereço local do mapa no navegador |

Cada um é iniciado diretamente com seus argumentos, nunca como uma linha de comando interpretada por um shell (a exceção é o `cmd /c start` do Windows, que só recebe o endereço local do mapa). No Claude Code, enquanto o skill está em uso, ele pré-aprova um único tipo de comando: `node` rodando um dos próprios scripts, cada um pelo nome. O resto segue as suas permissões de sempre; o Codex segue as suas configurações de aprovação.

Algumas coisas que merecem explicação:

- **`assets/vendor/elk.bundled.js`** é um arquivo minificado de 1,6 MB: o motor de layout que arruma o mapa. É o [elkjs](https://github.com/kieler/elkjs) 0.9.3, byte a byte igual ao pacote oficial no npm.
- **Um `new Function`** no servidor carrega o código de consulta do mapa a partir do `consulta.mjs`, um arquivo que a própria montagem gravou no seu projeto. Nunca roda nada vindo da rede.

O teste [`mapa/test/supply-chain.test.mjs`](../mapa/test/supply-chain.test.mjs), que roda com `npm test`, falha se uma mudança acrescentar um hook, um servidor MCP, uma dependência ou um script de instalação; mandar uma requisição para fora do servidor do próprio mapa; iniciar um programa fora da tabela acima ou por um shell; usar `eval` ou esconder uma string codificada longa; pré-aprovar outro script; ou mudar o motor de layout embutido.

Fazer o mapa continua sendo o Claude ou o Codex lendo o seu código para descrevê-lo, e isso vai para a Anthropic ou para a OpenAI pela sua conta, como qualquer outra tarefa que você dá a eles.

---

## 11. Solução de problemas

### A barra de perguntas diz que precisa da CLI do Claude Code

O mapa está aberto sem um jeito de responder perguntas. Ou:

- instale a [CLI do Claude Code](https://code.claude.com/docs/en/overview), entre na conta e peça ao Claude para atualizar o mapa do código, ou rode `node mapa-do-codigo/servidor.mjs`;
- ou abra o mapa no app Claude: peça ao Claude para "publicar o mapa do código no app Claude". Lá as respostas vêm só do mapa.

### A CLI está instalada mas não é encontrada

O servidor procura `claude` no `PATH` e em `~/.local/bin`. Se ela está em outro lugar:

```bash
node mapa-do-codigo/servidor.mjs --claude /caminho/para/claude
```

### No quadro, a barra de perguntas não funciona

- **Você é visualizador** no projeto, ou tem uma conta visualizadora: perguntar exige permissão de edição (veja a [seção 7.4](#74-permissões)).
- **A CLI não é encontrada pelo serviço do quadro.** O quadro roda pelo launchd, que nem sempre tem o mesmo `PATH` do seu Terminal. Dentro do quadro, o mapa usa a mesma CLI do Claude que o chat do painel: `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude` ou a variável `CLAUDE_BIN` do serviço (`FLOORPLAN_CLAUDE`, se definida, tem prioridade; para o Codex, `FLOORPLAN_CODEX`). Se a sua está em outro lugar, defina o caminho e reinicie o quadro:

  ```bash
  launchctl setenv CLAUDE_BIN "$(command -v claude)"
  launchctl kickstart -k gui/$(id -u)/com.claude-tasks.dashboard
  ```

  Confira também se a CLI está logada (`claude` no Terminal → `/login`).
- **O quadro está no Docker:** a CLI do Claude Code e o Codex não existem no contêiner, então as perguntas não funcionam lá. O resto do mapa funciona, desde que a pasta do projeto esteja montada no contêiner no mesmo caminho.

### Codex: a barra de perguntas diz que precisa do Codex

O servidor procura `codex` no `PATH` e a CLI que vem com o app do Codex (no Mac e no Windows). Instale a [CLI do Codex](https://developers.openai.com/codex/cli) ou aponte o servidor para a sua:

```bash
node mapa-do-codigo/servidor.mjs --codex /caminho/para/codex
```

Se aparecer que o Codex não está logado, abra o app do Codex (ou rode `codex login`) e entre com o ChatGPT. Para escolher quem responde, use `--engine claude` ou `--engine codex`; `--model <nome>` escolhe o modelo (sem ele, valem as configurações do Claude Code ou do Codex). As variáveis de ambiente `FLOORPLAN_ENGINE`, `FLOORPLAN_MODEL`, `FLOORPLAN_CLAUDE` e `FLOORPLAN_CODEX` fazem o mesmo, inclusive para o mapa servido pelo quadro.

### Codex: o mapa não abriu, ou a barra parou depois que o Codex o abriu

O Codex roda comandos num sandbox, e o servidor do mapa precisa continuar rodando e alcançar a rede. Permita que o servidor rode fora do sandbox quando o Codex pedir, ou rode `node mapa-do-codigo/servidor.mjs` você mesmo, na pasta do projeto.

### `node` não é reconhecido

Instale o [Node.js](https://nodejs.org) 18 ou mais novo e abra uma sessão nova, para o Claude Code ou o Codex enxergarem.

### O Claude ou o Codex fica pedindo para rodar scripts `node`

No Claude Code, o plugin pré-aprova os próprios scripts enquanto está rodando, mas em algumas configurações ainda pode perguntar. Escolha a opção de sempre permitir neste projeto. O Codex pergunta conforme as suas configurações de aprovação; permitir os scripts `node` do plugin no projeto acaba com as perguntas.

### O skill não aparece

Plugins carregam quando a sessão começa, então abra uma sessão nova depois de instalar. Confira se está instalado e ativo:

```bash
claude plugin list
```

Pedidos simples como "faça o mapa do código" funcionam sem o comando de barra. Se quiser usá-lo, é `/mapa-do-codigo:mapa-do-codigo`. No Codex, confira **Plugins** no app ou rode `codex plugin list`, e abra uma conversa nova depois de instalar. Para chamar pelo nome, digite `$mapa-do-codigo`.

### A aba Mapa do código não aparece no quadro

A aba só existe em projetos com pasta no computador. Projetos criados pelo painel sem pasta não têm mapa. Se o projeto tem pasta mas a aba diz que ela não existe, o quadro está rodando em outro computador ou no Docker sem a pasta montada.

### A aba diz que ainda não há mapa, mas eu fiz um

O quadro procura `mapa-do-codigo/index.html` na pasta registrada do projeto (a raiz do repositório git). Se o mapa foi feito numa subpasta, ou numa pasta com vários repositórios acima dela, ele está em outro lugar. Peça o mapa na raiz do projeto e clique em **Conferir de novo**.

### Uma tarefa não aparece no cartão do arquivo

A tarefa precisa citar o caminho do arquivo no título ou na descrição, e estar aberta ou ter sido concluída nos últimos 14 dias. O selo do cartão conta só as abertas; as concluídas aparecem no painel lateral, em **Tarefas do quadro**. Só o nome do arquivo (sem pasta) liga apenas quando não há outro arquivo com o mesmo nome no mapa: nesse caso, escreva o caminho com a pasta. Confira também se **Filtros → Mostrar tarefas do quadro** está ligado.

### O mapa parece desatualizado

Peça ao Claude ou ao Codex para "atualizar o mapa do código". Uma aba já aberta se recarrega quando a atualização termina.

### A barra de perguntas não tem a chave Alterar

**Alterar** só aparece numa [planta](#5-planejar-o-que-ainda-não-existe-planta), aberta por um servidor (o do mapa ou o do quadro) com a CLI do Claude Code ou o Codex disponível. No quadro, também exige permissão de gestão no projeto. Um mapa de código de verdade não tem a chave: peça ao Claude Code ou ao Codex para mudar o código e depois atualize o mapa.

### Uma alteração na planta falhou, ou não gostei dela

Se o plano atualizado não passa nas conferências depois de uma segunda tentativa, nada é salvo e o mapa fica como estava; tente pedir de forma mais específica. Se a alteração passou mas não é o que você queria, aperte **Desfazer** no resumo dela, ou peça outra alteração. As versões anteriores ficam em `mapa-do-codigo/.cache/history/`.

### Falta uma ligação

O plugin acha a maioria das requisições e imports lendo o código, mas não todos, por exemplo requisições para um endereço que só existe numa configuração. Peça ao Claude para acrescentar a ligação que falta ao mapa: ela fica registrada em `arquitetura.json` e permanece em todas as atualizações.

### Um arquivo está na parte errada, ou em "Não atribuídos"

Peça ao Claude para movê-lo, ou edite os padrões em `paths` no `mapa-do-codigo/arquitetura.json` e peça uma atualização.

### "Já existe uma pasta mapa-do-codigo/ aqui e ela não é um mapa"

O projeto tem uma pasta própria chamada `mapa-do-codigo`, onde o plugin não grava. Renomeie a sua pasta, ou peça ao Claude para montar o mapa em outro lugar; os scripts de varredura e montagem aceitam `--out <pasta>`. (O quadro só encontra mapas em `mapa-do-codigo/`.)

### `git status` mostra arquivos em `mapa-do-codigo/`

Eles foram commitados antes de o plugin passar a ignorar a pasta. Tire-os do git mantendo os arquivos no disco:

```bash
git rm -r --cached mapa-do-codigo
```

### A porta 4378 está em uso

Nada a fazer. O servidor passa para a próxima porta livre, e o endereço que ele mostra, ou que o Claude te dá, é o certo.

### Parar o servidor em segundo plano

```bash
node mapa-do-codigo/servidor.mjs --stop
```

Ele também para sozinho duas horas depois que a última aba fecha. O mapa dentro do quadro não usa esse servidor.

---

## 12. Créditos e licenças

- **Floorplan** 0.6.0, de [Hayden Smith](https://github.com/haydenschmitty) ([github.com/haydenschmitty/floorplan](https://github.com/haydenschmitty/floorplan)), sob a licença MIT. O Mapa do código é uma tradução e adaptação dele: textos, mapa e scripts em português, nomes de arquivos em português, a lista de espera do "Floorplan Cloud" removida e a integração com o quadro acrescentada. A licença original está em [`mapa/LICENSE`](../mapa/LICENSE) e o aviso sobre a adaptação em [`mapa/AVISO.md`](../mapa/AVISO.md).
- **[elkjs](https://github.com/kieler/elkjs)** 0.9.3, o motor de layout, sob a Eclipse Public License 2.0 ([licença](../mapa/skills/mapa-do-codigo/assets/vendor/elkjs-LICENSE.md)).
- **Fontes Inter e JetBrains Mono**, sob a SIL Open Font License 1.1 ([Inter](../mapa/skills/mapa-do-codigo/assets/vendor/fonts/inter-LICENSE.txt), [JetBrains Mono](../mapa/skills/mapa-do-codigo/assets/vendor/fonts/jetbrains-mono-LICENSE.txt)).

O motor de layout e as fontes ficam em `mapa/skills/mapa-do-codigo/assets/vendor/`, com as licenças, e cada montagem os copia para dentro do mapa.
