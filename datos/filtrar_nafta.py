"""
TP PoC Datos Georreferenciados - Nafta más barata en Zona Norte
Filtra el dataset oficial de precios en surtidor (Secretaría de Energía)
y deja las estaciones de Zona Norte con su precio de nafta SÚPER y PREMIUM.
"""

import unicodedata
from pathlib import Path

import pandas as pd

# 1. CONFIGURACIÓN
ARCHIVO_ENTRADA = "precios-en-surtidor-resolucin-3142016.csv"
ARCHIVO_SALIDA = "nafta_zona_norte.csv"
DESDE = "2026-04"   # solo precios informados desde este mes
MAXIMO = 100        # la consigna pide entre 20 y 100

PARTIDOS = {
    "Tigre": [
        "TIGRE", "GENERAL PACHECO", "GRAL PACHECO", "GRAL. PACHECO", "DON TORCUATO",
        "EL TALAR", "BENAVIDEZ", "RINCON DE MILBERG", "NORDELTA", "TRONCOS DEL TALAR",
        "RICARDO ROJAS", "DIQUE LUJAN", "LOPEZ CAMELO", "TIGRE CENTRO",
    ],
    "San Fernando": ["SAN FERNANDO", "VICTORIA", "VIRREYES"],
    "San Isidro": [
        "SAN ISIDRO", "MARTINEZ", "ACASSUSO", "BECCAR", "BOULOGNE",
        "BOULOGNE SUR MER", "VILLA ADELINA",
    ],
    "Vicente López": [
        "VICENTE LOPEZ", "OLIVOS", "FLORIDA", "FLORIDA OESTE", "MUNRO", "LA LUCILA",
        "CARAPACHAY", "VILLA MARTELLI",
    ],
}


def normalizar(texto) -> str:
    """Mayúsculas y sin tildes: 'Martínez' -> 'MARTINEZ'."""
    texto = unicodedata.normalize("NFKD", str(texto)).encode("ascii", "ignore").decode()
    return " ".join(texto.upper().split())


def a_numero(serie):
    return pd.to_numeric(serie.astype(str).str.replace(",", ".", regex=False), errors="coerce")


def limpiar_bandera(texto) -> str:
    """'SHELL C.A.P.S.A.' -> 'SHELL', 'DAPSA S.A.' -> 'DAPSA'."""
    t = str(texto).strip().upper()
    for marca in ["SHELL", "YPF", "AXION", "PUMA", "GULF", "DAPSA"]:
        if t.startswith(marca):
            return marca
    return t if t and t != "NAN" else "SIN BANDERA"


