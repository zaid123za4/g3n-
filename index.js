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
const AUTHORIZED_USERS = ['1110864648787480656', '1212961835582623755', '1333798275601662056']; // Example IDs
const CSEND_REQUIRED_ROLE_ID = '1374250200511680656'; // Example Role ID for =csend command
const VOUCH_CHANNEL_ID = '1374018342444204067'; // <--- IMPORTANT: SET YOUR VOUCH CHANNEL ID HERE

const DATA_DIR = './data';
const COOKIE_DIR = './cookies';
const VOUCH_PATH = './vouches.json';

// === Ensure directories exist ===
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(COOKIE_DIR)) fs.mkdirSync(COOKIE_DIR);
// Check if vouches.json exists, if not, create it with an empty object
if (!fs.existsSync(VOUCH_PATH)) {
    console.log('vouches.json not found, creating new one.');
    fs.writeFileSync(VOUCH_PATH, JSON.stringify({}));
}

// === Global data stores ===
let rolesAllowed = {}; // { commandName: roleId }
let stock = {};       // { category: [item1, item2, ...] }
let redeemed = {};    // { stockName: userId } (for manually redeemed stock names)

// Stores generated unique codes: { hexCode: { redeemed: boolean, category: string, stockName: string, generatedBy: string, timestamp: string } }
const generatedCodes = {}; // In-memory for current session

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
// Main data (stock, redeemed, rolesAllowed)
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

// === Initialize data on startup ===
loadData();
updateFileStock();

// === Client Setup ===
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages, // Needed for sending DMs
    ],
    partials: [Partials.Channel, Partials.Message], // Ensure DMs work correctly
});

client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
});

// === Dynamic commands map for stock gen commands (e.g., =fgen, =pgen) ===
const dynamicCommands = new Set();

function generateHexCode() {
    return Math.random().toString(16).substring(2, 8).toUpperCase();
}

