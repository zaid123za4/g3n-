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
const CSEND_REQUIRED_ROLE_ID = '1374250200511680582'; // Example Role ID for =csend command
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

        // Pick a random item from the stock
        const randomIndex = Math.floor(Math.random() * stock[category].length);
        const stockItem = stock[category][randomIndex];

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
                        .setDescription(`Here is your unique code for a **${category}** item: \`${hexCode}\`\n\nTo view details about this item, use: \`=redeem ${hexCode}\``)
                        .setFooter({ text: `Generated by ${client.user.tag}` })
                        .setTimestamp()
                ]
            });
            embed.setTitle('Code Sent! ✅')
                 .setDescription(`A unique code for a **${category}** item has been successfully sent to your DMs.`);
            return msg.reply({ embeds: [embed] });
        } catch (dmError) {
            console.error(`Could not DM user ${msg.author.tag}:`, dmError);
            embed.setTitle('DM Failed ⚠️')
                 .setDescription(`I could not send you the code in DMs. Please ensure your DMs are open for this server.\n\nYour code (for debugging): \`${hexCode}\``)
                 .setColor(0xe67e22); // Orange
            return msg.reply({ embeds: [embed] });
        }
    });
}
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const args = message.content.trim().split(/\s+/);
    const cmd = args[0].toLowerCase();
    const embed = new EmbedBuilder().setColor(0x3498db); // Default embed color

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

    // ✅ NEW =categoryremove
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
    // ✅ =upload <cookie_category> — global file ZIP support
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
            zip.extractAllTo(extractPath, true);
            fs.unlinkSync(zipPath);

            updateFileStock();

            embed.setTitle('Upload Successful! ✅')
                 .setDescription(`Files uploaded to \`${category}\`. Reflected in \`=cstock\`.`);
            return statusMsg.edit({ embeds: [embed] });
        } catch (err) {
            console.error('Upload error:', err);
            if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
            embed.setTitle('Upload Failed ❌')
                 .setDescription(`Error: \`${err.message}\``)
                 .setColor(0xe74c3c);
            return statusMsg.edit({ embeds: [embed] });
        }
    }

    // ✅ =csend <cookie_category> @user — global file sender
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
        const fileToSend = files[0];
        const filePath = path.join(categoryPath, fileToSend);

        try {
            const attachment = new AttachmentBuilder(filePath);
            await user.send({
                content: `Here is a cookie file from \`${category}\` sent by ${message.author.tag}`,
                files: [attachment]
            });

            fs.unlinkSync(filePath);
            if (fs.readdirSync(categoryPath).length === 0) fs.rmdirSync(categoryPath);
            updateFileStock();

            embed.setTitle('Cookie Sent! ✅')
                 .setDescription(`\`${fileToSend}\` has been sent to ${user.tag} and removed from storage.`);
            return message.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Error sending file:', error);
            embed.setTitle('Error Sending File ❌')
                 .setDescription(`Could not DM the user. Make sure their DMs are open.`);
            return message.reply({ embeds: [embed] });
        }
    }

    // Already good: =cstock
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

    // Keep existing =stock, =redeem, =pls, =debug...

    if (cmd === '=pls') {
        embed.setTitle('Cheers for our staff! 🎉')
             .setDescription(`Show appreciation with \`+vouch @user\` in <#${VOUCH_CHANNEL_ID}>.\nNot happy? Use \`-vouch @user <reason>\`.`)
             .setColor(0xffa500);
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '=debug' && message.author.id === OWNER_ID) {
        const debugEmbed = new EmbedBuilder()
            .setTitle('Bot Debug Info')
            .setColor(0x8e44ad)
            .setDescription('Internal state snapshot');

        const truncate = (obj) => JSON.stringify(obj, null, 2).slice(0, 1000);
        debugEmbed.addFields(
            { name: 'Stock', value: `\`\`\`json\n${truncate(stock)}\n\`\`\``, inline: false },
            { name: 'Roles Allowed', value: `\`\`\`json\n${truncate(rolesAllowed)}\n\`\`\``, inline: false },
            { name: 'Redeemed', value: `\`\`\`json\n${truncate(redeemed)}\n\`\`\``, inline: false },
            { name: 'File Stock', value: `\`\`\`json\n${truncate(fileStock)}\n\`\`\``, inline: false }
        );
        return message.channel.send({ embeds: [debugEmbed] });
    }
});

// === Login ===
client.login(TOKEN);

// === Keepalive Server ===
const app = express();
app.get('/', (req, res) => res.send('Bot is running.'));
app.listen(3000, () => console.log('Express server listening on port 3000'));
