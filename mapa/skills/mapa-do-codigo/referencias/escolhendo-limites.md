# Escolhendo os limites

O quadro é útil quando cada card é algo que uma pessoa citaria numa conversa no quadro branco. É inútil quando só repete a árvore de pastas. Use estas regras práticas para chegar lá. Escreva os rótulos e summaries em português do Brasil.

## O quadro de cima (3–9 cards)

Pergunte: *quais são as coisas que vão para o ar ou têm dono próprio, e com o que elas falam?*

- **Vários repositórios.** Em geral, um card por coisa que vai para o ar (frontend, API, worker, um segundo app como um painel de administração ou um app de celular), mais as bibliotecas compartilhadas, mais os externos. O repositório nem sempre é a unidade: um repositório de backend pode ter uma API *e* um worker *e* um conector MCP, então dê a cada um o próprio card.
- **Monorepo** (`apps/*`, `packages/*`, `services/*`). Apps e serviços viram cards de cima. Agrupe os pacotes num card `Bibliotecas compartilhadas` com filhos, a menos que um pacote seja grande e central.
- **Um monólito só.** Use camadas ou domínios no nível de cima (`Camada web`, `Serviços de domínio`, `Dados`, `Tarefas`), ou os 4–8 maiores domínios se o código é organizado por funcionalidade. Escolha o que o código realmente segue.
- **Externos.** Acrescente o(s) banco(s) de dados e cada API de terceiros de que o código depende de fato. Use as listas PACOTES EXTERNOS e HOSTS EXTERNOS do resumo da varredura; `packages` e `hosts` nos nós externos os ligam automaticamente. Pule bibliotecas utilitárias (react, lodash, pytest). Elas são dependências, não arquitetura.
- **Testes, scripts, migrations.** Dê a eles cards próprios no nível de cima (`kind: test`, `script`, `data`) em vez de misturá-los ao serviço. Senão eles escondem a estrutura real de dependências: os testes importam tudo.

## Segundo nível (3–12 por card)

- Prefira **responsabilidade** a **tipo de arquivo**. "Pedidos", "Estoque" e "Login" são melhores que "routes", "services" e "models" quando o código é organizado assim. Mas se o código é mesmo em camadas (routes/ → services/ → models/), espelhe as camadas. Um quadro em camadas que mostra routes → services → models é honesto e legível.
- Vale criar um filho quando ele tem um propósito claro de uma frase e arquivos suficientes (umas 3 ou mais) ou importância (um cliente de API central) para fazer diferença.
- Árvores grandes de componentes de tela: agrupe por área (`produtos`, `pedidos`, `pagamento`) e mantenha um card `Kit de interface` para as peças compartilhadas (`components/ui`). O kit vai ter muitas ligações chegando. Isso está certo e é útil de ver.
- Não passe de três níveis de nós. O visualizador já dá os níveis de pasta, arquivo e símbolo abaixo dos seus nós.

## Cobrindo os arquivos

- Escreva globs largos nos pais (`backend/app/**`) e depois mais estreitos nos filhos. O casamento mais fundo vence, então você nunca precisa de `exclude` só para impedir que um pai pegue os arquivos de um filho.
- Depois do build, olhe os "não atribuídos, por pasta" e dê a cada pasta de tamanho razoável um lugar ou uma entrada em `ignore`.
- `ignore` é para o que não é o sistema: clientes gerados, cópias vendorizadas, fixtures de snapshot, despejos de dados avulsos. Não é para testes nem scripts, que ficam nos próprios cards.

## Summaries

Uma frase, sobre a responsabilidade, no vocabulário do próprio código e em português do Brasil. "Sincroniza o catálogo de produtos e o estoque com o Shopify" é melhor que "Contém serviços relacionados ao Shopify". Cite o framework só no nível de cima.

## Flows

Escolha as 1–3 coisas que o sistema existe para fazer (receber um pedido, sincronizar o estoque, rodar uma tarefa noturna). Trace cada uma pelo quadro em 3–7 passos, do usuário ou do gatilho até o efeito final. Confira se passos seguidos estão mesmo ligados por um import, um HTTP ou uma edge explícita; se não estiverem, acrescente a edge que falta. O flow deve deixar o caminho principal do sistema óbvio para quem o vê pela primeira vez.

## Conferências antes de terminar

- O quadro de cima, lido da esquerda para a direita, conta a história do sistema (telas → API → serviços → dados/externos)?
- Algum card está ligado a quase tudo? Ou é um kit compartilhado (tudo bem, dê o nome certo) ou é sinal de que o limite está errado.
- Há ligações que você não esperava, como o frontend importando código do backend, ou testes importados por código de produção? Conte ao usuário; costumam ser a descoberta mais valiosa.
