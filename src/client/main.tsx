import { createRoot } from 'react-dom/client'
import App from './App'

// The stylesheet is pulled in by index.html's <link>, not imported here. Doing both would
// make Bun's HTML bundler emit it twice.

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

createRoot(container).render(<App />)
