import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted fonts (Latin subset, weights the UI uses): no third-party request.
import '@fontsource/inter-tight/latin-400.css'
import '@fontsource/inter-tight/latin-500.css'
import '@fontsource/inter-tight/latin-600.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import './index.css'
import App from './App.tsx'
import { registerServiceWorker } from './lib/offline'

registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
