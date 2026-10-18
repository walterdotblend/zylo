import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionsBitField, ChannelType, MessageFlags, Partials, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { nanoid } from 'nanoid';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GUILD_SETTINGS_FILE = path.join(__dirname, '..', 'guild_settings.json');

let guildSettings = {};
try {
  if (fs.existsSync(GUILD_SETTINGS_FILE)) {
    guildSettings = JSON.parse(fs.readFileSync(GUILD_SETTINGS_FILE, 'utf-8'));
  }
} catch (e) {
  console.warn('⚠️ [Discord Bot] Could not read guild_settings.json:', e);
}

function saveGuildSettings() {
  try {
    fs.writeFileSync(GUILD_SETTINGS_FILE, JSON.stringify(guildSettings, null, 2));
  } catch (e) {
    console.error('❌ [Discord Bot] Error saving guild_settings.json:', e);
  }
}

// In-memory Discord recording sessions (auto-expire after 12 hours)
const discordSessions = new Map();
const consumedDiscordSessions = new Map(); // sessionId / hash -> timestamp consumed
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// User messages queue (for /support and /reply)
const userMessages = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of discordSessions.entries()) {
    if (now - sess.createdAt > SESSION_TTL_MS) {
      discordSessions.delete(id);
    }
  }
  for (const [id, consumedAt] of consumedDiscordSessions.entries()) {
    if (now - consumedAt > SESSION_TTL_MS) {
      consumedDiscordSessions.delete(id);
    }
  }
}, 60 * 1000);

let discordClient = null;
let mediaDbRef = null;
let deleteMediaCallback = null;
let botBaseUrl = '';

export function getLocalLanIp() {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const net of interfaces[name]) {
        if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('127.')) {
          return net.address;
        }
      }
    }
  } catch (e) {}
  return 'localhost';
}

export function getDiscordPublicUrl(customUrl = '') {
  if (customUrl && typeof customUrl === 'string' && customUrl.trim()) {
    return customUrl.trim().replace(/\/$/, '');
  }
  const envUrl = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
  if (envUrl && typeof envUrl === 'string' && envUrl.trim()) {
    return envUrl.trim().replace(/\/$/, '');
  }
  if (process.env.BASE_URL && typeof process.env.BASE_URL === 'string' && process.env.BASE_URL.trim()) {
    return process.env.BASE_URL.trim().replace(/\/$/, '');
  }
  return '';
}

