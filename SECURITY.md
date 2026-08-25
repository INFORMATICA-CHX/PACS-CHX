# Segurança e LGPD — PACS CHX

Este documento registra o estado de segurança do projeto. Ele deve ser atualizado sempre que um controle for criado, removido ou alterado.

> O PACS CHX ainda não deve ser considerado homologado para produção clínica. Os controles já implementados reduzem riscos importantes, mas não substituem teste de invasão, revisão jurídica, validação DICOM e processo organizacional de LGPD.

## Escopo dos dados

O sistema trata dados pessoais sensíveis de saúde, incluindo identificação do paciente, exames, imagens DICOM, laudos e histórico de impressão. Mesmo funcionando localmente, está sujeito à LGPD e às políticas de segurança da instituição que opera o servidor.

## Revisão de reforço após as novas funcionalidades — 2026-08-01

### O que já estava correto

- Banco e metadados protegidos por criptografia compatível com SQLCipher.
- Arquivos DICOM e backups protegidos com AES-256-GCM.
- Senhas armazenadas com `scrypt`, salt individual e comparação resistente a timing attack.
- HTTPS com TLS 1.2 ou superior e HTTP de rede desativado.
- Tokens clínicos aleatórios de 256 bits e sessões mantidas na memória.
- Manutenção crítica restrita ao computador servidor e protegida por senha de serviço.
- Auditoria encadeada por SHA-256, licenças Ed25519 e vínculo da licença com a máquina.
- CSP, bloqueio de iframe, `nosniff`, política de referência e respostas de API sem cache.
- Auditorias npm do servidor e da interface sem vulnerabilidades conhecidas nesta revisão.

### O que foi corrigido nesta revisão

- MFA TOTP implementado para Master, Administrador e Manutenção, com segredo cifrado em AES-256-GCM, ativação confirmada e pré-autenticação de dois minutos (2026-08-01).
- Logins administrativos sem MFA passaram a gerar o evento `ADMIN_LOGIN_WITHOUT_MFA` durante a migração (2026-08-01).
- Bloqueio automático por inatividade implementado com padrão de 15 minutos, aviso aos 60 segundos finais e aplicação no Viewer e na Central de Impressão (2026-08-01).
- Auditoria replicada em `logs/audit/audit-YYYY-MM.jsonl`, com hash encadeado, verificação cruzada e inclusão nos backups cifrados (2026-08-01).
- Dependência não utilizada `@supabase/supabase-js` removida e build de produção validado (2026-08-01).
- Exclusão de estudo limitada no backend aos perfis Master, Administrador e Manutenção.
- Upload DICOM limitado aos perfis Master, Administrador e Técnico.
- Limite de upload Web reduzido de 512 MB para 128 MB por arquivo.
- Proteção de login por conta/endereço e também por endereço global, com `Retry-After` no bloqueio HTTP 429.
- Sessões revalidam conta ativa e perfil atual em toda requisição.
- Alteração de perfil, desativação ou redefinição de senha revoga sessões anteriores.
- Configuração completa deixou de ser exposta na rede; remotamente são retornados somente AE Title e HTTPS mínimo.
- Estado da autenticação de manutenção passou a ser consultável somente no servidor.
- Adicionados HSTS, `Cross-Origin-Opener-Policy` e `Cross-Origin-Resource-Policy` em HTTPS.
- Chave privada emissora removida da pasta do projeto e migrada para os dados privados do usuário Windows.
- Chaves `CHX1` do histórico passaram a ser criptografadas pelo `safeStorage`/DPAPI do Electron.
- Cinco erros de senha bloqueiam exclusões do histórico por 15 minutos.
- O gerador não cria outro emissor silenciosamente quando a chave autorizada está ausente.

### Decisão consciente mantida pelo proprietário

- O usuário Master permanece com a senha padrão definida pelo proprietário. Ela pode ser alterada pela Manutenção.
- `docs/USUARIOS-E-MASTER.md` é interno e nunca deve integrar um pacote de cliente.
- A porta `4443` continua fechada no Firewall; acesso móvel pela rede depende de autorização explícita.

### Pontos que ainda dependem de operação externa

