const { Client, GatewayIntentBits, Partials, AttachmentBuilder, EmbedBuilder, ChannelType } = require('discord.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const express = require('express');

// === Config & Constants ===
const TOKEN = process.env.TOKEN || 'YOUR_BOT_TOKEN'; // Use env or fallback
const OWNER_ID = '1110864648787480656'; // Your Discord User ID
const AUTHORIZED_USERS = ['1110864648787480656', '1212961835582623755', '1333798275601662056']; // Add IDs of users who can use admin commands
const CSEND_REQUIRED_ROLE_ID = '1374250200511680656'; // Example Role ID for =csend command
const VOUCH_CHANNEL_ID = '1374018342444204067'; // <--- IMPORTANT: SET YOUR VOUCH CHANNEL ID HERE
const REDEEM_ALLOWED_ROLE_ID = '1376539272714260501'; // Role ID for =redeem command

const DATA_DIR = './data';
const COOKIE_DIR = './cookies';
const VOUCH_PATH = './vouches.json';
const STOCK_PATH = './data/stock.json';
const ROLES_PATH = './data/roles.json';
const REDEEMED_PATH = './data/redeemed.json';
const CHANNEL_RESTRICTIONS_PATH = './data/channelRestrictions.json';
const COOLDOWN_PATH = './data/cooldowns.json'; // NEW: Path for cooldowns data

// === Ensure directories exist ===
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(COOKIE_DIR)) fs.mkdirSync(COOKIE_DIR);

// Ensure all JSON files exist with default empty objects
[VOUCH_PATH, STOCK_PATH, ROLES_PATH, REDEEMED_PATH, CHANNEL_RESTRICTIONS_PATH, COOLDOWN_PATH].forEach(filePath => {
    if (!fs.existsSync(filePath)) {
        console.log(`${path.basename(filePath)} not found, creating new one.`);
        fs.writeFileSync(filePath, JSON.stringify({}));
    }
});

// === Global data stores ===
let rolesAllowed = {};         // { commandName: roleId }
let stock = {};                // { category: [item1, item2, ...] }
let redeemed = {};             // { hexCode: { redeemed: boolean, ... } }
let channelRestrictions = {};  // { commandName: channelId }
let cooldowns = {};            // NEW: { commandName: { duration: seconds, lastUsed: { userId: timestamp_ms } } }

// Stores generated unique codes: { hexCode: { redeemed: boolean, category: string, stockName: string, generatedBy: string, timestamp: string } }
const generatedCodes = {}; // In-memory for current session

// Tracks users who have used =pls and are eligible for a single vouch
const plsRequests = {}; // { userId: { timestamp: number, vouchUsed: boolean } }

// This will now map dynamic command names (e.g., 'fgen') to their categories ('free')
const dynamicCommandMap = {};

// Set of all static command names (without '=') for validation
const ALL_STATIC_COMMAND_NAMES = new Set([
    'vouch', // for +vouch and -vouch
    'profile',
    'addcategory',
    'categoryremove',
    'addstock',
    'removestock',
    'add',
    'remove',
    'stock',
    'stockall',
    'cstock',
    'upload',
    'csend',
    'redeem',
    'pls',
    'backup',
    'debug',
    'restrict',
    'unrestrict',
    'cremove',
    'mvouch',
    'cool', // NEW
    'timesaved' // NEW consolidated restore command
]);


// === Helper functions for data persistence ===
function loadJSON(filepath, defaultValue = {}) {
    if (!fs.existsSync(filepath)) return defaultValue;
    try {
        return JSON.parse(fs.readFileSync(filepath, 'utf8'));
    } catch (e) {
        console.error(`Error reading or parsing ${filepath}:`, e);
        return defaultValue;
    }
}
function saveJSON(filepath, data) {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
}
// Specific loaders/savers for clarity
function loadVouches() { return loadJSON(VOUCH_PATH); }
function saveVouches(data) { saveJSON(VOUCH_PATH, data); }
function loadCooldowns() { return loadJSON(COOLDOWN_PATH); } // NEW: Cooldowns loader
function saveCooldowns(data) { saveJSON(COOLDOWN_PATH, data); } // NEW: Cooldowns saver

// Main data loader/saver
function loadData() {
    stock = loadJSON(STOCK_PATH);
    redeemed = loadJSON(REDEEMED_PATH);
    rolesAllowed = loadJSON(ROLES_PATH);
    channelRestrictions = loadJSON(CHANNEL_RESTRICTIONS_PATH);
    cooldowns = loadCooldowns(); // NEW: Load cooldowns
}
function saveData() {
    saveJSON(STOCK_PATH, stock);
    saveJSON(REDEEMED_PATH, redeemed);
    saveJSON(ROLES_PATH, rolesAllowed);
    saveJSON(CHANNEL_RESTRICTIONS_PATH, channelRestrictions);
    saveCooldowns(cooldowns); // NEW: Save cooldowns
}

// === File Stock Tracking (for cookies) ===
let fileStock = {}; // { category: [filename1, filename2, ...] }
function updateFileStock() {
    fileStock = {};
    const cookieCategories = fs.readdirSync(COOKIE_DIR, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

    for (const category of cookieCategories) {
        const categoryPath = path.join(COOKIE_DIR, category);
        fileStock[category] = fs.readdirSync(categoryPath);
    }
}

// Function to update the dynamic command map
function updateDynamicCommandMap() {
    // Clear existing mappings to rebuild fresh
    for (const key in dynamicCommandMap) {
        delete dynamicCommandMap[key];
    }
    for (const category of Object.keys(stock)) {
        dynamicCommandMap[`${category[0]}gen`] = category;
    }
}

// === Initialize data on startup ===
loadData();
updateFileStock();
updateDynamicCommandMap(); // Populate map on startup


// === Client Setup ===
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers, // ADDED: Guild Members Intent
    ],
    partials: [Partials.Channel, Partials.Message, Partials.GuildMember], // ADDED: Guild Member Partial
});

client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
});

function generateHexCode() {
    return Math.random().toString(16).substring(2, 8).toUpperCase();
}

