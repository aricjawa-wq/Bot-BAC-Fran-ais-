const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder } = require('discord.js');
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
    level INTEGER DEFAULT 1,
    totalQuestions INTEGER DEFAULT 0,
    correctAnswers INTEGER DEFAULT 0,
    dissertations INTEGER DEFAULT 0,
    commentaires INTEGER DEFAULT 0
  )
`);

function getUser(userId) {
  let user = db.prepare('SELECT * FROM users WHERE userId = ?').get(userId);
  if (!user) {
    db.prepare('INSERT INTO users (userId) VALUES (?)').run(userId);
    user = db.prepare('SELECT * FROM users WHERE userId = ?').get(userId);
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

function updateStats(userId, correct) {
  db.prepare('UPDATE users SET totalQuestions = totalQuestions + 1, correctAnswers = correctAnswers + ? WHERE userId = ?').run(correct ? 1 : 0, userId);
}

function updateRédaction(userId, type) {
  if (type === 'essay') db.prepare('UPDATE users SET dissertations = dissertations + 1 WHERE userId = ?').run(userId);
  if (type === 'com') db.prepare('UPDATE users SET commentaires = commentaires + 1 WHERE userId = ?').run(userId);
}

// ─── RÔLES ────────────────────────────────────────────────────────────────────
const ROLES = [
  { level: 1,  name: 'Benjamin Chavent',   color: 0xFF0000 },
  { level: 2,  name: 'Apprentice',          color: 0xFF4500 },
  { level: 3,  name: 'Good Student',        color: 0xFF8C00 },
  { level: 4,  name: 'Aric Jawa',           color: 0xFFD700 },
  { level: 5,  name: 'Anna Cat.',           color: 0x7FFF00 },
  { level: 6,  name: 'Mme Gil',             color: 0x00FF00 },
  { level: 7,  name: 'Mme Gil II',          color: 0x00CED1 },
  { level: 8,  name: 'Mme Gil III',         color: 0x0000FF },
  { level: 9,  name: 'M. Montillo',         color: 0x8A2BE2 },
  { level: 10, name: 'Wallahi ur cheating', color: 0x1a0033 },
];

async function updateRoles(guild, member, newLevel) {
  try {
    const roleData = ROLES[newLevel - 1];
    let role = guild.roles.cache.find(r => r.name === roleData.name);
    if (!role) {
      role = await guild.roles.create({ name: roleData.name, color: roleData.color, reason: 'Rôle XP Bac' });
    }
    for (const r of ROLES) {
      const existing = guild.roles.cache.find(ro => ro.name === r.name);
      if (existing && member.roles.cache.has(existing.id)) await member.roles.remove(existing).catch(() => {});
    }
    await member.roles.add(role).catch(() => {});
  } catch (e) { console.error('Erreur rôle:', e); }
}

async function calculerEtAttribuerXP(interaction, note, type) {
  let xpChange = 0, xpMsg = '';
  if (note !== null) {
    xpChange = note >= 14 ? 20 + (note - 14) * 20 : -(10 * (14 - note));
    xpMsg = xpChange >= 0 ? `📈 **+${xpChange} XP** pour ta note de ${note}/20 !` : `📉 **${xpChange} XP** (en dessous de la moyenne)`;
    const xpResult = addXP(interaction.user.id, xpChange);
    const user = getUser(interaction.user.id);
    const xpInLevel = user.xp % 500;
    const bar = '█'.repeat(Math.floor(xpInLevel / 50)) + '░'.repeat(10 - Math.floor(xpInLevel / 50));
    xpMsg += `\nTotal : **${user.xp} XP** — Niveau **${user.level}**\n${bar} ${xpInLevel}/500`;
    if (xpResult.newLevel > xpResult.oldLevel) {
      const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      if (member) {
        await updateRoles(interaction.guild, member, xpResult.newLevel);
        xpMsg += `\n\n🎉 **Niveau ${xpResult.newLevel} !** Tu es maintenant **${ROLES[xpResult.newLevel - 1].name}**`;
      }
    }
  }
  if (type) updateRédaction(interaction.user.id, type);
  return xpMsg;
}

// ─── ŒUVRES ───────────────────────────────────────────────────────────────────
const OEUVRES = {
  'Douai':          { nom: 'CAHIERS DE DOUAI — Arthur Rimbaud' },
  'DSV':            { nom: 'DISCOURS SUR LA VIOLENCE — textes variés' },
  'LeMenteur':      { nom: 'LE MENTEUR — Corneille' },
  'ExpressionRage': { nom: "PONGE — L'EXPRESSION DE LA RAGE" },
  'PeauDeChagrin':  { nom: 'LA PEAU DE CHAGRIN — Balzac' }
};

const OEUVRES_ESSAY = [
  'Cahiers de Douai (Rimbaud)', 'Le Menteur (Corneille)',
  'La Peau de Chagrin (Balzac)', "L'Expression de la Rage (Ponge)",
  'un groupement de textes sur la violence du discours'
];

// ─── SESSIONS ─────────────────────────────────────────────────────────────────
const qcmSessions = new Map();
const essaySessions = new Map();
const coursSessions = new Map();

// ─── GEMINI ───────────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const MODELS = ['gemini-3.1-flash-lite', 'gemini-3-flash'];

async function callGemini(prompt) {
  for (const modelName of MODELS) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { temperature: 0.7, maxOutputTokens: 4096 } });
      const result = await model.generateContent(prompt);
      console.log(`✅ Modèle : ${modelName}`);
      return result.response.text();
    } catch (err) {
      if (err.status === 429 || err.message?.includes('quota') || err.message?.includes('rate')) {
        console.log(`⚠️ Rate limit sur ${modelName}, bascule...`);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Tous les modèles ont atteint leur limite.');
}

// ─── CLIENT ───────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel, Partials.Message]
});

// ─── COMMANDS ─────────────────────────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName('qcm').setDescription('QCM interactif sur une œuvre'),
    new SlashCommandBuilder().setName('cours').setDescription('Questions de cours ouvertes sur une œuvre'),
    new SlashCommandBuilder().setName('essay').setDescription('Génère une problématique de dissertation'),
    new SlashCommandBuilder().setName('com').setDescription('Génère un texte pour commentaire de texte'),
    new SlashCommandBuilder().setName('plan').setDescription('Entraîne-toi à construire un plan de dissertation'),
    new SlashCommandBuilder().setName('fiche').setDescription('Génère une fiche de révision sur une œuvre'),
    new SlashCommandBuilder().setName('citation').setDescription('Analyse une citation aléatoire d\'une œuvre'),
    new SlashCommandBuilder().setName('end').setDescription('Termine ta rédaction et reçois une correction'),
    new SlashCommandBuilder().setName('close').setDescription('Ferme ce thread'),
    new SlashCommandBuilder().setName('xp').setDescription('Affiche ton niveau et tes XP'),
    new SlashCommandBuilder().setName('stats').setDescription('Affiche tes statistiques détaillées'),
    new SlashCommandBuilder().setName('classement').setDescription('Top 10 du serveur par XP'),
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('✅ Slash commands enregistrées.');
}

// ─── LIRE CATÉGORIE ───────────────────────────────────────────────────────────
async function lireContenuCategorie(guild, oeuvreKey) {
  const oeuvre = OEUVRES[oeuvreKey];
  const categories = guild.channels.cache.filter(c =>
    c.type === 4 && (c.name.toLowerCase().includes(oeuvre.nom.split('—')[0].trim().toLowerCase()) || c.name.toLowerCase().includes(oeuvreKey.toLowerCase()))
  );
  let contenu = `Œuvre : ${oeuvre.nom}\n\n`;
  if (categories.size === 0) { contenu += `[Pas de catégorie. Utilise tes connaissances sur ${oeuvre.nom}]\n`; return contenu; }
  const categorie = categories.first();
  const salons = guild.channels.cache.filter(c => c.parentId === categorie.id && c.isTextBased());
  for (const [, salon] of salons) {
    contenu += `\n--- #${salon.name} ---\n`;
    try {
      const messages = await salon.messages.fetch({ limit: 100 });
      for (const msg of [...messages.values()].reverse()) {
        if (msg.content) contenu += `${msg.content}\n`;
        msg.attachments.forEach(a => { contenu += `[Fichier: ${a.name} — ${a.url}]\n`; });
      }
    } catch { contenu += `[Impossible de lire]\n`; }
  }
  return contenu;
}

