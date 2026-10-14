// Ponte entre o pytest e o validador do painel.
// Carrega o Codigo.gs REAL (o mesmo que roda no Apps Script) e executa uma operação.
//
// Entrada (stdin, JSON):  { "op": "pipeline" | "payload" | "gerar" | "constantes", ... }
// Saída (stdout, JSON):   resultado da operação.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const codigo = fs.readFileSync(path.join(__dirname, '..', 'Codigo.gs'), 'utf8');
const ctx = vm.createContext({
  // Substitui o serviço do Apps Script que o código usa só para carimbar a data.
  Utilities: { formatDate: () => '01/01/2026 00:00' },
  console: console
});
vm.runInContext(codigo, ctx, { filename: 'Codigo.gs' });

const entrada = JSON.parse(fs.readFileSync(0, 'utf8'));
let saida;

if (entrada.op === 'pipeline') {
  // Mesmas etapas de montarPayload_, mas sobre os registros enviados pelo teste.
  const t = ctx.transformar_(entrada.itens);
  const v = ctx.validar_(t.itens);
  const q = ctx.avaliarQualidade_(v, entrada.itens.length, t.ajustados, false);
  saida = { validos: v.validos, quarentena: v.quarentena, qualidade: q, ajustados: t.ajustados };
} else if (entrada.op === 'payload') {
  saida = ctx.montarPayload_(!!entrada.simular);
} else if (entrada.op === 'gerar') {
  saida = ctx.gerarFretesFicticios_();
} else if (entrada.op === 'constantes') {
  saida = vm.runInContext('({ DATA_INI, DATA_FIM, MESES, ULTIMO_DIA, UFS, TIPOS, FRETE_POSVENDA })', ctx);
} else {
  throw new Error('operação desconhecida: ' + entrada.op);
}

process.stdout.write(JSON.stringify(saida));
