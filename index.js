const { Client, GatewayIntentBits, Partials, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const express = require('express');

// === Config & Constants ===
const TOKEN = process.env.TOKEN || 'YOUR_BOT_TOKEN'; // Use env or fallback
const OWNER_ID = '1110864648787480656';
const AUTHORIZED_USERS = ['1110864648787480656', '1212961835582623755', '1333798275601662056'];

const DATA_DIR = './data';
const COOKIE_DIR = './cookies';
const VOUCH_PATH = './vouches.json';

// === Ensure directories exist ===
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(COOKIE_DIR)) fs.mkdirSync(COOKIE_DIR);
if (!fs.existsSync(VOUCH_PATH)) fs.writeFileSync(VOUCH_PATH, JSON.stringify({}));

// === Global data stores ===
let rolesAllowed = {};
let stock = {};
let redeemed = {};
let fileStock = {};

// --- Redeemable codes (in-memory) ---
const redeemableCodes = {};

// --- Generate a random 6-character hex code ---
function generateHexCode() {
  return Math.random().toString(16).substring(2, 8).toUpperCase();
}
// Generate 5 random codes on startup
for (let i = 0; i < 5; i++) {
  const code = generateHexCode();
  redeemableCodes[code] = false; // false = not redeemed
  console.log(`Generated code: ${code}`);
}

// === Helper functions for data persistence ===
function loadJSON(filepath, defaultValue = {}) {
  if (!fs.existsSync(filepath)) return defaultValue;
  try {
    return JSON.parse(fs.readFileSync(filepath));
  } catch {
    return defaultValue;
  }
}
function saveJSON(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}
// Vouches function
function loadVouches() {
  return loadJSON(VOUCH_PATH);
}
function saveVouches(data) {
  saveJSON(VOUCH_PATH, data);
}
// Cookie data
function loadData() {
  stock = loadJSON(path.join(DATA_DIR, 'stock.json'));
  redeemed = loadJSON(path.join(DATA_DIR, 'redeemed.json'));
  rolesAllowed = loadJSON(path.join(DATA_DIR, 'roles.json'));
}
function saveData() {
  saveJSON(path.join(DATA_DIR, 'stock.json'), stock);
  saveJSON(path.join(DATA_DIR, 'redeemed.json'), redeemed);
  saveJSON(path.join(DATA_DIR, 'roles.json'), rolesAllowed);
}
// Update file stock from cookie folder structure
function updateFileStock() {
  fileStock = {};
  for (const category of fs.readdirSync(COOKIE_DIR)) {
    const categoryPath = path.join(COOKIE_DIR, category);
    if (fs.lstatSync(categoryPath).isDirectory()) {
      fileStock[category] = fs.readdirSync(categoryPath);
    }
  }
}

// === Initialize data on startup ===
loadData();
updateFileStock();

// === Client Setup ===
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// === Dynamic commands map to avoid multiple listeners for stock gen commands ===
const dynamicCommands = new Set();

// Function to create stock generation commands dynamically
function createDynamicCommand(category) {
  const commandName = `${category[0]}gen`;
  if (dynamicCommands.has(commandName)) return; // avoid duplicates

  dynamicCommands.add(commandName);

  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const args = msg.content.trim().split(/\s+/);
    if (args[0]?.toLowerCase() !== `=${commandName}`) return;

    // Check role permission
    const requiredRoleId = rolesAllowed[commandName];
    if (requiredRoleId && !msg.member.roles.cache.has(requiredRoleId)) {
      return msg.reply('🚫 You do not have permission to use this command.');
    }

    const name = args[1];
    if (!name) return msg.reply('❌ Provide a stock name to generate.');
    if (!stock[category]) return msg.reply('❌ Category does not exist.');

    const itemIndex = stock[category].findIndex((item) => item.toLowerCase() === name.toLowerCase());
    if (itemIndex === -1) return msg.reply('❌ Stock name not found.');

    // Remove from stock and save
    const [item] = stock[category].splice(itemIndex, 1);
    saveData();

    msg.reply(`✅ Generated stock: \`${item}\``);
  });
}
// Load dynamic commands for all categories on startup
for (const category of Object.keys(stock)) {
  createDynamicCommand(category);
}

