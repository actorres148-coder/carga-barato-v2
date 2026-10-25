import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import 'maplibre-gl/dist/maplibre-gl.css'
import './App.css'
import App from './App.jsx'

// Le indica al mapa dónde está su archivo auxiliar (necesario al publicar con Vite)
setWorkerUrl(workerUrl)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)