function getSelectOeuvres(customId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('Choisis une œuvre').addOptions(
      { label: 'Douai', description: 'Cahiers de Douai — Rimbaud', value: 'Douai' },
      { label: 'DSV', description: 'Discours S.V.', value: 'DSV' },
      { label: 'Le Menteur', description: 'Le Menteur — Corneille', value: 'LeMenteur' },
      { label: 'Expression Rage', description: "Ponge — L'Expression de la Rage", value: 'ExpressionRage' },
      { label: 'Peau de Chagrin', description: 'La Peau de Chagrin — Balzac', value: 'PeauDeChagrin' }
    )
  );
}

// ─── /qcm ─────────────────────────────────────────────────────────────────────
async function handleQcm(interaction) {
  await interaction.reply({ content: '📚 Combien de questions ? (1-10)', ephemeral: true });
  const filter = m => m.author.id === interaction.user.id && !isNaN(m.content) && +m.content >= 1 && +m.content <= 10;
  let collected;
  try { collected = await interaction.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] }); }
  catch { return interaction.followUp({ content: '⏱️ Temps écoulé.', ephemeral: true }); }
  const nbQuestions = parseInt(collected.first().content);
  await collected.first().delete().catch(() => {});
  await interaction.followUp({ content: `✅ **${nbQuestions} question(s)** — Choisis l'œuvre :`, components: [getSelectOeuvres(`qcm_oeuvre_${interaction.user.id}`)], ephemeral: true });
  qcmSessions.set(interaction.user.id, { nbQuestions });
}

