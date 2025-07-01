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
        const vouches = loadVouches();
        const data = vouches[user.id];
        const profileEmbed = new EmbedBuilder().setColor(0x2ecc71);

        if (!data) {
            profileEmbed.setTitle('Profile Not Found ℹ️')
                 .setDescription(`${user.tag} has not received any vouches or reviews yet.`);
            return message.channel.send({ embeds: [profileEmbed] });
        }

        profileEmbed.setTitle(`${user.tag}'s Vouch & Review Profile`)
             .setThumbnail(user.displayAvatarURL())
             .addFields(
                 { name: '✅ Positive Reviews', value: `${data.positive || 0}`, inline: true },
                 { name: '❌ Negative Reviews', value: `${data.negative || 0}`, inline: true },
                 { name: 'Last Reviewed On', value: `${data.lastVouched || 'N/A'}`, inline: false }
             );

        profileEmbed.setFooter({ text: `User ID: ${user.id}` })
             .setTimestamp();

        return message.channel.send({ embeds: [profileEmbed] });
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
        const stockName = args.slice(1).join(' ');
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
        if (stock[category].length === initialLength) {
            embed.setTitle('Stock Item Not Found ❌')
                 .setDescription(`Stock item \`${stockName}\` not found in category \`${category}\`.`);
            return message.channel.send({ embeds: [embed] });
        }
        saveData();
        embed.setTitle('Stock Removed! ✅')
             .setDescription(`Stock item \`${stockName}\` has been removed from the **${category}** category.`);
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '=stockoverview' || cmd === '=stock') {
        const requestedCategory = commandWithoutPrefix === 'stockoverview' ? args[0]?.toLowerCase() : null; // "stockoverview" can take an arg, "stock" does not

        if (requestedCategory && !stock[requestedCategory]) {
            embed.setTitle('Category Not Found ❌')
                 .setDescription(`Category \`${requestedCategory}\` does not exist.`);
            return message.channel.send({ embeds: [embed] });
        }

        if (requestedCategory) {
            // Display detailed stock for a specific category
            const items = stock[requestedCategory];
            const itemsText = items.length > 0 ? items.map(item => `- ${item}`).join('\n') : 'No items in this category.';
            embed.setTitle(`📦 Stock Overview: ${requestedCategory.toUpperCase()} Category`)
                 .setDescription(itemsText)
                 .setFooter({ text: `Total items: ${items.length}` });
        } else {
            // Display all categories and their item counts (for =stockoverview or =stock)
            const categories = Object.keys(stock);
            if (categories.length === 0) {
                embed.setTitle('📦 Stock Overview')
                     .setDescription('No stock categories have been created yet.');
            } else {
                embed.setTitle('📦 All Stock Categories')
                     .setDescription('Here is an overview of all current stock categories and their item counts:')
                     .addFields(
                         categories.map(category => ({
                             name: `• ${category.toUpperCase()}`,
                             value: `Items: ${stock[category].length}`,
                             inline: true
                         }))
                     );
            }
        }
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '=cstock') {
        updateFileStock(); // Ensure fileStock is up-to-date
        const cookieCategories = Object.keys(fileStock);
        if (cookieCategories.length === 0) {
            embed.setTitle('🍪 Cookie/File Stock Overview')
                 .setDescription('No cookie/file categories found. Use `=upload <category_name>` to add some.');
        } else {
            embed.setTitle('🍪 Cookie/File Stock Overview')
                 .setDescription('Here is an overview of available cookie/file categories:')
                 .addFields(
                     cookieCategories.map(category => ({
                         name: `• ${category.toUpperCase()}`,
                         value: `Files: ${fileStock[category].length}`,
                         inline: true
                     }))
                 );
        }
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '=upload') {
        if (!isAuthorized(message.author.id)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You are not authorized to use this command.');
            return message.channel.send({ embeds: [embed] });
        }
        const category = args[0]?.toLowerCase();
        const attachment = message.attachments.first();

        if (!category) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Please provide a category name. Usage: `=upload <category> (attach ZIP file)`');
            return message.channel.send({ embeds: [embed] });
        }
        if (!attachment || !attachment.name.endsWith('.zip')) {
            embed.setTitle('Invalid Attachment ❌')
                 .setDescription('Please attach a ZIP file containing the cookies/files.');
            return message.channel.send({ embeds: [embed] });
        }

        const categoryPath = path.join(COOKIE_DIR, category);
        if (!fs.existsSync(categoryPath)) {
            fs.mkdirSync(categoryPath);
        }

        const zipFilePath = path.join(categoryPath, attachment.name);

        try {
            const response = await fetch(attachment.url);
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            fs.writeFileSync(zipFilePath, buffer);

            const zip = new AdmZip(zipFilePath);
            zip.extractAllTo(categoryPath, true); // Overwrite existing files

            fs.unlinkSync(zipFilePath); // Delete the zip file after extraction

            updateFileStock(); // Update the in-memory file stock

            embed.setTitle('Upload Successful! ✅')
                 .setDescription(`Successfully uploaded and extracted files to the **${category}** category.`)
                 .addFields({ name: 'Files Added', value: `${fileStock[category] ? fileStock[category].length : 0} total files in this category.` });
            return message.channel.send({ embeds: [embed] });

        } catch (error) {
            console.error('Error uploading/extracting zip:', error);
            embed.setTitle('Upload Failed ❌')
                 .setDescription(`An error occurred during upload or extraction: \`${error.message}\`. Ensure it's a valid ZIP file.`);
            return message.channel.send({ embeds: [embed] });
        }
    }

    if (cmd === '=cremove') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild) && !isAuthorized(message.author.id)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Server` permission or be an authorized user to use this command.');
            return message.channel.send({ embeds: [embed] });
        }
        const category = args[0]?.toLowerCase();
        if (!category) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=cremove <cookie_category>`');
            return message.channel.send({ embeds: [embed] });
        }

        const categoryPath = path.join(COOKIE_DIR, category);
        if (!fs.existsSync(categoryPath)) {
            embed.setTitle('Category Not Found ❌')
                 .setDescription(`Cookie/file category \`${category}\` does not exist.`);
            return message.channel.send({ embeds: [embed] });
        }

        try {
            // Create a zip of the category contents
            const zip = new AdmZip();
            const files = fs.readdirSync(categoryPath);
            if (files.length > 0) {
                files.forEach(file => {
                    zip.addLocalFile(path.join(categoryPath, file));
                });
                const outputZipPath = path.join(__dirname, `${category}_backup_${Date.now()}.zip`);
                zip.writeZip(outputZipPath);

                // Send the zip file to the user's DMs
                const attachment = new AttachmentBuilder(outputZipPath, { name: `${category}_backup.zip` });
                await message.author.send({
                    content: `Here is the backup of the \`${category}\` cookie/file category before deletion:`,
                    files: [attachment]
                });
                fs.unlinkSync(outputZipPath); // Delete the temp zip file
            } else {
                await message.author.send(`The \`${category}\` cookie/file category was empty, so no backup was sent.`);
            }

            // Delete the directory and its contents
            fs.rmSync(categoryPath, { recursive: true, force: true });
            updateFileStock(); // Update in-memory stock

            embed.setTitle('Category Removed! ✅')
                 .setDescription(`Cookie/file category \`${category}\` has been removed. Its contents were sent to your DMs (if any).`);
            return message.channel.send({ embeds: [embed] });

        } catch (error) {
            console.error('Error removing cookie category or sending backup:', error);
            embed.setTitle('Error Removing Category ❌')
                 .setDescription(`An error occurred: \`${error.message}\`. Check console for details.`);
            return message.channel.send({ embeds: [embed] });
        }
    }

    if (cmd === '=csend') {
        const category = args[0]?.toLowerCase();
        const targetUser = message.mentions.users.first();

        if (!message.member.roles.cache.has(STAFF_ROLE_ID) && !isAuthorized(message.author.id)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need the Staff Role or be an authorized user to use this command.');
            return message.channel.send({ embeds: [embed] });
        }

        if (!category || !targetUser) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=csend <cookie_category> @user`');
            return message.channel.send({ embeds: [embed] });
        }

        updateFileStock(); // Ensure fileStock is current

        if (!fileStock[category] || fileStock[category].length === 0) {
            embed.setTitle('Stock Empty ❌')
                 .setDescription(`The cookie/file category \`${category}\` is empty or does not exist.`);
            return message.channel.send({ embeds: [embed] });
        }

        const filePath = path.join(COOKIE_DIR, category, fileStock[category][0]);
        if (!fs.existsSync(filePath)) {
            embed.setTitle('File Not Found ❌')
                 .setDescription(`The first file in category \`${category}\` was not found on disk. It might have been moved or deleted manually.`);
            return message.channel.send({ embeds: [embed] });
        }

        try {
            const attachment = new AttachmentBuilder(filePath);
            await targetUser.send({
                content: `Here is a file from the \`${category}\` category you requested:`,
                files: [attachment]
            });

            // Remove the sent file from disk and update stock
            fs.unlinkSync(filePath);
            updateFileStock();

            embed.setTitle('File Sent! ✅')
                 .setDescription(`Successfully sent a file from \`${category}\` to ${targetUser.tag}'s DMs.`)
                 .addFields({ name: 'Remaining in Category', value: `${fileStock[category] ? fileStock[category].length : 0} files.` });
            return message.channel.send({ embeds: [embed] });

        } catch (error) {
            console.error(`Error sending cookie/file to ${targetUser.tag}:`, error);
            embed.setTitle('Send Failed ❌')
                 .setDescription(`Could not send the file to ${targetUser.tag}. They might have DMs disabled or an internal error occurred: \`${error.message}\`.`);
            return message.channel.send({ embeds: [embed] });
        }
    }

    if (cmd === '=redeem') {
        const hexCode = args[0]?.toUpperCase();
        if (!hexCode) {
            embed.setTitle('Invalid Usage ❌')
                 .setDescription('Usage: `=redeem <hex_code>`');
            return message.channel.send({ embeds: [embed] });
        }

        const codeData = generatedCodes[hexCode];
        if (!codeData) {
            embed.setTitle('Code Not Found ❌')
                 .setDescription('The provided hex code is invalid or has expired.');
            return message.channel.send({ embeds: [embed] });
        }

        if (codeData.redeemed) {
            embed.setTitle('Code Already Redeemed ⚠️')
                 .setDescription(`This code has already been redeemed by <@${codeData.redeemedBy}> on ${new Date(codeData.redeemedAt).toLocaleString()}.`);
            return message.channel.send({ embeds: [embed] });
        }

        // Only staff can redeem the codes to view full info.
        if (!message.member.roles.cache.has(STAFF_ROLE_ID) && !isAuthorized(message.author.id)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('Only staff can redeem codes to view full details.');
            return message.channel.send({ embeds: [embed] });
        }


        // Mark as redeemed and store who redeemed it and when
        codeData.redeemed = true;
        codeData.redeemedBy = message.author.id;
        codeData.redeemedAt = new Date().toISOString();

        embed.setTitle('Code Redeemed Successfully! ✅')
             .setDescription(`Hex Code: \`${hexCode}\``)
             .addFields(
                 { name: 'Category', value: codeData.category, inline: true },
                 { name: 'Item', value: codeData.stockName, inline: true },
                 { name: 'Generated By', value: `<@${codeData.generatedBy}>`, inline: true },
                 { name: 'Generated At', value: new Date(codeData.timestamp).toLocaleString(), inline: false },
                 { name: 'Redeemed By', value: `<@${codeData.redeemedBy}>`, inline: true },
                 { name: 'Redeemed At', value: new Date(codeData.redeemedAt).toLocaleString(), inline: true }
             )
             .setColor(0x2ecc71); // Green for successful redemption

        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '=pls') {
        if (message.channel.type === ChannelType.DM) {
            embed.setTitle('Command Restricted 🚫')
                 .setDescription('This command can only be used in a server channel.');
            return message.channel.send({ embeds: [embed] });
        }

        const userId = message.author.id;
        const now = Date.now();
        const oneHour = 60 * 60 * 1000; // 1 hour in milliseconds

        if (plsRequests[userId] && (now - plsRequests[userId].timestamp < oneHour) && !plsRequests[userId].vouchUsed) {
            embed.setTitle('Request on Cooldown ⏳')
                 .setDescription('You can only make one `pls` request per hour, unless you have received a vouch from your previous request. Please wait or receive a vouch to use again.')
                 .setColor(0xffa500);
            return message.channel.send({ embeds: [embed] });
        }

        plsRequests[userId] = {
            timestamp: now,
            vouchUsed: false // Reset for new request
        };

        embed.setTitle('PLS Request Received! 🙏')
             .setDescription(`${message.author.tag} is asking for a vouch! If you've had a good interaction, please consider giving them a +vouch!\n\nThis user is now eligible to receive one vouch/review.`)
             .setColor(0xffd700); // Gold color
        message.channel.send({ embeds: [embed] });
        return message.delete(); // Delete the =pls message
    }


    if (cmd === '=backup') {
        if (!isAuthorized(message.author.id)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You are not authorized to use this command.');
            return message.channel.send({ embeds: [embed] });
        }

        try {
            const zip = new AdmZip();
            const filesToBackup = [VOUCH_PATH, STOCK_PATH, ROLES_PATH, REDEEMED_PATH, CHANNEL_RESTRICTIONS_PATH, COOLDOWN_PATH, TICKETS_DATA_PATH];

            filesToBackup.forEach(filePath => {
                if (fs.existsSync(filePath)) {
                    zip.addLocalFile(filePath, path.dirname(filePath) === '.' ? '' : path.dirname(filePath)); // Add to root of zip if no dir, else maintain path
                }
            });

            // Create a temporary zip file
            const backupZipPath = path.join(__dirname, `bot_data_backup_${Date.now()}.zip`);
            zip.writeZip(backupZipPath);

            const attachment = new AttachmentBuilder(backupZipPath, { name: 'bot_data_backup.zip' });
            await message.author.send({
                content: 'Here is your bot data backup:',
                files: [attachment]
            });
            fs.unlinkSync(backupZipPath); // Delete the temp zip file

            embed.setTitle('Backup Sent! ✅')
                 .setDescription('All bot data files have been sent to your DMs.');
            return message.channel.send({ embeds: [embed] });

        } catch (error) {
            console.error('Error creating or sending backup:', error);
            embed.setTitle('Backup Failed ❌')
                 .setDescription(`An error occurred during backup: \`${error.message}\`. Check console for details.`);
            return message.channel.send({ embeds: [embed] });
        }
    }

    if (cmd === '=timesaved') {
        if (!isAuthorized(message.author.id)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You are not authorized to use this command.');
            return message.channel.send({ embeds: [embed] });
        }

        const attachment = message.attachments.first();
        if (!attachment || !attachment.name.endsWith('.zip')) {
            embed.setTitle('Invalid Attachment ❌')
                 .setDescription('Please attach the `bot_data_backup.zip` file.');
            return message.channel.send({ embeds: [embed] });
        }

        const restoreZipPath = path.join(__dirname, attachment.name);
        try {
            const response = await fetch(attachment.url);
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            fs.writeFileSync(restoreZipPath, buffer);

            const zip = new AdmZip(restoreZipPath);
            zip.extractAllTo(__dirname, true); // Extract to current directory, overwriting existing

            fs.unlinkSync(restoreZipPath); // Delete the zip file after extraction

            loadData(); // Reload all data after restoration
            updateFileStock(); // Rescan cookie directories
            updateDynamicCommandMap(); // Rebuild dynamic commands

            embed.setTitle('Restore Successful! ✅')
                 .setDescription('Bot data has been successfully restored from the provided backup.');
            return message.channel.send({ embeds: [embed] });

        } catch (error) {
            console.error('Error restoring data:', error);
            embed.setTitle('Restore Failed ❌')
                 .setDescription(`An error occurred during data restoration: \`${error.message}\`. Ensure the zip file is valid and bot has write permissions.`);
            return message.channel.send({ embeds: [embed] });
        }
    }

    if (cmd === '=debug') {
        if (!isAuthorized(message.author.id)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You are not authorized to use this command.');
            return message.channel.send({ embeds: [embed] });
        }

        // Prepare debug information
        const debugInfo = {
            stock: stock,
            redeemed: redeemed,
            rolesAllowed: rolesAllowed,
            channelRestrictions: channelRestrictions,
            cooldowns: cooldowns,
            activeTickets: activeTickets,
            ticketPanelInfo: ticketPanelInfo,
            generatedCodes: Object.keys(generatedCodes).length, // Only count to avoid large output
            plsRequests: Object.keys(plsRequests).length, // Only count
            dynamicCommandMap: dynamicCommandMap,
            fileStock: fileStock,
            uptime: process.uptime(), // Bot uptime in seconds
            memoryUsage: process.memoryUsage() // Node.js memory usage
        };

        // Send as a file if too large for embed description
        const debugString = JSON.stringify(debugInfo, null, 2);
        if (debugString.length > 2000) { // Discord embed description limit is 4096, but 2000 is safer for formatting
            const debugFilePath = path.join(__dirname, 'debug_info.json');
            fs.writeFileSync(debugFilePath, debugString);
            const attachment = new AttachmentBuilder(debugFilePath, { name: 'debug_info.json' });
            await message.author.send({
                content: 'Here is the current debug information:',
                files: [attachment]
            });
            fs.unlinkSync(debugFilePath);
            embed.setTitle('Debug Info Sent! ✅')
                 .setDescription('The debug information was too large for an embed and has been sent to your DMs as a file.');
        } else {
            embed.setTitle('⚙️ Bot Debug Information')
                 .setDescription(`\`\`\`json\n${debugString}\n\`\`\``);
        }
        return message.channel.send({ embeds: [embed] });
    }

    if (cmd === '=check') {
        const uptimeSeconds = process.uptime();
        const uptimeString = new Date(uptimeSeconds * 1000).toISOString().substr(11, 8); // HH:MM:SS
        const memoryUsage = process.memoryUsage();
        const usedMemoryMB = (memoryUsage.heapUsed / 1024 / 1024).toFixed(2);
        const totalMemoryMB = (memoryUsage.heapTotal / 1024 / 1024).toFixed(2);

        embed.setTitle('✅ Bot Status')
             .setDescription(`I am online and operational!`)
             .addFields(
                 { name: 'Uptime', value: `\`${uptimeString}\``, inline: true },
                 { name: 'Memory Usage (Heap)', value: `\`${usedMemoryMB}MB / ${totalMemoryMB}MB\``, inline: true },
                 { name: 'Ping', value: `\`${client.ws.ping}ms\``, inline: true }
             )
             .setColor(0x2ecc71)
             .setTimestamp();
        return message.channel.send({ embeds: [embed] });
    }
});


