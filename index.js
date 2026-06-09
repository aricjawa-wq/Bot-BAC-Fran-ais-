const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Database = require('better-sqlite3');
const path = require('path');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const db = new Database(path.join('/app', 'xp.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    userId TEXT PRIMARY KEY,
    xp INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1
  )
`);

function getUser(userId) {
  let user = db.prepare('SELECT * FROM users WHERE userId = ?').get(userId);
  if (!user) {
    db.prepare('INSERT INTO users (userId, xp, level) VALUES (?, 0, 1)').run(userId);
    user = { userId, xp: 0, level: 1 };
  }
  return user;
}

function addXP(userId, amount) {
  const user = getUser(userId);
  const newXP = Math.max(0, user.xp + amount);
  const newLevel = Math.min(10, Math.floor(newXP / 500) + 1);
  db.prepare('UPDATE users SET xp = ?, level = ? WHERE userId = ?').run(newXP, newLevel, userId);
  return { oldLevel: user.level, newLevel, xp: newXP, gained: amount };
}

// ─── RÔLES ────────────────────────────────────────────────────────────────────
const ROLES = [
  { level: 1,  name: 'Benjamin Chavent',    color: 0xFF0000 },
  { level: 2,  name: 'Apprentice',           color: 0xFF4500 },
  { level: 3,  name: 'Good Student',         color: 0xFF8C00 },
  { level: 4,  name: 'Aric Jawa',            color: 0xFFD700 },
  { level: 5,  name: 'Anna Cat.',            color: 0x7FFF00 },
  { level: 6,  name: 'Mme Gil',              color: 0x00FF00 },
  { level: 7,  name: 'Mme Gil II',           color: 0x00CED1 },
  { level: 8,  name: 'Mme Gil III',          color: 0x0000FF },
  { level: 9,  name: 'M. Montillo',          color: 0x8A2BE2 },
  { level: 10, name: 'Wallahi ur cheating',  color: 0x1a0033 },
];

async function updateRoles(guild, member, newLevel) {
  try {
    const roleData = ROLES[newLevel - 1];
    let role = guild.roles.cache.find(r => r.name === roleData.name);
    if (!role) {
      role = await guild.roles.create({
        name: roleData.name,
        color: roleData.color,
        reason: 'Rôle XP Bac de Français'
      });
    }
    for (const r of ROLES) {
      const existing = guild.roles.cache.find(ro => ro.name === r.name);
      if (existing && member.roles.cache.has(existing.id)) {
        await member.roles.remove(existing).catch(() => {});
      }
    }
    await member.roles.add(role).catch(() => {});
    return role;
  } catch (e) {
    console.error('Erreur rôle:', e);
    return null;
  }
}

async function handleXPResult(interaction, result, guild) {
  const { oldLevel, newLevel, xp, gained } = result;
  const userId = interaction.user.id;
  const xpInLevel = xp % 500;
  const bar = '█'.repeat(Math.floor(xpInLevel / 50)) + '░'.repeat(10 - Math.floor(xpInLevel / 50));
  const gainedStr = gained >= 0 ? `+${gained} XP 🟢` : `${gained} XP 🔴`;
  let msg = `${gainedStr} — Total : **${xp} XP**\n${bar} ${xpInLevel}/500`;
  if (newLevel > oldLevel) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) {
      await updateRoles(guild, member, newLevel);
      msg += `\n\n🎉 **Niveau ${newLevel} atteint !** Tu es maintenant **${ROLES[newLevel - 1].name}**`;
    }
  }
  return msg;
}

// ─── XP DISSERTATION / COMMENTAIRE (logique partagée) ────────────────────────
async function calculerEtAttribuerXP(interaction, note) {
  let xpChange = 0;
  let xpMsg = '';
  if (note !== null) {
    if (note >= 14) {
      xpChange = 20 + (note - 14) * 20;
      xpMsg = `📈 **+${xpChange} XP** pour ta note de ${note}/20 !`;
    } else {
      xpChange = -(10 * (14 - note));
      xpMsg = `📉 **${xpChange} XP** (en dessous de la moyenne)`;
    }
    const xpResult = addXP(interaction.user.id, xpChange);
    const xpUpdate = await handleXPResult(interaction, xpResult, interaction.guild);
    xpMsg += `\n${xpUpdate}`;
  }
  return xpMsg;
}

// ─── ŒUVRES ───────────────────────────────────────────────────────────────────
const OEUVRES = {
  'Douai': { label: 'Douai', nom: 'CAHIERS DE DOUAI — Arthur Rimbaud' },
  'DSV': { label: 'DSV', nom: 'DISCOURS SUR LA VIOLENCE — textes variés' },
  'LeMenteur': { label: 'Le Menteur', nom: 'LE MENTEUR — Corneille' },
  'ExpressionRage': { label: 'Expression Rage', nom: "PONGE — L'EXPRESSION DE LA RAGE" },
  'PeauDeChagrin': { label: 'Peau de Chagrin', nom: 'LA PEAU DE CHAGRIN — Balzac' }
};

const OEUVRES_ESSAY = [
  'Cahiers de Douai (Rimbaud)',
  'Le Menteur (Corneille)',
  'La Peau de Chagrin (Balzac)',
  "L'Expression de la Rage (Ponge)",
  'un groupement de textes sur la violence du discours'
];

// ─── ÉTAT SESSIONS ────────────────────────────────────────────────────────────
const qcmSessions = new Map();
const essaySessions = new Map();   // type: 'essay' | 'com'

// ─── INIT GEMINI ──────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-3.1-flash-lite',
  generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
});

async function callGemini(prompt) {
  const result = await model.generateContent(prompt);
  return result.response.text();
}

// ─── CLIENT DISCORD ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message]
});

// ─── REGISTER SLASH COMMANDS ─────────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('qcm')
      .setDescription('Lance un QCM interactif sur une œuvre au programme du Bac de Français 2026'),
    new SlashCommandBuilder()
      .setName('essay')
      .setDescription('Génère une problématique de dissertation et t\'accompagne dans ta rédaction'),
    new SlashCommandBuilder()
      .setName('com')
      .setDescription('Génère un texte et une problématique pour un commentaire de texte'),
    new SlashCommandBuilder()
      .setName('end')
      .setDescription('Termine ta rédaction et reçois une correction détaillée'),
    new SlashCommandBuilder()
      .setName('close')
      .setDescription('Ferme ce thread'),
    new SlashCommandBuilder()
      .setName('xp')
      .setDescription('Affiche ton niveau et tes points XP'),
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('✅ Slash commands enregistrées.');
}

// ─── LIRE LE CONTENU D'UNE CATÉGORIE ─────────────────────────────────────────
async function lireContenuCategorie(guild, oeuvreKey) {
  const oeuvre = OEUVRES[oeuvreKey];
  const categories = guild.channels.cache.filter(c =>
    c.type === 4 &&
    (c.name.toLowerCase().includes(oeuvre.nom.split('—')[0].trim().toLowerCase()) ||
     c.name.toLowerCase().includes(oeuvreKey.toLowerCase()))
  );

  let contenu = `Œuvre : ${oeuvre.nom}\n\n`;
  if (categories.size === 0) {
    contenu += `[Aucune catégorie trouvée. Utilise les connaissances générales sur ${oeuvre.nom}]\n`;
    return contenu;
  }

  const categorie = categories.first();
  const salons = guild.channels.cache.filter(c => c.parentId === categorie.id && c.isTextBased());

  for (const [, salon] of salons) {
    contenu += `\n--- Salon : #${salon.name} ---\n`;
    try {
      const messages = await salon.messages.fetch({ limit: 100 });
      const sorted = [...messages.values()].reverse();
      for (const msg of sorted) {
        if (msg.content) contenu += `[Message] ${msg.content}\n`;
        if (msg.attachments.size > 0) {
          msg.attachments.forEach(a => { contenu += `[Pièce jointe] ${a.name} : ${a.url}\n`; });
        }
        if (msg.embeds.length > 0) {
          msg.embeds.forEach(e => {
            if (e.title) contenu += `[Embed titre] ${e.title}\n`;
            if (e.description) contenu += `[Embed description] ${e.description}\n`;
          });
        }
      }
    } catch (e) {
      contenu += `[Impossible de lire ce salon]\n`;
    }
  }
  return contenu;
}

