import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { startBridgeClient } from './services/agent/bridgeClient'
import { defaultMotionApiBase } from './stores/motionStore'

// Agent 桥接：让 MCP server 里的外部 Agent 能操作本编辑器。
// 静默失败（后端没开就不断重试），不影响编辑器本身使用。
let bridge: { stop: () => void } | null = null
if (typeof window !== 'undefined') {
  try {
    bridge = startBridgeClient(defaultMotionApiBase)
  } catch {
    bridge = null
  }
}
if (import.meta.hot) {
  import.meta.hot.dispose(() => bridge?.stop())
}

// 开发期调试钩子（生产构建里这段会被 tree-shake 掉）
if (import.meta.env.DEV) {
  void import('./core/weapon/debugHooks').then((m) => m.installDebugHooks())
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