- Instalar certificado HTTPS institucional/confiável nos clientes.
- Executar teste de invasão independente antes da homologação clínica.
- Validar DIMSE com stack DICOM de produção e realizar fuzz testing.
- Configurar BitLocker, antivírus, cópia offline, restauração testada e processo institucional LGPD.
- Transferir a chave emissora para o segundo PC separadamente e de forma protegida; o ZIP do código não leva mais o segredo.

## Controles implementados

- Gerenciamento local de usuários em **Banco de dados → Manutenção**, protegido por senha de serviço.
- Criação, ativação/desativação, perfis, desbloqueio e redefinição de senha.
- Alterações administrativas de contas registradas na cadeia de auditoria.
- Login de serviço bloqueado por 15 minutos após cinco senhas incorretas consecutivas.
- Manutenção SQLite serializada: apenas uma operação pode ser executada por vez, sempre com auditoria.

### Autenticação clínica no backend

- A tela de login não compara mais a senha no navegador.
- O login é validado pelo endpoint `POST /api/auth/login`.
- O servidor emite tokens aleatórios de 256 bits.
- Sessões expiram após 8 horas.
- Logout invalida a sessão no servidor.
- Tokens são mantidos em `sessionStorage`, não em armazenamento permanente.
- Viewer e Central de Impressão recebem a sessão pelo fragmento `#access=...`.
- O fragmento não é enviado ao servidor HTTP e é removido imediatamente da barra de endereço.

### Proteção contra força bruta

- Máximo de 5 tentativas por conta/endereço e 20 tentativas totais por endereço em uma janela de 15 minutos.
- Novas tentativas são recusadas temporariamente com HTTP 429.
- Falhas e sucessos de autenticação são registrados nos logs de segurança.

### Proteção das rotas clínicas

Exigem token clínico:

- pacientes;
- estudos;
- séries;
- instâncias;
- download de arquivo DICOM;
- upload DICOM pela Web;
- exclusão individual de estudo;
- consulta e encerramento da sessão.

### Proteção das rotas administrativas

Operações administrativas críticas foram limitadas ao endereço de loopback, ou seja, ao próprio computador servidor:

- alteração da configuração;
- iniciar e parar SCP;
- importação por caminho local;
- teste de conexão;
- ativação e desativação de licença;
- configuração e login de manutenção;
- consulta e limpeza de logs;
- estatísticas administrativas;
- backup e manutenção do banco;
- exclusão administrativa de pacientes e estudos antigos.

Exclusões administrativas e manutenção também exigem a sessão de serviço quando aplicável.

### Senha removida da configuração pública

`GET /api/config` não devolve mais `viewerPassword`. A senha continua configurável localmente pelo Manager, mas não é exposta aos navegadores da rede.

### Auditoria

- Acessos autenticados às APIs clínicas são registrados com usuário, método e rota.
- Alterações, exclusões e importações produzem eventos persistentes.
- Logs são gravados diariamente na pasta configurada.

### Segurança HTTP

- Cabeçalho `X-Powered-By` desativado.
- `X-Content-Type-Options: nosniff`.
- `X-Frame-Options: DENY`.
- `Referrer-Policy: no-referrer`.
- `Permissions-Policy` bloqueando câmera, microfone e geolocalização.
- Content Security Policy para restringir scripts, objetos, frames e conexões.
- Respostas da API usam `Cache-Control: no-store`.

### CORS

- CORS não aceita mais qualquer site.
- São permitidos localhost, loopback e endereços de redes privadas.
- Métodos e cabeçalhos aceitos foram limitados.

### Licenciamento

- Licenças são assinadas com Ed25519.
- Licenças versão 2 são vinculadas ao identificador criptográfico da instalação e recusadas em outro computador.
- Novas licenças versão 3 vinculam hashes de `MachineGuid`, serial do disco do sistema e UUID de BIOS/placa-mãe; exigem ao menos duas fontes disponíveis e duas coincidências.
- Uma fonte de hardware pode mudar legitimamente sem invalidar a licença; duas divergências impedem o uso.
- O último relógio aceito é persistido com AES-256-GCM, e retrocessos do relógio local recusam a licença até a correção da data.
- A consulta de revogação é opcional, exclusivamente HTTPS e limitada a uma tentativa diária; falhas de rede nunca interrompem a operação offline.
- O servidor possui somente a chave pública de verificação.
- A chave privada fica fora do projeto, no armazenamento privado do usuário Windows; segredos residuais continuam no `.gitignore`.
- O License Manager deve permanecer exclusivamente com a equipe emissora.
- O aplicativo distribuído usa ASAR e o servidor é iniciado por bytecode V8 Bytenode, sem incluir o bundle intermediário legível. Isso eleva substancialmente o custo de adulteração casual, mas não impede decompilação por um atacante motivado.