// ─── COMMANDE /qcm ────────────────────────────────────────────────────────────
async function handleQcm(interaction) {
  await interaction.reply({
    content: '📚 **Bac de Français 2026** — Combien de questions veux-tu ? (entre 1 et 10)',
    ephemeral: true
  });

  const filter = m => m.author.id === interaction.user.id && !isNaN(m.content) && +m.content >= 1 && +m.content <= 10;
  let collected;
  try {
    collected = await interaction.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
  } catch {
    return interaction.followUp({ content: '⏱️ Temps écoulé. Relance `/qcm`.', ephemeral: true });
  }

  const nbQuestions = parseInt(collected.first().content);
  await collected.first().delete().catch(() => {});

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`qcm_oeuvre_${interaction.user.id}`)
    .setPlaceholder('Choisis une œuvre')
    .addOptions(
      { label: 'Douai', description: 'Cahiers de Douai — Rimbaud', value: 'Douai' },
      { label: 'DSV', description: 'Discours S.V.', value: 'DSV' },
      { label: 'Le Menteur', description: 'Le Menteur — Corneille', value: 'LeMenteur' },
      { label: 'Expression Rage', description: "Ponge — L'Expression de la Rage", value: 'ExpressionRage' },
      { label: 'Peau de Chagrin', description: 'La Peau de Chagrin — Balzac', value: 'PeauDeChagrin' }
    );

  await interaction.followUp({
    content: `✅ **${nbQuestions} question(s)** — Choisis l'œuvre :`,
    components: [new ActionRowBuilder().addComponents(selectMenu)],
    ephemeral: true
  });

  qcmSessions.set(interaction.user.id, { nbQuestions, step: 'awaiting_oeuvre' });
}

