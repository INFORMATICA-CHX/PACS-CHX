# Licenciamento e transferência do projeto — PACS CHX

Este documento descreve como manter o código em dois computadores autorizados,
emitir licenças e preparar instalações independentes para cada cliente.

## Separação obrigatória

Existem dois produtos diferentes dentro do projeto:

1. **PACS CHX do cliente** — Manager, servidor DICOM, API e Viewer.
2. **License Manager interno** — ferramenta que possui a chave privada e emite licenças comerciais.

O License Manager e sua chave privada nunca devem ser entregues ao cliente. O
cliente recebe somente o PACS, a chave pública de verificação e a licença emitida
para o servidor dele.

## Armazenamento seguro da chave emissora

A chave privada não fica mais dentro da pasta do projeto. No Windows ela é
armazenada em
`%APPDATA%\pacs-chx-license-manager\issuer-keys\private.pem`. A chave pública
correspondente permanece em `server/license-public.pem` e pode integrar o PACS
do cliente.

O histórico permanece em `license-manager/data/license-history.json`, porém as
chaves completas `CHX1` são criptografadas pelo `safeStorage`/DPAPI do Windows.
Copiar esse JSON para outro Windows preserva os metadados, mas não permite
recuperar as chaves secretas naquele computador.

Para autorizar o segundo computador emissor, transfira a mesma chave privada
separadamente, usando mídia confiável e arquivo criptografado. Coloque-a no mesmo
diretório `%APPDATA%` do segundo PC e elimine a cópia de transporte depois da
validação. O gerador se recusa a criar silenciosamente outro par quando encontra
uma instalação já associada a uma chave pública.

## Dois computadores autorizados para desenvolvimento

É possível manter e editar o projeto inteiro em dois computadores próprios. Se
você transferir a pasta completa por ZIP, use um ZIP criptografado e mídia
confiável. A autoridade privada de licenciamento não acompanha mais a pasta e
deve ser transferida separadamente pelo procedimento descrito acima.

Para os dois computadores emitirem licenças compatíveis, eles precisam usar o
mesmo par Ed25519, seguindo o procedimento seguro descrito acima.

Evite editar manualmente o histórico ou copiar segredos em ZIP comum.

Faça uma cópia offline adicional dessas chaves. A perda da chave privada impede
emitir novas licenças compatíveis. O vazamento permite que terceiros criem
licenças falsas aceitas pelos clientes.

Depois de descompactar o projeto no outro computador, reinstale as dependências:

```powershell
npm.cmd install
npm.cmd --prefix server install
npm.cmd --prefix license-manager install
npm.cmd run build
```

Os atalhos `.bat` fazem essa preparação automaticamente quando necessário. No
uso normal, basta descompactar, abrir a pasta e clicar no atalho desejado. O
computador precisa ter Node.js e acesso à internet na primeira instalação caso as
dependências não estejam completas no ZIP.

Se o ZIP contiver banco, imagens, logs ou uma chave DPAPI pertencentes ao primeiro
computador, o inicializador não os sobrescreve. Ele move esse conjunto para
`server/portable-backups/foreign-runtime-<data>` e cria um ambiente local vazio,
com chave própria para o novo PC. Uma licença antiga copiada com o ZIP será
recusada no segundo computador porque sua identidade de hardware não corresponde.

Nas instalações Windows, o estado da licença e o relógio protegido ficam na pasta
de dados persistente escolhida no instalador (por padrão `%ProgramData%\PACS CHX`),
fora da pasta do programa. Atualizações preservam esses arquivos. A primeira
atualização a partir de uma versão antiga copia `server/license.json` e
`server/license-clock.enc` para essa pasta antes de substituir o programa; a chave
continua vinculada ao mesmo hardware.

Não é necessário aproveitar `node_modules` do primeiro computador. O código pode
ser editado mesmo que o banco de desenvolvimento não abra no segundo PC. Bancos
e imagens de clientes nunca devem entrar na pasta de desenvolvimento.

## Como uma licença fica presa ao servidor

