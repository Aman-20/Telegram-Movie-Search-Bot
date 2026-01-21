import dotenv from 'dotenv';
dotenv.config();

import Redis from 'ioredis';
import TelegramBot from 'node-telegram-bot-api';
import mongoose from 'mongoose';
import crypto from 'crypto';
import express from 'express';

// --- CONFIGURATION ---
const {
  TELEGRAM_TOKEN,
  MONGODB_URI,
  ADMIN_IDS = '',
  DAILY_LIMIT = '100',
  RESULTS_PER_PAGE = '10',
  PORT = 3000,
  RENDER_EXTERNAL_URL,
  // [FEATURE 1] Force Join Config
  FORCE_CHANNEL_ID // e.g., "@mychannel" or "-100123456789"
} = process.env;

if (!TELEGRAM_TOKEN || !MONGODB_URI) {
  console.error('❌ Missing TELEGRAM_TOKEN or MONGODB_URI');
  process.exit(1);
}

const ADMIN_SET = new Set(ADMIN_IDS.split(',').map(s => s.trim()).filter(Boolean));
const DAILY_LIMIT_NUM = Number(DAILY_LIMIT) || 100;
const RESULTS_PER_PAGE_NUM = Number(RESULTS_PER_PAGE) || 10;

// --- DATABASE CONNECT ---
const redis = new Redis(process.env.REDIS_URL);
redis.on('error', err => console.error('Redis Error:', err.message));

await mongoose.connect(MONGODB_URI, { dbName: 'TelegramMovies' });
console.log('✅ MongoDB Connected');

// --- SCHEMAS ---
const Schema = mongoose.Schema;

// [FEATURE 2] User Schema for Broadcasts
const UserSchema = new Schema({
  userId: { type: String, unique: true, index: true },
  firstName: String,
  username: String,
  joinedAt: { type: Date, default: Date.now }
});

const FileSchema = new Schema({
  customId: { type: String, unique: true, index: true },
  file_id: { type: String, required: true, unique: true },
  file_name: String,
  type: String,
  uploader_id: String,
  uploaded_at: { type: Date, default: Date.now, index: true },
  downloads: { type: Number, default: 0, index: true },
  file_size: String,
  clean_title: String,
  attributes: { type: [String], index: true }
});

const CounterSchema = new Schema({ _id: String, seq: Number });
const LimitSchema = new Schema({ userId: String, date: String, count: { type: Number, default: 0 } });
const FavoriteSchema = new Schema({ userId: String, customId: String, savedAt: { type: Date, default: Date.now } });
const PendingSchema = new Schema({
  adminId: String,
  chatId: String,
  messageId: Number,
  file_id: String,
  file_name: String,
  type: String,
  clean_title: String,
  attributes: [String],
  file_size: String,
  created_at: { type: Date, default: Date.now }
});

LimitSchema.index({ userId: 1, date: 1 }, { unique: true });
FavoriteSchema.index({ userId: 1, customId: 1 }, { unique: true });
PendingSchema.index({ created_at: 1 }, { expireAfterSeconds: 600 });

const User = mongoose.model('User', UserSchema);
const File = mongoose.model('File', FileSchema);
const Counter = mongoose.model('Counter', CounterSchema);
const Limit = mongoose.model('Limit', LimitSchema);
const Favorite = mongoose.model('Favorite', FavoriteSchema);
const Pending = mongoose.model('Pending', PendingSchema);

// --- HELPERS ---

function autoDeleteMessage(bot, chatId, messageId, delayMs = 60000) {
  setTimeout(() => {
    bot.deleteMessage(chatId, messageId).catch(() => { });
  }, delayMs);
}

async function nextSequence(name = 'file') {
  const doc = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  ).lean();
  return 'F' + String(doc.seq).padStart(4, '0');
}

