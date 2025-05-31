const { Client, GatewayIntentBits, Partials, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.ID ;
const GUILD_ID =  process.env.gid ;
const OWNER_ID = '1110864648787480656';
const AUTHORIZED_USERS = ['1110864648787480656', '1212961835582623755', '1333798275601662056'];

const DATA_DIR = './data';
const COOKIE_DIR = './cookies';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

let rolesAllowed = {};
let stock = {};
let redeemed = {};
let fileStock = {};

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(COOKIE_DIR)) fs.mkdirSync(COOKIE_DIR);

const loadData = () => {
  if (fs.existsSync(`${DATA_DIR}/stock.json`)) stock = JSON.parse(fs.readFileSync(`${DATA_DIR}/stock.json`));
  if (fs.existsSync(`${DATA_DIR}/redeemed.json`)) redeemed = JSON.parse(fs.readFileSync(`${DATA_DIR}/redeemed.json`));
  if (fs.existsSync(`${DATA_DIR}/roles.json`)) rolesAllowed = JSON.parse(fs.readFileSync(`${DATA_DIR}/roles.json`));
};

const saveData = () => {
  fs.writeFileSync(`${DATA_DIR}/stock.json`, JSON.stringify(stock, null, 2));
  fs.writeFileSync(`${DATA_DIR}/redeemed.json`, JSON.stringify(redeemed, null, 2));
  fs.writeFileSync(`${DATA_DIR}/roles.json`, JSON.stringify(rolesAllowed, null, 2));
};

const generateCode = () => crypto.randomBytes(4).toString('hex');

const updateFileStock = () => {
  for (const category of fs.readdirSync(COOKIE_DIR)) {
    const categoryPath = path.join(COOKIE_DIR, category);
    if (fs.lstatSync(categoryPath).isDirectory()) {
      fileStock[category] = fs.readdirSync(categoryPath);
    }
  }
};

