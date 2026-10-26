"""
Robot de Cargá Barato v2.
1) Descarga el archivo oficial de precios en surtidor (Secretaría de Energía).
2) Lo filtra (10 partidos de Zona Norte, 5 combustibles, último precio y fecha).
3) Carga las estaciones en Supabase sin dejar la tabla vacía: primero inserta las
   nuevas y recién después borra las viejas.
Si algo falla (el sitio no responde, el archivo viene raro), NO toca Supabase:
la app sigue mostrando los precios anteriores.

Lo corre GitHub Actions todos los días. Necesita dos secretos:
  SUPABASE_URL y SUPABASE_SECRET_KEY
"""

import io
import os
import sys
import time
from datetime import datetime, timezone

import requests
import unicodedata

import pandas as pd

ARCHIVO_ENTRADA = "precios-en-surtidor-resolucin-3142016.csv"
ARCHIVO_SALIDA = "estaciones_v2.csv"

# Localidades de cada partido (como aparecen en el dataset, sin tildes ni puntos)
PARTIDOS = {
    "Tigre": ["TIGRE", "GRAL PACHECO", "GENERAL PACHECO", "DON TORCUATO", "EL TALAR",
              "EL TALAR DE PACHECO", "BENAVIDEZ", "RINCON DE MILBERG", "NORDELTA",
              "TRONCOS DEL TALAR", "RICARDO ROJAS", "DIQUE LUJAN", "LOPEZ CAMELO", "BANCALARI"],
    "San Fernando": ["SAN FERNANDO", "VICTORIA", "VIRREYES"],
    "San Isidro": ["SAN ISIDRO", "MARTINEZ", "ACASSUSO", "BECCAR", "BOULOGNE",
                   "BOULOGNE SUR MER", "VILLA ADELINA"],
    "Vicente López": ["VICENTE LOPEZ", "OLIVOS", "FLORIDA", "FLORIDA OESTE", "MUNRO",
                      "LA LUCILA", "CARAPACHAY", "VILLA MARTELLI"],
    "San Martín": ["SAN MARTIN", "GENERAL SAN MARTIN", "GRAL SAN MARTIN", "VILLA BALLESTER",
                   "JOSE LEON SUAREZ", "SAN ANDRES", "BILLINGHURST", "BILLINGHURTS",
                   "VILLA LYNCH", "VILLA MAIPU", "CHILAVERT", "VILLA ZAGALA"],
    "San Miguel": ["SAN MIGUEL", "BELLA VISTA", "MUNIZ", "SANTA MARIA"],
    "José C. Paz": ["JOSE C PAZ", "JOSE CLEMENTE PAZ"],
    "Malvinas Argentinas": ["GRAND BOURG", "LOS POLVORINES", "TORTUGUITAS", "PABLO NOGUES",
                            "PABLO NOGHES", "ING PABLO NOGUES", "VILLA DE MAYO",
                            "MALVINAS ARGENTINAS", "TIERRAS ALTAS", "ADOLFO SOURDEAUX",
                            "ING ADOLFO SOURDEAUX", "R SOURDEAUX"],
    "Escobar": ["ESCOBAR", "BELEN DE ESCOBAR", "GARIN", "ING MASCHWITZ", "INGENIERO MASCHWITZ",
                "MATHEU", "MAQUINISTA SAVIO", "LOMA VERDE"],
    "Pilar": ["PILAR", "DEL VISO", "PRESIDENTE DERQUI", "DERQUI", "VILLA ROSA", "MANZANARES",
              "FATIMA", "LA LONJA", "MANUEL ALBERTI", "VILLA ASTOLFI", "ZELAYA", "TORTUGAS"],
}

# Nombre del producto en el dataset -> nombre corto en nuestra tabla
COMBUSTIBLES = {
    "super": lambda p: "NAFTA" in p and "SUPER" in p,
    "premium": lambda p: "NAFTA" in p and "PREMIUM" in p,
    "gasoil": lambda p: "GAS OIL" in p and "GRADO 2" in p,
    "gasoil_premium": lambda p: "GAS OIL" in p and "GRADO 3" in p,
    "gnc": lambda p: p == "GNC",
}


