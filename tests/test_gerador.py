"""Testes do gerador de dados fictícios: garantem que a base do painel é coerente."""
from collections import Counter


def test_gerador_e_deterministico(dados_gerados):
    from conftest import chamar_node
    outra_vez = chamar_node({"op": "gerar"})
    assert outra_vez == dados_gerados, "mesma semente deve gerar sempre os mesmos dados"


def test_datas_ficam_dentro_do_periodo(dados_gerados, constantes):
    datas = [x["data"] for x in dados_gerados]
    assert min(datas) >= constantes["DATA_INI"]
    assert max(datas) <= constantes["DATA_FIM"]


def test_identificadores_sao_unicos(dados_gerados):
    ids = [x["id_caso"] for x in dados_gerados]
    assert len(ids) == len(set(ids))


def test_pos_venda_soma_cerca_de_18_milhoes(dados_gerados, constantes):
    total = sum(x["valor_frete"] for x in dados_gerados if x["categoria_frete"] == "Pós-venda")
    alvo = constantes["FRETE_POSVENDA"]
    assert 0.9 * alvo <= total <= 1.1 * alvo, f"pós-venda = {total:,.0f}"


def test_pos_venda_representa_20_a_26_por_cento_do_total(dados_gerados):
    soma = Counter()
    for x in dados_gerados:
        soma[x["categoria_frete"]] += x["valor_frete"]
    parte = soma["Pós-venda"] / sum(soma.values())
    assert 0.20 <= parte <= 0.26, f"participação = {parte:.1%}"


def test_todas_as_27_ufs_aparecem(dados_gerados, constantes):
    ufs = {x["uf"] for x in dados_gerados if x["categoria_frete"] == "Pós-venda"}
    assert ufs == set(constantes["UFS"]) and len(ufs) == 27


def test_os_quatro_tipos_de_pedido_aparecem(dados_gerados, constantes):
    tipos = {x["tipo_pedido"] for x in dados_gerados if x["categoria_frete"] == "Pós-venda"}
    assert tipos == set(constantes["TIPOS"])


def test_todo_reenvio_tem_motivo_e_so_ele_tem(dados_gerados):
    for x in dados_gerados:
        if x["categoria_frete"] != "Pós-venda":
            continue
        if x["tipo_pedido"] == "Reenvio":
            assert x["motivo_reenvio"], x["id_caso"]
        else:
            assert x["motivo_reenvio"] == "" and not x["problema_logistico"], x["id_caso"]


def test_outubro_e_parcial_e_tem_menos_volume_que_um_mes_cheio(dados_gerados):
    por_mes = Counter()
    for x in dados_gerados:
        if x["categoria_frete"] == "Pós-venda":
            por_mes[x["data"][:7]] += x["valor_frete"]
    assert por_mes["2026-10"] < 0.7 * por_mes["2026-09"]
