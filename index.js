require("dotenv").config();

const path = require("path");
const { Readable } = require("stream");
const express = require("express");
const cors = require("cors");
const multer = require("multer");

const {
  listDriveFiles,
  downloadDriveFileStream,
  driveFileExistsByName,
  uploadDriveFileStream,
  deleteDriveFile,
} = require("./services/googleDrive");
const {
  getContainerName,
  listBlobFiles,
  blobExists,
  uploadBlobStream,
  downloadBlobStream,
  deleteBlobFile,
} = require("./services/azureBlob");

const app = express();

const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }
      const cleanOrigin = origin.replace(/\/+$/, "");
      return callback(null, allowedOrigins.includes(cleanOrigin));
    },
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 20,
  },
});

function decodeUploadFilename(originalname) {
  let name = originalname || "arquivo";
  try {
    if (/[ÃÂ]/.test(name)) {
      name = Buffer.from(name, "latin1").toString("utf8");
    }
  } catch {
    name = originalname || "arquivo";
  }
  return path.basename(name);
}

async function executeTransfer(
  fileIds = null,
  deps = {
    listDriveFiles,
    downloadDriveFileStream,
    blobExists,
    uploadBlobStream,
  }
) {
  const allDriveFiles = await deps.listDriveFiles();
  const hasFilter = Array.isArray(fileIds) && fileIds.length > 0;
  const selectedIdSet = hasFilter
    ? new Set(fileIds.map((id) => String(id).trim()).filter(Boolean))
    : null;
  const driveFiles = selectedIdSet
    ? allDriveFiles.filter((file) => selectedIdSet.has(file.id))
    : allDriveFiles;

  console.log("Iniciando migração (Drive -> Azure)...\n");

  let uploadedCount = 0;
  let ignoredCount = 0;
  let errorCount = 0;
  const results = [];

  for (const file of driveFiles) {
    if (file.isGoogleWorkspaceFile) {
      ignoredCount += 1;
      const message = "Arquivo nativo do Google Docs/Sheets/Slides precisa de exportação.";
      console.log(`[IGNORADO] ${file.name} - Arquivo nativo do Google precisa de exportação.`);
      results.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        status: "ignored",
        message,
      });
      continue;
    }

    try {
      const alreadyExists = await deps.blobExists(file.name);
      if (alreadyExists) {
        ignoredCount += 1;
        console.log(`[IGNORADO] ${file.name} já existe no Azure.`);
        results.push({
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          status: "ignored",
          message: "Arquivo já existe no Azure e foi ignorado.",
        });
        continue;
      }

      const stream = await deps.downloadDriveFileStream(file.id);
      await deps.uploadBlobStream(file.name, stream, file.mimeType);

      uploadedCount += 1;
      console.log(`[OK] ${file.name} enviado para o Azure.`);
      results.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        status: "success",
        message: "Arquivo enviado para o Azure com sucesso.",
      });
    } catch (err) {
      if (err && err.code === "CONFIG_ERROR") {
        throw err;
      }

      if (err && err.statusCode === 412) {
        ignoredCount += 1;
        console.log(`[IGNORADO] ${file.name} já existe no Azure.`);
        results.push({
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          status: "ignored",
          message: "Arquivo já existe no Azure e foi ignorado.",
        });
        continue;
      }

      errorCount += 1;
      const reason = (err && err.message) || "Falha na transferência.";
      console.error(`[ERRO] ${file.name} - ${reason}`);
      results.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        status: "error",
        message: reason,
      });
    }
  }

  console.log("\nMigração finalizada.");
  console.log(`Sucesso: ${uploadedCount} | Ignorados: ${ignoredCount} | Erros: ${errorCount}`);

  return {
    message: "Migração finalizada.",
    direction: "drive-to-blob",
    summary: {
      total: driveFiles.length,
      uploaded: uploadedCount,
      ignored: ignoredCount,
      errors: errorCount,
    },
    files: results,
  };
}