// === Interaction Handler (for buttons) ===
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    const { customId, channel, member, guild, message } = interaction;
    const embed = new EmbedBuilder().setColor(0x3498db); // Default embed color for interactions

    if (customId === 'open_ticket') {
        await interaction.deferReply({ ephemeral: true }); // Acknowledge the interaction
        const result = await createTicketChannel(member, guild);
        return interaction.followUp({ embeds: [result.embed], ephemeral: true });
    }

    if (customId === 'close_ticket') {
        await interaction.deferReply({ ephemeral: true });
        const channelIdToClose = channel.id;
        const ticketData = activeTickets[channelIdToClose];

        if (!ticketData) {
            embed.setTitle('Not a Ticket Channel ℹ️')
                 .setDescription('This button can only be used in an active ticket channel.');
            return interaction.followUp({ embeds: [embed], ephemeral: true });
        }

        const isAuthorizedToClose = interaction.user.id === ticketData.userId || member.permissions.has(PermissionsBitField.Flags.ManageChannels) || isAuthorized(interaction.user.id);

        if (!isAuthorizedToClose) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need to be the ticket creator, an authorized user, or have `Manage Channels` permission to close this ticket.');
            return interaction.followUp({ embeds: [embed], ephemeral: true });
        }

        try {
            embed.setTitle('Closing Ticket... ⏳')
                 .setDescription('This ticket will be closed shortly.')
                 .setColor(0xffa500);
            await channel.send({ embeds: [embed] }); // Send closing message in the ticket channel

            const logEmbed = new EmbedBuilder()
                .setTitle('Ticket Closed 🗑️')
                .setDescription(`Ticket channel ${channel.name} (ID: ${channelIdToClose}) closed by ${interaction.user}.`)
                .addFields(
                    { name: 'Opened By', value: `<@${ticketData.userId}>`, inline: true },
                    { name: 'Reason', value: ticketData.reason, inline: true },
                    { name: 'Opened At', value: new Date(ticketData.openedAt).toLocaleString(), inline: false }
                )
                .setColor(0xff0000)
                .setTimestamp();

            if (TICKET_LOG_CHANNEL_ID) {
                const logChannel = await guild.channels.cache.get(TICKET_LOG_CHANNEL_ID);
                if (logChannel) {
                    logChannel.send({ embeds: [logEmbed] });
                }
            }

            delete activeTickets[channelIdToClose];
            saveTicketsData();

            await channel.delete('Ticket closed via button interaction.');
            return interaction.followUp({ content: 'Ticket closed successfully!', ephemeral: true });

        } catch (error) {
            console.error('Error closing ticket via button:', error);
            embed.setTitle('Error Closing Ticket ❌')
                 .setDescription(`An error occurred while closing the ticket: \`${error.message}\``);
            return interaction.followUp({ embeds: [embed], ephemeral: true });
        }
    }

    if (customId === 'claim_ticket') {
        await interaction.deferReply({ ephemeral: true });

        const channelId = channel.id;
        const ticketData = activeTickets[channelId];

        if (!ticketData) {
            embed.setTitle('Not a Ticket Channel ℹ️')
                 .setDescription('This button can only be used in an active ticket channel.');
            return interaction.followUp({ embeds: [embed], ephemeral: true });
        }

        if (!member.roles.cache.has(STAFF_ROLE_ID) && !isAuthorized(interaction.user.id)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need the Staff Role or be an authorized user to claim tickets.');
            return interaction.followUp({ embeds: [embed], ephemeral: true });
        }

        if (ticketData.claimedBy) {
            embed.setTitle('Ticket Already Claimed ⚠️')
                 .setDescription(`This ticket has already been claimed by <@${ticketData.claimedBy}>.`);
            return interaction.followUp({ embeds: [embed], ephemeral: true });
        }

        ticketData.claimedBy = interaction.user.id;
        saveTicketsData();

        embed.setTitle('Ticket Claimed! 🙋‍♂️')
             .setDescription(`This ticket has been claimed by ${interaction.user}. They will assist you shortly.`);
        await channel.send({ embeds: [embed] }); // Send in the ticket channel

        // Update the original message buttons (optional, to show it's claimed)
        if (message) {
            const updatedActionRow = ActionRowBuilder.from(message.components[0]);
            const claimButton = updatedActionRow.components.find(btn => btn.customId === 'claim_ticket');
            if (claimButton) {
                claimButton.setDisabled(true).setLabel(`Claimed by ${interaction.user.username}`);
            }
            await message.edit({ components: [updatedActionRow] });
        }

        return interaction.followUp({ content: 'You have successfully claimed this ticket!', ephemeral: true });
    }

    if (customId === 'add_user_ticket') {
        await interaction.deferReply({ ephemeral: true });

        const channelId = channel.id;
        const ticketData = activeTickets[channelId];

        if (!ticketData) {
            embed.setTitle('Not a Ticket Channel ℹ️')
                 .setDescription('This button can only be used in an active ticket channel.');
            return interaction.followUp({ embeds: [embed], ephemeral: true });
        }

        if (!member.permissions.has(PermissionsBitField.Flags.ManageChannels) && !isAuthorized(interaction.user.id)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Channels` permission or be an authorized user to add users to tickets.');
            return interaction.followUp({ embeds: [embed], ephemeral: true });
        }

        const modal = new ModalBuilder()
            .setCustomId('add_user_modal')
            .setTitle('Add User to Ticket');

        const userIdInput = new TextInputBuilder()
            .setCustomId('userId')
            .setLabel('User ID or Mention (e.g., 123456789012345678 or @user)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Enter User ID or mention them')
            .setRequired(true);

        const firstActionRow = new ActionRowBuilder().addComponents(userIdInput);
        modal.addComponents(firstActionRow);

        await interaction.showModal(modal);
    }

    if (customId === 'remove_user_ticket') {
        await interaction.deferReply({ ephemeral: true });

        const channelId = channel.id;
        const ticketData = activeTickets[channelId];

        if (!ticketData) {
            embed.setTitle('Not a Ticket Channel ℹ️')
                 .setDescription('This button can only be used in an active ticket channel.');
            return interaction.followUp({ embeds: [embed], ephemeral: true });
        }

        if (!member.permissions.has(PermissionsBitField.Flags.ManageChannels) && !isAuthorized(interaction.user.id)) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Channels` permission or be an authorized user to remove users from tickets.');
            return interaction.followUp({ embeds: [embed], ephemeral: true });
        }

        const modal = new ModalBuilder()
            .setCustomId('remove_user_modal')
            .setTitle('Remove User from Ticket');

        const userIdInput = new TextInputBuilder()
            .setCustomId('userId')
            .setLabel('User ID or Mention (e.g., 123456789012345678 or @user)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Enter User ID or mention them')
            .setRequired(true);

        const firstActionRow = new ActionRowBuilder().addComponents(userIdInput);
        modal.addComponents(firstActionRow);

        await interaction.showModal(modal);
    }

    if (customId === 'transcript_ticket') {
        await interaction.deferReply({ ephemeral: true });
        const channelId = channel.id;
        const ticketData = activeTickets[channelId];

        if (!ticketData) {
            embed.setTitle('Not a Ticket Channel ℹ️')
                 .setDescription('This button can only be used in an active ticket channel.');
            return interaction.followUp({ embeds: [embed], ephemeral: true });
        }

        if (!member.permissions.has(PermissionsBitField.Flags.ManageChannels) && !isAuthorized(interaction.user.id) && interaction.user.id !== ticketData.userId) {
            embed.setTitle('Permission Denied 🚫')
                 .setDescription('You need `Manage Channels` permission, be an authorized user, or the ticket creator to generate a transcript.');
            return interaction.followUp({ embeds: [embed], ephemeral: true });
        }

        try {
            const fetchedMessages = await channel.messages.fetch({ limit: 100 }); // Fetch last 100 messages
            const messagesArray = Array.from(fetchedMessages.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);

            let transcriptContent = `Ticket Transcript for #${channel.name} (ID: ${channel.id})\n`;
            transcriptContent += `Opened by: ${ticketData.userId} on ${new Date(ticketData.openedAt).toLocaleString()}\n`;
            if (ticketData.reason) transcriptContent += `Reason: ${ticketData.reason}\n`;
            if (ticketData.claimedBy) transcriptContent += `Claimed by: ${ticketData.claimedBy}\n`;
            transcriptContent += '------------------------------------\n\n';

            messagesArray.forEach(msg => {
                const authorTag = msg.author.tag;
                const timestamp = new Date(msg.createdTimestamp).toLocaleString();
                let content = msg.content;

                // Handle embeds (simple representation)
                if (msg.embeds.length > 0) {
                    msg.embeds.forEach(emb => {
                        content += `\n[EMBED] Title: ${emb.title || 'N/A'}`;
                        if (emb.description) content += `\nDescription: ${emb.description}`;
                        if (emb.fields.length > 0) {
                            emb.fields.forEach(field => content += `\n  Field: ${field.name} - ${field.value}`);
                        }
                    });
                }
                // Handle attachments (list filenames)
                if (msg.attachments.size > 0) {
                    content += `\n[ATTACHMENTS]: ${Array.from(msg.attachments.values()).map(att => att.name).join(', ')}`;
                }

                transcriptContent += `[${timestamp}] ${authorTag}: ${content}\n`;
            });

            const transcriptBuffer = Buffer.from(transcriptContent, 'utf-8');
            const attachment = new AttachmentBuilder(transcriptBuffer, { name: `transcript-${channel.name}.txt` });

            const logChannel = await guild.channels.cache.get(TICKET_LOG_CHANNEL_ID);
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


client.on('modalSubmit', async modal => {
    if (modal.customId === 'add_user_modal') {
        await modal.deferReply({ ephemeral: true });
        const userIdOrMention = modal.fields.getTextInputValue('userId');
        const channel = modal.channel;

        const ticketData = activeTickets[channel.id];
        if (!ticketData) {
            return modal.followUp({ content: 'This is not an active ticket channel.', ephemeral: true });
        }

        if (!modal.member.permissions.has(PermissionsBitField.Flags.ManageChannels) && !isAuthorized(modal.user.id)) {
            return modal.followUp({ content: 'You do not have permission to add users to tickets.', ephemeral: true });
        }

        try {
            let targetUser;
            const userIdMatch = userIdOrMention.match(/\d+/); // Extract ID from mention or plain ID
            const targetId = userIdMatch ? userIdMatch[0] : null;

            if (targetId) {
                targetUser = await modal.guild.members.fetch(targetId).catch(() => null);
            }

            if (!targetUser) {
                return modal.followUp({ content: 'Could not find the user. Please provide a valid User ID or mention.', ephemeral: true });
            }

            // Check if user is already in the channel
            const currentPermissions = channel.permissionsFor(targetUser);
            if (currentPermissions.has(PermissionsBitField.Flags.ViewChannel)) {
                return modal.followUp({ content: `${targetUser.user.tag} is already in this ticket channel.`, ephemeral: true });
            }

            await channel.permissionOverwrites.edit(targetUser.id, {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true,
            });

            await channel.send({ embeds: [
                new EmbedBuilder()
                    .setTitle('User Added to Ticket ➕')
                    .setDescription(`${targetUser.user.tag} has been added to the ticket by ${modal.user.tag}.`)
                    .setColor(0x00ff00)
            ]});
            return modal.followUp({ content: `${targetUser.user.tag} has been successfully added to the ticket.`, ephemeral: true });

        } catch (error) {
            console.error('Error adding user to ticket:', error);
            return modal.followUp({ content: `Failed to add user: \`${error.message}\`. Please ensure the bot has necessary permissions.`, ephemeral: true });
        }
    }

    if (modal.customId === 'remove_user_modal') {
        await modal.deferReply({ ephemeral: true });
        const userIdOrMention = modal.fields.getTextInputValue('userId');
        const channel = modal.channel;

        const ticketData = activeTickets[channel.id];
        if (!ticketData) {
            return modal.followUp({ content: 'This is not an active ticket channel.', ephemeral: true });
        }

        if (!modal.member.permissions.has(PermissionsBitField.Flags.ManageChannels) && !isAuthorized(modal.user.id)) {
            return modal.followUp({ content: 'You do not have permission to remove users from tickets.', ephemeral: true });
        }

        try {
            let targetUser;
            const userIdMatch = userIdOrMention.match(/\d+/);
            const targetId = userIdMatch ? userIdMatch[0] : null;

            if (targetId) {
                targetUser = await modal.guild.members.fetch(targetId).catch(() => null);
            }

            if (!targetUser) {
                return modal.followUp({ content: 'Could not find the user. Please provide a valid User ID or mention.', ephemeral: true });
            }

            // Prevent removing the ticket creator or the bot itself
            if (targetUser.id === ticketData.userId) {
                return modal.followUp({ content: 'You cannot remove the ticket creator from the ticket.', ephemeral: true });
            }
            if (targetUser.id === modal.client.user.id) {
                return modal.followUp({ content: 'You cannot remove the bot from the ticket.', ephemeral: true });
            }


            // Check if user is actually in the channel
            const currentPermissions = channel.permissionsFor(targetUser);
            if (!currentPermissions.has(PermissionsBitField.Flags.ViewChannel)) {
                return modal.followUp({ content: `${targetUser.user.tag} is not currently in this ticket channel.`, ephemeral: true });
            }

            await channel.permissionOverwrites.edit(targetUser.id, {
                ViewChannel: false,
                SendMessages: false,
                ReadMessageHistory: false,
            });

            await channel.send({ embeds: [
                new EmbedBuilder()
                    .setTitle('User Removed from Ticket ➖')
                    .setDescription(`${targetUser.user.tag} has been removed from the ticket by ${modal.user.tag}.`)
                    .setColor(0xff0000)
            ]});
            return modal.followUp({ content: `${targetUser.user.tag} has been successfully removed from the ticket.`, ephemeral: true });

        } catch (error) {
            console.error('Error removing user from ticket:', error);
            return modal.followUp({ content: `Failed to remove user: \`${error.message}\`. Please ensure the bot has necessary permissions.`, ephemeral: true });
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
