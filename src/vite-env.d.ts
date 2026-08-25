/// <reference types="vite/client" />

interface Window {
  localPacs?: {
    startServer: () => Promise<{ running: boolean; pid: number | null; startedAt: string | null; lastError: string | null }>;
    stopServer: () => Promise<{ running: boolean; pid: number | null; startedAt: string | null; lastError: string | null }>;
    getServerStatus: () => Promise<{ running: boolean; pid: number | null; startedAt: string | null; lastError: string | null }>;
    openViewer: (apiPort?: number) => Promise<void | { opened: boolean }>;
    openFolder: () => Promise<string | null>;
  };
}