async function executeBlobToDriveTransfer(
  fileNames = null,
  deps = {
    listBlobFiles,
    driveFileExistsByName,
    downloadBlobStream,
    uploadDriveFileStream,
  }
) {
  const allBlobs = await deps.listBlobFiles();
  const hasFilter = Array.isArray(fileNames) && fileNames.length > 0;
  const selectedNameSet = hasFilter
    ? new Set(fileNames.map((name) => String(name).trim()).filter(Boolean))
    : null;
  const blobs = selectedNameSet
    ? allBlobs.filter((blob) => selectedNameSet.has(blob.name))
    : allBlobs;

  console.log("Iniciando migração (Azure -> Drive)...\n");

  let uploadedCount = 0;
  let ignoredCount = 0;
  let errorCount = 0;
  const results = [];

  for (const blob of blobs) {
    try {
      const alreadyExists = await deps.driveFileExistsByName(blob.name);
      if (alreadyExists) {
        ignoredCount += 1;
        console.log(`[IGNORADO] ${blob.name} já existe no Google Drive.`);
        results.push({
          name: blob.name,
          size: blob.size,
          status: "ignored",
          message: "Arquivo já existe no Google Drive e foi ignorado.",
        });
        continue;
      }

      const downloaded = await deps.downloadBlobStream(blob.name);
      await deps.uploadDriveFileStream(
        blob.name,
        downloaded.stream,
        blob.contentType || downloaded.contentType
      );

      uploadedCount += 1;
      console.log(`[OK] ${blob.name} enviado para o Google Drive.`);
      results.push({
        name: blob.name,
        size: blob.size,
        status: "success",
        message: "Arquivo enviado para o Google Drive com sucesso.",
      });
    } catch (err) {
      if (err && err.code === "CONFIG_ERROR") {
        throw err;
      }

      errorCount += 1;
      const reason = (err && err.message) || "Falha ao enviar para o Google Drive.";
      console.error(`[ERRO] ${blob.name} - ${reason}`);
      results.push({
        name: blob.name,
        size: blob.size,
        status: "error",
        message: reason,
      });
    }
  }

  console.log("\nMigração Azure -> Drive finalizada.");
  console.log(`Sucesso: ${uploadedCount} | Ignorados: ${ignoredCount} | Erros: ${errorCount}`);

  return {
    message: "Migração Azure → Drive finalizada.",
    direction: "blob-to-drive",
    summary: {
      total: blobs.length,
      uploaded: uploadedCount,
      ignored: ignoredCount,
      errors: errorCount,
    },
    files: results,
  };
}

async function executeDeleteBlobFiles(fileNames, deps = { deleteBlobFile }) {
  const uniqueNames = Array.from(
    new Set((fileNames || []).map((name) => String(name).trim()).filter(Boolean))
  );

  console.log("Iniciando exclusão no Azure...\n");

  let deletedCount = 0;
  let ignoredCount = 0;
  let errorCount = 0;
  const results = [];

  for (const fileName of uniqueNames) {
    try {
      const removed = await deps.deleteBlobFile(fileName);
      if (removed) {
        deletedCount += 1;
        console.log(`[OK] ${fileName} removido do Azure.`);
        results.push({
          name: fileName,
          status: "deleted",
          message: "Arquivo removido do Azure com sucesso.",
        });
      } else {
        ignoredCount += 1;
        console.log(`[IGNORADO] ${fileName} não encontrado no Azure.`);
        results.push({
          name: fileName,
          status: "ignored",
          message: "Arquivo não encontrado no Azure.",
        });
      }
    } catch (err) {
      if (err && err.code === "CONFIG_ERROR") {
        throw err;
      }
      errorCount += 1;
      const reason = (err && err.message) || "Falha ao remover arquivo do Azure.";
      console.error(`[ERRO] ${fileName} - ${reason}`);
      results.push({
        name: fileName,
        status: "error",
        message: reason,
      });
    }
  }

  console.log("\nExclusão no Azure finalizada.");
  console.log(`Excluídos: ${deletedCount} | Ignorados: ${ignoredCount} | Erros: ${errorCount}`);

  return {
    message: "Exclusão no Azure finalizada.",
    target: "blob",
    summary: {
      total: uniqueNames.length,
      deleted: deletedCount,
      ignored: ignoredCount,
      errors: errorCount,
    },
    files: results,
  };
}

