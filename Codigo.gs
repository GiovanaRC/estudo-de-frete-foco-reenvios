/**
 * Painel de frete pós-venda — Apps Script Web App
 *
 * Tipos de pedido pós-venda: Troca, Devolução, Garantia, Reenvio.
 * Indicador especial: Reenvios causados por problema logístico.
 *
 * Fonte de dados: obterFretes_() — hoje gera dados fictícios.
 * Para usar API real, troque o corpo de obterFretes_() por buscarDaApi_() e ajuste o mapeamento.
 *
 * Formato do registro (lote consolidado):
 *   qtd            nº de casos do lote
 *   qtd_atraso     casos do lote entregues depois do prazo
 *   valor_frete    frete TOTAL do lote (R$)
 *   prazo_*        médias do lote, em dias
 */

const TIPOS = ['Troca', 'Devolução', 'Garantia', 'Reenvio'];
// 27 UFs, peso aproximado pela população (normalizado em gerarFretesFicticios_).
const UFS = ['SP', 'MG', 'RJ', 'BA', 'PR', 'RS', 'PE', 'CE', 'PA', 'SC', 'MA', 'GO', 'AM', 'ES', 'PB', 'RN', 'AL', 'MT', 'MS', 'DF', 'PI', 'SE', 'RO', 'TO', 'AC', 'AP', 'RR'];
const PESO_UF = [22, 10, 8, 7, 5.5, 5.3, 4.5, 4.3, 4, 3.7, 3.4, 3.4, 2, 2, 2, 1.7, 1.5, 1.7, 1.4, 1.5, 1.5, 1.1, 0.8, 0.7, 0.4, 0.4, 0.3];

// Referência fictícia: ~R$ 18 mi de frete de PÓS-VENDA de 1/jan a 14/out/2026, com variação mensal.
// Outubro é parcial (vai só até o dia 14), então recebe volume proporcional aos seus dias.
// O frete total da operação (venda + pós-venda + outros) é derivado: pós-venda ≈ 20–25% do total.
const ANO = 2026;
const MESES = 10;        // jan..out
const ULTIMO_DIA = 14;   // último dia de dados em outubro
const FRETE_POSVENDA = 18000000;
const LOTES = 4000;

// Motivos de reenvio. true = problema de logística.
const MOTIVOS_REENVIO = {
  'Insucesso na entrega': true,
  'Extravio': true,
  'Avaria no transporte': true,
  'Endereço não localizado': true,
  'Atraso excessivo': true,
  'Erro de expedição': false,
  'Solicitação do cliente': false
};
const MOTIVOS_LOGISTICOS = Object.keys(MOTIVOS_REENVIO).filter(m => MOTIVOS_REENVIO[m]);
const MOTIVOS_OUTROS = Object.keys(MOTIVOS_REENVIO).filter(m => !MOTIVOS_REENVIO[m]);

// Perfil fictício de cada transportadora (só para o painel ter variação).
const TRANSPORTADORAS = {
  'Correios':      { peso: 0.30, frete: 1.00, log: 0.78, atraso: 0.30, fav: ['Extravio', 'Atraso excessivo'] },
  'Jadlog':        { peso: 0.20, frete: 0.90, log: 0.70, atraso: 0.28, fav: ['Atraso excessivo', 'Endereço não localizado'] },
  'Total Express': { peso: 0.20, frete: 1.10, log: 0.55, atraso: 0.15, fav: ['Avaria no transporte', 'Insucesso na entrega'] },
  'Loggi':         { peso: 0.15, frete: 0.95, log: 0.84, atraso: 0.18, fav: ['Insucesso na entrega', 'Endereço não localizado'] },
  'Azul Cargo':    { peso: 0.15, frete: 1.35, log: 0.45, atraso: 0.10, fav: ['Avaria no transporte', 'Atraso excessivo'] }
};