export function initDiscordBot(mediaDb, deleteMediaFn, baseUrl = 'https://mogi-web.onrender.com') {
  mediaDbRef = mediaDb;
  deleteMediaCallback = deleteMediaFn;
  botBaseUrl = getDiscordPublicUrl(baseUrl);

  const token = process.env.DISCORD_BOT_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;

  if (!token) {
    console.log('ℹ️ [Discord Bot] DISCORD_BOT_TOKEN not configured in .env. The bot will activate when you add credentials.');
    return null;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages
    ],
    partials: [
      Partials.Channel,
      Partials.Message
    ]
  });

  // Slash commands definitions (Streamlined per user requests)
  const commands = [
    // 1. /clip: Simple, 1-click recording link that auto-publishes to channel
    new SlashCommandBuilder()
      .setName('clip')
      .setDescription('Record a quick clip and automatically post it to this channel.')
      .addStringOption(opt =>
        opt.setName('note')
          .setDescription('Optional note or description for the clip')
          .setRequired(false)),

    // 2. /destruct: Early permanent deletion
    new SlashCommandBuilder()
      .setName('destruct')
      .setDescription('Immediately and permanently destroy a Zylo clip by its ID.')
      .addStringOption(opt =>
        opt.setName('id')
          .setDescription('Clip ID (characters after /v/)')
          .setRequired(true)),

    // 3. /support: Send message to bot admin / support
    new SlashCommandBuilder()
      .setName('support')
      .setDescription('Send a message or inquiry to the Zylo team.')
      .addStringOption(opt =>
        opt.setName('message')
          .setDescription('Your message or question')
          .setRequired(true)),

    // 4. /reply: Admin reply to user through bot
    new SlashCommandBuilder()
      .setName('reply')
      .setDescription('[Admin] Reply to a user through the bot.')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
      .addStringOption(opt =>
        opt.setName('user_id')
          .setDescription('Discord ID of the user to reply to')
          .setRequired(true))
      .addStringOption(opt =>
        opt.setName('reply')
          .setDescription('Reply message text')
          .setRequired(true)),

    // 5. /anuncio: Broadcast announcement to current channel or ALL 30+ servers
    new SlashCommandBuilder()
      .setName('anuncio')
      .setDescription('[Admin] Post an official announcement.')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
      .addStringOption(opt =>
        opt.setName('message')
          .setDescription('Announcement text')
          .setRequired(true))
      .addStringOption(opt =>
        opt.setName('scope')
          .setDescription('Where to publish: this channel or broadcast to ALL linked servers')
          .setRequired(false)
          .addChoices(
            { name: '📍 Only this channel', value: 'this' },
            { name: '🌐 Broadcast to ALL linked servers (30+)', value: 'all' }
          ))
      .addChannelOption(opt =>
        opt.setName('channel')
          .setDescription('Channel to publish in (if scope is this server)')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false))
      .addStringOption(opt =>
        opt.setName('title')
          .setDescription('Optional announcement title')
          .setRequired(false))
      .addStringOption(opt =>
        opt.setName('banner_url')
          .setDescription('Optional image or GIF banner URL')
          .setRequired(false)),

    // 6. /setcanal: Designate official channel for announcements in this server
    new SlashCommandBuilder()
      .setName('setcanal')
      .setDescription('[Admin] Set the designated announcements channel for Zylo.')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
      .addChannelOption(opt =>
        opt.setName('channel')
          .setDescription('Text or announcement channel for Zylo updates')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true)),

    // 7. /help: Complete interactive guide to all commands
    new SlashCommandBuilder()
      .setName('help')
      .setDescription('Show the complete guide to Zylo commands.')
      .addStringOption(opt =>
        opt.setName('command')
          .setDescription('Select a specific command for detailed explanation')
          .setRequired(false)
          .addChoices(
            { name: '/clip - Record and post clip', value: 'clip' },
            { name: '/destruct - Self-destruct a clip', value: 'destruct' },
            { name: '/support - Send message to admin', value: 'support' },
            { name: '/anuncio - Broadcast announcement', value: 'anuncio' },
            { name: '/setcanal - Set announcements channel', value: 'setcanal' },
            { name: '/reply - Reply to user message', value: 'reply' }
          ))
  ];

  // Register commands on Discord Gateway
  async function registerSlashCommands() {
    try {
      if (!clientId) {
        console.warn('⚠️ [Discord Bot] DISCORD_CLIENT_ID not configured; cannot register slash commands automatically.');
        return;
      }
      const rest = new REST({ version: '10' }).setToken(token);
      console.log('🔄 [Discord Bot] Registering global Slash commands...');
      await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands.map(c => c.toJSON()) }
      );
      console.log('✅ [Discord Bot] Slash commands registered.');
    } catch (err) {
      console.error('❌ [Discord Bot] Error registering Slash commands:', err.message);
    }
  }

  client.once('ready', async () => {
    console.log(`🤖 [Discord Bot] Successfully connected as ${client.user.tag}`);
    await registerSlashCommands();
  });

  async function safeDeferReply(interaction) {
    if (!interaction.deferred && !interaction.replied) {
      try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      } catch (err) {
        if (err.code !== 40060) {
          console.warn('⚠️ [Discord Bot] safeDeferReply notice:', err.message);
        }
      }
    }
  }

  client.on('interactionCreate', async interaction => {
    try {
      if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        // Command 1: /clip (Simple 1-click recording with automatic channel posting)
        if (commandName === 'clip') {
          // Immediately acknowledge so Discord mobile never errors with "La aplicación no ha respondido"
          await safeDeferReply(interaction);

          const note = interaction.options.getString('note') || interaction.options.getString('nota') || '';

          const sessionPayload = {
            channelId: interaction.channelId,
            guildId: interaction.guildId,
            userId: interaction.user.id,
            userName: interaction.user.tag || interaction.user.username,
            note,
            createdAt: Date.now()
          };
          const token = Buffer.from(JSON.stringify(sessionPayload)).toString('base64url');
          const sessionId = `mgs_${token}`;
          sessionPayload.sessionId = sessionId;
          discordSessions.set(sessionId, { ...sessionPayload, interactionToken: interaction.token, applicationId: interaction.applicationId });

          const publicBase = getDiscordPublicUrl(baseUrl || botBaseUrl);
          const port = process.env.PORT || 3000;
          const lanIp = getLocalLanIp();

          const buttons = [];

          if (publicBase) {
            // Live Public Domain is configured
            const recordingUrl = `${publicBase}/?session=${encodeURIComponent(sessionId)}`;
            buttons.push(
              new ButtonBuilder()
                .setLabel('🎥 Record Clip Now')
                .setStyle(ButtonStyle.Link)
                .setURL(recordingUrl)
            );
          } else {
            // Local dev mode: provide PC localhost and LAN mobile buttons so clicking on either device works!
            const pcUrl = `http://localhost:${port}/?session=${encodeURIComponent(sessionId)}`;
            buttons.push(
              new ButtonBuilder()
                .setLabel('💻 Open on PC')
                .setStyle(ButtonStyle.Link)
                .setURL(pcUrl)
            );
            if (lanIp && lanIp !== 'localhost') {
              const lanUrl = `http://${lanIp}:${port}/?session=${encodeURIComponent(sessionId)}`;
              buttons.push(
                new ButtonBuilder()
                  .setLabel('📱 Open on Mobile (Local LAN)')
                  .setStyle(ButtonStyle.Link)
                  .setURL(lanUrl)
              );
            }
          }

          let canSendInChannel = true;
          try {
            if (interaction.guild && interaction.channel) {
              const botMember = interaction.guild.members.me || await interaction.guild.members.fetch(client.user.id).catch(() => null);
              if (botMember) {
                const perms = interaction.channel.permissionsFor(botMember);
                if (perms && (!perms.has(PermissionsBitField.Flags.SendMessages) || !perms.has(PermissionsBitField.Flags.ViewChannel))) {
                  canSendInChannel = false;
                }
              }
            }
          } catch(e){}

          const embed = new EmbedBuilder()
            .setTitle('🎥 Zylo Clip Recording')
            .setDescription(`Private session for <@${interaction.user.id}>.\nClick the button to record your video. Once confirmed, **it will automatically be posted to this channel** for everyone.`)
            .setColor(0xff7b00)
            .addFields(
              { name: '⏱️ Max Duration', value: 'Up to 6 minutes (Fast Mode)', inline: true },
              { name: '⌛ Retention', value: 'Self-destructs in 6h', inline: true }
            );

          if (!canSendInChannel) {
            embed.addFields({
              name: '⚠️ Missing Permissions',
              value: 'The bot does not have permission to send messages in this channel. If not granted before upload, your clip will be delivered to you via Direct Message (DM).'
            });
          }

          if (!publicBase) {
            embed.setFooter({ text: '💡 Local mode active. To configure a public domain, add PUBLIC_URL=https://your-app.onrender.com to your .env or Render dashboard.' });
          }

          if (note) {
            embed.addFields({ name: '📝 Note', value: note });
          }

          const row = new ActionRowBuilder().addComponents(buttons);

          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ embeds: [embed], components: [row] });
          } else {
            await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
          }

          // Auto-delete the token recording link message after 2 minutes for privacy
          setTimeout(async () => {
            try {
              await interaction.deleteReply();
            } catch(e) {}
          }, 120000);
        }

        // Command 2: /destruct
        else if (commandName === 'destruct') {
          await safeDeferReply(interaction);

          const clipId = interaction.options.getString('id').trim();
          if (!mediaDbRef || !mediaDbRef[clipId]) {
            await interaction.editReply({ content: `❌ No clip found with ID \`${clipId}\`. It might have expired.` });
            return;
          }

          const clip = mediaDbRef[clipId];
          const isOwner = clip.discordUserId === interaction.user.id;
          const isAdmin = interaction.memberPermissions && interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator);

          if (!isOwner && !isAdmin) {
            await interaction.editReply({ content: '⛔ Only the clip author or a server administrator can destroy it.' });
            return;
          }

          if (deleteMediaCallback) {
            deleteMediaCallback(clipId);
          }

          await interaction.editReply({ content: `💥 The clip \`${clipId}\` has been **permanently destroyed**. It is no longer accessible by anyone.` });
        }

        // Command 3: /support (Send message to admin / Walter)
        else if (commandName === 'support') {
          await safeDeferReply(interaction);

          const messageText = interaction.options.getString('message');
          userMessages.set(interaction.user.id, {
            
            userId: interaction.user.id,
            userTag: interaction.user.tag || interaction.user.username,
            channelId: interaction.channelId,
            guildName: interaction.guild ? interaction.guild.name : 'DM',
            message: messageText,
            timestamp: new Date().toLocaleString()
          });

          console.log(`\n==========================================`);
          console.log(`📩 [DISCORD MESSAGE] `);
          console.log(`From: @${interaction.user.tag} (ID: ${interaction.user.id})`);
          console.log(`Server: ${interaction.guild ? interaction.guild.name : 'DM'}`);
          console.log(`Message: ${messageText}`);
          console.log(`To reply use: /reply user_id:${interaction.user.id} reply:Your text`);
          console.log(`==========================================\n`);

          // If admin user ID is specified in .env, forward directly via DM
          if (process.env.DISCORD_ADMIN_USER_ID) {
            try {
              const adminUser = await client.users.fetch(process.env.DISCORD_ADMIN_USER_ID);
              if (adminUser) {
                const adminEmbed = new EmbedBuilder()
                  .setTitle('📩 New User Message')
                  .setColor(0x3b82f6)
                  .addFields(
                    { name: '👤 User', value: `<@${interaction.user.id}> (\`${interaction.user.id}\`)`, inline: true },
                    { name: '🏠 Server', value: interaction.guild ? interaction.guild.name : 'DM', inline: true },
                    { name: '💬 Message', value: messageText }
                  )
                  .setFooter({ text: `To reply use: /reply user_id:${interaction.user.id} reply:... (or click Reply below)` });
                
                  
                  const replyBtn = new ButtonBuilder()
                    .setCustomId('reply_' + interaction.user.id)
                    .setLabel('Reply to ' + interaction.user.tag)
                    .setStyle(ButtonStyle.Primary)
                    ;
                  const row = new ActionRowBuilder().addComponents(replyBtn);
                  await adminUser.send({ embeds: [adminEmbed], components: [row] });

              }
            } catch(e) {
              console.warn('Could not send DM to admin:', e.message);
            }
          }

          await interaction.editReply({
            content: `📨 **Your message has been delivered to the Zylo team.**\nWe will reply to you here through the bot. Thanks for writing!`
          });
        }

        // Command 4: /reply (Admin only, 100% Private DM to recipient)
        else if (commandName === 'reply') {
          if (interaction.user.id !== process.env.DISCORD_ADMIN_USER_ID) {
            return interaction.reply({ content: "⛔ Unauthorized: Only the bot administrator can use this command.", flags: MessageFlags.Ephemeral });
          }
          await safeDeferReply(interaction);

          const targetUserId = interaction.options.getString('user_id').trim();
          const replyText = interaction.options.getString('reply');

          try {
            const targetUser = await client.users.fetch(targetUserId).catch(() => null);
            if (!targetUser) {
              await interaction.editReply({ content: `❌ No user found with ID \`${targetUserId}\`.` });
              return;
            }

            const replyEmbed = new EmbedBuilder()
              .setTitle('💬 Message from Zylo Team')
              .setDescription(replyText)
              .setColor(0x10b981)
              .setTimestamp()
              .setFooter({ text: 'Zylo Support • Private Response' });

            await targetUser.send({ embeds: [replyEmbed] });
            await interaction.editReply({ content: `✅ Reply delivered in private (DM) to <@${targetUserId}>.` });
          } catch(err) {
            await interaction.editReply({ content: `❌ Could not send private DM to <@${targetUserId}> (They may have DMs closed): ${err.message}` });
          }
        }

        // Command 5: /anuncio [mensaje] [alcance] [canal] [titulo] [banner_url]
        else if (commandName === 'anuncio') {
          await safeDeferReply(interaction);

          const messageText = interaction.options.getString('message');
          const alcance = interaction.options.getString('scope') || 'this';
          const title = interaction.options.getString('title') || '📢 Official Zylo Announcement';
          const bannerUrl = interaction.options.getString('banner_url') || '';

          const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(messageText)
            .setColor(0xff7b00)
            .setTimestamp()
            .setFooter({ text: 'Zylo • Official Announcements' });

          if (bannerUrl && (bannerUrl.startsWith('http://') || bannerUrl.startsWith('https://'))) {
            embed.setImage(bannerUrl);
          }

          if (alcance === 'all') {
            let sentCount = 0;
            let failedCount = 0;
            const guilds = Array.from(client.guilds.cache.values());

            for (const guild of guilds) {
              try {
                // Find best channel to broadcast:
                let targetCh = null;

                // 1. Check if server admin configured a designated news/announcements channel via /setcanal
                const designatedId = guildSettings[guild.id]?.announcementChannelId;
                if (designatedId) {
                  const ch = guild.channels.cache.get(designatedId);
                  if (ch && ch.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.SendMessages)) {
                    targetCh = ch;
                  }
                }

                // 2. Look for channel specifically named anuncios, noticias, updates, news, or bot
                if (!targetCh) {
                  targetCh = guild.channels.cache.find(ch => 
                    ch.isTextBased() && 
                    /anuncios|noticias|updates|news|bot|mogi/i.test(ch.name) &&
                    ch.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.SendMessages)
                  );
                }

                // 3. Or fallback to system channel if permitted
                if (!targetCh && guild.systemChannel && guild.systemChannel.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.SendMessages)) {
                  targetCh = guild.systemChannel;
                }

                // 4. Or first available text channel where bot can speak
                if (!targetCh) {
                  targetCh = guild.channels.cache.find(ch => 
                    ch.isTextBased() && 
                    ch.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.SendMessages)
                  );
                }

                if (targetCh) {
                  await targetCh.send({ embeds: [embed] });
                  sentCount++;
                  // 400ms pause to respect Discord API rate limits across 30+ servers
                  await new Promise(res => setTimeout(res, 400));
                } else {
                  failedCount++;
                }
              } catch(e) {
                failedCount++;
              }
            }

            await interaction.editReply({
              content: `🌐 **Global Broadcast Completed:**\n✅ Delivered to **${sentCount}** linked server(s).\n⚠️ Skipped: **${failedCount}** (due to insufficient permissions in text channels).`
            });
          } else {
            // Local announcement in selected or current channel
            const targetChannel = interaction.options.getChannel('channel') || interaction.channel;
            await targetChannel.send({ embeds: [embed] });
            await interaction.editReply({ content: `✅ Announcement published successfully in <#${targetChannel.id}>.` });
          }
        }

        // Command 6: /setcanal [canal]
        else if (commandName === 'setcanal') {
          if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({ content: '❌ Only server administrators can configure the official news and announcements channel.', flags: MessageFlags.Ephemeral });
          }

          const targetChannel = interaction.options.getChannel('channel');
          if (!targetChannel) {
            return interaction.reply({ content: '❌ You must specify a valid channel.', flags: MessageFlags.Ephemeral });
          }

          if (!interaction.guildId) {
            return interaction.reply({ content: '❌ This command can only be used within a Discord server.', flags: MessageFlags.Ephemeral });
          }

          guildSettings[interaction.guildId] = {
            announcementChannelId: targetChannel.id,
            guildName: interaction.guild?.name || '',
            updatedAt: Date.now()
          };
          saveGuildSettings();

          return interaction.reply({ content: `✅ **Official Channel Designated:**\nOfficial announcements and news from Zylo Bot will be published in <#${targetChannel.id}>.\nThis ensures that no notices are sent to the general channel without consent!`, flags: MessageFlags.Ephemeral });
        }

        // Command 7: /help [comando_opcional]
        else if (commandName === 'help') {
          const selectedCmd = interaction.options.getString('command');

          if (selectedCmd === 'clip') {
            const embed = new EmbedBuilder()
              .setTitle('📖 Command Guide: `/clip`')
              .setColor(0xff7b00)
              .setDescription('Generate a quick recording link with 1 click. Once you finish recording and confirm, **the clip is automatically posted to this Discord channel**.')
              .addFields(
                { name: 'Optional Parameters', value: '`nota`: Brief description or comment attached to the published clip.' },
                { name: 'Automatic Expiration', value: 'The clip has an ephemeral duration of **6 hours** after which it self-destructs to save storage.' },
                { name: 'Compatibility', value: 'If you open the link on mobile, it opens the WebApp with integrated camera; on PC it opens Zylo Studio.' }
              )
              .setFooter({ text: 'Zylo Bot • Official Guide' });
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
          }

          if (selectedCmd === 'destruct') {
            const embed = new EmbedBuilder()
              .setTitle('📖 Command Guide: `/destruct`')
              .setColor(0xef4444)
              .setDescription('Permanently destroy a clip before its 6-hour expiration time.')
              .addFields(
                { name: 'Required Parameter', value: '`id`: The unique clip code (e.g. if your link is `mogi.com/v/k8J1a0P`, the ID is `k8J1a0P`).' },
                { name: 'Permissions', value: 'Only the clip author or a server Administrator can execute self-destruction.' }
              )
              .setFooter({ text: 'Zylo Bot • Official Guide' });
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
          }

          if (selectedCmd === 'msj') {
            const embed = new EmbedBuilder()
              .setTitle('📖 Command Guide: `/support`')
              .setColor(0x3b82f6)
              .setDescription('Send questions, tech support requests, or feedback directly to the Zylo team.')
              .addFields(
                { name: 'Required Parameter', value: '`mensaje`: Text you want to communicate.' },
                { name: "How you'll receive a reply", value: 'The Zylo team will reply directly to your DM through the bot.' }
              )
              .setFooter({ text: 'Zylo Bot • Official Guide' });
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
          }

          if (selectedCmd === 'anuncio') {
            const embed = new EmbedBuilder()
              .setTitle('📖 Command Guide: `/anuncio` (Administrators)')
              .setColor(0x8b5cf6)
              .setDescription('Publishes official announcements formatted with professional design and optional banner.')
              .addFields(
                { name: 'Global Scope (30+ Servers)', value: 'Select `scope: Broadcast to ALL linked servers` to send the announcement simultaneously to the entire server network where Zylo Bot is present.' },
                { name: 'Parameters', value: '`message` (required), `scope` (this channel or all), `channel` (optional), `title` (optional), `banner_url` (optional image/GIF).' }
              )
              .setFooter({ text: 'Zylo Bot • Official Guide' });
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
          }

          if (selectedCmd === 'setcanal') {
            const embed = new EmbedBuilder()
              .setTitle('📖 Command Guide: `/setcanal` (Administrators)')
              .setColor(0x10b981)
              .setDescription('Configures the designated channel of this server to receive official Zylo news and announcements.')
              .addFields(
                { name: 'Required Parameter', value: '`canal`: The text or announcement channel where you want Zylo to publish.' },
                { name: 'Anti-Spam Benefit', value: 'Prevents global announcement broadcasts from reaching general channels without consent.' },
                { name: 'Permissions', value: 'Only members with Administrator permissions can execute this command.' }
              )
              .setFooter({ text: 'Zylo Bot • Official Guide' });
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
          }

          if (selectedCmd === 'responder') {
            const embed = new EmbedBuilder()
              .setTitle('📖 Command Guide: `/reply` (Administrators)')
              .setColor(0x10b981)
              .setDescription('Allows the administrator to reply to messages received via `/support`.')
              .addFields(
                { name: 'Parameters', value: '`user_id`: Numeric ID of the Discord user.\n`reply`: Response message sent via private DM.' }
              )
              .setFooter({ text: 'Zylo Bot • Official Guide' });
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
          }

          // General Help Overview
          const generalEmbed = new EmbedBuilder()
            .setTitle('🎬 Zylo Bot — Guide and Command List')
            .setColor(0xff7b00)
            .setDescription('Zylo is the fastest and most private system to record, trim losslessly, and share temporary clips (6h) with your friends on Discord.')
            .addFields(
              { name: '🎥 `/clip [nota]`', value: 'Generates a 1-click recording link. Upon finishing, the clip is automatically uploaded to this channel.' },
              { name: '💥 `/destruct [id]`', value: 'Immediately destroys a clip permanently before 6 hours.' },
              { name: '📩 `/support [mensaje]`', value: 'Sends a message or help report directly to the Zylo administrator.' },
              { name: '📢 `/anuncio [mensaje]`', value: '*(Admin)* Publishes an official announcement in this channel or across all linked servers.' },
              { name: '📌 `/setcanal [canal]`', value: '*(Admin)* Designates the official channel of this server for global announcements and news.' },
              { name: '💬 `/reply [usuario_id] [respuesta]`', value: '*(Admin)* Replies to a user support message.' },
              { name: '❓ `/help [comando]`', value: 'Shows details and advanced options of any command.' }
            )
            .setFooter({ text: 'Use /help command:<name> to see specific details' });

                    await interaction.reply({ embeds: [generalEmbed], flags: MessageFlags.Ephemeral });
        }
        // Command 8: /language
        else if (commandName === 'language') {
          await interaction.reply({ content: "Bot language is currently set to English.", flags: MessageFlags.Ephemeral });
        }
      }

            // Button interactions
      else if (interaction.isButton()) {
        const customId = interaction.customId;
        if (customId.startsWith('reply_')) {
          const targetId = customId.replace('reply_', '');
          const modal = new ModalBuilder()
            .setCustomId('modal_reply_' + targetId)
            .setTitle('Reply to User');
          const input = new TextInputBuilder()
            .setCustomId('reply_text')
            .setLabel('Type your reply:')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);
          const firstActionRow = new ActionRowBuilder().addComponents(input);
          modal.addComponents(firstActionRow);
          await interaction.showModal(modal);
          return;
        }

        if (customId.startsWith('destruct_')) {
          const clipId = customId.replace('destruct_', '');
          if (!mediaDbRef || !mediaDbRef[clipId]) {
            await interaction.reply({ content: '❌ This clip was already destroyed or expired.', flags: MessageFlags.Ephemeral });
            return;
          }
          const clip = mediaDbRef[clipId];
          const isOwner = clip.discordUserId === interaction.user.id;
          const isAdmin = interaction.memberPermissions && interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator);

          if (!isOwner && !isAdmin) {
            await interaction.reply({ content: '⛔ You do not have permissions to self-destruct this clip.', flags: MessageFlags.Ephemeral });
            return;
          }

          if (deleteMediaCallback) {
            deleteMediaCallback(clipId);
          }

          await interaction.update({
            content: `💥 **Clip self-destructed by <@${interaction.user.id}>.** It is no longer available.`,
            embeds: [],
            components: []
          });
        }
      }
            else if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('modal_reply_')) {
          const targetUserId = interaction.customId.replace('modal_reply_', '');
          const replyText = interaction.fields.getTextInputValue('reply_text');
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });

          try {
            const targetUser = await client.users.fetch(targetUserId).catch(() => null);
            if (!targetUser) {
              await interaction.editReply({ content: `❌ No user found with ID \`${targetUserId}\`.` });
              return;
            }

            const replyEmbed = new EmbedBuilder()
              .setTitle('💬 Message from Zylo Team')
              .setDescription(replyText)
              .setColor(0x10b981)
              .setTimestamp()
              .setFooter({ text: 'Zylo Support • Private Response' });

            await targetUser.send({ embeds: [replyEmbed] });
            await interaction.editReply({ content: `✅ Reply sent via private DM to <@${targetUserId}>.` });
          } catch(err) {
            await interaction.editReply({ content: `❌ Could not send private DM to <@${targetUserId}> (their DMs are closed): ${err.message}` });
          }
        }
      }
    } catch (err) {
      console.error('Error handling Discord interaction:', err);
    }
  });

  client.login(token).catch(err => {
    console.error('❌ [Discord Bot] Error logging into Discord:', err.message);
  });

  discordClient = client;
  return client;
}

