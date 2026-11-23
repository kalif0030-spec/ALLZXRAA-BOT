'use strict';

const {
  Client, Events, GatewayIntentBits, SlashCommandBuilder,
} = require('discord.js');
const config = require('./config');
const resolvers = require('./resolvers');

const cfg = config.load();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const command = new SlashCommandBuilder()
  .setName('bypass')
  .setDescription('Resolve link ke tujuan akhirnya')
  .addStringOption((o) =>
    o.setName('link').setDescription('Link yang mau di-resolve').setRequired(true)
  );

client.once(Events.ClientReady, async (c) => {
  await c.application.commands.set([command.toJSON()]);
  console.log(`Login sebagai ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'bypass') return;
  await interaction.deferReply();
  const res = await resolvers.resolve(interaction.options.getString('link', true), cfg);
  if (!res.ok) {
    await interaction.editReply(`Gagal di-resolve: ${res.note}`);
    return;
  }
  const chain = res.hops.map((h, i) => `${i + 1}. ${h}`).join('\n');
  await interaction.editReply(`Final: ${res.finalUrl}\n\nHop:\n${chain}`.slice(0, 1900));
});

client.login(cfg.botToken);
