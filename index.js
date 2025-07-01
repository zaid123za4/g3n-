const { Client, GatewayIntentBits, Partials, AttachmentBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField } = require('discord.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const express = require('express');

// === Config & Constants ===
const TOKEN = process.env.TOKEN || 'YOUR_BOT_TOKEN'; // Use env or fallback
const OWNER_ID = '1110864648787480656'; // Your Discord User ID - ONLY THIS USER CAN SETUP THE TICKET PANEL
const AUTHORIZED_USERS = ['1389567581853319268', '1110864648787480656', '1380028507228209232', '1333798275601662056']; // Authorized User IDs for admin commands
const VOUCH_CHANNEL_ID = '1374018342444204067'; // Vouch Channel ID

// --- Consolidated Staff Role ---
// This role will be used for:
// - Permissions for =csend
// - Permissions for =redeem
// - The role to be pinged when a new ticket is created
// - The role that can manage/claim tickets
const STAFF_ROLE_ID = '1376539272714260501'; // <--- IMPORTANT: REPLACE WITH YOUR STAFF ROLE ID

// --- Ticket System Config ---
const TICKET_CATEGORY_ID = '1385685111177089045'; // <--- IMPORTANT: REPLACE WITH YOUR TICKET CATEGORY ID
const TICKET_LOG_CHANNEL_ID = '1385685463142240356'; // <--- IMPORTANT: REPLACE WITH YOUR TICKET LOG CHANNEL ID

const DATA_DIR = './data';
const COOKIE_DIR = './cookies';
const VOUCH_PATH = './vouches.json';
const STOCK_PATH = './data/stock.json';
const ROLES_PATH = './data/roles.json';
const REDEEMED_PATH = './data/redeemed.json';
const CHANNEL_RESTRICTIONS_PATH = './data/channelRestrictions.json';
const COOLDOWN_PATH = './data/cooldowns.json'; // Path for cooldowns data
const TICKETS_DATA_PATH = './data/tickets.json'; // To store active ticket information and panel info

// === Ensure directories exist ===
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(COOKIE_DIR)) fs.mkdirSync(COOKIE_DIR);

