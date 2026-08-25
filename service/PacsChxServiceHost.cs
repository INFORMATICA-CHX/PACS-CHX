using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;

namespace PacsChxService
{
    public class PacsChxServiceHost : ServiceBase
    {
        private Process child;
        private string resourcesDir;
        private string dataDir;
        private string logPath;

        public PacsChxServiceHost()
        {
            ServiceName = "PACS CHX Server";
            CanStop = true;
            CanShutdown = true;
        }

        public static void Main(string[] args)
        {
            if (args.Length > 0 && args[0].Equals("--console", StringComparison.OrdinalIgnoreCase))
            {
                var service = new PacsChxServiceHost();
                service.OnStart(args);
                Console.WriteLine("PACS CHX Server rodando. Pressione Enter para encerrar.");
                Console.ReadLine();
                service.OnStop();
                return;
            }

            Run(new PacsChxServiceHost());
        }

        protected override void OnStart(string[] args)
        {
            resourcesDir = ResolveResourcesDir();
            dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "PACS CHX");
            Directory.CreateDirectory(dataDir);
            Directory.CreateDirectory(Path.Combine(dataDir, "logs"));
            logPath = Path.Combine(dataDir, "logs", "service-host.log");
            StartChild();
        }

        protected override void OnStop()
        {
            StopChild();
        }

        protected override void OnShutdown()
        {
            StopChild();
        }

        private void StartChild()
        {
            var nodePath = Path.Combine(resourcesDir, "node", "node.exe");
            var pythonPath = Path.Combine(resourcesDir, "python", "python.exe");
            var serverRoot = Path.Combine(resourcesDir, "app.asar.unpacked", "server");
            var serverEntry = Path.Combine(serverRoot, "build", "server-loader.cjs");

            if (!File.Exists(nodePath)) throw new FileNotFoundException("node.exe nao encontrado.", nodePath);
            if (!File.Exists(serverEntry)) throw new FileNotFoundException("server-loader.cjs nao encontrado.", serverEntry);

            var startInfo = new ProcessStartInfo
            {
                FileName = nodePath,
                Arguments = Quote(serverEntry),
                WorkingDirectory = serverRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };

            startInfo.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "";
            startInfo.EnvironmentVariables["PACS_SERVER_ROOT"] = serverRoot;
            startInfo.EnvironmentVariables["PACS_CONFIG_DIR"] = dataDir;
            if (File.Exists(pythonPath)) startInfo.EnvironmentVariables["PACS_PYTHON_PATH"] = pythonPath;

            child = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            child.OutputDataReceived += (sender, eventArgs) => { if (eventArgs.Data != null) Log(eventArgs.Data); };
            child.ErrorDataReceived += (sender, eventArgs) => { if (eventArgs.Data != null) Log("ERROR " + eventArgs.Data); };
            child.Exited += (sender, eventArgs) =>
            {
                Log("Servidor Node encerrou com codigo " + child.ExitCode + ".");
                child.Dispose();
                child = null;
            };

            child.Start();
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            Log("Servidor Node iniciado. PID " + child.Id + ".");
        }

        private void StopChild()
        {
            try
            {
                if (child == null || child.HasExited) return;
                Log("Encerrando servidor Node. PID " + child.Id + ".");
                child.Kill();
                child.WaitForExit(10000);
            }
            catch (Exception error)
            {
                Log("Falha ao encerrar servidor Node: " + error.Message);
            }
            finally
            {
                if (child != null)
                {
                    child.Dispose();
                    child = null;
                }
            }
        }

        private string ResolveResourcesDir()
        {
            var serviceDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var parent = Directory.GetParent(serviceDir);
            return parent != null ? parent.FullName : serviceDir;
        }

        private void Log(string message)
        {
            try
            {
                File.AppendAllText(logPath, DateTime.Now.ToString("s") + " " + message + Environment.NewLine);
            }
            catch
            {
                // Service logging must never crash the service host.
            }
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }
    }
}
