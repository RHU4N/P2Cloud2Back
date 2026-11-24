require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { listDriveFiles, downloadDriveFileStream } = require("./services/googleDrive");
const {
  getContainerName,
  listBlobFiles,
  blobExists,
  uploadBlobStream,
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
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json());

async function executeTransfer(
  deps = {
    listDriveFiles,
    downloadDriveFileStream,
    blobExists,
    uploadBlobStream,
  }
) {
  const driveFiles = await deps.listDriveFiles();

  console.log("Iniciando migração...\n");

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
    summary: {
      total: driveFiles.length,
      uploaded: uploadedCount,
      ignored: ignoredCount,
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

app.post("/api/transfer", async (req, res) => {
  try {
    const result = await executeTransfer();
    res.status(200).json(result);
  } catch (err) {
    const status = err && err.code === "CONFIG_ERROR" ? 503 : 500;
    res.status(status).json({
      error: (err && err.message) || "Erro ao executar a migração.",
    });
  }
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
  });
}

module.exports = { app, executeTransfer };