// Ensure all JSON files exist with default empty objects
[VOUCH_PATH, STOCK_PATH, ROLES_PATH, REDEEMED_PATH, CHANNEL_RESTRICTIONS_PATH, COOLDOWN_PATH, TICKETS_DATA_PATH].forEach(filePath => {
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
let cooldowns = {};            // { commandName: { duration: seconds, lastUsed: { userId: timestamp_ms } } }
let activeTickets = {};        // { ticketChannelId: { userId: string, openedAt: string, reason: string, claimedBy?: string } }
let ticketPanelInfo = {        // Stores ticket panel message and channel IDs
    channelId: null,
    messageId: null
};

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
    'stockoverview', // Renamed from stock
    'stock',         // Renamed from stockall
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
    'cool',
    'timesaved',
    'ticket',
    'newticket',
    'closeticket',
    'help',
    'setuppanel', // NEW
    'check' // Added for the placeholder command
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
function loadCooldowns() { return loadJSON(COOLDOWN_PATH); }
function saveCooldowns(data) { saveJSON(COOLDOWN_PATH, data); }
function loadTicketsData() { // Consolidated ticket data loader
    const data = loadJSON(TICKETS_DATA_PATH, { activeTickets: {}, ticketPanelInfo: { channelId: null, messageId: null } });
    activeTickets = data.activeTickets || {};
    ticketPanelInfo = data.ticketPanelInfo || { channelId: null, messageId: null };
}
function saveTicketsData() { // Consolidated ticket data saver
    saveJSON(TICKETS_DATA_PATH, { activeTickets, ticketPanelInfo });
}

// Main data loader/saver
function loadData() {
    stock = loadJSON(STOCK_PATH);
    redeemed = loadJSON(REDEEMED_PATH);
    rolesAllowed = loadJSON(ROLES_PATH);
    channelRestrictions = loadJSON(CHANNEL_RESTRICTIONS_PATH);
    cooldowns = loadCooldowns();
    loadTicketsData(); // Load active tickets and panel info
}
function saveData() {
    saveJSON(STOCK_PATH, stock);
    saveJSON(REDEEMED_PATH, redeemed);
    saveJSON(ROLES_PATH, rolesAllowed);
    saveJSON(CHANNEL_RESTRICTIONS_PATH, channelRestrictions);
    saveCooldowns(cooldowns);
    saveTicketsData(); // Save active tickets and panel info
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
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    // Attempt to restore ticket panel message if info exists
    if (ticketPanelInfo.channelId && ticketPanelInfo.messageId) {
        try {
            const channel = await client.channels.fetch(ticketPanelInfo.channelId);
            if (channel && channel.isTextBased()) {
                await channel.messages.fetch(ticketPanelInfo.messageId);
                console.log('Ticket panel message fetched successfully.');
            }
        } catch (error) {
            console.error('Failed to fetch ticket panel message, it might have been deleted:', error.message);
            ticketPanelInfo = { channelId: null, messageId: null };
            saveTicketsData();
        }
    }
});

function generateHexCode() {
    return Math.random().toString(16).substring(2, 8).toUpperCase();
}

// Function to check if user is authorized
const isAuthorized = (userId) => AUTHORIZED_USERS.includes(userId);

// Reusable function to send profile embed
async function sendProfileEmbed(channel, user) {
    const vouches = loadVouches();
    const data = vouches[user.id];
    const embed = new EmbedBuilder().setColor(0x2ecc71);

    if (!data) {
        embed.setTitle('Profile Not Found ℹ️')
             .setDescription(`${user.tag} has not received any vouches or reviews yet.`);
        return channel.send({ embeds: [embed] });
    }

    embed.setTitle(`${user.tag}'s Vouch & Review Profile`)
         .setThumbnail(user.displayAvatarURL())
         .addFields(
             { name: '✅ Positive Reviews', value: `${data.positive || 0}`, inline: true }, // Changed from data.positiveCount
             { name: '❌ Negative Reviews', value: `${data.negative || 0}`, inline: true }, // Changed from data.negativeCount
             { name: 'Last Reviewed On', value: `${data.lastVouched || 'N/A'}`, inline: false }
         );

    // Assuming 'reasons' is structured as before if you want to display them
    // For simplicity, I'm adapting to the current vouch structure (positive/negative counts)
    // If you need to display individual reasons, ensure they are stored in vouches.json
    // and adapt this section.

    embed.setFooter({ text: `User ID: ${user.id}` })
         .setTimestamp();

    return channel.send({ embeds: [embed] });
}


// Reusable ticket creation logic
async function createTicketChannel(member, guild, reason = 'No reason provided') {
    const embed = new EmbedBuilder().setColor(0x3498db);

    if (!TICKET_CATEGORY_ID || !TICKET_LOG_CHANNEL_ID || !STAFF_ROLE_ID) {
        embed.setTitle('Ticket System Not Fully Configured ⚙️')
             .setDescription('Ticket system constants (TICKET_CATEGORY_ID, TICKET_LOG_CHANNEL_ID, STAFF_ROLE_ID) are not set. Please configure them in the bot\'s code.');
        return { success: false, embed };
    }

    const existingTicket = Object.values(activeTickets).find(ticket => ticket.userId === member.id);
    if (existingTicket) {
        embed.setTitle('Ticket Already Open ⚠️')
             .setDescription(`You already have an active ticket: <#${Object.keys(activeTickets).find(channelId => activeTickets[channelId].userId === member.id)}>`);
        return { success: false, embed };
    }

    const ticketChannelName = `ticket-${member.user.username.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${member.id.slice(-4)}`;

    try {
        const ticketChannel = await guild.channels.create({
            name: ticketChannelName,
            type: ChannelType.GuildText,
            parent: TICKET_CATEGORY_ID,
            permissionOverwrites: [
                {
                    id: guild.id, // @everyone role
                    deny: [PermissionsBitField.Flags.ViewChannel],
                },
                {
                    id: member.id,
                    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
                },
                {
                    id: STAFF_ROLE_ID, // Staff role can view and manage tickets
                    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageChannels],
                },
                {
                    id: client.user.id, // Bot itself
                    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageChannels],
                }
            ],
            topic: `Ticket for ${member.user.tag} (ID: ${member.id}). Reason: ${reason}.` // Store opener ID and reason in topic
        });

        // Store ticket info
        activeTickets[ticketChannel.id] = {
            userId: member.id,
            openedAt: new Date().toISOString(),
            reason: reason,
            claimedBy: null // Initially not claimed
        };
        saveTicketsData();

        // Ping the user who created the ticket
        await ticketChannel.send(`Welcome, ${member.toString()}!`);


        // Ping the staff role
        await ticketChannel.send(`<@&${STAFF_ROLE_ID}>`);

        const welcomeEmbed = new EmbedBuilder()
            .setTitle('✨ New Support Ticket Opened! ✨')
            .setDescription(`Hello ${member},\n\nOur staff will be with you shortly. Please describe your issue in detail here.\n\n**Reason:** \`${reason}\``)
            .setColor(0x3498db) // Vibrant Blue Aura
            .setFooter({ text: `Ticket created by ${member.user.tag}` })
            .setTimestamp();

        const actionRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('close_ticket')
                    .setLabel('Close Ticket')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('🔒'),
                new ButtonBuilder()
                    .setCustomId('claim_ticket')
                    .setLabel('Claim Ticket')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('🙋‍♂️'),
                new ButtonBuilder()
                    .setCustomId('add_user_ticket')
                    .setLabel('Add User')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('➕'),
                new ButtonBuilder()
                    .setCustomId('remove_user_ticket')
                    .setLabel('Remove User')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('➖'),
                new ButtonBuilder()
                    .setCustomId('transcript_ticket')
                    .setLabel('Transcript')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('📄'),
            );

        ticketChannel.send({ embeds: [welcomeEmbed], components: [actionRow] });

        // Log to a dedicated channel
        if (TICKET_LOG_CHANNEL_ID) {
            const logChannel = await guild.channels.cache.get(TICKET_LOG_CHANNEL_ID);
            if (logChannel) {
                logChannel.send({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('Ticket Opened 📝')
                            .setDescription(`Ticket ${ticketChannel} opened by ${member.user} for reason: \`${reason}\``)
                            .setColor(0x00ff00) // Green aura for log
                            .setTimestamp()
                    ]
                });
            }
        }
        return { success: true, embed: new EmbedBuilder().setTitle('Ticket Created! ✅').setDescription(`Your support ticket has been created: ${ticketChannel}.\n\nPlease explain your issue there.`).setColor(0x2ecc71) }; // Green success for user

    } catch (error) {
        console.error('Error creating ticket:', error);
        embed.setTitle('Error Creating Ticket ❌')
             .setDescription(`An error occurred while creating your ticket: \`${error.message}\`. Please ensure the bot has 'Manage Channels' and 'Manage Roles' permissions and the category ID is correct.`);
        return { success: false, embed };
    }
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
client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const args = message.content.trim().split(/\s+/);
    const cmd = args[0].toLowerCase(); // e.g., "=fgen" or "=addcategory"
    const commandWithoutPrefix = cmd.startsWith('=') || cmd.startsWith('+') || cmd.startsWith('-') ? cmd.substring(1).toLowerCase() : cmd.toLowerCase(); // e.g., "fgen" or "addcategory"

    const embed = new EmbedBuilder().setColor(0x3498db); // Default embed color

    // --- Guild Context Check ---
    if (!message.guild && commandWithoutPrefix !== 'backup') {
        if (message.channel.type === ChannelType.DM) {
            embed.setTitle('Command Restricted 🚫')
                 .setDescription('This command can only be used in a server channel.');
            return message.channel.send({ embeds: [embed] });
        }
        return;
    }

    // --- Handle =pls command in tickets ---
    if (cmd === '=pls' && message.channel.type === ChannelType.GuildText && activeTickets[message.channel.id]) {
        try {
            embed.setTitle('🛑 Command Not Allowed in Tickets')
                 .setDescription('The `PLS` command is not allowed in ticket channels. This ticket will be deleted.');
            await message.channel.send({ embeds: [embed] });
            await message.delete(); // Delete the =pls message

            const ticketData = activeTickets[message.channel.id];
            const logEmbed = new EmbedBuilder()
                .setTitle('Ticket Auto-Deleted! 💥')
                .setDescription(`Ticket channel ${message.channel.name} (ID: ${message.channel.id}) was auto-deleted because \`=pls\` command was detected.`)
                .addFields(
                    { name: 'Opened By', value: `<@${ticketData.userId}>`, inline: true },
                    { name: 'Reason', value: ticketData.reason, inline: true }
                )
                .setColor(0xffa500) // Orange for warning/auto-action
                .setTimestamp();

            if (TICKET_LOG_CHANNEL_ID) {
                const logChannel = await message.guild.channels.cache.get(TICKET_LOG_CHANNEL_ID);
                if (logChannel) {
                    logChannel.send({ embeds: [logEmbed] });
                }
            }

            delete activeTickets[message.channel.id];
            saveTicketsData(); // Save updated tickets
            await message.channel.delete('`=pls` command detected in ticket.');

        } catch (error) {
            console.error('Error handling =pls in ticket or deleting ticket:', error);
            if (message.channel.viewable) {
                message.channel.send({ content: 'An error occurred while trying to delete the ticket due to `=pls` command.' });
            }
        }
        return; // Prevent further processing if =pls is detected in a ticket
    }

    // --- Cooldown Check ---
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
        saveCooldowns(cooldowns);
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

    // --- Ticket System Commands ---
    if (cmd === '=ticket' || cmd === '=newticket') {
        if (!message.guild) {
            embed.setTitle('Command Restricted 🚫')
                 .setDescription('This command can only be used in a server channel.');
            return message.channel.send({ embeds: [embed] });
        }
        const reason = args.slice(1).join(' ');
        const result = await createTicketChannel(message.member, message.guild, reason);
        return message.channel.send({ embeds: [result.embed] });
    }

    if (cmd === '=closeticket') {
        if (!message.guild) {
            embed.setTitle('Command Restricted 🚫')
                 .setDescription('This command can only be used in a server channel.');
            return message.channel.send({ embeds: [embed] });
        }

        const channelIdToClose = message.channel.id;
        const ticketData = activeTickets[channelIdToClose];

        if (!ticketData) {
            embed.setTitle('Not a Ticket Channel ℹ️')
                 .setDescription('This command can only be used in an active ticket channel.');
            return message.channel.send({ embeds: [embed] });
        }

        const isAuthorizedToClose = message.author.id === ticketData.userId || message.member.permissions.has(PermissionsBitField.Flags.ManageChannels) || isAuthorized(message.author.id);

        if (!isAuthorizedToClose) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need to be the ticket creator, an authorized user, or have `Manage Channels` permission to close this ticket.');
            return message.channel.send({ embeds: [embed] });
        }

        try {
            const ticketChannel = message.guild.channels.cache.get(channelIdToClose);
            if (ticketChannel) {
                embed.setTitle('Closing Ticket... ⏳')
                     .setDescription('This ticket will be closed shortly.')
                     .setColor(0xffa500); // Orange aura for closing
                await message.channel.send({ embeds: [embed] });

                const logEmbed = new EmbedBuilder()
                    .setTitle('Ticket Closed 🗑️')
                    .setDescription(`Ticket channel ${ticketChannel.name} (ID: ${channelIdToClose}) closed by ${message.author}.`)
                    .addFields(
                        { name: 'Opened By', value: `<@${ticketData.userId}>`, inline: true },
                        { name: 'Reason', value: ticketData.reason, inline: true },
                        { name: 'Opened At', value: new Date(ticketData.openedAt).toLocaleString(), inline: false }
                    )
                    .setColor(0xff0000) // Red aura for closed ticket log
                    .setTimestamp();

                if (TICKET_LOG_CHANNEL_ID) {
                    const logChannel = await message.guild.channels.cache.get(TICKET_LOG_CHANNEL_ID);
                    if (logChannel) {
                        logChannel.send({ embeds: [logEmbed] });
                    }
                }

                delete activeTickets[channelIdToClose];
                saveTicketsData();

                await ticketChannel.delete('Ticket closed by user or staff.');
            }
        } catch (error) {
            console.error('Error closing ticket:', error);
            embed.setTitle('Error Closing Ticket ❌')
                 .setDescription(`An error occurred while closing the ticket: \`${error.message}\``);
            return message.channel.send({ embeds: [embed] });
        }
        return;
    }

    // =setuppanel command
    if (cmd === '=setuppanel') {
        if (message.author.id !== OWNER_ID) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('Only the bot owner can set up the ticket panel.');
            return message.channel.send({ embeds: [embed] });
        }
        if (!message.guild) {
            embed.setTitle('Command Restricted 🚫')
                 .setDescription('This command can only be used in a server channel.');
            return message.channel.send({ embeds: [embed] });
        }
        if (!TICKET_CATEGORY_ID || !TICKET_LOG_CHANNEL_ID || !STAFF_ROLE_ID) {
            embed.setTitle('Ticket System Not Fully Configured ⚙️')
                 .setDescription('Ticket system constants (TICKET_CATEGORY_ID, TICKET_LOG_CHANNEL_ID, STAFF_ROLE_ID) are not set. Please configure them in the bot\'s code.');
            return message.channel.send({ embeds: [embed] });
        }

        const panelEmbed = new EmbedBuilder()
            .setTitle('✨🎫 Create a New Support Ticket 🎫✨')
            .setDescription('Need assistance? Click the button below to open a private support ticket with our dedicated staff. We\'re here to help!')
            .setColor(0x9b59b6) // Enchanting Purple Aura
            .setFooter({ text: 'Click the button to get started!' });

        const openTicketButton = new ButtonBuilder()
            .setCustomId('open_ticket')
            .setLabel('Open a Ticket')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('➕');

        const actionRow = new ActionRowBuilder().addComponents(openTicketButton);

        try {
            if (ticketPanelInfo.channelId && ticketPanelInfo.messageId) {
                try {
                    const oldChannel = await client.channels.fetch(ticketPanelInfo.channelId);
                    if (oldChannel && oldChannel.isTextBased()) {
                        const oldMessage = await oldChannel.messages.fetch(ticketPanelInfo.messageId);
                        await oldMessage.delete();
                        console.log('Deleted old ticket panel message.');
                    }
                } catch (e) {
                    console.warn('Could not delete old ticket panel message, it might be gone:', e.message);
                }
            }

            const sentMessage = await message.channel.send({
                embeds: [panelEmbed],
                components: [actionRow]
            });

            ticketPanelInfo.channelId = sentMessage.channel.id;
            ticketPanelInfo.messageId = sentMessage.id;
            saveTicketsData();

            embed.setTitle('Ticket Panel Setup! ✅')
                 .setDescription(`The ticket panel has been set up in ${message.channel}.`);
            return message.channel.send({ embeds: [embed] });

        } catch (error) {
            console.error('Error setting up ticket panel:', error);
            embed.setTitle('Error Setting Up Panel ❌')
                 .setDescription(`An error occurred: \`${error.message}\`. Please check bot permissions (Send Messages, Embed Links, Read Message History).`);
            return message.channel.send({ embeds: [embed] });
        }
    }
    // --- END Ticket System Commands ---


    // --- Help Command ---
    if (cmd === '=help') {
        const helpEmbed = new EmbedBuilder()
            .setTitle('📚 Bot Commands Help')
            .setColor(0x007bff) // A nice blue
            .setDescription('Here is a list of commands you can use. Some commands may require specific roles or permissions.');

        const addCommandField = (name, description, permissionNeeded = null, adminOnly = false) => {
            if (adminOnly && !isAuthorized(message.author.id)) return;
            if (permissionNeeded && message.member && !message.member.permissions.has(permissionNeeded)) return;

            helpEmbed.addFields({ name: name, value: description, inline: false });
        };

        // Vouch & Profile Commands
        helpEmbed.addFields({ name: '__Vouch & Profile Commands__', value: '\u200b', inline: false });
        addCommandField('+vouch @user <reason>', 'Add a positive vouch for a user.');
        addCommandField('-vouch @user <reason>', 'Add a negative review for a user.');
        addCommandField('+mvouch @user <amount> [reason]', 'Manually add positive vouches for a user.', PermissionsBitField.Flags.ManageGuild, true);
        addCommandField('-mvouch @user <amount> [reason]', 'Manually add negative vouches for a user.', PermissionsBitField.Flags.ManageGuild, true);
        addCommandField('=profile [@user]', 'View vouch and review profile for yourself or another user.');

        // Stock Management Commands
        helpEmbed.addFields({ name: '__Stock Management Commands__', value: '\u200b', inline: false });
        addCommandField('=addcategory <name>', 'Create a new stock category.', PermissionsBitField.Flags.ManageGuild, true);
        addCommandField('=categoryremove <category>', 'Remove an existing stock category, its dynamic command, and all items.', PermissionsBitField.Flags.ManageGuild, true);
        addCommandField('=addstock <category> <stock_name>', 'Add a new item to a stock category.', PermissionsBitField.Flags.ManageGuild, true);
        addCommandField('=removestock <category> <stock_name>', 'Remove an item from a stock category.', PermissionsBitField.Flags.ManageGuild, true);
        helpEmbed.addFields({ name: '=stockoverview [category]', value: 'View the overview of all stock categories or detailed stock for a specific category.', inline: false }); // Swapped
        helpEmbed.addFields({ name: '=stock', value: 'View all items across all stock categories.', inline: false }); // Swapped

        // Cookie/File Management Commands
        helpEmbed.addFields({ name: '__Cookie/File Management Commands__', value: '\u200b', inline: false });
        addCommandField('=cstock', 'View the overview of cookie/file stock categories.');
        addCommandField('=upload <cookie_category>', 'Upload a ZIP file of cookies/files to a specified category.', null, true);
        addCommandField('=cremove <cookie_category>', 'Remove an entire cookie category and receive its contents as a ZIP in DMs.', PermissionsBitField.Flags.ManageGuild, true);
        addCommandField('=csend <cookie_category> @user', 'Send a cookie/file from a category to a user\'s DMs. (Requires Staff Role)', null, false); // Updated description

        // Permission & Restriction Commands
        helpEmbed.addFields({ name: '__Permission & Restriction Commands__', value: '\u200b', inline: false });
        addCommandField('=add <command_name_without_=> @role', 'Restrict a command to a specific role.', PermissionsBitField.Flags.ManageGuild, true);
        addCommandField('=remove <command_name_without_=>', 'Remove role restriction for a command.', PermissionsBitField.Flags.ManageGuild, true);
        addCommandField('=restrict <command_name_without_=> <#channel | channel_id>', 'Restrict a command to a specific channel.', PermissionsBitField.Flags.ManageGuild, true);
        addCommandField('=unrestrict <command_name_without_=>', 'Remove channel restriction for a command.', PermissionsBitField.Flags.ManageGuild, true);
        addCommandField('=cool <command_name_without_=> <cooldown_in_seconds>', 'Set a cooldown for a command (use 0 to remove).', null, true);

        // Generation & Redemption Commands
        helpEmbed.addFields({ name: '__Generation & Redemption Commands__', value: '\u200b', inline: false });
        helpEmbed.addFields({ name: '`=[first_letter_of_category]gen [item_name]`', 'value': 'Dynamically generated commands (e.g., `=fgen` for \'free\' category). Generates a unique code for a stock item from the specified category and sends it to your DMs. You can also request a specific item name.', inline: false });
        addCommandField('=redeem <hex_code>', 'Redeem a generated code to view its details (Requires Staff Role).');

        // Utility & Admin Commands
        helpEmbed.addFields({ name: '__Utility & Admin Commands__', value: '\u200b', inline: false });
        addCommandField('=pls', 'Makes you eligible to receive one vouch/review. (Not allowed in tickets!)');
        addCommandField('=backup', 'Sends all bot data files to your DMs.', null, true);
        addCommandField('=timesaved', 'Restores bot data from attached JSON files.', null, true);
        addCommandField('=debug', 'Displays current internal bot state.', null, true);
        addCommandField('=check', 'Displays basic bot status and uptime.', null, false);


        // Ticket System Commands
        helpEmbed.addFields({ name: '__Ticket System Commands__', value: '\u200b', inline: false });
        addCommandField('=ticket [reason]', 'Create a new private support ticket.');
        addCommandField('=newticket [reason]', 'Alias for =ticket.', null, false);
        addCommandField('=closeticket', 'Close the current active ticket channel.', PermissionsBitField.Flags.ManageChannels);
        addCommandField('=setuppanel', 'Set up the interactive ticket creation panel with a button.', null, true); // Only for OWNER_ID

        helpEmbed.setFooter({ text: `Requested by ${message.author.tag}` }).setTimestamp();
        return message.channel.send({ embeds: [helpEmbed] });
    }
    // --- END Help Command ---


    // --- Static Command Handling ---
    if (cmd === '+vouch' || cmd === '-vouch') {
        const targetUser = message.mentions.users.first();
        const reason = args.slice(1).join(' '); // Adjusted args.slice for +vouch/-vouch

        if (!targetUser) {
            embed.setDescription('Please mention a user. Usage: `+vouch @user <reason>` or `-vouch @user <reason>`').setColor(0xff0000);
            return message.reply({ embeds: [embed] });
        }
        if (targetUser.id === message.author.id) {
            embed.setDescription('You cannot vouch for yourself.').setColor(0xff0000);
            return message.reply({ embeds: [embed] });
        }

        // Load vouches inside the command to ensure latest data
        const currentVouches = loadVouches();
        if (!currentVouches[targetUser.id]) currentVouches[targetUser.id] = { positive: 0, negative: 0, usersVouched: [], usersNegativeVouched: [] };

        if (cmd === '+vouch') {
            if (currentVouches[targetUser.id].usersVouched.includes(message.author.id)) {
                embed.setDescription('You have already positively vouched for this user.').setColor(0xff0000);
                return message.reply({ embeds: [embed] });
            }
            currentVouches[targetUser.id].positive++;
            currentVouches[targetUser.id].usersVouched.push(message.author.id);
            embed.setDescription(`Vouch recorded for ${targetUser.tag}! They now have ${currentVouches[targetUser.id].positive} positive vouches.`)
                 .setColor(0x00ff00);
        } else { // -vouch
            if (currentVouches[targetUser.id].usersNegativeVouched.includes(message.author.id)) {
                 embed.setDescription('You have already negatively vouched for this user.').setColor(0xff0000);
                 return message.reply({ embeds: [embed] });
            }
            currentVouches[targetUser.id].negative++;
            currentVouches[targetUser.id].usersNegativeVouched.push(message.author.id);
            embed.setDescription(`Negative vouch recorded for ${targetUser.tag}. They now have ${currentVouches[targetUser.id].negative} negative vouches. Reason: ${reason || 'Not provided'}`)
                 .setColor(0xff0000);
        }
        saveVouches(currentVouches);
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '+mvouch') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.channel.send({ embeds: [embed] });
        }
        const user = message.mentions.users.first();
        const amount = parseInt(args[1]); // Adjusted args index
        const reason = args.slice(2).join(' ') || 'Manual adjustment by staff';

        if (!user || isNaN(amount) || amount <= 0) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `+mvouch @user <amount> [reason]`');
            return message.channel.send({ embeds: [embed] });
        }

        const currentVouches = loadVouches();
        const id = user.id;

        if (!currentVouches[id]) {
            currentVouches[id] = { positive: 0, negative: 0, usersVouched: [], usersNegativeVouched: [] };
        }

        currentVouches[id].positive += amount;
        // No need to track individual users for manual vouches unless specifically requested
        saveVouches(currentVouches);

        embed.setTitle('Vouches Manually Added! ✅')
             .setDescription(`Successfully added **${amount}** positive vouches for **${user.tag}**.`)
             .addFields({ name: 'Reason', value: `"${reason}"` });
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '-mvouch') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.channel.send({ embeds: [embed] });
        }
        const user = message.mentions.users.first();
        const amount = parseInt(args[1]); // Adjusted args index
        const reason = args.slice(2).join(' ') || 'Manual adjustment by staff';

        if (!user || isNaN(amount) || amount <= 0) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `-mvouch @user <amount> [reason]`');
            return message.channel.send({ embeds: [embed] });
        }

        const currentVouches = loadVouches();
        const id = user.id;

        if (!currentVouches[id]) {
            currentVouches[id] = { positive: 0, negative: 0, usersVouched: [], usersNegativeVouched: [] };
        }

        currentVouches[id].negative += amount;
        saveVouches(currentVouches);

        embed.setTitle('Vouches Manually Removed! ✅')
             .setDescription(`Successfully added **${amount}** negative vouches (effectively removed) for **${user.tag}**.`)
             .addFields({ name: 'Reason', value: `"${reason}"` });
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '=profile') {
        const user = message.mentions.users.first() || message.author;
        return sendProfileEmbed(message.channel, user); // Use the reusable function
    }

    if (cmd === '=addcategory') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.channel.send({ embeds: [embed] });
        }
        const name = args[0]?.toLowerCase(); // Adjusted args index
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
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.channel.send({ embeds: [embed] });
        }

        const category = args[0]?.toLowerCase(); // Adjusted args index
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
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.channel.send({ embeds: [embed] });
        }
        const category = args[0]?.toLowerCase(); // Adjusted args index
        const stockItem = args.slice(1).join(' '); // Adjusted args index
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
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.channel.send({ embeds: [embed] });
        }
        const category = args[0]?.toLowerCase(); // Adjusted args index
        const stockName = args.slice(1).join(' '); // Adjusted args index
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
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.channel.send({ embeds: [embed] });
        }
        const commandToRestrict = args[0]?.toLowerCase(); // Adjusted args index
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
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.channel.send({ embeds: [embed] });
        }
        const commandToRemoveRestriction = args[0]?.toLowerCase(); // Adjusted args index
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
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.channel.send({ embeds: [embed] });
        }

        const commandToRestrict = args[0]?.toLowerCase(); // Adjusted args index
        const targetChannel = message.mentions.channels.first() || message.guild.channels.cache.get(args[1]); // Adjusted args index

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
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.channel.send({ embeds: [embed] });
        }
        const commandToUnrestrict = args[0]?.toLowerCase(); // Adjusted args index
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

    if (cmd === '=cool') {
        if (!isAuthorized(message.author.id)) {
            embed.setTitle('Authorization Required 🚫')
                 .setDescription('You need to be an authorized user to use this command.');
            return message.channel.send({ embeds: [embed] });
        }

        const commandToCool = args[0]?.toLowerCase(); // Adjusted args index
        const cooldownTimeSeconds = parseInt(args[1]); // Adjusted args index

        if (!commandToCool || isNaN(cooldownTimeSeconds) || cooldownTimeSeconds < 0) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=cool <command_name_without_=> <cooldown_in_seconds>` (use 0 to remove cooldown)');
            return message.channel.send({ embeds: [embed] });
        }

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
                lastUsed: cooldowns[commandToCool]?.lastUsed || {}
            };
            saveCooldowns(cooldowns);
            embed.setTitle('Cooldown Set! ✅')
                 .setDescription(`\`=${commandToCool}\` now has a cooldown of **${cooldownTimeSeconds}** seconds.`);
        }
        return message.channel.send({ embeds: [embed] });
    }


    // --- SWAPPED COMMANDS: =stock and =stockoverview ---
    // The old =stockall is now =stock
    if (cmd === '=stock') { // This was previously =stockall
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

    // The old =stock is now =stockoverview
    if (cmd === '=stockoverview') { // This was previously =stock
        const allCategories = Object.keys(stock);
        if (allCategories.length === 0) {
            embed.setTitle('No Stock 📦')
                 .setDescription('No stock categories have been added yet.')
                 .setColor(0x0099ff);
            return message.channel.send({ embeds: [embed] });
        }

        const cat = args[0]?.toLowerCase(); // Adjusted args index
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
    // --- END SWAPPED COMMANDS ---


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

        const category = args[0]?.toLowerCase(); // Adjusted args index
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

    if (cmd === '=cremove') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission to use this command.');
            return message.channel.send({ embeds: [embed] });
        }

        const category = args[0]?.toLowerCase(); // Adjusted args index

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

            filesInCategories.forEach(file => {
                const filePath = path.join(categoryPath, file);
                zip.addLocalFile(filePath, category);
            });

            zip.writeZip(tempZipPath);

            const attachment = new AttachmentBuilder(tempZipPath, { name: zipFileName });
            await message.author.send({
                content: `Here are all the cookie files from the removed category \`${category}\`:`,
                files: [attachment]
            });

            fs.rmSync(categoryPath, { recursive: true, force: true });
            fs.unlinkSync(tempZipPath);

            updateFileStock();

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
        // Role permission check for =csend
        if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription(`You need the role <@&${STAFF_ROLE_ID}> to use this command.`);
            return message.channel.send({ embeds: [embed] });
        }

        const category = args[0]?.toLowerCase(); // Adjusted args index
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
        if (!message.member.roles.cache.has(STAFF_ROLE_ID)) { // Changed to STAFF_ROLE_ID
            embed.setTitle('Permission Denied 🚫')
                 .setDescription(`You need the role <@&${STAFF_ROLE_ID}> to use this command.`);
            return message.channel.send({ embeds: [embed] });
        }

        const code = args[0]?.toUpperCase(); // Adjusted args index
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
            codeData.redeemed = true;

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
            const cooldownsAttachment = new AttachmentBuilder(COOLDOWN_PATH, { name: 'cooldowns.json' });
            const ticketsAttachment = new AttachmentBuilder(TICKETS_DATA_PATH, { name: 'tickets.json' });

            await message.author.send({
                content: 'Here are your backup files:',
                files: [vouchesAttachment, stockAttachment, rolesAttachment, redeemedAttachment, channelRestrictionsAttachment, cooldownsAttachment, ticketsAttachment]
            });
            embed.setTitle('Backup Sent! ✅')
                 .setDescription('Your bot data files have been sent to your DMs (`vouches.json`, `stock.json`, `roles.json`, `redeemed.json`, `channelRestrictions.json`, `cooldowns.json`, `tickets.json`).');
            return message.channel.send({ embeds: [embed] });
        } catch (dmError) {
            console.error(`Could not DM user ${message.author.tag} for backup:`, dmError);
            embed.setTitle('Backup Failed ❌')
                 .setDescription('Could not send backup files to your DMs. Please ensure your DMs are open.');
            return message.channel.send({ embeds: [embed] });
        }
    }

    if (cmd === '=timesaved') {
        if (!isAuthorized(message.author.id)) {
            embed.setTitle('Authorization Required 🚫')
                 .setDescription('You need to be an authorized user to use this command.');
            return message.channel.send({ embeds: [embed] });
        }

        const attachments = message.attachments;
        if (attachments.size === 0) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Please attach one or more JSON files to restore data. Accepted files: `vouches.json`, `stock.json`, `roles.json`, `redeemed.json`, `channelRestrictions.json`, `cooldowns.json`, `tickets.json`.');
            return message.channel.send({ embeds: [embed] });
        }

        const allowedFileNames = [
            'vouches.json', 'stock.json', 'roles.json',
            'redeemed.json', 'channelRestrictions.json', 'cooldowns.json', 'tickets.json'
        ];
        let restoredFiles = [];
        let errorMessages = [];

        for (const attachment of attachments.values()) {
            if (!attachment.name.endsWith('.json') || !allowedFileNames.includes(attachment.name)) {
                errorMessages.push(`Skipping invalid file: \`${attachment.name}\`. Only allowed JSON files can be restored.`);
                continue;
            }
            if (attachment.size > 1024 * 1024 * 5) {
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
                        vouches = newData;
                        saveVouches(newData);
                        break;
                    case 'stock.json':
                        stock = newData;
                        saveJSON(STOCK_PATH, stock);
                        updateDynamicCommandMap();
                        break;
                    case 'roles.json':
                        rolesAllowed = newData;
                        saveJSON(ROLES_PATH, rolesAllowed);
                        break;
                    case 'redeemed.json':
                        redeemed = newData;
                        saveJSON(REDEEMED_PATH, redeemed);
                        break;
                    case 'channelRestrictions.json':
                        channelRestrictions = newData;
                        saveJSON(CHANNEL_RESTRICTIONS_PATH, channelRestrictions);
                        break;
                    case 'cooldowns.json':
                        cooldowns = newData;
                        saveJSON(COOLDOWN_PATH, cooldowns);
                        break;
                    case 'tickets.json':
                        activeTickets = newData.activeTickets || {};
                        ticketPanelInfo = newData.ticketPanelInfo || { channelId: null, messageId: null };
                        saveTicketsData();
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
        const cooldownsStr = JSON.stringify(cooldowns, null, 2);
        const activeTicketsStr = JSON.stringify(activeTickets, null, 2);
        const ticketPanelInfoStr = JSON.stringify(ticketPanelInfo, null, 2);

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
        debugEmbed.addFields(...splitStringForEmbed(cooldownsStr, 'Cooldowns'));
        debugEmbed.addFields(...splitStringForEmbed(activeTicketsStr, 'Active Tickets'));
        debugEmbed.addFields(...splitStringForEmbed(ticketPanelInfoStr, 'Ticket Panel Info'));

        return message.channel.send({ embeds: [debugEmbed] });
    }
});

