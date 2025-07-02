const { Client, GatewayIntentBits, Partials, AttachmentBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const express = require('express');

// === Consolidated Config & Constants ===
// IMPORTANT: Replace these with your actual Discord IDs
const TOKEN = process.env.TOKEN || 'YOUR_BOT_TOKEN'; // Your bot's token
const OWNER_ID = '1110864648787480656'; // Your Discord User ID - ONLY THIS USER CAN SETUP THE TICKET PANEL
// Combined Authorized Users from both files
const AUTHORIZED_USERS = [
    '1389567581853319268', // From zaid 1234.txt
    '1110864648787480656', // From both
    '1380028507228209232', // From zaid 1234.txt
    '1333798275601662056', // From both
    '1212961835582623755'  // From zaid 123.txt
];

// --- Consolidated Staff Role ---
// This role will be used for:
// - The role to be pinged when a new ticket is created
// - The role that can manage/claim tickets
// - The role that can use =redeem command
const STAFF_ROLE_ID = '1376539272714260501'; // <--- IMPORTANT: REPLACE WITH YOUR STAFF ROLE ID
const REDEEM_ALLOWED_ROLE_ID = STAFF_ROLE_ID; // Using STAFF_ROLE_ID for redeem as it was 1376539272714260501 in both

// --- Ticket System Channel IDs ---
const TICKET_CATEGORY_ID = '1385685111177089045'; // <--- IMPORTANT: REPLACE WITH YOUR TICKET CATEGORY ID
const TICKET_LOG_CHANNEL_ID = '1385685463142240356'; // <--- IMPORTANT: REPLACE WITH YOUR TICKET LOG CHANNEL ID

// --- Other Specific Channel/Role IDs ---
const CSEND_REQUIRED_ROLE_ID = '1374250200511680656'; // Example Role ID for =csend command (from zaid 123.txt)
const VOUCH_CHANNEL_ID = '1374018342444204067'; // <--- IMPORTANT: SET YOUR VOUCH CHANNEL ID HERE (from zaid 123.txt)

// === Data Directories & Paths ===
const DATA_DIR = './data'; // Common in both
const COOKIE_DIR = './cookies'; // From zaid 123.txt

// Specific data files
const TICKETS_DATA_PATH = './data/tickets.json'; // From zaid 1234.txt
const VOUCH_PATH = './vouches.json'; // From zaid 123.txt
const STOCK_PATH = './data/stock.json'; // From zaid 123.txt
const ROLES_PATH = './data/roles.json'; // From zaid 123.txt
const REDEEMED_PATH = './data/redeemed.json'; // From zaid 123.txt
const CHANNEL_RESTRICTIONS_PATH = './data/channelRestrictions.json'; // From zaid 123.txt
const COOLDOWN_PATH = './data/cooldowns.json'; // From zaid 123.txt

// === Ensure directories exist ===
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(COOKIE_DIR)) fs.mkdirSync(COOKIE_DIR);

// Ensure all JSON files exist with default empty objects
[
    TICKETS_DATA_PATH, VOUCH_PATH, STOCK_PATH, ROLES_PATH,
    REDEEMED_PATH, CHANNEL_RESTRICTIONS_PATH, COOLDOWN_PATH
].forEach(filePath => {
    if (!fs.existsSync(filePath)) {
        console.log(`${path.basename(filePath)} not found, creating new one.`);
        // Special handling for tickets.json to include ticketPanelInfo
        if (filePath === TICKETS_DATA_PATH) {
            fs.writeFileSync(filePath, JSON.stringify({ activeTickets: {}, ticketPanelInfo: { channelId: null, messageId: null } }));
        } else {
            fs.writeFileSync(filePath, JSON.stringify({}));
        }
    }
});

// === Global data stores ===
// Ticket System Data (from zaid 1234.txt)
let activeTickets = {};        // { ticketChannelId: { userId: string, openedAt: string, reason: string, claimedBy?: string, guildId: string, scheduledDeletionTimestamp?: number } }
let ticketPanelInfo = {        // Stores ticket panel message and channel IDs
    channelId: null,
    messageId: null
};

