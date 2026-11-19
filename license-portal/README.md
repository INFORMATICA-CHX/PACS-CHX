# Portal online de licenças PACS CHX

Aplicação isolada em Node.js para emitir licenças `CHX1` compatíveis com a chave pública atual do PACS. O portal não altera os arquivos do PACS nem do License Manager local. As entradas do cliente são usadas apenas durante a requisição e não são gravadas em histórico pelo portal.

## Requisitos de hospedagem

Use uma aplicação Node.js da Hostinger nos planos Business/Cloud ou um VPS. A aplicação precisa executar `npm start` com Node.js 20 ou superior, HTTPS e variáveis de ambiente secretas. Hospedagem compartilhada estática não executa o serviço que assina as licenças.

## Preparar os segredos

1. Entre no Windows com a mesma conta usada pelo `ABRIR-GERADOR-LICENCAS`.
2. No PowerShell, execute `powershell -ExecutionPolicy Bypass -File .\license-portal\export-hostinger-key.ps1`.
3. O utilitário lê a chave DPAPI existente, não a modifica e mostra somente um pacote criptografado. Crie uma senha longa e guarde-a em local seguro.
4. Na configuração da aplicação Hostinger, cadastre estas variáveis como segredos, sem prefixo `VITE_`:
   - `PORTAL_ADMIN_PASSWORD`: senha administrativa aleatória com pelo menos 16 caracteres.
   - `LICENSE_KEY_BUNDLE`: linha Base64 mostrada pelo utilitário.
   - `LICENSE_KEY_PASSPHRASE`: senha longa criada no passo anterior.
   - `NODE_ENV`: `production`.
5. Envie somente a pasta `license-portal` para a aplicação Node.js da Hostinger. Defina o comando de início como `npm start` e associe um domínio com HTTPS.

O pacote exportado não substitui nem remove a chave DPAPI original. O utilitário não escreve a chave privada em arquivo; ela sai do computador apenas dentro do pacote criptografado. A aplicação confere se a chave privada importada corresponde à chave pública incluída no pacote, abre a chave ao iniciar e nunca a envia ao navegador. Proteja as permissões de acesso ao painel e às variáveis secretas da Hostinger.

## Uso

Abra o domínio HTTPS, entre com `PORTAL_ADMIN_PASSWORD`, informe titular, código do servidor e plano, e emita a licença. Copie a chave ou baixe o arquivo `.chxlic` para enviar ao cliente. Para manter histórico, salve uma cópia do arquivo no seu armazenamento administrativo seguro; o portal não mantém cópias.

Planos e formato de assinatura seguem `license-manager/main.cjs`: `TRIAL`, `PRO`, `FULL`, vínculo de máquina legado e fingerprint `CHX3`, payload Base64URL e assinatura Ed25519 com prefixo `CHX1`.

## Limites desta entrega

O código está pronto para configuração na Hostinger, mas não foi publicado. A configuração depende do plano e do domínio da conta Hostinger, da inserção dos segredos no painel e da implantação pelo proprietário da conta. O segredo de assinatura fica disponível ao processo do servidor em execução; limite o acesso de administradores da hospedagem.
