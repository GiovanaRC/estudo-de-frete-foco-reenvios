# Painel Executivo · Frete Pós-venda

Painel web (Google Apps Script) para acompanhar o frete de pós-venda: **trocas, devoluções, garantias e reenvios**, com destaque para os **reenvios causados por problema logístico** (insucesso na entrega, extravio, avaria, endereço não localizado, atraso excessivo).

> Os dados são **fictícios** (gerados no código) para demonstração: cerca de R$ 18 mi de frete de pós-venda entre 01/01 e 14/10/2026, dentro de um frete total de operação de cerca de R$ 78 mi (venda + pós-venda + outros).

## O que o painel mostra

- Faixa de **frete total da operação** (venda, pós-venda, outros) e % do pós-venda
- Indicadores-chave com variação contra o período anterior: casos, frete, custo médio, prazo, taxa de atraso, reenvios logísticos
- Leitura executiva gerada automaticamente
- Reenvios logísticos: evolução, motivos, taxa por transportadora, **mapa do Brasil por UF** (com custo médio no hover) e mapa de calor transportadora × motivo
- Visão geral: casos e custo por tipo, prazo previsto × real, taxa de atraso
- Ranking de transportadoras e detalhamento dos lotes com busca
- Filtros de período, tipo de pedido, transportadora e UF; cada gráfico tem visão em tabela

## Estrutura

| Arquivo | Função |
|---|---|
| `Codigo.gs` | Backend: `doGet`, `getDados()`, gerador de dados fictícios e modelo de chamada à API real |
| `Index.html` | Painel (HTML, CSS e JS; gráficos com Chart.js 4.4.1, mapa em SVG) |
| `appsscript.json` | Manifesto do projeto Apps Script |

Cada registro é um **lote consolidado**: `qtd` (casos), `qtd_atraso`, `valor_frete` (total do lote), `prazo_previsto` e `prazo_real` (médias), `categoria_frete` (`Venda`, `Pós-venda` ou `Outros`).

## Como publicar

1. Crie um projeto em [script.google.com](https://script.google.com) e copie os arquivos, **ou** use o [clasp](https://github.com/google/clasp):
   ```bash
   npm install -g @google/clasp
   clasp login
   cp .clasp.json.example .clasp.json   # coloque o ID do seu script
   clasp push
   ```
2. Em **Implantar → Nova implantação → App da Web**, defina quem pode acessar e copie a URL `/exec`.
3. Para atualizar a mesma URL depois: `clasp push` e `clasp deploy -i <ID_DA_IMPLANTACAO>`.

## Trocar para uma API real

Em `Codigo.gs`, no ponto único de troca `obterFretes_()`, troque `gerarFretesFicticios_()` por `buscarDaApi_()` e ajuste o mapeamento de campos. O token fica em **Propriedades do script** (`API_TOKEN`), nunca no código. Se a API devolver uma linha por caso, use `qtd: 1`. Sem `categoria_frete`, tudo é tratado como pós-venda.

Antes de ligar dados reais, restrinja o acesso do App da Web (`appsscript.json` está com `ANYONE_ANONYMOUS`).