// ─── LANCEMENT QCM APRÈS SÉLECTION ───────────────────────────────────────────
async function lancerQcm(interaction, oeuvreKey, nbQuestions) {
  await interaction.deferUpdate();

  const oeuvre = OEUVRES[oeuvreKey];
  const contenu = await lireContenuCategorie(interaction.guild, oeuvreKey);

  const prompt = `Tu es un professeur de Français pour le Bac 2026 en France.
En te basant sur les informations suivantes sur l'œuvre "${oeuvre.nom}" :

${contenu}

Génère exactement ${nbQuestions} question(s) QCM en français sur cette œuvre.
Chaque question doit avoir exactement 4 propositions (A, B, C, D).
Une seule bonne réponse par question.
Les options doivent être courtes (moins de 60 caractères chacune).

Réponds UNIQUEMENT en JSON valide, sans markdown, sans backticks, sans texte avant ou après :
{
  "questions": [
    {
      "question": "texte de la question",
      "options": ["option A", "option B", "option C", "option D"],
      "reponse": 0,
      "explication": "explication courte de la bonne réponse"
    }
  ]
}
La valeur de "reponse" est l'index (0=A, 1=B, 2=C, 3=D).`;

  let qcmData;
  try {
    const raw = await callGemini(prompt);
    const cleaned = raw.replace(/```json|```/g, '').trim();
    qcmData = JSON.parse(cleaned);
  } catch (e) {
    return interaction.followUp({ content: '❌ Erreur lors de la génération du QCM. Réessaie.', ephemeral: true });
  }

  const session = {
    questions: qcmData.questions,
    current: 0,
    score: 0,
    xpGained: 0,
    oeuvre: oeuvre.nom,
    channelId: interaction.channelId
  };
  qcmSessions.set(interaction.user.id, session);
  await envoyerQuestion(interaction, session, interaction.user.id);
}

async function envoyerQuestion(interaction, session, userId) {
  const q = session.questions[session.current];
  const embed = new EmbedBuilder()
    .setColor(0x2B2D31)
    .setTitle(`📖 Question ${session.current + 1}/${session.questions.length}`)
    .setDescription(`**${q.question}**\n\n🅐 ${q.options[0]}\n🅑 ${q.options[1]}\n🅒 ${q.options[2]}\n🅓 ${q.options[3]}`)
    .setFooter({ text: session.oeuvre });

  const row = new ActionRowBuilder().addComponents(
    ['A', 'B', 'C', 'D'].map((letter, i) =>
      new ButtonBuilder()
        .setCustomId(`qcm_rep_${userId}_${i}`)
        .setLabel(letter)
        .setStyle(ButtonStyle.Secondary)
    )
  );

  await interaction.followUp({ embeds: [embed], components: [row], ephemeral: true });

}

// ─── COMMANDE /essay ─────────────────────────────────────────────────────────
async function handleEssay(interaction) {
  await interaction.deferReply();

  const oeuvreChoisie = OEUVRES_ESSAY[Math.floor(Math.random() * OEUVRES_ESSAY.length)];

  const prompt = `Tu es un professeur de Français pour le Bac de Français 2026 en France.
Génère une problématique originale pour une dissertation littéraire sur l'œuvre suivante : ${oeuvreChoisie}.
La problématique doit être ouverte, littéraire, et adaptée au niveau Terminale.
Réponds UNIQUEMENT avec la problématique, sans introduction ni commentaire.`;

  const problematique = await callGemini(prompt);

  const thread = await interaction.channel.threads.create({
    name: `📝 Dissertation — ${interaction.user.username}`,
    autoArchiveDuration: 1440,
    reason: 'Session dissertation Bac de Français'
  });

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📝 Ta Dissertation — Bac de Français 2026')
    .setDescription(`**Œuvre :** ${oeuvreChoisie}\n\n**Problématique :**\n\n*${problematique.trim()}*`)
    .addFields({ name: 'Comment ça marche', value: 'Rédige ta dissertation ici, message par message.\nTape `/end` quand tu as terminé pour recevoir ta correction et tes XP.' })
    .setFooter({ text: 'Bon courage ! 💪' });

  await thread.send({ embeds: [embed] });

  essaySessions.set(thread.id, {
    type: 'essay',
    userId: interaction.user.id,
    problematique: problematique.trim(),
    oeuvre: oeuvreChoisie,
    messages: [],
    startTime: Date.now()
  });

  await interaction.editReply(`✅ Ton espace de dissertation a été créé : ${thread}`);
}

// ─── COMMANDE /com ────────────────────────────────────────────────────────────
async function handleCom(interaction) {
  await interaction.deferReply();

  const prompt = `Tu es un professeur de Français pour le Bac de Français 2026 en France.
Choisis un extrait littéraire adapté au niveau Terminale, provenant de n'importe quelle époque ou genre (poésie, roman, théâtre, essai).
L'extrait doit être suffisamment riche pour faire l'objet d'un commentaire de texte au Bac.

Génère ensuite une problématique de commentaire de texte pour cet extrait.

Réponds UNIQUEMENT en JSON valide, sans markdown, sans backticks :
{
  "titre": "Titre de l'œuvre et auteur",
  "extrait": "Le texte complet de l'extrait (15 à 25 lignes)",
  "problematique": "La problématique du commentaire"
}`;

  let data;
  try {
    const raw = await callGemini(prompt);
    const cleaned = raw.replace(/```json|```/g, '').trim();
    data = JSON.parse(cleaned);
  } catch (e) {
    return interaction.editReply('❌ Erreur lors de la génération du texte. Réessaie.');
  }

  const thread = await interaction.channel.threads.create({
    name: `📄 Commentaire — ${interaction.user.username}`,
    autoArchiveDuration: 1440,
    reason: 'Session commentaire de texte Bac de Français'
  });

  const embed = new EmbedBuilder()
    .setColor(0xE67E22)
    .setTitle('📄 Commentaire de Texte — Bac de Français 2026')
    .setDescription(
      `**Texte :** *${data.titre}*\n\n` +
      `${data.extrait.length > 1800 ? data.extrait.substring(0, 1800) + '...' : data.extrait}\n\n` +
      `**Problématique :**\n*${data.problematique}*`
    )
    .addFields({ name: 'Comment ça marche', value: 'Rédige ton commentaire de texte ici, message par message.\nTape `/end` quand tu as terminé pour recevoir ta correction et tes XP.' })
    .setFooter({ text: 'Bon courage ! 💪' });

  await thread.send({ embeds: [embed] });

  essaySessions.set(thread.id, {
    type: 'com',
    userId: interaction.user.id,
    problematique: data.problematique,
    texte: data.extrait,
    titre: data.titre,
    messages: [],
    startTime: Date.now()
  });

  await interaction.editReply(`✅ Ton espace de commentaire a été créé : ${thread}`);
}

// ─── COMMANDE /end ────────────────────────────────────────────────────────────
async function handleEnd(interaction) {
  const session = essaySessions.get(interaction.channelId);

  if (!session) {
    return interaction.reply({ content: '❌ Aucune session active dans ce thread. Lance `/essay` ou `/com` d\'abord.', ephemeral: true });
  }

  if (session.userId !== interaction.user.id) {
    return interaction.reply({ content: '❌ Ce n\'est pas ton exercice.', ephemeral: true });
  }

  await interaction.deferReply();

  const texteEleve = session.messages.join('\n\n');

  if (!texteEleve.trim()) {
    return interaction.editReply('❌ Tu n\'as rien écrit encore. Rédige quelque chose avant de taper `/end`.');
  }

  let prompt;

  if (session.type === 'essay') {
    prompt = `Tu es un correcteur expert du Bac de Français 2026 en France.

Œuvre : ${session.oeuvre}
Problématique : "${session.problematique}"

Dissertation de l'élève :
"""
${texteEleve}
"""

Corrige cette dissertation selon les critères officiels du Bac de Français 2026 :
1. Compréhension du sujet et pertinence de la problématique
2. Construction du plan (thèses, antithèses, synthèse)
3. Qualité des arguments et des exemples littéraires
4. Expression écrite (syntaxe, vocabulaire, style)
5. Introduction et conclusion

Pour chaque critère :
- Donne une note sur 4 points
- Explique ce qui est réussi
- Explique ce qui peut être amélioré avec des conseils concrets

Termine par :
- Une note globale sur 20 (format exact: "NOTE_GLOBALE: X/20" sur une ligne séparée)
- Un commentaire bienveillant et encourageant
- Les 3 priorités d'amélioration

Réponds en français, de façon structurée et pédagogique.`;
  } else {
    prompt = `Tu es un correcteur expert du Bac de Français 2026 en France.

Texte étudié : ${session.titre}
Extrait :
"""
${session.texte}
"""

Problématique : "${session.problematique}"

Commentaire de texte de l'élève :
"""
${texteEleve}
"""

Corrige ce commentaire de texte selon les critères officiels du Bac de Français 2026 :
1. Pertinence de la lecture et compréhension du texte
2. Construction du plan en lien avec la problématique
3. Qualité de l'analyse stylistique et des procédés littéraires
4. Utilisation des citations et exemples du texte
5. Expression écrite (syntaxe, vocabulaire, style)

Pour chaque critère :
- Donne une note sur 4 points
- Explique ce qui est réussi
- Explique ce qui peut être amélioré avec des conseils concrets

Termine par :
- Une note globale sur 20 (format exact: "NOTE_GLOBALE: X/20" sur une ligne séparée)
- Un commentaire bienveillant et encourageant
- Les 3 priorités d'amélioration

Réponds en français, de façon structurée et pédagogique.`;
  }

  const correction = await callGemini(prompt);

  const noteMatch = correction.match(/NOTE_GLOBALE:\s*(\d+(?:\.\d+)?)\/20/);
  const note = noteMatch ? parseFloat(noteMatch[1]) : null;

  const xpMsg = await calculerEtAttribuerXP(interaction, note);
  const correctionDisplay = correction.replace(/NOTE_GLOBALE:.*$/m, '').trim();

  const titre = session.type === 'essay'
    ? '✅ Correction de ta Dissertation — Bac de Français 2026'
    : '✅ Correction de ton Commentaire de Texte — Bac de Français 2026';

  const embed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle(titre)
    .setDescription(correctionDisplay.length > 4096 ? correctionDisplay.substring(0, 4093) + '...' : correctionDisplay)
    .setFooter({ text: 'Continue à travailler, tu progresses ! 💪' });

  await interaction.editReply({ embeds: [embed] });

  if (correctionDisplay.length > 4096) {
    const chunks = correctionDisplay.substring(4093).match(/.{1,2000}/gs) || [];
    for (const chunk of chunks) await interaction.channel.send(chunk);
  }

  if (xpMsg) await interaction.channel.send(xpMsg);

  essaySessions.delete(interaction.channelId);
}

// ─── COMMANDE /close ──────────────────────────────────────────────────────────
async function handleClose(interaction) {
  if (!interaction.channel.isThread()) {
    return interaction.reply({ content: '❌ Cette commande ne fonctionne que dans un thread.', ephemeral: true });
  }
  await interaction.reply('🔒 Fermeture du thread dans 3 secondes...');
  setTimeout(async () => { await interaction.channel.delete().catch(() => {}); }, 3000);
}

