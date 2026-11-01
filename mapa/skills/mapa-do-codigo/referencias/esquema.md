# Esquema do arquitetura.json

`mapa-do-codigo/arquitetura.json` descreve a estrutura: subsistemas, módulos, serviços externos, flows. Nomes e descrições de cada arquivo e rota ficam em `mapa-do-codigo/descricoes/*.json` (veja [escrevendo-descricoes.md](escrevendo-descricoes.md)). Ficam separados para que agentes em paralelo possam escrevê-los sem conflito. O `build.mjs` confere os dois contra a varredura e aponta os problemas campo a campo.

As chaves do JSON ficam em inglês, como abaixo. Os valores que alguém vai ler (`project.summary`, `label`, `summary`, `details`, notas, títulos de flows e do tour) são escritos em português do Brasil.

Conteúdo: [Nível de cima](#nível-de-cima) · [nodes](#nodes) · [Regras de distribuição](#como-os-arquivos-são-distribuídos) · [edges](#edges) · [annotations](#annotations) · [flows](#flows) · [Trabalho recente](#trabalho-recente) · [Exemplo completo](#exemplo-completo)

## Nível de cima

| campo | tipo | obrigatório | significado |
|---|---|---|---|
| `$schema` | `"floorplan/architecture@1"` | não | marcador |
| `project` | objeto | sim | `name` (texto, obrigatório), `summary` (1–3 frases), `entrypoints` (caminhos de arquivo) |
| `nodes` | lista | sim | subsistemas e módulos. Veja abaixo |
| `edges` | lista | não | ligações que o scanner não enxerga |
| `annotations` | lista | não | notas presas a arquivos específicos |
| `flows` | lista | não | percursos guiados pelo quadro |
| `tour` | lista | não | o tour "Comece aqui" mostrado na primeira abertura: 3–8 paradas `{ "node": "<id do nó ou caminho do arquivo>", "title": "…", "note": "…" }`, em linguagem simples, na ordem em que alguém novo deveria ver. O primeiro flow é acrescentado automaticamente |
| `audience` | `"everyone"` \| `"developers"` | não | para quem os nomes e descrições são escritos. Padrão `"everyone"`: linguagem simples que um dono não técnico entende (o que a coisa faz pelo negócio, em palavras do dia a dia). `"developers"`: estilo técnico, para engenheiros |
| `include` | lista de textos | não | categorias de arquivo a mapear. Padrão `["code"]`. Outras: `config`, `docs` |
| `ignore` | lista de textos | não | globs de arquivos que ficam totalmente fora do quadro (código gerado, bibliotecas vendorizadas, fixtures) |

## nodes

Cada nó é um card no quadro. A hierarquia vem de `parent`. Um nó sem pai fica no quadro de cima.

| campo | tipo | significado |
|---|---|---|
| `id` | texto | único; letras, dígitos, `_ - .`. Convenção: com pontos, a partir do pai (`api.orders`) |
| `label` | texto | nome curto exibido ("API de pedidos") |
| `kind` | enum | `ui` `service` `worker` `library` `feature` `data` `config` `test` `script` `infra` `external` |
| `parent` | texto | id do nó que o contém |
| `summary` | texto | uma frase: do que ele é responsável |
| `details` | texto | notas mais longas, opcionais; linhas em branco separam parágrafos |
| `paths` | lista de textos | globs que reivindicam arquivos (veja abaixo) |
| `exclude` | lista de textos | globs que tiram arquivos de volta de `paths`. **Herdado por todos os descendentes**, por exemplo `"exclude": ["**/*.test.tsx"]` num nó de frontend mantém os testes que ficam junto do código fora de todos os filhos, para um nó de Testes separado pegá-los |
| `packages` | lista de textos | **nós externos:** nomes de pacote que este nó representa, por exemplo `"stripe"`, `"npm:@stripe/*"`, `"pypi:sqlalchemy"`. Imports deles viram ligações com este nó |
| `hosts` | lista de textos | **nós externos:** hosts chamados pelo código, por exemplo `"api.stripe.com"`, `"*.squareup.com"`. As chamadas viram ligações `http` |
| `tags` | lista de textos | livres, mostradas no painel |

Os tipos, em resumo:
- `ui`: frontends e apps
- `service`: um servidor que vai para o ar
- `worker`: tarefas em segundo plano e filas
- `library`: código compartilhado
- `feature`: uma fatia vertical dentro de um serviço ou de uma interface
- `data`: modelos, migrations, a camada do banco
- `config`
- `test`
- `script`: scripts avulsos e de operação
- `infra`: deploy, CI, infraestrutura como código
- `external`: bancos de dados e APIs de terceiros. Não têm arquivos.

### Sintaxe dos globs
- `**` casa qualquer número de pastas, `*` fica dentro de um trecho do caminho, `?` casa um caractere, `{a,b}` é alternativa.
- Um nome de pasta inteiro entre colchetes, como `[id]`, `[...slug]` ou `[[...slug]]` (Next.js, SvelteKit), casa aquela pasta literalmente: `app/orders/[id]/**`. Em outros lugares, `[abc]` casa um desses caracteres.
- Um padrão sem curinga também casa como pasta: `backend/app` equivale a `backend/app/**`.
- Os caminhos são relativos à raiz do código. Numa raiz com vários repositórios, começam pela pasta do repositório.

### Como os arquivos são distribuídos
Cada arquivo incluído vai para exatamente um nó:
1. Junte os nós cujos `paths` casam com o arquivo e cujo `exclude` não casa.
2. O nó **mais fundo** vence, então um filho ganha do pai. Dá para pôr um glob largo no pai (`web/**`) e outros mais estreitos nos filhos; os arquivos que nenhum filho pega ficam no pai.
3. Entre nós da mesma profundidade, vence o glob com o maior prefixo literal. Empates de verdade geram aviso.
4. Arquivos que nenhum nó pega vão para um card automático de **não atribuídos**. Mantenha abaixo de ~10%.

No visualizador, um nó com mais de ~24 arquivos próprios os agrupa em cards de pasta automaticamente, então você não precisa de um nó para cada pasta. Crie um nó quando ele significar algo.

## edges

Acrescente só o que a análise estática não acha. Imports (`import`) e chamadas HTTP casadas com rotas (`http`) já estão na varredura.

| campo | tipo | significado |
|---|---|---|
| `from`, `to` | texto | id de nó **ou** caminho de arquivo |
| `kind` | enum | `import` `call` `http` `rpc` `event` `queue` `data` `config` |
| `label` | texto | curto, por exemplo `"POST /orders"`, `"order.paid"`, `"lê/grava"` |
| `description` | texto | frase opcional, mostrada quando alguém clica na ligação |

Bons candidatos:
- serviço → banco de dados (`data`)
- quem publica → fila → quem consome (`queue` / `event`)
- webhooks chegando de terceiros (`http`, do nó externo para o handler)
- cron/agendador → tarefa (`call`)
- funções de segundo plano do Firebase (agendamentos, gatilhos de Firestore/Storage/Pub/Sub, da seção FUNÇÕES DO FIREBASE da varredura) → um nó `worker`; ligue a coleção ou o tópico que as dispara (`event`)
- chamadas por URLs base configuradas em variáveis de ambiente que o casamento não pegou (`http`)

## annotations

`{ "path": "<arquivo>", "note": "…", "tags": ["hotspot"] }` prende uma nota a um arquivo. O card do arquivo ganha um contorno de destaque. Use com moderação, para arquivos que fazem tudo, regras delicadas ou código obsoleto que ainda está em uso.

## flows

```json
{ "id": "checkout", "title": "Pagamento", "description": "opcional",
  "steps": [ { "node": "web.cart", "note": "A pessoa clica em Pagar" }, { "node": "api.orders", "note": "Cria o pedido" } ] }
```
- O `node` de cada passo é um id de nó ou um caminho de arquivo. Precisa haver pelo menos 2 passos.
- O visualizador vai até o quadro em que cada par de passos seguidos aparece e anima um sinal entre eles.
- Escreva as notas como a narração que alguém novo no código gostaria de ouvir.

## Trabalho recente

`mapa-do-codigo/trabalho-recente.json` é um arquivo à parte, reescrito em toda criação e atualização. Guarda o que acabou de ser trabalhado, explicado em relação ao que o usuário pediu. O visualizador dá a esses cards uma etiqueta verde de "Alterado"/"Novo", mostra "N alterados" nas partes que os contêm, acrescenta a `note` de cada um ao passar o mouse e lista as tarefas num botão **Trabalho recente** e no painel de visão geral.

```json
{
  "updatedAt": "2026-10-27T10:30:00Z",
  "tasks": [
    {
      "title": "Reembolsos na página do pedido",
      "request": "Deixar a equipe reembolsar um pedido direto da página dele",
      "summary": "A equipe agora pode reembolsar um pedido inteiro ou parte dele pela página do pedido. O dinheiro volta para o cartão do cliente pelo Stripe, e ele recebe um email. Reembolsos acima de R$ 500 precisam de um gerente.",
      "items": [
        { "ref": "shop-api/app/services/refunds.py", "change": "new", "note": "Novo: calcula quanto devolver, devolve pelo Stripe e registra no pedido. É o coração do que foi pedido." },
        { "ref": "POST /api/orders/<int:order_id>/refund", "change": "new", "note": "O pedido que o botão Reembolsar manda; confere o limite do gerente antes de qualquer reembolso." }
      ]
    }
  ]
}
```

| campo | significado |
|---|---|
| `tasks[].title` | 2–5 palavras, mostradas ao passar o mouse e como título do quadro |
| `tasks[].request` | o que o usuário pediu, nas palavras dele (encurtado). Aparece como "Você pediu: …" |
| `tasks[].summary` | 1–2 frases: o que foi feito para isso e em que pé está. Cite aqui o que foi apagado; arquivos apagados não estão no mapa |
| `items[].ref` | um caminho de arquivo, um id de nó ou `"MÉTODO /caminho"` exatamente como no mapa. Refs que não estão no mapa ficam de fora, com um aviso |
| `items[].change` | `"new"` ou `"changed"` (padrão) |
| `items[].note` | 1–2 frases simples: o que mudou neste card e como isso atende ao pedido |

`{ "tasks": [] }` limpa todos os destaques.

## Exemplo completo

Um repositório de frontend e um de backend lado a lado:

```json
{
  "$schema": "floorplan/architecture@1",
  "project": {
    "name": "Loja Acme",
    "summary": "Loja virtual em Next.js que fala com uma API em Flask por REST; Postgres guarda os dados e o Stripe recebe os pagamentos.",
    "entrypoints": ["shop-api/app.py", "shop-web/src/app/page.tsx"]
  },
  "ignore": ["shop-api/migrations/versions/**"],
  "nodes": [
    { "id": "web", "label": "Loja virtual", "kind": "ui", "summary": "As telas que os clientes usam para ver produtos e comprar.", "paths": ["shop-web/src"] },
    { "id": "web.pages", "parent": "web", "label": "Páginas", "kind": "feature", "paths": ["shop-web/src/app"] },
    { "id": "web.api", "parent": "web", "label": "Conexão com o servidor", "kind": "library", "summary": "O único lugar de onde as telas falam com o servidor.", "paths": ["shop-web/src/lib/api*"] },
    { "id": "api", "label": "Servidor da loja", "kind": "service", "summary": "O servidor principal: pedidos, produtos e pagamentos.", "paths": ["shop-api/app.py", "shop-api/app"] },
    { "id": "api.routes", "parent": "api", "label": "Pedidos que o servidor atende", "kind": "feature", "paths": ["shop-api/app/routes"] },
    { "id": "api.models", "parent": "api", "label": "Como os dados são guardados", "kind": "data", "paths": ["shop-api/app/models"] },
    { "id": "tests", "label": "Testes", "kind": "test", "paths": ["shop-api/tests", "shop-web/**/*.test.{ts,tsx}"] },
    { "id": "pg", "label": "Postgres", "kind": "external", "packages": ["pypi:sqlalchemy", "pypi:psycopg2"] },
    { "id": "stripe", "label": "Stripe", "kind": "external", "packages": ["stripe"], "hosts": ["api.stripe.com"] }
  ],
  "edges": [
    { "from": "stripe", "to": "api.routes", "kind": "http", "label": "webhooks", "description": "payment_intent.succeeded marca os pedidos como pagos." }
  ],
  "annotations": [
    { "path": "shop-api/app/routes/orders.py", "note": "Todas as mudanças de situação de um pedido ficam aqui.", "tags": ["hotspot"] }
  ],
  "flows": [
    { "id": "checkout", "title": "Pagamento", "steps": [
      { "node": "web.pages", "note": "A página do carrinho envia o pedido" },
      { "node": "web.api", "note": "POST /api/orders" },
      { "node": "api.routes", "note": "Confere e cria o pedido" },
      { "node": "stripe", "note": "Cria a cobrança no Stripe" }
    ]}
  ]
}
```