/** Web App: ?api=fretes devolve JSON (simula API); sem parâmetro abre o painel. */
function doGet(e) {
  if (e && e.parameter && e.parameter.api === 'fretes') {
    return ContentService
      .createTextOutput(JSON.stringify({ itens: gerarFretesFicticios_() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Painel Executivo · Frete Pós-venda')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Chamada pelo HTML via google.script.run.
 * Retorna { itens, qualidade }: só registros validados vão para o painel.
 * simularErros = true injeta defeitos típicos para demonstrar a validação.
 */
function getDados(simularErros) {
  const chave = simularErros ? 'payload_sim_v3' : 'payload_v3';
  const cache = CacheService.getScriptCache();
  const hit = cache.get(chave);
  if (hit) return JSON.parse(hit);

  const payload = montarPayload_(!!simularErros);
  try { cache.put(chave, JSON.stringify(payload), 600); } catch (err) { /* >100KB: sem cache */ }
  return payload;
}

/** Ponto único de troca: mock hoje, API real depois. */
function obterFretes_() {
  return gerarFretesFicticios_();
  // return buscarDaApi_();
}

/* ======================= Pipeline: extrair → transformar → validar → publicar ======================= */

const DATA_INI = ANO + '-01-01';
const DATA_FIM = ANO + '-' + (MESES < 10 ? '0' : '') + MESES + '-' + ULTIMO_DIA;
const CATEGORIAS = ['Pós-venda', 'Venda', 'Outros'];

// Catálogo das regras (a ordem é a da tela). tratamento: Quarentena | Alerta | Bloqueio
const REGRAS = [
  { id: 'R01', nome: 'Campos obrigatórios', tratamento: 'Quarentena', descricao: 'Identificador, data, categoria, quantidade e frete preenchidos; lotes de pós-venda também com tipo, transportadora e UF' },
  { id: 'R02', nome: 'Sem duplicidade', tratamento: 'Quarentena', descricao: 'Cada lote tem identificador único' },
  { id: 'R03', nome: 'Valores numéricos válidos', tratamento: 'Quarentena', descricao: 'Quantidade inteira maior que zero e frete maior que zero' },
  { id: 'R04', nome: 'Datas válidas e no período', tratamento: 'Quarentena', descricao: 'Formato aaaa-mm-dd entre 01/01 e a data final dos dados' },
  { id: 'R05', nome: 'Domínios conhecidos', tratamento: 'Quarentena', descricao: 'Categoria, tipo de pedido, UF e transportadora existem nas listas oficiais' },
  { id: 'R06', nome: 'Coerência de reenvio', tratamento: 'Quarentena', descricao: 'Reenvio sempre tem motivo; problema logístico só com motivo logístico' },
  { id: 'R07', nome: 'Coerência de prazo e atraso', tratamento: 'Quarentena', descricao: 'Atrasados não passam do total de casos; prazos maiores que zero' },
  { id: 'R08', nome: 'Frete unitário plausível', tratamento: 'Alerta', descricao: 'Frete por caso entre R$ 5 e R$ 400 (fora disso o lote segue, mas gera alerta)' },
  { id: 'R09', nome: 'Reconciliação de totais', tratamento: 'Bloqueio', descricao: 'Soma por tipo, por transportadora e por UF fecha com o total do pós-venda (tolerância de R$ 0,01)' },
  { id: 'R10', nome: 'Cobertura temporal', tratamento: 'Alerta', descricao: 'Todos os meses do período têm dados e o último dado está a até 2 dias da data final' },
  { id: 'R11', nome: 'Participação do pós-venda', tratamento: 'Alerta', descricao: 'Pós-venda entre 15% e 35% do frete total da operação' },
  { id: 'R12', nome: 'Variação mensal', tratamento: 'Alerta', descricao: 'Frete por dia de cada mês dentro de ±50% da mediana' }
];

/** Executa o pipeline completo e devolve o que o painel consome. */
function montarPayload_(simular) {
  let bruto = obterFretes_();
  if (simular) bruto = injetarProblemas_(bruto);
  const t = transformar_(bruto);
  const v = validar_(t.itens);
  const q = avaliarQualidade_(v, bruto.length, t.ajustados, !!simular);
  return { itens: v.validos, qualidade: q };
}

/** Transformação: tipos numéricos, textos padronizados, valores arredondados. */
function transformar_(itens) {
  let ajustados = 0;
  const saida = itens.map(r => {
    const n = Object.assign({}, r);
    let mudou = false;
    ['id_caso', 'data', 'tipo_pedido', 'transportadora', 'uf', 'categoria_frete', 'motivo_reenvio', 'status'].forEach(c => {
      if (typeof n[c] === 'string') {
        const limpo = c === 'uf' ? n[c].trim().toUpperCase() : n[c].trim();
        if (limpo !== n[c]) { n[c] = limpo; mudou = true; }
      }
    });
    ['qtd', 'qtd_atraso', 'valor_frete', 'prazo_previsto', 'prazo_real'].forEach(c => {
      if (typeof n[c] === 'string' && n[c] !== '') { n[c] = Number(n[c]); mudou = true; }
    });
    if (typeof n.valor_frete === 'number' && isFinite(n.valor_frete)) {
      const arred = Math.round(n.valor_frete * 100) / 100;
      if (arred !== n.valor_frete) { n.valor_frete = arred; mudou = true; }
    }
    if (mudou) ajustados++;
    return n;
  });
  return { itens: saida, ajustados: ajustados };
}

/** Validação linha a linha (R01–R08). Registros com falha vão para quarentena. */
function validar_(itens) {
  const set = lista => lista.reduce((m, x) => { m[x] = true; return m; }, {});
  const tiposOk = set(TIPOS), ufsOk = set(UFS), catsOk = set(CATEGORIAS), transpOk = set(Object.keys(TRANSPORTADORAS));
  const vistos = {}, validos = [], quarentena = [];
  const falhas = {}, outliers = [];
  const marca = (motivos, id, texto) => motivos.push({ regra: id, texto: texto });

  itens.forEach(r => {
    const m = [];
    const pv = r.categoria_frete === 'Pós-venda';
    const vazio = v => v === undefined || v === null || v === '';

    if (vazio(r.id_caso) || vazio(r.data) || vazio(r.categoria_frete) || vazio(r.qtd) || vazio(r.valor_frete) ||
        (pv && (vazio(r.tipo_pedido) || vazio(r.transportadora) || vazio(r.uf)))) {
      marca(m, 'R01', 'Campo obrigatório vazio');
    }
    if (!vazio(r.id_caso)) {
      if (vistos[r.id_caso]) marca(m, 'R02', 'Identificador duplicado'); else vistos[r.id_caso] = true;
    }
    if (!(Number.isInteger(r.qtd) && r.qtd > 0) || !(typeof r.valor_frete === 'number' && isFinite(r.valor_frete) && r.valor_frete > 0)) {
      marca(m, 'R03', 'Quantidade ou frete inválido (zero, negativo ou nulo)');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.data || '') || r.data < DATA_INI || r.data > DATA_FIM) {
      marca(m, 'R04', 'Data inválida ou fora do período');
    }
    if ((!vazio(r.categoria_frete) && !catsOk[r.categoria_frete]) ||
        (pv && ((!vazio(r.tipo_pedido) && !tiposOk[r.tipo_pedido]) || (!vazio(r.uf) && !ufsOk[r.uf]) ||
                (!vazio(r.transportadora) && !transpOk[r.transportadora])))) {
      marca(m, 'R05', 'Valor fora da lista oficial (categoria, tipo, UF ou transportadora)');
    }
    if (pv) {
      const reenvio = r.tipo_pedido === 'Reenvio';
      const motivoLog = MOTIVOS_REENVIO[r.motivo_reenvio];
      if ((reenvio && vazio(r.motivo_reenvio)) ||
          (r.problema_logistico && !reenvio) ||
          (reenvio && !vazio(r.motivo_reenvio) && motivoLog !== undefined && motivoLog !== !!r.problema_logistico) ||
          (reenvio && !vazio(r.motivo_reenvio) && motivoLog === undefined)) {
        marca(m, 'R06', 'Reenvio sem motivo ou problema logístico incoerente com o motivo');
      }
      if (!(r.qtd_atraso >= 0 && r.qtd_atraso <= r.qtd) || !(r.prazo_real > 0) || !(r.prazo_previsto > 0)) {
        marca(m, 'R07', 'Atrasados maior que o total de casos, ou prazo inválido');
      }
    }

    if (m.length) {
      m.forEach(x => { falhas[x.regra] = (falhas[x.regra] || 0) + 1; });
      quarentena.push({ id_caso: r.id_caso || '(sem id)', data: r.data || '', valor_frete: r.valor_frete, motivos: m });
    } else {
      const unit = r.valor_frete / r.qtd;
      if (unit < 5 || unit > 400) outliers.push(r.id_caso);
      validos.push(r);
    }
  });
  return { validos: validos, quarentena: quarentena, falhas: falhas, outliers: outliers };
}

/** Regras de agregado (R09–R12) + resumo das etapas do pipeline. */
function avaliarQualidade_(v, recebidos, ajustados, simulado) {
  const pvLotes = v.validos.filter(r => r.categoria_frete === 'Pós-venda');
  const soma = (lista, f) => lista.reduce((s, r) => s + f(r), 0);
  const porChave = (lista, f) => lista.reduce((m, r) => { const k = f(r); m[k] = (m[k] || 0) + r.valor_frete; return m; }, {});
  const total = soma(pvLotes, r => r.valor_frete);
  const checks = [];
  const add = (id, afetados, detalhe) => {
    const regra = REGRAS.filter(x => x.id === id)[0];
    const status = afetados === 0 ? 'ok' : (regra.tratamento === 'Alerta' ? 'alerta' : 'erro');
    checks.push({ id: id, nome: regra.nome, descricao: regra.descricao, tratamento: regra.tratamento, status: status, afetados: afetados, detalhe: detalhe });
  };
  const emQuarentena = n => n ? n + ' lote(s) em quarentena' : 'Nenhuma ocorrência';

  ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07'].forEach(id => add(id, v.falhas[id] || 0, emQuarentena(v.falhas[id] || 0)));
  add('R08', v.outliers.length, v.outliers.length ? v.outliers.length + ' lote(s) com frete unitário fora da faixa, mantidos com alerta' : 'Nenhuma ocorrência');

  // R09: reconciliação por três dimensões.
  const dims = [['tipo', r => r.tipo_pedido], ['transportadora', r => r.transportadora], ['UF', r => r.uf]];
  const quebras = dims.filter(d => {
    const grupos = porChave(pvLotes, d[1]);
    const s = Object.keys(grupos).reduce((a, k) => a + grupos[k], 0);
    return Math.abs(s - total) > 0.01;
  }).map(d => d[0]);
  add('R09', quebras.length, quebras.length ? 'Total não fecha por: ' + quebras.join(', ') : 'Total fecha por tipo, transportadora e UF');

  // R10: cobertura temporal.
  const meses = {};
  pvLotes.forEach(r => { meses[r.data.slice(5, 7)] = true; });
  const faltando = [];
  for (let k = 1; k <= MESES; k++) if (!meses[(k < 10 ? '0' : '') + k]) faltando.push(k);
  const ultimo = pvLotes.reduce((mx, r) => r.data > mx ? r.data : mx, '');
  const atrasoDias = ultimo ? Math.round((Date.parse(DATA_FIM) - Date.parse(ultimo)) / 86400000) : 999;
  const problemasCobertura = faltando.length + (atrasoDias > 2 ? 1 : 0);
  add('R10', problemasCobertura, problemasCobertura ? (faltando.length ? 'Meses sem dados: ' + faltando.join(', ') + '. ' : '') + 'Último dado: ' + ultimo : 'Meses completos; último dado em ' + ultimo);

  // R11: participação do pós-venda no total da operação.
  const outros = soma(v.validos.filter(r => r.categoria_frete !== 'Pós-venda'), r => r.valor_frete);
  const parte = total + outros ? total / (total + outros) : 0;
  const foraFaixa = (parte < 0.15 || parte > 0.35) ? 1 : 0;
  add('R11', foraFaixa, 'Pós-venda = ' + (parte * 100).toFixed(1).replace('.', ',') + '% do frete total');

  // R12: frete por dia de cada mês vs. mediana.
  const diasDoMes = m => (m === MESES ? ULTIMO_DIA : new Date(ANO, m, 0).getDate());
  const porMes = porChave(pvLotes, r => Number(r.data.slice(5, 7)));
  const perDia = Object.keys(porMes).map(m => ({ m: Number(m), v: porMes[m] / diasDoMes(Number(m)) }));
  const ordenado = perDia.map(x => x.v).sort((a, b) => a - b);
  const mediana = ordenado.length ? ordenado[Math.floor(ordenado.length / 2)] : 0;
  const fora = perDia.filter(x => mediana && (x.v > mediana * 1.5 || x.v < mediana * 0.5)).map(x => x.m);
  add('R12', fora.length, fora.length ? 'Meses fora da faixa: ' + fora.join(', ') : 'Todos os meses dentro de ±50% da mediana');

  const alertas = checks.filter(c => c.status === 'alerta').reduce((s, c) => s + c.afetados, 0);
  const erros = checks.filter(c => c.status === 'erro').length;
  const geradoEm = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'dd/MM/yyyy HH:mm');
  return {
    simulado: simulado,
    geradoEm: geradoEm,
    dataInicial: DATA_INI,
    dataFinal: DATA_FIM,
    resumo: {
      recebidos: recebidos, ajustados: ajustados, validos: v.validos.length, quarentena: v.quarentena.length,
      alertas: alertas, regras: REGRAS.length,
      status: (v.quarentena.length || erros) ? 'erro' : (alertas ? 'alerta' : 'ok')
    },
    checks: checks,
    quarentena: v.quarentena.slice(0, 20)
  };
}

/** Injeta defeitos típicos (determinísticos) para demonstrar a validação. */
function injetarProblemas_(itens) {
  const copia = itens.map(r => Object.assign({}, r));
  const pv = [];
  copia.forEach((r, i) => { if (r.categoria_frete === 'Pós-venda') pv.push(i); });
  let k = 0;
  const alvo = () => copia[pv[(k++ * 397 + 11) % pv.length]];
  let r;
  for (let i = 0; i < 8; i++) { r = alvo(); copia.push(Object.assign({}, r)); }               // duplicidade (R02)
  for (let i = 0; i < 6; i++) { r = alvo(); r.valor_frete = -Math.abs(r.valor_frete); }      // frete negativo (R03)
  for (let i = 0; i < 5; i++) { r = alvo(); r.qtd_atraso = r.qtd + 15; }                     // atraso > casos (R07)
  for (let i = 0; i < 4; i++) { r = alvo(); r.uf = 'XX'; }                                   // UF inexistente (R05)
  for (let i = 0; i < 7; i++) { r = alvo(); r.uf = ' ' + r.uf.toLowerCase() + ' '; }         // sujeira corrigível na transformação
  for (let i = 0; i < 5; i++) { r = alvo(); r.data = (ANO + 1) + '-03-01'; }                 // fora do período (R04)
  for (let i = 0; i < 4; i++) { r = alvo(); r.tipo_pedido = 'Reenvio'; r.problema_logistico = true; r.motivo_reenvio = ''; } // R06
  for (let i = 0; i < 3; i++) { r = alvo(); r.valor_frete = r.valor_frete * 60; }            // outlier (R08, alerta)
  for (let i = 0; i < 4; i++) { r = alvo(); r.transportadora = ''; }                         // campo vazio (R01)
  return copia;
}

/** Modelo para API real. Token fica em Propriedades do script (API_TOKEN). */
function buscarDaApi_() {
  const token = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  const resp = UrlFetchApp.fetch('https://api.exemplo.com/v1/fretes?tipo=pos_venda', {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('API erro ' + resp.getResponseCode() + ': ' + resp.getContentText());
  }
  // Ajuste o mapeamento para o formato real da API.
  // Se a API devolver 1 linha por caso, use qtd: 1 e valor_frete do caso.
  return JSON.parse(resp.getContentText()).itens.map(i => ({
    id_caso: i.id,
    categoria_frete: i.categoria_frete || 'Pós-venda', // Venda | Pós-venda | Outros
    data: i.data,
    tipo_pedido: i.tipo_pedido,
    transportadora: i.transportadora,
    uf: i.uf,
    qtd: Number(i.qtd || 1),
    valor_frete: Number(i.valor_frete),
    prazo_previsto: Number(i.prazo_previsto),
    prazo_real: Number(i.prazo_real),
    qtd_atraso: Number(i.prazo_real) > Number(i.prazo_previsto) ? Number(i.qtd || 1) : 0,
    status: i.status,
    motivo_reenvio: i.motivo_reenvio || '',
    problema_logistico: !!i.problema_logistico
  }));
}

/**
 * Gerador determinístico (mesma semente = mesmos dados a cada abertura).
 * Gera LOTES lotes consolidados e calibra o frete de cada mês perto de
 * FRETE_TOTAL / MESES, com oscilação mensal.
 */
function gerarFretesFicticios_() {
  let seed = 20260101;
  const rnd = () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const wpick = (itens, pesos) => {
    let r = rnd(), acc = 0;
    for (let k = 0; k < itens.length; k++) { acc += pesos[k]; if (r <= acc) return itens[k]; }
    return itens[itens.length - 1];
  };
  const somaUf = PESO_UF.reduce((s, v) => s + v, 0);
  const pesosUf = PESO_UF.map(v => v / somaUf);
  const pad = v => (v < 10 ? '0' : '') + v;
  const arred1 = v => Math.round(v * 10) / 10;

  const nomes = Object.keys(TRANSPORTADORAS);
  const pesosTransp = nomes.map(t => TRANSPORTADORAS[t].peso);
  const porMes = [], idxMeses = [], diasMes = [];
  for (let m = 0; m < MESES; m++) {
    porMes.push([]); idxMeses.push(m);
    diasMes.push(m === MESES - 1 ? ULTIMO_DIA : new Date(ANO, m + 1, 0).getDate());
  }
  const totalDias = diasMes.reduce((s, v) => s + v, 0);
  const pesosMes = diasMes.map(d => d / totalDias);    // mais dias, mais lotes

  for (let i = 1; i <= LOTES; i++) {
    const mes = wpick(idxMeses, pesosMes);             // 0 = jan ... 9 = out
    const dia = 1 + Math.floor(rnd() * diasMes[mes]);
    const recente = mes >= MESES - 2;                  // últimos ~60 dias
    const transp = wpick(nomes, pesosTransp);
    const perfil = TRANSPORTADORAS[transp];

    // Reenvios crescem nos últimos meses.
    const pReenvio = recente ? 0.27 : 0.17;
    const resto = (1 - pReenvio) / 3;
    const tipo = wpick(TIPOS, [resto * 1.1, resto * 0.95, resto * 0.95, pReenvio]);

    const qtd = 60 + Math.floor(rnd() * 80);           // 60–139 casos por lote
    const previsto = 3 + rnd() * 7;
    let pAtraso = Math.min(0.95, perfil.atraso * 1.4 + rnd() * 0.1);
    let motivo = '', logistico = false, status = 'Concluído';

    if (tipo === 'Reenvio') {
      logistico = rnd() < Math.min(0.95, perfil.log + (recente ? 0.08 : 0));
      if (logistico) {
        motivo = rnd() < 0.6 ? pick(perfil.fav) : pick(MOTIVOS_LOGISTICOS);
        status = motivo;
        pAtraso = 0.8 + rnd() * 0.15;
      } else {
        motivo = pick(MOTIVOS_OUTROS);
      }
    } else if (rnd() < 0.10) {
      status = 'Em andamento';
    }

    const multTipo = tipo === 'Reenvio' ? 1.15 : tipo === 'Garantia' ? 0.9 : 1;
    const freteUnit = (15 + rnd() * 85) * perfil.frete * multTipo;

    porMes[mes].push({
      id_caso: 'LT-' + String(100000 + i),
      categoria_frete: 'Pós-venda',
      data: ANO + '-' + pad(mes + 1) + '-' + pad(dia),
      tipo_pedido: tipo,
      transportadora: transp,
      uf: wpick(UFS, pesosUf),
      qtd: qtd,
      qtd_atraso: Math.round(qtd * pAtraso),
      valor_frete: freteUnit * qtd,                    // total do lote (calibrado abaixo)
      prazo_previsto: arred1(previsto),
      prazo_real: arred1(previsto + pAtraso * (logistico ? 6 : 3.5) - 0.5 + rnd()),
      status: status,
      motivo_reenvio: motivo,
      problema_logistico: logistico
    });
  }

  // Calibra cada mês perto de FRETE_TOTAL / MESES, com oscilação de ±12%
  // (o total do ano fica próximo de R$ 18 mi, mas não exato).
  const itens = [];
  porMes.forEach((lotes, mes) => {
    const soma = lotes.reduce((s, r) => s + r.valor_frete, 0);
    const metaMes = FRETE_POSVENDA * pesosMes[mes] * (0.88 + rnd() * 0.24);
    lotes.forEach(r => {
      r.valor_frete = Math.round(r.valor_frete / soma * metaMes * 100) / 100;
      itens.push(r);
    });

    // Frete das outras categorias, registros agregados por semana do mês (sem transportadora/UF).
    // Pós-venda fica em ~20–25% do frete total; do restante, ~10% é "Outros".
    const totalMes = metaMes / (0.20 + rnd() * 0.05);
    const outrosMes = (totalMes - metaMes) * (0.09 + rnd() * 0.04);
    const faixas = [[1, 7], [8, 14], [15, 21], [22, 31]]
      .filter(f => f[0] <= diasMes[mes])
      .map(f => [f[0], Math.min(f[1], diasMes[mes])]);
    [['Venda', totalMes - metaMes - outrosMes, 32], ['Outros', outrosMes, 55]].forEach(c => {
      faixas.forEach(fx => {
        const parte = c[1] * (fx[1] - fx[0] + 1) / diasMes[mes];
        itens.push({
          id_caso: 'AG-' + c[0].toUpperCase() + '-' + pad(mes + 1) + pad(fx[0]),
          data: ANO + '-' + pad(mes + 1) + '-' + pad(fx[1]),
          categoria_frete: c[0],
          tipo_pedido: '', transportadora: '', uf: '',
          qtd: Math.round(parte / c[2]),
          valor_frete: Math.round(parte * 100) / 100,
          prazo_previsto: 0, prazo_real: 0, qtd_atraso: 0,
          status: 'Agregado', motivo_reenvio: '', problema_logistico: false
        });
      });
    });
  });
  return itens;
}
