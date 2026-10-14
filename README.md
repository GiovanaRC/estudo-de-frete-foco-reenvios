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

## Pipeline de dados: ETL e validação

O painel só mostra dados que passaram por um pipeline de 4 etapas (`montarPayload_` em `Codigo.gs`):

1. **Extração**: recebe os registros (aqui, o gerador fictício; em produção, o banco de dados ou a API).
2. **Transformação**: converte tipos, padroniza textos (UF em maiúsculas, espaços removidos) e arredonda valores.
3. **Validação**: 12 regras. Registros que falham vão para **quarentena** e não entram em nenhum cálculo.
4. **Publicação**: só os registros válidos chegam ao painel, junto com o relatório de qualidade.

| Regra | O que verifica | Se falhar |
|---|---|---|
| R01 | Campos obrigatórios preenchidos | Quarentena |
| R02 | Sem identificador duplicado | Quarentena |
| R03 | Quantidade inteira > 0 e frete > 0 | Quarentena |
| R04 | Data válida e dentro do período | Quarentena |
| R05 | Categoria, tipo, UF e transportadora existem nas listas oficiais | Quarentena |
| R06 | Reenvio sempre tem motivo; problema logístico só com motivo logístico | Quarentena |
| R07 | Atrasados ≤ total de casos; prazos > 0 | Quarentena |
| R08 | Frete por caso entre R$ 5 e R$ 400 | Alerta (o lote segue) |
| R09 | Soma por tipo, transportadora e UF fecha com o total | Bloqueio |
| R10 | Todos os meses com dados; último dado recente | Alerta |
| R11 | Pós-venda entre 15% e 35% do frete total | Alerta |
| R12 | Frete por dia de cada mês dentro de ±50% da mediana | Alerta |

O painel tem uma seção **Qualidade dos dados** com as etapas, o resultado de cada regra e a tabela de quarentena. O botão **Simular dados com problemas** injeta defeitos típicos (duplicidade, frete negativo, UF inválida, data fora do período...) para mostrar a validação funcionando.

## Testes (pytest)

As regras de validação têm testes automatizados com **pytest**. Eles carregam o `Codigo.gs` real via Node (`tests/harness.js`), então testam exatamente o código que roda no Apps Script: cada regra tem casos bons e ruins, a transformação é verificada e o gerador de dados fictícios tem testes de coerência (período, totais, unicidade, domínios).

```bash
pip install pytest
python -m pytest        # requer Node.js instalado
```

O workflow `.github/workflows/testes.yml` roda a suíte a cada push.

## Estrutura

| Arquivo | Função |
|---|---|
| `Codigo.gs` | Backend: `doGet`, `getDados()`, pipeline de ETL e validação, gerador de dados fictícios e modelo de chamada à API real |
| `Index.html` | Painel (HTML, CSS e JS; gráficos com Chart.js 4.4.1, mapa em SVG) |
| `appsscript.json` | Manifesto do projeto Apps Script |
| `tests/` | Testes pytest (`test_validacao.py`, `test_gerador.py`) e a ponte `harness.js` |
| `.claspignore` | Garante que o `clasp push` envie só os 3 arquivos do painel ao Apps Script |

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
