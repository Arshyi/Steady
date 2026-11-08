import { BrowserRouter, Routes, Route, Navigate } from 'react-router'
import { LiveProvider } from './live'
import { AppShell } from './components/AppShell'
import { Home } from './pages/Home'
import { Alerts } from './pages/Alerts'
import { Residents } from './pages/Residents'
import { Settings } from './pages/Settings'

export default function App() {
  return (
    <LiveProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route element={<AppShell />}>
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/residents" element={<Residents />} />
            <Route path="/residents/:id" element={<Residents />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
          {/* Old addresses now go to Alerts */}
          <Route path="/overview" element={<Navigate to="/alerts" replace />} />
          <Route path="/board" element={<Navigate to="/alerts" replace />} />
          <Route path="/dashboard" element={<Navigate to="/alerts" replace />} />
        </Routes>
      </BrowserRouter>
    </LiveProvider>
  )
}
