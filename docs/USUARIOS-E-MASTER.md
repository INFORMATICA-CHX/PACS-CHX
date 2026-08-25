# Usuários, permissões e conta Master — PACS CHX

Este documento registra o funcionamento da aba de usuários e a conta Master do
ambiente de desenvolvimento.

> Documento interno. Não incluir no instalador ou pacote entregue aos clientes.

## Conta Master de desenvolvimento

Credenciais internas atuais:

```text
Usuário: master
Senha padrão: admin123admin
Perfil: Master
```

A senha é definitiva e não existe tela obrigatória de troca no primeiro acesso.
Quando necessário, ela pode ser alterada pela área de Manutenção.

Depois da troca, atualize ou remova a senha deste documento. O banco armazena
somente o hash `scrypt`; a senha definitiva não pode ser recuperada pelo sistema.

## Finalidade do perfil Master

O perfil **Master** é reservado ao proprietário/desenvolvedor e possui acesso
total às operações protegidas pelo controle de perfis, incluindo:

- Worklist e Viewer DICOM;
- Central de Laudos;
- criação, edição e assinatura de laudos;
- gerenciamento dos modelos de laudo por modalidade;
- impressão e exportação;
- administração de usuários;
- auditoria;
- configurações e manutenção permitidas pela aplicação.

Não atribua o perfil Master a médicos, técnicos, recepcionistas ou usuários dos
clientes. Para esses casos, use o perfil específico da função.

## Onde administrar usuários

Abra:

**PACS CHX Manager → Banco de dados → Manutenção → Usuários e permissões**

A área administrativa exige a senha de serviço/manutenção. Nela é possível:

- criar usuário;
- informar nome completo e nome de acesso;
- definir senha;
- escolher o perfil;
- ativar ou desativar uma conta;
- exigir troca de senha;
- redefinir senha;
- desbloquear usuário;
- consultar registros de auditoria.

## Perfis disponíveis

| Perfil | Uso recomendado |
|---|---|
| Master | Proprietário/desenvolvedor com acesso total |
| Administrador | Administração operacional do PACS |
| Médico / Radiologista | Viewer, modelos, elaboração e assinatura de laudos |
| Técnico | Operação técnica, exames e impressão autorizada |
| Recepção | Consulta e atividades administrativas limitadas |
| Impressão | Central e fila de impressão |
| Manutenção | Manutenção técnica e banco de dados |
| Auditor | Consulta da trilha de auditoria |
| Visualizador | Consulta clínica sem edição de laudos |

## Criação de um usuário

1. Abra a aba **Usuários e permissões**.
2. Informe o nome completo.
3. Defina um nome de acesso com pelo menos três caracteres.
4. Crie uma senha com pelo menos 10 caracteres.
5. Escolha o perfil adequado.
6. Clique em **Criar usuário**.
7. Entregue a senha diretamente ao usuário.
8. O usuário deverá definir uma senha definitiva no primeiro acesso.

## Regras importantes

- Cada profissional deve possuir uma conta individual.
- Não compartilhar a conta Master.
- Não usar Master para a rotina clínica do cliente.
- Desativar imediatamente contas de pessoas desligadas.
- Não registrar senhas definitivas em documentos, mensagens ou planilhas.
- Redefinições, alterações de perfil e desbloqueios são auditados.
- Laudos devem ser assinados pela conta individual do médico responsável.

## Transferência para outro computador de desenvolvimento

Ao transferir a pasta completa para o segundo computador, o código do perfil
Master também será transferido. O banco e a conta local podem ser recriados pelo
inicializador portátil, porque os dados criptografados pertencem a cada máquina.

Para criar a conta Master em um novo banco, execute dentro de `server/`, com a
chave de dados carregada no ambiente:

```powershell
$env:PACS_MASTER_PASSWORD='uma-senha-temporaria-forte'
npm.cmd run create:master
Remove-Item Env:PACS_MASTER_PASSWORD
```

O comando não redefine uma senha Master já existente.

## Pacotes entregues aos clientes

Este arquivo contém uma credencial do ambiente de desenvolvimento e não deve ser
entregue ao cliente. Antes de criar um instalador comercial, exclua este documento
do pacote e crie as contas autorizadas diretamente no servidor do cliente.
