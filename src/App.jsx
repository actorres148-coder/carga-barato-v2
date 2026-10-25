import { useEffect, useMemo, useState } from 'react'
import DeckGL from '@deck.gl/react'
import { FlyToInterpolator } from '@deck.gl/core'
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import Map from 'react-map-gl/maplibre'
import { obtenerEstaciones } from './supabaseClient'

// ---------------- Configuración ----------------
const MAPA_BASE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json' // gratis, sin token
const VISTA_INICIAL = { longitude: -58.68, latitude: -34.47, zoom: 10.3, pitch: 0, bearing: 0 }
const TIGRE_CENTRO = { lat: -34.4255, lon: -58.5797 } // ejemplo si no hay ubicación
const LEJOS_KM = 15 // más lejos que esto de cualquier estación = fuera de Zona Norte
const RADIOS = [3, 5, 10]

const COMBUSTIBLES = {
  super: { nombre: 'Súper', largo: 'Nafta súper', unidad: 'litro', carga: 40 },
  premium: { nombre: 'Premium', largo: 'Nafta premium', unidad: 'litro', carga: 40 },
  gnc: { nombre: 'GNC', largo: 'GNC', unidad: 'm³', carga: 15 },
  gasoil: { nombre: 'Gasoil', largo: 'Gasoil', unidad: 'litro', carga: 40 },
  gasoil_premium: { nombre: 'Gasoil Premium', largo: 'Gasoil premium', unidad: 'litro', carga: 40 },
}

// Un precio es "actual" si se informó en los últimos 3 meses
const DIAS_ACTUAL = 90
const FECHA_CORTE = new Date(Date.now() - DIAS_ACTUAL * 86400000).toISOString().slice(0, 10)
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
const mesTexto = (f) => (f ? `${MESES[Number(f.slice(5, 7)) - 1]} ${f.slice(0, 4)}` : 'sin fecha')
const mesCorto = (f) => (f ? `${MESES[Number(f.slice(5, 7)) - 1].slice(0, 3)} ${f.slice(0, 4)}` : 's/f')

const CATEGORIAS = [
  { nombre: 'Barata', color: [26, 150, 65] },
  { nombre: 'Precio medio', color: [235, 170, 20] },
  { nombre: 'Cara', color: [215, 48, 39] },
]
const GRIS = [160, 166, 162]
const AZUL = [37, 99, 235]
const DORADO = [224, 164, 0]

const pesos = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 })

