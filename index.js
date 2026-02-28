const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeInMemoryStore
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
require('dotenv').config();

// Global database
global.db = {
  data: {
    chats: {}
  }
};

// Load plugins
global.plugins = {};

// Read all plugin files
const pluginFiles = fs.readdirSync('./plugins').filter(file => file.endsWith('.js'));
for (const file of pluginFiles) {
  const plugin = require(`./plugins/${file}`);
  const pluginName = file.replace('.js', '');
  global.plugins[pluginName] = plugin;
  console.log(`📦 Loaded plugin: ${pluginName}`);
}

const logger = pino({ level: 'silent' });
const store = makeInMemoryStore({ logger });
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function startBot() {
  console.log('🚀 Starting WhatsApp Bot...');
  
  const { state, saveCreds } = await useMultiFileAuthState('./session');
  
  const sock = makeWASocket({
    version: [2, 2413, 1],
    logger,
    printQRInTerminal: false,
    auth: state,
    defaultQueryTimeoutMs: undefined
  });

  store.bind(sock.ev);

  // Handle Pairing Code
  if (!sock.authState.creds.registered) {
    console.log('📱 Enter your phone number for pairing code:');
    rl.question('Number (with country code): ', async (number) => {
      try {
        const code = await sock.requestPairingCode(number);
        console.log(`\n🔐 Pairing Code: ${code}\n`);
        console.log('1. Open WhatsApp > Linked Devices');
        console.log('2. Click "Link a Device"');
        console.log('3. Enter the code above\n');
      } catch (error) {
        console.error('❌ Error:', error);
      }
    });
  }

  // Connection events
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('❌ Connection closed, reconnecting:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Bot connected successfully!');
      console.log('🤖 Always Online feature is active');
    }
  });

  // Message handler
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m.message) return;

    const chatId = m.key.remoteJid;
    if (!global.db.data.chats[chatId]) {
      global.db.data.chats[chatId] = { autotype: true };
    }

    // Run all plugins' before function
    for (const pluginName in global.plugins) {
      const plugin = global.plugins[pluginName];
      if (plugin.before && !plugin.disabled) {
        try {
          const modifiedM = {
            ...m,
            chat: chatId,
            text: m.message?.conversation || 
                  m.message?.extendedTextMessage?.text || ''
          };
          
          await plugin.before.call({ 
            sendPresenceUpdate: sock.sendPresenceUpdate.bind(sock) 
          }, modifiedM);
          
        } catch (error) {
          console.error(`❌ Error in plugin ${pluginName}:`, error);
        }
      }
    }
  });

  // Auto-view status
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (msg.key.remoteJid === 'status@broadcast') {
        try {
          await sock.readMessages([msg.key]);
          console.log('👁️ Auto-viewed status');
        } catch (error) {
          console.log('Status view error:', error);
        }
      }
    }
  });

  // Always online presence
  setInterval(() => {
    Object.keys(global.db.data.chats).forEach(chatId => {
      if (global.db.data.chats[chatId]?.autotype) {
        sock.sendPresenceUpdate('available', chatId);
      }
    });
  }, 30000);

  sock.ev.on('creds.update', saveCreds);
}

startBot().catch(console.error);