// === Interaction Listener for Buttons ===
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    // Defer the reply to prevent "This interaction failed" error
    await interaction.deferReply({ ephemeral: true });

    if (!interaction.guild) {
        return interaction.editReply({ content: 'This action can only be performed in a server channel.', ephemeral: true });
    }

    const ticketChannel = interaction.channel;
    const ticketInfo = activeTickets[ticketChannel.id];
    const isStaff = interaction.member.roles.cache.has(STAFF_ROLE_ID) || interaction.user.id === OWNER_ID;

    // --- Open Ticket Logic ---
    if (interaction.customId === 'open_ticket') {
        const result = await createTicketChannel(interaction.member, interaction.guild, 'Opened via ticket panel');
        await interaction.editReply({ embeds: [result.embed], ephemeral: true });
    }

    // --- Close Ticket Logic ---
    else if (interaction.customId === 'close_ticket') {
        if (!ticketInfo) {
            return interaction.editReply({ content: 'This does not appear to be an active ticket channel.', ephemeral: true });
        }

        const isOpener = interaction.user.id === ticketInfo.userId;
        if (!isOpener && !isStaff) {
            return interaction.editReply({ content: 'Only the ticket opener, bot owner, or support staff can close this ticket.', ephemeral: true });
        }

        // Inform users in the ticket channel
        await ticketChannel.send({
            embeds: [
                new EmbedBuilder()
                    .setDescription(`This ticket is being closed by <@${interaction.user.id}>...`)
                    .setColor(0xffa500) // Orange
            ]
        });
        await interaction.editReply({ content: 'Ticket closure initiated.', ephemeral: true });


        // Log to a designated channel
        const logChannel = await interaction.guild.channels.fetch(TICKET_LOG_CHANNEL_ID);
        if (logChannel && logChannel.type === ChannelType.GuildText) {
            const closeEmbed = new EmbedBuilder()
                .setTitle('Ticket Closed 🗑️')
                .setDescription(`Ticket <#${ticketChannel.id}> (\`${ticketChannel.name}\`) closed by ${interaction.user.tag}.`)
                .addFields(
                    { name: 'Ticket Opener', value: `<@${ticketInfo.userId}>`, inline: true },
                    { name: 'Closed By', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true }
                )
                .setColor(0xff0000) // Red
                .setTimestamp();
            logChannel.send({ embeds: [closeEmbed] });
        }

        // Remove ticket from active tickets
        delete activeTickets[ticketChannel.id];
        saveTicketsData();

        // Delete the ticket channel after a short delay (e.g., 5 seconds)
        setTimeout(async () => {
            try {
                await ticketChannel.delete('Ticket closed by user/staff.');
                console.log(`Deleted ticket channel: ${ticketChannel.name}`);
            } catch (deleteError) {
                console.error(`Error deleting ticket channel ${ticketChannel.name}:`, deleteError);
            }
        }, 5000);
    }

    // --- Claim Ticket Logic ---
    else if (interaction.customId === 'claim_ticket') {
        if (!ticketInfo) {
            return interaction.editReply({ content: 'This does not appear to be an active ticket channel.', ephemeral: true });
        }
        if (!isStaff) {
            return interaction.editReply({ content: 'Only support staff can claim tickets.', ephemeral: true });
        }
        if (ticketInfo.claimedBy) {
            return interaction.editReply({ content: `This ticket has already been claimed by <@${ticketInfo.claimedBy}>.`, ephemeral: true });
        }

        ticketInfo.claimedBy = interaction.user.id;
        saveTicketsData();

        const claimedEmbed = new EmbedBuilder()
            .setDescription(`✅ This ticket has been claimed by <@${interaction.user.id}>.`)
            .setColor(0x2ecc71) // Green
            .setTimestamp();

        // Disable the claim button after it's clicked
        const updatedComponents = interaction.message.components.map(row => {
            return new ActionRowBuilder().addComponents(
                row.components.map(component => {
                    if (component.customId === 'claim_ticket') {
                        return ButtonBuilder.from(component).setDisabled(true);
                    }
                    return component;
                })
            );
        });

        await interaction.message.edit({ embeds: [interaction.message.embeds[0], claimedEmbed], components: updatedComponents });
        await interaction.editReply({ content: 'You have claimed this ticket!', ephemeral: true });

        // Log to a designated channel
        const logChannel = await interaction.guild.channels.fetch(TICKET_LOG_CHANNEL_ID);
        if (logChannel && logChannel.type === ChannelType.GuildText) {
            const claimLogEmbed = new EmbedBuilder()
                .setTitle('Ticket Claimed 🙋‍♂️')
                .setDescription(`Ticket <#${ticketChannel.id}> (\`${ticketChannel.name}\`) claimed by ${interaction.user.tag}.`)
                .addFields(
                    { name: 'Ticket Opener', value: `<@${ticketInfo.userId}>`, inline: true },
                    { name: 'Claimed By', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true }
                )
                .setColor(0x0099ff) // Blue
                .setTimestamp();
            logChannel.send({ embeds: [claimLogEmbed] });
        }
    }

    // --- Add User to Ticket Logic ---
    else if (interaction.customId === 'add_user_ticket') {
        if (!ticketInfo) {
            return interaction.editReply({ content: 'This does not appear to be an active ticket channel.', ephemeral: true });
        }
        if (!isStaff) {
            return interaction.editReply({ content: 'Only support staff can add users to tickets.', ephemeral: true });
        }

        await interaction.editReply({ content: 'Please mention the user you want to add to this ticket (e.g., `@user`). I will listen for your next message in this channel.', ephemeral: false });

        const filter = m => m.author.id === interaction.user.id && m.mentions.users.size > 0;
        const collector = interaction.channel.createMessageCollector({ filter, time: 60000, max: 1 });

        collector.on('collect', async m => {
            const userToAdd = m.mentions.users.first();
            if (!userToAdd) {
                await interaction.channel.send('No user mentioned. Please try again.');
                return;
            }

            try {
                await ticketChannel.permissionOverwrites.edit(userToAdd.id, {
                    ViewChannel: true,
                    SendMessages: true,
                    ReadMessageHistory: true,
                });
                await interaction.channel.send({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(`✅ <@${userToAdd.id}> has been added to the ticket.`)
                            .setColor(0x2ecc71)
                    ]
                });
                // Log to a designated channel
                const logChannel = await interaction.guild.channels.fetch(TICKET_LOG_CHANNEL_ID);
                if (logChannel && logChannel.type === ChannelType.GuildText) {
                    logChannel.send({
                        embeds: [
                            new EmbedBuilder()
                                .setTitle('User Added to Ticket')
                                .setDescription(`User ${userToAdd.tag} added to ticket <#${ticketChannel.id}> by ${interaction.user.tag}.`)
                                .setColor(0x00ff00)
                                .setTimestamp()
                        ]
                    });
                }
            } catch (error) {
                console.error('Error adding user to ticket:', error);
                await interaction.channel.send({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(`❌ Failed to add <@${userToAdd.id}> to the ticket: \`${error.message}\`.`)
                            .setColor(0xff0000)
                    ]
                });
            }
            m.delete().catch(e => console.error("Could not delete staff message:", e)); // Clean up staff's message
        });

        collector.on('end', collected => {
            if (collected.size === 0) {
                interaction.channel.send({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription('No user was mentioned in time. Add user operation cancelled.')
                            .setColor(0xffa500)
                    ]
                }).catch(e => console.error("Error sending collector end message:", e));
            }
        });
    }

    // --- Remove User from Ticket Logic ---
    else if (interaction.customId === 'remove_user_ticket') {
        if (!ticketInfo) {
            return interaction.editReply({ content: 'This does not appear to be an active ticket channel.', ephemeral: true });
        }
        if (!isStaff) {
            return interaction.editReply({ content: 'Only support staff can remove users from tickets.', ephemeral: true });
        }

        await interaction.editReply({ content: 'Please mention the user you want to remove from this ticket (e.g., `@user`). I will listen for your next message in this channel.', ephemeral: false });

        const filter = m => m.author.id === interaction.user.id && m.mentions.users.size > 0;
        const collector = interaction.channel.createMessageCollector({ filter, time: 60000, max: 1 });

        collector.on('collect', async m => {
            const userToRemove = m.mentions.users.first();
            if (!userToRemove) {
                await interaction.channel.send('No user mentioned. Please try again.');
                return;
            }

            // Prevent removing the ticket opener or the bot itself
            if (userToRemove.id === ticketInfo.userId || userToRemove.id === client.user.id) {
                await interaction.channel.send({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription('❌ Cannot remove the ticket opener or the bot from the ticket.')
                            .setColor(0xff0000)
                    ]
                });
                m.delete().catch(e => console.error("Could not delete staff message:", e));
                return;
            }

            try {
                await ticketChannel.permissionOverwrites.edit(userToRemove.id, {
                    ViewChannel: false, // Deny view access
                });
                await interaction.channel.send({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(`✅ <@${userToRemove.id}> has been removed from the ticket.`)
                            .setColor(0x2ecc71)
                    ]
                });
                // Log to a designated channel
                const logChannel = await interaction.guild.channels.fetch(TICKET_LOG_CHANNEL_ID);
                if (logChannel && logChannel.type === ChannelType.GuildText) {
                    logChannel.send({
                        embeds: [
                            new EmbedBuilder()
                                .setTitle('User Removed from Ticket')
                                .setDescription(`User ${userToRemove.tag} removed from ticket <#${ticketChannel.id}> by ${interaction.user.tag}.`)
                                .setColor(0xffa500)
                                .setTimestamp()
                        ]
                    });
                }
            } catch (error) {
                console.error('Error removing user from ticket:', error);
                await interaction.channel.send({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(`❌ Failed to remove <@${userToRemove.id}> from the ticket: \`${error.message}\`.`)
                            .setColor(0xff0000)
                    ]
                });
            }
            m.delete().catch(e => console.error("Could not delete staff message:", e));
        });

        collector.on('end', collected => {
            if (collected.size === 0) {
                interaction.channel.send({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription('No user was mentioned in time. Remove user operation cancelled.')
                            .setColor(0xffa500)
                    ]
                }).catch(e => console.error("Error sending collector end message:", e));
            }
        });
    }

    // --- Transcript Ticket Logic ---
    else if (interaction.customId === 'transcript_ticket') {
        if (!ticketInfo) {
            return interaction.editReply({ content: 'This does not appear to be an active ticket channel.', ephemeral: true });
        }
        if (!isStaff) {
            return interaction.editReply({ content: 'Only support staff can generate ticket transcripts.', ephemeral: true });
        }

        await interaction.editReply({ content: 'Generating transcript... This might take a moment.', ephemeral: true });

        try {
            const messages = await ticketChannel.messages.fetch({ limit: 100 }); // Fetch last 100 messages
            const transcript = messages.reverse().map(m =>
                `${new Date(m.createdTimestamp).toLocaleString()} - ${m.author.tag}: ${m.cleanContent}`
            ).join('\n');

            const transcriptBuffer = Buffer.from(transcript, 'utf8');
            const attachment = new AttachmentBuilder(transcriptBuffer, { name: `${ticketChannel.name}-transcript.txt` });

            const logChannel = await interaction.guild.channels.fetch(TICKET_LOG_CHANNEL_ID);
            if (logChannel && logChannel.type === ChannelType.GuildText) {
                await logChannel.send({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('Ticket Transcript Generated 📄')
                            .setDescription(`Transcript for ticket <#${ticketChannel.id}> (\`${ticketChannel.name}\`) generated by ${interaction.user.tag}.`)
                            .setColor(0x3498db) // Blue
                            .setTimestamp()
                    ],
                    files: [attachment]
                });
                await interaction.followUp({ content: 'Transcript sent to the log channel!', ephemeral: true });
            } else {
                await interaction.followUp({ content: 'Could not find the log channel to send the transcript. Please ensure it\'s configured correctly.', ephemeral: true });
            }

        } catch (error) {
            console.error('Error generating transcript:', error);
            await interaction.followUp({ content: `Failed to generate transcript: \`${error.message}\`.`, ephemeral: true });
        }
    }
});


// === Login ===
client.login(TOKEN);

// === Keepalive Server ===
// This helps keep the bot alive on platforms like Render, Replit, etc.
const app = express();
app.get('/', (req, res) => {
    res.send('Bot is alive!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Keepalive server listening on port ${PORT}`);
});