def normalizar(texto) -> str:
    """Mayúsculas, sin tildes ni puntos: 'Gral. Pacheco' -> 'GRAL PACHECO'."""
    texto = unicodedata.normalize("NFKD", str(texto)).encode("ascii", "ignore").decode()
    return " ".join(texto.upper().replace(".", " ").split())


def limpiar_bandera(texto) -> str:
    t = str(texto).strip().upper()
    for marca in ["SHELL", "YPF", "AXION", "PUMA", "GULF", "DAPSA"]:
        if t.startswith(marca):
            return marca
    return t.split()[0] if t and t != "NAN" else "SIN BANDERA"


def a_numero(serie):
    return pd.to_numeric(serie.astype(str).str.replace(",", ".", regex=False), errors="coerce")


LOCALIDAD_A_PARTIDO = {normalizar(l): p for p, ls in PARTIDOS.items() for l in ls}


def procesar(df: pd.DataFrame) -> pd.DataFrame:
    """Recibe el dataset completo y devuelve una fila por estación con sus precios."""
    df = df.copy()
    df.columns = [c.strip().lower() for c in df.columns]

    # 1. Zona: provincia de Buenos Aires y alguno de los 10 partidos
    df = df[df["provincia"].map(normalizar).str.contains("BUENOS AIRES")]
    df["partido"] = df["localidad"].map(normalizar).map(LOCALIDAD_A_PARTIDO)
    df = df[df["partido"].notna()]

    # 2. Solo horario diurno (de noche el precio es el mismo)
    if "tipohorario" in df.columns:
        df = df[df["tipohorario"].map(normalizar) == "DIURNO"]

    # 3. Tipo de combustible
    producto = df["producto"].map(normalizar)
    df["tipo"] = None
    for nombre, es_este in COMBUSTIBLES.items():
        df.loc[producto.map(es_este), "tipo"] = nombre
    df = df[df["tipo"].notna()]

    # 4. Datos válidos
    df["latitud"] = a_numero(df["latitud"])
    df["longitud"] = a_numero(df["longitud"])
    df["precio"] = a_numero(df["precio"])
    df["fecha"] = pd.to_datetime(df["fecha_vigencia"], errors="coerce").dt.strftime("%Y-%m-%d")
    df = df[df["latitud"].between(-34.8, -34.1) & df["longitud"].between(-59.2, -58.3)]
    df = df[df["precio"] > 0]

    # 5. Una fila por estación, con el último precio y la fecha de cada combustible
    df = df.sort_values("fecha_vigencia")
    clave = ["empresa", "direccion"]
    ultimo = df.groupby(clave + ["tipo"]).agg(precio=("precio", "last"), fecha=("fecha", "last")).reset_index()
    tabla = ultimo.pivot_table(index=clave, columns="tipo", values=["precio", "fecha"], aggfunc="first")
    tabla.columns = [f"{a}_{b}" for a, b in tabla.columns]
    datos = df.drop_duplicates(clave, keep="last").set_index(clave)
    est = datos[["localidad", "partido", "empresabandera", "latitud", "longitud"]].join(tabla).reset_index()

    salida = pd.DataFrame({
        "nombre": est["empresa"].str.strip().str.title(),
        "bandera": est["empresabandera"].map(limpiar_bandera),
        "partido": est["partido"],
        "localidad": est["localidad"].str.strip().str.title(),
        "direccion": est["direccion"].str.strip().str.title(),
        "latitud": est["latitud"].round(6),
        "longitud": est["longitud"].round(6),
    })
    for tipo in COMBUSTIBLES:
        salida[f"precio_{tipo}"] = est.get(f"precio_{tipo}")
        salida[f"fecha_{tipo}"] = est.get(f"fecha_{tipo}")
    return salida.sort_values(["partido", "nombre"]).reset_index(drop=True)



# ---------------- Descarga ----------------
DATASET_API = "http://datos.energia.gob.ar/api/3/action/package_show?id=precios-en-surtidor"
URL_RESPALDO = ("http://datos.energia.gob.ar/dataset/1c181390-5045-475e-94dc-410429be4b17/resource/"
                "80ac25de-a44a-4445-9215-090cf55cfda5/download/precios-en-surtidor-resolucin-3142016.csv")
