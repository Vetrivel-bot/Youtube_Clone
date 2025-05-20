const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

// Initialize file logging
const logStream = fs.createWriteStream(path.join(__dirname, 'server.log'), { flags: 'a' });
const log = (msg) => {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}\n`;
  console.log(line.trim());
  logStream.write(line);
};

// Initialize Firebase Admin SDK
const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
const server = http.createServer(app);

// Trust proxy so we can get real client IP from X-Forwarded-For
app.set("trust proxy", true);

// Middleware
app.use(cors());
app.use(express.json());

// Helper: Send FCM Notification with optional IP and timestamp
const sendNotification = async (customBody = "Default notification body", clientIp = null) => {
  const timestamp = new Date().toISOString();
  const bodyWithTs = `${customBody} at ${timestamp}${clientIp ? ` (IP: ${clientIp})` : ""}`;
  const message = {
    token: hardcodedFcmToken,
    notification: {
      title: "Socket Status Update",
      body: bodyWithTs,
    },
    data: {
      timestamp,
      ...(clientIp && { clientIp }),
    },
  };

  log(`Sending notification: "${message.notification.body}"`);
  const response = await admin.messaging().send(message);
  log(`Notification sent successfully, message ID: ${response}`);
  return { messageId: response, timestamp };
};

// Root endpoint for health checks (no notification)
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

// Explicit notification trigger
app.get("/notify", async (req, res) => {
  const clientIp = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip;

  // Skip internal/private IPs
  if (
    clientIp === "127.0.0.1" ||
    clientIp === "::1" ||
    clientIp.startsWith("10.") ||
    clientIp.startsWith("192.168.") ||
    clientIp.startsWith("172.16.")
  ) {
    log(`Internal IP ${clientIp} - skipping notification`);
    return res.status(200).json({ success: true, message: "Health check/internal call", ip: clientIp });
  }

  log(`Received GET /notify from IP: ${clientIp}`);
  try {
    const result = await sendNotification("Manual notification triggered", clientIp);
    res.status(200).json({ success: true, ...result, ip: clientIp });
  } catch (err) {
    log(`Error in /notify: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to send notification" });
  }
});

// Website‐visit endpoint
app.get("/website", async (req, res) => {
  const clientIp = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip;
  log(`Received GET /website from IP: ${clientIp}`);
  try {
    const result = await sendNotification("Visitor at /website", clientIp);
    res.status(200).json({ success: true, ...result, ip: clientIp });
  } catch (err) {
    log(`Error in /website: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to send notification" });
  }
});

// Socket.IO setup
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});
io.on("connection", (socket) => {
  const xfwd = socket.handshake.headers["x-forwarded-for"];
  const clientIp = xfwd ? xfwd.split(",")[0].trim() : socket.handshake.address;
  log(`Client connected: ${socket.id} from IP: ${clientIp}`);
  sendNotification(`A new client connected. Socket ID: ${socket.id}`, clientIp);

  socket.on("sendMessage", (msg) => {
    log(`sendMessage from ${socket.id}: ${JSON.stringify(msg)}`);
    io.emit("newMessage", msg);
  });

  socket.on("disconnect", () => {
    log(`Client disconnected: ${socket.id}`);
    sendNotification(`A client disconnected. Socket ID: ${socket.id}`, clientIp);
  });
});

// Hardcoded FCM Token (replace as needed)
const hardcodedFcmToken = `c94RvYloTraWsToM-QL2II:APA91bG3qxPePaynJWp-P0AKq0GTC55CluYLIaE5Wnk1E58gWhcgLaIHuKA8444NiJ_D3C45h_i7hQuV5qJpyEMDuJGOjEtuCHfb_p1O_fgy7YUoErKCkeE`;

// Start the server
server.listen(5000, "0.0.0.0", () => {
  log("Socket.io server running on port 5000 and accepting all IPs");
});
