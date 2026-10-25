import { createClient } from '@supabase/supabase-js'

// Las dos claves se leen del archivo .env (y en Vercel, de sus variables de entorno)
const url = import.meta.env.VITE_SUPABASE_URL
const clave = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

export const supabase = url && clave ? createClient(url, clave) : null

const NUMEROS = ['latitud', 'longitud', 'precio_super', 'precio_premium', 'precio_gasoil', 'precio_gasoil_premium', 'precio_gnc']

// Trae las estaciones de la tabla "estaciones" (la actualiza el robot)
export async function obtenerEstaciones() {
  if (!supabase) {
    throw new Error('Faltan VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY en el archivo .env')
  }

  const { data, error } = await supabase.from('estaciones').select('*')
  if (error) throw new Error(error.message)

  console.log(`Supabase devolvió ${data.length} estaciones`, data)

  return data.map((e) => {
    const fila = { ...e }
    for (const campo of NUMEROS) fila[campo] = e[campo] == null ? null : Number(e[campo])
    return fila
  })
}
