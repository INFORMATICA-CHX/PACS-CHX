# PACS CHX

O PACS CHX é um sistema local para recebimento, armazenamento, organização e visualização de exames médicos no padrão DICOM. O servidor, o banco de dados e as imagens ficam no computador do cliente. A aplicação não depende de nuvem para a operação normal.

## Componentes do sistema

### PACS CHX Manager

Aplicativo Electron usado para administrar o PACS. Ele inicia e acompanha o servidor, exibe logs, permite configurar armazenamento, banco de dados, conexões DICOM, licença e manutenção.

Ao abrir o Manager, o servidor local é iniciado automaticamente.

### PACS CHX Web

Interface clínica acessada pelo navegador. Contém:

- Worklist de pacientes e exames;
- filtros por período e modalidade;
- Viewer DICOM;
- Central de Laudos;
- Central de Impressão;
- importação de arquivos DICOM;
- fila e histórico de impressão;
- indicadores de pacientes, estudos e imagens.

Endereço recomendado: `https://127.0.0.1:4443/viewer`

HTTPS vem habilitado por padrão. Configure `https.certPath` e `https.keyPath` em
`server/config.json` com um certificado institucional. O certificado local
autoassinado em `server/certs/` serve apenas para instalação e testes; o navegador
exibirá um aviso até que ele seja confiado. Com HTTPS habilitado, a porta HTTP 4000
aceita conexões somente do próprio servidor (`127.0.0.1`).

O banco e os arquivos DICOM são criptografados em repouso. O servidor exige
`PACS_DB_KEY` com 32 bytes (64 caracteres hexadecimais ou base64). A chave não
deve ser colocada no `config.json`, em scripts ou no repositório. Perder essa
chave torna os dados irrecuperáveis; mantenha uma cópia protegida no cofre de
segredos da instituição. Nesta instalação Windows, os inicializadores recuperam
uma cópia local protegida pelo DPAPI da conta atual e a passam somente pela
memória do processo. A inicialização direta com `npm start` exige a variável.

Cada licença comercial é vinculada ao código criptográfico exibido na aba
**Licença** do servidor. Copie esse código para o License Manager ao emitir o
arquivo `.chxlic`. Uma licença copiada para outro computador será recusada. A
troca da placa de rede não altera o código, mas uma reinstalação do Windows pode
exigir reemissão administrativa da licença.

### Servidor DICOM

Executa localmente e fornece:

- DICOM SCP para recebimento C-STORE;
- AE Title padrão `PACSCHX`;
- porta DICOM padrão `11112`;
- API REST e Web na porta `4000`;
- indexação dos metadados em SQLite;
- armazenamento dos arquivos `.dcm` no disco;
- logs persistentes.

### License Manager

Aplicativo Electron separado para emissão de licenças assinadas. Permite definir titular, validade, funcionalidades, dispositivos, usuários, estudos e limite de armazenamento.

Também mantém uma aba permanente de licenças geradas. A remoção do histórico
ativo exige senha administrativa e deixa um registro de auditoria da exclusão.

O License Manager é uma ferramenta interna e não deve ser instalado no computador do cliente.

O procedimento completo para trabalhar em dois computadores autorizados, emitir
licenças vinculadas ao servidor e preparar o pacote de cada cliente está em
[`docs/LICENCIAMENTO.md`](docs/LICENCIAMENTO.md).

O guia interno da aba de usuários, perfis e conta de desenvolvimento Master está
em [`docs/USUARIOS-E-MASTER.md`](docs/USUARIOS-E-MASTER.md). Esse documento contém
as credenciais internas e não deve ser incluído no pacote entregue ao cliente.

## Abertura rápida no Windows

Na pasta principal do projeto existem os seguintes atalhos:

| Atalho | Função |
|---|---|
| `INICIAR-PACS-CHX.bat` | Compila a interface quando necessário e abre o Manager. É a opção normal de uso. |
| `INICIAR-WEB-SERVIDOR.bat` | Inicia somente o servidor e abre a Web no navegador. |
| `ABRIR-GERADOR-LICENCAS.bat` | Abre o License Manager interno. |
| `CRIAR-DADOS-DEMO.bat` | Cria/reindexa os pacientes e exames demonstrativos. |

