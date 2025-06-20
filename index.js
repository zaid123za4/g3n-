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

const DATA_DIR = './data';
const COOKIE_DIR = './cookies';
const VOUCH_PATH = './vouches.json';
const STOCK_PATH = './data/stock.json';
const ROLES_PATH = './data/roles.json';
const REDEEMED_PATH = './data/redeemed.json';
const CHANNEL_RESTRICTIONS_PATH = './data/channelRestrictions.json'; // NEW path for channel restrictions

// === Ensure directories exist ===
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(COOKIE_DIR)) fs.mkdirSync(COOKIE_DIR);

// Ensure all JSON files exist with default empty objects
[VOUCH_PATH, STOCK_PATH, ROLES_PATH, REDEEMED_PATH, CHANNEL_RESTRICTIONS_PATH].forEach(filePath => {
    if (!fs.existsSync(filePath)) {
        console.log(`${path.basename(filePath)} not found, creating new one.`);
        fs.writeFileSync(filePath, JSON.stringify({}));
    }
});

// === Global data stores ===
let rolesAllowed = {};         // { commandName: roleId }
let stock = {};                // { category: [item1, item2, ...] }
let redeemed = {};             // { stockName: userId } (for manually redeemed stock names)
let channelRestrictions = {};  // NEW: { commandName: channelId } for restricting commands to specific channels