async function lancerQcm(interaction, oeuvreKey, nbQuestions) {
  await interaction.deferUpdate();
  const oeuvre = OEUVRES[oeuvreKey];
  const contenu = await lireContenuCategorie(interaction.guild, oeuvreKey);
  const prompt = `Professeur Bac Français 2026. Génère ${nbQuestions} QCM sur "${oeuvre.nom}" basé sur :
${contenu}
Règles : 4 options (A/B/C/D), 1 bonne réponse, options max 60 caractères.
JSON uniquement : {"questions":[{"question":"...","options":["A","B","C","D"],"reponse":0,"explication":"..."}]}`;
  let qcmData;
  try { qcmData = JSON.parse((await callGemini(prompt)).replace(/```json|```/g, '').trim()); }
  catch { return interaction.channel.send('❌ Erreur génération QCM. Réessaie.'); }
  const session = { questions: qcmData.questions, current: 0, score: 0, xpGained: 0, oeuvre: oeuvre.nom };
  qcmSessions.set(interaction.user.id, session);
  await envoyerQuestion(interaction.channel, session, interaction.user.id);
}

async function envoyerQuestion(channel, session, userId) {
  const q = session.questions[session.current];
  const embed = new EmbedBuilder()
    .setColor(0x2B2D31)
    .setTitle(`📖 Question ${session.current + 1}/${session.questions.length}`)
    .setDescription(`**${q.question}**\n\n🅐 ${q.options[0]}\n🅑 ${q.options[1]}\n🅒 ${q.options[2]}\n🅓 ${q.options[3]}`)
    .setFooter({ text: session.oeuvre });
  const row = new ActionRowBuilder().addComponents(
    ['A', 'B', 'C', 'D'].map((letter, i) =>
      new ButtonBuilder().setCustomId(`qcm_rep_${userId}_${i}`).setLabel(letter).setStyle(ButtonStyle.Secondary)
    )
  );
  await new Promise(r => setTimeout(r, 500));
  await channel.send({ embeds: [embed], components: [row] });
}

// ─── /cours ───────────────────────────────────────────────────────────────────
async function handleCours(interaction) {
  await interaction.reply({ content: '🎓 **Questions de cours** — Choisis une œuvre :', components: [getSelectOeuvres(`cours_oeuvre_${interaction.user.id}`)], ephemeral: true });
}

