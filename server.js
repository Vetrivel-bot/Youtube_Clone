const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");

// Initialize file logging
const logStream = fs.createWriteStream(path.join(__dirname, "server.log"), {
  flags: "a",
});
const log = (msg) => {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}\n`;
  console.log(line.trim());
  logStream.write(line);
};

// Initialize Firebase Admin SDK
const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const app = express();
const server = http.createServer(app);
app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Upload directory setup
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// Create private directory for old files
const privateDir = path.join(__dirname, "private_uploads");
if (!fs.existsSync(privateDir)) fs.mkdirSync(privateDir);

// Serve both upload directories
app.use("/uploads", express.static(uploadDir));
app.use("/private_uploads", express.static(privateDir));

// Multer storage config
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const fname = uuidv4() + ext;
    cb(null, fname);
  },
});
const upload = multer({ storage });

// In-memory maps
const mediaMap = new Map();
const urlToKeyMap = new Map();
const messageQueue = [];

/**
 * Cleanup function to move old files to private directory
 */
async function cleanupOldFiles() {
  try {
    const now = Date.now();
    const files = await fs.promises.readdir(uploadDir);
    let movedCount = 0;

    for (const file of files) {
      const filePath = path.join(uploadDir, file);
      try {
        const stats = await fs.promises.stat(filePath);
        const fileAge = (now - stats.birthtimeMs) / (1000 * 60); // minutes

        if (fileAge > 10) {
          const destPath = path.join(privateDir, file);
          await fs.promises.rename(filePath, destPath);
          movedCount++;

          const publicUrl = `/uploads/${file}`;
          if (urlToKeyMap.has(publicUrl)) {
            const key = urlToKeyMap.get(publicUrl);
            mediaMap.delete(key);
            urlToKeyMap.delete(publicUrl);
          }
        }
      } catch (err) {
        if (err.code !== "ENOENT") {
          log(`Error processing file ${file}: ${err.message}`);
        }
      }
    }

    if (movedCount > 0) {
      log(`Moved ${movedCount} old files to private directory`);
    }
  } catch (err) {
    log(`File cleanup error: ${err.message}`);
  }
}

// Schedule cleanup every 5 minutes
setInterval(
  () => cleanupOldFiles().catch((err) => log(`Cleanup error: ${err.message}`)),
  5 * 60 * 1000
);

// Run immediately on startup, non-blocking
cleanupOldFiles().catch((err) => log(`Initial cleanup error: ${err.message}`));

app.post("/upload", upload.single("file"), (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded." });

    const url = `${req.protocol}://${req.get("host")}/uploads/${file.filename}`;
    const key = req.body.key;
    if (key) {
      mediaMap.set(key, url);
      urlToKeyMap.set(url, key);
    }
    log(`Mapped key ${key} => ${url}`);

    for (let i = messageQueue.length - 1; i >= 0; i--) {
      const queued = messageQueue[i];
      let { msg, unresolvedKeys } = queued;

      unresolvedKeys = unresolvedKeys.filter((k) => k !== key);
      msg.text = msg.text.split(key).join(url);

      if (unresolvedKeys.length === 0) {
        io.emit("newMessage", msg);
        log(`Broadcast queued message ${msg.id} after resolving all blobs`);
        messageQueue.splice(i, 1);
      } else {
        queued.unresolvedKeys = unresolvedKeys;
      }
    }

    res.json({ url, key });
  } catch (err) {
    log(`Error in /upload: ${err.message}`);
    res.status(500).json({ error: "Failed to upload file." });
  }
});

// Health check
app.get("/", (req, res) => res.status(200).send("OK"));