MINIMO_ESTACIONES = 150  # si vienen menos, algo anda mal y no se toca nada


def url_del_archivo():
    """Busca el link de descarga en el catálogo del gobierno; si no puede, usa el conocido."""
    if os.environ.get("PRECIOS_URL"):
        return os.environ["PRECIOS_URL"]
    try:
        r = requests.get(DATASET_API, timeout=60)
        r.raise_for_status()
        for recurso in r.json()["result"]["resources"]:
            nombre = (recurso.get("name", "") + " " + recurso.get("url", "")).lower()
            if "314" in nombre and recurso.get("url", "").lower().endswith(".csv"):
                return recurso["url"]
    except Exception as e:
        print(f"No pude leer el catálogo ({e}); uso el link conocido.")
    return URL_RESPALDO


def descargar(url, intentos=3):
    for i in range(1, intentos + 1):
        try:
            print(f"Descargando (intento {i}): {url}")
            r = requests.get(url, timeout=180, headers={"User-Agent": "carga-barato-robot"})
            r.raise_for_status()
            if len(r.content) < 1_000_000:
                raise ValueError(f"El archivo es muy chico ({len(r.content)} bytes)")
            return r.content
        except Exception as e:
            print(f"  Falló: {e}")
            if i < intentos:
                time.sleep(30)
    raise SystemExit("No se pudo descargar el archivo. No se tocó Supabase.")


def leer_csv(contenido):
    try:
        return pd.read_csv(io.BytesIO(contenido), low_memory=False, encoding="utf-8")
    except UnicodeDecodeError:
        return pd.read_csv(io.BytesIO(contenido), low_memory=False, encoding="latin-1")


# ---------------- Supabase ----------------
def subir_a_supabase(est, url_supabase, clave):
    base = url_supabase.rstrip("/") + "/rest/v1/estaciones"
    headers = {"apikey": clave, "Content-Type": "application/json", "Prefer": "return=minimal"}
    marca = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    filas = est.astype(object).where(est.notna(), None).to_dict("records")
    for f in filas:
        f["actualizado"] = marca

    # 1) Insertar las nuevas
    for i in range(0, len(filas), 500):
        r = requests.post(base, json=filas[i:i + 500], headers=headers, timeout=60)
        if r.status_code >= 300:
            raise SystemExit(f"Error al insertar en Supabase ({r.status_code}): {r.text}")
    print(f"Insertadas {len(filas)} estaciones nuevas.")

    # 2) Borrar las anteriores (las que tienen una marca de tiempo más vieja)
    r = requests.delete(base, params={"actualizado": f"lt.{marca}"}, headers=headers, timeout=60)
    if r.status_code >= 300:
        raise SystemExit(f"Error al borrar las viejas ({r.status_code}): {r.text}")
    print("Borradas las estaciones de la carga anterior.")


if __name__ == "__main__":
    contenido = descargar(url_del_archivo())
    crudo = leer_csv(contenido)
    print(f"Registros totales: {len(crudo):,}")

    est = procesar(crudo)
    print(f"Estaciones en Zona Norte: {len(est)}")
    ultimo = est[[f"fecha_{t}" for t in COMBUSTIBLES]].max().max()
    print(f"Último precio informado: {ultimo}")
    if len(est) < MINIMO_ESTACIONES:
        raise SystemExit(f"Solo {len(est)} estaciones: parece un error. No se tocó Supabase.")

    os.makedirs("datos", exist_ok=True)
    est.to_csv("datos/estaciones_v2.csv", index=False, encoding="utf-8")  # copia en el repositorio

    if "--prueba" in sys.argv:
        print("Modo prueba: no se sube a Supabase.")
        sys.exit(0)

    url_supabase = os.environ.get("SUPABASE_URL")
    clave = os.environ.get("SUPABASE_SECRET_KEY")
    if not url_supabase or not clave:
        raise SystemExit("Faltan los secretos SUPABASE_URL y SUPABASE_SECRET_KEY.")
    subir_a_supabase(est, url_supabase, clave)
    print("¡Listo! Precios actualizados.")