async function incrementAndGetLimit(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const doc = await Limit.findOneAndUpdate(
    { userId, date: today },
    { $inc: { count: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  return doc.count;
}

async function getUserLimitCount(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const doc = await Limit.findOne({ userId, date: today }).lean();
  return doc?.count || 0;
}

// [FEATURE 2] Helper: Save/Update User for Broadcasts
async function saveUser(msg) {
  if (!msg.from) return;
  const userId = String(msg.from.id);
  try {
    await User.updateOne(
      { userId },
      {
        $set: {
          firstName: msg.from.first_name,
          username: msg.from.username
        },
        $setOnInsert: { joinedAt: new Date() }
      },
      { upsert: true }
    );
  } catch (err) {
    console.error('Save User Error:', err.message);
  }
}

// [FEATURE 1] Helper: Force Subscribe Check
async function verifyJoin(chatId, userId) {
  if (!FORCE_CHANNEL_ID) return true; // Feature disabled if env var missing
  if (ADMIN_SET.has(userId)) return true; // Admins bypass

  // Check Redis Cache first to avoid hitting API limits
  const cacheKey = `isMember:${userId}`;
  const cached = await redis.get(cacheKey);
  if (cached) return cached === 'true';

  try {
    const member = await bot.getChatMember(FORCE_CHANNEL_ID, userId);
    const isMember = ['creator', 'administrator', 'member'].includes(member.status);

    // Cache result: 5 mins for true, 1 min for false (in case they just joined)
    await redis.set(cacheKey, String(isMember), 'EX', isMember ? 300 : 60);

    if (!isMember) {
      const channelLink = FORCE_CHANNEL_ID.startsWith('@')
        ? `https://t.me/${FORCE_CHANNEL_ID.replace('@', '')}`
        : await bot.exportChatInviteLink(FORCE_CHANNEL_ID).catch(() => null);

      await bot.sendMessage(chatId, '⚠️ <b>You must join our channel to use this bot.</b>', {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📢 Join Channel', url: channelLink || 'https://t.me/' }],
            [{ text: '✅ I Have Joined', callback_data: 'CHECK_JOIN' }]
          ]
        }
      });
      return false;
    }
    return true;
  } catch (err) {
    console.error('Force Join Error:', err.message);
    // If bot isn't admin in channel or ID is wrong, let user pass to avoid breaking bot
    return true;
  }
}

function cleanFileName(text) {
  return text
    .replace(/\.(mkv|mp4|avi|mov|flv|wmv|webm|m4v)$/i, '')
    .replace(/@\w+/g, '')
    .replace(/[\[\]\(\)\{\}\.\;\:\~\|\,\_\-\+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function generateAttributes(text) {
  return text.toLowerCase().split(' ').filter(t => t.length > 0);
}

function formatSize(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  return (bytes / 1e3).toFixed(1) + " KB";
}

// --- SERVER ---
const app = express();
app.use(express.json());

const bot = new TelegramBot(TELEGRAM_TOKEN);
bot.setWebHook(`${RENDER_EXTERNAL_URL}/bot${TELEGRAM_TOKEN}`);

app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => res.send('Bot is running. 🚀'));
app.listen(PORT, () => console.log(`Server on port ${PORT}`));

// --- BOT COMMANDS ---

bot.setMyCommands([
  { command: '/start', description: 'Start bot' },
  { command: '/recent', description: 'New files' },
  { command: '/trending', description: 'Popular files' },
  { command: '/favorites', description: 'My saved files' },
  { command: '/myaccount', description: 'Check limits' },
]).catch(() => { });

bot.onText(/\/start/, async (msg) => {
  await saveUser(msg); // Track user
  if (!await verifyJoin(msg.chat.id, String(msg.from.id))) return;

  const text = `👋 <b>Welcome, ${msg.from.first_name}!</b>

🔎 <b>How to search:</b>
Simply type the name of the movie.
<i>Example: "Avengers" or "Breaking Bad"</i>

📂 <b>Commands:</b>
/recent - New Uploads
/trending - Most Popular
/favorites - Saved Files
/myaccount - Daily Limit`;

  await bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

bot.onText(/\/help/, async (msg) => {
  const userId = String(msg.from.id);
  const isAdmin = ADMIN_SET.has(userId);

  // 1. Standard Help Message for Everyone
  let helpText = `🔍 <b>Search:</b>
Just type the name of the movie or series you want to find.`;

  // 2. Add Admin Commands ONLY if user is an Admin
  if (isAdmin) {
    helpText += `\n\n👮‍♂️ <b>Admin Commands:</b>
/stats - View database statistics
/broadcast [message] - Send text to all users
/broadcast (reply) - Broadcast the message you reply to
/delete [ID] - Delete a file by Custom ID
<i>Upload: Simply send a file/video to the bot to upload it.</i>`;
  }

  await bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'HTML' });
});

bot.onText(/\/stats/, async (msg) => {
  if (!ADMIN_SET.has(String(msg.from.id))) return;
  const totalFiles = await File.countDocuments();
  const totalUsers = await User.countDocuments();
  const today = new Date().toISOString().slice(0, 10);
  const activeUsers = await Limit.countDocuments({ date: today });

  await bot.sendMessage(msg.chat.id,
    `📊 <b>Stats</b>\n\nFiles: ${totalFiles}\nTotal Users: ${totalUsers}\nActive Today: ${activeUsers}`,
    { parse_mode: 'HTML' }
  );
});

// [FEATURE 2] Admin Broadcast Command
bot.onText(/\/broadcast(?: (.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const fromId = String(msg.from.id);

  if (!ADMIN_SET.has(fromId)) return;

  const text = match[1];
  const replyMsg = msg.reply_to_message;

  if (!text && !replyMsg) {
    return bot.sendMessage(chatId, '⚠️ Usage:\n1. <code>/broadcast Message</code>\n2. Reply to a message with <code>/broadcast</code>', { parse_mode: 'HTML' });
  }

  const users = await User.find({}, { userId: 1 }).lean();
  let success = 0, blocked = 0;

  const sentMsg = await bot.sendMessage(chatId, `🚀 Broadcasting to ${users.length} users...`);

  // Broadcast Loop
  for (const user of users) {
    try {
      if (replyMsg) {
        // Copy message (supports images, videos, etc.)
        await bot.copyMessage(user.userId, chatId, replyMsg.message_id);
      } else {
        // Send Text
        await bot.sendMessage(user.userId, text, { parse_mode: 'HTML' });
      }
      success++;
    } catch (err) {
      // Error 403 means user blocked bot
      if (err.response && err.response.statusCode === 403) blocked++;
    }
    // Tiny delay to prevent 429 errors
    await new Promise(r => setTimeout(r, 50));
  }

  bot.editMessageText(`✅ <b>Broadcast Complete</b>\n\nSent: ${success}\nBlocked/Failed: ${blocked}`, {
    chat_id: chatId,
    message_id: sentMsg.message_id,
    parse_mode: 'HTML'
  });
});

bot.onText(/\/recent/, async (msg) => {
  await saveUser(msg);
  if (!await verifyJoin(msg.chat.id, String(msg.from.id))) return;

  const files = await File.find().sort({ uploaded_at: -1 }).limit(10).lean();
  if (!files.length) return bot.sendMessage(msg.chat.id, 'No files yet.');

  const keyboard = files.map(f => [{
    text: `📂 ${f.file_size} | ${f.clean_title}`,
    callback_data: `GET:${f.customId}`
  }]);

  const sent = await bot.sendMessage(msg.chat.id, '🆕 <b>Recent Uploads:</b>', {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
  autoDeleteMessage(bot, msg.chat.id, sent.message_id);
});

bot.onText(/\/trending/, async (msg) => {
  await saveUser(msg);
  if (!await verifyJoin(msg.chat.id, String(msg.from.id))) return;

  const files = await File.find().sort({ downloads: -1 }).limit(10).lean();
  if (!files.length) return bot.sendMessage(msg.chat.id, 'No trending files.');

  const keyboard = files.map(f => [{
    text: `🔥 ${f.file_size} | ${f.clean_title}`,
    callback_data: `GET:${f.customId}`
  }]);

  const sent = await bot.sendMessage(msg.chat.id, '📈 <b>Top Trending:</b>', {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
  autoDeleteMessage(bot, msg.chat.id, sent.message_id);
});

bot.onText(/\/favorites/, async (msg) => {
  await saveUser(msg);
  if (!await verifyJoin(msg.chat.id, String(msg.from.id))) return;

  const userId = String(msg.from.id);
  const favs = await Favorite.find({ userId }).lean();
  if (!favs.length) {
    return bot.sendMessage(msg.chat.id, '⭐ You have no favorite files yet.\nClick "Favorite" on a file to save it.');
  }

  const fileIds = favs.map(f => f.customId);
  const files = await File.find({ customId: { $in: fileIds } }).lean();

  if (!files.length) {
    return bot.sendMessage(msg.chat.id, '⭐ Your favorites list is empty (files may have been deleted).');
  }

  const keyboard = files.slice(0, 10).map(f => [{
    text: `⭐ ${f.file_size} | ${f.clean_title}`,
    callback_data: `GET:${f.customId}`
  }]);

  const sent = await bot.sendMessage(msg.chat.id, `❤️ <b>Your Favorites (${files.length}):</b>`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
  autoDeleteMessage(bot, msg.chat.id, sent.message_id);
});

bot.onText(/\/myaccount/, async (msg) => {
  await saveUser(msg);
  const used = await getUserLimitCount(String(msg.from.id));
  const remaining = Math.max(DAILY_LIMIT_NUM - used, 0);

  await bot.sendMessage(msg.chat.id,
    `👤 <b>Your Account</b>\n\n✅ Used: ${used}\n⏳ Remaining: ${remaining}\n🎯 Limit: ${DAILY_LIMIT_NUM}`,
    { parse_mode: 'HTML' }
  );
});

// --- ADMIN UPLOAD & SEARCH HANDLER ---
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const fromId = String(msg.from.id);
  const text = msg.text?.trim();

  if (text && text.startsWith('/')) return; // Ignore commands

  // 1. Handle Admin File Upload (Bypasses Force Join)
  if (ADMIN_SET.has(fromId) && (msg.video || msg.document)) {
    const file = msg.video || msg.document;
    const rawName = msg.caption || file.file_name || "Unknown";
    const clean = cleanFileName(rawName);
    const size = formatSize(file.file_size);
    const attrs = generateAttributes(clean);

    const pending = await Pending.create({
      adminId: fromId,
      chatId: String(chatId),
      messageId: msg.message_id,
      file_id: file.file_id,
      file_name: rawName,
      type: msg.video ? 'video' : 'document',
      clean_title: clean,
      attributes: attrs,
      file_size: size
    });

    await bot.sendMessage(chatId,
      `📝 <b>Review Upload</b>\n\nName: ${clean}\nSize: ${size}\n\nConfirm save?`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Save', callback_data: `CONFIRM:${pending._id}` }, { text: '❌ Cancel', callback_data: `CANCEL:${pending._id}` }]
          ]
        }
      }
    );
    return;
  }

  // 2. Handle User Search
  if (text) {
    await saveUser(msg); // Track User
    // [FEATURE 1] Check Force Join Before Search
    if (!await verifyJoin(chatId, fromId)) return;

    // A. Search by ID
    if (/^F\d{4}$/i.test(text)) {
      const customId = text.toUpperCase();
      const file = await File.findOne({ customId }).lean();

      if (!file) {
        const temp = await bot.sendMessage(chatId, '❌ File not found.');
        autoDeleteMessage(bot, chatId, temp.message_id, 3000);
        return;
      }

      const used = await getUserLimitCount(fromId);
      if (used >= DAILY_LIMIT_NUM) return bot.sendMessage(chatId, '⚠️ Daily limit reached.');

      await incrementAndGetLimit(fromId);
      await File.updateOne({ _id: file._id }, { $inc: { downloads: 1 } });

      const caption = `🎬 <b>${file.clean_title}</b>\n📦 ${file.file_size}\n🆔 <code>${file.customId}</code>\n\n⚠️ <i>Auto-deletes in 60s</i>`;
      let sent;
      const opts = { caption, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❤️ Favorite', callback_data: `FAV:${file.customId}` }]] } };

      if (file.type === 'video') sent = await bot.sendVideo(chatId, file.file_id, opts);
      else sent = await bot.sendDocument(chatId, file.file_id, opts);

      autoDeleteMessage(bot, chatId, sent.message_id, 60000);
      return;
    }

    // B. Keyword Search
    const keywords = text.toLowerCase().split(' ').filter(Boolean);
    if (!keywords.length) return;

    const query = { attributes: { $all: keywords } };
    const total = await File.countDocuments(query);
    const files = await File.find(query).sort({ uploaded_at: -1 }).limit(RESULTS_PER_PAGE_NUM).lean();

    if (!files.length) {
      const sent = await bot.sendMessage(chatId, `🔍 No results for "<b>${text}</b>"`, { parse_mode: 'HTML' });
      autoDeleteMessage(bot, chatId, sent.message_id, 5000);
      return;
    }

    const searchKey = `search:${fromId}`;
    await redis.set(searchKey, JSON.stringify(keywords), 'EX', 300);

    const keyboard = files.map(f => [{
      text: `📂 ${f.file_size} | ${f.clean_title}`,
      callback_data: `GET:${f.customId}`
    }]);

    if (total > RESULTS_PER_PAGE_NUM) {
      keyboard.push([{ text: `Page 1 of ${Math.ceil(total / RESULTS_PER_PAGE_NUM)} ➡️`, callback_data: `PAGE:1` }]);
    }

    const sent = await bot.sendMessage(chatId, `🔍 Found <b>${total}</b> results for "<b>${text}</b>":`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });

    autoDeleteMessage(bot, chatId, sent.message_id);
    autoDeleteMessage(bot, chatId, msg.message_id, 2000);
  }
});

// --- CALLBACK HANDLER ---
bot.on('callback_query', async (q) => {
  const chatId = q.message.chat.id;
  const fromId = String(q.from.id);
  const data = q.data;

  // [FEATURE 1] Handle "I Joined" button specifically
  if (data === 'CHECK_JOIN') {
    await redis.del(`isMember:${fromId}`); // Clear cache
    if (await verifyJoin(chatId, fromId)) {
      bot.sendMessage(chatId, '✅ <b>Thanks for joining!</b> You can now use the bot.', { parse_mode: 'HTML' });
      bot.deleteMessage(chatId, q.message.message_id).catch(() => { });
    } else {
      bot.answerCallbackQuery(q.id, { text: '❌ You still haven\'t joined the channel!', show_alert: true });
    }
    return;
  }

  // [FEATURE 1] Check membership for all other interactions (downloads, pagination)
  // Admins bypass this in verifyJoin
  if (!await verifyJoin(chatId, fromId)) {
    return bot.answerCallbackQuery(q.id, { text: '⚠️ You must join the channel first!', show_alert: true });
  }

  try {
    if (data.startsWith('CONFIRM:')) {
      const pendingId = data.split(':')[1];
      const pending = await Pending.findById(pendingId).lean();
      if (!pending) return bot.answerCallbackQuery(q.id, { text: 'Expired' });

      const exists = await File.exists({ file_id: pending.file_id });
      if (exists) {
        await Pending.deleteOne({ _id: pendingId });
        return bot.editMessageText('⚠️ File already exists.', { chat_id: chatId, message_id: q.message.message_id });
      }

      const customId = await nextSequence();
      await File.create({
        customId,
        file_id: pending.file_id,
        file_name: pending.file_name,
        type: pending.type,
        uploader_id: pending.adminId,
        file_size: pending.file_size,
        clean_title: pending.clean_title,
        attributes: pending.attributes
      });

      await Pending.deleteOne({ _id: pendingId });
      await bot.editMessageText(`✅ <b>Published:</b> ${customId}\n${pending.clean_title}`, {
        chat_id: chatId,
        message_id: q.message.message_id,
        parse_mode: 'HTML'
      });
      return;
    }

    if (data.startsWith('CANCEL:')) {
      await Pending.deleteOne({ _id: data.split(':')[1] });
      await bot.editMessageText('❌ Cancelled.', { chat_id: chatId, message_id: q.message.message_id });
      return;
    }

    if (data.startsWith('GET:')) {
      const customId = data.split(':')[1];
      const file = await File.findOne({ customId }).lean();

      if (!file) return bot.answerCallbackQuery(q.id, { text: 'File not found/deleted.' });

      const used = await getUserLimitCount(fromId);
      if (used >= DAILY_LIMIT_NUM) return bot.answerCallbackQuery(q.id, { text: 'Daily limit exceeded!', show_alert: true });

      await bot.answerCallbackQuery(q.id, { text: 'Sending file...' });
      await incrementAndGetLimit(fromId);
      await File.updateOne({ _id: file._id }, { $inc: { downloads: 1 } });

      const caption = `🎬 <b>${file.clean_title}</b>\n📦 ${file.file_size}\n🆔 <code>${file.customId}</code>\n\n⚠️ <i>Auto-deletes in 60s</i>`;
      const opts = { caption, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❤️ Favorite', callback_data: `FAV:${file.customId}` }]] } };

      let sent;
      if (file.type === 'video') sent = await bot.sendVideo(chatId, file.file_id, opts);
      else sent = await bot.sendDocument(chatId, file.file_id, opts);

      autoDeleteMessage(bot, chatId, sent.message_id, 60000);
      return;
    }

    if (data.startsWith('PAGE:')) {
      const page = Number(data.split(':')[1]);
      const searchKey = `search:${fromId}`;
      const rawKeywords = await redis.get(searchKey);

      if (!rawKeywords) return bot.answerCallbackQuery(q.id, { text: 'Search expired.' });

      const keywords = JSON.parse(rawKeywords);
      const query = { attributes: { $all: keywords } };

      const total = await File.countDocuments(query);
      const files = await File.find(query)
        .sort({ uploaded_at: -1 })
        .skip(page * RESULTS_PER_PAGE_NUM)
        .limit(RESULTS_PER_PAGE_NUM)
        .lean();

      const keyboard = files.map(f => [{
        text: `📂 ${f.file_size} | ${f.clean_title}`,
        callback_data: `GET:${f.customId}`
      }]);

      const navRow = [];
      if (page > 0) navRow.push({ text: '⬅️ Prev', callback_data: `PAGE:${page - 1}` });
      const maxPage = Math.ceil(total / RESULTS_PER_PAGE_NUM) - 1;
      if (page < maxPage) navRow.push({ text: 'Next ➡️', callback_data: `PAGE:${page + 1}` });

      if (navRow.length) keyboard.push(navRow);

      await bot.editMessageText(`🔍 Results (Page ${page + 1}/${maxPage + 1})`, {
        chat_id: chatId,
        message_id: q.message.message_id,
        reply_markup: { inline_keyboard: keyboard }
      });
      return;
    }

    if (data.startsWith('FAV:')) {
      const customId = data.split(':')[1];
      const exists = await Favorite.findOne({ userId: fromId, customId }).lean();

      if (exists) {
        await Favorite.deleteOne({ userId: fromId, customId });
        await bot.answerCallbackQuery(q.id, { text: 'Removed from favorites' });
      } else {
        const count = await Favorite.countDocuments({ userId: fromId });
        if (count >= 50) return bot.answerCallbackQuery(q.id, { text: 'Max 50 favorites.' });

        await Favorite.create({ userId: fromId, customId });
        await bot.answerCallbackQuery(q.id, { text: 'Added to favorites!' });
      }
      return;
    }

  } catch (err) {
    console.error('Callback Error:', err);
    bot.answerCallbackQuery(q.id, { text: 'Error occurred' }).catch(() => { });
  }
});

bot.onText(/\/delete (.+)/, async (msg, match) => {
  if (!ADMIN_SET.has(String(msg.from.id))) return;
  const customId = match[1].trim().toUpperCase();
  const res = await File.deleteOne({ customId });
  bot.sendMessage(msg.chat.id, res.deletedCount ? `🗑️ Deleted ${customId}` : '❌ Not found');
});

process.on('SIGINT', async () => {
  await mongoose.disconnect();
  process.exit(0);
});