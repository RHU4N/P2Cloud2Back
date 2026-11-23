const { google } = require("googleapis");

function createConfigError(message) {
  const err = new Error(message);
  err.code = "CONFIG_ERROR";
  return err;
}

function getDriveClient() {
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
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
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

module.exports = {
  listDriveFiles,
  downloadDriveFileStream,
};
