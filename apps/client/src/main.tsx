import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { SessionProvider } from './lib/session';
import { ToastProvider } from './components/ui';

createRoot(document.getElementById('root')!).render(
  <SessionProvider>
    <ToastProvider>
      <App />
    </ToastProvider>
  </SessionProvider>
);