// Function to handle dynamic stock generation commands (e.g., =fgen, =pgen)
async function handleDynamicGenCommand(msg, category) {
    const embed = new EmbedBuilder().setColor(0x3498db); // Blue color
    const args = msg.content.trim().split(/\s+/);
    const commandName = args[0].substring(1).toLowerCase(); // e.g., "fgen"

    // Check role permission
    const requiredRoleId = rolesAllowed[commandName];
    if (requiredRoleId && !msg.member.roles.cache.has(requiredRoleId)) {
        embed.setTitle('Permission Denied 🚫')
             .setDescription('You do not have the required role to use this command.');
        return msg.channel.send({ embeds: [embed] });
    }

    if (!stock[category] || stock[category].length === 0) {
        embed.setTitle('Stock Empty ❌')
             .setDescription(`The **${category}** stock is currently empty. Please try again later.`);
        return msg.channel.send({ embeds: [embed] });
    }

    let stockItem;
    const requestedStockName = args.slice(1).join(' ');

    if (requestedStockName) {
        const foundItemIndex = stock[category].findIndex(item => item.toLowerCase() === requestedStockName.toLowerCase());
        if (foundItemIndex !== -1) {
            stockItem = stock[category][foundItemIndex];
        } else {
            embed.setTitle('Invalid Stock ❌')
                 .setDescription(`The stock item \`${requestedStockName}\` was not found in the **${category}** category.`);
            return msg.channel.send({ embeds: [embed] });
        }
    } else {
        const randomIndex = Math.floor(Math.random() * stock[category].length);
        stockItem = stock[category][randomIndex];
    }

    if (!stockItem) {
         embed.setTitle('Stock Empty ❌')
             .setDescription(`The **${category}** stock is currently empty after an attempt to retrieve an item.`);
         return msg.channel.send({ embeds: [embed] });
    }

    let hexCode;
    do {
        hexCode = generateHexCode();
    } while (generatedCodes[hexCode]);

    generatedCodes[hexCode] = {
        redeemed: false,
        category: category,
        stockName: stockItem,
        generatedBy: msg.author.id,
        timestamp: new Date().toISOString()
    };

    try {
        await msg.author.send({
            embeds: [
                new EmbedBuilder()
                    .setColor(0x2ecc71)
                    .setTitle('✨ Your Generated Stock Code!')
                    .setDescription(
  `**🛡 FIRST VERIFY URSELF** [CLICK HERE](https://ember-chat-register-web.onrender.com/Chat)\n\n` +
  `🎁 Here is your unique code for a **${category}** item: \`${hexCode}\`\n\n` +
  `🎫 To view details, open a ticket and ping our staff.`
)                   
                    .setFooter({ text: `Generated by ${client.user.tag}` })
                    .setTimestamp()
            ]
        });
        embed.setTitle('Code Sent! ✅')
             .setDescription(`A unique code for the **${stockItem}** item has been successfully sent to your DMs.`);
        try {
            return await msg.reply({ embeds: [embed] });
        } catch (replyError) {
            console.warn(`Failed to reply directly to message ID ${msg.id}, sending to channel instead.`);
            return msg.channel.send({ embeds: [embed] });
        }
    } catch (dmError) {
        console.error(`Could not DM user ${msg.author.tag}:`, dmError);
        embed.setTitle('DM Failed ⚠️')
             .setDescription(`I could not send you the code in DMs. Please ensure your DMs are open for this server.`)
             .setColor(0xe67e22);
        return msg.channel.send({ embeds: [embed] });
    }
}


