# P2Cloud2Back

API REST em Node.js e Express para listar arquivos de uma pasta do Google Drive e copiá-los para um contêiner do Azure Blob Storage.

## Tecnologias

- Node.js + Express
- `googleapis` (Google Drive API v3 via Service Account)
- `@azure/storage-blob`
- `dotenv` e `cors`

## Endpoints

| Método | Endpoint | Função |
|---|---|---|
| `GET` | `/api/health` | Verificar status do servidor |
| `GET` | `/api/drive/files` | Listar arquivos da pasta no Google Drive |
| `GET` | `/api/blob/files` | Listar arquivos no contêiner Azure |
| `POST` | `/api/transfer` | Copiar arquivos do Drive para o Azure sem sobrescrever existentes |

## Configuração

Copie `.env.example` para `.env` e preencha as variáveis:

```dotenv
PORT=3000
GOOGLE_DRIVE_FOLDER_ID=
GOOGLE_SERVICE_ACCOUNT_JSON_B64=
AZURE_STORAGE_CONNECTION_STRING=
AZURE_CONTAINER_NAME=aluno-rhuan
FRONTEND_URL=
```

- `GOOGLE_SERVICE_ACCOUNT_JSON_B64`: conteúdo do JSON da Service Account codificado em Base64 (sem quebras ou com espaços simples). A Service Account deve ter permissão de leitura na pasta do Google Drive.
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
