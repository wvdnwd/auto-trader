import { Routes, Route } from 'react-router-dom';
import { Dashboard } from './dashboard.js';
import { LanguageProvider } from './i18n.js';

/**
 * Root of the autonomous trading dashboard.
 *
 * Wrapped in {@link LanguageProvider} so every screen — including a copy of
 * this app opened by someone else — can switch between Dutch and English
 * independently, with no effect on any other visitor.
 */
export function TraderApp() {
  return (
    <LanguageProvider>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="*" element={<Dashboard />} />
      </Routes>
    </LanguageProvider>
  );
}
