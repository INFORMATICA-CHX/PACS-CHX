# PACS CHX Server

## Administração de usuários

O gerenciamento visual está no Manager em **Banco de dados → Manutenção → Usuários e permissões** e requer uma sessão local de serviço. As rotas `/api/service/users` permitem criar, atualizar, desbloquear e redefinir senhas sem expor hashes ou senhas existentes. Toda alteração é registrada na auditoria encadeada. O último administrador ativo não pode ser desativado ou rebaixado.

As ferramentas SQLite executam `PRAGMA integrity_check`, `VACUUM`, `REINDEX` e `ANALYZE`/`PRAGMA optimize`. O servidor impede operações simultâneas, informa resultado e duração e registra cada execução na auditoria.

DICOM SCP (C-STORE) server with REST API, designed to run locally alongside the web viewer.

## Architecture

```
server/
├── src/
│   ├── index.js      — entry point: starts SCP + REST API
│   ├── dicomScp.js   — TCP DICOM SCP (C-STORE receiver)
│   ├── api.js        — Express REST endpoints
│   ├── database.js   — SQLite schema for DICOM metadata
│   ├── config.js     — persisted config (config.json)
│   └── logger.js     — in-memory event log
└── package.json
```

## Running

```bash
# 1. Build the frontend first (from project root)
npm run build

# 2. Install server dependencies and start
cd server
npm install
npm start
```

The server starts:
- **DICOM SCP** on the configured port (default `11112`)
- **HTTPS API and frontend** on port `4443`
- **Loopback-only HTTP** on `127.0.0.1:4000`

`PACS_DB_KEY` is required to open the encrypted database and DICOM storage.

## How it works

1. Modalities (CT, MR, CR, etc.) send studies via DICOM C-STORE to the SCP.
2. The SCP validates the sender's AE Title against the whitelist in the config.
3. Accepted `.dcm` files are encrypted with AES-256-GCM under `storage/<patientId>/<studyUid>/<seriesUid>/<sopUid>.dcm`.
4. Metadata is parsed and indexed in an encrypted SQLCipher-compatible database.
5. The React frontend queries the REST API and renders the worklist + viewer.

## Configuration

All settings are editable from the web UI (Settings page) and persist to `config.json`:

| Setting | Description |
|---------|-------------|
| AE Title | Our PACS name on the DICOM network |
| Listen IP | `0.0.0.0` for all interfaces |
| Listen Port | TCP port for DICOM (104 or 11112) |
| Storage Path | Where `.dcm` files are saved |
| Remote Devices | Whitelist of authorized modalities |

## REST API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/patients` | List all patients |
| GET | `/api/studies` | Worklist (with filters) |
| GET | `/api/studies/:id/series` | Series in a study |
| GET | `/api/series/:id/instances` | Instances in a series |
| GET | `/api/instances/:id/file` | Serve raw `.dcm` file |
| GET | `/api/config` | Full config on loopback; minimal HTTPS identity on the LAN |
| PUT | `/api/config` | Update server config |
| POST | `/api/server/start` | Start SCP |
| POST | `/api/server/stop` | Stop SCP |
| POST | `/api/test-echo` | C-ECHO a remote device |
| GET | `/api/logs` | Event log |

Clinical sessions revalidate the active account and current role on every
request. Study deletion is restricted to Master/Admin/Maintenance. Web DICOM
upload is restricted to Master/Admin/Technician and accepts at most 128 MB per
file.

## Future extension points

The code has marked extension points for:

- **C-FIND SCP** — let other PACS query our database
- **C-MOVE SCU** — fetch studies from another PACS server
- **Cloud backup** — push received files to S3/GCS/Azure after local storage

## Licensing

Licenses are signed with Ed25519 and bound to the server code derived from the
Windows installation identity. A license issued for one server is rejected on
another. See [`../docs/LICENCIAMENTO.md`](../docs/LICENCIAMENTO.md).

## Notes on the DICOM protocol

The SCP uses `dcmjs` for parsing DICOM datasets. The TCP upper-layer PDU
handling is a simplified implementation. For a production-grade SCP with
full state-machine compliance, consider integrating a dedicated DIMSE
library such as `node-dicom` or `fo-dicom` (via a sidecar).
