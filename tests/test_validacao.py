"""Testes das regras de validação do painel (R01 a R12), no código real do Codigo.gs."""
import copy

import pytest

from conftest import chamar_node, check, regras_em_quarentena


# ---------------------------------------------------------------- lote válido

def test_lote_valido_passa_sem_quarentena(rodar, lote):
    r = rodar([lote])
    assert r["quarentena"] == []
    assert len(r["validos"]) == 1


def test_lote_de_venda_nao_precisa_de_tipo_transportadora_nem_uf(rodar, lote):
    agregado = {**lote, "categoria_frete": "Venda", "tipo_pedido": "", "transportadora": "", "uf": "",
                "qtd_atraso": 0, "prazo_previsto": 0, "prazo_real": 0}
    assert rodar([agregado])["quarentena"] == []


# ------------------------------------------- regras que mandam para quarentena

DEFEITOS = [
    # (id do caso de teste, alteração no lote, regra que deve barrar)
    ("R01 transportadora vazia", {"transportadora": ""}, "R01"),
    ("R01 sem identificador", {"id_caso": ""}, "R01"),
    ("R01 sem data", {"data": ""}, "R01"),
    ("R03 frete negativo", {"valor_frete": -10.0}, "R03"),
    ("R03 frete zero", {"valor_frete": 0}, "R03"),
    ("R03 quantidade zero", {"qtd": 0}, "R03"),
    ("R03 quantidade fracionada", {"qtd": 2.5}, "R03"),
    ("R04 ano seguinte", {"data": "2027-03-01"}, "R04"),
    ("R04 antes do início", {"data": "2025-12-31"}, "R04"),
    ("R04 formato brasileiro", {"data": "15/03/2026"}, "R04"),
    ("R05 UF inexistente", {"uf": "XX"}, "R05"),
    ("R05 tipo desconhecido", {"tipo_pedido": "Cortesia"}, "R05"),
    ("R05 transportadora fora da lista", {"transportadora": "Fedex"}, "R05"),
    ("R05 categoria desconhecida", {"categoria_frete": "Brinde"}, "R05"),
    ("R06 reenvio sem motivo", {"tipo_pedido": "Reenvio", "motivo_reenvio": ""}, "R06"),
    ("R06 problema logístico fora de reenvio", {"problema_logistico": True}, "R06"),
    ("R06 motivo logístico sem a marcação",
     {"tipo_pedido": "Reenvio", "motivo_reenvio": "Extravio", "problema_logistico": False}, "R06"),
    ("R06 marcação com motivo não logístico",
     {"tipo_pedido": "Reenvio", "motivo_reenvio": "Erro de expedição", "problema_logistico": True}, "R06"),
    ("R07 atrasados maior que casos", {"qtd_atraso": 150}, "R07"),
    ("R07 atrasados negativo", {"qtd_atraso": -1}, "R07"),
    ("R07 prazo real zero", {"prazo_real": 0}, "R07"),
]


@pytest.mark.parametrize("mudanca, regra", [(d[1], d[2]) for d in DEFEITOS], ids=[d[0] for d in DEFEITOS])
def test_defeito_vai_para_quarentena_pela_regra_certa(rodar, lote, mudanca, regra):
    r = rodar([{**lote, **mudanca}])
    assert r["validos"] == []
    assert regra in regras_em_quarentena(r)
    assert check(r, regra)["status"] == "erro"


def test_duplicidade_mantem_o_primeiro_e_barra_o_segundo(rodar, lote):
    r = rodar([lote, copy.deepcopy(lote)])
    assert len(r["validos"]) == 1
    assert regras_em_quarentena(r) == {"R02"}


def test_lote_com_dois_defeitos_registra_os_dois_motivos(rodar, lote):
    r = rodar([{**lote, "uf": "XX", "valor_frete": -5}])
    assert regras_em_quarentena(r) == {"R03", "R05"}
    assert len(r["quarentena"][0]["motivos"]) == 2


# ------------------------------------------------------------------- alerta

def test_frete_unitario_fora_da_faixa_gera_alerta_mas_o_lote_segue(rodar, lote):
    caro = {**lote, "valor_frete": 100 * 600.0}  # R$ 600 por caso (limite é R$ 400)
    r = rodar([caro])
    assert len(r["validos"]) == 1, "alerta não pode tirar o lote do painel"
    assert check(r, "R08")["status"] == "alerta"
    assert check(r, "R08")["afetados"] == 1


def test_frete_unitario_normal_nao_gera_alerta(rodar, lote):
    assert check(rodar([lote]), "R08")["status"] == "ok"


