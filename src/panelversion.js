// Versão do painel: um hash dos arquivos de public/. O servidor lê esses arquivos do disco a cada
// pedido, então o código novo vale na hora para quem abre a página, mas não para uma janela já aberta.
// Com esta versão, a janela percebe que ficou para trás e avisa quem está nela.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HIDDEN = /(^|[\\/])\./;

// Devolve uma função que informa a versão atual. Só confere o disco de vez em quando (maxAge, em ms) e
// só relê o conteúdo se o nome, o tamanho ou a data de algum arquivo mudou. Uma data diferente com o
// mesmo conteúdo não muda a versão: trocar de branch e voltar não gera aviso.
export function panelVersionReader(dir, { maxAge = 2000 } = {}) {
  let checkedAt = 0;
  let stamp = '';
  let version = '';
  return () => {
    if (Date.now() - checkedAt < maxAge) return version;
    checkedAt = Date.now();
    try {
      const files = readdirSync(dir, { recursive: true }).filter((name) => !HIDDEN.test(name)).sort()
        .map((name) => ({ name, info: statSync(join(dir, name)) }))
        .filter((file) => file.info.isFile());
      const now = files.map((file) => `${file.name}:${file.info.size}:${file.info.mtimeMs}`).join('\n');
      if (now === stamp) return version;
      const hash = createHash('sha1');
      for (const file of files) hash.update(`${file.name}\0`).update(readFileSync(join(dir, file.name)));
      version = hash.digest('hex').slice(0, 12);
      stamp = now;
    } catch {
      // Arquivo trocado no meio da leitura (um git checkout, por exemplo): confere de novo na próxima.
    }
    return version;
  };
}