async function executeDeleteDriveFiles(
  fileIds,
  deps = { listDriveFiles, deleteDriveFile }
) {
  const uniqueIds = Array.from(
    new Set((fileIds || []).map((id) => String(id).trim()).filter(Boolean))
  );

  const nameById = new Map();
  try {
    const driveFiles = await deps.listDriveFiles();
    for (const file of driveFiles) {
      nameById.set(file.id, file.name);
    }
  } catch {
    // Segue mesmo se a listagem auxiliar de nomes falhar.
  }

  console.log("Iniciando exclusão no Google Drive...\n");

  let deletedCount = 0;
  let errorCount = 0;
  const results = [];

  for (const fileId of uniqueIds) {
    const fallbackName = nameById.get(fileId) || fileId;
    try {
      const removed = await deps.deleteDriveFile(fileId);
      const displayName = (removed && removed.name) || fallbackName;
      deletedCount += 1;
      console.log(`[OK] ${displayName} removido do Google Drive.`);
      results.push({
        id: fileId,
        name: displayName,
        status: "deleted",
        message: "Arquivo movido para a lixeira do Google Drive.",
      });
    } catch (err) {
      if (err && err.code === "CONFIG_ERROR") {
        throw err;
      }
      errorCount += 1;
      const reason = (err && err.message) || "Falha ao remover arquivo do Google Drive.";
      console.error(`[ERRO] ${fallbackName} - ${reason}`);
      results.push({
        id: fileId,
        name: fallbackName,
        status: "error",
        message: reason,
      });
    }
  }

  console.log("\nExclusão no Google Drive finalizada.");
  console.log(`Excluídos: ${deletedCount} | Erros: ${errorCount}`);

  return {
    message: "Exclusão no Google Drive finalizada.",
    target: "drive",
    summary: {
      total: uniqueIds.length,
      deleted: deletedCount,
      ignored: 0,
      errors: errorCount,
    },
    files: results,
  };
}

app.get("/", (req, res) => {
  res.status(200).json({
    message: "API P2Cloud2Back em execução. Consulte /api/health.",
  });
});

app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "P2Cloud2Back",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/drive/files", async (req, res) => {
  try {
    const files = await listDriveFiles();
    res.status(200).json({
      count: files.length,
      files,
    });
  } catch (err) {
    const status = err && err.code === "CONFIG_ERROR" ? 503 : 500;
    res.status(status).json({
      error: (err && err.message) || "Erro ao listar arquivos do Google Drive.",
    });
  }
});

app.get("/api/blob/files", async (req, res) => {
  try {
    const files = await listBlobFiles();
    res.status(200).json({
      container: getContainerName(),
      count: files.length,
      files,
    });
  } catch (err) {
    const status = err && err.code === "CONFIG_ERROR" ? 503 : 500;
    res.status(status).json({
      error: (err && err.message) || "Erro ao listar arquivos do Azure Blob Storage.",
    });
  }
});

let transferring = false;

app.post("/api/transfer", async (req, res) => {
  if (transferring) {
    return res.status(409).json({
      error: "Já existe uma migração em andamento. Aguarde a conclusão.",
    });
  }

  if (req.body && Array.isArray(req.body.fileIds) && req.body.fileIds.length === 0) {
    return res.status(400).json({
      error: "Selecione pelo menos um arquivo para transferir.",
    });
  }

  const selectedIds = req.body && Array.isArray(req.body.fileIds) ? req.body.fileIds : null;

  transferring = true;
  try {
    const result = await executeTransfer(selectedIds);
    res.status(200).json(result);
  } catch (err) {
    const status = err && err.code === "CONFIG_ERROR" ? 503 : 500;
    res.status(status).json({
      error: (err && err.message) || "Erro ao executar a migração.",
    });
  } finally {
    transferring = false;
  }
});

