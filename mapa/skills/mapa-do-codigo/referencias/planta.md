# Plantas: o mapa de um sistema que ainda não foi construído

Uma planta é o mesmo mapa, desenhado a partir de um plano em vez de código. Alguém tem um PRD, uma especificação ou só uma descrição longa do que quer construir, e o mapa mostra cada peça de que ele vai precisar, como as peças se ligam, de que cada tela depende e o que ainda falta decidir.

Escreva em português do Brasil todo texto que alguém vai ler: nomes, descrições, `stack`, `assumptions`, `questions`, summaries, flows e tour. Caminhos, ids, métodos e URLs ficam como estão.

Você escreve dois arquivos em `mapa-do-codigo/`:
- `plano.json`: os arquivos, endpoints e ligações que o sistema teria (este arquivo).
- `arquitetura.json`: as partes, os serviços de fora, os flows e o tour, exatamente como num mapa de código ([esquema.md](esquema.md)).

O `plan.mjs` transforma o `plano.json` na varredura que o `build.mjs` espera, então tudo daí em diante funciona como com código de verdade. Os cards são desenhados com contorno tracejado e uma etiqueta **Planta**, a Saúde vira uma **revisão da planta**, e cada parte tem um botão **Construir isto com o Claude** (ou o Codex), com um pedido pronto para construí-la.