client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;

  const args = msg.content.trim().split(/\s+/);
  const cmd = args[0].toLowerCase();

  // CATEGORY & STOCK MANAGEMENT
  if (cmd === '=addcategory') {
    const name = args[1]?.toLowerCase();
    if (!name) return msg.reply('❌ Provide a category name.');
    if (stock[name]) return msg.reply('❌ Category already exists.');
    stock[name] = [];
    createDynamicCommand(name);
    saveData();
    return msg.reply(`✅ Category \`${name}\` created and command \`=${name[0]}gen\` is now active.`);
  }

  if (cmd === '=addstock') {
    const category = args[1]?.toLowerCase();
    const code = args.slice(2).join(' ');
    if (!category || !code) return msg.reply('❌ Usage: =addstock <category> <stock_name>');
    if (!stock[category]) return msg.reply('❌ Category not found.');
    stock[category].push(code);
    saveData();
    return msg.reply(`✅ Stock \`${code}\` added to \`${category}\`.`);
  }

  if (cmd === '=add') {
    const command = args[1]?.toLowerCase();
    const role = msg.mentions.roles.first();
    if (!command || !role) return msg.reply('❌ Usage: =add <command> @role');
    rolesAllowed[command] = role.id;
    saveData();
    return msg.reply(`✅ Command \`=${command}\` is now usable by ${role}`);
  }

  if (cmd === '=help') {
    let helpMsg = '**📜 Available Commands:**\n';
    Object.keys(stock).forEach(cat => helpMsg += `=\`${cat[0]}gen\` - Generate from ${cat}\n`);
    helpMsg += '`=addcategory <name>`\n`=addstock <category> <stock_name>`\n`=redeem <code>`\n`=backup`\n`=upload`\n`=csend <category> @user`\n`=cstock`\n`=stock`\n`=pls`';
    return msg.reply(helpMsg);
  }

  if (cmd === '=redeem') {
    const code = args[1];
    if (!code || !redeemed[code]) return msg.reply('❌ Invalid code.');
    const { category, stock: codeName, user } = redeemed[code];
    return msg.reply(`🔑 Code \`${code}\` was redeemed for \`${codeName}\` from category \`${category}\`.`);
  }

  if (cmd === '=backup') {
    if (msg.author.id !== OWNER_ID) return;
    const files = ['stock.json', 'redeemed.json', 'roles.json'];
    const attachments = files.map(f => ({ attachment: path.join(DATA_DIR, f), name: f }));
    attachments.push({ attachment: __filename, name: path.basename(__filename) });
    return msg.author.send({ content: '📦 Backup files:', files: attachments });
  }

  // FILE MANAGEMENT
  if (cmd === '=upload') {
    if (!AUTHORIZED_USERS.includes(msg.author.id)) return msg.reply('🚫 You are not authorized to upload.');
    if (msg.attachments.size === 0) return msg.reply('📎 Please attach a ZIP file.');
    const attachment = msg.attachments.first();
    const category = args[1];
    if (!category) return msg.reply('Usage: `=upload <category>`');
    const categoryPath = path.join(COOKIE_DIR, category);
    if (!fs.existsSync(categoryPath)) fs.mkdirSync(categoryPath);

    const tempPath = path.join(COOKIE_DIR, `${Date.now()}_temp.zip`);
    const res = await fetch(attachment.url);
    const buffer = await res.arrayBuffer();
    fs.writeFileSync(tempPath, Buffer.from(buffer));

    const zip = new AdmZip(tempPath);
    zip.extractAllTo(categoryPath, true);
    fs.unlinkSync(tempPath);
    updateFileStock();
    return msg.reply(`✅ Uploaded and extracted files to **${category}**.`);
  }

  if (cmd === '=csend') {
    if (!msg.member.roles.cache.some(role => role.name === 'YourStaffRole')) return msg.reply('🚫 You don\'t have permission to use this.');
    const category = args[1];
    const user = msg.mentions.users.first();
    if (!category || !user) return msg.reply('Usage: `=csend <category> @user`');
    const categoryPath = path.join(COOKIE_DIR, category);
    if (!fs.existsSync(categoryPath)) return msg.reply('❌ Category not found.');
    const files = fs.readdirSync(categoryPath);
    if (files.length === 0) return msg.reply('📭 No stock available in this category.');
    const filePath = path.join(categoryPath, files[0]);
    const attachment = new AttachmentBuilder(filePath);
    await user.send({ content: `Here is your cookie for **${category}**.`, files: [attachment] });
    fs.unlinkSync(filePath);
    updateFileStock();
    return msg.reply(`✅ Cookie sent to ${user.tag} and removed from stock.`);
  }

  if (cmd === '=stock') {
    updateFileStock();
    if (Object.keys(fileStock).length === 0) return msg.reply('📦 No stock available.');
    const embed = new EmbedBuilder().setTitle('📦 Current Stock').setColor('Blue');
    for (const category in fileStock) {
      const items = fileStock[category];
      embed.addFields({ name: category, value: items.length ? items.join('\n') : 'No stock added yet.', inline: false });
    }
    return msg.channel.send({ embeds: [embed] });
  }

  if (cmd === '=cstock') {
    updateFileStock();
    let msgText = '📦 **Stock Count Per Category:**\n';
    for (const category in fileStock) {
      msgText += `**${category}** - ${fileStock[category].length} item(s)\n`;
    }
    return msg.reply(msgText);
  }

  if (cmd === '=pls') {
    const embed = new EmbedBuilder()
      .setTitle('Cheers for our staff!')
      .setDescription(`🌟 Share the love with \`+vouch @user\` in <#1374018342444204067>. Your appreciation brightens our day!\n\nIf you're not satisfied, type \`-vouch @user\` to provide feedback. 🎉`)
      .setColor('Yellow');
    return msg.channel.send({ embeds: [embed] });
  }
});

function createDynamicCommand(category) {
  const commandName = `${category[0]}gen`;
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const args = msg.content.trim().split(/\s+/);
    if (args[0]?.toLowerCase() !== `=${commandName}`) return;

    const name = args[1];
    if (!name) return msg.reply('❌ Provide a stock name to generate.');
    if (!stock[category]) return msg.reply('❌ Category does not exist.');
    if (!stock[category].includes(name)) return msg.reply('❌ Stock not found in this category.');

    const genCode = generateCode();
    redeemed[genCode] = { category, stock: name, user: msg.author.id, time: Date.now() };
    saveData();
    return msg.author.send(`✅ Here is your code for **${name}** from **${category}**: \`${genCode}\``)
      .then(() => msg.reply('📬 Check your DM for the code.'));
  });
}

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  loadData();
  updateFileStock();
  Object.keys(stock).forEach(createDynamicCommand);
});

client.login(TOKEN);