// General Bot Data (from zaid 123.txt)
let rolesAllowed = {};         // { commandName: roleId }
let stock = {};                // { category: [item1, item2, ...] }
let redeemed = {};             // { hexCode: { redeemed: boolean, ... } } (Note: This was for manual redemption, now replaced by generatedCodes)
let channelRestrictions = {};  // { commandName: channelId }
let cooldowns = {};            // { commandName: { duration: seconds, lastUsed: { userId: timestamp_ms } } }

// Stores generated unique codes: { hexCode: { redeemed: boolean, category: string, stockName: string, generatedBy: string, timestamp: string } }
const generatedCodes = {}; // In-memory for current session

// Tracks users who have used =pls and are eligible for a single vouch
const plsRequests = {}; // { userId: { timestamp: number, vouchUsed: boolean } }

// This will now map dynamic command names (e.g., 'fgen') to their categories ('free')
const dynamicCommandMap = {};

// Set of all static command names (without '=') for validation
const ALL_STATIC_COMMAND_NAMES = new Set([
    'vouch', 'mvouch', // for +vouch and -vouch, +mvouch, -mvouch
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
    'cool',
    'timesaved',
    // Ticket System Commands (added from zaid 1234.txt)
    'ticket', 'newticket', 'closeticket', 'setuppanel'
]);

// Stores timeout IDs for scheduled ticket deletions (transient, not persisted)
const scheduledTimeouts = new Map(); // { channelId: timeoutId }

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

// Specific loader/saver for consolidated ticket data
function loadTicketsData() {
    const data = loadJSON(TICKETS_DATA_PATH, { activeTickets: {}, ticketPanelInfo: { channelId: null, messageId: null } });
    activeTickets = data.activeTickets || {};
    ticketPanelInfo = data.ticketPanelInfo || { channelId: null, messageId: null };
}

function saveTicketsData() {
    saveJSON(TICKETS_DATA_PATH, { activeTickets, ticketPanelInfo });
}

// Specific loaders/savers for general bot data
function loadVouches() { return loadJSON(VOUCH_PATH); }
function saveVouches(data) { saveJSON(VOUCH_PATH, data); }
function loadCooldowns() { return loadJSON(COOLDOWN_PATH); }
function saveCooldowns(data) { saveJSON(COOLDOWN_PATH, data); }

// Main data loader/saver for stock, roles, restrictions, cooldowns
function loadBotData() {
    stock = loadJSON(STOCK_PATH);
    redeemed = loadJSON(REDEEMED_PATH); // This 'redeemed' is for manual redemption, 'generatedCodes' is in-memory
    rolesAllowed = loadJSON(ROLES_PATH);
    channelRestrictions = loadJSON(CHANNEL_RESTRICTIONS_PATH);
    cooldowns = loadCooldowns();
}

