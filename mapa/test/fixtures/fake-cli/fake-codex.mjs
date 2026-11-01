// Faz o papel do `codex` nos testes: responde a --version e, com exec, registra o que recebeu (argumentos,
// prompt, schema da resposta) em $FAKE_LOG e imprime os eventos JSONL que uma execução de verdade imprimiria.
// Um prompt com "SIGNED-OUT" falha do jeito que o Codex falha quando ninguém fez login.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.0.0-test'); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const schemaFile = args[args.indexOf('--output-schema') + 1];
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, input, schema: JSON.parse(fs.readFileSync(schemaFile, 'utf8')) }) + '\n');
  const out = (ev) => console.log(JSON.stringify(ev));
  out({ type: 'thread.started', thread_id: 'test-thread' });
  out({ type: 'turn.started' });
  if (input.includes('SIGNED-OUT')) {
    out({ type: 'error', message: 'You are not logged in. Run codex login.' });
    out({ type: 'turn.failed', error: { message: 'You are not logged in. Run codex login.' } });
    return;
  }
  out({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: `/bin/bash -lc 'node mapa-do-codigo/consulta.mjs buscar "reembolso"'`, status: 'in_progress' } });
  out({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: `"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "Get-Content shop-api/routes/orders.js"`, status: 'in_progress' } });
  out({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Vou olhar a rota de reembolso.' } });
  out({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: JSON.stringify({
    title: 'Reembolsos', answer: 'Os reembolsos passam por [[f:shop-api/routes/orders.js]].',
    items: [{ id: 'f:shop-api/routes/orders.js', note: 'Tem o endpoint de reembolso.' }], steps: [], followups: ['Quem pode pedir um?'],
  }) } });
  out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
});