// Session Registry API for Express routes
export function registerDiscordSession(data) {
  const sessionId = nanoid(12);
  discordSessions.set(sessionId, {
    sessionId,
    ...data,
    createdAt: Date.now()
  });
  return sessionId;
}

export function isDiscordSessionConsumed(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return false;
  return consumedDiscordSessions.has(sessionId.trim());
}

export function consumeDiscordSession(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return;
  const cleanId = sessionId.trim();
  consumedDiscordSessions.set(cleanId, Date.now());
  discordSessions.delete(cleanId);
}

export function getDiscordSession(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  const cleanId = sessionId.trim();
  if (consumedDiscordSessions.has(cleanId)) {
    return null; // Session has already been consumed / used
  }
  if (discordSessions.has(cleanId)) {
    return discordSessions.get(cleanId);
  }
  try {
    if (cleanId.startsWith('mgs_')) {
      const b64 = cleanId.slice(4);
      const jsonStr = Buffer.from(b64, 'base64url').toString('utf-8');
      const data = JSON.parse(jsonStr);
      if (data && (data.channelId || data.userId)) {
        if (!data.createdAt || (Date.now() - data.createdAt <= SESSION_TTL_MS)) {
          data.sessionId = cleanId;
          return data;
        }
      }
    }
  } catch (e) {
    console.warn('[Discord Bot] Error parsing token session:', e.message);
  }
  return null;
}