app.post("/api/transfer/blob-to-drive", async (req, res) => {
  if (transferring) {
    return res.status(409).json({
      error: "Já existe uma operação em andamento. Aguarde a conclusão.",
    });
  }

  if (req.body && Array.isArray(req.body.fileNames) && req.body.fileNames.length === 0) {
    return res.status(400).json({
      error: "Selecione pelo menos um arquivo do Azure para transferir.",
    });
  }

  const selectedNames =
    req.body && Array.isArray(req.body.fileNames) ? req.body.fileNames : null;

  transferring = true;
  try {
    const result = await executeBlobToDriveTransfer(selectedNames);
    res.status(200).json(result);
  } catch (err) {
    const status = err && err.code === "CONFIG_ERROR" ? 503 : 500;
    res.status(status).json({
      error: (err && err.message) || "Erro ao transferir do Azure para o Google Drive.",
    });
  } finally {
    transferring = false;
  }
});

app.post("/api/upload/blob", upload.array("files", 20), async (req, res) => {
  if (transferring) {
    return res.status(409).json({
      error: "Já existe uma operação em andamento. Aguarde a conclusão.",
    });
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({
      error: "Envie pelo menos um arquivo.",
    });
  }

  transferring = true;
  try {
    console.log("Iniciando upload do site para o Azure...\n");
    let uploadedCount = 0;
    let ignoredCount = 0;
    let errorCount = 0;
    const results = [];

    for (const file of req.files) {
      const fileName = decodeUploadFilename(file.originalname);

      try {
        const exists = await blobExists(fileName);
        if (exists) {
          ignoredCount += 1;
          console.log(`[IGNORADO] ${fileName} já existe no Azure.`);
          results.push({
            name: fileName,
            size: file.size,
            status: "ignored",
            message: "Arquivo já existe no Azure e foi ignorado.",
          });
          continue;
        }

        await uploadBlobStream(fileName, Readable.from(file.buffer), file.mimetype);
        uploadedCount += 1;
        console.log(`[OK] ${fileName} enviado para o Azure.`);
        results.push({
          name: fileName,
          size: file.size,
          status: "success",
          message: "Arquivo enviado para o Azure com sucesso.",
        });
      } catch (err) {
        if (err && err.code === "CONFIG_ERROR") {
          throw err;
        }
        if (err && err.statusCode === 412) {
          ignoredCount += 1;
          results.push({
            name: fileName,
            size: file.size,
            status: "ignored",
            message: "Arquivo já existe no Azure e foi ignorado.",
          });
          continue;
        }
        errorCount += 1;
        const reason = (err && err.message) || "Falha no upload para o Azure.";
        console.error(`[ERRO] ${fileName} - ${reason}`);
        results.push({
          name: fileName,
          size: file.size,
          status: "error",
          message: reason,
        });
      }
    }

    res.status(200).json({
      message: "Upload para o Azure finalizado.",
      destination: "blob",
      summary: {
        total: req.files.length,
        uploaded: uploadedCount,
        ignored: ignoredCount,
        errors: errorCount,
      },
      files: results,
    });
  } catch (err) {
    const status = err && err.code === "CONFIG_ERROR" ? 503 : 500;
    res.status(status).json({
      error: (err && err.message) || "Erro ao enviar arquivos para o Azure.",
    });
  } finally {
    transferring = false;
  }
});

