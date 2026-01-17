# 🎬 Telegram Movie/File Search Bot

A robust, high-performance Telegram bot for searching, indexing, and sharing files. Built with **Node.js**, **MongoDB**, and **Redis**.

![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg) ![MongoDB](https://img.shields.io/badge/MongoDB-Required-green.svg) ![Redis](https://img.shields.io/badge/Redis-Required-red.svg)

## ✨ Features

* **🔍 Smart Search:** Strict keyword matching ensures users find exactly what they are looking for (no junk results).
* **🚀 High Performance:** Uses **Redis** for caching search sessions and pagination.
* **📂 Admin Uploads:** Admins can simply forward files to the bot to index them.
* **🏷️ Auto-Cleaning:** Automatically cleans filenames to generate searchable tags (removes `[ ]`, `.`, `_`, etc.).
* **❤️ Favorites System:** Users can save up to 50 files for quick access.
* **📉 Daily Limits:** Set daily download caps per user to prevent abuse.
* **🧹 Auto-Delete:** Search results and file links auto-delete to keep chats clean and protect content.
* **📊 Statistics:** Admin command to view total files and active users.

---

## 🛠️ Prerequisites

Before you begin, ensure you have the following:

1.  **Node.js** (v16 or higher)
2.  **MongoDB Connection URI** (e.g., from MongoDB Atlas)
3.  **Redis Connection URL** (e.g., from Redis Labs or Render Redis)
4.  **Telegram Bot Token** (from [@BotFather](https://t.me/BotFather))

---

## 🚀 Installation & Local Setup

1.  **Clone the repository**
    ```bash
    git clone [https://github.com/Aman-20/Telegram-Movie-Search-Bot.git](https://github.com/Aman-20/Telegram-Movie-Search-Bot.git)
    cd telegram-movie-search-bot
    ```

2.  **Install dependencies**
    ```bash
    npm install
    ```

3.  **Configure Environment Variables**
    Create a `.env` file in the root directory and add your credentials (see table below).

4.  **Start the Bot**
    ```bash
    npm start
    ```

---

## 🔑 Environment Variables

To run the bot, you need to configure the following variables in your `.env` file (or your hosting platform's environment settings).

| Variable | Required | Description | Example |
| :--- | :---: | :--- | :--- |
| `TELEGRAM_TOKEN` | ✅ | Your Bot Token from BotFather | `123456:ABC-DEF...` |
| `MONGODB_URI` | ✅ | Your MongoDB connection string | `mongodb+srv://user:pass@...` |
| `REDIS_URL` | ✅ | Your Redis connection string | `redis://default:pass@...` |
| `RENDER_EXTERNAL_URL`| ✅ | Your app's public URL (for Webhook) | `https://my-bot.onrender.com` |
| `ADMIN_IDS` | ✅ | Comma-separated User IDs of admins | `12345678, 87654321` |
| `DAILY_LIMIT` | ❌ | Max downloads per user/day (Default: 100) | `50` |
| `RESULTS_PER_PAGE` | ❌ | Number of files per page (Default: 10) | `10` |

---

## 📖 Usage Guide

### 👑 For Admins (Uploading Files)
The bot does **not** rely on complex commands to add files. It uses a "Send & Confirm" workflow:

1.  **Send the File:** As an admin, simply send a **Video** or **Document** to the bot.
2.  **Review:** The bot will clean the filename and show you a preview.
3.  **Confirm:** Click **✅ Save** to add it to the database.

* **Delete a File:** Use `/delete F0001` (replace `F0001` with the file's Custom ID).
* **View Stats:** Use `/stats` to see database health.

### 👤 For Users
* **Search:** Just type the name of the movie (e.g., "Iron Man").
* **Commands:**
    * `/start` - Welcome menu
    * `/recent` - See newly uploaded files
    * `/trending` - See most popular files
    * `/favorites` - View saved files
    * `/myaccount` - Check daily download limit

---

## ☁️ Deployment (Render.com)

This bot is optimized for **Render** using Webhooks.

1.  Create a new **Web Service** on Render.
2.  Connect your GitHub repository.
3.  Add the **Environment Variables** listed above in the Render dashboard.
4.  **Important:** Ensure `RENDER_EXTERNAL_URL` matches your Render app's URL (e.g., `https://your-bot-name.onrender.com`).
5.  Deploy! 🚀

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to fork this repository and submit a pull request.

## 📝 License

This project is licensed under the MIT License.