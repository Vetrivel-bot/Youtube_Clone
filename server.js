const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const admin = require("firebase-admin");

// Initialize Firebase Admin SDK
const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.json());

// Helper: Send FCM Notification with optional IP
const sendNotification = async (customBody = "Default notification body", clientIp = null) => {
  const message = {
    token: hardcodedFcmToken,
    notification: {
      title: "Socket Status Update",
      body: clientIp ? `${customBody} (IP: ${clientIp})` : customBody,
    },
    data: {
      customKey: "customValue",
      ...(clientIp && { clientIp }),
    },
  };

  try {
    const response = await admin.messaging().send(message);
    console.log("Notification sent, message ID:", response);
    return { messageId: response };
  } catch (error) {
    console.error("Error sending notification:", error);
    throw error;
  }
};

// Manual GET trigger
app.get("/", async (req, res) => {
  try {
    const clientIp = req.ip;
    await sendNotification("Hello from server!", clientIp);
    res.status(200).json({ success: true, message: "Hello from server!", ip: clientIp });
  } catch (err) {
    res.status(500).json({ success: false, error: "Something went wrong" });
  }
});

// Socket.IO setup
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

io.on("connection", (socket) => {
  const clientIp = socket.handshake.address;
  console.log(`New client connected: ${socket.id} (IP: ${clientIp})`);

  // Notify on connection
  sendNotification(`A new client has connected. Socket ID: ${socket.id}`, clientIp);

  socket.on("sendMessage", (msg) => {
    io.emit("newMessage", msg);
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
    sendNotification(`A client has disconnected. Socket ID: ${socket.id}`, clientIp);
  });
});

// Other endpoints
app.get("/notify", async (req, res) => {
  try {
    const clientIp = req.ip;
    const response = await sendNotification(
      "Manual notification triggered via GET /notify",
      clientIp
    );
    res.status(200).json({ success: true, response, ip: clientIp });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to send notification" });
  }
});

app.get("/website", async (req, res) => {
  try {
    const clientIp = req.ip;
    const response = await sendNotification(
      "Someone entered the website /website",
      clientIp
    );
    res.status(200).json({ success: true, response, ip: clientIp });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to send notification" });
  }
});

// Hardcoded FCM Token (replace as needed)
const hardcodedFcmToken = `c94RvYloTraWsToM-QL2II:APA91bG3qxPePaynJWp-P0AKq0GTC55CluYLIaE5Wnk1E58gWhcgLaIHuKA8444NiJ_D3C45h_i7hQuV5qJpyEMDuJGOjEtuCHfb_p1O_fgy7YUoErKCkeE`;

// Start the server
server.listen(5000, "0.0.0.0", () => {
  console.log("Socket.io server running on port 5000 and accepting all IPs");
});