O PACS calcula um código SHA-256 a partir da identidade estável da instalação do
Windows. O identificador original não é colocado na licença. O código aparece na
aba **Licença** do PACS.

Fluxo de emissão:

1. Instale o PACS no servidor do cliente.
2. Abra a aba **Licença** e copie o código do servidor.
3. No seu computador autorizado, abra `ABRIR-GERADOR-LICENCAS.bat`.
4. Informe titular, código do servidor, plano, validade e limites.
5. Gere e salve o arquivo `.chxlic`.
6. No servidor do cliente, cole a chave contida no arquivo e ative a licença.
7. O servidor valida assinatura, validade, permissões, limites e máquina.

## Histórico e exclusão de licenças

A aba **Licenças geradas** registra cada emissão imediatamente, mesmo que o
arquivo `.chxlic` ainda não tenha sido salvo. Ela mostra cliente, ID, plano,
validade, data, código do servidor e permite copiar novamente a chave.

Na primeira utilização, configure uma senha administrativa de pelo menos oito
caracteres. Excluir uma licença do histórico ativo exige essa senha. A exclusão
não apaga silenciosamente todos os vestígios: data, cliente, máquina e ID ficam
registrados na auditoria de exclusões.

A exclusão no License Manager não revoga remotamente uma licença já ativada no
cliente, pois a validação é offline. Para revogação imediata futura será
necessário um serviço central de licenciamento ou uma lista de revogação assinada.

Uma cópia dessa licença será recusada em outro computador. Trocar a placa de rede
não deve invalidá-la. Reinstalar o Windows pode mudar o código e exigir reemissão.

## Reemissão e troca legítima de servidor

Quando um cliente substituir o servidor:

1. confirme a identidade e o contrato do cliente;
2. registre o motivo e o identificador da licença anterior;
3. obtenha o código do novo servidor;
4. emita nova licença para o mesmo plano e limites;
5. desative e arquive administrativamente a licença anterior;
6. transfira banco, imagens e chave de dados por procedimento seguro.

O sistema faz validação offline. A revogação ainda é administrativa; não existe
servidor central consultado pelo PACS para bloquear uma licença já emitida.

## Dados e chave de criptografia não são a licença

Cada cliente possui separadamente:

- seu próprio `pacs.db`;
- sua própria pasta `storage/`;
- seus próprios logs;
- sua própria `PACS_DB_KEY`;
- sua licença vinculada ao servidor, salva em `license.json` na pasta de dados persistente.

A licença controla autorização comercial. A `PACS_DB_KEY` abre os dados clínicos.
Uma não substitui a outra. Seus computadores de desenvolvimento não devem guardar
bancos, imagens ou chaves de dados dos clientes.

## O que entregar ao cliente

Inclua:

- aplicação PACS CHX;
- dependências/artefatos necessários para execução;
- `server/license-public.pem`;
- certificado HTTPS apropriado ou procedimento para instalá-lo;
- documentação de operação e recuperação;
- licença emitida para aquele servidor.

Não inclua:

- pasta `license-manager/`;
- qualquer chave privada copiada do diretório `%APPDATA%`;
- bancos ou imagens de outro cliente;
- chaves de criptografia de desenvolvimento;
- backups, logs e dados demonstrativos desnecessários;
- ferramentas internas de emissão.

## Checklist antes de enviar uma versão

- [ ] Build e typecheck concluídos.
- [ ] Dependências auditadas.
- [ ] Pacote do cliente não contém a chave privada do emissor.
- [ ] Banco e armazenamento começam vazios ou somente com dados autorizados.
- [ ] Chave de dados exclusiva criada no servidor do cliente.
- [ ] HTTPS configurado.
- [ ] Licença emitida com o código correto do servidor.
- [ ] Recuperação da chave de dados entregue ao responsável autorizado.
- [ ] Licença, cliente, validade, limites e reemissões registrados internamente.

## Recomendação para o código-fonte

Um ZIP completo funciona, mas um repositório Git privado fornece histórico,
comparação e recuperação de alterações. Mesmo em Git privado, mantenha a chave
privada fora do repositório e transfira-a separadamente entre os dois computadores
autorizados.
