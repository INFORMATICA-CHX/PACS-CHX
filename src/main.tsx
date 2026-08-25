import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import ViewerApp from './viewer-main.tsx';
import { IdleSessionGuard } from './components/IdleSessionGuard.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <IdleSessionGuard><ViewerApp /></IdleSessionGuard>
  </StrictMode>
);
