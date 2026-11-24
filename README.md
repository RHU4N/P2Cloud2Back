# P2Cloud2Back

API REST em Node.js e Express para listar arquivos do Google Drive e do Azure Blob Storage, transferir arquivos nos dois sentidos (sem sobrescrever) e receber uploads diretos da interface web.

## Tecnologias

- Node.js + Express
- `googleapis` (Google Drive API v3)
- `@azure/storage-blob`
- `multer`, `dotenv` e `cors`

## Endpoints

| Método | Endpoint | Função |
|---|---|---|
| `GET` | `/api/health` | Verificar status do servidor |
| `GET` | `/api/drive/files` | Listar arquivos da pasta no Google Drive |
| `GET` | `/api/blob/files` | Listar arquivos no contêiner Azure |
| `POST` | `/api/transfer` | Copiar do Google Drive para o Azure (opcional `{ fileIds }`) |
| `POST` | `/api/transfer/blob-to-drive` | Copiar do Azure para o Google Drive (opcional `{ fileNames }`) |
| `POST` | `/api/upload/blob` | Enviar arquivos locais (`multipart/form-data`, campo `files`) para o Azure |
| `POST` | `/api/upload/drive` | Enviar arquivos locais (`multipart/form-data`, campo `files`) para o Google Drive |

## Configuração

Copie `.env.example` para `.env` e preencha as variáveis:

```dotenv
PORT=3000
GOOGLE_DRIVE_FOLDER_ID=
GOOGLE_SERVICE_ACCOUNT_JSON_B64=
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REFRESH_TOKEN=
AZURE_STORAGE_CONNECTION_STRING=
AZURE_CONTAINER_NAME=aluno-rhuan
FRONTEND_URL=
```

- `GOOGLE_SERVICE_ACCOUNT_JSON_B64`: conteúdo do JSON da Service Account codificado em Base64.
- `GOOGLE_OAUTH_*` (opcional): necessário apenas se a pasta do Google Drive estiver no Meu Drive pessoal (já que Service Accounts não possuem cota de armazenamento pessoal para gravar arquivos fora de Drives Compartilhados).
- `AZURE_STORAGE_CONNECTION_STRING`: Connection String da conta `stop2nuvem2`, mantendo o contêiner `aluno-rhuan` privado.
- `FRONTEND_URL`: URL do frontend autorizada no CORS (aceita múltiplas URLs separadas por vírgula).

## Execução local

```bash
npm install
npm start
```

## Publicação no Render

- **Build Command:** `npm install`
- **Start Command:** `npm start`
- Configurar todas as variáveis de ambiente acima no painel do serviço no Render.
