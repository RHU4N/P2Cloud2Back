const { google } = require("googleapis");

function createConfigError(message) {
  const err = new Error(message);
  err.code = "CONFIG_ERROR";
  return err;
}

function getOAuthDriveClient() {
  const clientId = (process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim();
  const clientSecret = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim();
  const refreshToken = (process.env.GOOGLE_OAUTH_REFRESH_TOKEN || "").trim();

  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: "v3", auth: oauth2Client });
}

function getDriveClient({ preferOAuth = false } = {}) {
  if (preferOAuth) {
    const oauthClient = getOAuthDriveClient();
    if (oauthClient) {
      return oauthClient;
    }
  }

  const rawB64 = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 || "").trim();
  if (!rawB64) {
    throw createConfigError("Variável GOOGLE_SERVICE_ACCOUNT_JSON_B64 não configurada.");
  }

  let credentials;
  try {
    const cleanB64 = rawB64.replace(/\s+/g, "");
    const decoded = Buffer.from(cleanB64, "base64").toString("utf8");
    credentials = JSON.parse(decoded);
  } catch {
    throw createConfigError("Variável GOOGLE_SERVICE_ACCOUNT_JSON_B64 não contém um JSON válido em Base64.");
  }

  if (!credentials || !credentials.client_email || !credentials.private_key) {
    throw createConfigError("Credenciais da Service Account inválidas (client_email ou private_key ausente).");
  }

  credentials.private_key = String(credentials.private_key).replace(/\\n/g, "\n");

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  return google.drive({ version: "v3", auth });
}

function getFolderId() {
  const folderId = (process.env.GOOGLE_DRIVE_FOLDER_ID || "").trim();
  if (!folderId) {
    throw createConfigError("Variável GOOGLE_DRIVE_FOLDER_ID não configurada.");
  }
  return folderId;
}

function translateDriveWriteError(err) {
  const rawMessage = String(err?.message || "");
  const reasons = (err?.errors || err?.response?.data?.error?.errors || [])
    .map((item) => item?.reason || "")
    .join(" ");
  const status = err?.code || err?.status || err?.response?.status;

  if (
    reasons.includes("storageQuotaExceeded") ||
    rawMessage.includes("Service Accounts do not have storage quota") ||
    rawMessage.includes("storage quota")
  ) {
    return new Error(
      "A Service Account do Google não tem cota de gravação no Meu Drive pessoal. Configure GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET e GOOGLE_OAUTH_REFRESH_TOKEN no .env do backend (ou use um Drive Compartilhado)."
    );
  }

  if (
    status === 403 ||
    reasons.includes("insufficientFilePermissions") ||
    reasons.includes("cannotAddChildren")
  ) {
    return new Error(
      "Sem permissão de escrita na pasta do Google Drive. Conceda permissão de Editor ou configure OAuth2 no backend."
    );
  }

  return err;
}

async function listDriveFiles() {
  const drive = getDriveClient();
  const folderId = getFolderId();
  const files = [];
  let pageToken;

  do {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: "nextPageToken, files(id, name, mimeType, size)",
      orderBy: "name",
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const items = response.data.files || [];
    for (const file of items) {
      const mimeType = file.mimeType || "application/octet-stream";
      files.push({
        id: file.id,
        name: file.name,
        mimeType,
        size: file.size != null ? Number(file.size) : null,
        isGoogleWorkspaceFile: mimeType.startsWith("application/vnd.google-apps."),
      });
    }

    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return files;
}

async function downloadDriveFileStream(fileId) {
  const drive = getDriveClient();
  const response = await drive.files.get(
    {
      fileId,
      alt: "media",
      supportsAllDrives: true,
    },
    { responseType: "stream" }
  );
  return response.data;
}

async function driveFileExistsByName(fileName) {
  const drive = getDriveClient();
  const folderId = getFolderId();
  const escaped = String(fileName).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  const response = await drive.files.list({
    q: `'${folderId}' in parents and name = '${escaped}' and trashed = false`,
    fields: "files(id, name)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  return Boolean(response.data.files && response.data.files.length > 0);
}

async function uploadDriveFileStream(fileName, stream, mimeType) {
  const drive = getDriveClient({ preferOAuth: true });
  const folderId = getFolderId();

  try {
    const response = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId],
      },
      media: {
        mimeType: mimeType || "application/octet-stream",
        body: stream,
      },
      fields: "id, name, mimeType, size",
      supportsAllDrives: true,
    });

    return response.data;
  } catch (err) {
    throw translateDriveWriteError(err);
  }
}

async function deleteDriveFile(fileId) {
  const drive = getDriveClient({ preferOAuth: true });
  const folderId = getFolderId();

  try {
    const meta = await drive.files.get({
      fileId,
      fields: "id, name, parents, trashed",
      supportsAllDrives: true,
    });

    const parents = meta.data.parents || [];
    if (!parents.includes(folderId)) {
      throw new Error("Arquivo não pertence à pasta configurada no Google Drive.");
    }

    if (!meta.data.trashed) {
      await drive.files.update({
        fileId,
        requestBody: { trashed: true },
        supportsAllDrives: true,
      });
    }

    return {
      id: meta.data.id,
      name: meta.data.name,
    };
  } catch (err) {
    const status = err?.code || err?.status || err?.response?.status;
    const reasons = (err?.errors || err?.response?.data?.error?.errors || [])
      .map((item) => item?.reason || "")
      .join(" ");

    if (
      status === 403 ||
      reasons.includes("insufficientFilePermissions") ||
      reasons.includes("cannotTrashFile") ||
      reasons.includes("cannotDelete")
    ) {
      throw new Error(
        "Sem permissão para apagar arquivos na pasta do Google Drive. Conceda permissão de Editor ou configure OAuth2 no backend."
      );
    }

    throw translateDriveWriteError(err);
  }
}

module.exports = {
  listDriveFiles,
  downloadDriveFileStream,
  driveFileExistsByName,
  uploadDriveFileStream,
  deleteDriveFile,
};