// Stores generated unique codes: { hexCode: { redeemed: boolean, category: string, stockName: string, generatedBy: string, timestamp: string } }
const generatedCodes = {}; // In-memory for current session

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
    'restvouch',
    'reststock',
    'debug',
    'restrict', // NEW
    'unrestrict' // NEW
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
// Vouches function
function loadVouches() {
    return loadJSON(VOUCH_PATH);
}
function saveVouches(data) {
    saveJSON(VOUCH_PATH, data);
}
// Main data (stock, redeemed, rolesAllowed, channelRestrictions)
function loadData() {
    stock = loadJSON(STOCK_PATH);
    redeemed = loadJSON(REDEEMED_PATH);
    rolesAllowed = loadJSON(ROLES_PATH);
    channelRestrictions = loadJSON(CHANNEL_RESTRICTIONS_PATH); // NEW: Load channel restrictions
}
function saveData() {
    saveJSON(STOCK_PATH, stock);
    saveJSON(REDEEMED_PATH, redeemed);
    saveJSON(ROLES_PATH, rolesAllowed);
    saveJSON(CHANNEL_RESTRICTIONS_PATH, channelRestrictions); // NEW: Save channel restrictions
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
    ],
    partials: [Partials.Channel, Partials.Message],
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
                    .setDescription(`Here is your unique code for a **${category}** item: \`${hexCode}\`\n\n**Item:** \`${stockItem}\`\n\nTo view details about this item, use: \`=redeem ${hexCode}\``)
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
             .setDescription(`I could not send you the code in DMs. Please ensure your DMs are open for this server.\n\nYour code (for debugging): \`${hexCode}\`\n**Item:** \`${stockItem}\``)
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

    // --- Channel Restriction Check (NEW) ---
    if (channelRestrictions[commandWithoutPrefix]) {
        if (message.channel.id !== channelRestrictions[commandWithoutPrefix]) {
            embed.setTitle('Command Restricted 🚫')
                 .setDescription(`The command \`${cmd}\` can only be used in <#${channelRestrictions[commandWithoutPrefix]}>.`);
            return message.channel.send({ embeds: [embed] });
        }
    }

    // --- Dynamic Command Handling (Revised) ---
    const categoryForDynamicCmd = dynamicCommandMap[commandWithoutPrefix];
    if (categoryForDynamicCmd) {
        await handleDynamicGenCommand(message, categoryForDynamicCmd);
        return;
    }

    // --- Static Command Handling ---
    if (cmd === '+vouch') {
        const user = message.mentions.users.first();
        const reason = args.slice(2).join(' ');
        if (!user || !reason) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `+vouch @user <reason>`');
            return message.channel.send({ embeds: [embed] });
        }

        const vouches = loadVouches();
        const id = user.id;

        if (!vouches[id]) {
            vouches[id] = { positiveCount: 0, negativeCount: 0, reasons: [], lastVouched: null };
        }

        vouches[id].positiveCount++;
        vouches[id].reasons.push({
            by: message.author.tag,
            type: 'positive',
            reason,
            date: new Date().toLocaleString(),
        });
        vouches[id].lastVouched = new Date().toLocaleString();

        saveVouches(vouches);
        embed.setTitle('Vouch Added! ✅')
             .setDescription(`Successfully added a positive vouch for **${user.tag}**.`)
             .addFields({ name: 'Reason', value: `"${reason}"` });
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '-vouch') {
        const user = message.mentions.users.first();
        const reason = args.slice(2).join(' ');
        if (!user || !reason) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `-vouch @user <reason>`');
            return message.channel.send({ embeds: [embed] });
        }

        const vouches = loadVouches();
        const id = user.id;

        if (!vouches[id]) {
            vouches[id] = { positiveCount: 0, negativeCount: 0, reasons: [], lastVouched: null };
        }
        
        vouches[id].negativeCount++;
        vouches[id].reasons.push({
            by: message.author.tag,
            type: 'negative',
            reason: reason,
            date: new Date().toLocaleString(),
        });
        vouches[id].lastVouched = new Date().toLocaleString();

        saveVouches(vouches);
        embed.setTitle('Negative Review Added! ❌')
             .setDescription(`A negative review has been added for **${user.tag}**.`)
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

        const positiveReasons = data.reasons.filter(r => r.type === 'positive');
        const negativeReasons = data.reasons.filter(r => r.type === 'negative');

        if (positiveReasons.length > 0) {
            embed.addFields({
                name: 'Recent Positive Reviews',
                value: positiveReasons
                    .slice(-3)
                    .reverse()
                    .map((r, i) => `**${positiveReasons.length - i}.** By: ${r.by}\nReason: *"${r.reason}"*\nDate: (${r.date})`)
                    .join('\n\n') || 'No recent positive reviews.',
                inline: false
            });
        }

        if (negativeReasons.length > 0) {
            embed.addFields({
                name: 'Recent Negative Reviews',
                value: negativeReasons
                    .slice(-3)
                    .reverse()
                    .map((r, i) => `**${negativeReasons.length - i}.** By: ${r.by}\nReason: *"${r.reason}"*\nDate: (${r.date})`)
                    .join('\n\n') || 'No recent negative reviews.',
                inline: false
            });
        }
        
        if (positiveReasons.length === 0 && negativeReasons.length === 0) {
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
        delete channelRestrictions[`${category[0]}gen`]; // Remove associated channel restriction (NEW)
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

    // NEW: =restrict command
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

    // NEW: =unrestrict command
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
        if (!message.member.permissions.has('ManageGuild')) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
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

    if (cmd === '=redeem') {
        const code = args[1]?.toUpperCase();
        if (!code) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=redeem <hex_code_or_stock_name>`');
            return message.channel.send({ embeds: [embed] });
        }

        if (generatedCodes[code]) {
            const codeData = generatedCodes[code];
            if (codeData.redeemed) {
                embed.setTitle('Code Already Redeemed ⚠️')
                     .setDescription(`The code \`${code}\` has already been redeemed.`);
                return message.channel.send({ embeds: [embed] });
            }
            codeData.redeemed = true;

            embed.setTitle('Code Redeemed! ✅')
                 .setDescription(`You have successfully redeemed code: \`${code}\`\n\nThis code was generated for a **${codeData.category.toUpperCase()}** item: \`${codeData.stockName}\`.`)
                 .addFields(
                     { name: 'Generated By', value: `<@${codeData.generatedBy}>`, inline: true },
                     { name: 'Generated On', value: new Date(codeData.timestamp).toLocaleString(), inline: true }
                 )
                 .setFooter({ text: 'This code is now invalid.' });
            return message.channel.send({ embeds: [embed] });
        }

        if (!isAuthorized(message.author.id)) {
            embed.setTitle('Authorization Required 🚫')
                 .setDescription('You are not authorized to manually redeem general stock names.\n\nTo redeem a generated item, please use `=redeem <hex_code>`.');
            return message.channel.send({ embeds: [embed] });
        }

        if (redeemed[code]) {
            embed.setTitle('Stock Name Already Manually Redeemed ❌')
                 .setDescription(`The stock name \`${code}\` has already been manually redeemed by <@${redeemed[code]}>.`);
            return message.channel.send({ embeds: [embed] });
        }

        redeemed[code] = message.author.id;
        saveData();
        embed.setTitle('Stock Name Manually Redeemed! ✅')
             .setDescription(`The stock name \`${code}\` has been successfully marked as redeemed by ${message.author.tag}.`);
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '=pls') {
        embed.setTitle('Cheers for our staff! 🎉')
             .setDescription(`Show appreciation with \`+vouch @user\` in <#${VOUCH_CHANNEL_ID}>.\nNot happy? Use \`-vouch @user <reason>\`.`)
             .setColor(0xffa500);
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

            await message.author.send({
                content: 'Here are your backup files:',
                files: [vouchesAttachment, stockAttachment]
            });
            embed.setTitle('Backup Sent! ✅')
                 .setDescription('Your `vouches.json` and `stock.json` files have been sent to your DMs.');
            return message.channel.send({ embeds: [embed] });
        } catch (dmError) {
            console.error(`Could not DM user ${message.author.tag} for backup:`, dmError);
            embed.setTitle('Backup Failed ❌')
                 .setDescription('Could not send backup files to your DMs. Please ensure your DMs are open.');
            return message.channel.send({ embeds: [embed] });
        }
    }

    if (cmd === '=restvouch') {
        if (!isAuthorized(message.author.id)) {
            embed.setTitle('Authorization Required 🚫')
                 .setDescription('You need to be an authorized user to use this command.');
            return message.channel.send({ embeds: [embed] });
        }

        const attachment = message.attachments.first();
        if (!attachment || !attachment.name.endsWith('.json')) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Please attach a `.json` file to restore vouches. Usage: `=restvouch {attach vouches.json}`');
            return message.channel.send({ embeds: [embed] });
        }

        if (attachment.size > 1024 * 1024 * 5) {
            embed.setTitle('File Too Large ❌')
                 .setDescription('The attached file is too large. Max 5MB.');
            return message.channel.send({ embeds: [embed] });
        }

        try {
            const response = await fetch(attachment.url);
            const text = await response.text();
            const newVouchesData = JSON.parse(text);

            if (typeof newVouchesData !== 'object' || newVouchesData === null) {
                throw new Error('Invalid JSON structure. Expected an object.');
            }

            saveVouches(newVouchesData);
            embed.setTitle('Vouches Restored! ✅')
                 .setDescription('`vouches.json` has been successfully restored from the attached file.');
            return message.channel.send({ embeds: [embed] });
        } catch (error) {
            console.error('Error restoring vouches:', error);
            embed.setTitle('Restore Failed ❌')
                 .setDescription(`Failed to restore vouches. Make sure the attached file is a valid JSON. Error: \`${error.message}\``);
            return message.channel.send({ embeds: [embed] });
        }
    }

    if (cmd === '=reststock') {
        if (!isAuthorized(message.author.id)) {
            embed.setTitle('Authorization Required 🚫')
                 .setDescription('You need to be an authorized user to use this command.');
            return message.channel.send({ embeds: [embed] });
        }

        const attachment = message.attachments.first();
        if (!attachment || !attachment.name.endsWith('.json')) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Please attach a `.json` file to restore stock. Usage: `=reststock {attach stock.json}`');
            return message.channel.send({ embeds: [embed] });
        }

        if (attachment.size > 1024 * 1024 * 5) {
            embed.setTitle('File Too Large ❌')
                 .setDescription('The attached file is too large. Max 5MB.');
            return message.channel.send({ embeds: [embed] });
        }

        try {
            const response = await fetch(attachment.url);
            const text = await response.text();
            const newStockData = JSON.parse(text);

            if (typeof newStockData !== 'object' || newStockData === null) {
                throw new Error('Invalid JSON structure. Expected an object.');
            }
            for (const key in newStockData) {
                if (!Array.isArray(newStockData[key])) {
                    throw new Error(`Category "${key}" does not contain an array. Invalid stock format.`);
                }
            }

            stock = newStockData;
            saveData();

            updateDynamicCommandMap(); // Update map after restoring stock

            embed.setTitle('Stock Restored! ✅')
                 .setDescription('`stock.json` has been successfully restored from the attached file. Dynamic commands have been reloaded.');
            return message.channel.send({ embeds: [embed] });
        } catch (error) {
            console.error('Error restoring stock:', error);
            embed.setTitle('Restore Failed ❌')
                 .setDescription(`Failed to restore stock. Make sure the attached file is a valid JSON with correct structure. Error: \`${error.message}\``);
            return message.channel.send({ embeds: [embed] });
        }
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
        const channelRestrictionsStr = JSON.stringify(channelRestrictions, null, 2); // NEW debug data

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
        debugEmbed.addFields(...splitStringForEmbed(channelRestrictionsStr, 'Channel Restrictions')); // NEW debug field

        return message.channel.send({ embeds: [debugEmbed] });
    }
}

// Attach the main message handler to the client
client.on('messageCreate', handleMessage);

// === Login ===
client.login(TOKEN);

// === Keepalive Server ===
const app = express();
app.get('/', (req, res) => res.send('Bot is running.'));
app.listen(3000, () => console.log('Express server listening on port 3000'));
