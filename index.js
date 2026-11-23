const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, REST, Routes, AttachmentBuilder } = require('discord.js');
const axios = require('axios');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const bannerArt = `
 █████╗ ██╗     ██╗     ███████╗██╗  ██╗██████╗  █████╗  █████╗ 
██╔══██╗██║     ██║     ╚══███╔╝╚██╗██╔╝██╔══██╗██╔══██╗██╔══██╗
███████║██║     ██║       ███╔╝  ╚███╔╝ ██████╔╝███████║███████║
██╔══██║██║     ██║      ███╔╝   ██╔██╗ ██╔══██╗██╔══██║██╔══██║
██║  ██║███████╗███████╗███████╗██╔╝ ██╗██║  ██║██║  ██║██║  ██║
╚═╝  ╚═╝╚══════╝╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝
               ALLZXRAA COMMUNITY BOT
`;

function xorCipher(str, key) {
    let result = "";
    for (let i = 0; i < str.length; i++) {
        result += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return result;
}

function formatToLua(str) {
    let luaFormat = "";
    for (let i = 0; i < str.length; i++) {
        luaFormat += `\\${str.charCodeAt(i).toString().padStart(3, '0')}`;
    }
    return luaFormat;
}

async function getTextFromUrl(url) {
    try {
        const response = await axios.get(url, { responseType: 'text' });
        return response.data;
    } catch (e) {
        return null;
    }
}

const commands = [
    new SlashCommandBuilder()
        .setName('obfuscate')
        .setDescription('Obfuscate teks, link, atau file .lua')
        .addStringOption(opt => opt.setName('teks').setDescription('Ketik teks manual (opsional)'))
        .addStringOption(opt => opt.setName('link').setDescription('Paste link raw (opsional)'))
        .addAttachmentOption(opt => opt.setName('file').setDescription('Upload file .lua (opsional)')),
        
    new SlashCommandBuilder()
        .setName('deobfuscate')
        .setDescription('Deobfuscate teks, link, atau file .lua')
        .addStringOption(opt => opt.setName('teks').setDescription('Ketik teks obfu manual (opsional)'))
        .addStringOption(opt => opt.setName('link').setDescription('Paste link raw (opsional)'))
        .addAttachmentOption(opt => opt.setName('file').setDescription('Upload file .lua obfu (opsional)')),
];

client.once('clientReady', async () => { // Pake clientReady biar gak ada warning
    console.log(`[+] Bot ${client.user.tag} online!`);
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('[+] Slash commands berhasil didaftarin!');
    } catch (e) { console.error(e); }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

    // ================= COMMAND OBFUSCATE =================
    if (commandName === 'obfuscate') {
        await interaction.deferReply(); 
        const teksManual = interaction.options.getString('teks');
        const linkInput = interaction.options.getString('link');
        const fileInput = interaction.options.getAttachment('file');
        const key = 'ALLZXRAA'; // Key otomatis

        let originalText = "";

        try {
            if (fileInput) {
                const res = await axios.get(fileInput.url, { responseType: 'text' });
                originalText = res.data;
            } else if (linkInput) {
                originalText = await getTextFromUrl(linkInput);
            } else if (teksManual) {
                originalText = teksManual;
            }

            if (!originalText) return interaction.editReply('❌ Kamu harus isi salah satu: Teks, Link, atau Upload File sayang~');

            const obfuscated = xorCipher(originalText, key);
            const luaFormat = formatToLua(obfuscated);
            const finalOutput = `--[[\n${bannerArt}\n]]\n-- [ OBFUSCATED BY ALLZXRAA BOT ]\nlocal script = "${luaFormat}"\nloadstring(script)()\n\n--[[\n--- KODE ASLI ---\n${originalText}\n]]`;

            const buffer = Buffer.from(finalOutput, 'utf-8');
            const attachment = new AttachmentBuilder(buffer, { name: 'obfuscated_output.lua' });

            const embed = new EmbedBuilder()
                .setTitle('🛡️ Obfuscate Berhasil')
                .setColor('Blue')
                .setDescription(`📁 Sumber: ${fileInput ? 'Upload File' : linkInput ? 'Link' : 'Teks Manual'}`)
                .addFields({ name: 'Status', value: 'File hasil obfu siap di-download!' });

            await interaction.editReply({ embeds: [embed], files: [attachment] });

        } catch (e) {
            await interaction.editReply('❌ Gagal memproses file/link sayang~ pastiin filenya bener ya 🥺');
        }
    }

    // ================= COMMAND DEOBFUSCATE =================
    if (commandName === 'deobfuscate') {
        await interaction.deferReply();
        const teksManual = interaction.options.getString('teks');
        const linkInput = interaction.options.getString('link');
        const fileInput = interaction.options.getAttachment('file');
        const key = 'ALLZXRAA'; // Key otomatis (sama kayak obfuscate)

        let textToDecode = "";

        try {
            if (fileInput) {
                const res = await axios.get(fileInput.url, { responseType: 'text' });
                textToDecode = res.data;
            } else if (linkInput) {
                textToDecode = await getTextFromUrl(linkInput);
            } else if (teksManual) {
                textToDecode = teksManual;
            }

            if (!textToDecode) return interaction.editReply('❌ Kamu harus isi salah satu: Teks, Link, atau Upload File sayang~');

            const parsedTeks = textToDecode.replace(/\\(\d{1,3})/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
            const decoded = xorCipher(parsedTeks, key);
            const finalOutput = `--[[\n${bannerArt}\n]]\n-- [ DEOBFUSCATED BY ALLZXRAA BOT ]\n\n${decoded}`;

            const buffer = Buffer.from(finalOutput, 'utf-8');
            const attachment = new AttachmentBuilder(buffer, { name: 'deobfuscated_output.lua' });

            const embed = new EmbedBuilder()
                .setTitle('🔓 Deobfuscate Berhasil')
                .setColor('Green')
                .setDescription(`📁 Sumber: ${fileInput ? 'Upload File' : linkInput ? 'Link' : 'Teks Manual'}`)
                .addFields({ name: 'Status', value: 'File hasil deobfu siap di-download!' });

            await interaction.editReply({ embeds: [embed], files: [attachment] });

        } catch (e) {
            await interaction.editReply('❌ Gagal decode sayang~ formatnya salah atau filenya bukan hasil obfu bot ini 🥺');
        }
    }
});

client.login(process.env.TOKEN);
