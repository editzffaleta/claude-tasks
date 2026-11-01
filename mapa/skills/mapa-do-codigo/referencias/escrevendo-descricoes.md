# Escrevendo nomes e descrições

Cada card do mapa mostra um **nome** e uma **descrição**. O caminho do arquivo e o da rota continuam aparecendo, mas em letra pequena embaixo. O objetivo é que alguém que nunca viu o código consiga ler o quadro como um diagrama do sistema.

Este guia cobre os nomes e descrições em `descricoes/*.json` e os `label` / `summary` dos nós e o `project.summary` no `arquitetura.json`.

**Sempre em português do Brasil**, natural e direto, mesmo quando o código, os comentários e os nomes dos arquivos estão em inglês. Nomes de produtos (Stripe, Shopify, Postgres) ficam como são. Termos técnicos sem tradução consagrada (endpoint, frontend, backend, webhook, commit) podem aparecer quando o público é de desenvolvedores; para `"everyone"`, prefira a expressão simples da tabela abaixo.

## Para quem você escreve: `audience`

O `arquitetura.json` tem um `"audience"` opcional no nível de cima. O cabeçalho de cada ficha repete o valor.

- **`"everyone"` (padrão).** Pense que quem lê é o dono do app, não um engenheiro. Muitas vezes ele o construiu com IA e não sabe como funciona por dentro. Escreva em **linguagem simples**: o que a coisa faz pelo negócio ou pelos usuários, em palavras do dia a dia. Seja específico e correto. Veja [Linguagem simples](#linguagem-simples) abaixo.
- **`"developers"`.** Quem lê é um engenheiro chegando ao código. Citar frameworks, padrões e mecanismos é bom e muitas vezes útil ("blueprint do Flask", "modelo do SQLAlchemy", "consumidor de Pub/Sub").

Use `"developers"` só quando o usuário pedir ou quando o mapa for claramente para um time de engenharia (uma biblioteca, um SDK, código de infraestrutura). Na dúvida, use `"everyone"`.

## Onde ficam

O `describe.mjs` grava uma ficha por módulo (`mapa-do-codigo/.cache/worksheets/<chave>.md`) e um esqueleto correspondente (`mapa-do-codigo/descricoes/<chave>.json`):

```json
{
  "files": {
    "api/app/services/inventory_bulk_service.py": { "name": "Atualização de estoque em lote", "description": "Aplica em segundo plano as mudanças de estoque de uma planilha enviada, conferindo cada linha antes de mudar qualquer coisa." }
  },
  "routes": {
    "GET /api/products/<int:product_id>/activity": { "name": "Histórico do produto", "description": "Mostra quem mudou um produto e quando, do mais recente para o mais antigo." }
  }
}
```

Preencha cada `description` e melhore cada `name`. **Não mude, acrescente nem tire chaves.** As chaves são como o `build.mjs` casa as entradas com os arquivos e rotas. Mantenha o JSON válido.

## Nomes

- 2–5 palavras, só com a primeira letra maiúscula, dizendo o que a coisa *é* ou *faz* nas palavras do próprio negócio. Curtos e concretos: "App da equipe", "Servidor principal", "Vale-presentes", "Reembolsos".
- Não repita só o nome do arquivo. `inventory_bulk_service.py` vira "Atualização de estoque em lote", não "Serviço de inventário em lote". `page.tsx` em `dashboard/products/` vira "Página de produtos".
- Componentes de tela ganham o nome que um usuário reconheceria: "Editor de fotos do produto", "Tabela de regras de desconto".
- Testes: "Testes de <assunto>", por exemplo "Testes da atualização de estoque em lote".
- Migrations e scripts dizem o que fazem: "Guarda o saldo dos vale-presentes", "Liga clientes antigos ao Stripe".
- Rotas recebem o nome do ponto de vista de quem chama: "Histórico do produto", "Marcar pedidos como enviados", "Avisos de pagamento do Stripe".
- Nomes de produtos ficam como são (Stripe, Shopify, Postgres, SendGrid). As pessoas os conhecem, e o glossário do visualizador explica os técnicos.

## Descrições

- **Uma frase, de preferência com menos de 140 caracteres**, no presente, começando por um verbo: "Guarda…", "Mostra…", "Envia…", "Confere…".
- Diga do que a coisa é responsável e o que tiver de notável: um efeito colateral (muda preços no Shopify, manda email ao cliente), uma restrição (só para a equipe, pode rodar de novo sem problema) ou um papel (o único lugar onde X é decidido).
- Use substantivos concretos do negócio: "vale-presente", "lista de separação", "anúncio no Shopify", não "dados", "itens", "coisas".
- Não escreva "Este arquivo…", não hesite e não repita o nome.
- Nas rotas, descreva o efeito, não a mecânica do HTTP. "Marca um pedido como enviado e manda ao cliente o link de rastreio" é melhor que "Endpoint POST para envio".

## Linguagem simples

O público padrão é `"everyone"`. Escreva como se explicasse o app ao dono num café: ele conhece o negócio de cor, mas não o código.

**Você não precisa carregar a identidade técnica.** O caminho real aparece embaixo de cada card, e os cards de endpoint mostram o método e a URL (`POST /api/orders/<id>/ship`). O "Mostrar detalhes técnicos" do visualizador revela exports, contagem de linhas e termos de desenvolvedor. Então a descrição pode dizer só para que a coisa *serve*.

### Regras

1. **Comece pelo trabalho, não pelo mecanismo.** O que ela faz pela equipe, pelos clientes ou pelo negócio? "Recebe pagamentos com cartão no checkout", não "Wrapper da API de Payments do Stripe".
2. **Palavras do dia a dia.** Troque o jargão pela expressão simples da tabela abaixo. Se uma palavra técnica é mesmo a mais clara ("banco de dados", "login"), pode usar. O visualizador sublinha termos comuns e explica ao passar o mouse.
3. **Continue específico.** Simples não quer dizer vago. "Cuida dos pedidos" é simples *e* inútil. "Segura o estoque de um pedido online enquanto o pagamento é conferido, depois libera ou despacha" é simples e diz alguma coisa.
4. **Dê nome aos serviços de fora.** "Manda os preços novos para o Shopify e a Amazon" é melhor que "Sincroniza com canais externos".
5. **Sem nomes de frameworks ou bibliotecas nas descrições** (Flask, SQLAlchemy, React, Radix, Pydantic…), a menos que a coisa exista *por causa* daquela ferramenta. Os rótulos podem manter o nome de um produto que o dono escolheu e conhece (por exemplo "Stripe", "Google Cloud").
6. **Nada de contagem de código, nomes de arquivo ou identificadores** ("~6,7 mil linhas", "product_routes.py", `ApiClient`) nos summaries. Isso vai em `annotations` ou já aparece em outro lugar.
7. **Avisos em termos simples.** "Roda à mão contra os dados de verdade; confira duas vezes antes de usar" em vez de "script de produção não idempotente".

### Jargão → simples

| Em vez de | Diga |
|---|---|
| API | o jeito de programas conversarem; para a sua, "o servidor principal" (por exemplo "pede ao Shippo os valores de frete") |
| endpoint, rota (backend) | um pedido que o app pode receber (por exemplo "o pedido que marca um pedido como enviado") |
| page, rota (frontend) | uma tela / uma página |
| webhook | um aviso que outro serviço manda para o seu app quando algo acontece ("o Stripe avisa que um pagamento foi aprovado") |
| REST, HTTP, GET/POST | (deixe de fora; o método e a URL já estão no card) |
| frontend / client | o app que as pessoas usam / as telas |
| backend / server / service | o servidor principal, a parte que faz o trabalho por trás das telas |
| monólito | um servidor principal que faz tudo |
| blueprint, router, controller | um grupo de pedidos relacionados (por exemplo "os pedidos sobre encomendas") |
| middleware | uma checagem por que todo pedido passa (por exemplo "confere se você fez login") |
| modelo do ORM, schema, entidade | como um tipo de registro é guardado (por exemplo "como um pedido é guardado") |
| tabela, linha | uma lista de registros / um registro |
| query | uma consulta / uma busca nos registros |
| banco de dados (Postgres, MySQL, RDS, Cloud SQL) | o banco de dados, onde ficam todos os registros |
| migration | uma mudança no jeito de guardar os registros (por exemplo "cria um lugar para guardar o número dos vale-presentes") |
| seed, fixture | dados de exemplo para testes |
| worker, background job | uma tarefa que roda sozinha em segundo plano |
| fila, outbox, Pub/Sub, message bus | uma fila de tarefas / um jeito de passar trabalho para as tarefas em segundo plano |
| cron, agendador, tarefa agendada | roda sozinho num horário fixo (por exemplo "toda noite às 2h") |
| cache, snapshot | uma cópia guardada para as coisas carregarem mais rápido |
| SDK, biblioteca cliente, cliente de API | código pronto para falar com um serviço (por exemplo "fala com o Stripe") |
| integração, sync | mantém X e Y em dia / copia as mudanças entre X e Y |
| variável de ambiente, config | configurações (por exemplo "qual loja e qual senha usar") |
| secret, API key, token | uma senha para um serviço / um passe de acesso |
| auth, autenticação | login |
| autorização, papéis, permissões, RBAC | quem pode fazer o quê |
| sessão | continuar com o login feito |
| hook, context, provider (React) | lógica compartilhada entre telas / mantém as telas em dia |
| componente, UI kit, primitivos | uma peça das telas (botão, tabela, janela) |
| state | o que a tela está lembrando no momento |
| deploy, CI/CD | colocar uma versão nova no ar |
| container, Docker, Cloud Run, serverless | onde o servidor roda na nuvem |
| bucket de armazenamento, S3, GCS, blob | arquivos guardados na nuvem (imagens, uploads, exportações) |
| CDN | uma rede rápida de entrega de imagens e arquivos |
| idempotente | pode rodar duas vezes sem problema |
| rate limit | um limite de quantas vezes algo pode ser pedido |
| reconciliar | compara dois registros da mesma coisa e corrige as diferenças |
| refatoração, dívida técnica | (deixe de fora) |
| servidor MCP | uma conexão que deixa assistentes de IA (como o Claude) consultarem o seu app |
| testes unitários, suíte de testes | conferências automáticas de que o código continua funcionando |

### Exemplos

**Módulos / subsistemas (`summary` no `arquitetura.json`)**

| | |
|---|---|
| ✗ | "Monólito Flask com blueprints de rotas sobre uma camada de serviços crescente e modelos SQLAlchemy." |
| ✓ | "O servidor principal: a loja e o app de administração falam com ele, e ele mantém estoque, preços, pedidos e vale-presentes em dia entre o Shopify, o Stripe e o depósito." |
| ✗ | "Primitivos baseados em Radix (components/ui) e o shell do dashboard." |
| ✓ | "As peças compartilhadas de todas as telas: botões, tabelas, janelas, e o menu e a moldura em volta do app da equipe." |
| ✗ | "Workers de longa duração no Cloud Run: inventário em lote, preços, emails de carrinho abandonado, reconciliação do Stripe." |
| ✓ | "Tarefas que rodam sozinhas em segundo plano ou em horário fixo: grandes envios de estoque, mudanças de preço, emails de carrinho abandonado e a conferência noturna dos repasses do Stripe." |

**Arquivos (`descricoes/*.json`)**

| | |
|---|---|
| ✗ | nome "Serviço de vale-presente do Stripe", "Encapsula a API de saldo de cliente do Stripe para projeção do razão." |
| ✓ | nome "Saldo dos vale-presentes", "Mantém o saldo de vale-presente de cada cliente no Stripe igual ao saldo que a loja mostra para ele." |
| ✗ | nome "Contexto useAuth", "Provider de contexto React que expõe o estado de autenticação e a renovação do token." |
| ✓ | nome "Login da equipe", "Lembra quem da equipe fez login, mantém a pessoa conectada e esconde o painel de todo mundo mais." |
| ✗ | nome "Trava de pedido", "Advisory lock do Postgres pela chave do id do pedido no Shopify." |
| ✓ | nome "Um pedido de cada vez", "Impede que o mesmo pedido online seja processado duas vezes quando o Shopify manda avisos repetidos." |

**Rotas (endpoints)**

| | |
|---|---|
| ✗ | nome "POST ship", "Endpoint POST que muda um pedido para enviado." |
| ✓ | nome "Marcar pedido como enviado", "Marca um pedido como enviado e manda ao cliente o link de rastreio." |
| ✗ | nome "Webhook do Stripe", "Recebe e confere a assinatura dos payloads de webhook do Stripe." |
| ✓ | nome "Avisos do Stripe", "O Stripe chama isto quando um pagamento, reembolso ou contestação muda; confere se o aviso é autêntico e o põe na fila." |

Para `"developers"`, a coluna ✗ fica mais perto do certo (tirando o enchimento). No resto, as mesmas regras: uma frase, começando pelo verbo, específica, em português do Brasil.

## Como trabalhar

1. Leia a ficha. Ela lista as definições, docstrings, o que cada arquivo usa e o que o usa, e o handler de cada rota. Isso basta para a maioria dos arquivos.
2. Abra o arquivo (as primeiras ~80 linhas, ou o handler específico) só quando o resumo deixar o propósito obscuro. Nomes genéricos (`utils.py`, `index.ts`, `common.py`) e arquivos grandes costumam precisar de uma olhada.
3. Escreva o JSON de uma vez por ficha, no estilo que a linha `Público:` da ficha pede.
4. Seja consistente dentro de um módulo: arquivos irmãos devem soar como um conjunto.

## Nível de qualidade

Uma boa descrição permite escolher o arquivo certo para abrir sem abrir os outros. Se dois irmãos acabarem com descrições quase iguais, descubra o que de fato os diferencia e diga isso. Para `"everyone"`, confira também: o dono entenderia cada palavra sem perguntar?
