import { BrowserRouter, Routes, Route, Navigate } from 'react-router'
import { LiveProvider } from './live'
import { AppShell } from './components/AppShell'
import { RequireLogin } from './auth'
import { Home } from './pages/Home'
import { Alerts } from './pages/Alerts'
import { Residents } from './pages/Residents'
import { Settings } from './pages/Settings'
import { Register } from './pages/Register'
import { Staff } from './pages/Staff'

export default function App() {
  return (
    <LiveProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/register" element={<Register />} />
          <Route
            element={
              <RequireLogin>
                <AppShell />
              </RequireLogin>
            }
          >
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/residents" element={<Residents />} />
            <Route path="/residents/:id" element={<Residents />} />
            <Route path="/settings" element={<Settings />} />
            <Route
              path="/staff"
              element={
                <RequireLogin admin>
                  <Staff />
                </RequireLogin>
              }
            />
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
