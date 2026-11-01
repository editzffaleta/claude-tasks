// Faz o papel do `claude` nos testes: responde a --version e, com -p, registra os argumentos e o prompt em
// $FAKE_LOG e imprime os eventos stream-json que uma execução de verdade imprimiria.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.0.0 (Claude Code, test)'); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, input }) + '\n');
  const out = (ev) => console.log(JSON.stringify(ev));
  out({ type: 'system', subtype: 'init', session_id: 'test-session' });
  // uma alteração de planta: responde com a próxima resposta de $FAKE_CHANGES (uma lista JSON), uma por execução
  const schema = args[args.indexOf('--json-schema') + 1] || '';
  if (process.env.FAKE_CHANGES && schema.includes('"architecture"')) {
    const replies = JSON.parse(fs.readFileSync(process.env.FAKE_CHANGES, 'utf8'));
    const counter = process.env.FAKE_CHANGES + '.n';
    const n = fs.existsSync(counter) ? +fs.readFileSync(counter, 'utf8') : 0;
    fs.writeFileSync(counter, String(n + 1));
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'mapa-do-codigo/plano.json' } }] } });
    out({ type: 'result', subtype: 'success', is_error: false, session_id: 'test-session', structured_output: replies[Math.min(n, replies.length - 1)] });
    return;
  }
  // uma pergunta que demora: só termina quando alguém a cancela (o processo é encerrado)
  if (input.includes('DEMORADA')) {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node mapa-do-codigo/consulta.mjs buscar "reembolso"' } }] } });
    setInterval(() => {}, 1000);
    return;
  }
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node mapa-do-codigo/consulta.mjs overview' } }] } });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'shop-api/routes/orders.js' } }] } });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: 'test-session', structured_output: {
    title: 'Reembolsos', answer: 'Os reembolsos passam por [[f:shop-api/routes/orders.js]].',
    items: [{ id: 'f:shop-api/routes/orders.js', note: 'Tem o endpoint de reembolso.' }],
  } });
});