def categorias(precios):
    """Barata / Precio medio / Cara: un tercio de las estaciones en cada una."""
    ordenados = sorted(precios.dropna())
    t1 = ordenados[len(ordenados) // 3]
    t2 = ordenados[len(ordenados) * 2 // 3]
    return precios.apply(lambda p: "Barata" if p < t1 else ("Precio medio" if p < t2 else "Cara"))


LOCALIDAD_A_PARTIDO = {normalizar(loc): p for p, locs in PARTIDOS.items() for loc in locs}

# 2. LEER EL DATASET
ruta = Path(ARCHIVO_ENTRADA)
if not ruta.exists():
    candidatos = sorted(Path(".").glob("*precios*.csv"))
    if not candidatos:
        raise SystemExit("No encontré el CSV. Tiene que estar en la misma carpeta que este script.")
    ruta = candidatos[0]

print(f"Leyendo {ruta} ...")
try:
    df = pd.read_csv(ruta, low_memory=False, encoding="utf-8")
except UnicodeDecodeError:
    df = pd.read_csv(ruta, low_memory=False, encoding="latin-1")

df.columns = [c.strip().lower() for c in df.columns]
print(f"Registros totales: {len(df):,}")

# 3. FILTROS
df = df[df["provincia"].map(normalizar).str.contains("BUENOS AIRES")]
df["partido"] = df["localidad"].map(normalizar).map(LOCALIDAD_A_PARTIDO)
df = df[df["partido"].notna()]
print(f"Zona Norte: {len(df):,}")

# Súper y premium (solo nafta, no gasoil ni GNC)
producto = df["producto"].map(normalizar)
df["tipo"] = None
df.loc[producto.str.contains("NAFTA") & producto.str.contains("SUPER"), "tipo"] = "super"
df.loc[producto.str.contains("NAFTA") & producto.str.contains("PREMIUM"), "tipo"] = "premium"
df = df[df["tipo"].notna()]

# Horario diurno (de noche el precio es el mismo)
if "tipohorario" in df.columns:
    df = df[df["tipohorario"].map(normalizar) == "DIURNO"]

df = df[df["indice_tiempo"].astype(str) >= DESDE]

df["latitud"] = a_numero(df["latitud"])
df["longitud"] = a_numero(df["longitud"])
df["precio"] = a_numero(df["precio"])
df = df[df["latitud"].between(-35, -34) & df["longitud"].between(-59, -58) & (df["precio"] > 0)]
print(f"Filas de súper y premium recientes: {len(df):,}")

# 4. UNA FILA POR ESTACIÓN, CON LOS DOS PRECIOS
df = df.sort_values("indice_tiempo")  # el último de cada estación es el más reciente
clave = ["empresa", "direccion"]

precios = df.pivot_table(index=clave, columns="tipo", values="precio", aggfunc="last")
datos = df.drop_duplicates(subset=clave, keep="last").set_index(clave)
est = datos.join(precios).reset_index()

# Necesitamos el precio súper sí o sí; la premium puede faltar en alguna estación
est = est[est["super"].notna()]
if "premium" not in est:
    est["premium"] = pd.NA
print(f"Estaciones únicas: {len(est):,}")

est = est.sort_values("indice_tiempo", ascending=False).head(MAXIMO)

# 5. CSV FINAL
bandera_col = "empresabandera" if "empresabandera" in est.columns else "empresa"

salida = pd.DataFrame({
    "nombre": est["empresa"].str.strip().str.title(),
    "bandera": est[bandera_col].map(limpiar_bandera),
    "partido": est["partido"],
    "localidad": est["localidad"].str.strip().str.title(),
    "direccion": est["direccion"].str.strip().str.title(),
    "latitud": est["latitud"].round(6),
    "longitud": est["longitud"].round(6),
    "precio_super": est["super"].round(2),
    "precio_premium": est["premium"].round(2),
    "fecha": est["indice_tiempo"].astype(str),
})
salida["valor"] = salida["precio_super"]                       # valor principal (consigna)
salida["categoria"] = categorias(salida["precio_super"])        # categoría según súper
salida["categoria_premium"] = categorias(salida["precio_premium"])
salida = salida.sort_values(["partido", "precio_super"])

salida.to_csv(ARCHIVO_SALIDA, index=False, encoding="utf-8")

# 6. RESUMEN
print("\n================ RESULTADO ================")
print(f"Archivo generado: {ARCHIVO_SALIDA}  ({len(salida)} estaciones)")

for nombre, col in [("SÚPER", "precio_super"), ("PREMIUM", "precio_premium")]:
    s = salida.dropna(subset=[col])
    if s.empty:
        continue
    barata = s.loc[s[col].idxmin()]
    cara = s.loc[s[col].idxmax()]
    print(f"\n--- NAFTA {nombre} ({len(s)} estaciones) ---")
    print(f"Precio promedio: ${s[col].mean():,.2f}")
    print(f"Más barata: ${barata[col]:,.2f} - {barata['bandera']} - {barata['direccion']} ({barata['localidad']})")
    print(f"Más cara:   ${cara[col]:,.2f} - {cara['bandera']} - {cara['direccion']} ({cara['localidad']})")

print("\nPrecio promedio por partido:")
print(salida.groupby("partido")[["precio_super", "precio_premium"]].mean().round(2))
print("\nEstaciones por categoría (súper):")
print(salida["categoria"].value_counts())
print("\nEstaciones por bandera:")
print(salida["bandera"].value_counts())