Para o uso diário, clique duas vezes em **`INICIAR-PACS-CHX.bat`**.

### Pasta copiada ou descompactada em outro PC

Os três atalhos executam uma preparação portátil automaticamente. Eles verificam
Electron e dependências e criam uma chave de desenvolvimento própria da máquina.
Dados criptografados trazidos de outro computador são preservados em
`server/portable-backups/` e não são misturados com a nova instalação. Assim,
depois de descompactar a pasta, basta clicar no `.bat` desejado. O Node.js continua
sendo um requisito do computador.

## Primeira instalação

Requisitos:

- Windows 10 ou 11;
- Node.js 22 ou superior;
- npm;
- espaço disponível para os exames DICOM.

Abra o PowerShell na pasta do projeto e execute:

```powershell
npm.cmd install
npm.cmd --prefix server install
npm.cmd --prefix license-manager install
npm.cmd run build
```

Depois disso, utilize os atalhos `.bat`.

## Comandos manuais

```powershell
# Manager completo, que também inicia o servidor
npm.cmd run desktop

# Compilar e abrir o Manager
npm.cmd run desktop:build

# Somente servidor DICOM + API + Web
npm.cmd --prefix server start

# License Manager
npm.cmd run license-manager

# Criar dados demonstrativos
npm.cmd run seed:demo

# Verificar o TypeScript
npm.cmd run typecheck

# Gerar a interface de produção
npm.cmd run build
```

## Pastas e dados locais

| Caminho padrão | Conteúdo |
|---|---|
| `storage/` | Arquivos DICOM organizados por paciente, estudo e série. |
| `pacs.db` | Banco SQLite com pacientes, estudos, séries e instâncias. |
| `logs/` | Logs diários do servidor. |
| `server/config.json` | Configuração do servidor e dos dispositivos. |
| `server/license.json` | Estado local e licença ativada, quando aplicável. |
| `server/service-auth.json` | Credencial protegida da manutenção. |

Os destinos podem ser alterados no Manager. Faça backup periódico do banco, das imagens e da configuração.

## Credenciais

As credenciais da Web são configuradas no Manager. A área de manutenção utiliza uma senha de serviço separada.

Nunca coloque senhas reais em documentação, capturas de tela ou repositórios públicos.

## Usuários e permissões

O cadastro administrativo fica no **Manager → Banco de dados → Manutenção → Usuários e permissões**. O acesso exige a senha privada de serviço. Nessa tela é possível criar e desativar contas, atribuir perfis, redefinir senhas, desbloquear contas e consultar a auditoria. As senhas existentes nunca são exibidas.

### Central de Laudos e modelos

A Central de Laudos aparece somente para os perfis **Médico / Radiologista** e
**Master**. Ao iniciar um laudo novo, o sistema identifica a modalidade DICOM e
carrega automaticamente o modelo correspondente. O botão **Modelos de laudo**
permite editar os textos-base persistentes de MG, CT, MR, XR, CR, DX, US, NM, PT
e XA. Alterações nos modelos são auditadas no servidor.

O perfil **Master** possui acesso total e é destinado exclusivamente ao
proprietário/desenvolvedor. Contas clínicas comuns não devem receber esse perfil.

## Segurança das licenças

Arquivos sensíveis do emissor:

- `%APPDATA%\pacs-chx-license-manager\issuer-keys\private.pem` — chave privada de assinatura, fora do projeto;
- `server/.license-secret` — segredo legado/local, se estiver em uso.

Esses arquivos não devem ser enviados ao cliente, publicados ou incluídos no instalador do PACS. O cliente precisa somente da chave pública usada para verificar a licença e do arquivo de licença emitido.

