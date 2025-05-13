const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
// Replace node-fetch entirely—no more manual REST calls
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
// 🔥 Manual GET trigger to send a message notification
app.get("/", async (req, res) => {
  try {
    res.status(200).json({ success: true, message: "Hello from server!" });
  } catch (err) {
    res.status(500).json({ success: false, error: "Something went wrong" });
  }
});

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// 🔥 Hardcoded FCM Token & Server Key (no longer needed)
// const serverKey = "YOUR_SERVER_KEY";
const hardcodedFcmToken = `c94RvYloTraWsToM-QL2II:APA91bG3qxPePaynJWp-P0AKq0GTC55CluYLIaE5Wnk1E58gWhcgLaIHuKA8444NiJ_D3C45h_i7hQuV5qJpyEMDuJGOjEtuCHfb_p1O_fgy7YUoErKCkeE`; // ⚠️ Replace with actual token

// 🔔 Send FCM Notification (now using Admin SDK)
const sendNotification = async (customBody = "Default notification body") => {
  const message = {
    token: hardcodedFcmToken,
    notification: {
      title: "Socket Status Update",
      body: customBody,
    },
    data: {
      customKey: "customValue",
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

// WebSocket connection handling
io.on("connection", (socket) => {
  console.log("New client connected");

  // 🔔 Notify on connection
  sendNotification("A new client has connected. Socket ID: " + socket.id);

  socket.on("sendMessage", (msg) => {
    io.emit("newMessage", msg); // Broadcast to all clients
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected");

    // 🔔 Notify on disconnection
    sendNotification("A client has disconnected. Socket ID: " + socket.id);
  });
});

// 🔥 Manual GET trigger to send a message notification
app.get("/notify", async (req, res) => {
  try {
    const response = await sendNotification(
      "Manual notification triggered via GET /notify"
    );
    res.status(200).json({ success: true, response });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, error: "Failed to send notification" });
  }
});

// Start the server
server.listen(5000, "0.0.0.0", () => {
  console.log("Socket.io server running on port 5000 and accepting all IPs");
});