async function lancerCours(interaction, oeuvreKey) {
  await interaction.deferUpdate();
  const oeuvre = OEUVRES[oeuvreKey];
  const contenu = await lireContenuCategorie(interaction.guild, oeuvreKey);

  const typesDeQuestions = [
    'une question sur le contexte historique ou biographique de l\'auteur',
    'une question sur la structure ou la composition de l\'œuvre',
    'une question sur un personnage ou un thème central',
    'une question sur le style ou les procédés littéraires',
    'une question sur une scène ou un passage précis',
    'une question sur les axes d\'étude au programme',
    'une question sur les liens entre l\'œuvre et son époque',
    'une question sur la réception critique de l\'œuvre',
  ];
  const typeChoisi = typesDeQuestions[Math.floor(Math.random() * typesDeQuestions.length)];

  const prompt = `Tu es un professeur de Français pour le Bac 2026.
En te basant sur ces informations sur "${oeuvre.nom}" :
${contenu}

Pose UNE question ouverte de cours sur cette œuvre. La question doit porter sur : ${typeChoisi}.
La question doit être précise, importante pour le Bac, et nécessiter une réponse développée.
Réponds UNIQUEMENT avec la question, sans introduction ni commentaire.`;

  const question = await callGemini(prompt);

  const thread = await interaction.channel.threads.create({
    name: `🎓 Cours — ${oeuvre.nom.split('—')[0].trim()} — ${interaction.user.username}`,
    autoArchiveDuration: 1440
  });

  const embed = new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle('🎓 Question de Cours — Bac de Français 2026')
    .setDescription(`**Œuvre :** ${oeuvre.nom}\n\n**Question :**\n*${question.trim()}*`)
    .addFields({ name: 'Comment ça marche', value: 'Réponds librement dans ce thread.\nTape `/end` quand tu as terminé pour recevoir une correction et des XP.' })
    .setFooter({ text: 'Réponds comme à l\'oral du Bac !' });

  await thread.send({ embeds: [embed] });

  coursSessions.set(thread.id, {
    type: 'cours',
    userId: interaction.user.id,
    question: question.trim(),
    oeuvre: oeuvre.nom,
    messages: []
  });

  await interaction.channel.send(`✅ <@${interaction.user.id}> — Ta question de cours t'attend : ${thread}`);
}

// ─── /plan ────────────────────────────────────────────────────────────────────
async function handlePlan(interaction) {
  await interaction.reply({ content: '📋 **Plan de dissertation** — Choisis une œuvre :', components: [getSelectOeuvres(`plan_oeuvre_${interaction.user.id}`)], ephemeral: true });
}

async function lancerPlan(interaction, oeuvreKey) {
  await interaction.deferUpdate();
  const oeuvre = OEUVRES[oeuvreKey];
  const oeuvreEssay = OEUVRES_ESSAY.find(o => o.toLowerCase().includes(oeuvreKey.toLowerCase().substring(0, 5))) || OEUVRES_ESSAY[0];

  const prompt = `Tu es un professeur de Français pour le Bac 2026.
Génère un sujet de dissertation sur "${oeuvre.nom}".
Réponds UNIQUEMENT avec le sujet, sans introduction.`;

  const sujet = await callGemini(prompt);

  const thread = await interaction.channel.threads.create({
    name: `📋 Plan — ${interaction.user.username}`,
    autoArchiveDuration: 1440
  });

  const embed = new EmbedBuilder()
    .setColor(0x1ABC9C)
    .setTitle('📋 Entraînement au Plan — Bac de Français 2026')
    .setDescription(`**Œuvre :** ${oeuvre.nom}\n\n**Sujet :**\n*${sujet.trim()}*`)
    .addFields({ name: 'Consigne', value: 'Rédige UNIQUEMENT le plan (I, II, III avec sous-parties A, B).\nPas de rédaction — juste la structure et les grandes idées.\nTape `/end` pour recevoir ta correction.' })
    .setFooter({ text: 'Un bon plan = une bonne dissertation !' });

  await thread.send({ embeds: [embed] });

  essaySessions.set(thread.id, {
    type: 'plan',
    userId: interaction.user.id,
    sujet: sujet.trim(),
    oeuvre: oeuvre.nom,
    messages: []
  });

  await interaction.channel.send(`✅ <@${interaction.user.id}> — Ton sujet de plan t'attend : ${thread}`);
}

// ─── /fiche ───────────────────────────────────────────────────────────────────
async function handleFiche(interaction) {
  await interaction.reply({ content: '📄 **Fiche de révision** — Choisis une œuvre :', components: [getSelectOeuvres(`fiche_oeuvre_${interaction.user.id}`)], ephemeral: true });
}

