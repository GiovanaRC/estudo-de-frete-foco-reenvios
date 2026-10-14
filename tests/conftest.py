"""Fixtures compartilhadas: rodam o validador REAL do painel (Codigo.gs) via Node."""
import json
import pathlib
import subprocess

import pytest

RAIZ = pathlib.Path(__file__).resolve().parent.parent
HARNESS = RAIZ / "tests" / "harness.js"


def chamar_node(entrada: dict):
    """Envia uma operação ao harness.js e devolve o JSON de resposta."""
    r = subprocess.run(
        ["node", str(HARNESS)],
        input=json.dumps(entrada),
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert r.returncode == 0, f"harness falhou:\n{r.stderr}"
    return json.loads(r.stdout)


@pytest.fixture(scope="session")
def constantes():
    return chamar_node({"op": "constantes"})


@pytest.fixture(scope="session")
def dados_gerados():
    """Os ~4 mil lotes do gerador fictício (calculados uma vez por sessão)."""
    return chamar_node({"op": "gerar"})


@pytest.fixture
def rodar():
    """Roda transformação + validação sobre uma lista de registros."""

    def _rodar(itens):
        return chamar_node({"op": "pipeline", "itens": itens})

    return _rodar


@pytest.fixture
def lote():
    """Um lote de pós-venda perfeitamente válido (cada teste estraga só o que quer testar)."""
    return {
        "id_caso": "LT-1",
        "categoria_frete": "Pós-venda",
        "data": "2026-03-10",
        "tipo_pedido": "Troca",
        "transportadora": "Correios",
        "uf": "SP",
        "qtd": 100,
        "qtd_atraso": 20,
        "valor_frete": 4500.0,
        "prazo_previsto": 5.0,
        "prazo_real": 6.0,
        "status": "Concluído",
        "motivo_reenvio": "",
        "problema_logistico": False,
    }


def regras_em_quarentena(resultado):
    """Conjunto de regras (R01..R07) que mandaram algum lote para a quarentena."""
    return {m["regra"] for q in resultado["quarentena"] for m in q["motivos"]}


def check(resultado, regra):
    """Resultado da regra (R01..R12) na avaliação de qualidade."""
    return next(c for c in resultado["qualidade"]["checks"] if c["id"] == regra)
