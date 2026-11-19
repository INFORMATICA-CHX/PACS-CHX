// Lançador do Gerador de Licenças do PACS CHX.
// Faz o mesmo que ABRIR-GERADOR-LICENCAS.bat, sem a janela do prompt:
//  1. garante o Electron (roda scripts\bootstrap-windows.ps1 -LicenseOnly se faltar);
//  2. abre o license-manager com o electron.exe do projeto.
//
// Compilar (de qualquer sistema com Go):
//   GOOS=windows GOARCH=amd64 go build -ldflags "-H=windowsgui -s -w" -o "Gerador de Licencas PACS CHX.exe"
package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

// Pasta do projeto usada quando o .exe não está dentro dela
// (permite copiar o .exe para a Área de Trabalho). Pode ser trocada com
// -ldflags "-X main.fallbackRoot=C:\caminho\do\projeto".
var fallbackRoot = `C:\Users\CHX\Desktop\PACS REVISADO\PACS CHX\project`

const (
	title            = "PACS CHX - Gerador de Licenças"
	mbIconError      = 0x10
	createNewConsole = 0x00000010
)

func messageBox(text string, flags uintptr) {
	proc := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString(title)
	proc.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), flags)
}

func fail(text string) {
	messageBox(text, mbIconError)
	os.Exit(1)
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func isProject(dir string) bool {
	return exists(filepath.Join(dir, "license-manager", "main.cjs"))
}

func findRoot() string {
	if exe, err := os.Executable(); err == nil {
		if real, err := filepath.EvalSymlinks(exe); err == nil {
			exe = real
		}
		if dir := filepath.Dir(exe); isProject(dir) {
			return dir
		}
	}
	if isProject(fallbackRoot) {
		return fallbackRoot
	}
	fail("Não encontrei a pasta do projeto PACS CHX.\n\n" +
		"Deixe este .exe na pasta do projeto (junto de license-manager) " +
		"ou crie um atalho para ele.")
	return ""
}

func main() {
	root := findRoot()
	electron := filepath.Join(root, "node_modules", "electron", "dist", "electron.exe")

	if !exists(electron) {
		// Mesmo preparo do .bat; abre um console para mostrar o progresso do npm.
		script := filepath.Join(root, "scripts", "bootstrap-windows.ps1")
		cmd := exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
			"-File", script, "-LicenseOnly")
		cmd.Dir = root
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNewConsole}
		if err := cmd.Run(); err != nil || !exists(electron) {
			fail("Não foi possível preparar o License Manager.\n\n" +
				"Verifique se o Node.js está instalado e a internet/antivírus, " +
				"ou rode ABRIR-GERADOR-LICENCAS.bat para ver o erro.")
		}
	}

	env := make([]string, 0, len(os.Environ()))
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(kv), "ELECTRON_RUN_AS_NODE=") {
			env = append(env, kv)
		}
	}

	cmd := exec.Command(electron, ".")
	cmd.Dir = filepath.Join(root, "license-manager")
	cmd.Env = env
	if err := cmd.Start(); err != nil {
		fail("Não foi possível abrir o License Manager:\n\n" + err.Error())
	}
	_ = cmd.Process.Release()
}