// Utility to list media files in a directory
async function getMediaFiles(dir, baseUrlPath) {
  const validExtensions = [
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".mp4",
    ".webm",
    ".mov",
  ];
  try {
    const files = await fs.promises.readdir(dir);
    return files
      .filter((file) =>
        validExtensions.includes(path.extname(file).toLowerCase())
      )
      .map((file) => `${baseUrlPath}/${file}`);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

// Route to fetch all images/videos
app.get("/media", async (req, res) => {
  try {
    const host = `${req.protocol}://${req.get("host")}`;
    const publicFiles = await getMediaFiles(uploadDir, `${host}/uploads`);
    const privateFiles = await getMediaFiles(
      privateDir,
      `${host}/private_uploads`
    );
    res.status(200).json({
      public: publicFiles,
      private: privateFiles,
      total: publicFiles.length + privateFiles.length,
    });
  } catch (err) {
    log(`Error in /media: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch media files" });
  }
});

// Route to delete all files in both directories
app.delete("/media", async (req, res) => {
  try {
    await Promise.all([
      fs.promises.rm(uploadDir, { recursive: true, force: true }),
      fs.promises.rm(privateDir, { recursive: true, force: true }),
    ]);
    fs.mkdirSync(uploadDir);
    fs.mkdirSync(privateDir);
    res.status(200).json({ success: true, message: "All files deleted." });
  } catch (err) {
    log(`Error deleting all files: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Route to delete all files in a specific scope (public or private)
app.delete("/media/:scope", async (req, res) => {
  const { scope } = req.params;
  if (scope !== "public" && scope !== "private") {
    return res.status(400).json({ success: false, error: "Invalid scope" });
  }
  const dir = scope === "private" ? privateDir : uploadDir;
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    res
      .status(200)
      .json({ success: true, message: `All ${scope} files deleted.` });
  } catch (err) {
    log(`Error deleting ${scope} files: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Route to delete a specific file in a scope
app.delete("/media/:scope/:filename", async (req, res) => {
  const { scope, filename } = req.params;
  if (scope !== "public" && scope !== "private") {
    return res.status(400).json({ success: false, error: "Invalid scope" });
  }
  const dir = scope === "private" ? privateDir : uploadDir;
  const filePath = path.join(dir, filename);
  try {
    await fs.promises.unlink(filePath);
    res
      .status(200)
      .json({ success: true, message: `${filename} deleted from ${scope}.` });
  } catch (err) {
    log(`Error deleting file ${filename} from ${scope}: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Notification helpers (Firebase Cloud Messaging)
const hardcodedFcmToken = `f7IiWa2FSMCnV42OpcouJH:APA91bHHXEwGBbx1rUOaq2GIw-pZPe7X645vrtVedhCi6-zOdZAxBrWjumw56HCpFffHxmbYYlKU3yhk4ojUq1tgxDa9VRrAg28z2UgnIR2a8cNaMGSWbII`;
const sendNotification = async (customBody, clientIp) => {
  const timestamp = new Date().toISOString();
  const bodyWithTs = `${customBody} at ${timestamp}${
    clientIp ? ` (IP: ${clientIp})` : ""
  }`;
  const message = {
    token: hardcodedFcmToken,
    notification: { title: "Socket Status Update", body: bodyWithTs },
    data: { timestamp, ...(clientIp && { clientIp }) },
  };
  log(`Sending notification: "${message.notification.body}"`);
  const response = await admin.messaging().send(message);
  log(`Notification sent successfully, message ID: ${response}`);
  return { messageId: response, timestamp };
};

// Manual notify endpoint
app.get("/notify", async (req, res) => {
  const clientIp =
    req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip;
  if (
    ["127.0.0.1", "::1"].includes(clientIp) ||
    clientIp.match(/^(10\.|192\.168\.|172\.16\.)/)
  ) {
    log(`Internal IP ${clientIp} - skipping notification`);
    return res.status(200).json({
      success: true,
      message: "Health check/internal call",
      ip: clientIp,
    });
  }
  log(`Received GET /notify from IP: ${clientIp}`);
  try {
    const result = await sendNotification(
      "Manual notification triggered",
      clientIp
    );
    res.status(200).json({ success: true, ...result, ip: clientIp });
  } catch (err) {
    log(`Error in /notify: ${err.message}`);
    res
      .status(500)
      .json({ success: false, error: "Failed to send notification" });
  }
});

// Website visit endpoint
app.get("/website", async (req, res) => {
  const clientIp =
    req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip;
  log(`Received GET /website from IP: ${clientIp}`);
  try {
    const result = await sendNotification("Visitor at /website", clientIp);
    res.status(200).json({ success: true, ...result, ip: clientIp });
  } catch (err) {
    log(`Error in /website: ${err.message}`);
    res
      .status(500)
      .json({ success: false, error: "Failed to send notification" });
  }
});

// Socket.IO setup
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

io.on("connection", (socket) => {
  const clientIp =
    socket.handshake.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    socket.handshake.address;
  log(`Client connected: ${socket.id} from IP: ${clientIp}`);
  sendNotification(`A new client connected. Socket ID: ${socket.id}`, clientIp);

  socket.on("blobUploadComplete", ({ key, url }) => {
    mediaMap.set(key, url);
    urlToKeyMap.set(url, key);
    log(`Received blobUploadComplete for ${key} -> ${url}`);

    for (let i = messageQueue.length - 1; i >= 0; i--) {
      const queued = messageQueue[i];
      let { msg, unresolvedKeys } = queued;

      unresolvedKeys = unresolvedKeys.filter((k) => k !== key);
      msg.text = msg.text.split(key).join(url);

      if (unresolvedKeys.length === 0) {
        io.emit("newMessage", msg);
        log(`Broadcast queued message ${msg.id} after resolving all blobs`);
        messageQueue.splice(i, 1);
      } else {
        queued.unresolvedKeys = unresolvedKeys;
      }
    }
  });

  socket.on("sendMessage", async (msg) => {
    log(`sendMessage from ${socket.id}: ${JSON.stringify(msg)}`);

    if (msg.media && msg.mediaUrl) {
      io.emit("newMessage", msg);
      return;
    }

    let text = msg.text;
    const unresolvedKeys = [];

    mediaMap.forEach((url, key) => {
      if (text.includes(key)) {
        text = text.split(key).join(url);
      }
    });

    const blobRegex = /blob:[^\s]+/g;
    const blobUrls = text.match(blobRegex) || [];
    for (const blobUrl of blobUrls) {
      if (!mediaMap.has(blobUrl)) {
        unresolvedKeys.push(blobUrl);
        socket.emit("requestBlobUpload", blobUrl);
        log(`Requested client to upload blob ${blobUrl}`);
      }
    }

    if (unresolvedKeys.length > 0) {
      messageQueue.push({ msg: { ...msg, text }, unresolvedKeys });
      return;
    }

    const modifiedMsg = { ...msg, text };
    io.emit("newMessage", modifiedMsg);
  });

  socket.on("disconnect", () => {
    log(`Client disconnected: ${socket.id}`);
    sendNotification(
      `A client disconnected. Socket ID: ${socket.id}`,
      clientIp
    );
  });
});

// Start server
server.listen(5000, "0.0.0.0", () => {
  log("Socket.io server running on port 5000 and accepting all IPs");
});