# ------------------------------------------------------------ transformação

def test_transformacao_padroniza_uf_e_conta_ajuste(rodar, lote):
    r = rodar([{**lote, "uf": " sp "}])
    assert r["validos"][0]["uf"] == "SP"
    assert r["ajustados"] == 1
    assert r["quarentena"] == []


def test_transformacao_converte_numeros_em_texto(rodar, lote):
    r = rodar([{**lote, "qtd": "100", "valor_frete": "4500.50"}])
    assert r["validos"][0]["qtd"] == 100
    assert r["validos"][0]["valor_frete"] == 4500.5
    assert r["quarentena"] == []


def test_transformacao_arredonda_frete_em_centavos(rodar, lote):
    r = rodar([{**lote, "valor_frete": 4500.123456}])
    assert r["validos"][0]["valor_frete"] == 4500.12


def test_registro_limpo_nao_conta_como_ajustado(rodar, lote):
    assert rodar([lote])["ajustados"] == 0


# ------------------------------------- regras de agregado (R09 a R12) em dados reais

def test_dados_fictícios_limpos_passam_em_todas_as_regras(dados_gerados, rodar):
    r = rodar(dados_gerados)
    assert r["quarentena"] == []
    assert r["qualidade"]["resumo"]["status"] == "ok"
    assert all(c["status"] == "ok" for c in r["qualidade"]["checks"])


def test_r09_total_fecha_por_tipo_transportadora_e_uf(dados_gerados, rodar):
    assert check(rodar(dados_gerados), "R09")["status"] == "ok"


def test_r10_mes_sem_dados_gera_alerta(dados_gerados, rodar):
    sem_marco = [x for x in dados_gerados if not x["data"].startswith("2026-03")]
    c = check(rodar(sem_marco), "R10")
    assert c["status"] == "alerta"
    assert "3" in c["detalhe"]


def test_r10_dado_parado_gera_alerta(dados_gerados, rodar, constantes):
    # Corta tudo a partir de 01/10: o último dado fica a 13 dias da data final.
    parado = [x for x in dados_gerados if x["data"] < "2026-10-01"]
    assert check(rodar(parado), "R10")["status"] == "alerta"


def test_r11_pos_venda_sem_venda_e_outros_fica_fora_da_faixa(dados_gerados, rodar):
    so_pos_venda = [x for x in dados_gerados if x["categoria_frete"] == "Pós-venda"]
    assert check(rodar(so_pos_venda), "R11")["status"] == "alerta"


def test_r12_mes_com_frete_explodindo_gera_alerta(dados_gerados, rodar):
    inflado = copy.deepcopy(dados_gerados)
    for x in inflado:
        if x["categoria_frete"] == "Pós-venda" and x["data"].startswith("2026-01"):
            x["valor_frete"] = round(x["valor_frete"] * 5, 2)
    c = check(rodar(inflado), "R12")
    assert c["status"] == "alerta"
    assert "1" in c["detalhe"]


# ------------------------------------------------------- simulação de problemas

def test_simulacao_injeta_defeitos_e_a_validacao_pega_todos():
    p = chamar_node({"op": "payload", "simular": True})
    q = p["qualidade"]
    falharam = {c["id"] for c in q["checks"] if c["status"] == "erro"}
    assert {"R01", "R02", "R03", "R04", "R05", "R06", "R07"} <= falharam
    assert any(c["id"] == "R08" and c["status"] == "alerta" for c in q["checks"])
    assert q["resumo"]["quarentena"] >= 30
    assert q["resumo"]["status"] == "erro"
    assert q["resumo"]["ajustados"] >= 7, "UFs com espaço/minúscula devem ser corrigidas na transformação"


def test_simulacao_nao_deixa_registro_ruim_chegar_ao_painel():
    p = chamar_node({"op": "payload", "simular": True})
    ids = [x["id_caso"] for x in p["itens"]]
    assert len(ids) == len(set(ids)), "nenhum identificador duplicado pode passar"
    assert all(x["valor_frete"] > 0 for x in p["itens"])
    assert all(x["data"] <= "2026-10-14" for x in p["itens"])
    assert all(x["qtd_atraso"] <= x["qtd"] for x in p["itens"] if x["categoria_frete"] == "Pós-venda")


def test_dados_limpos_do_payload_ficam_com_status_ok():
    p = chamar_node({"op": "payload", "simular": False})
    assert p["qualidade"]["resumo"]["status"] == "ok"
    assert p["qualidade"]["resumo"]["quarentena"] == 0
    assert p["qualidade"]["resumo"]["regras"] == 12