Conteúdo: [Planejando bem](#planejando-bem) · [plano.json](#planojson) · [Alterações pelo mapa](#alterações-pelo-mapa) · [O que a revisão confere](#o-que-a-revisão-da-planta-confere)

## Planejando bem

- **Planeje no nível de arquivos e endpoints**, não só de caixas. As telas, a revisão da planta e os pedidos de construção dependem disso. Um produto pequeno tem tipicamente 15–60 arquivos e 10–40 endpoints. Não planeje cada helper: um arquivo por página, por grupo de endpoints, por serviço de fora e por tipo de dado salvo está de bom tamanho. Onde a stack põe um handler por URL (`route.ts` do Next.js, `+server.ts` do SvelteKit), planeje assim; mais arquivos não tem problema.
- **Escolha uma stack sensata e comum**, a menos que o PRD diga qual, e liste em `stack`. Prefira o que alguém construindo sozinho com IA escolheria: um site em Next.js ou React, um servidor em Node ou Python, Postgres, Stripe, um serviço de email hospedado. Use caminhos reais e convencionais para essa stack (`web/app/checkout/page.tsx`, `api/src/routes/orders.ts`).
- **Cada tela que o PRD descreve é um arquivo com uma URL em `screen`.** Dê a cada tela `calls` com os endpoints que ela usa e `uses` com as partes de que ela é feita.
- **Todo endpoint recebe `access`**, e `who` quando só algumas pessoas com login podem usá-lo ("gerentes daquela unidade", "o dono da conta"). Decida a partir do PRD. Se o PRD não diz nada e isso importa, deixe sem (a revisão vai apontar) ou acrescente uma pergunta. Um endpoint que precisa ficar aberto a qualquer pessoa e altera dados (códigos de login, cadastro, compra sem conta) recebe `publicBecause`: por quê, e o que impede abuso.
- **Não invente requisitos.** Onde o PRD não diz e você teve de escolher, escreva a escolha em `assumptions`. Onde a resposta muda o que vai ser construído e você não pode escolher com razoabilidade, acrescente em `questions`, com as partes afetadas. Leve para `questions` toda pergunta em aberto que o PRD lista, a menos que o próprio PRD a resolva em outro ponto; se você planejou em torno da resposta mais provável, diga isso também em `assumptions`. Faça 2–3 perguntas ao usuário logo de início só se o PRD deixa algo fundamental em aberto (quem usa, web ou celular, se alguém faz login, se há dinheiro envolvido).
- **Serviços de fora e onde os dados ficam são nós `external`** no arquitetura.json (Stripe, o banco de dados, um serviço de email). Os arquivos chegam a eles por `services` e `data` no plano.json. Ponha `data` nos arquivos que falam direto com o banco (um helper do banco, ou cada arquivo de acesso a dados), não em todo arquivo que os usa: as Telas seguem os `uses` até eles.
- **Trabalho em segundo plano** (emails agendados, tarefas noturnas, workers de fila) ganha arquivos próprios e um nó `worker`.

## plano.json

```json
{
  "$schema": "floorplan/plan@1",
  "source": "docs/prd.md",
  "stack": ["Site em Next.js", "Servidor em Node.js + Express", "Postgres", "Stripe"],
  "assumptions": ["Funcionários e clientes usam o mesmo login, com os funcionários marcados como tal."],
  "questions": [{ "question": "Os clientes podem cancelar sem custo?", "about": ["POST /api/orders/:id/cancel"] }],
  "files": [ { "path": "web/app/checkout/page.tsx", "name": "Página de pagamento", "description": "…", "screen": "/checkout", "uses": ["web/lib/api.ts"], "calls": ["POST /api/orders"] } ],
  "endpoints": [ { "method": "POST", "path": "/api/orders", "file": "api/src/routes/orders.ts", "name": "Fazer um pedido", "description": "…", "access": "signed-in" } ]
}
```

| campo | significado |
|---|---|
| `source` | de onde veio o plano: o caminho do PRD no projeto, ou umas poucas palavras como "uma descrição no chat" |
| `stack` | as escolhas de tecnologia, em palavras simples |
| `assumptions` | escolhas que você fez onde o PRD não dizia. Aparecem na visão geral do mapa |
| `questions` | `{ question, about }`: decisões que o PRD deixa em aberto. `about` lista ids de nós, caminhos de arquivo ou `"MÉTODO /caminho"`. Cada uma aparece na revisão da planta até ser respondida e retirada |
| `files` | cada arquivo planejado (veja abaixo) |
| `endpoints` | cada endpoint planejado (veja abaixo) |

**files[]**

| campo | significado |
|---|---|
| `path` | onde ele ficaria, relativo à pasta do projeto. Obrigatório, único |
| `name`, `description` | um nome humano e uma frase simples, escritos como a descrição de um código real ([escrevendo-descricoes.md](escrevendo-descricoes.md)) |
| `screen` | para uma página que as pessoas abrem: a URL dela (`/checkout`, `/orders/:id`). Faz dela uma tela em **Telas** |
| `uses` | outros arquivos planejados de que ele é feito ou que chama direto (viram ligações "usa") |
| `calls` | endpoints que ele chama, como `"MÉTODO /caminho"`, exatamente como em `endpoints` |
| `services` | ids de nós `external` com que ele fala (Stripe, um serviço de email) |
| `data` | ids dos nós onde ficam os dados que ele lê ou grava (normalmente o banco de dados) |

**endpoints[]**

| campo | significado |
|---|---|
| `method` | GET, POST, PUT, PATCH, DELETE, ou CALL para uma função chamável (por exemplo `onCall` do Firebase) |
| `path` | a URL, começando com `/`. Use `:nome` para as partes que variam (`/api/orders/:id`) |
| `file` | o arquivo planejado que o atende. Obrigatório |
| `name`, `description` | como nos arquivos |
| `access` | quem pode usá-lo: `public` (qualquer pessoa), `signed-in` (com login), `team` (só quem opera o serviço, para as próprias páginas de administração, não os usuários do app), `webhook` (o serviço de outra empresa, que precisa provar quem é) ou `internal` (só os seus próprios serviços) |
| `who` | com `signed-in`: quais pessoas com login, em poucas palavras ("gerentes daquela unidade", "o dono da conta"). Deixe sem quando qualquer pessoa com login pode |
| `publicBecause` | com `public`: por que ele precisa ficar aberto, e o que limita o abuso ("o login precisa funcionar antes de alguém estar logado; 5 códigos por número por hora"). A revisão da planta para de apontar um endpoint aberto que tenha isso |

Os globs de `paths` dos nós no arquitetura.json distribuem os arquivos planejados entre as partes, como no código. Mire em nenhum arquivo não atribuído. Nomes de pasta entre colchetes (`app/orders/[id]/**`) casam literalmente.

O "chamadas a endpoints planejados" do plan.mjs conta cada chamada; as ligações "http" do build contam cada ligação de quem chama para um arquivo, mais as ligações com serviços de fora, então os dois números são diferentes.

## Alterações pelo mapa

Quando o mapa está aberto pelo servidor dele (open.mjs) ou pela aba **Mapa** do quadro de tarefas, a barra de perguntas tem uma chave **Perguntar / Alterar**. Um pedido de alteração ("planeje também os reembolsos", "tire a página de administração") vai para o mesmo agente, que só lê. Ele responde com o plano.json e o arquitetura.json completos e atualizados, e o servidor confere os dois com o plan.mjs e o build.mjs. Se as verificações falharem, ou se arquivos novos não couberem em nenhuma parte, ele manda os problemas de volta uma vez. Depois salva os arquivos, redesenha o mapa (as abas abertas recarregam) e destaca os cards novos e alterados como trabalho recente, com **Desfazer**. Os arquivos substituídos ficam guardados em `mapa-do-codigo/.cache/history/`. Cada item da revisão da planta tem **Resolver no mapa**, que põe um pedido pronto no modo Alterar: o pedido de uma pergunta em aberto termina com "Minha resposta:" para a pessoa completar, e o agente então retira a pergunta e incorpora a resposta ao plano. No quadro de tarefas, alterar a planta é só para quem gerencia o projeto. Alterações que você faz à mão ou por esta skill funcionam do mesmo jeito: edite os arquivos e rode o refresh.mjs.

## O que a revisão da planta confere

- endpoints que alteram dados e estão abertos a qualquer pessoa, a menos que `publicBecause` explique por quê;
- endpoints sem `access` decidido;
- cada pergunta em aberto, apontando as partes que ela afeta;
- endpoints que nenhuma tela ou serviço planejado chama;
- arquivos planejados que não se ligam a nada.

Cada item tem **Resolver no mapa** quando o mapa está sendo servido (veja acima) e, fora disso, **Resolver com o Claude/Codex**, um pedido para colar no agente.
