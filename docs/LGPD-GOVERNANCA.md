# Kit de Governança LGPD — PACS CHX

Este arquivo é um modelo operacional. Deve ser preenchido pelo estabelecimento controlador com apoio jurídico e do responsável por privacidade. Não constitui parecer jurídico.

## 1. Identificação dos agentes

- Controlador:
- CNPJ:
- Endereço:
- Responsável legal:
- Encarregado ou canal de privacidade:
- Operador do PACS:
- Fornecedores/suboperadores:

## 2. Registro da operação de tratamento

| Campo | Preenchimento |
|---|---|
| Operação | Recepção, armazenamento, visualização, laudo, impressão, exportação e descarte de exames DICOM |
| Categorias de titulares | Pacientes |
| Dados pessoais | Nome, identificador, nascimento, sexo, instituição e solicitante |
| Dados sensíveis | Imagens, exames, laudos e informações de saúde |
| Finalidade | Diagnóstico, assistência à saúde e continuidade do cuidado |
| Base legal validada pelo jurídico | A preencher |
| Compartilhamentos | A preencher |
| Prazo de retenção | A preencher conforme legislação e política institucional |
| Medidas de segurança | Consultar `SECURITY.md` |
| Responsável interno | A preencher |

## 3. Estrutura mínima do RIPD

1. Descrição do tratamento e fluxo dos dados.
2. Necessidade, adequação e proporcionalidade.
3. Categorias de dados e titulares.
4. Fontes e destinatários.
5. Volume, frequência e retenção.
6. Riscos aos direitos dos titulares.
7. Probabilidade e impacto de cada risco.
8. Controles técnicos e administrativos.
9. Riscos residuais e aceite formal.
10. Responsáveis, revisão e aprovação.

## 4. Matriz inicial de riscos

| Risco | Controle esperado | Responsável | Estado |
|---|---|---|---|
| Acesso indevido | Usuário individual, RBAC, bloqueio e auditoria |  |  |
| Furto do servidor | BitLocker, conta Windows e bloqueio de tela |  |  |
| Interceptação na rede | HTTPS e segmentação de rede |  |  |
| Perda de exames | Backup criptografado e restauração testada |  |  |
| Alteração de laudo | Versões, hash, assinatura e auditoria |  |  |
| Impressão indevida | Perfil de impressão e histórico |  |  |
| Malware/ransomware | EDR, atualizações, backup offline e menor privilégio |  |  |
| Descarte incorreto | Política de retenção e eliminação verificável |  |  |

## 5. Direitos dos titulares

- Canal de solicitação:
- Responsável por validar identidade:
- Processo de localização dos dados:
- Processo de correção:
- Processo de entrega segura:
- Processo de bloqueio/eliminação quando legalmente cabível:
- Prazos e registros:

## 6. Plano de incidente

- Coordenador do incidente:
- Contato técnico:
- Contato jurídico/LGPD:
- Contato da direção:
- Procedimento de preservação de evidências:
- Critérios para risco ou dano relevante:
- Processo de comunicação à ANPD:
- Processo de comunicação aos titulares:
- Modelo de registro e lições aprendidas:

## 7. Retenção e descarte

| Categoria | Prazo aprovado | Motivo legal/contratual | Método de descarte |
|---|---:|---|---|
| Imagens DICOM |  |  | Exclusão controlada e registro de auditoria |
| Metadados |  |  | Exclusão controlada |
| Laudos e versões |  |  | Exclusão conforme autorização legal |
| Logs de auditoria |  |  | Expurgo autorizado e documentado |
| Incidentes | Mínimo regulatório aplicável | Resolução da ANPD | Descarte documentado |
| Backups |  |  | Expiração criptográfica e eliminação segura |

## 8. Aprovações

- Responsável técnico:
- Responsável clínico:
- Encarregado/canal de privacidade:
- Jurídico:
- Direção:
- Data da aprovação:
- Próxima revisão:
