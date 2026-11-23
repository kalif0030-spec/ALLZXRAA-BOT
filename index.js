const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, REST, Routes, AttachmentBuilder } = require('discord.js');
const axios = require('axios');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Banner Asli ALLZXRAA (Buat di dalem file)
const bannerArt = `
 █████╗ ██╗     ██╗     ███████╗██╗  ██╗██████╗  █████╗  █████╗ 
██╔══██╗██║     ██║     ╚══███╔╝╚██╗██╔╝██╔══██╗██╔══██╗██╔══██╗
███████║██║     ██║       ███╔╝  ╚███╔╝ ██████╔╝███████║███████║
██╔══██║██║     ██║      ███╔╝   ██╔██╗ ██╔══██╗██╔══██║██╔══██║
██║  ██║███████╗███████╗███████╗██╔╝ ██╗██║  ██║██║  ██║██║  ██║
╚═╝  ╚═╝╚══════╝╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝
               ALLZXRAA COMMUNITY BOT
`;

// Fungsi XOR
function xorCipher(str, key) {
    let result = "";
    for (let i = 0; i < str.length; i++) {
        result += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return result;
}

// Fungsi Format ke Lua (\xxx)
function formatToLua(str) {
    let luaFormat = "";
    for (let i = 0; i < str.length; i++) {
        luaFormat += `\\${str.charCodeAt(i).toString().padStart(3, '0')}`;
    }
    return luaFormat;
}

// Fungsi Ambil Teks dari Link
async function getTextFromUrl(url) {
    try {
        const response = await axios.get(url, { responseType: 'text' });
        return response.data;
    } catch (e) {
        return null;
    }
}

// ==========================================
// SLASH COMMANDS
// ==========================================
const commands = [
    new SlashCommandBuilder()
        .setName('obfuscate')
        .setDescription('Obfuscate teks atau link, hasilnya langsung di-download')
        .addStringOption(opt => opt.setName('input').setDescription('Teks atau Link (https://...)').setRequired(true)),
        
    new SlashCommandBuilder()
        .setName('deobfuscate')
        .setDescription('Deobfuscate teks atau link, hasilnya langsung di-download')
        .addStringOption(opt => opt.setName('input').setDescription('Teks obfu atau Link file').setRequired(true))
        .addStringOption(opt => opt.setName('key').setDescription('Key rahasia').setRequired(true)),
];

client.once('ready', async () => {
    console.log(`[+] Bot ${client.user.tag} online!`);
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('[+] Slash commands berhasil didaftarin!');
    } catch (e) { 
        console.error(e); 
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

    // ================= COMMAND OBFUSCATE =================
    if (commandName === 'obfuscate') {
        await interaction.deferReply(); 
        let input = interaction.options.getString('input');
        const key = 'ALLZXRAA'; // Key rahasia
        let isLink = input.startsWith('http');

        let originalText = input;
        if (isLink) {
            originalText = await getTextFromUrl(input);
            if (!originalText) return interaction.editReply('❌ Gagal ambil file dari link sayang~');
        }

        // Proses Obfuscate
        const obfuscated = xorCipher(originalText, key);
        const luaFormat = formatToLua(obfuscated);

        // Gabungin Banner + Hasil Obfu + Kode Asli (comment)
        const finalOutput = `--[[\n${bannerArt}\n]]\n-- [ OBFUSCATED BY ALLZXRAA BOT ]\nlocal script = "${luaFormat}"\nloadstring(script)()\n\n--[[\n--- KODE ASLI ---\n${originalText}\n]]`;

        // Bikin file buat di-download
        const buffer = Buffer.from(finalOutput, 'utf-8');
        const attachment = new AttachmentBuilder(buffer, { name: 'obfuscated_output.lua' });

        const embed = new EmbedBuilder()
            .setTitle('🛡️ Obfuscate Berhasil')
            .setColor('Blue')
            .setDescription(isLink ? `📁 Diambil dari: ${input}` : `📝 Diinput manual`)
            .addFields({ name: 'Status', value: 'File hasil obfu siap di-download! (Banner & Kode asli udah masuk ke dalam file)' });

        await interaction.editReply({ embeds: [embed], files: [attachment] });
    }

    // ================= COMMAND DEOBFUSCATE =================
    if (commandName === 'deobfuscate') {
        await interaction.deferReply();
        let input = interaction.options.getString('input');
        const key = interaction.options.getString('key');
        let isLink = input.startsWith('http');

        let textToDecode = input;
        if (isLink) {
            textToDecode = await getTextFromUrl(input);
            if (!textToDecode) return interaction.editReply('❌ Gagal ambil file dari link sayang~');
        }

        try {
            // Bersihin format \xxx jadi karakter asli
            const parsedTeks = textToDecode.replace(/\\(\d{1,3})/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
            const decoded = xorCipher(parsedTeks, key);

            // Gabungin Banner + Hasil Deobfu
            const finalOutput = `--[[\n${bannerArt}\n]]\n-- [ DEOBFUSCATED BY ALLZXRAA BOT ]\n\n${decoded}`;

            const buffer = Buffer.from(finalOutput, 'utf-8');
            const attachment = new AttachmentBuilder(buffer, { name: 'deobfuscated_output.lua' });

            const embed = new EmbedBuilder()
                .setTitle('🔓 Deobfuscate Berhasil')
                .setColor('Green')
                .setDescription(isLink ? `📁 Diambil dari: ${input}` : `📝 Diinput manual`)
                .addFields({ name: 'Status', value: 'File hasil deobfu siap di-download! (Banner udah masuk ke file)' });

            await interaction.editReply({ embeds: [embed], files: [attachment] });
        } catch (e) {
            await interaction.editReply('❌ Gagal decode sayang~ formatnya salah atau key-nya beda 🥺');
        }
    }
});

client.login(process.env.TOKEN);
