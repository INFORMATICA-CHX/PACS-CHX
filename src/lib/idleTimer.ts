import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, getClinicalToken, setClinicalToken } from './apiClient';

const WARNING_MS = 60_000;

export function useIdleTimer(timeoutMinutes: number, active: boolean, onTimeout: () => void) {
  const [warning, setWarning] = useState(false);
  const warningTimer = useRef<number>();
  const logoutTimer = useRef<number>();
  const lastReset = useRef(0);

  const clear = useCallback(() => {
    if (warningTimer.current) window.clearTimeout(warningTimer.current);
    if (logoutTimer.current) window.clearTimeout(logoutTimer.current);
  }, []);

  const expire = useCallback(async () => {
    if (!getClinicalToken()) return;
    try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch { /* local cleanup must still happen */ }
    setClinicalToken(null);
    sessionStorage.setItem('pacs_logout_message', 'Sessão encerrada por inatividade');
    setWarning(false);
    onTimeout();
  }, [onTimeout]);

  const reset = useCallback(() => {
    if (!active || !getClinicalToken()) return;
    clear(); setWarning(false); lastReset.current = Date.now();
    const total = Math.max(1, timeoutMinutes) * 60_000;
    warningTimer.current = window.setTimeout(() => setWarning(true), Math.max(0, total - WARNING_MS));
    logoutTimer.current = window.setTimeout(() => void expire(), total);
  }, [active, clear, expire, timeoutMinutes]);

  useEffect(() => {
    if (!active) { clear(); setWarning(false); return; }
    const activity = () => { if (Date.now() - lastReset.current >= 1000) reset(); };
    const passive: AddEventListenerOptions = { passive: true };
    for (const event of ['mousemove', 'keydown', 'click', 'scroll']) window.addEventListener(event, activity, passive);
    reset();
    return () => { clear(); for (const event of ['mousemove', 'keydown', 'click', 'scroll']) window.removeEventListener(event, activity); };
  }, [active, clear, reset]);

  return { warning, continueSession: reset };
}
