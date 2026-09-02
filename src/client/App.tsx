import { Chat } from './components/Chat'

/**
 * The only default export in the project.
 *
 * Everything else uses named exports; this one is default because it is the single thing
 * `main.tsx` mounts, and a default keeps that call site free of a name to keep in sync.
 */
export default function App() {
  return <Chat />
}
