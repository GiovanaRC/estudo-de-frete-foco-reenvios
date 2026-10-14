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

/** Chamada pelo HTML via google.script.run. */
function getDados() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('fretes');
  if (hit) return JSON.parse(hit);

  const dados = obterFretes_();
  try { cache.put('fretes', JSON.stringify(dados), 600); } catch (err) { /* >100KB: sem cache */ }
  return dados;
}

/** Ponto único de troca: mock hoje, API real depois. */
function obterFretes_() {
  return gerarFretesFicticios_();
  // return buscarDaApi_();
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
