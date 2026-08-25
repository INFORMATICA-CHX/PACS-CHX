import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ManagerApp } from '@/components/ManagerApp';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ManagerApp />
  </StrictMode>,
);