// === Main message handler ===
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const args = message.content.trim().split(/\s+/);
  const cmd = args[0].toLowerCase();

  // ----- Vouch commands -----
  if (cmd === '+vouch') {
    const user = message.mentions.users.first();
    const reason = args.slice(2).join(' ');
    if (!user || !reason) return message.reply('Usage: `+vouch @user <reason>`');

    const vouches = loadVouches();
    const id = user.id;

    if (!vouches[id]) {
      vouches[id] = { count: 0, reasons: [], lastVouched: null };
    }

    vouches[id].count++;
    vouches[id].reasons.push({
      by: message.author.tag,
      reason,
      date: new Date().toLocaleString(),
    });
    vouches[id].lastVouched = new Date().toLocaleString();

    saveVouches(vouches);
    return message.channel.send(`✅ Vouched for **${user.tag}**. Reason: "${reason}"`);
  }

  if (cmd === '-vouch') {
    const user = message.mentions.users.first();
    const reason = args.slice(2).join(' ');
    if (!user || !reason) return message.reply('Usage: `-vouch @user <reason>`');

    const vouches = loadVouches();
    const id = user.id;

    if (!vouches[id] || vouches[id].count <= 0)
      return message.reply('❌ User has no vouches to remove.');

    vouches[id].count--;
    vouches[id].reasons.push({
      by: message.author.tag,
      reason: `REMOVED: ${reason}`,
      date: new Date().toLocaleString(),
    });
    vouches[id].lastVouched = new Date().toLocaleString();

    saveVouches(vouches);
    return message.channel.send(`❌ Removed a vouch from **${user.tag}**. Reason: "${reason}"`);
  }

  if (cmd === '=profile') {
    const user = message.mentions.users.first() || message.author;
    const vouches = loadVouches();
    const data = vouches[user.id];

    if (!data) return message.reply(`${user.tag} has no vouches.`);

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('Profile')
      .setThumbnail(user.displayAvatarURL())
      .setDescription(`${user.tag} has received ${data.count} vouches.`)
      .addFields(
        { name: 'Total Vouches', value: `${data.count}`, inline: true },
        { name: 'Last Vouched', value: `${data.lastVouched}`, inline: true },
        {
          name: 'Vouch Reasons',
          value:
            data.reasons
              .slice(-5)
              .map((r, i) => `**${i + 1}.** ${r.by}: ${r.reason} (${r.date})`)
              .join('\n') || 'No reasons.',
        }
      )
      .setFooter({ text: 'Vouch Bot' });

    return message.channel.send({ embeds: [embed] });
  }

  // ----- Cookie / Stock Management commands -----
  if (cmd === '=addcategory') {
    if (!message.member.permissions.has('ManageGuild'))
      return message.reply('🚫 You need Manage Server permission.');
    const name = args[1]?.toLowerCase();
    if (!name) return message.reply('❌ Provide a category name.');
    if (stock[name]) return message.reply('❌ Category already exists.');
    stock[name] = [];
    createDynamicCommand(name);
    saveData();
    return message.reply(`✅ Category \`${name}\` created and command \`=${name[0]}gen\` is now active.`);
  }

  if (cmd === '=addstock') {
    if (!message.member.permissions.has('ManageGuild'))
      return message.reply('🚫 You need Manage Server permission.');
    const category = args[1]?.toLowerCase();
    const code = args.slice(2).join(' ');
    if (!category || !code) return message.reply('❌ Usage: =addstock <category> <stock_name>');
    if (!stock[category]) return message.reply('❌ Category not found.');
    stock[category].push(code);
    saveData();
    return message.reply(`✅ Stock \`${code}\` added to \`${category}\`.`);
  }

  if (cmd === '=add') {
    if (!message.member.permissions.has('ManageGuild'))
      return message.reply('🚫 You need Manage Server permission.');
    const command = args[1]?.toLowerCase();
    const role = message.mentions.roles.first();
    if (!command || !role) return message.reply('❌ Usage: =add <command> @role');
    rolesAllowed[command] = role.id;
    saveData();
    return message.reply(`✅ Role ${role.name} allowed to use command =${command}`);
  }

  if (cmd === '=remove') {
    if (!message.member.permissions.has('ManageGuild'))
      return message.reply('🚫 You need Manage Server permission.');
    const command = args[1]?.toLowerCase();
    if (!command) return message.reply('❌ Usage: =remove <command>');
    delete rolesAllowed[command];
    saveData();
    return message.reply(`✅ Removed role restriction for command =${command}`);
  }

  if (cmd === '=stock') {
    const cat = args[1]?.toLowerCase();
    if (!cat)
      return message.reply(
        `📦 Stock:\n${Object.entries(stock)
          .map(([k, v]) => `**${k}**: ${v.length} items`)
          .join('\n')}`
      );
    if (!stock[cat]) return message.reply('❌ Category not found.');
    return message.reply(`📦 Stock for **${cat}**:\n` + stock[cat].join('\n'));
  }

  if (cmd === '=stockall') {
    const lines = [];
    for (const cat in stock) {
      lines.push(`**${cat}** (${stock[cat].length} items):\n${stock[cat].join('\n') || 'Empty'}`);
    }
    return message.reply(lines.join('\n\n'));
  }

  if (cmd === '=cstock') {
    updateFileStock();
    const lines = [];
    for (const cat in fileStock) {
      lines.push(`**${cat}**: ${fileStock[cat].length} files`);
    }
    return message.reply('🍪 Cookie stock:\n' + lines.join('\n'));
  }

  if (cmd === '=upload') {
    if (!AUTHORIZED_USERS.includes(message.author.id)) return message.reply('🚫 Not authorized.');

    if (!message.attachments.size) return message.reply('❌ Please attach a ZIP file.');

    const attachment = message.attachments.first();

    if (!attachment.name.endsWith('.zip')) return message.reply('❌ Only ZIP files allowed.');

    // Download ZIP and save
    const url = attachment.url;
    const zipPath = path.join('./', `upload_${Date.now()}.zip`);

    const res = await fetch(url);
    const buffer = await res.buffer();
    fs.writeFileSync(zipPath, buffer);

    try {
      const zip = new AdmZip(zipPath);
      const extractPath = path.join(COOKIE_DIR, message.author.id);
      if (!fs.existsSync(extractPath)) fs.mkdirSync(extractPath, { recursive: true });
      zip.extractAllTo(extractPath, true);
      fs.unlinkSync(zipPath);
      updateFileStock();
      return message.reply(`✅ ZIP uploaded and extracted to your folder (${message.author.id}).`);
    } catch (err) {
      fs.unlinkSync(zipPath);
      return message.reply(`❌ Failed to extract ZIP: ${err.message}`);
    }
  }

  if (cmd === '=csend') {
    if (!message.member.roles.cache.has('1121741911406903376'))
      return message.reply('🚫 Missing required role.');
    const user = message.mentions.users.first();
    if (!user) return message.reply('❌ Mention a user to send cookie.');
    const cookieFilePath = path.join(COOKIE_DIR, `${user.id}.txt`);
    if (!fs.existsSync(cookieFilePath)) return message.reply('❌ Cookie file does not exist.');

    const attachment = new AttachmentBuilder(cookieFilePath);
    await message.channel.send({ content: `Here is the cookie file for ${user.tag}`, files: [attachment] });

    // Delete file after sending
    fs.unlinkSync(cookieFilePath);
    return message.reply('✅ Cookie file sent and deleted.');
  }

  // === REDEEM COMMAND MERGED ===
  // Check for redeem command
  if (cmd === '=redeem') {
    const code = args[1]?.toUpperCase();
    if (!code) {
      return message.reply('❌ Please provide a stock name or redeem code.');
    }

    // First check in-memory redeemableCodes
    if (code in redeemableCodes) {
      if (redeemableCodes[code]) {
        return message.reply('⚠️ This code has already been redeemed.');
      }
      // Mark code as redeemed
      redeemableCodes[code] = true;
      // You can add reward logic here
      return message.reply(`✅ Code **${code}** redeemed successfully!`);
    }

    // Else fallback to your original redeemed stock system
    if (!AUTHORIZED_USERS.includes(message.author.id)) return message.reply('🚫 Not authorized.');

    if (redeemed[code]) return message.reply('❌ Stock name already redeemed.');

    redeemed[code] = message.author.id;
    saveData();
    return message.reply(`✅ Redeemed stock name: ${code}`);
  }
}

if (cmd === '=pls') {
  if (!AUTHORIZED_USERS.includes(message.author.id))
    return message.reply('🚫 Not authorized.');
  const stockName = args[1];
  if (!stockName) return message.reply('❌ Specify stock name.');
  if (redeemed[stockName]) return message.reply('❌ Stock name already redeemed.');
  redeemed[stockName] = message.author.id;
  saveData();
  return message.reply(`✅ Redeemed stock name: ${stockName}`);
}
  if (cmd === '=debug') {
    if (message.author.id !== OWNER_ID) return;
    return message.channel.send(
      `Roles Allowed: ${JSON.stringify(rolesAllowed)}\nStock: ${JSON.stringify(
        stock
      )}\nRedeemed: ${JSON.stringify(redeemed)}\nFile Stock: ${JSON.stringify(fileStock)}`
    );
  }
});

// === Login ===
client.login(TOKEN);

// === Express server to keep bot alive ===
const app = express();
app.get('/', (req, res) => res.send('Bot is running'));
app.listen(3000, () => console.log('Express server listening on port 3000'));
