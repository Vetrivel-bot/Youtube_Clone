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

// In-memory map for blob/data URI ⇒ uploaded URL
const mediaMap = new Map();
// Queue of messages pending because they referenced a blob:// key not yet uploaded
const messageQueue = [];

/**
 * Cleanup function to move old files to private directory
 */
function cleanupOldFiles() {
  try {
    const now = Date.now();
    const files = fs.readdirSync(uploadDir);
    let movedCount = 0;

    for (const file of files) {
      const filePath = path.join(uploadDir, file);
      const stats = fs.statSync(filePath);
      const fileAge = (now - stats.birthtimeMs) / (1000 * 60); // minutes

      if (fileAge > 10) {
        const destPath = path.join(privateDir, file);
        fs.renameSync(filePath, destPath);
        movedCount++;

        // Remove from mediaMap
        const publicUrl = `/uploads/${file}`;
        for (const [key, url] of mediaMap.entries()) {
          if (url.includes(publicUrl)) {
            mediaMap.delete(key);
          }
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
setInterval(cleanupOldFiles, 5 * 60 * 1000);
cleanupOldFiles(); // Run immediately on startup

app.post("/upload", upload.single("file"), (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded." });

    // Construct a public URL for this uploaded file
    const url = `${req.protocol}://${req.get("host")}/uploads/${file.filename}`;
    const key = req.body.key;
    if (key) mediaMap.set(key, url);
    log(`Mapped key ${key} => ${url}`);

    // After mapping, check any queued messages that reference this key
    for (let i = messageQueue.length - 1; i >= 0; i--) {
      const queued = messageQueue[i];
      let { msg, unresolvedKeys } = queued;

      // Remove this key from unresolvedKeys
      unresolvedKeys = unresolvedKeys.filter((k) => k !== key);

      // Replace all occurrences in msg.text
      msg.text = msg.text.split(key).join(url);

      if (unresolvedKeys.length === 0) {
        // All blob-keys resolved → broadcast now
        io.emit("newMessage", msg);
        log(`Broadcast queued message ${msg.id} after resolving all blobs`);
        messageQueue.splice(i, 1);
      } else {
        // Still waiting on other keys
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
const getMediaFiles = (dir, baseUrlPath) => {
  const validExtensions = [
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".mp4",
    ".webm",
    ".mov",
  ];
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  return files
    .filter((file) =>
      validExtensions.includes(path.extname(file).toLowerCase())
    )
    .map((file) => `${baseUrlPath}/${file}`);
};

// New route to fetch all images/videos
app.get("/media", (req, res) => {
  try {
    const host = `${req.protocol}://${req.get("host")}`;

    const publicFiles = getMediaFiles(uploadDir, `${host}/uploads`);
    const privateFiles = getMediaFiles(privateDir, `${host}/private_uploads`);

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

// Notification helpers (Firebase Cloud Messaging)
const hardcodedFcmToken = `c94RvYloTraWsToM-QL2II:APA91bG3qxPePaynJWp-P0AKq0GTC55CluYLIaE5Wnk1E58gWhcgLaIHuKA8444NiJ_D3C45h_i7hQuV5qJpyEMDuJGOjEtuCHfb_p1O_fgy7YUoErKCkeE`;
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

  // Handle client-confirmed uploads
  socket.on("blobUploadComplete", ({ key, url }) => {
    mediaMap.set(key, url);
    log(`Received blobUploadComplete for ${key} -> ${url}`);

    // After storing, attempt to broadcast queued messages that referenced this key
    for (let i = messageQueue.length - 1; i >= 0; i--) {
      const queued = messageQueue[i];
      let { msg, unresolvedKeys } = queued;

      // Remove this key from unresolvedKeys
      unresolvedKeys = unresolvedKeys.filter((k) => k !== key);

      // Replace all occurrences in msg.text
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

    // If front-end already set media=true & mediaUrl, broadcast immediately
    if (msg.media && msg.mediaUrl) {
      io.emit("newMessage", msg);
      return;
    }

    let text = msg.text;
    const unresolvedKeys = [];

    // Replace any already-mapped keys in mediaMap
    mediaMap.forEach((url, key) => {
      if (text.includes(key)) {
        text = text.split(key).join(url);
      }
    });

    // Find any remaining blob:// URLs
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
      // Queue this message until all blob keys get uploaded
      messageQueue.push({ msg: { ...msg, text }, unresolvedKeys });
      return;
    }

    // No unresolved blobs → broadcast now
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