// ─── COMMANDE /xp ─────────────────────────────────────────────────────────────
async function handleXpCommand(interaction) {
  const user = getUser(interaction.user.id);
  const xpInLevel = user.xp % 500;
  const bar = '█'.repeat(Math.floor(xpInLevel / 50)) + '░'.repeat(10 - Math.floor(xpInLevel / 50));
  const roleName = ROLES[user.level - 1].name;
  const nextRole = ROLES[user.level] ? ROLES[user.level].name : '👑 MAX';

  const embed = new EmbedBuilder()
    .setColor(ROLES[user.level - 1].color)
    .setTitle(`🎓 ${interaction.user.username}`)
    .addFields(
      { name: 'Niveau', value: `**${user.level}** — ${roleName}`, inline: true },
      { name: 'XP Total', value: `**${user.xp} XP**`, inline: true },
      { name: 'Prochain niveau', value: nextRole, inline: true },
      { name: 'Progression', value: `${bar} ${xpInLevel}/500` }
    )
    .setFooter({ text: 'Bac de Français 2026 — Continue à réviser !' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ─── ÉVÉNEMENTS ───────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);
  await registerCommands();
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'qcm')   return await handleQcm(interaction);
      if (interaction.commandName === 'essay') return await handleEssay(interaction);
      if (interaction.commandName === 'com')   return await handleCom(interaction);
      if (interaction.commandName === 'end')   return await handleEnd(interaction);
      if (interaction.commandName === 'close') return await handleClose(interaction);
      if (interaction.commandName === 'xp')    return await handleXpCommand(interaction);
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('qcm_oeuvre_')) {
      const userId = interaction.customId.split('_')[2];
      if (interaction.user.id !== userId) return;
      const session = qcmSessions.get(userId);
      if (!session) return;
      await lancerQcm(interaction, interaction.values[0], session.nbQuestions);
    }

    if (interaction.isButton() && interaction.customId.startsWith('qcm_rep_')) {
      const parts = interaction.customId.split('_');
      const userId = parts[2];
      const repIndex = parseInt(parts[3]);

      if (interaction.user.id !== userId) {
        return interaction.reply({ content: '❌ Ce n\'est pas ton QCM.', ephemeral: true });
      }

      const session = qcmSessions.get(userId);
      if (!session) return;

      await interaction.deferUpdate();

      const q = session.questions[session.current];
      const correct = repIndex === q.reponse;

      if (correct) session.score++;
      const xpChange = correct ? 10 : -5;
      session.xpGained += xpChange;
      const xpResult = addXP(userId, xpChange);

      const embed = new EmbedBuilder()
        .setColor(correct ? 0x57F287 : 0xED4245)
        .setTitle(correct ? '✅ Bonne réponse ! +10 XP' : '❌ Mauvaise réponse — 5 XP')
        .setDescription(`**Bonne réponse : ${['A', 'B', 'C', 'D'][q.reponse]} — ${q.options[q.reponse]}**\n\n💡 ${q.explication}`);

      await interaction.editReply({ embeds: [embed], components: [] });

      if (xpResult.newLevel > xpResult.oldLevel) {
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        if (member) {
          await updateRoles(interaction.guild, member, xpResult.newLevel);
          await interaction.followUp({
            content: `🎉 <@${userId}> passe au **niveau ${xpResult.newLevel}** — **${ROLES[xpResult.newLevel - 1].name}** !`,
            ephemeral: false
          });
        }
      }

      session.current++;

      if (session.current >= session.questions.length) {
        const user = getUser(userId);
        const scoreEmbed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle('🎓 QCM terminé !')
          .setDescription(
            `**Score : ${session.score}/${session.questions.length}**\n\n` +
            `XP gagné ce QCM : **${session.xpGained > 0 ? '+' : ''}${session.xpGained} XP**\n` +
            `XP total : **${user.xp} XP** — Niveau **${user.level}**`
          )
          .setFooter({ text: session.oeuvre });

        await interaction.followUp({ embeds: [scoreEmbed], ephemeral: true });
        qcmSessions.delete(userId);
      } else {
        await envoyerQuestion(interaction, session, userId);
      }
    }
  } catch (err) {
    console.error('Erreur interaction:', err);
    const reply = interaction.replied || interaction.deferred ? interaction.followUp : interaction.reply;
    await reply.call(interaction, { content: '❌ Une erreur est survenue. Réessaie.', ephemeral: true }).catch(() => {});
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (!message.channel.isThread()) return;
  const session = essaySessions.get(message.channel.id);
  if (!session) return;
  if (session.userId !== message.author.id) return;
  if (message.content.startsWith('/')) return;
  session.messages.push(message.content);
});

client.login(DISCORD_TOKEN);
