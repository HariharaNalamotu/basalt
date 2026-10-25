import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from '@basalt/auth/react';
import { auth } from './auth';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider client={auth}>
      <App />
    </AuthProvider>
  </StrictMode>,
);