async function lancerFiche(interaction, oeuvreKey) {
  await interaction.deferUpdate();
  const oeuvre = OEUVRES[oeuvreKey];
  const contenu = await lireContenuCategorie(interaction.guild, oeuvreKey);

  const prompt = `Tu es un professeur de Français pour le Bac 2026.
Génère une fiche de révision complète sur "${oeuvre.nom}" en te basant sur :
${contenu}

La fiche doit contenir :
1. **Contexte** : auteur, époque, genre
2. **Résumé** : en 5-6 lignes max
3. **Personnages / Voix principales** : les plus importants avec 1 ligne chacun
4. **Thèmes majeurs** : 4-5 thèmes avec une phrase d'explication
5. **Axes d'étude au Bac** : 3 axes avec une problématique possible
6. **Citations clés** : 5 citations essentielles avec leur analyse en 1 ligne
7. **À retenir absolument** : 5 points incontournables pour le Bac

Réponds en français, format structuré et clair.`;

  const fiche = await callGemini(prompt);

  const embed = new EmbedBuilder()
    .setColor(0xF39C12)
    .setTitle(`📄 Fiche de révision — ${oeuvre.nom}`)
    .setDescription(fiche.substring(0, 4096))
    .setFooter({ text: 'Bac de Français 2026' });

  await interaction.channel.send({ embeds: [embed] });

  if (fiche.length > 4096) {
    for (const chunk of fiche.substring(4096).match(/.{1,2000}/gs) || []) {
      await interaction.channel.send(chunk);
    }
  }
}

// ─── /citation ────────────────────────────────────────────────────────────────
async function handleCitation(interaction) {
  await interaction.reply({ content: '💬 **Analyse de citation** — Choisis une œuvre :', components: [getSelectOeuvres(`citation_oeuvre_${interaction.user.id}`)], ephemeral: true });
}

async function lancerCitation(interaction, oeuvreKey) {
  await interaction.deferUpdate();
  const oeuvre = OEUVRES[oeuvreKey];
  const contenu = await lireContenuCategorie(interaction.guild, oeuvreKey);

  const prompt = `Tu es un professeur de Français pour le Bac 2026.
En te basant sur "${oeuvre.nom}" et ces informations :
${contenu}

Choisis UNE citation importante et représentative de l'œuvre.
JSON uniquement sans markdown :
{"citation":"la citation exacte","source":"acte/chapitre/poème etc","piste":"une piste d'analyse en 1 phrase pour aider l'élève"}`;

  let data;
  try { data = JSON.parse((await callGemini(prompt)).replace(/```json|```/g, '').trim()); }
  catch { return interaction.channel.send('❌ Erreur. Réessaie.'); }

  const thread = await interaction.channel.threads.create({
    name: `💬 Citation — ${interaction.user.username}`,
    autoArchiveDuration: 1440
  });

  const embed = new EmbedBuilder()
    .setColor(0xE91E63)
    .setTitle('💬 Analyse de Citation — Bac de Français 2026')
    .setDescription(`**Œuvre :** ${oeuvre.nom}\n\n> *${data.citation}*\n\n**Source :** ${data.source}`)
    .addFields(
      { name: 'Piste d\'analyse', value: data.piste },
      { name: 'Consigne', value: 'Rédige ton analyse de cette citation (procédés, sens, portée).\nTape `/end` pour recevoir ta correction et des XP.' }
    )
    .setFooter({ text: 'L\'analyse de citation est clé pour l\'oral !' });

  await thread.send({ embeds: [embed] });

  essaySessions.set(thread.id, {
    type: 'citation',
    userId: interaction.user.id,
    citation: data.citation,
    source: data.source,
    oeuvre: oeuvre.nom,
    messages: []
  });

  await interaction.channel.send(`✅ <@${interaction.user.id}> — Ta citation t'attend : ${thread}`);
}

// ─── /essay ───────────────────────────────────────────────────────────────────
async function handleEssay(interaction) {
  await interaction.deferReply();
  const oeuvreChoisie = OEUVRES_ESSAY[Math.floor(Math.random() * OEUVRES_ESSAY.length)];
  const prompt = `Professeur Bac Français 2026. Génère une problématique originale de dissertation sur : ${oeuvreChoisie}. Niveau Terminale. UNIQUEMENT la problématique.`;
  const problematique = await callGemini(prompt);
  const thread = await interaction.channel.threads.create({ name: `📝 Dissertation — ${interaction.user.username}`, autoArchiveDuration: 1440 });
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📝 Dissertation — Bac de Français 2026')
    .setDescription(`**Œuvre :** ${oeuvreChoisie}\n\n**Problématique :**\n*${problematique.trim()}*`)
    .addFields({ name: 'Comment ça marche', value: 'Rédige ici message par message. Tape `/end` pour la correction.' });
  await thread.send({ embeds: [embed] });
  essaySessions.set(thread.id, { type: 'essay', userId: interaction.user.id, problematique: problematique.trim(), oeuvre: oeuvreChoisie, messages: [] });
  await interaction.editReply(`✅ Thread créé : ${thread}`);
}