### Laudos por modalidade

- Modelos de laudo persistentes são vinculados à modalidade DICOM.
- Apenas Médico/Radiologista e Master podem acessar e alterar modelos.
- Apenas esses perfis podem criar, editar e assinar laudos.
- Alterações de modelos e assinaturas são registradas na auditoria.

### Manutenção

- Senha de serviço derivada com `scrypt` e salt aleatório.
- Comparação resistente a timing attack.
- Tokens de manutenção aleatórios, temporários e mantidos somente em memória.

## Limitações conhecidas e pendências

### Prioridade crítica antes de produção

- [x] Substituir a senha clínica em texto no `config.json` por hash `scrypt` com salt individual.
- [x] Criar estrutura de usuários individuais no banco.
- [x] Implementar RBAC no backend: administrador, radiologista, técnico, recepção, impressão, manutenção, auditor e leitura.
- [x] Armazenar laudos e versões no banco do servidor.
- [x] Armazenar fila e histórico de impressão no servidor.
- [x] Implementar HTTPS e restringir o HTTP puro ao loopback quando habilitado (usar certificado institucional em produção).
- [x] Criptografar banco com SQLCipher compatível e imagens/backups com AES-256-GCM usando chave externa ao repositório.
- [ ] Substituir/validar a implementação DIMSE simplificada por uma biblioteca DICOM de produção.
- [ ] Implementar DICOM TLS quando suportado pelas modalidades.
- [ ] Realizar teste de invasão e revisão independente do código.

### Prioridade alta

- [ ] Política de senha, troca inicial, expiração administrativa e recuperação segura.
- [x] Autenticação multifator para administradores e manutenção.
- [x] Bloqueio automático da estação por inatividade.
- [x] Revogação das sessões anteriores após redefinição de senha, alteração de perfil ou desativação.
- [x] Auditoria resistente a adulteração por encadeamento SHA-256 e verificação de integridade.
- [x] Replicar auditoria para destino externo protegido, em arquivo append-only fora do banco principal.
- [ ] Registrar abertura de paciente, visualização, impressão, exportação, assinatura e alteração de laudo com contexto completo.
- [ ] Assinatura de laudo com identidade individual e impedimento de alteração silenciosa após assinatura.
- [ ] Validação antivírus e limites adicionais para uploads DICOM.
- [ ] Proteção contra arquivos DICOM malformados e fuzz testing do parser.
- [x] Backup manual/automático criptografado com AES-256-GCM e verificação imediata de descriptografia/checksum.
- [ ] Manter cópia offline e executar teste operacional periódico de restauração completa.
- [ ] Política de atualização de dependências e correção de vulnerabilidades.
- [ ] Assinatura digital dos executáveis e instalador.

### Governança e LGPD

- [ ] Definir formalmente controlador, operador, suboperadores e encarregado/canal de privacidade.
- [ ] Documentar bases legais e finalidades do tratamento.
- [ ] Criar Registro das Operações de Tratamento.
- [ ] Elaborar RIPD conforme risco e orientação jurídica.
- [ ] Criar política de retenção, descarte e anonimização.
- [ ] Criar procedimento para direitos dos titulares.
- [ ] Criar plano de resposta a incidentes e responsáveis de plantão.
- [ ] Manter registro dos incidentes pelo período regulatório aplicável.
- [ ] Definir processo de comunicação à ANPD e aos titulares.
- [ ] Treinar usuários sobre acesso indevido, impressão, exportação e engenharia social.
- [ ] Formalizar termos com clientes e fornecedores.

## Operação segura recomendada hoje

Enquanto os itens críticos não forem concluídos:

1. Use somente dados fictícios ou anonimizados.
2. Não exponha a porta `4000` ou `11112` à internet.
3. Restrinja o acesso por firewall à rede clínica necessária.
4. Use uma conta Windows dedicada e bloqueio de tela.
5. Habilite BitLocker no volume que contém banco, imagens e backups.
6. Troque as credenciais padrão.
7. Não compartilhe a senha de manutenção.
8. Mantenha a chave privada de licenças fora dos computadores clientes.
9. Faça backups e teste periodicamente a restauração.
10. Revise diariamente eventos de erro e segurança.

## Resposta a incidentes

Em caso de suspeita de acesso indevido:

1. Isole o servidor da rede sem desligar ou apagar evidências.
2. Registre horário, usuário, equipamento e evento observado.
3. Preserve banco, logs e arquivos relevantes.
4. Revogue credenciais e sessões afetadas.
5. Avalie quais titulares e dados foram envolvidos.
6. Acione o responsável de segurança, o controlador e o encarregado/canal LGPD.
7. Avalie com assessoria competente a comunicação à ANPD e aos titulares dentro do prazo aplicável.
8. Documente causa, impacto, contenção, correção e prevenção.

## Referências oficiais

- LGPD — Lei nº 13.709/2018: https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709compilado.htm
- Guia de Segurança da Informação da ANPD: https://www.gov.br/anpd/pt-br/assuntos/noticias/anpd-publica-guia-de-seguranca-para-agentes-de-tratamento-de-pequeno-porte
- Comunicação de Incidente de Segurança: https://www.gov.br/anpd/pt-br/canais_atendimento/agente-de-tratamento/comunicado-de-incidente-de-seguranca-cis
- Relatório de Impacto à Proteção de Dados: https://www.gov.br/anpd/pt-br/canais_atendimento/agente-de-tratamento/relatorio-de-impacto-a-protecao-de-dados-pessoais-ripd

## Histórico

### 2026-08-02

- License Manager: chave privada de assinatura agora protegida via Electron `safeStorage`; hardening de janela padronizado com o app principal.
- Licenciamento anti-clone: fingerprint v3 multifonte com tolerância 2-de-3, cache transitório de dez minutos e compatibilidade com licenças v2 existentes.
- Licenciamento anti-clone: detecção cifrada de retrocesso do relógio e canal HTTPS opcional de revogação diária, com funcionamento offline preservado em falhas de rede.
- Distribuição: ASAR habilitado e servidor empacotado em bytecode V8 com Bytenode; bytecode dificulta adulteração casual, mas ainda pode ser analisado por atacantes motivados.

### 2026-08-01

- Criada autenticação clínica no backend.
- Adicionadas sessões aleatórias com expiração.
- Adicionado bloqueio de tentativas de login.
- Protegidas rotas clínicas.
- Restringidas operações administrativas ao servidor local.
- Removida senha da resposta pública de configuração.
- Adicionados eventos de auditoria.
- CORS restringido.
- Adicionados cabeçalhos de segurança e CSP.
- Criado este documento de acompanhamento.
- Migradas credenciais clínicas para `scrypt` no SQLite e removida senha do `config.json`.
- Criadas tabelas e APIs de usuários e perfis.
- Criados laudos versionados, hash de conteúdo e assinatura individual.
- Migrada fila de impressão para o servidor.
- Criada auditoria encadeada e endpoint de verificação.
- Criado backup AES-256-GCM com chave local, manifesto e verificação.
- Adicionado agendamento configurável de backup.
- Adicionado HTTPS opcional com TLS 1.2 ou superior.
- HTTPS habilitado por padrão; HTTP puro restrito a `127.0.0.1` quando ativo e aviso crítico emitido quando desativado.
- Dependências corrigidas com `npm audit fix`; `dcmjs` validado em 80 arquivos DICOM e versões críticas fixadas sem `^`.
- Banco migrado para formato SQLCipher compatível e 80 arquivos DICOM migrados para AES-256-GCM; inicializadores injetam a chave em memória a partir de recuperação local protegida por DPAPI.
- Reforçado receptor DICOM com validação de AE/IP, timeout, limite de conexões e tamanho.
- Criado modelo de governança em `docs/LGPD-GOVERNANCA.md`.