function saveBotData() {
    saveJSON(STOCK_PATH, stock);
    saveJSON(REDEEMED_PATH, redeemed);
    saveJSON(ROLES_PATH, rolesAllowed);
    saveJSON(CHANNEL_RESTRICTIONS_PATH, channelRestrictions);
    saveCooldowns(cooldowns);
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
loadTicketsData(); // Load ticket system data
loadBotData();     // Load general bot data
updateFileStock();
updateDynamicCommandMap(); // Populate map on startup

// Function to check if user is authorized for general bot admin commands
const isAuthorized = (userId) => AUTHORIZED_USERS.includes(userId);

// === Ticket Deletion Scheduling Functions ===
async function scheduleTicketDeletion(channelId, delayMs) {
    // Clear any existing timeout for this channel to prevent duplicates
    if (scheduledTimeouts.has(channelId)) {
        clearTimeout(scheduledTimeouts.get(channelId));
        scheduledTimeouts.delete(channelId);
    }

    const timeout = setTimeout(async () => {
        console.log(`Attempting to delete ticket channel ${channelId} after scheduled delay.`);
        const ticketData = activeTickets[channelId];
        if (!ticketData) {
            console.log(`Ticket data for ${channelId} not found during scheduled deletion, likely already deleted.`);
            scheduledTimeouts.delete(channelId);
            return;
        }

        try {
            const guild = client.guilds.cache.get(ticketData.guildId); // Use stored guildId
            if (!guild) {
                console.error(`Guild for ticket ${channelId} not found during scheduled deletion.`);
                return;
            }
            const channel = await guild.channels.fetch(channelId).catch(() => null);

            if (channel && channel.deletable) {
                const logEmbed = new EmbedBuilder()
                    .setTitle('Ticket Auto-Deleted (Scheduled) 💥')
                    .setDescription(`Ticket channel ${channel.name} (ID: ${channel.id}) was auto-deleted after 6 hours due to \`=pls\` command usage.`)
                    .addFields(
                        { name: 'Opened By', value: `<@${ticketData.userId}>`, inline: true },
                        { name: 'Reason', value: ticketData.reason, inline: true }
                    )
                    .setColor(0xffa500) // Orange for warning/auto-action
                    .setTimestamp();

                if (TICKET_LOG_CHANNEL_ID) {
                    const logChannel = await guild.channels.cache.get(TICKET_LOG_CHANNEL_ID);
                    if (logChannel) {
                        logChannel.send({ embeds: [logEmbed] });
                    }
                }

                await channel.send({ embeds: [
                    new EmbedBuilder()
                        .setTitle('Ticket Deleting... ⏳')
                        .setDescription('This ticket is now being automatically deleted due to the use of the `=pls` command.')
                        .setColor(0xffa500)
                ]});
                await channel.delete('Scheduled deletion due to =pls command.');
                console.log(`Ticket channel ${channelId} deleted successfully.`);
            } else {
                console.warn(`Channel ${channelId} not found or not deletable during scheduled deletion.`);
            }
        } catch (error) {
            console.error(`Error during scheduled ticket deletion for ${channelId}:`, error);
        } finally {
            // Clean up activeTickets and scheduledTimeouts regardless of deletion success
            delete activeTickets[channelId];
            saveTicketsData();
            scheduledTimeouts.delete(channelId);
        }
    }, delayMs);

    scheduledTimeouts.set(channelId, timeout);
    console.log(`Ticket ${channelId} scheduled for deletion in ${delayMs / 1000} seconds.`);
}

function cancelTicketDeletion(channelId) {
    if (scheduledTimeouts.has(channelId)) {
        clearTimeout(scheduledTimeouts.get(channelId));
        scheduledTimeouts.delete(channelId);
        console.log(`Cancelled scheduled deletion for ticket ${channelId}.`);
    }
    // Also remove the timestamp from persisted data
    if (activeTickets[channelId]) {
        activeTickets[channelId].scheduledDeletionTimestamp = null;
        saveTicketsData();
    }
}

// === Client Setup ===
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers, // Required for fetching members and roles
    ],
    partials: [Partials.Channel, Partials.Message, Partials.GuildMember], // Required for caching members and channels
});

client.once('ready', async () => {
    console.log(`✅ Bot Logged in as ${client.user.tag}`);

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

    // NEW: Re-schedule pending ticket deletions on bot startup
    for (const channelId in activeTickets) {
        const ticket = activeTickets[channelId];
        if (ticket.scheduledDeletionTimestamp) {
            const remainingTime = ticket.scheduledDeletionTimestamp - Date.now();
            if (remainingTime > 0) {
                console.log(`Re-scheduling deletion for ticket ${channelId}. Remaining: ${remainingTime / 1000}s`);
                scheduleTicketDeletion(channelId, remainingTime);
            } else {
                // Ticket was due for deletion during downtime, delete it now (with a small delay to allow bot to fully start)
                console.log(`Ticket ${channelId} was due for deletion. Scheduling immediate deletion.`);
                await scheduleTicketDeletion(channelId, 1000); // Schedule for 1 second later
            }
        }
    }
});

