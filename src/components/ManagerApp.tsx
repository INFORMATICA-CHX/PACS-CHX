import { useEffect } from 'react';
import { ManagerPanel } from '@/components/ManagerPanel';
import { usePacsStore } from '@/lib/usePacsStore';

export function ManagerApp() {
  const store = usePacsStore();
  const setServerProcessStatus = store.setServerProcessStatus;

  useEffect(() => {
    if (!window.localPacs?.getServerStatus) return;
    const syncStatus = async () => {
      const result = await window.localPacs!.getServerStatus();
      setServerProcessStatus(result);
    };
    void syncStatus();
    const timer = window.setInterval(() => void syncStatus(), 1000);
    return () => window.clearInterval(timer);
  }, [setServerProcessStatus]);

  const toggleServer = async () => {
    const result = store.status.running
      ? await window.localPacs?.stopServer()
      : await window.localPacs?.startServer();
    if (result) store.setServerProcessStatus(result);
    else store.setServerRunning(!store.status.running);
  };

  const openViewer = () => {
    if (!store.status.running) {
      store.addLog('warning', 'Abrir Viewer bloqueado: servico DICOM parado', 'UI');
      return;
    }
    if (window.localPacs?.openViewer) {
      void window.localPacs.openViewer(store.config.apiPort ?? 4000);
      return;
    }
    window.location.href = '/viewer';
  };

  return <ManagerPanel store={{ ...store, toggleServer }} onOpenViewer={openViewer} />;
}