// Function to create stock generation commands dynamically
function createDynamicCommand(category) {
    const commandName = `${category[0]}gen`; // e.g., 'fgen' for 'free'
    if (dynamicCommands.has(commandName)) return; // Avoid duplicates

    dynamicCommands.add(commandName);

    client.on('messageCreate', async (msg) => {
        if (msg.author.bot) return;
        const args = msg.content.trim().split(/\s+/);
        if (args[0]?.toLowerCase() !== `=${commandName}`) return;

        const embed = new EmbedBuilder().setColor(0x3498db); // Blue color

        // Check role permission
        const requiredRoleId = rolesAllowed[commandName];
        if (requiredRoleId && !msg.member.roles.cache.has(requiredRoleId)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You do not have the required role to use this command.');
            return msg.reply({ embeds: [embed] });
        }

        if (!stock[category] || stock[category].length === 0) {
            embed.setTitle('Stock Empty ❌')
                 .setDescription(`The **${category}** stock is currently empty. Please try again later.`);
            return msg.reply({ embeds: [embed] });
        }

        let stockItem;
        const requestedStockName = args.slice(1).join(' '); // Get everything after the command as the requested stock name

        if (requestedStockName) { // User provided a specific stock name
            const foundItemIndex = stock[category].findIndex(item => item.toLowerCase() === requestedStockName.toLowerCase());
            if (foundItemIndex !== -1) {
                stockItem = stock[category][foundItemIndex];
                // Remove the item from stock once it's "selected" for generation
                stock[category].splice(foundItemIndex, 1);
                saveData(); // Save changes to stock
            } else {
                embed.setTitle('Invalid Stock ❌')
                     .setDescription(`The stock item \`${requestedStockName}\` was not found in the **${category}** category.`);
                return msg.reply({ embeds: [embed] });
            }
        } else { // User did not provide a specific stock name, pick a random one
            const randomIndex = Math.floor(Math.random() * stock[category].length);
            stockItem = stock[category][randomIndex];
            // Remove the item from stock once it's "selected" for generation
            stock[category].splice(randomIndex, 1);
            saveData(); // Save changes to stock
        }

        // If no stock item was found (e.g., if stock became empty after previous checks)
        if (!stockItem) {
             embed.setTitle('Stock Empty ❌')
                 .setDescription(`The **${category}** stock is currently empty after an attempt to retrieve an item.`);
             return msg.reply({ embeds: [embed] });
        }

        // Generate a unique hex code for this specific stock item
        let hexCode;
        do {
            hexCode = generateHexCode();
        } while (generatedCodes[hexCode]); // Ensure uniqueness

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
                        .setColor(0x2ecc71) // Green
                        .setTitle('✨ Your Generated Stock Code!')
                        .setDescription(`Here is your unique code for a **${category}** item: \`${hexCode}\`\n\n**Item:** \`${stockItem}\`\n\nTo view details about this item, use: \`=redeem ${hexCode}\``)
                        .setFooter({ text: `Generated by ${client.user.tag}` })
                        .setTimestamp()
                ]
            });
            embed.setTitle('Code Sent! ✅')
                 .setDescription(`A unique code for the **${stockItem}** item has been successfully sent to your DMs.`);
            return msg.reply({ embeds: [embed] });
        } catch (dmError) {
            console.error(`Could not DM user ${msg.author.tag}:`, dmError);
            embed.setTitle('DM Failed ⚠️')
                 .setDescription(`I could not send you the code in DMs. Please ensure your DMs are open for this server.\n\nYour code (for debugging): \`${hexCode}\`\n**Item:** \`${stockItem}\``) // Include code in public reply if DM fails
                 .setColor(0xe67e22); // Orange
            return msg.reply({ embeds: [embed] });
        }
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
    const embed = new EmbedBuilder().setColor(0x3498db); // Default embed color

    // ----- Vouch commands (UPDATED) -----
    if (cmd === '+vouch') {
        const user = message.mentions.users.first();
        const reason = args.slice(2).join(' ');
        if (!user || !reason) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `+vouch @user <reason>`');
            return message.reply({ embeds: [embed] });
        }

        const vouches = loadVouches();
        const id = user.id;

        if (!vouches[id]) {
            // Initialize with both positive and negative counts
            vouches[id] = { positiveCount: 0, negativeCount: 0, reasons: [], lastVouched: null };
        }

        vouches[id].positiveCount++; // Increment positive vouch count
        vouches[id].reasons.push({
            by: message.author.tag,
            type: 'positive', // Explicitly mark as positive
            reason,
            date: new Date().toLocaleString(),
        });
        vouches[id].lastVouched = new Date().toLocaleString();

        saveVouches(vouches);
        embed.setTitle('Vouch Added! ✅')
             .setDescription(`Successfully added a positive vouch for **${user.tag}**.`) // Updated description
             .addFields({ name: 'Reason', value: `"${reason}"` });
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '-vouch') {
        const user = message.mentions.users.first();
        const reason = args.slice(2).join(' ');
        if (!user || !reason) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `-vouch @user <reason>`');
            return message.reply({ embeds: [embed] });
        }

        const vouches = loadVouches();
        const id = user.id;

        if (!vouches[id]) {
             // Initialize if not exists
            vouches[id] = { positiveCount: 0, negativeCount: 0, reasons: [], lastVouched: null };
        }
        
        vouches[id].negativeCount++; // Increment negative vouch count
        vouches[id].reasons.push({
            by: message.author.tag,
            type: 'negative', // Explicitly mark as negative
            reason: reason, // The reason is the negative feedback
            date: new Date().toLocaleString(),
        });
        vouches[id].lastVouched = new Date().toLocaleString();

        saveVouches(vouches);
        embed.setTitle('Negative Review Added! ❌') // Updated title
             .setDescription(`A negative review has been added for **${user.tag}**.`) // Updated description
             .addFields({ name: 'Reason', value: `"${reason}"` });
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '=profile') {
        const user = message.mentions.users.first() || message.author;
        const vouches = loadVouches();
        const data = vouches[user.id];

        if (!data) {
            embed.setTitle('Profile Not Found ℹ️')
                 .setDescription(`${user.tag} has not received any vouches or reviews yet.`); // Updated description
            return message.reply({ embeds: [embed] });
        }

        embed.setColor(0x2ecc71) // Green color
             .setTitle(`${user.tag}'s Vouch & Review Profile`) // Updated title
             .setThumbnail(user.displayAvatarURL())
             .addFields(
                 { name: '✅ Positive Reviews', value: `${data.positiveCount || 0}`, inline: true }, // Display positive count
                 { name: '❌ Negative Reviews', value: `${data.negativeCount || 0}`, inline: true }, // Display negative count
                 { name: 'Last Reviewed On', value: `${data.lastVouched || 'N/A'}`, inline: false } // Changed from Last Vouched On to Last Reviewed On
             );

        // Filter and display recent reasons, categorizing by type
        const positiveReasons = data.reasons.filter(r => r.type === 'positive');
        const negativeReasons = data.reasons.filter(r => r.type === 'negative');

        if (positiveReasons.length > 0) {
            embed.addFields({
                name: 'Recent Positive Reviews',
                value: positiveReasons
                    .slice(-3) // Get last 3 positive reasons
                    .reverse() // Show most recent first
                    .map((r, i) => `**${positiveReasons.length - i}.** By: ${r.by}\nReason: *"${r.reason}"*\nDate: (${r.date})`)
                    .join('\n\n') || 'No recent positive reviews.',
                inline: false
            });
        }

        if (negativeReasons.length > 0) {
            embed.addFields({
                name: 'Recent Negative Reviews',
                value: negativeReasons
                    .slice(-3) // Get last 3 negative reasons
                    .reverse() // Show most recent first
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

    // ----- Stock Management commands ----- (No changes here, keeping them for context)
    if (cmd === '=addcategory') {
        if (!message.member.permissions.has('ManageGuild')) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.reply({ embeds: [embed] });
        }
        const name = args[1]?.toLowerCase();
        if (!name) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Please provide a category name. Usage: `=addcategory <name>`');
            return message.reply({ embeds: [embed] });
        }
        if (stock[name]) {
            embed.setTitle('Category Exists ⚠️')
                 .setDescription(`Category \`${name}\` already exists.`);
            return message.reply({ embeds: [embed] });
        }
        stock[name] = [];
        createDynamicCommand(name); // Ensure dynamic command is created for new category
        saveData();
        embed.setTitle('Category Created! ✅')
             .setDescription(`Category \`${name}\` has been created.`)
             .addFields({ name: 'Generated Command', value: `\`=${name[0]}gen\` is now active for this category.` });
        return message.reply({ embeds: [embed] });
    }

    // NEW =categoryremove
    if (cmd === '=categoryremove') {
        if (!message.member.permissions.has('ManageGuild')) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.reply({ embeds: [embed] });
        }

        const category = args[1]?.toLowerCase();
        if (!category) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=categoryremove <category>`');
            return message.reply({ embeds: [embed] });
        }

        if (!stock[category]) {
            embed.setTitle('Category Not Found ❌')
                 .setDescription(`The category \`${category}\` does not exist.`);
            return message.reply({ embeds: [embed] });
        }

        delete stock[category];
        saveData();

        const dynCmd = `${category[0]}gen`;
        dynamicCommands.delete(dynCmd);
        delete rolesAllowed[dynCmd];
        saveData();

        embed.setTitle('Category Removed! ✅')
             .setDescription(`Category \`${category}\` and dynamic command \`=${dynCmd}\` have been removed.`);
        return message.reply({ embeds: [embed] });
    }

    if (cmd === '=addstock') {
        if (!message.member.permissions.has('ManageGuild')) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.reply({ embeds: [embed] });
        }
        const category = args[1]?.toLowerCase();
        const stockItem = args.slice(2).join(' ');
        if (!category || !stockItem) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=addstock <category> <stock_name>`');
            return message.reply({ embeds: [embed] });
        }
        if (!stock[category]) {
            embed.setTitle('Category Not Found ❌')
                 .setDescription(`Category \`${category}\` does not exist. Use \`=addcategory\` first.`);
            return message.reply({ embeds: [embed] });
        }
        stock[category].push(stockItem);
        saveData();
        embed.setTitle('Stock Added! ✅')
             .setDescription(`Stock item \`${stockItem}\` has been added to the **${category}** category.`);
        return message.reply({ embeds: [embed] });
    }

    if (cmd === '=removestock') {
        if (!message.member.permissions.has('ManageGuild')) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.reply({ embeds: [embed] });
        }
        const category = args[1]?.toLowerCase();
        const stockName = args.slice(2).join(' ');
        if (!category || !stockName) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=removestock <category> <stock_name>`');
            return message.reply({ embeds: [embed] });
        }
        if (!stock[category]) {
            embed.setTitle('Category Not Found ❌')
                 .setDescription(`Category \`${category}\` does not exist.`);
            return message.reply({ embeds: [embed] });
        }

        const initialLength = stock[category].length;
        stock[category] = stock[category].filter(item => item.toLowerCase() !== stockName.toLowerCase());

        if (stock[category].length < initialLength) {
            saveData();
            embed.setTitle('Stock Removed! ✅')
                 .setDescription(`Removed all instances of \`${stockName}\` from **${category}** stock.`);
            return message.reply({ embeds: [embed] });
        } else {
            embed.setTitle('Stock Not Found ❌')
                 .setDescription(`Stock item \`${stockName}\` not found in **${category}** category.`);
            return message.reply({ embeds: [embed] });
        }
    }

    if (cmd === '=add') {
        if (!message.member.permissions.has('ManageGuild')) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.reply({ embeds: [embed] });
        }
        const commandToRestrict = args[1]?.toLowerCase();
        const role = message.mentions.roles.first();

        if (!commandToRestrict || !role) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=add <command_name_without_=> @role`');
            return message.reply({ embeds: [embed] });
        }

        // Validate if it's a known command that can be restricted
        if (!dynamicCommands.has(commandToRestrict) && commandToRestrict !== 'csend' && commandToRestrict !== 'addcategory' && commandToRestrict !== 'addstock' && commandToRestrict !== 'removestock' && commandToRestrict !== 'categoryremove' && commandToRestrict !== 'add' && commandToRestrict !== 'remove' && commandToRestrict !== 'upload' && commandToRestrict !== 'pls') {
            embed.setTitle('Invalid Command ⚠️')
                 .setDescription(`Command \`=${commandToRestrict}\` is not a recognized command that can be restricted. Dynamic commands (like \`fgen\`, \`agen\`), \`csend\`, \`addcategory\`, \`addstock\`, \`removestock\`, \`categoryremove\`, \`add\`, \`remove\`, \`upload\`, and \`pls\` can be restricted.`);
            return message.reply({ embeds: [embed] });
        }

        rolesAllowed[commandToRestrict] = role.id;
        saveData();
        embed.setTitle('Permission Granted! ✅')
             .setDescription(`The role **${role.name}** can now use the command \`=${commandToRestrict}\`.`);
        return message.reply({ embeds: [embed] });
    }

    if (cmd === '=remove') {
        if (!message.member.permissions.has('ManageGuild')) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.reply({ embeds: [embed] });
        }
        const commandToRemoveRestriction = args[1]?.toLowerCase();
        if (!commandToRemoveRestriction) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=remove <command_name_without_=>`');
            return message.reply({ embeds: [embed] });
        }

        if (rolesAllowed[commandToRemoveRestriction]) {
            delete rolesAllowed[commandToRemoveRestriction];
            saveData();
            embed.setTitle('Permission Removed! ✅')
                 .setDescription(`Role restriction for command \`=${commandToRemoveRestriction}\` has been removed.`);
            return message.reply({ embeds: [embed] });
        } else {
            embed.setTitle('No Restriction Found ℹ️')
                 .setDescription(`The command \`=${commandToRemoveRestriction}\` does not have a role restriction set.`);
            return message.reply({ embeds: [embed] });
        }
    }

    // === =stock command - NOW WITH IMAGE-LIKE FORMATTING ===
    if (cmd === '=stock') {
        const allCategories = Object.keys(stock);
        if (allCategories.length === 0) {
            embed.setTitle('No Stock 📦')
                 .setDescription('No stock categories have been added yet.')
                 .setColor(0x0099ff);
            return message.reply({ embeds: [embed] });
        }

        // Handle specific category request
        const cat = args[1]?.toLowerCase();
        if (cat) {
            if (stock[cat]) {
                const categoryItems = stock[cat];
                embed.setTitle(`📦 Stock for **${cat.toUpperCase()}** (${categoryItems.length} items)`)
                     .setDescription(categoryItems.length > 0 ? categoryItems.map(item => `\`${item}\``).join(', ') : 'This category is empty.')
                     .setColor(0x0099ff);
                return message.reply({ embeds: [embed] });
            } else {
                embed.setTitle('Category Not Found ❌')
                     .setDescription(`The category \`${cat}\` does not exist.`)
                     .setColor(0xe74c3c);
                return message.reply({ embeds: [embed] });
            }
        }

        // Default: display all stock categories like the image
        const replyEmbed = new EmbedBuilder()
            .setTitle('📦 Current Stock Overview')
            .setColor(0x2c3e50); // Darker color for the overall stock embed

        // Sort categories alphabetically for consistent display
        const sortedCategories = allCategories.sort();

        // Dynamically add fields for each stock category
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
            return message.reply({ embeds: [embed] });
        }

        const replyEmbeds = [];
        let currentEmbed = new EmbedBuilder()
            .setTitle('📦 All Stock Details')
            .setColor(0x0099ff);
        let fieldCounter = 0; // To keep track of fields per embed

        // Sort categories alphabetically for consistent display
        const sortedCategories = allCategories.sort();

        for (const cat of sortedCategories) {
            const items = stock[cat];
            const content = items.length > 0 ? items.map(item => `\`${item}\``).join(', ') : '*Empty*';

            // Split content if too long for a single field
            if (content.length > 1000) {
                const parts = content.match(/[\s\S]{1,1000}/g) || [];
                for (let i = 0; i < parts.length; i++) {
                    currentEmbed.addFields({
                        name: i === 0 ? `${cat.toUpperCase()} (${items.length} items)` : '\u200b', // Use zero-width space for subsequent parts
                        value: parts[i],
                        inline: false
                    });
                    fieldCounter++;
                    if (fieldCounter >= 24) { // Max 25 fields, leave one for title/description if needed
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
        replyEmbeds.push(currentEmbed); // Add the last embed

        for (const finalEmbed of replyEmbeds) {
            await message.channel.send({ embeds: [finalEmbed] });
        }
        return;
    }

    if (cmd === '=cstock') {
        updateFileStock(); // Ensure latest file stock is loaded
        embed.setTitle('🍪 Cookie Stock Overview')
             .setColor(0xf1c40f); // Yellow color

        const cookieCategories = Object.keys(fileStock);
        if (cookieCategories.length === 0) {
            embed.setDescription('No cookie categories found. Upload a ZIP file to create one!');
            return message.reply({ embeds: [embed] });
        }

        // Sort categories alphabetically for consistent display
        const sortedCookieCategories = cookieCategories.sort();

        for (const category of sortedCookieCategories) {
            const fileCount = fileStock[category].length;
            embed.addFields({ name: category.toUpperCase(), value: `${fileCount} files`, inline: true });
        }
        return message.reply({ embeds: [embed] });
    }

    // Updated =upload command logic (Fixed for multiple files in ZIP)
    if (cmd === '=upload') {
        if (!message.member.permissions.has('ManageGuild')) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.reply({ embeds: [embed] });
        }

        const category = args[1]?.toLowerCase();
        if (!category) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=upload <cookie_category>` with a ZIP file.');
            return message.reply({ embeds: [embed] });
        }

        if (!message.attachments.size) {
            embed.setTitle('Missing Attachment ❌')
                 .setDescription('Please attach a ZIP file to upload.');
            return message.reply({ embeds: [embed] });
        }

        const attachment = message.attachments.first();
        if (!attachment.name.endsWith('.zip')) {
            embed.setTitle('Invalid File Type ❌')
                 .setDescription('Only ZIP files are allowed.');
            return message.reply({ embeds: [embed] });
        }

        const zipPath = path.join('./', `upload_${Date.now()}.zip`);
        embed.setTitle('Processing Upload... ⏳')
             .setDescription(`Uploading ZIP to \`${category}\`...`)
             .setColor(0x9b59b6);
        const statusMsg = await message.reply({ embeds: [embed] });

        try {
            const res = await fetch(attachment.url);
            const buffer = await res.buffer();
            fs.writeFileSync(zipPath, buffer);

            const zip = new AdmZip(zipPath);
            const extractPath = path.join(COOKIE_DIR, category);
            if (!fs.existsSync(extractPath)) fs.mkdirSync(extractPath, { recursive: true });

            // Iterate through each entry in the zip and extract it directly into the category folder, flattening structure
            for (const zipEntry of zip.getEntries()) {
                if (!zipEntry.isDirectory) {
                    zip.extractEntryTo(zipEntry.entryName, extractPath, false, true); // maintainEntryPath: false, overwrite: true
                }
            }
            fs.unlinkSync(zipPath);

            updateFileStock(); // Refresh file stock after extraction

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

    // Updated =csend command logic
    if (cmd === '=csend') {
        if (!message.member.permissions.has('ManageGuild')) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.reply({ embeds: [embed] });
        }

        const category = args[1]?.toLowerCase();
        const user = message.mentions.users.first();
        if (!category || !user) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=csend <cookie_category> @user`');
            return message.reply({ embeds: [embed] });
        }

        const categoryPath = path.join(COOKIE_DIR, category);
        if (!fs.existsSync(categoryPath) || fs.readdirSync(categoryPath).length === 0) {
            embed.setTitle('No Files ❌')
                 .setDescription(`No files found in category \`${category}\`.`);
            return message.reply({ embeds: [embed] });
        }

        const files = fs.readdirSync(categoryPath);
        const fileToSend = files[0]; // Sends the first file found in the category
        const filePath = path.join(categoryPath, fileToSend);

        try {
            const attachment = new AttachmentBuilder(filePath);
            await user.send({
                content: `Here is a cookie file from \`${category}\` sent by ${message.author.tag}:`,
                files: [attachment]
            });

            fs.unlinkSync(filePath); // Delete file after sending
            if (fs.readdirSync(categoryPath).length === 0) { // If folder becomes empty, remove it
                fs.rmdirSync(categoryPath);
            }
            updateFileStock(); // Update file stock after deleting

            embed.setTitle('Cookie Sent! ✅')
                 .setDescription(`\`${fileToSend}\` has been sent to ${user.tag} and removed from storage.`);
            return message.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Error sending file:', error);
            embed.setTitle('Error Sending File ❌')
                 .setDescription(`An error occurred while sending the cookie file for **${user.tag}**. Please ensure their DMs are open.`);
            return message.reply({ embeds: [embed] });
        }
    }

    if (cmd === '=cstock') {
        updateFileStock(); // Ensure latest file stock is loaded
        embed.setTitle('🍪 Cookie Stock Overview')
             .setColor(0xf1c40f);

        const cookieCategories = Object.keys(fileStock);
        if (cookieCategories.length === 0) {
            embed.setDescription('No cookie categories found. Upload a ZIP file to create one!');
            return message.reply({ embeds: [embed] });
        }

        const sortedCookieCategories = cookieCategories.sort();
        for (const category of sortedCookieCategories) {
            const fileCount = fileStock[category].length;
            embed.addFields({ name: category.toUpperCase(), value: `${fileCount} files`, inline: true });
        }
        return message.reply({ embeds: [embed] });
    }

    // === REDEEM COMMAND (Hex Code or Manual Stock Name) ===
    if (cmd === '=redeem') {
        const code = args[1]?.toUpperCase();
        if (!code) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=redeem <hex_code_or_stock_name>`');
            return message.reply({ embeds: [embed] });
        }

        // --- First, check generated hex codes (for user redemption) ---
        if (generatedCodes[code]) {
            const codeData = generatedCodes[code];
            if (codeData.redeemed) {
                embed.setTitle('Code Already Redeemed ⚠️')
                     .setDescription(`The code \`${code}\` has already been redeemed.`);
                return message.reply({ embeds: [embed] });
            }
            // Mark code as redeemed
            codeData.redeemed = true;

            embed.setTitle('Code Redeemed! ✅')
                 .setDescription(`You have successfully redeemed code: \`${code}\`\n\nThis code was generated for a **${codeData.category.toUpperCase()}** item: \`${codeData.stockName}\`.`)
                 .addFields(
                     { name: 'Generated By', value: `<@${codeData.generatedBy}>`, inline: true },
                     { name: 'Generated On', value: new Date(codeData.timestamp).toLocaleString(), inline: true }
                 )
                 .setFooter({ text: 'This code is now invalid.' });
            return message.reply({ embeds: [embed] });
        }

        // --- If not a generated hex code, fallback to manual stock name redemption (admin use) ---
        if (!AUTHORIZED_USERS.includes(message.author.id)) {
            embed.setTitle('Authorization Required 🚫')
                 .setDescription('You are not authorized to manually redeem general stock names.\n\nTo redeem a generated item, please use `=redeem <hex_code>`.');
            return message.reply({ embeds: [embed] });
        }

        if (redeemed[code]) {
            embed.setTitle('Stock Name Already Manually Redeemed ❌')
                 .setDescription(`The stock name \`${code}\` has already been manually redeemed by <@${redeemed[code]}>.`);
            return message.reply({ embeds: [embed] });
        }

        redeemed[code] = message.author.id;
        saveData();
        embed.setTitle('Stock Name Manually Redeemed! ✅')
             .setDescription(`The stock name \`${code}\` has been successfully marked as redeemed by ${message.author.tag}.`);
        return message.reply({ embeds: [embed] });
    }

    // === =pls command - A FRIENDLY VOUCH REMINDER ===
    if (cmd === '=pls') {
        embed.setTitle('Cheers for our staff! 🎉')
             .setDescription(`Show appreciation with \`+vouch @user\` in <#${VOUCH_CHANNEL_ID}>.\nNot happy? Use \`-vouch @user <reason>\`.`)
             .setColor(0xffa500);
        return message.channel.send({ embeds: [embed] });
    }

    // === =debug command ===
    if (cmd === '=debug') {
        if (message.author.id !== OWNER_ID) {
            embed.setTitle('Owner Only Command 🚫')
                 .setDescription('This command can only be used by the bot owner.');
            return message.reply({ embeds: [embed] });
        }
        const debugEmbed = new EmbedBuilder()
            .setTitle('Bot Debug Information')
            .setColor(0x8e44ad)
            .setDescription('Current internal state of the bot data. (Truncated for Discord character limits)');

        // Prepare fields, ensuring they don't exceed Discord's limits
        const rolesAllowedStr = JSON.stringify(rolesAllowed, null, 2);
        const stockStr = JSON.stringify(stock, null, 2);
        const redeemedStr = JSON.stringify(redeemed, null, 2);
        const generatedCodesStr = JSON.stringify(generatedCodes, null, 2);
        const fileStockStr = JSON.stringify(fileStock, null, 2);

        // Function to split large strings for embed fields
        const splitStringForEmbed = (str, fieldName) => {
            const maxLen = 1000; // A bit less than 1024 for safety
            const parts = [];
            for (let i = 0; i < str.length; i += maxLen) {
                parts.push(str.substring(i, Math.min(i + maxLen, str.length)));
            }
            return parts.map((part, index) => ({
                name: index === 0 ? fieldName : '\u200b', // Use zero-width space for subsequent parts
                value: `\`\`\`json\n${part}\n\`\`\``,
                inline: false
            }));
        };

        debugEmbed.addFields(...splitStringForEmbed(rolesAllowedStr, 'Roles Allowed'));
        debugEmbed.addFields(...splitStringForEmbed(stockStr, 'Stock Data'));
        debugEmbed.addFields(...splitStringForEmbed(redeemedStr, 'Manually Redeemed'));
        debugEmbed.addFields(...splitStringForEmbed(generatedCodesStr, 'Generated Codes (in-memory)'));
        debugEmbed.addFields(...splitStringForEmbed(fileStockStr, 'File Stock'));

        return message.channel.send({ embeds: [debugEmbed] });
    }
});

// === Login ===
client.login(TOKEN);

// === Keepalive Server ===
const app = express();
app.get('/', (req, res) => res.send('Bot is running.'));
app.listen(3000, () => console.log('Express server listening on port 3000'));