Faça uma cópia segura e offline da chave privada. A perda dessa chave impede a emissão compatível de novas licenças; o vazamento permite emissão não autorizada.

Se os seus dois computadores forem autoridades de emissão, ambos devem possuir o
mesmo par de chaves. Ao copiar a pasta inteira por ZIP, proteja o ZIP com
criptografia e não reutilize esse pacote como instalador do cliente. Consulte
[`docs/LICENCIAMENTO.md`](docs/LICENCIAMENTO.md).

## Fluxo normal de operação

1. Abra `INICIAR-PACS-CHX.bat`.
2. Aguarde o status do servidor ficar ativo no Manager.
3. Clique em abrir o Viewer ou acesse `https://127.0.0.1:4443/viewer`.
4. Entre na Worklist.
5. Importe arquivos ou receba estudos das modalidades configuradas.
6. Abra um estudo para visualizar as imagens.
7. Use as áreas separadas de Laudos e Impressão quando necessário.

## Encerramento

Feche o PACS CHX Manager para encerrar o processo do servidor iniciado por ele. Se o servidor tiver sido iniciado pelo atalho Web, feche também a janela `PACS CHX Server`.

## Estado dos executáveis

Atualmente o projeto roda em modo de desenvolvimento/implantação local por meio do Electron e dos atalhos `.bat`. Ainda não há um instalador final `.exe` com atualização e desinstalação automáticas.

Antes da distribuição comercial, o próximo passo recomendado é empacotar:

- `PACS CHX Manager.exe`, contendo apenas o Manager e o servidor;
- `PACS CHX License Manager.exe`, mantido exclusivamente pela equipe emissora;
- instalador do cliente sem chave privada e sem ferramentas de emissão.

## Suporte técnico

Ao investigar problemas, reúna:

- horário aproximado do erro;
- tela e ação realizada;
- status do servidor no Manager;
- arquivo diário correspondente em `logs/`;
- configuração de AE Title, IP e porta da modalidade.

Detalhes técnicos do backend estão em [`server/README.md`](server/README.md).

O estado dos controles de segurança, pendências técnicas e preparação para LGPD estão documentados em [`SECURITY.md`](SECURITY.md).

O modelo para inventário, RIPD, riscos, incidentes e retenção está em [`docs/LGPD-GOVERNANCA.md`](docs/LGPD-GOVERNANCA.md).

## Atualizacoes automaticas do aplicativo Windows

O instalador NSIS verifica novas versoes no GitHub Releases cinco segundos depois de abrir o aplicativo. Havendo uma versao mais nova, o download ocorre em segundo plano. Ao terminar, o PACS pergunta se deve reiniciar para aplicar a atualizacao. Sem internet ou sem uma nova versao publicada, a instalacao existente continua funcionando.

Para publicar uma atualizacao:

1. Incremente `version` em `package.json` usando uma versao semver (por exemplo, `1.0.1`).
2. Gere o instalador com `npm run dist:win`.
3. Publique como **GitHub Release** no repositorio `INFORMATICA-CHX/PACS-CHX`, usando a mesma tag da versao (por exemplo, `v1.0.1`) e anexe `PACS-CHX-Setup-1.0.1.exe` e `latest.yml` produzidos em `release/`. Anexe tambem o `.blockmap` se estiver disponivel.
4. Mantenha os releases publicos para que os clientes possam consultar e baixar atualizacoes sem credenciais.

A verificacao automatica funciona no instalador NSIS. A versao portatil nao se atualiza automaticamente. A atualizacao reinicia o servico local PACS CHX durante a troca dos arquivos; os dados persistentes ficam fora da pasta de instalacao.


Para automatizar esses passos no Windows, execute `PUBLICAR-ATUALIZACAO-GITHUB.bat` na pasta do projeto. E necessario ter Node.js/npm, Git e GitHub CLI (`gh`) instalados e estar autenticado com `gh auth login`. O script exige uma arvore Git limpa, incrementa a versao patch, constroi o instalador, cria e envia um commit da versao e publica a release apos pedir confirmacao.
