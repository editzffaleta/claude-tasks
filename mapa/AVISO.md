# Aviso: de onde vem o Mapa do código

O **Mapa do código** (`mapa-do-codigo`) é uma versão traduzida e adaptada do [Floorplan](https://github.com/haydenschmitty/floorplan) 0.6.0, de Hayden Smith, publicado sob a licença MIT. O texto original da licença está, sem alterações, em [LICENSE](LICENSE), e vale para todo o código que veio do Floorplan e para as mudanças feitas aqui.

Copyright (c) 2026 Hayden Smith. Mudanças para o quadro de tarefas claude-tasks distribuídas sob a mesma licença MIT.

## O que mudou em relação ao Floorplan

- **Tudo em português do Brasil.** O mapa, as mensagens dos scripts e do servidor, a skill (`SKILL.md`), as referências em `referencias/`, o recado no `CLAUDE.local.md` e as instruções mandadas ao `claude -p` e ao `codex exec`, que pedem as respostas em português do Brasil.
- **Nomes novos.** O plugin e a skill se chamam `mapa-do-codigo`, e a pasta no projeto passou de `floorplan/` para `mapa-do-codigo/`, com arquivos em português: `arquitetura.json`, `descricoes/`, `grafo.json`, `plano.json`, `trabalho-recente.json`, `fluxos-pedidos.json`, `servidor.mjs`, `servidor-nucleo.mjs`, `consulta.mjs` e `artefato.html`. As chaves dos JSON e os nomes internos da página (`window.FLOORPLAN`, `window.FLOORPLAN_SERVER`, o cabeçalho `x-floorplan-token`) continuam os mesmos.
- **Sem o Floorplan Cloud.** A lista de espera e tudo o que falava com ela foram retirados. O plugin não faz nenhum pedido para fora deste computador, a não ser na simulação no Breakscale, descrita abaixo, e só quando a pessoa pede.
- **Servidor dividido em núcleo e linha de comando.** `servidor-nucleo.mjs` faz o trabalho (perguntas, fluxos, alterações de planta com Desfazer, exportação, recarga ao vivo) e `servidor.mjs` é o servidor local que escuta só em 127.0.0.1. O quadro de tarefas monta o mesmo núcleo em `/mapa/<projeto>/`, com as permissões de cada pessoa no projeto.
- **Integração com o quadro de tarefas.** A aba **Mapa do código** de cada projeto mostra o mapa, e os problemas da Saúde podem virar tarefas no quadro.
- **Consulta com comandos em português.** `consulta.mjs` aceita `buscar`, `mostrar`, `caminho` e `visao-geral`, além dos originais `find`, `show`, `path` e `overview`.

## Simulação no Breakscale (opcional)

`scripts/breakscale.mjs` leva o sistema do mapa para o [Breakscale](https://github.com/workersio/breakscale) (licença MIT, de xevrion), um simulador de arquitetura, e grava onde o sistema quebra. Nenhum código do Breakscale vem dentro do plugin. É a única parte que sai das promessas acima, e por isso:

- só roda quando a pessoa pede, e nunca entra na lista de comandos pré-aprovados da skill: o Claude Code pede aprovação a cada vez;
- por padrão roda o simulador **neste computador**, pelo `npx -y breakscale-mcp@0.1.1 --stdio`. Isso baixa do npm o pacote oficial do Breakscale, numa versão fixa, e o executa, sem shell;
- com `--remoto`, usa o servidor hospedado do Breakscale (`https://mcp.breakscale.tech/mcp`). Aí o modelo sai deste computador: os nomes das peças, as ligações e os números, nunca o código;
- a leitura do resultado segue o texto que essa versão do pacote escreve. Trocar a versão é uma mudança deliberada, conferida em `test/supply-chain.test.mjs`.

## Componentes de terceiros incluídos

Ficam em `skills/mapa-do-codigo/assets/vendor/`, sem alterações, com as licenças ao lado:

| Componente | Para que serve | Licença | Arquivo da licença |
|---|---|---|---|
| [elkjs](https://github.com/kieler/elkjs) 0.9.3 (`elk.bundled.js`, igual byte a byte ao publicado no npm) | o motor de layout que posiciona os cards do mapa | Eclipse Public License 2.0 (EPL-2.0) | `vendor/elkjs-LICENSE.md` |
| [Inter](https://github.com/rsms/inter) | a fonte do texto do mapa | SIL Open Font License 1.1 (OFL-1.1) | `vendor/fonts/inter-LICENSE.txt` |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | a fonte dos caminhos e do código | SIL Open Font License 1.1 (OFL-1.1) | `vendor/fonts/jetbrains-mono-LICENSE.txt` |

O build embute esses arquivos na página do mapa (`index.html`) para ela funcionar offline. O código-fonte do elkjs está disponível no repositório dele e no pacote `elkjs` do npm, como pede a EPL-2.0.