// ---------------- Utilidades ----------------
function distanciaKm(a, b) {
  const R = 6371
  const rad = (x) => (x * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLon = rad(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// Link de Google Maps: sin punto de partida, así arranca solo desde donde está la persona
const linkGoogleMaps = (e) =>
  `https://www.google.com/maps/dir/?api=1&destination=${e.latitud},${e.longitud}&travelmode=driving&dir_action=navigate`

const textoKm = (d) => (d < 1 ? `${Math.round(d * 1000)} m` : `${d.toFixed(1).replace('.', ',')} km`)

// ---------------- App ----------------
export default function App() {
  const [estaciones, setEstaciones] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  const [combustible, setCombustible] = useState(null) // null hasta que el usuario elige
  const [yo, setYo] = useState(null) // { lat, lon }
  const [radioKm, setRadioKm] = useState(5)
  const [aviso, setAviso] = useState(null)
  const [buscando, setBuscando] = useState(false)
  const [pedirNafta, setPedirNafta] = useState(false)
  const [vista, setVista] = useState(VISTA_INICIAL)

  // 1) Traer los datos de Supabase
  useEffect(() => {
    obtenerEstaciones()
      .then(setEstaciones)
      .catch((e) => setError(e.message))
      .finally(() => setCargando(false))
  }, [])

  // 2) Estaciones con el precio del combustible elegido (súper por defecto antes de elegir)
  const tipo = combustible ?? 'super'
  const lista = useMemo(() => {
    const con = estaciones
      .filter((e) => e[`precio_${tipo}`] != null)
      .map((e) => {
        const fecha = e[`fecha_${tipo}`] ? String(e[`fecha_${tipo}`]).slice(0, 10) : null
        return { ...e, precio: e[`precio_${tipo}`], fecha, actual: !!fecha && fecha >= FECHA_CORTE }
      })
    // Precios absurdos (errores de carga) no cuentan como actuales
    const p = con.filter((e) => e.actual).map((e) => e.precio).sort((a, b) => a - b)
    const mediana = p[Math.floor(p.length / 2)]
    if (mediana) con.forEach((e) => { if (e.actual && (e.precio < mediana * 0.8 || e.precio > mediana * 1.35)) e.actual = false })
    return con
  }, [estaciones, tipo])
  const actuales = useMemo(() => lista.filter((e) => e.actual), [lista])

  // 3) Cortes de categoría: un tercio de las estaciones en cada color
  const cortes = useMemo(() => {
    const p = actuales.map((e) => e.precio).sort((a, b) => a - b)
    if (!p.length) return [0, 0]
    return [p[Math.floor(p.length / 3)], p[Math.floor((p.length * 2) / 3)]]
  }, [actuales])

  const categoriaDe = (precio) => (precio < cortes[0] ? CATEGORIAS[0] : precio < cortes[1] ? CATEGORIAS[1] : CATEGORIAS[2])
  const colorDe = (e) => (e.actual ? categoriaDe(e.precio).color : GRIS)

  // 4) Indicadores del dashboard (calculados con los datos de Supabase)
  const kpis = useMemo(() => {
    if (!actuales.length) return null
    const barata = actuales.reduce((a, b) => (b.precio < a.precio ? b : a))
    const cara = actuales.reduce((a, b) => (b.precio > a.precio ? b : a))
    const promedio = actuales.reduce((s, e) => s + e.precio, 0) / actuales.length
    return { total: estaciones.length, promedio, barata, cara }
  }, [actuales, estaciones.length])

  // 5) Estaciones dentro del radio: por cercanía (o por precio, si el usuario elige)
  const [orden, setOrden] = useState('cerca')
  const cercanas = useMemo(() => {
    if (!yo) return []
    const dentro = lista
      .map((e) => ({ ...e, dist: distanciaKm(yo, { lat: e.latitud, lon: e.longitud }) }))
      .filter((e) => e.dist <= radioKm)
    if (orden === 'cerca') return dentro.sort((a, b) => a.dist - b.dist)
    // Por precio: primero las actuales de la más barata a la más cara, después las no actualizadas
    return dentro.sort((a, b) => b.actual - a.actual || (a.actual ? a.precio - b.precio : (b.fecha || '').localeCompare(a.fecha || '')) || a.dist - b.dist)
  }, [lista, yo, radioKm, orden])
  const cercanasActuales = cercanas.filter((e) => e.actual)

  const masCercana = useMemo(() => {
    if (!yo || !lista.length) return null
    return lista
      .map((e) => ({ ...e, dist: distanciaKm(yo, { lat: e.latitud, lon: e.longitud }) }))
      .sort((a, b) => a.dist - b.dist)[0]
  }, [lista, yo])

  // La más barata: solo entre las que tienen precio actual
  const mejor = cercanasActuales.length ? cercanasActuales.reduce((a, b) => (b.precio < a.precio || (b.precio === a.precio && b.dist < a.dist) ? b : a)) : null
  const masCaraCerca = cercanasActuales.length ? cercanasActuales.reduce((a, b) => (b.precio > a.precio ? b : a)) : null
  const promedioCerca = cercanasActuales.length ? cercanasActuales.reduce((s, e) => s + e.precio, 0) / cercanasActuales.length : 0

  // ---------------- Acciones ----------------
  const [origen, setOrigen] = useState(null) // de dónde salió tu ubicación: 'gps', 'mapa' o 'ejemplo'
  const [elegida, setElegida] = useState(null) // id de la estación que tocaste

  // Camino por calle hasta la estación que tocaste (OSRM: servicio gratuito, sin clave)
  const [ruta, setRuta] = useState(null) // { path, km, min, estado: 'cargando' | 'ok' | 'error' }
  const destino = lista.find((e) => e.id === elegida) ?? null

  useEffect(() => {
    if (!destino || !yo) {
      setRuta(null)
      return
    }
    const recta = [
      [yo.lon, yo.lat],
      [destino.longitud, destino.latitud],
    ]
    setRuta({ path: recta, estado: 'cargando' })
    const control = new AbortController()
    const url = `https://router.project-osrm.org/route/v1/driving/${yo.lon},${yo.lat};${destino.longitud},${destino.latitud}?overview=full&geometries=geojson`
    fetch(url, { signal: control.signal })
      .then((res) => res.json())
      .then((json) => {
        const r = json.routes?.[0]
        if (!r) throw new Error('Sin camino')
        setRuta({ path: r.geometry.coordinates, km: r.distance / 1000, min: r.duration / 60, estado: 'ok' })
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setRuta({ path: recta, estado: 'error' }) // si falla, línea recta
      })
    return () => control.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destino?.id, destino?.latitud, yo?.lat, yo?.lon])

  function volarA(lon, lat, zoom) {
    setVista((v) => ({ ...v, longitude: lon, latitude: lat, zoom, transitionDuration: 800, transitionInterpolator: new FlyToInterpolator() }))
  }

  function ubicar(lat, lon, mensaje = null, desde = 'mapa') {
    setYo({ lat, lon })
    setOrigen(desde)
    setAviso(mensaje)
    volarA(lon, lat, radioKm >= 10 ? 11 : radioKm >= 5 ? 12 : 13)
  }

  function usarEjemplo(motivo) {
    ubicar(TIGRE_CENTRO.lat, TIGRE_CENTRO.lon, `${motivo} Te mostramos un ejemplo desde Tigre centro. También podés tocar el mapa para elegir otro punto.`, 'ejemplo')
  }

  function usarMiUbicacion() {
    if (!navigator.geolocation) return usarEjemplo('Este navegador no permite usar la ubicación.')
    setBuscando(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setBuscando(false)
        const aqui = { lat: pos.coords.latitude, lon: pos.coords.longitude }
        const minimo = Math.min(...estaciones.map((e) => distanciaKm(aqui, { lat: e.latitud, lon: e.longitud })))
        if (minimo > LEJOS_KM) usarEjemplo(`Estás a ${Math.round(minimo)} km de Zona Norte.`)
        else ubicar(aqui.lat, aqui.lon, null, 'gps')
      },
      () => {
        setBuscando(false)
        usarEjemplo('No pudimos obtener tu ubicación.')
      },
      { enableHighAccuracy: true, timeout: 10000 }
    )
  }

  // Tocaste una estación de la lista: el mapa se acomoda para mostrar el camino completo
  function elegirDeLaLista(e) {
    setElegida(e.id)
    // En el celular el mapa está arriba: subimos para que se vea el camino
    if (window.innerWidth <= 860) document.querySelector('.mapa')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    if (!yo) return volarA(e.longitud, e.latitud, 14)
    const d = distanciaKm(yo, { lat: e.latitud, lon: e.longitud })
    volarA((yo.lon + e.longitud) / 2, (yo.lat + e.latitud) / 2, d < 1.5 ? 14 : d < 3.5 ? 13 : 12)
  }

  function elegirCombustible(c) {
    setCombustible(c)
    setPedirNafta(false)
  }

  function clickEnMapa(info) {
    // Tocaste una estación: se muestra su cartel con nombre y precio (tu ubicación no se mueve)
    if (info.layer?.id === 'estaciones' && info.object) return setElegida(info.object.id)
    if (info.object) return // tocaste tu punto o un cartel
    setElegida(null)
    if (!combustible) return setPedirNafta(true)
    if (origen === 'gps') return // con tu ubicación real, el punto azul queda fijo
    if (info.coordinate) ubicar(info.coordinate[1], info.coordinate[0])
  }

  // Nombre de cada partido, en el centro de sus estaciones
  const partidos = useMemo(() => {
    const g = {}
    estaciones.forEach((e) => { if (e.partido) (g[e.partido] ??= []).push(e) })
    return Object.entries(g).map(([nombre, es]) => ({
      nombre: nombre.toUpperCase(),
      pos: [es.reduce((s, e) => s + e.longitud, 0) / es.length, es.reduce((s, e) => s + e.latitud, 0) / es.length],
    }))
  }, [estaciones])

  // ---------------- Capas de deck.gl ----------------
  const esMejor = (d) => mejor && d.id === mejor.id
  const estacionElegida = lista.find((e) => e.id === elegida && !esMejor(e))
  const enRadio = new Set(cercanas.map((e) => e.id))

  const capas = [
    new TextLayer({
      id: 'partidos',
      data: partidos,
      getPosition: (d) => d.pos,
      getText: (d) => d.nombre,
      getSize: 13,
      getColor: [91, 103, 96, 140],
      fontFamily: 'Barlow Condensed, Arial Narrow, sans-serif',
      fontWeight: 700,
      characterSet: 'auto',
    }),
    yo &&
      new ScatterplotLayer({
        id: 'radio',
        data: [yo],
        getPosition: (d) => [d.lon, d.lat],
        getRadius: radioKm * 1000,
        radiusUnits: 'meters',
        stroked: true,
        getFillColor: [...AZUL, 25],
        getLineColor: [...AZUL, 160],
        lineWidthMinPixels: 1.5,
        updateTriggers: { getRadius: radioKm },
      }),
    ruta &&
      new PathLayer({
        id: 'ruta',
        data: [ruta],
        getPath: (d) => d.path,
        getColor: ruta.estado === 'ok' ? [...AZUL, 230] : [...AZUL, 130],
        getWidth: 6,
        widthUnits: 'pixels',
        capRounded: true,
        jointRounded: true,
        updateTriggers: { getPath: ruta.path, getColor: ruta.estado },
      }),
    new ScatterplotLayer({
      id: 'estaciones',
      data: lista,
      getPosition: (d) => [d.longitud, d.latitud], // deck.gl usa [LONGITUD, LATITUD]
      getRadius: (d) => (esMejor(d) ? 11 : 7),
      radiusUnits: 'pixels',
      getFillColor: (d) => [...colorDe(d), !yo || enRadio.has(d.id) ? 235 : 70],
      getLineColor: (d) => (esMejor(d) ? DORADO : [255, 255, 255]),
      getLineWidth: (d) => (esMejor(d) ? 3.5 : 1.2),
      lineWidthUnits: 'pixels',
      stroked: true,
      pickable: true,
      autoHighlight: true,
      highlightColor: [20, 20, 20, 80],
      updateTriggers: {
        getRadius: mejor?.id,
        getFillColor: [tipo, yo?.lat, yo?.lon, radioKm, cortes[0], cortes[1]],
        getLineColor: mejor?.id,
        getLineWidth: mejor?.id,
      },
    }),
    mejor &&
      new TextLayer({
        id: 'etiqueta-mejor',
        data: [mejor],
        getPosition: (d) => [d.longitud, d.latitud],
        getText: (d) => `${d.bandera} · ${pesos.format(d.precio)}`,
        getPixelOffset: [0, -26],
        getSize: 15,
        fontFamily: 'Barlow Condensed, Arial Narrow, sans-serif',
        fontWeight: 700,
        characterSet: 'auto',
        getColor: [20, 20, 20],
        background: true,
        getBackgroundColor: DORADO,
        backgroundPadding: [6, 3],
      }),
    estacionElegida &&
      new ScatterplotLayer({
        id: 'anillo-elegida',
        data: [estacionElegida],
        getPosition: (d) => [d.longitud, d.latitud],
        getRadius: 14,
        radiusUnits: 'pixels',
        filled: false,
        stroked: true,
        getLineColor: [23, 32, 27],
        lineWidthMinPixels: 2,
      }),
    estacionElegida &&
      new TextLayer({
        id: 'etiqueta-elegida',
        data: [estacionElegida],
        getPosition: (d) => [d.longitud, d.latitud],
        getText: (d) => `${d.bandera} · ${pesos.format(d.precio)}${d.actual ? '' : ` · últ. precio ${mesCorto(d.fecha)}`}`,
        getPixelOffset: [0, -26],
        getSize: 15,
        fontFamily: 'Barlow Condensed, Arial Narrow, sans-serif',
        fontWeight: 700,
        characterSet: 'auto',
        getColor: [20, 20, 20],
        background: true,
        getBackgroundColor: (d) => (d.actual ? [255, 255, 255] : [255, 236, 179]),
        getBorderColor: [23, 32, 27],
        getBorderWidth: 1,
        backgroundPadding: [6, 3],
      }),
    yo &&
      new ScatterplotLayer({
        id: 'yo',
        data: [yo],
        getPosition: (d) => [d.lon, d.lat],
        getRadius: 8,
        radiusUnits: 'pixels',
        getFillColor: AZUL,
        getLineColor: [255, 255, 255],
        lineWidthMinPixels: 3,
        stroked: true,
      }),
  ].filter(Boolean)

  // Etapa 6: datos al pasar el mouse
  function tooltip({ object, layer }) {
    if (!object || layer?.id !== 'estaciones') return null
    const cat = categoriaDe(object.precio)
    const dist = yo ? textoKm(distanciaKm(yo, { lat: object.latitud, lon: object.longitud })) : null
    return {
      html: `
        <div class="tt-titulo">${object.bandera}</div>
        <div class="tt-sub">${object.nombre}</div>
        <div>${object.direccion}, ${object.localidad} · ${object.partido}</div>
        <div class="tt-precio">${pesos.format(object.precio)} <small>/ ${COMBUSTIBLES[tipo].unidad} · ${COMBUSTIBLES[tipo].nombre}</small></div>
        ${object.actual
          ? `<span class="tt-cat" style="background: rgb(${cat.color.join(',')})">${cat.nombre}</span>`
          : `<span class="tt-cat" style="background: rgb(120,126,122)">Precio no actualizado</span>`}
        ${dist ? `<div class="tt-sub">a ${dist} de vos</div>` : ''}
        <div class="tt-sub">${object.actual ? 'Informado' : '⚠️ Último precio informado'}: <strong>${mesTexto(object.fecha)}</strong></div>`,
      style: {
        background: '#ffffff',
        color: '#17201b',
        border: '1px solid #dde3de',
        borderRadius: '8px',
        padding: '8px 10px',
        boxShadow: '0 4px 14px rgba(0,0,0,.18)',
        fontFamily: 'Barlow, system-ui, sans-serif',
        fontSize: '13px',
        lineHeight: '1.4',
      },
    }
  }

  // ---------------- Pantalla ----------------
  return (
    <div className="app">
      <header className="encabezado">
        <h1>⛽ Cargá Barato</h1>
        <p>Nafta, gasoil y GNC en Zona Norte: estaciones cercanas y precios informados.</p>
      </header>

      {kpis && (
        <section className="kpis">
          <Kpi valor={kpis.total} titulo="Estaciones" sub={`en ${partidos.length} partidos`} />
          <Kpi valor={pesos.format(kpis.promedio)} titulo="Precio promedio" sub={`${COMBUSTIBLES[tipo].largo} por ${COMBUSTIBLES[tipo].unidad}`} />
          <Kpi valor={pesos.format(kpis.barata.precio)} titulo="Más barata" sub={`${kpis.barata.bandera} · ${kpis.barata.localidad}`} />
          <Kpi valor={pesos.format(kpis.cara.precio)} titulo="Más cara" sub={`${kpis.cara.bandera} · ${kpis.cara.localidad}`} />
        </section>
      )}

      <section className="principal">
        <aside className="panel">
          <div className="paso">
            <span className="num">1</span>¿Qué cargás?
          </div>
          <div className={`combustibles ${pedirNafta ? 'resaltar' : ''}`}>
            {Object.entries(COMBUSTIBLES).map(([clave, c]) => (
              <button key={clave} className={combustible === clave ? 'activo' : ''} onClick={() => elegirCombustible(clave)}>
                {c.nombre}
              </button>
            ))}
          </div>

          <div className={`paso ${combustible ? '' : 'apagado'}`}>
            <span className="num">2</span>¿Dónde estás?
          </div>
          <button className="ubicar" onClick={usarMiUbicacion} disabled={!combustible || buscando || cargando}>
            {buscando ? 'Buscando tu ubicación…' : yo ? '📍 Actualizar mi ubicación' : '📍 Usar mi ubicación'}
          </button>

          <div className="radios">
            <span>Buscar a menos de</span>
            <div>
              {RADIOS.map((r) => (
                <button key={r} className={radioKm === r ? 'activo' : ''} onClick={() => setRadioKm(r)}>
                  {r} km
                </button>
              ))}
            </div>
          </div>

          {aviso && <div className="aviso">{aviso}</div>}

          <Resultado
            combustible={combustible}
            yo={yo}
            radioKm={radioKm}
            cercanas={cercanas}
            mejor={mejor}
            masCercana={masCercana}
            masCaraCerca={masCaraCerca}
            promedioCerca={promedioCerca}
            colorDe={colorDe}
            orden={orden}
            setOrden={setOrden}
            tipo={tipo}
            alElegir={elegirDeLaLista}
          />
        </aside>

        <div className={`mapa ${destino ? 'con-ruta' : ''}`}>
          {cargando && <div className="estado">Cargando estaciones desde Supabase…</div>}
          {error && (
            <div className="estado error">
              <strong>No se pudieron cargar los datos.</strong>
              <br />
              {error}
            </div>
          )}
          {!cargando && !error && estaciones.length === 0 && (
            <div className="estado error">La tabla "puntos" está vacía o falta la política de lectura en Supabase.</div>
          )}

          <DeckGL
            initialViewState={vista}
            controller={true}
            pickingRadius={12}
            layers={capas}
            getTooltip={tooltip}
            onClick={clickEnMapa}
            getCursor={({ isHovering }) => (isHovering ? 'pointer' : 'crosshair')}
          >
            <Map mapStyle={MAPA_BASE} />
          </DeckGL>

          {destino && (
            <div className="ruta">
              <div className="ruta-arriba">
                <div>
                  <div className="ruta-sub">{yo ? 'Camino hasta' : 'Estación elegida'}</div>
                  <strong>
                    {destino.bandera} · {pesos.format(destino.precio)}
                  </strong>
                  {!destino.actual && <div className="ruta-sub">⚠️ Último precio informado: {mesTexto(destino.fecha)}</div>}
                </div>
                <button className="ruta-cerrar" onClick={() => setElegida(null)} aria-label="Cerrar">
                  ✕
                </button>
              </div>
              {ruta?.estado === 'cargando' && <div className="ruta-sub">Calculando el camino…</div>}
              {ruta?.estado === 'ok' && (
                <>
                  <div className="ruta-dato">
                    {textoKm(ruta.km)} · {Math.max(1, Math.round(ruta.min))} min
                  </div>
                  <div className="ruta-sub">en auto, por calle</div>
                </>
              )}
              {ruta?.estado === 'error' && <div className="ruta-sub">No pudimos calcular el camino por calle; te mostramos la línea recta.</div>}
              <a className="ruta-boton" href={linkGoogleMaps(destino)} target="_blank" rel="noopener noreferrer">
                🧭 Cómo llegar con Google Maps
              </a>
            </div>
          )}

          <Leyenda tipo={tipo} cortes={cortes} />
        </div>
      </section>

      <footer className="pie">
        Datos: Secretaría de Energía, Precios en surtidor (Res. 314/2016). Cada estación muestra el último precio que informó; en gris, las que no lo actualizan hace más de 3 meses. · Base de datos: Supabase · Mapa: deck.gl
      </footer>
    </div>
  )
}

// ---------------- Componentes ----------------
function Kpi({ valor, titulo, sub }) {
  return (
    <div className="kpi">
      <div className="kpi-valor">{valor}</div>
      <div className="kpi-titulo">{titulo}</div>
      <div className="kpi-sub">{sub}</div>
    </div>
  )
}

function Resultado({ combustible, yo, radioKm, cercanas, mejor, masCercana, masCaraCerca, promedioCerca, colorDe, orden, setOrden, tipo, alElegir }) {
  const c = COMBUSTIBLES[tipo]
  if (!combustible) {
    return (
      <div className="tarjeta vacia">
        Elegí qué cargás: <strong>Súper</strong>, <strong>Premium</strong>, <strong>GNC</strong> o <strong>Gasoil</strong>. Después te ubicamos y te mostramos las estaciones cerca tuyo.
      </div>
    )
  }
  if (!yo) {
    return (
      <div className="tarjeta vacia">
        Tocá <strong>Usar mi ubicación</strong> y permití el acceso. También podés tocar el mapa donde estés.
      </div>
    )
  }
  if (!cercanas.length) {
    return (
      <div className="mejor">
        <div className="etiqueta">No hay estaciones a menos de {radioKm} km</div>
        {masCercana && (
          <>
            <div className="nombre">La más cercana: {masCercana.bandera} · {masCercana.direccion}</div>
            <div className="detalle">
              {masCercana.localidad} · a {textoKm(masCercana.dist)} · {pesos.format(masCercana.precio)}
            </div>
          </>
        )}
        <div className="ahorro">Probá con 10 km o tocá otro punto del mapa.</div>
      </div>
    )
  }

  const diferencia = mejor ? promedioCerca - mejor.precio : 0
  const ahorro = mejor && masCaraCerca ? (masCaraCerca.precio - mejor.precio) * c.carga : 0
  return (
    <>
      {mejor ? (
        <div className="mejor">
          <div className="etiqueta">⭐ {c.largo} más barata cerca tuyo</div>
          <div className="precio">
            {pesos.format(mejor.precio)} <small>/ {c.unidad}</small>
          </div>
          <div className="nombre">
            {mejor.bandera} · {mejor.direccion}
          </div>
          <div className="detalle">
            {mejor.localidad} · a {textoKm(mejor.dist)} · informado en {mesTexto(mejor.fecha)}
          </div>
          <div className="promedio">
            <span>Promedio cerca tuyo</span>
            <strong>{pesos.format(promedioCerca)}</strong>
          </div>
          {diferencia >= 1 && <div className="detalle">Está {pesos.format(diferencia)} por {c.unidad} debajo del promedio.</div>}
          {ahorro > 0 && (
            <div className="ahorro">
              Cargando {c.carga} {c.unidad === 'litro' ? 'litros' : c.unidad} ahorrás {pesos.format(ahorro)} frente a la más cara de la zona.
            </div>
          )}
        </div>
      ) : (
        <div className="mejor">
          <div className="etiqueta">Sin precios actualizados cerca</div>
          <div className="detalle">Ninguna estación a menos de {radioKm} km informó precio de {c.largo.toLowerCase()} en los últimos 3 meses. Abajo ves el último precio que informó cada una.</div>
        </div>
      )}

      <div className="tarjeta lista">
        <h3 className="lista-titulo">
          <span>
            {cercanas.length} estaciones a menos de {radioKm} km
          </span>
          <span className="orden">
            <button className={orden === 'cerca' ? 'activo' : ''} onClick={() => setOrden('cerca')}>
              Cercanía
            </button>
            <button className={orden === 'precio' ? 'activo' : ''} onClick={() => setOrden('precio')}>
              Precio
            </button>
          </span>
        </h3>
        <ol>
          {cercanas.map((e) => (
            <li key={e.id} className={e.actual ? '' : 'vieja'}>
              <button onClick={() => alElegir(e)}>
                <span className="punto" style={{ background: `rgb(${colorDe(e).join(',')})` }} />
                <span className="li-texto">
                  <span className="li-nombre">
                    {mejor && e.id === mejor.id ? '⭐ ' : ''}
                    {e.bandera} · {e.direccion}
                  </span>
                  <span className="li-sub">
                    {e.localidad}
                    {e.actual ? '' : ` · ⚠️ último precio: ${mesCorto(e.fecha)}`}
                  </span>
                </span>
                <span className="li-derecha">
                  <span className="li-precio">{pesos.format(e.precio)}</span>
                  <span className="li-sub">{textoKm(e.dist)}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </>
  )
}

function Leyenda({ tipo, cortes }) {
  const rangos = [`hasta ${pesos.format(cortes[0] - 1)}`, `${pesos.format(cortes[0])} a ${pesos.format(cortes[1] - 1)}`, `desde ${pesos.format(cortes[1])}`]
  return (
    <div className="leyenda">
      <div className="leyenda-titulo">{COMBUSTIBLES[tipo].nombre} por {COMBUSTIBLES[tipo].unidad}</div>
      {CATEGORIAS.map((c, i) => (
        <div key={c.nombre} className="leyenda-item">
          <span className="punto" style={{ background: `rgb(${c.color.join(',')})` }} />
          <span>{c.nombre}</span>
          <span className="rango">{rangos[i]}</span>
        </div>
      ))}
      <div className="leyenda-item">
        <span className="punto" style={{ background: 'rgb(160,166,162)' }} />
        <span>Precio no actualizado</span>
      </div>
      <div className="separador leyenda-extra" />
      <div className="leyenda-item leyenda-extra">
        <span className="punto borde-dorado" />
        <span>La más barata cerca tuyo</span>
      </div>
      <div className="leyenda-item leyenda-extra">
        <span className="punto" style={{ background: 'rgb(37,99,235)' }} />
        <span>Vos</span>
      </div>
      <div className="leyenda-item leyenda-extra">
        <span className="punto" style={{ background: 'rgba(120,120,120,.35)' }} />
        <span>Fuera de la distancia elegida</span>
      </div>
    </div>
  )
}