app.post("/api/upload/drive", upload.array("files", 20), async (req, res) => {
  if (transferring) {
    return res.status(409).json({
      error: "Já existe uma operação em andamento. Aguarde a conclusão.",
    });
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({
      error: "Envie pelo menos um arquivo.",
    });
  }

  transferring = true;
  try {
    console.log("Iniciando upload do site para o Google Drive...\n");
    let uploadedCount = 0;
    let ignoredCount = 0;
    let errorCount = 0;
    const results = [];

    for (const file of req.files) {
      const fileName = decodeUploadFilename(file.originalname);

      try {
        const exists = await driveFileExistsByName(fileName);
        if (exists) {
          ignoredCount += 1;
          console.log(`[IGNORADO] ${fileName} já existe no Google Drive.`);
          results.push({
            name: fileName,
            size: file.size,
            status: "ignored",
            message: "Arquivo já existe no Google Drive e foi ignorado.",
          });
          continue;
        }

        await uploadDriveFileStream(fileName, Readable.from(file.buffer), file.mimetype);
        uploadedCount += 1;
        console.log(`[OK] ${fileName} enviado para o Google Drive.`);
        results.push({
          name: fileName,
          size: file.size,
          status: "success",
          message: "Arquivo enviado para o Google Drive com sucesso.",
        });
      } catch (err) {
        if (err && err.code === "CONFIG_ERROR") {
          throw err;
        }
        errorCount += 1;
        const reason = (err && err.message) || "Falha no upload para o Google Drive.";
        console.error(`[ERRO] ${fileName} - ${reason}`);
        results.push({
          name: fileName,
          size: file.size,
          status: "error",
          message: reason,
        });
      }
    }

    res.status(200).json({
      message: "Upload para o Google Drive finalizado.",
      destination: "drive",
      summary: {
        total: req.files.length,
        uploaded: uploadedCount,
        ignored: ignoredCount,
        errors: errorCount,
      },
      files: results,
    });
  } catch (err) {
    const status = err && err.code === "CONFIG_ERROR" ? 503 : 500;
    res.status(status).json({
      error: (err && err.message) || "Erro ao enviar arquivos para o Google Drive.",
    });
  } finally {
    transferring = false;
  }
});

app.delete("/api/blob/files", async (req, res) => {
  if (transferring) {
    return res.status(409).json({
      error: "Já existe uma operação em andamento. Aguarde a conclusão.",
    });
  }

  const fileNames = req.body && Array.isArray(req.body.fileNames) ? req.body.fileNames : [];
  const validNames = fileNames.map((name) => String(name).trim()).filter(Boolean);
  if (validNames.length === 0) {
    return res.status(400).json({
      error: "Informe pelo menos um arquivo do Azure para apagar.",
    });
  }

  transferring = true;
  try {
    const result = await executeDeleteBlobFiles(validNames);
    res.status(200).json(result);
  } catch (err) {
    const status = err && err.code === "CONFIG_ERROR" ? 503 : 500;
    res.status(status).json({
      error: (err && err.message) || "Erro ao apagar arquivos do Azure.",
    });
  } finally {
    transferring = false;
  }
});

app.delete("/api/drive/files", async (req, res) => {
  if (transferring) {
    return res.status(409).json({
      error: "Já existe uma operação em andamento. Aguarde a conclusão.",
    });
  }

  const fileIds = req.body && Array.isArray(req.body.fileIds) ? req.body.fileIds : [];
  const validIds = fileIds.map((id) => String(id).trim()).filter(Boolean);
  if (validIds.length === 0) {
    return res.status(400).json({
      error: "Informe pelo menos um arquivo do Google Drive para apagar.",
    });
  }

  transferring = true;
  try {
    const result = await executeDeleteDriveFiles(validIds);
    res.status(200).json(result);
  } catch (err) {
    const status = err && err.code === "CONFIG_ERROR" ? 503 : 500;
    res.status(status).json({
      error: (err && err.message) || "Erro ao apagar arquivos do Google Drive.",
    });
  } finally {
    transferring = false;
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      error:
        err.code === "LIMIT_FILE_SIZE"
          ? "Arquivo excede o limite máximo de 100 MB."
          : err.code === "LIMIT_FILE_COUNT"
          ? "Máximo de 20 arquivos por envio."
          : `Erro no envio de arquivos: ${err.message}`,
    });
  }
  return next(err);
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
  });
}

module.exports = {
  app,
  executeTransfer,
  executeBlobToDriveTransfer,
  executeDeleteBlobFiles,
  executeDeleteDriveFiles,
};
