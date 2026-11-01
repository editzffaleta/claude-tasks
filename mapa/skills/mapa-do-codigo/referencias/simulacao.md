# Simulação no Breakscale

O [Breakscale](https://breakscale.tech) (licença MIT, de xevrion) é um simulador de arquitetura. Ele monta o sistema com servidores, bancos, filas e caches, cada um com um número finito de vagas e uma fila. Depois aumenta o tráfego e mede o que acontece com cada pedido simulado: latência, ocupação, filas enchendo, pedidos recusados e falhando. Os números são medidos de verdade, mas só são tão bons quanto o modelo e as premissas.

Aqui você leva o sistema do mapa para o Breakscale, descobre onde ele quebra e entrega isso como gargalos que viram tarefas no quadro.

Conteúdo: [Quando usar](#quando-usar) · [Passo a passo](#passo-a-passo) · [O modelo](#o-modelo) · [Números do código](#números-do-código) · [Relatando](#relatando) · [Arquivos](#arquivos)

## Quando usar

Quando o usuário perguntar onde o sistema quebra, quanto tráfego ele aguenta, qual é o gargalo, ou pedir para simular no Breakscale. É preciso um mapa pronto (`mapa-do-codigo/grafo.json`). Se não houver, faça o mapa primeiro.

Não serve para prometer capacidade ("aguenta exatamente 3.200 usuários"). Serve para achar o elo fraco e comparar alternativas ("com cache na frente, o banco deixa de ser o gargalo").

## Passo a passo

1. **Rascunho.** `node ${CLAUDE_SKILL_DIR}/scripts/breakscale.mjs rascunho <raiz>` monta `mapa-do-codigo/simulacao-projeto.json` a partir do mapa. Ele lista o que entrou, as ligações e o que ficou de fora. Se o arquivo já existe, ele não sobrescreve. Edite o que está lá, ou use `--forcar` para começar do zero, e só se o usuário quiser.
2. **Confira o modelo** (veja [O modelo](#o-modelo)): o tráfego entra pelas origens certas? Falta alguma peça que o mapa não mostra (um balanceador, um cache, réplicas)? Sobra alguma?
3. **Troque os números** pelos do código (veja [Números do código](#números-do-código)) e atualize as `premissas`.
4. **Simule.** `node ${CLAUDE_SKILL_DIR}/scripts/breakscale.mjs simular <raiz>`. Na primeira vez o npx baixa o pacote `breakscale-mcp`, numa versão fixa, e o simulador roda neste computador. Esse comando nunca é pré-aprovado: o usuário aprova cada vez. Se o Breakscale recusar o modelo, a mensagem diz qual componente ou ligação está errado. Corrija e rode de novo. `--cenarios 1,2,5,10` troca os múltiplos do tráfego.
   - Só com `--remoto` o simulador roda no servidor do Breakscale (`mcp.breakscale.tech`). Aí o modelo sai deste computador: os nomes das peças, as ligações e os números, nunca o código. Use só se o usuário pedir, por exemplo quando o npx não estiver disponível.
5. **Sugestões.** Para cada gargalo, escreva em `sugestoes` do `simulacao-projeto.json` uma correção concreta, ligada ao código: `{ "pg": "Pôr o Redis na frente das leituras de produtos (api/produtos.js), que são 90% das consultas." }`. Rode `breakscale.mjs anotar` para levar as sugestões ao resultado sem simular de novo.
6. **Relate** (veja [Relatando](#relatando)).

Para testar uma alternativa ("e se tivesse um cache?"), mude o `simulacao-projeto.json`, rode `simular` de novo e compare os dois resultados para o usuário.

## O modelo

O `simulacao-projeto.json` usa o formato curto do Breakscale, com algumas chaves a mais para o quadro:

```json
{
  "$schema": "mapa/simulacao-projeto@1",
  "nome": "Loja",
  "cenarios": [1, 2, 5, 10],
  "nodes": [
    { "id": "origem-web", "kind": "client", "label": "Usuários do site", "config": { "rps": 40 } },
    { "id": "api", "kind": "service", "label": "Servidor da loja", "config": { "capacity": 16, "serviceMs": 35, "instances": 2 } },
    { "id": "pg", "kind": "db", "label": "Postgres", "config": { "capacity": 10 } }
  ],
  "edges": [{ "from": "origem-web", "to": "api" }, { "from": "api", "to": "pg" }],
  "premissas": [
    { "componente": "api", "texto": "16 pedidos ao mesmo tempo (UV_THREADPOOL_SIZE em .env.example) e 2 cópias (docker-compose.yml).", "origem": "código" },
    { "componente": "origem-web", "texto": "40 pedidos por segundo: estimativa a partir de 3 mil pedidos por dia no horário de pico.", "origem": "chute" }
  ],
  "deixadoDeFora": [{ "texto": "O envio de e-mails pelo SES ficou de fora: acontece em segundo plano e não segura o pedido." }],
  "sugestoes": {}
}
```

- **Os ids** do rascunho são os das partes do mapa. Mantenha: é assim que a tarefa de um gargalo aparece no cartão certo do mapa. Origens de tráfego ganham ids `origem-…`.
- **`kind`** é um dos 33 componentes do Breakscale: `client`, `lb`, `service`, `cache`, `db`, `queue`, `worker`, `replica`, `shard`, `autoscaler`, `region`, `cdn`, `ratelimiter`, `breaker`, `objectstore`, `searchindex`, `timeseriesdb`, `graphdb`, `coldstorage`, `vectordb`, `streambroker`, `pubsub`, `websocket`, `apigateway`, `sidecar`, `lambda`, `cron`, `bulkhead`, `retryqueue`, `transcoder`, `edgecompute`, `writebehind` e `loadshedder`. Se o pacote MCP do Breakscale estiver ligado na sessão, a ferramenta `read_me` dele lista as configurações de cada um.
- **Como o tráfego anda.** Uma origem (`client`) manda `rps` pedidos por segundo. `lb`, `region` e `bulkhead` mandam cada pedido por **uma** das ligações. Todos os outros componentes chamam **todas** as ligações a cada pedido e só respondem quando todas respondem. Por isso o rascunho não liga os serviços externos (Stripe, e-mail, a API de IA): se ligasse, todo pedido passaria por eles. Para um caminho que só alguns pedidos fazem, crie uma origem própria com o tráfego dele.
- **Cache** que só passa adiante o que não achou: ligue serviço → cache → banco (não serviço → cache e serviço → banco).
- **Fila:** quem publica → `queue` → `worker`. Um worker ligado a uma fila sempre a consome.
- **Sem posições.** Deixe sem `x` e `y`. O Breakscale organiza da esquerda para a direita.

## Números do código

Use os números que o código e a configuração dizem. Onde não dizem, deixe o padrão do Breakscale e marque como `chute` em vez de inventar um número que parece preciso.

| No código | No modelo |
|---|---|
| pool de conexões, threads, `max_connections`, workers do gunicorn/uvicorn/puma | `capacity` |
| réplicas, pods, processos, `instances` do PM2, `replicas` do compose/k8s | `instances` |
| tempo médio de resposta (logs, APM, um benchmark) | `serviceMs` |
| timeouts e novas tentativas **de quem chama** (axios, fetch, clientes HTTP) | `timeoutMs` e `retries` no componente que chama |
| limite de fila, backlog | `queueLimit` |
| taxa de acerto do cache (métricas) | `hitRate` (de 0 a 1) |
| tráfego real (métricas, logs, analytics) | `rps` de cada `client` |

A conta que diz se um componente aguenta: ele faz no máximo `capacity × instances × 1000 / serviceMs` pedidos por segundo.

Cada número trocado vira uma premissa com a origem (`"origem": "código"`, com arquivo e linha no texto). O que continuar padrão fica `"chute"`, com o motivo. O quadro mostra quantas premissas ainda são chute.

## Relatando

Em português simples, em 4–8 linhas:

- **onde quebra primeiro** e com quanto tráfego: "Com o dobro do tráfego de hoje, o banco fica 100% ocupado e 8% dos pedidos falham por esperar demais";
- **por quê**, em termos do código ("o pool tem 10 conexões e cada consulta de produtos leva 40 ms");
- **o que fazer**, as sugestões, da mais barata para a mais cara;
- **quais números foram chute** e o que mudaria se estivessem errados. Isso é obrigatório: um gargalo calculado em cima de um chute é uma pista, não uma conclusão;
- o link para abrir no Breakscale (o `LINK` da saída). Lá dá para arrastar o tráfego e derrubar peças para ver o que acontece. O modelo vai no link depois do `#`, que o navegador não envia a nenhum servidor.

### Projeto no quadro de tarefas

Os gargalos aparecem na aba **Mapa do código › Simulação** do projeto, cada um com **Criar tarefa** (uma tarefa por gargalo, sem duplicar). Ofereça criar as tarefas por lá, ou crie você mesmo, se o usuário pedir, com `add_tasks` (`project_path` = a raiz do código), depois de conferir com `list_tasks` que elas ainda não existem. Avise numa linha quais foram criadas.

A ferramenta `code_map` do MCP do quadro, com `action: "simulacao"`, mostra o último resultado em outras sessões.

## Arquivos

Tudo fica em `mapa-do-codigo/`, fora do git como o resto do mapa:

| arquivo | quem escreve | o que é |
|---|---|---|
| `simulacao-projeto.json` | o rascunho, depois você | o modelo, as premissas, o que ficou de fora e as sugestões |
| `simulacao.json` | `simular` e `anotar` | o resultado: cenários, ocupação de cada componente, gargalos |
| `simulacao.breakscale` | `simular` | o modelo completo, que abre em breakscale.tech (Settings › Open a file) e na extensão do VS Code |

Não edite o `simulacao.json` à mão: rode `simular` ou `anotar`.