function generateHexCode() {
    return Math.random().toString(16).substring(2, 8).toUpperCase();
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
            claimedBy: null, // Initially not claimed
            guildId: guild.id, // NEW: Store guild ID for scheduled deletion
            scheduledDeletionTimestamp: null // NEW: Initialize as null
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
    // Many commands require message.member or message.guild.permissions, etc.
    // If it's not a guild message, these properties will be null.
    // We explicitly allow =backup to proceed without a guild context check, as it DMs the user.
    // All other commands that manage server data or check roles/permissions should be restricted to guilds.
    if (!message.guild && commandWithoutPrefix !== 'backup') {
        if (message.channel.type === ChannelType.DM) {
            embed.setTitle('Command Restricted 🚫')
                 .setDescription('This command can only be used in a server channel.');
            return message.channel.send({ embeds: [embed] });
        }
        return; // For messages not in DMs but still not in a guild (rare, but good for safety)
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

    // --- Dynamic Command Handling (e.g., =fgen) ---
    const categoryForDynamicCmd = dynamicCommandMap[commandWithoutPrefix];
    if (categoryForDynamicCmd) {
        await handleDynamicGenCommand(message, categoryForDynamicCmd);
        return;
    }

    // === Static Command Handling ===

    // --- Ticket System Commands ---
    if (cmd === '=ticket' || cmd === '=newticket') {
        const reason = args.slice(1).join(' ');
        const result = await createTicketChannel(message.member, message.guild, reason);
        return message.channel.send({ embeds: [result.embed] });
    }

    if (cmd === '=closeticket') {
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
                // NEW: Cancel any pending scheduled deletion
                cancelTicketDeletion(channelIdToClose);

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

                await ticketChannel.delete('Ticket closed by user or staff.');
                delete activeTickets[channelIdToClose]; // Remove from activeTickets after channel deletion
                saveTicketsData();
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

    // --- Vouch System Commands ---
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
        // If the intent was to reduce positive vouches, that logic needs to be added.
        // Keeping it simple as per original code: "-mvouches @user to remove the vouches" -> implies adding negative.

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

    // --- Stock Management Commands ---
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
        saveBotData();
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
        saveBotData();

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
        saveBotData();
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
            saveBotData();
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
        saveBotData();
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
            saveBotData();
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
        saveBotData();
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
            saveBotData();
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

        // NEW: Schedule ticket deletion after 6 hours if =pls is used in a ticket
        if (message.channel.type === ChannelType.GuildText && activeTickets[message.channel.id]) {
            const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
            const deletionTimestamp = Date.now() + SIX_HOURS_MS;

            activeTickets[message.channel.id].scheduledDeletionTimestamp = deletionTimestamp;
            saveTicketsData(); // Persist the scheduled deletion timestamp

            // Schedule the actual deletion
            scheduleTicketDeletion(message.channel.id, SIX_HOURS_MS);

            embed.setTitle('Ticket Scheduled for Deletion ⏳')
                 .setDescription(`The \`=pls\` command was used in this ticket. This ticket will be automatically closed and deleted in **6 hours**.\n\nIf you wish to close it sooner, use the \`=closeticket\` command or the "Close Ticket" button.`);
            await message.channel.send({ embeds: [embed] });
            // Do NOT delete the message or channel immediately
        } else {
            // Original =pls behavior if not in a ticket
            embed.setTitle('Cheers for our staff! 🎉')
                 .setDescription(`Show appreciation with \`+vouch @user\` in <#${VOUCH_CHANNEL_ID}>.\nNot happy? Use \`-vouch @user <reason>\`.\n\n**You are now eligible to receive ONE vouch/review.**`);
            await message.channel.send({ embeds: [embed] });
        }
        return; // Prevent further processing
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

            // Also include ticket data in backup
            const ticketsBackupContent = JSON.stringify({ activeTickets, ticketPanelInfo }, null, 2);
            const ticketsAttachment = new AttachmentBuilder(Buffer.from(ticketsBackupContent, 'utf-8'), { name: 'tickets_backup.json' });


            await message.author.send({
                content: 'Here are your backup files:',
                files: [
                    vouchesAttachment, stockAttachment, rolesAttachment,
                    redeemedAttachment, channelRestrictionsAttachment, cooldownsAttachment,
                    ticketsAttachment // Add ticket data backup
                ]
            });
            embed.setTitle('Backup Sent! ✅')
                 .setDescription('Your bot data files have been sent to your DMs (`vouches.json`, `stock.json`, `roles.json`, `redeemed.json`, `channelRestrictions.json`, `cooldowns.json`, `tickets_backup.json`).');
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
                 .setDescription('Please attach one or more JSON files to restore data. Accepted files: `vouches.json`, `stock.json`, `roles.json`, `redeemed.json`, `channelRestrictions.json`, `cooldowns.json`, `tickets_backup.json`.');
            return message.channel.send({ embeds: [embed] });
        }

        const allowedFileNames = [
            'vouches.json', 'stock.json', 'roles.json',
            'redeemed.json', 'channelRestrictions.json', 'cooldowns.json',
            'tickets_backup.json' // Added for ticket data restore
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
                        saveBotData(); // Saves all data including stock
                        updateDynamicCommandMap(); // Re-populate dynamic commands based on new stock
                        break;
                    case 'roles.json':
                        rolesAllowed = newData;
                        saveBotData();
                        break;
                    case 'redeemed.json':
                        redeemed = newData;
                        saveBotData();
                        break;
                    case 'channelRestrictions.json':
                        channelRestrictions = newData;
                        saveBotData();
                        break;
                    case 'cooldowns.json':
                        cooldowns = newData;
                        saveBotData();
                        break;
                    case 'tickets_backup.json': // Handle ticket data restore
                        if (newData.activeTickets && newData.ticketPanelInfo) {
                            activeTickets = newData.activeTickets;
                            ticketPanelInfo = newData.ticketPanelInfo;
                            saveTicketsData();
                        } else {
                            throw new Error('Invalid ticket backup structure.');
                        }
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
        const activeTicketsStr = JSON.stringify(activeTickets, null, 2); // Add ticket data to debug
        const ticketPanelInfoStr = JSON.stringify(ticketPanelInfo, null, 2); // Add ticket panel info to debug


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
        debugEmbed.addFields(...splitStringForEmbed(redeemedStr, 'Manually Redeemed (Legacy)')); // Clarify this is for manual redemption
        debugEmbed.addFields(...splitStringForEmbed(generatedCodesStr, 'Generated Codes (in-memory)'));
        debugEmbed.addFields(...splitStringForEmbed(fileStockStr, 'File Stock (Cookies)'));
        debugEmbed.addFields(...splitStringForEmbed(channelRestrictionsStr, 'Channel Restrictions'));
        debugEmbed.addFields(...splitStringForEmbed(plsRequestsStr, 'PLS Requests (in-memory)'));
        debugEmbed.addFields(...splitStringForEmbed(cooldownsStr, 'Cooldowns'));
        debugEmbed.addFields(...splitStringForEmbed(activeTicketsStr, 'Active Tickets')); // Add ticket data to debug
        debugEmbed.addFields(...splitStringForEmbed(ticketPanelInfoStr, 'Ticket Panel Info')); // Add ticket panel info to debug


        return message.channel.send({ embeds: [debugEmbed] });
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
            // NEW: Cancel any pending scheduled deletion
            cancelTicketDeletion(channelIdToClose);

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

            await channel.delete('Ticket closed via button interaction.');
            delete activeTickets[channelIdToClose]; // Remove from activeTickets after channel deletion
            saveTicketsData();
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
                            .setDescription(`Transcript for ticket <#${channel.id}> (\`${channel.name}\`) generated by ${interaction.user.tag}.`)
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


// === Modal Submit Handler ===
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
                    .setTitle('User Removed from Ticket➖')
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
const app = express();
app.get('/', (req, res) => {
    res.send('Bot is running and alive!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Keepalive server listening on port ${PORT}`);
});