// Auto-notify Discord channel when clip upload completes
export async function notifyDiscordClipUploaded(sessionId, clipData, baseUrl) {
  console.log(`[Discord Bot] notifyDiscordClipUploaded triggered for session: "${sessionId}", clip: ${clipData?.id}`);
  const session = getDiscordSession(sessionId);
  if (!session) {
    console.warn(`[Discord Bot] Session not found or expired for ID: "${sessionId}"`);
    return false;
  }
  // Immediately consume the session so it can never be reused for another upload
  consumeDiscordSession(sessionId);

  const targetChannelId = session.channelId;
  const publicBase = getDiscordPublicUrl(baseUrl) || getDiscordPublicUrl(botBaseUrl) || 'https://mogi-web.onrender.com';
  const clipUrl = `${publicBase}/v/${clipData.id}`;
  const noteStr = session.note ? `\n> *${session.note}*` : '';
  const messageContent = `Clip of <@${session.userId}>: ${clipUrl}${noteStr}`;

  let sent = false;

  // 1. If Discord Bot Client is active, try channel first
  if (discordClient && discordClient.isReady()) {
    if (targetChannelId) {
      try {
        const channel = await discordClient.channels.fetch(targetChannelId);
        if (channel && channel.isTextBased()) {
          await channel.send({ content: messageContent });
          sent = true;
          console.log(`✅ [Discord Bot] Clip ${clipData.id} posted automatically to Discord channel: ${targetChannelId}`);
        }
      } catch (err) {
        console.warn(`⚠️ [Discord Bot] Channel fetch/send failed for channel ${targetChannelId}:`, err.message);
      }
    }

    // Fallback A: public follow-up on the original /clip interaction (posts in the same channel)
    if (!sent && session.interactionToken && session.applicationId) {
      try {
        const resp = await fetch(`https://discord.com/api/v10/webhooks/${session.applicationId}/${session.interactionToken}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: messageContent, flags: 0 })
        });
        if (resp.ok) {
          sent = true;
          console.log(`✅ [Discord Bot] Clip ${clipData.id} posted via interaction follow-up in channel ${targetChannelId}`);
        } else {
          console.warn(`⚠️ [Discord Bot] Follow-up failed: ${resp.status} ${await resp.text()}`);
        }
      } catch (fuErr) {
        console.warn('⚠️ [Discord Bot] Follow-up error:', fuErr.message);
      }
    }

    // Fallback B: If channel send did not succeed, send directly as a DM to the author
    if (!sent && session.userId) {
      try {
        const user = await discordClient.users.fetch(session.userId);
        if (user) {
          const dmContent = `⚠️ The bot does not have permissions to send messages in <#${session.channelId}>, so your clip is delivered here in private:\nClip of <@${session.userId}>: ${clipUrl}${noteStr}`;
          await user.send({ content: dmContent });
          sent = true;
          console.log(`✅ [Discord Bot] Clip ${clipData.id} posted via DM to user ${session.userId}`);
        }
      } catch (dmErr) {
        console.warn(`⚠️ [Discord Bot] DM fallback failed for user ${session.userId}:`, dmErr.message);
      }
    }
  }

  // 2. Webhook Fallback if configured and not yet sent
  if (!sent && process.env.DISCORD_WEBHOOK_URL) {
    try {
      const resp = await fetch(process.env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: messageContent
        })
      });
      if (resp.ok) {
        sent = true;
        console.log(`✅ [Discord Bot] Clip ${clipData.id} posted via Discord webhook`);
      }
    } catch(err) {
      console.error('❌ [Discord Bot] Error sending clip to Discord webhook:', err.message);
    }
  }

  if (sent) {
    // Delete the original /clip message containing the recording token now that upload is complete
    if (session.interactionToken && session.applicationId) {
      try {
        await fetch(`https://discord.com/api/v10/webhooks/${session.applicationId}/${session.interactionToken}/messages/@original`, {
          method: 'DELETE'
        });
      } catch(delErr) {}
    }
    discordSessions.delete(sessionId);
    return true;
  }

  console.warn(`⚠️ [Discord Bot] Could not deliver clip notification for session: "${sessionId}"`);
  return false;
}
