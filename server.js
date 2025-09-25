const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// Variabel global
let clients = {};
let jumlahKirim = 0;
const MAX_PESAN_PER_BOT = 1000;
let selectedBot = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeSend(client, to, msg, retry = 3) {
  try {
    return await client.sendMessage(to, msg);
  } catch (err) {
    if (retry > 0) {
      console.log(`⚠️ Gagal kirim ke ${to}, coba ulang... (${retry})`);
      await delay(2000);
      return safeSend(client, to, msg, retry - 1);
    }
    throw err;
  }
}

function getNextAvailableClient() {
  for (let [name, data] of Object.entries(clients)) {
    if (data.count < MAX_PESAN_PER_BOT && data.ready) {
      return name;
    }
  }
  return null;
}

/**
 * Buat bot baru
 */
function buatBot(sessionName) {
  if (clients[sessionName]) {
    console.log(`⚠️ Bot ${sessionName} sudah ada`);
    return;
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionName }),
    puppeteer: { headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] },
  });

  clients[sessionName] = { client, count: 0, ready: false };

  client.on("qr", async (qr) => {
    console.log(`📌 QR untuk ${sessionName} siap, scan pakai WhatsApp`);
    try {
      const qrImage = await QRCode.toDataURL(qr);
      io.emit("qr", { session: sessionName, qr: qrImage });
    } catch (err) {
      console.error("❌ Gagal generate QR:", err);
    }
  });

  client.on("ready", () => {
    console.log(`✅ Bot ${sessionName} siap digunakan`);
    clients[sessionName].ready = true;
    io.emit("connected", { session: sessionName });
  });

  client.on("disconnected", (reason) => {
    console.log(`❌ Bot ${sessionName} terputus: ${reason}`);
    clients[sessionName].ready = false;

    if (reason === "LOGOUT") {
      console.log(`⚠️ Bot ${sessionName} logout, scan ulang diperlukan`);
      delete clients[sessionName];
    } else {
      console.log(`🔄 Mencoba reconnect bot ${sessionName}...`);
      setTimeout(() => client.initialize(), 5000);
    }
  });

  client.initialize().catch((err) => {
    console.error(`❌ Gagal inisialisasi bot ${sessionName}:`, err);
    setTimeout(() => buatBot(sessionName), 10000);
  });
}

/**
 * API Routes
 */
app.post("/tambah-bot", (req, res) => {
  const { sessionName } = req.body;
  if (!sessionName) return res.status(400).json({ error: "sessionName wajib diisi" });
  if (clients[sessionName]) return res.status(400).json({ error: "Bot sudah ada" });

  buatBot(sessionName);
  res.json({ status: "sedang proses login", session: sessionName });
});

app.post("/set-selected-bot", (req, res) => {
  const { sessionName } = req.body;
  if (!clients[sessionName]) return res.status(404).json({ error: "Bot tidak ditemukan" });
  selectedBot = sessionName;
  res.json({ status: "Bot terpilih", selectedBot });
});

app.get("/get-selected-bot", (req, res) => {
  res.json({ selectedBot });
});

app.post("/send-pesan", async (req, res) => {
  if (!selectedBot) return res.status(400).json({ error: "Belum ada bot terpilih" });
  const { to, pesan } = req.body;
  const clientData = clients[selectedBot];

  if (!clientData || !clientData.ready) {
    return res.status(503).json({ error: `Bot ${selectedBot} belum siap` });
  }
  if (!to || !pesan) return res.status(400).json({ error: "parameter 'to' dan 'pesan' wajib diisi" });

  try {
    const chatId = to.includes("@c.us") ? to : `${to}@c.us`;
    await safeSend(clientData.client, chatId, pesan);
    clientData.count++;
    jumlahKirim++;

    console.log(`✅ [${selectedBot}] Pesan terkirim ke ${chatId}: "${pesan}"`);
    io.emit("log", { waktu: new Date().toLocaleString(), session: selectedBot, to: chatId, pesan, status: "✅ Terkirim" });
    res.json({ status: "berhasil", session: selectedBot, to: chatId, pesan });
  } catch (err) {
    console.error(`❌ [${selectedBot}] Gagal kirim:`, err.message);
    io.emit("log", { waktu: new Date().toLocaleString(), session: selectedBot, to, pesan, status: "❌ Gagal", error: err.toString() });
    res.status(500).json({ error: err.toString() });
  }
});

app.post("/broadcast", async (req, res) => {
  const { daftar } = req.body;
  if (!Array.isArray(daftar) || daftar.length === 0) {
    return res.status(400).json({ error: "daftar wajib diisi" });
  }

  const batchSize = 5;
  const minDelay = 3000;
  const maxDelay = 8000;

  for (let i = 0; i < daftar.length; i += batchSize) {
    const batch = daftar.slice(i, i + batchSize);

    await Promise.all(
      batch.map(async ({ to, pesan }) => {
        const sessionName = getNextAvailableClient();
        if (!sessionName) {
          console.warn("❌ Semua bot full atau belum siap");
          return;
        }

        const clientData = clients[sessionName];
        try {
          const chatId = to.includes("@c.us") ? to : `${to}@c.us`;
          await safeSend(clientData.client, chatId, pesan);
          clientData.count++;
          jumlahKirim++;
          console.log(`✅ [${sessionName}] Pesan terkirim ke ${chatId}: "${pesan}"`);

          io.emit("log", { waktu: new Date().toLocaleString(), session: sessionName, to: chatId, pesan, status: "✅ Terkirim" });
        } catch (err) {
          console.error(`❌ [${sessionName}] Gagal kirim ke ${to}: ${err.message}`);
          io.emit("log", { waktu: new Date().toLocaleString(), session: sessionName, to, pesan, status: "❌ Gagal", error: err.toString() });
        }
      })
    );

    await delay(Math.floor(Math.random() * (maxDelay - minDelay + 1) + minDelay));
  }

  res.json({ status: "selesai" });
});

app.get("/status", (req, res) => {
  const status = {};
  for (let [name, data] of Object.entries(clients)) {
    status[name] = { count: data.count, ready: data.ready };
  }
  res.json({ jumlahKirim, perBot: status });
});

app.get("/list-bot", (req, res) => {
  const list = Object.keys(clients).map((sessionName) => ({
    session: sessionName,
    count: clients[sessionName].count,
    ready: clients[sessionName].ready,
  }));
  res.json({ bots: list });
});

app.get("/", (req, res) => {
  res.send("🤖 Bot aktif (whatsapp-web.js + HTTP, SSL by Nginx)");
});

io.on("connection", (socket) => {
  console.log("⚡ Socket.IO client terhubung");
  const botList = Object.keys(clients).map((sessionName) => ({
    session: sessionName,
    count: clients[sessionName].count,
    ready: clients[sessionName].ready,
  }));
  socket.emit("bot-list", botList);
});

process.on("unhandledRejection", (reason) => console.error("⚠️ Unhandled Rejection:", reason));
process.on("uncaughtException", (err) => console.error("🔥 Uncaught Exception:", err));

server.listen(4000, () => {
  console.log("🚀 Server berjalan di http://localhost:4000 (SSL by Nginx → akses via https://dev-chat.e-nagih.cloud)");
});