// ─── /com ─────────────────────────────────────────────────────────────────────
async function handleCom(interaction) {
  await interaction.deferReply();
  const prompt = `Professeur Bac Français 2026. Choisis un extrait littéraire riche (15-25 lignes), niveau Terminale. Génère une problématique de commentaire.
JSON uniquement : {"titre":"Titre — Auteur","extrait":"texte","problematique":"..."}`;
  let data;
  try { data = JSON.parse((await callGemini(prompt)).replace(/```json|```/g, '').trim()); }
  catch { return interaction.editReply('❌ Erreur. Réessaie.'); }
  const thread = await interaction.channel.threads.create({ name: `📄 Commentaire — ${interaction.user.username}`, autoArchiveDuration: 1440 });
  const embed = new EmbedBuilder()
    .setColor(0xE67E22)
    .setTitle('📄 Commentaire de Texte — Bac de Français 2026')
    .setDescription(`**${data.titre}**\n\n${data.extrait.substring(0, 1800)}\n\n**Problématique :** *${data.problematique}*`)
    .addFields({ name: 'Comment ça marche', value: 'Rédige ton commentaire ici. Tape `/end` pour la correction.' });
  await thread.send({ embeds: [embed] });
  essaySessions.set(thread.id, { type: 'com', userId: interaction.user.id, problematique: data.problematique, texte: data.extrait, titre: data.titre, messages: [] });
  await interaction.editReply(`✅ Thread créé : ${thread}`);
}

// ─── /end ─────────────────────────────────────────────────────────────────────
async function handleEnd(interaction) {
  const session = essaySessions.get(interaction.channelId) || coursSessions.get(interaction.channelId);
  if (!session) return interaction.reply({ content: '❌ Aucune session active ici.', ephemeral: true });
  if (session.userId !== interaction.user.id) return interaction.reply({ content: '❌ Ce n\'est pas ton exercice.', ephemeral: true });

  await interaction.deferReply();
  const texteEleve = session.messages.join('\n\n');
  if (!texteEleve.trim()) return interaction.editReply('❌ Tu n\'as rien écrit.');

  let prompt;

  if (session.type === 'essay') {
    prompt = `Correcteur Bac Français 2026. Œuvre : ${session.oeuvre}. Problématique : "${session.problematique}".
Dissertation : """${texteEleve}"""
Critères (4pts) : compréhension, plan, arguments/exemples, expression, intro/conclusion.
Note + réussites + améliorations par critère. Termine par NOTE_GLOBALE: X/20 seul sur une ligne, commentaire, 3 priorités.`;
  } else if (session.type === 'com') {
    prompt = `Correcteur Bac Français 2026. Texte : ${session.titre}. Extrait : """${session.texte}""". Problématique : "${session.problematique}".
Commentaire : """${texteEleve}"""
Critères (4pts) : lecture/compréhension, plan, analyse stylistique, citations, expression.
Note + réussites + améliorations. Termine par NOTE_GLOBALE: X/20 seul sur une ligne, commentaire, 3 priorités.`;
  } else if (session.type === 'plan') {
    prompt = `Correcteur Bac Français 2026. Œuvre : ${session.oeuvre}. Sujet : "${session.sujet}".
Plan de l'élève : """${texteEleve}"""
Évalue : pertinence des axes, logique de la progression, qualité des sous-parties, rapport au sujet.
Note sur 20 + réussites + améliorations détaillées. Termine par NOTE_GLOBALE: X/20 seul sur une ligne et 3 priorités.`;
  } else if (session.type === 'citation') {
    prompt = `Correcteur Bac Français 2026. Œuvre : ${session.oeuvre}. Citation : "${session.citation}" (${session.source}).
Analyse de l'élève : """${texteEleve}"""
Évalue : identification des procédés, pertinence de l'interprétation, richesse de l'analyse, expression.
Note sur 20 + réussites + améliorations. Termine par NOTE_GLOBALE: X/20 seul sur une ligne et 3 priorités.`;
  } else if (session.type === 'cours') {
    prompt = `Professeur Bac Français 2026. Œuvre : ${session.oeuvre}. Question : "${session.question}".
Réponse de l'élève : """${texteEleve}"""
Évalue l'exactitude, la précision, la complétude et l'expression.
Donne la réponse idéale attendue au Bac, puis évalue l'élève.
Note sur 20 + ce qui est juste + ce qui manque + conseils. Termine par NOTE_GLOBALE: X/20 seul sur une ligne.`;
  }

  const correction = await callGemini(prompt);
  const noteMatch = correction.match(/NOTE_GLOBALE:\s*(\d+(?:\.\d+)?)\/20/);
  const note = noteMatch ? parseFloat(noteMatch[1]) : null;
  const xpMsg = await calculerEtAttribuerXP(interaction, note, session.type);
  const correctionDisplay = correction.replace(/NOTE_GLOBALE:.*$/m, '').trim();

  const titres = { essay: '✅ Correction Dissertation', com: '✅ Correction Commentaire', plan: '✅ Correction Plan', citation: '✅ Correction Analyse de Citation', cours: '✅ Correction Question de Cours' };

  const embed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle(titres[session.type] || '✅ Correction')
    .setDescription(correctionDisplay.substring(0, 4096))
    .setFooter({ text: 'Continue à travailler ! 💪' });

  await interaction.editReply({ embeds: [embed] });
  if (correctionDisplay.length > 4096) {
    for (const chunk of correctionDisplay.substring(4096).match(/.{1,2000}/gs) || []) await interaction.channel.send(chunk);
  }
  if (xpMsg) await interaction.channel.send(xpMsg);

  essaySessions.delete(interaction.channelId);
  coursSessions.delete(interaction.channelId);
}

