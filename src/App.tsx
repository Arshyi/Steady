import { BrowserRouter, Routes, Route, Navigate } from 'react-router'
import { AlertsProvider } from './alerts'
import { AppShell } from './components/AppShell'
import { Home } from './pages/Home'
import { Overview } from './pages/Overview'
import { Alerts } from './pages/Alerts'
import { Residents } from './pages/Residents'
import { Settings } from './pages/Settings'

export default function App() {
  return (
    <AlertsProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route element={<AppShell />}>
            <Route path="/overview" element={<Overview />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/residents" element={<Residents />} />
            <Route path="/residents/:id" element={<Residents />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
          <Route path="/board" element={<Navigate to="/overview" replace />} />
          <Route path="/dashboard" element={<Navigate to="/overview" replace />} />
        </Routes>
      </BrowserRouter>
    </AlertsProvider>
  )
}
