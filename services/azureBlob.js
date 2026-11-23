const { BlobServiceClient } = require("@azure/storage-blob");

function createConfigError(message) {
  const err = new Error(message);
  err.code = "CONFIG_ERROR";
  return err;
}

function getContainerName() {
  return (process.env.AZURE_CONTAINER_NAME || "aluno-rhuan").trim() || "aluno-rhuan";
}

function getContainerClient() {
  const connectionString = (process.env.AZURE_STORAGE_CONNECTION_STRING || "").trim();
  if (!connectionString) {
    throw createConfigError("Variável AZURE_STORAGE_CONNECTION_STRING não configurada.");
  }

  const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
  return blobServiceClient.getContainerClient(getContainerName());
}

async function listBlobFiles() {
  const containerClient = getContainerClient();
  const files = [];

  for await (const blob of containerClient.listBlobsFlat()) {
    files.push({
      name: blob.name,
      size: blob.properties.contentLength ?? 0,
      contentType: blob.properties.contentType || null,
      lastModified: blob.properties.lastModified || null,
    });
  }

  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

async function blobExists(blobName) {
  const containerClient = getContainerClient();
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  return blockBlobClient.exists();
}

async function uploadBlobStream(blobName, stream, contentType) {
  const containerClient = getContainerClient();
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  await blockBlobClient.uploadStream(stream, 4 * 1024 * 1024, 5, {
    blobHTTPHeaders: {
      blobContentType: contentType || "application/octet-stream",
    },
    conditions: {
      ifNoneMatch: "*",
    },
  });
}

module.exports = {
  getContainerName,
  listBlobFiles,
  blobExists,
  uploadBlobStream,
};