// ─── /close ───────────────────────────────────────────────────────────────────
async function handleClose(interaction) {
  if (!interaction.channel.isThread()) return interaction.reply({ content: '❌ Thread uniquement.', ephemeral: true });
  await interaction.reply('🔒 Fermeture dans 3 secondes...');
  setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
}

// ─── /xp ──────────────────────────────────────────────────────────────────────
async function handleXpCommand(interaction) {
  const user = getUser(interaction.user.id);
  const xpInLevel = user.xp % 500;
  const bar = '█'.repeat(Math.floor(xpInLevel / 50)) + '░'.repeat(10 - Math.floor(xpInLevel / 50));
  const embed = new EmbedBuilder()
    .setColor(ROLES[user.level - 1].color)
    .setTitle(`🎓 ${interaction.user.username}`)
    .addFields(
      { name: 'Niveau', value: `**${user.level}** — ${ROLES[user.level - 1].name}`, inline: true },
      { name: 'XP Total', value: `**${user.xp} XP**`, inline: true },
      { name: 'Prochain niveau', value: ROLES[user.level] ? ROLES[user.level].name : '👑 MAX', inline: true },
      { name: 'Progression', value: `${bar} ${xpInLevel}/500` }
    );
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ─── /stats ───────────────────────────────────────────────────────────────────
async function handleStats(interaction) {
  const user = getUser(interaction.user.id);
  const tauxReussite = user.totalQuestions > 0 ? Math.round((user.correctAnswers / user.totalQuestions) * 100) : 0;
  const embed = new EmbedBuilder()
    .setColor(ROLES[user.level - 1].color)
    .setTitle(`📊 Stats de ${interaction.user.username}`)
    .addFields(
      { name: '🎯 QCM', value: `${user.correctAnswers}/${user.totalQuestions} correctes (${tauxReussite}%)`, inline: true },
      { name: '📝 Dissertations', value: `${user.dissertations || 0} rédigées`, inline: true },
      { name: '📄 Commentaires', value: `${user.commentaires || 0} rédigés`, inline: true },
      { name: '⭐ XP Total', value: `**${user.xp} XP**`, inline: true },
      { name: '🏅 Niveau', value: `**${user.level}** — ${ROLES[user.level - 1].name}`, inline: true }
    )
    .setFooter({ text: 'Bac de Français 2026' });
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ─── /classement ──────────────────────────────────────────────────────────────
async function handleClassement(interaction) {
  const top = db.prepare('SELECT * FROM users ORDER BY xp DESC LIMIT 10').all();
  if (!top.length) return interaction.reply({ content: '❌ Aucun utilisateur encore.', ephemeral: true });

  let description = '';
  const medals = ['🥇', '🥈', '🥉'];

  for (let i = 0; i < top.length; i++) {
    const u = top[i];
    let member;
    try { member = await interaction.guild.members.fetch(u.userId); } catch { continue; }
    const medal = medals[i] || `**${i + 1}.**`;
    description += `${medal} ${member.displayName} — **${u.xp} XP** — Niv. ${u.level} (${ROLES[u.level - 1].name})\n`;
  }

  const embed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle('🏆 Classement — Bac de Français 2026')
    .setDescription(description)
    .setFooter({ text: 'Continue à réviser pour grimper !' });

  await interaction.reply({ embeds: [embed] });
}

// ─── EVENTS ───────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);
  await registerCommands();
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'qcm')        return await handleQcm(interaction);
      if (interaction.commandName === 'cours')      return await handleCours(interaction);
      if (interaction.commandName === 'essay')      return await handleEssay(interaction);
      if (interaction.commandName === 'com')        return await handleCom(interaction);
      if (interaction.commandName === 'plan')       return await handlePlan(interaction);
      if (interaction.commandName === 'fiche')      return await handleFiche(interaction);
      if (interaction.commandName === 'citation')   return await handleCitation(interaction);
      if (interaction.commandName === 'end')        return await handleEnd(interaction);
      if (interaction.commandName === 'close')      return await handleClose(interaction);
      if (interaction.commandName === 'xp')         return await handleXpCommand(interaction);
      if (interaction.commandName === 'stats')      return await handleStats(interaction);
      if (interaction.commandName === 'classement') return await handleClassement(interaction);
    }

    if (interaction.isStringSelectMenu()) {
      const [cmd, , userId] = interaction.customId.split('_');
      if (interaction.user.id !== userId) return;

      if (cmd === 'qcm') {
        const session = qcmSessions.get(userId);
        if (session) await lancerQcm(interaction, interaction.values[0], session.nbQuestions);
      } else if (cmd === 'cours') {
        await lancerCours(interaction, interaction.values[0]);
      } else if (cmd === 'plan') {
        await lancerPlan(interaction, interaction.values[0]);
      } else if (cmd === 'fiche') {
        await lancerFiche(interaction, interaction.values[0]);
      } else if (cmd === 'citation') {
        await lancerCitation(interaction, interaction.values[0]);
      }
    }

    if (interaction.isButton() && interaction.customId.startsWith('qcm_rep_')) {
      const parts = interaction.customId.split('_');
      const userId = parts[2];
      const repIndex = parseInt(parts[3]);
      if (interaction.user.id !== userId) return interaction.reply({ content: '❌ Ce n\'est pas ton QCM.', ephemeral: true });
      const session = qcmSessions.get(userId);
      if (!session) return;

      await interaction.deferUpdate();

      const q = session.questions[session.current];
      const correct = repIndex === q.reponse;
      if (correct) session.score++;
      const xpChange = correct ? 10 : -5;
      session.xpGained += xpChange;
      const xpResult = addXP(userId, xpChange);
      updateStats(userId, correct);

      const correctionEmbed = new EmbedBuilder()
        .setColor(correct ? 0x57F287 : 0xED4245)
        .setTitle(correct ? '✅ Bonne réponse ! +10 XP' : '❌ Mauvaise réponse — 5 XP')
        .setDescription(`**Bonne réponse : ${['A', 'B', 'C', 'D'][q.reponse]} — ${q.options[q.reponse]}**\n\n💡 ${q.explication}`);

      await interaction.channel.send({ embeds: [correctionEmbed] });

      if (xpResult.newLevel > xpResult.oldLevel) {
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        if (member) {
          await updateRoles(interaction.guild, member, xpResult.newLevel);
          await interaction.channel.send(`🎉 <@${userId}> passe au **niveau ${xpResult.newLevel}** — **${ROLES[xpResult.newLevel - 1].name}** !`);
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
            `XP ce QCM : **${session.xpGained >= 0 ? '+' : ''}${session.xpGained} XP**\n` +
            `XP total : **${user.xp} XP** — Niveau **${user.level}**`
          )
          .setFooter({ text: session.oeuvre });
        await interaction.channel.send({ embeds: [scoreEmbed] });
        qcmSessions.delete(userId);
      } else {
        await envoyerQuestion(interaction.channel, session, userId);
      }
    }
  } catch (err) {
    console.error('Erreur:', err);
    try {
      const msg = { content: '❌ Une erreur est survenue. Réessaie.', flags: 64 };
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
      else await interaction.reply(msg);
    } catch {}
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (!message.channel.isThread()) return;
  const session = essaySessions.get(message.channel.id) || coursSessions.get(message.channel.id);
  if (!session || session.userId !== message.author.id) return;
  if (message.content.startsWith('/')) return;
  session.messages.push(message.content);
});

client.login(DISCORD_TOKEN);