// === Main message handler ===
async function handleMessage(message) {
    if (message.author.bot) return;

    const args = message.content.trim().split(/\s+/);
    const cmd = args[0].toLowerCase(); // e.g., "=fgen" or "=addcategory"
    const commandWithoutPrefix = cmd.startsWith('=') || cmd.startsWith('+') || cmd.startsWith('-') ? cmd.substring(1).toLowerCase() : cmd.toLowerCase(); // e.g., "fgen" or "addcategory"

    const embed = new EmbedBuilder().setColor(0x3498db); // Default embed color

    // Function to check if user is authorized
    const isAuthorized = (userId) => AUTHORIZED_USERS.includes(userId);

    // --- Guild Context Check (NEW) ---
    // Many commands require message.member or message.guild.permissions, etc.
    // If it's not a guild message, these properties will be null.
    // We explicitly allow =backup to proceed without a guild context check, as it DMs the user.
    // All other commands that manage server data or check roles/permissions should be restricted to guilds.
    if (!message.guild && commandWithoutPrefix !== 'backup') {
        // You can send a message in DM if you want, or just ignore it.
        // For simplicity, we'll ignore commands that aren't =backup if they're in DMs.
        if (message.channel.type === ChannelType.DM) {
            embed.setTitle('Command Restricted 🚫')
                 .setDescription('This command can only be used in a server channel.');
            return message.channel.send({ embeds: [embed] });
        }
        return; // For messages not in DMs but still not in a guild (rare, but good for safety)
    }

    // After the guild check, message.member should be available for guild messages.
    // If message.member is still null here for a guild message, it indicates a caching/intent issue,
    // but the previous fixes should largely mitigate this for common scenarios.
    // For specific commands that require message.member, add additional check if needed.
    // For example, if (!message.member) { return message.channel.send('Could not fetch member data.'); }


    // --- Cooldown Check (NEW) ---
    if (cooldowns[commandWithoutPrefix]) {
        const cooldownDuration = cooldowns[commandWithoutPrefix].duration;
        const lastUsedTimestamp = cooldowns[commandWithoutPrefix].lastUsed[message.author.id] || 0;
        const remainingTime = (lastUsedTimestamp + (cooldownDuration * 1000)) - Date.now();

        if (remainingTime > 0) {
            const seconds = Math.ceil(remainingTime / 1000);
            embed.setTitle('Command on Cooldown ⏳')
                 .setDescription(`\`=${commandWithoutPrefix}\` can be used again in **${seconds}** seconds.`);
            return message.channel.send({ embeds: [embed] });
        }
    }

    // Update cooldown timestamp for the command if it passes the check
    if (cooldowns[commandWithoutPrefix]) {
        if (!cooldowns[commandWithoutPrefix].lastUsed) {
            cooldowns[commandWithoutPrefix].lastUsed = {};
        }
        cooldowns[commandWithoutPrefix].lastUsed[message.author.id] = Date.now();
        saveCooldowns(cooldowns); // Save updated cooldowns
    }

    // --- Channel Restriction Check ---
    if (channelRestrictions[commandWithoutPrefix]) {
        if (message.channel.id !== channelRestrictions[commandWithoutPrefix]) {
            embed.setTitle('Command Restricted 🚫')
                 .setDescription(`The command \`${cmd}\` can only be used in <#${channelRestrictions[commandWithoutPrefix]}>.`);
            return message.channel.send({ embeds: [embed] });
        }
    }

    // --- Dynamic Command Handling ---
    const categoryForDynamicCmd = dynamicCommandMap[commandWithoutPrefix];
    if (categoryForDynamicCmd) {
        await handleDynamicGenCommand(message, categoryForDynamicCmd);
        return;
    }

    // --- Static Command Handling ---
    if (cmd === '+vouch' || cmd === '-vouch') {
        const user = message.mentions.users.first();
        const reason = args.slice(2).join(' ');
        const vouchType = cmd === '+vouch' ? 'positive' : 'negative';

        if (!user || !reason) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription(`Usage: \`${cmd} @user <reason>\`\n`);
            return message.channel.send({ embeds: [embed] });
        }

        // Check if the user is vouchable via =pls
        if (!plsRequests[user.id] || plsRequests[user.id].vouchUsed) {
            embed.setTitle('Cannot Vouch ℹ️')
                 .setDescription(`First, LET ${user.tag} help u!`);
            return message.channel.send({ embeds: [embed] });
        }

        // Mark vouch as used for this =pls request
        plsRequests[user.id].vouchUsed = true;


        const vouches = loadVouches();
        const id = user.id;

        if (!vouches[id]) {
            vouches[id] = { positiveCount: 0, negativeCount: 0, reasons: [], lastVouched: null };
        }

        if (vouchType === 'positive') {
            vouches[id].positiveCount++;
            embed.setTitle('Vouch Added! ✅')
                 .setDescription(`Successfully added a positive vouch for **${user.tag}**.`)
                 .addFields({ name: 'Reason', value: `"${reason}"` });
        } else {
            vouches[id].negativeCount++;
            embed.setTitle('Negative Review Added! ❌')
                 .setDescription(`A negative review has been added for **${user.tag}**.`)
                 .addFields({ name: 'Reason', value: `"${reason}"` });
        }

        vouches[id].reasons.push({
            by: message.author.tag,
            type: vouchType,
            reason,
            date: new Date().toLocaleString(),
        });
        vouches[id].lastVouched = new Date().toLocaleString();

        saveVouches(vouches);
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '+mvouch') {
        if (!message.member.permissions.has('ManageGuild')) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.channel.send({ embeds: [embed] });
        }
        const user = message.mentions.users.first();
        const amount = parseInt(args[2]);
        const reason = args.slice(3).join(' ') || 'Manual adjustment by staff';

        if (!user || isNaN(amount) || amount <= 0) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `+mvouch @user <amount> [reason]`');
            return message.channel.send({ embeds: [embed] });
        }

        const vouches = loadVouches();
        const id = user.id;

        if (!vouches[id]) {
            vouches[id] = { positiveCount: 0, negativeCount: 0, reasons: [], lastVouched: null };
        }

        vouches[id].positiveCount += amount;
        vouches[id].reasons.push({
            by: message.author.tag,
            type: 'manual_positive',
            reason: `${amount} vouches added: "${reason}"`,
            date: new Date().toLocaleString(),
        });
        vouches[id].lastVouched = new Date().toLocaleString();
        saveVouches(vouches);

        embed.setTitle('Vouches Manually Added! ✅')
             .setDescription(`Successfully added **${amount}** positive vouches for **${user.tag}**.`)
             .addFields({ name: 'Reason', value: `"${reason}"` });
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '-mvouch') {
        if (!message.member.permissions.has('ManageGuild')) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.channel.send({ embeds: [embed] });
        }
        const user = message.mentions.users.first();
        const amount = parseInt(args[2]);
        const reason = args.slice(3).join(' ') || 'Manual adjustment by staff';

        if (!user || isNaN(amount) || amount <= 0) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `-mvouch @user <amount> [reason]`');
            return message.channel.send({ embeds: [embed] });
        }

        const vouches = loadVouches();
        const id = user.id;

        if (!vouches[id]) {
            vouches[id] = { positiveCount: 0, negativeCount: 0, reasons: [], lastVouched: null };
        }

        vouches[id].negativeCount += amount;
        if (vouches[id].positiveCount - amount < 0) {
            // This case handles removal from positive vouches
            // For now, we only increment negative and don't touch positive for -mvouch
            // If the intent was to reduce positive vouches, that logic needs to be added.
            // Keeping it simple as per request: "-mvouches @user to remove the vouches" -> implies adding negative.
        }

        vouches[id].reasons.push({
            by: message.author.tag,
            type: 'manual_negative',
            reason: `${amount} vouches removed: "${reason}"`,
            date: new Date().toLocaleString(),
        });
        vouches[id].lastVouched = new Date().toLocaleString();
        saveVouches(vouches);

        embed.setTitle('Vouches Manually Removed! ✅')
             .setDescription(`Successfully added **${amount}** negative vouches (effectively removed) for **${user.tag}**.`)
             .addFields({ name: 'Reason', value: `"${reason}"` });
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '=profile') {
        const user = message.mentions.users.first() || message.author;
        const vouches = loadVouches();
        const data = vouches[user.id];

        if (!data) {
            embed.setTitle('Profile Not Found ℹ️')
                 .setDescription(`${user.tag} has not received any vouches or reviews yet.`);
            return message.channel.send({ embeds: [embed] });
        }

        embed.setColor(0x2ecc71)
             .setTitle(`${user.tag}'s Vouch & Review Profile`)
             .setThumbnail(user.displayAvatarURL())
             .addFields(
                 { name: '✅ Positive Reviews', value: `${data.positiveCount || 0}`, inline: true },
                 { name: '❌ Negative Reviews', value: `${data.negativeCount || 0}`, inline: true },
                 { name: 'Last Reviewed On', value: `${data.lastVouched || 'N/A'}`, inline: false }
             );

        // Filter for regular and manual vouches/reviews
        const regularPositiveReasons = data.reasons.filter(r => r.type === 'positive');
        const regularNegativeReasons = data.reasons.filter(r => r.type === 'negative');
        const manualPositiveReasons = data.reasons.filter(r => r.type === 'manual_positive');
        const manualNegativeReasons = data.reasons.filter(r => r.type === 'manual_negative');

        // Combine all positive and negative reasons for display
        const allPositiveReasons = [...regularPositiveReasons, ...manualPositiveReasons];
        const allNegativeReasons = [...regularNegativeReasons, ...manualNegativeReasons];

        if (allPositiveReasons.length > 0) {
            embed.addFields({
                name: 'Recent Positive Reviews',
                value: allPositiveReasons
                    .slice(-3)
                    .reverse()
                    .map((r, i) => `**${allPositiveReasons.length - i}.** By: ${r.by}\nReason: *"${r.reason}"*\nDate: (${r.date})`)
                    .join('\n\n') || 'No recent positive reviews.',
                inline: false
            });
        }

        if (allNegativeReasons.length > 0) {
            embed.addFields({
                name: 'Recent Negative Reviews',
                value: allNegativeReasons
                    .slice(-3)
                    .reverse()
                    .map((r, i) => `**${allNegativeReasons.length - i}.** By: ${r.by}\nReason: *"${r.reason}"*\nDate: (${r.date})`)
                    .join('\n\n') || 'No recent negative reviews.',
                inline: false
            });
        }
        
        if (allPositiveReasons.length === 0 && allNegativeReasons.length === 0) {
            embed.addFields({ name: 'Recent Reviews', value: 'No recent reviews.', inline: false });
        }

        embed.setFooter({ text: `User ID: ${user.id}` })
             .setTimestamp();

        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '=addcategory') {
        if (!message.member.permissions.has('ManageGuild')) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.channel.send({ embeds: [embed] });
        }
        const name = args[1]?.toLowerCase();
        if (!name) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Please provide a category name. Usage: `=addcategory <name>`');
            return message.channel.send({ embeds: [embed] });
        }
        if (stock[name]) {
            embed.setTitle('Category Exists ⚠️')
                 .setDescription(`Category \`${name}\` already exists.`);
            return message.channel.send({ embeds: [embed] });
        }
        stock[name] = [];
        updateDynamicCommandMap(); // Update map after adding category
        saveData();
        embed.setTitle('Category Created! ✅')
             .setDescription(`Category \`${name}\` has been created.`)
             .addFields({ name: 'Generated Command', value: `\`=${name[0]}gen\` is now active for this category.` });
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '=categoryremove') {
        if (!message.member.permissions.has('ManageGuild')) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.channel.send({ embeds: [embed] });
        }

        const category = args[1]?.toLowerCase();
        if (!category) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=categoryremove <category>`');
            return message.channel.send({ embeds: [embed] });
        }

        if (!stock[category]) {
            embed.setTitle('Category Not Found ❌')
                 .setDescription(`The category \`${category}\` does not exist.`);
            return message.channel.send({ embeds: [embed] });
        }

        delete stock[category];
        delete rolesAllowed[`${category[0]}gen`]; // Remove associated role restriction
        delete channelRestrictions[`${category[0]}gen`]; // Remove associated channel restriction
        // Also remove cooldowns for this dynamic command
        if (cooldowns[`${category[0]}gen`]) {
            delete cooldowns[`${category[0]}gen`];
        }
        updateDynamicCommandMap(); // Update map after category removal
        saveData();

        embed.setTitle('Category Removed! ✅')
             .setDescription(`Category \`${category}\` and associated dynamic command \`=${category[0]}gen\` (and its restrictions) have been removed.`);
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '=addstock') {
        if (!message.member.permissions.has('ManageGuild')) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.channel.send({ embeds: [embed] });
        }
        const category = args[1]?.toLowerCase();
        const stockItem = args.slice(2).join(' ');
        if (!category || !stockItem) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=addstock <category> <stock_name>`');
            return message.channel.send({ embeds: [embed] });
        }
        if (!stock[category]) {
            embed.setTitle('Category Not Found ❌')
                 .setDescription(`Category \`${category}\` does not exist. Use \`=addcategory\` first.`);
            return message.channel.send({ embeds: [embed] });
        }
        stock[category].push(stockItem);
        saveData();
        embed.setTitle('Stock Added! ✅')
             .setDescription(`Stock item \`${stockItem}\` has been added to the **${category}** category.`);
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '=removestock') {
        if (!message.member.permissions.has('ManageGuild')) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.channel.send({ embeds: [embed] });
        }
        const category = args[1]?.toLowerCase();
        const stockName = args.slice(2).join(' ');
        if (!category || !stockName) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=removestock <category> <stock_name>`');
            return message.channel.send({ embeds: [embed] });
        }
        if (!stock[category]) {
            embed.setTitle('Category Not Found ❌')
                 .setDescription(`Category \`${category}\` does not exist.`);
            return message.channel.send({ embeds: [embed] });
        }

        const initialLength = stock[category].length;
        stock[category] = stock[category].filter(item => item.toLowerCase() !== stockName.toLowerCase());

        if (stock[category].length < initialLength) {
            saveData();
            embed.setTitle('Stock Removed! ✅')
                 .setDescription(`Removed all instances of \`${stockName}\` from **${category}** stock.`);
            return message.channel.send({ embeds: [embed] });
        } else {
            embed.setTitle('Stock Not Found ❌')
                 .setDescription(`Stock item \`${stockName}\` not found in **${category}** category.`);
            return message.channel.send({ embeds: [embed] });
        }
    }

    if (cmd === '=add') {
        if (!message.member.permissions.has('ManageGuild')) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.channel.send({ embeds: [embed] });
        }
        const commandToRestrict = args[1]?.toLowerCase();
        const role = message.mentions.roles.first();

        if (!commandToRestrict || !role) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=add <command_name_without_=> @role`');
            return message.channel.send({ embeds: [embed] });
        }

        // Validate if it's a known command (static or dynamic)
        if (!ALL_STATIC_COMMAND_NAMES.has(commandToRestrict) && !dynamicCommandMap.hasOwnProperty(commandToRestrict)) {
            embed.setTitle('Invalid Command ⚠️')
                 .setDescription(`Command \`=${commandToRestrict}\` is not a recognized command that can be restricted.`);
            return message.channel.send({ embeds: [embed] });
        }

        rolesAllowed[commandToRestrict] = role.id;
        saveData();
        embed.setTitle('Permission Granted! ✅')
             .setDescription(`The role **${role.name}** can now use the command \`=${commandToRestrict}\`.`);
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '=remove') {
        if (!message.member.permissions.has('ManageGuild')) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.channel.send({ embeds: [embed] });
        }
        const commandToRemoveRestriction = args[1]?.toLowerCase();
        if (!commandToRemoveRestriction) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=remove <command_name_without_=>`');
            return message.channel.send({ embeds: [embed] });
        }

        if (rolesAllowed[commandToRemoveRestriction]) {
            delete rolesAllowed[commandToRemoveRestriction];
            saveData();
            embed.setTitle('Permission Removed! ✅')
                 .setDescription(`Role restriction for command \`=${commandToRemoveRestriction}\` has been removed.`);
            return message.channel.send({ embeds: [embed] });
        } else {
            embed.setTitle('No Restriction Found ℹ️')
                 .setDescription(`The command \`=${commandToRemoveRestriction}\` does not have a role restriction set.`);
            return message.channel.send({ embeds: [embed] });
        }
    }

    if (cmd === '=restrict') {
        if (!message.member.permissions.has('ManageGuild')) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.channel.send({ embeds: [embed] });
        }

        const commandToRestrict = args[1]?.toLowerCase();
        const targetChannel = message.mentions.channels.first() || message.guild.channels.cache.get(args[2]);

        if (!commandToRestrict || !targetChannel || targetChannel.type !== ChannelType.GuildText) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=restrict <command_name_without_=> <#channel | channel_id>`');
            return message.channel.send({ embeds: [embed] });
        }

        // Validate if it's a known command (static or dynamic)
        if (!ALL_STATIC_COMMAND_NAMES.has(commandToRestrict) && !dynamicCommandMap.hasOwnProperty(commandToRestrict)) {
            embed.setTitle('Invalid Command ⚠️')
                 .setDescription(`Command \`=${commandToRestrict}\` is not a recognized command that can be restricted.`);
            return message.channel.send({ embeds: [embed] });
        }

        channelRestrictions[commandToRestrict] = targetChannel.id;
        saveData();
        embed.setTitle('Command Restricted! ✅')
             .setDescription(`The command \`=${commandToRestrict}\` can now only be used in <#${targetChannel.id}>.`);
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '=unrestrict') {
        if (!message.member.permissions.has('ManageGuild')) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.channel.send({ embeds: [embed] });
        }
        const commandToUnrestrict = args[1]?.toLowerCase();
        if (!commandToUnrestrict) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=unrestrict <command_name_without_=>`');
            return message.channel.send({ embeds: [embed] });
        }

        if (channelRestrictions[commandToUnrestrict]) {
            delete channelRestrictions[commandToUnrestrict];
            saveData();
            embed.setTitle('Command Unrestricted! ✅')
                 .setDescription(`Channel restriction for command \`=${commandToUnrestrict}\` has been removed.`);
            return message.channel.send({ embeds: [embed] });
        } else {
            embed.setTitle('No Channel Restriction Found ℹ️')
                 .setDescription(`The command \`=${commandToUnrestrict}\` does not have a channel restriction set.`);
            return message.channel.send({ embeds: [embed] });
        }
    }

    // NEW: =cool command
    if (cmd === '=cool') {
        if (!isAuthorized(message.author.id)) {
            embed.setTitle('Authorization Required 🚫')
                 .setDescription('You need to be an authorized user to use this command.');
            return message.channel.send({ embeds: [embed] });
        }

        const commandToCool = args[1]?.toLowerCase();
        const cooldownTimeSeconds = parseInt(args[2]);

        if (!commandToCool || isNaN(cooldownTimeSeconds) || cooldownTimeSeconds < 0) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=cool <command_name_without_=> <cooldown_in_seconds>` (use 0 to remove cooldown)');
            return message.channel.send({ embeds: [embed] });
        }

        // Validate if it's a known command (static or dynamic)
        if (!ALL_STATIC_COMMAND_NAMES.has(commandToCool) && !dynamicCommandMap.hasOwnProperty(commandToCool)) {
            embed.setTitle('Invalid Command ⚠️')
                 .setDescription(`Command \`=${commandToCool}\` is not a recognized command.`);
            return message.channel.send({ embeds: [embed] });
        }

        if (cooldownTimeSeconds === 0) {
            if (cooldowns[commandToCool]) {
                delete cooldowns[commandToCool];
                saveCooldowns(cooldowns);
                embed.setTitle('Cooldown Removed! ✅')
                     .setDescription(`Cooldown for \`=${commandToCool}\` has been removed.`);
            } else {
                embed.setTitle('No Cooldown Set ℹ️')
                     .setDescription(`\`=${commandToCool}\` does not have a cooldown set.`);
            }
        } else {
            cooldowns[commandToCool] = {
                duration: cooldownTimeSeconds,
                lastUsed: cooldowns[commandToCool]?.lastUsed || {} // Preserve lastUsed if it exists
            };
            saveCooldowns(cooldowns);
            embed.setTitle('Cooldown Set! ✅')
                 .setDescription(`\`=${commandToCool}\` now has a cooldown of **${cooldownTimeSeconds}** seconds.`);
        }
        return message.channel.send({ embeds: [embed] });
    }


    if (cmd === '=stock') {
        const allCategories = Object.keys(stock);
        if (allCategories.length === 0) {
            embed.setTitle('No Stock 📦')
                 .setDescription('No stock categories have been added yet.')
                 .setColor(0x0099ff);
            return message.channel.send({ embeds: [embed] });
        }

        const cat = args[1]?.toLowerCase();
        if (cat) {
            if (stock[cat]) {
                const categoryItems = stock[cat];
                embed.setTitle(`📦 Stock for **${cat.toUpperCase()}** (${categoryItems.length} items)`)
                     .setDescription(categoryItems.length > 0 ? categoryItems.map(item => `\`${item}\``).join(', ') : 'This category is empty.')
                     .setColor(0x0099ff);
                return message.channel.send({ embeds: [embed] });
            } else {
                embed.setTitle('Category Not Found ❌')
                     .setDescription(`The category \`${cat}\` does not exist.`)
                     .setColor(0xe74c3c);
                return message.channel.send({ embeds: [embed] });
            }
        }

        const replyEmbed = new EmbedBuilder()
            .setTitle('📦 Current Stock Overview')
            .setColor(0x2c3e50);

        const sortedCategories = allCategories.sort();

        for (const category of sortedCategories) {
            const items = stock[category];
            const stockCount = items.length;
            const fieldValue = stockCount > 0 ? `**${stockCount}** items` : '*Empty*';
            replyEmbed.addFields({ name: category.toUpperCase(), value: fieldValue, inline: true });
        }

        return message.channel.send({ embeds: [replyEmbed] });
    }

    if (cmd === '=stockall') {
        const allCategories = Object.keys(stock);
        if (allCategories.length === 0) {
            embed.setTitle('No Stock 📦')
                 .setDescription('There are no stock categories to display.')
                 .setColor(0x0099ff);
            return message.channel.send({ embeds: [embed] });
        }

        const replyEmbeds = [];
        let currentEmbed = new EmbedBuilder()
            .setTitle('📦 All Stock Details')
            .setColor(0x0099ff);
        let fieldCounter = 0;

        const sortedCategories = allCategories.sort();

        for (const cat of sortedCategories) {
            const items = stock[cat];
            const content = items.length > 0 ? items.map(item => `\`${item}\``).join(', ') : '*Empty*';

            if (content.length > 1000) {
                const parts = content.match(/[\s\S]{1,1000}/g) || [];
                for (let i = 0; i < parts.length; i++) {
                    currentEmbed.addFields({
                        name: i === 0 ? `${cat.toUpperCase()} (${items.length} items)` : '\u200b',
                        value: parts[i],
                        inline: false
                    });
                    fieldCounter++;
                    if (fieldCounter >= 24) {
                        replyEmbeds.push(currentEmbed);
                        currentEmbed = new EmbedBuilder()
                            .setTitle('📦 All Stock Details (Continued)')
                            .setColor(0x0099ff);
                        fieldCounter = 0;
                    }
                }
            } else {
                 currentEmbed.addFields({
                    name: `${cat.toUpperCase()} (${items.length} items)`,
                    value: content,
                    inline: false
                });
                fieldCounter++;
                if (fieldCounter >= 24) {
                    replyEmbeds.push(currentEmbed);
                    currentEmbed = new EmbedBuilder()
                        .setTitle('📦 All Stock Details (Continued)')
                        .setColor(0x0099ff);
                    fieldCounter = 0;
                }
            }
        }
        replyEmbeds.push(currentEmbed);

        for (const finalEmbed of replyEmbeds) {
            await message.channel.send({ embeds: [finalEmbed] });
        }
        return;
    }

    if (cmd === '=cstock') {
        updateFileStock();
        embed.setTitle('🍪 Cookie Stock Overview')
             .setColor(0xf1c40f);

        const cookieCategories = Object.keys(fileStock);
        if (cookieCategories.length === 0) {
            embed.setDescription('No cookie categories found. Upload a ZIP file to create one!');
            return message.channel.send({ embeds: [embed] });
        }

        const sortedCookieCategories = cookieCategories.sort();

        for (const category of sortedCookieCategories) {
            const fileCount = fileStock[category].length;
            embed.addFields({ name: category.toUpperCase(), value: `${fileCount} files`, inline: true });
        }
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '=upload') {
        if (!isAuthorized(message.author.id)) {
            embed.setTitle('Authorization Required 🚫')
                 .setDescription('You need to be an authorized user to use this command.');
            return message.channel.send({ embeds: [embed] });
        }

        const category = args[1]?.toLowerCase();
        if (!category) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=upload <cookie_category>` with a ZIP file.');
            return message.channel.send({ embeds: [embed] });
        }

        if (!message.attachments.size) {
            embed.setTitle('Missing Attachment ❌')
                 .setDescription('Please attach a ZIP file to upload.');
            return message.channel.send({ embeds: [embed] });
        }

        const attachment = message.attachments.first();
        if (!attachment.name.endsWith('.zip')) {
            embed.setTitle('Invalid File Type ❌')
                 .setDescription('Only ZIP files are allowed.');
            return message.channel.send({ embeds: [embed] });
        }

        const zipPath = path.join('./', `upload_${Date.now()}.zip`);
        embed.setTitle('Processing Upload... ⏳')
             .setDescription(`Uploading ZIP to \`${category}\`...`)
             .setColor(0x9b59b6);
        const statusMsg = await message.channel.send({ embeds: [embed] });

        try {
            const res = await fetch(attachment.url);
            const buffer = await res.buffer();
            fs.writeFileSync(zipPath, buffer);

            const zip = new AdmZip(zipPath);
            const extractPath = path.join(COOKIE_DIR, category);
            if (!fs.existsSync(extractPath)) fs.mkdirSync(extractPath, { recursive: true });

            for (const zipEntry of zip.getEntries()) {
                if (!zipEntry.isDirectory) {
                    zip.extractEntryTo(zipEntry.entryName, extractPath, false, true);
                }
            }
            fs.unlinkSync(zipPath);

            updateFileStock();

            embed.setTitle('Upload Successful! ✅')
                 .setDescription(`Files uploaded to \`${category}\`. Reflected in \`=cstock\`.`);
            return statusMsg.edit({ embeds: [embed] });
        } catch (err) {
            console.error('Upload error:', err);
            if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
            embed.setTitle('Upload Failed ❌')
                 .setDescription(`An error occurred while processing your ZIP: \`${err.message}\``)
                 .setColor(0xe74c3c);
            return statusMsg.edit({ embeds: [embed] });
        }
    }

    if (cmd === '=cremove') { // MODIFIED COMMAND: =cremove to remove a whole category and send as zip
        if (!message.member.permissions.has('ManageGuild')) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.channel.send({ embeds: [embed] });
        }

        const category = args[1]?.toLowerCase();

        if (!category) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=cremove <cookie_category>` to remove all files in a category and get them in a ZIP.');
            return message.channel.send({ embeds: [embed] });
        }

        const categoryPath = path.join(COOKIE_DIR, category);
        if (!fs.existsSync(categoryPath)) {
            embed.setTitle('Category Not Found ❌')
                 .setDescription(`Cookie category \`${category}\` does not exist.`);
            return message.channel.send({ embeds: [embed] });
        }

        const filesInCategories = fs.readdirSync(categoryPath);
        if (filesInCategories.length === 0) {
            embed.setTitle('Category Empty ℹ️')
                 .setDescription(`Category \`${category}\` is already empty. Removing directory.`);
            fs.rmdirSync(categoryPath);
            updateFileStock();
            return message.channel.send({ embeds: [embed] });
        }

        try {
            const zip = new AdmZip();
            const zipFileName = `${category}_cookies_${Date.now()}.zip`;
            const tempZipPath = path.join('./', zipFileName);

            // Add all files from the category to the zip
            filesInCategories.forEach(file => {
                const filePath = path.join(categoryPath, file);
                zip.addLocalFile(filePath, category); // Add to a folder named 'category' inside the zip
            });

            zip.writeZip(tempZipPath);

            // Send the ZIP to the user's DM
            const attachment = new AttachmentBuilder(tempZipPath, { name: zipFileName });
            await message.author.send({
                content: `Here are all the cookie files from the removed category \`${category}\`:`,
                files: [attachment]
            });

            // Delete the original category directory and its contents
            fs.rmSync(categoryPath, { recursive: true, force: true });
            fs.unlinkSync(tempZipPath); // Clean up temp zip file

            updateFileStock(); // Update stock after removal

            embed.setTitle('Category Removed and Sent! ✅')
                 .setDescription(`All files from category \`${category}\` have been removed and sent to your DMs in a ZIP file.`);
            return message.channel.send({ embeds: [embed] });

        } catch (error) {
            console.error('Error removing or sending cookie category:', error);
            embed.setTitle('Error ❌')
                 .setDescription(`An error occurred: \`${error.message}\`. Please check console for details or ensure your DMs are open.`);
            return message.channel.send({ embeds: [embed] });
        }
    }


    if (cmd === '=csend') {
        if (!message.member.permissions.has('ManageGuild')) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.channel.send({ embeds: [embed] });
        }

        const category = args[1]?.toLowerCase();
        const user = message.mentions.users.first();
        if (!category || !user) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=csend <cookie_category> @user`');
            return message.channel.send({ embeds: [embed] });
        }

        const categoryPath = path.join(COOKIE_DIR, category);
        if (!fs.existsSync(categoryPath) || fs.readdirSync(categoryPath).length === 0) {
            embed.setTitle('No Files ❌')
                 .setDescription(`No files found in category \`${category}\`.`);
            return message.channel.send({ embeds: [embed] });
        }

        const files = fs.readdirSync(categoryPath);
        const fileToSend = files[0];
        const filePath = path.join(categoryPath, fileToSend);

        try {
            const attachment = new AttachmentBuilder(filePath);
            await user.send({
                content: `Here is a cookie file from \`${category}\` sent by ${message.author.tag}:`,
                files: [attachment]
            });

            fs.unlinkSync(filePath);
            if (fs.readdirSync(categoryPath).length === 0) {
                fs.rmdirSync(categoryPath);
            }
            updateFileStock();

            embed.setTitle('Cookie Sent! ✅')
                 .setDescription(`\`${fileToSend}\` has been sent to ${user.tag} and removed from storage.`);
            return message.channel.send({ embeds: [embed] });
        } catch (error) {
            console.error('Error sending file:', error);
            embed.setTitle('Error Sending File ❌')
                 .setDescription(`An error occurred while sending the cookie file for **${user.tag}**. Please ensure their DMs are open.`);
            return message.channel.send({ embeds: [embed] });
        }
    }

    if (cmd === '=redeem') { // MODIFIED: Only allows redemption by hex code and by specific role
        // NEW: Role permission check for =redeem
        if (!message.member.roles.cache.has(REDEEM_ALLOWED_ROLE_ID)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription(`You need the role <@&${REDEEM_ALLOWED_ROLE_ID}> to use this command.`);
            return message.channel.send({ embeds: [embed] });
        }

        const code = args[1]?.toUpperCase();
        if (!code) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=redeem <hex_code>`');
            return message.channel.send({ embeds: [embed] });
        }

        if (generatedCodes[code]) {
            const codeData = generatedCodes[code];
            if (codeData.redeemed) {
                embed.setTitle('Code Already Redeemed ⚠️')
                     .setDescription(`The code \`${code}\` has already been redeemed.`);
                return message.channel.send({ embeds: [embed] });
            }
            codeData.redeemed = true; // Mark as redeemed

            embed.setTitle('Code Redeemed! ✅')
                 .setDescription(`You have successfully redeemed code: \`${code}\`\n\nThis code was generated for a **${codeData.category.toUpperCase()}** item: \`${codeData.stockName}\`.`)
                 .addFields(
                     { name: 'Generated By', value: `<@${codeData.generatedBy}>`, inline: true },
                     { name: 'Generated On', value: new Date(codeData.timestamp).toLocaleString(), inline: true }
                 )
                 .setFooter({ text: 'This code is now invalid.' });
            return message.channel.send({ embeds: [embed] });
        } else {
            embed.setTitle('Invalid Code ❌')
                 .setDescription('The provided code is either invalid or has expired. Only hex codes generated by `=*gen` commands can be redeemed.');
            return message.channel.send({ embeds: [embed] });
        }
    }

    if (cmd === '=pls') {
        // NEW: Set the user as vouchable for one vouch
        // Clear any previous state for this user to allow a new vouch
        plsRequests[message.author.id] = { timestamp: Date.now(), vouchUsed: false };

        embed.setTitle('Cheers for our staff! 🎉')
             .setDescription(`Show appreciation with \`+vouch @user\` in <#${VOUCH_CHANNEL_ID}>.\nNot happy? Use \`-vouch @user <reason>\`.\n\n**You are now eligible to receive ONE vouch/review.**`);
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '=backup') {
        if (!isAuthorized(message.author.id)) {
            embed.setTitle('Authorization Required 🚫')
                 .setDescription('You need to be an authorized user to use this command.');
            return message.channel.send({ embeds: [embed] });
        }

        try {
            const vouchesAttachment = new AttachmentBuilder(VOUCH_PATH, { name: 'vouches.json' });
            const stockAttachment = new AttachmentBuilder(STOCK_PATH, { name: 'stock.json' });
            const rolesAttachment = new AttachmentBuilder(ROLES_PATH, { name: 'roles.json' });
            const redeemedAttachment = new AttachmentBuilder(REDEEMED_PATH, { name: 'redeemed.json' });
            const channelRestrictionsAttachment = new AttachmentBuilder(CHANNEL_RESTRICTIONS_PATH, { name: 'channelRestrictions.json' });
            const cooldownsAttachment = new AttachmentBuilder(COOLDOWN_PATH, { name: 'cooldowns.json' }); // NEW: Cooldowns backup

            await message.author.send({
                content: 'Here are your backup files:',
                files: [vouchesAttachment, stockAttachment, rolesAttachment, redeemedAttachment, channelRestrictionsAttachment, cooldownsAttachment]
            });
            embed.setTitle('Backup Sent! ✅')
                 .setDescription('Your bot data files have been sent to your DMs (`vouches.json`, `stock.json`, `roles.json`, `redeemed.json`, `channelRestrictions.json`, `cooldowns.json`).');
            return message.channel.send({ embeds: [embed] });
        } catch (dmError) {
            console.error(`Could not DM user ${message.author.tag} for backup:`, dmError);
            embed.setTitle('Backup Failed ❌')
                 .setDescription('Could not send backup files to your DMs. Please ensure your DMs are open.');
            return message.channel.send({ embeds: [embed] });
        }
    }

    // NEW CONSOLIDATED COMMAND: =timesaved
    if (cmd === '=timesaved') {
        if (!isAuthorized(message.author.id)) {
            embed.setTitle('Authorization Required 🚫')
                 .setDescription('You need to be an authorized user to use this command.');
            return message.channel.send({ embeds: [embed] });
        }

        const attachments = message.attachments;
        if (attachments.size === 0) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Please attach one or more JSON files to restore data. Accepted files: `vouches.json`, `stock.json`, `roles.json`, `redeemed.json`, `channelRestrictions.json`, `cooldowns.json`.');
            return message.channel.send({ embeds: [embed] });
        }

        const allowedFileNames = [
            'vouches.json', 'stock.json', 'roles.json',
            'redeemed.json', 'channelRestrictions.json', 'cooldowns.json'
        ];
        let restoredFiles = [];
        let errorMessages = [];

        for (const attachment of attachments.values()) {
            if (!attachment.name.endsWith('.json') || !allowedFileNames.includes(attachment.name)) {
                errorMessages.push(`Skipping invalid file: \`${attachment.name}\`. Only allowed JSON files can be restored.`);
                continue;
            }
            if (attachment.size > 1024 * 1024 * 5) { // 5MB limit for each file
                errorMessages.push(`Skipping \`${attachment.name}\` - file too large (Max 5MB).`);
                continue;
            }

            try {
                const response = await fetch(attachment.url);
                const text = await response.text();
                const newData = JSON.parse(text);

                if (typeof newData !== 'object' || newData === null) {
                    throw new Error('Invalid JSON structure. Expected an object.');
                }

                switch (attachment.name) {
                    case 'vouches.json':
                        saveVouches(newData);
                        break;
                    case 'stock.json':
                        stock = newData;
                        saveData(); // Saves all data including stock
                        updateDynamicCommandMap(); // Re-populate dynamic commands based on new stock
                        break;
                    case 'roles.json':
                        rolesAllowed = newData;
                        saveData();
                        break;
                    case 'redeemed.json':
                        redeemed = newData;
                        saveData();
                        break;
                    case 'channelRestrictions.json':
                        channelRestrictions = newData;
                        saveData();
                        break;
                    case 'cooldowns.json': // NEW: Restore cooldowns
                        cooldowns = newData;
                        saveData();
                        break;
                }
                restoredFiles.push(attachment.name);
            } catch (error) {
                errorMessages.push(`Failed to restore \`${attachment.name}\`: \`${error.message}\`.`);
                console.error(`Error restoring ${attachment.name}:`, error);
            }
        }

        if (restoredFiles.length > 0) {
            embed.setTitle('Data Restoration Complete! ✅')
                 .setDescription(`Successfully restored: ${restoredFiles.map(f => `\`${f}\``).join(', ')}.`);
        } else {
            embed.setTitle('Data Restoration Failed ❌')
                 .setDescription('No valid files were restored. Ensure correct file names and valid JSON format.\nU noob.');
        }
        if (errorMessages.length > 0) {
            embed.addFields({ name: 'Errors', value: errorMessages.join('\n'), inline: false });
        }
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '=debug') {
        if (!isAuthorized(message.author.id)) {
            embed.setTitle('Authorization Required 🚫')
                 .setDescription('You need to be an authorized user to use this command.');
            return message.channel.send({ embeds: [embed] });
        }
        const debugEmbed = new EmbedBuilder()
            .setTitle('Bot Debug Information')
            .setColor(0x8e44ad)
            .setDescription('Current internal state of the bot data. (Truncated for Discord character limits)');

        const rolesAllowedStr = JSON.stringify(rolesAllowed, null, 2);
        const stockStr = JSON.stringify(stock, null, 2);
        const redeemedStr = JSON.stringify(redeemed, null, 2);
        const generatedCodesStr = JSON.stringify(generatedCodes, null, 2);
        const fileStockStr = JSON.stringify(fileStock, null, 2);
        const channelRestrictionsStr = JSON.stringify(channelRestrictions, null, 2);
        const plsRequestsStr = JSON.stringify(plsRequests, null, 2);
        const cooldownsStr = JSON.stringify(cooldowns, null, 2); // NEW: Add cooldowns to debug

        const splitStringForEmbed = (str, fieldName) => {
            const maxLen = 1000;
            const parts = [];
            for (let i = 0; i < str.length; i += maxLen) {
                parts.push(str.substring(i, Math.min(i + maxLen, str.length)));
            }
            return parts.map((part, index) => ({
                name: index === 0 ? fieldName : '\u200b',
                value: `\`\`\`json\n${part}\n\`\`\``,
                inline: false
            }));
        };

        debugEmbed.addFields(...splitStringForEmbed(rolesAllowedStr, 'Roles Allowed'));
        debugEmbed.addFields(...splitStringForEmbed(stockStr, 'Stock Data'));
        debugEmbed.addFields(...splitStringForEmbed(redeemedStr, 'Manually Redeemed'));
        debugEmbed.addFields(...splitStringForEmbed(generatedCodesStr, 'Generated Codes (in-memory)'));
        debugEmbed.addFields(...splitStringForEmbed(fileStockStr, 'File Stock'));
        debugEmbed.addFields(...splitStringForEmbed(channelRestrictionsStr, 'Channel Restrictions'));
        debugEmbed.addFields(...splitStringForEmbed(plsRequestsStr, 'PLS Requests (in-memory)'));
        debugEmbed.addFields(...splitStringForEmbed(cooldownsStr, 'Cooldowns')); // NEW debug field

        return message.channel.send({ embeds: [debugEmbed] });
    }
}
client.login(TOKEN);

// Attach the main message handler to the client
client.on('messageCreate', handleMessage);

// === Keepalive Server ===
const app = express();
app.get('/', (req, res) => res.send('Bot is running.'));
app.listen(3000, () => console.log('Express server listening on port 3000'));

