const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder } = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Database = require('better-sqlite3');
const path = require('path');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// ─── INSTRUCTIONS GLOBALES GEMINI ─────────────────────────────────────────────
const SYSTEM_CONTEXT = `Tu es un professeur de Français pour le Bac 2026 en France, niveau Terminale.
Tu t'appuies sur les analyses disponibles sur commentairecompose.fr pour toutes les œuvres au programme.
Tes questions, problématiques et corrections sont toujours simples, claires et accessibles à un élève de Terminale.
Tu évites le jargon universitaire excessif. Tes problématiques font une phrase courte et compréhensible.
Les œuvres au programme sont : Cahiers de Douai (Rimbaud), Le Menteur (Corneille), La Peau de Chagrin (Balzac), L'Expression de la Rage (Ponge), Discours sur la violence.`;

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const db = new Database(path.join('/app', 'xp.db'));
db.exec(`CREATE TABLE IF NOT EXISTS users (
  userId TEXT PRIMARY KEY, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 1,
  totalQuestions INTEGER DEFAULT 0, correctAnswers INTEGER DEFAULT 0,
  dissertations INTEGER DEFAULT 0, commentaires INTEGER DEFAULT 0
)`);

function getUser(userId) {
  let u = db.prepare('SELECT * FROM users WHERE userId = ?').get(userId);
  if (!u) { db.prepare('INSERT INTO users (userId) VALUES (?)').run(userId); u = db.prepare('SELECT * FROM users WHERE userId = ?').get(userId); }
  return u;
}
function addXP(userId, amount) {
  const u = getUser(userId);
  const newXP = Math.max(0, u.xp + amount);
  const newLevel = Math.min(10, Math.floor(newXP / 500) + 1);
  db.prepare('UPDATE users SET xp = ?, level = ? WHERE userId = ?').run(newXP, newLevel, userId);
  return { oldLevel: u.level, newLevel, xp: newXP };
}
function updateStats(userId, correct) {
  db.prepare('UPDATE users SET totalQuestions = totalQuestions + 1, correctAnswers = correctAnswers + ? WHERE userId = ?').run(correct ? 1 : 0, userId);
}
function updateRedaction(userId, type) {
  if (type === 'essay') db.prepare('UPDATE users SET dissertations = dissertations + 1 WHERE userId = ?').run(userId);
  if (type === 'com') db.prepare('UPDATE users SET commentaires = commentaires + 1 WHERE userId = ?').run(userId);
}

// ─── RÔLES ────────────────────────────────────────────────────────────────────
const ROLES = [
  { level:1,  name:'Benjamin Chavent',   color:0xFF0000 },
  { level:2,  name:'Apprentice',          color:0xFF4500 },
  { level:3,  name:'Good Student',        color:0xFF8C00 },
  { level:4,  name:'Aric Jawa',           color:0xFFD700 },
  { level:5,  name:'Anna Cat.',           color:0x7FFF00 },
  { level:6,  name:'Mme Gil',             color:0x00FF00 },
  { level:7,  name:'Mme Gil II',          color:0x00CED1 },
  { level:8,  name:'Mme Gil III',         color:0x0000FF },
  { level:9,  name:'M. Montillo',         color:0x8A2BE2 },
  { level:10, name:'Wallahi ur cheating', color:0x1a0033 },
];

async function updateRoles(guild, member, newLevel) {
  try {
    const rd = ROLES[newLevel - 1];
    let role = guild.roles.cache.find(r => r.name === rd.name);
    if (!role) role = await guild.roles.create({ name: rd.name, color: rd.color, reason: 'XP Bac' });
    for (const r of ROLES) {
      const ex = guild.roles.cache.find(ro => ro.name === r.name);
      if (ex && member.roles.cache.has(ex.id)) await member.roles.remove(ex).catch(() => {});
    }
    await member.roles.add(role).catch(() => {});
  } catch (e) { console.error('Erreur rôle:', e); }
}

async function giveXP(guild, userId, amount) {
  const res = addXP(userId, amount);
  const u = getUser(userId);
  const xpInLevel = u.xp % 500;
  const bar = '█'.repeat(Math.floor(xpInLevel / 50)) + '░'.repeat(10 - Math.floor(xpInLevel / 50));
  let msg = `${amount >= 0 ? '+' : ''}${amount} XP — Total : **${u.xp} XP** — Niv. **${u.level}**\n${bar} ${xpInLevel}/500`;
  if (res.newLevel > res.oldLevel) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) {
      await updateRoles(guild, member, res.newLevel);
      msg += `\n🎉 **Niveau ${res.newLevel} !** Tu es **${ROLES[res.newLevel - 1].name}**`;
    }
  }
  return msg;
}

async function calculerXPRedaction(guild, userId, note, type) {
  let xpChange = 0, msg = '';
  if (note !== null) {
    xpChange = note >= 14 ? 20 + (note - 14) * 20 : -(10 * (14 - note));
    const xpMsg = await giveXP(guild, userId, xpChange);
    msg = `${xpChange >= 0 ? '📈' : '📉'} **${xpChange >= 0 ? '+' : ''}${xpChange} XP** (${note}/20)\n${xpMsg}`;
  }
  if (type) updateRedaction(userId, type);
  return msg;
}

// ─── ŒUVRES ───────────────────────────────────────────────────────────────────
const OEUVRES = {
  'Douai':          { nom: 'CAHIERS DE DOUAI — Arthur Rimbaud', url: 'https://commentairecompose.fr/cahiers-de-douai/' },
  'DSV':            { nom: 'DISCOURS SUR LA VIOLENCE — textes variés', url: 'https://commentairecompose.fr/' },
  'LeMenteur':      { nom: 'LE MENTEUR — Corneille', url: 'https://commentairecompose.fr/le-menteur-corneille/' },
  'ExpressionRage': { nom: "PONGE — L'EXPRESSION DE LA RAGE", url: 'https://commentairecompose.fr/ponge/' },
  'PeauDeChagrin':  { nom: 'LA PEAU DE CHAGRIN — Balzac', url: 'https://commentairecompose.fr/la-peau-de-chagrin/' }
};
const OEUVRES_ESSAY = [
  'Cahiers de Douai (Rimbaud)', 'Le Menteur (Corneille)',
  'La Peau de Chagrin (Balzac)', "L'Expression de la Rage (Ponge)",
  'un groupement de textes sur la violence du discours'
];

// ─── SESSIONS ─────────────────────────────────────────────────────────────────
const qcmSessions      = new Map();
const essaySessions    = new Map();
const coursSessions    = new Map();
const revisionSessions = new Map();
const userActiveSessions = new Map();

function registerSession(userId, type, threadId) {
  if (!userActiveSessions.has(userId)) userActiveSessions.set(userId, []);
  userActiveSessions.get(userId).push({ type, threadId });
}
function unregisterSession(userId, threadId) {
  if (!userActiveSessions.has(userId)) return;
  userActiveSessions.set(userId, userActiveSessions.get(userId).filter(s => s.threadId !== threadId));
}

// ─── GEMINI ───────────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const MODELS = ['gemini-3.1-flash-lite', 'gemini-3-flash'];

async function callGemini(prompt) {
  const fullPrompt = `${SYSTEM_CONTEXT}\n\n${prompt}`;
  for (const modelName of MODELS) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { temperature: 0.7, maxOutputTokens: 4096 } });
      const result = await model.generateContent(fullPrompt);
      console.log(`✅ ${modelName}`);
      return result.response.text();
    } catch (err) {
      if (err.status === 429 || err.message?.includes('quota') || err.message?.includes('rate')) {
        console.log(`⚠️ Rate limit ${modelName}`); continue;
      }
      throw err;
    }
  }
  throw new Error('Tous les modèles en limite.');
}

// ─── CLIENT ───────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel, Partials.Message]
});

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName('qcm').setDescription('QCM interactif sur une œuvre'),
    new SlashCommandBuilder().setName('cours').setDescription('Questions de cours ouvertes'),
    new SlashCommandBuilder().setName('essay').setDescription('Dissertation guidée'),
    new SlashCommandBuilder().setName('com').setDescription('Commentaire de texte'),
    new SlashCommandBuilder().setName('plan').setDescription('Entraînement au plan'),
    new SlashCommandBuilder().setName('fiche').setDescription('Fiche de révision'),
    new SlashCommandBuilder().setName('citation').setDescription('Analyse de citation'),
    new SlashCommandBuilder().setName('revision').setDescription('Révision complète d\'une œuvre (6 étapes)'),
    new SlashCommandBuilder().setName('valider').setDescription('Valider ta réponse dans une révision'),
    new SlashCommandBuilder().setName('end').setDescription('Terminer une rédaction libre'),
    new SlashCommandBuilder().setName('cancel').setDescription('Annuler toutes tes sessions actives'),
    new SlashCommandBuilder().setName('close').setDescription('Fermer ce thread'),
    new SlashCommandBuilder().setName('xp').setDescription('Ton niveau et XP'),
    new SlashCommandBuilder().setName('stats').setDescription('Tes statistiques'),
    new SlashCommandBuilder().setName('classement').setDescription('Top 10 du serveur'),
  ].map(cmd => cmd.toJSON());
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('✅ Slash commands enregistrées.');
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function lireContenuCategorie(guild, oeuvreKey) {
  const oeuvre = OEUVRES[oeuvreKey];
  const cats = guild.channels.cache.filter(c =>
    c.type === 4 && (c.name.toLowerCase().includes(oeuvre.nom.split('—')[0].trim().toLowerCase()) || c.name.toLowerCase().includes(oeuvreKey.toLowerCase()))
  );
  let contenu = `Œuvre : ${oeuvre.nom}\nSource de référence : ${oeuvre.url}\n\n`;
  if (!cats.size) { contenu += `[Pas de catégorie Discord. Base-toi sur commentairecompose.fr et tes connaissances sur ${oeuvre.nom}]\n`; return contenu; }
  const cat = cats.first();
  const salons = guild.channels.cache.filter(c => c.parentId === cat.id && c.isTextBased());
  for (const [, salon] of salons) {
    contenu += `\n--- #${salon.name} ---\n`;
    try {
      const msgs = await salon.messages.fetch({ limit: 100 });
      for (const msg of [...msgs.values()].reverse()) {
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
      { label: 'Douai',           description: 'Cahiers de Douai — Rimbaud',       value: 'Douai' },
      { label: 'DSV',             description: 'Discours S.V.',                    value: 'DSV' },
      { label: 'Le Menteur',      description: 'Le Menteur — Corneille',           value: 'LeMenteur' },
      { label: 'Expression Rage', description: "Ponge — L'Expression de la Rage", value: 'ExpressionRage' },
      { label: 'Peau de Chagrin', description: 'La Peau de Chagrin — Balzac',     value: 'PeauDeChagrin' }
    )
  );
}

async function envoyerQuestion(channel, session, userId) {
  const q = session.questions[session.current];
  const embed = new EmbedBuilder()
    .setColor(0x2B2D31)
    .setTitle(`📖 Question ${session.current + 1}/${session.questions.length}`)
    .setDescription(`**${q.question}**\n\n🅐 ${q.options[0]}\n🅑 ${q.options[1]}\n🅒 ${q.options[2]}\n🅓 ${q.options[3]}`)
    .setFooter({ text: session.oeuvre });
  const row = new ActionRowBuilder().addComponents(
    ['A', 'B', 'C', 'D'].map((l, i) =>
      new ButtonBuilder().setCustomId(`qcm_rep_${userId}_${i}`).setLabel(l).setStyle(ButtonStyle.Secondary)
    )
  );
  await new Promise(r => setTimeout(r, 500));
  await channel.send({ embeds: [embed], components: [row] });
}

// ─── PROMPTS CENTRALISÉS ──────────────────────────────────────────────────────
function promptProblematique(oeuvre) {
  return `Génère une problématique courte et simple pour une dissertation de Terminale sur "${oeuvre}".
La problématique doit être en une seule phrase claire, compréhensible par un lycéen, sans jargon compliqué.
Inspire-toi des problématiques proposées sur commentairecompose.fr.
UNIQUEMENT la problématique, sans introduction ni guillemets.`;
}

function promptSujet(oeuvre) {
  return `Génère un sujet de dissertation accessible pour un élève de Terminale sur "${oeuvre}".
Le sujet doit être court, clair, et réaliste pour un Bac de Français standard.
Inspire-toi des sujets de commentairecompose.fr.
UNIQUEMENT le sujet.`;
}

function promptCorrection(type, contexte, texteEleve) {
  const criteres = {
    essay: 'compréhension du sujet, construction du plan, qualité des arguments, expression écrite, introduction et conclusion',
    com: 'compréhension du texte, construction du plan, analyse des procédés littéraires, utilisation des citations, expression écrite',
    plan: 'pertinence des axes, logique de la progression, qualité des sous-parties, rapport au sujet',
    citation: 'identification des procédés, pertinence de l\'interprétation, richesse de l\'analyse',
    cours: 'exactitude, précision, complétude de la réponse, expression'
  };
  return `${contexte}

Travail de l'élève :
"""${texteEleve}"""

Corrige ce travail de façon bienveillante et pédagogique. Critères : ${criteres[type] || criteres.essay}.
Explique ce qui est bien fait et ce qui peut être amélioré avec des conseils concrets.
Termine par NOTE_GLOBALE: X/20 seul sur une ligne à la fin.`;
}

// ─── /qcm ─────────────────────────────────────────────────────────────────────
async function handleQcm(interaction) {
  await interaction.reply({ content: '📚 Combien de questions ? (1-10)', ephemeral: true });
  const filter = m => m.author.id === interaction.user.id && !isNaN(m.content) && +m.content >= 1 && +m.content <= 10;
  let collected;
  try { collected = await interaction.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] }); }
  catch { return interaction.followUp({ content: '⏱️ Temps écoulé.', ephemeral: true }); }
  const nb = parseInt(collected.first().content);
  await collected.first().delete().catch(() => {});
  await interaction.followUp({ content: `✅ **${nb} question(s)** — Choisis l'œuvre :`, components: [getSelectOeuvres(`qcm_oeuvre_${interaction.user.id}`)], ephemeral: true });
  qcmSessions.set(interaction.user.id, { nbQuestions: nb });
}

async function lancerQcm(interaction, oeuvreKey, nb) {
  await interaction.deferUpdate();
  const oeuvre = OEUVRES[oeuvreKey];
  const contenu = await lireContenuCategorie(interaction.guild, oeuvreKey);
  const prompt = `Génère ${nb} questions QCM sur "${oeuvre.nom}". Basé sur :\n${contenu}
Les questions doivent porter sur des points importants pour le Bac (thèmes, personnages, procédés, structure).
4 options (A/B/C/D), 1 bonne réponse, options courtes (max 60 caractères).
JSON uniquement : {"questions":[{"question":"...","options":["A","B","C","D"],"reponse":0,"explication":"..."}]}`;
  let data;
  try { data = JSON.parse((await callGemini(prompt)).replace(/```json|```/g, '').trim()); }
  catch { return interaction.channel.send('❌ Erreur génération QCM. Réessaie.'); }
  const session = { questions: data.questions, current: 0, score: 0, xpGained: 0, oeuvre: oeuvre.nom };
  qcmSessions.set(interaction.user.id, session);
  await envoyerQuestion(interaction.channel, session, interaction.user.id);
}

// ─── /cours ───────────────────────────────────────────────────────────────────
async function handleCours(interaction) {
  await interaction.reply({ content: '🎓 **Questions de cours** — Choisis une œuvre :', components: [getSelectOeuvres(`cours_oeuvre_${interaction.user.id}`)], ephemeral: true });
}
async function lancerCours(interaction, oeuvreKey) {
  await interaction.deferUpdate();
  const oeuvre = OEUVRES[oeuvreKey];
  const contenu = await lireContenuCategorie(interaction.guild, oeuvreKey);
  const types = ['le contexte historique ou biographique', 'la structure de l\'œuvre', 'un personnage ou thème important', 'un procédé littéraire caractéristique', 'un passage ou une scène clé', 'les axes d\'étude principaux'];
  const type = types[Math.floor(Math.random() * types.length)];
  const question = await callGemini(`Pose une question de cours simple et claire sur "${oeuvre.nom}" portant sur : ${type}.
La réponse attendue est un court paragraphe (environ une demi-page A4).
La question doit être accessible à un lycéen de Terminale.
Basé sur :\n${contenu}\nUNIQUEMENT la question.`);
  const thread = await interaction.channel.threads.create({ name: `🎓 Cours — ${oeuvre.nom.split('—')[0].trim()} — ${interaction.user.username}`, autoArchiveDuration: 1440 });
  const embed = new EmbedBuilder().setColor(0x9B59B6).setTitle('🎓 Question de Cours — Bac 2026')
    .setDescription(`**Œuvre :** ${oeuvre.nom}\n\n*${question.trim()}*`)
    .addFields({ name: 'Comment ça marche', value: 'Réponds librement. Tape `/end` pour la correction.' });
  await thread.send({ embeds: [embed] });
  coursSessions.set(thread.id, { type: 'cours', userId: interaction.user.id, question: question.trim(), oeuvre: oeuvre.nom, messages: [] });
  registerSession(interaction.user.id, 'cours', thread.id);
  await interaction.channel.send(`✅ <@${interaction.user.id}> — Ta question t'attend : ${thread}`);
}

// ─── /essay ───────────────────────────────────────────────────────────────────
async function handleEssay(interaction) {
  await interaction.deferReply();
  const oeuvre = OEUVRES_ESSAY[Math.floor(Math.random() * OEUVRES_ESSAY.length)];
  const prob = await callGemini(promptProblematique(oeuvre));
  const thread = await interaction.channel.threads.create({ name: `📝 Dissertation — ${interaction.user.username}`, autoArchiveDuration: 1440 });
  const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('📝 Dissertation — Bac 2026')
    .setDescription(`**Œuvre :** ${oeuvre}\n\n**Problématique :**\n*${prob.trim()}*`)
    .addFields({ name: 'Comment ça marche', value: 'Rédige ici. Tape `/end` pour la correction.' });
  await thread.send({ embeds: [embed] });
  essaySessions.set(thread.id, { type: 'essay', userId: interaction.user.id, problematique: prob.trim(), oeuvre, messages: [] });
  registerSession(interaction.user.id, 'essay', thread.id);
  await interaction.editReply(`✅ Thread créé : ${thread}`);
}

// ─── /com ─────────────────────────────────────────────────────────────────────
async function handleCom(interaction) {
  await interaction.deferReply();
  let data;
  try {
    data = JSON.parse((await callGemini(`Choisis un extrait littéraire clair et accessible (15-25 lignes) pour un élève de Terminale.
Génère une problématique simple pour un commentaire de texte.
JSON uniquement : {"titre":"Titre — Auteur","extrait":"texte complet","problematique":"problématique courte et claire"}`)).replace(/```json|```/g, '').trim());
  } catch { return interaction.editReply('❌ Erreur. Réessaie.'); }
  const thread = await interaction.channel.threads.create({ name: `📄 Commentaire — ${interaction.user.username}`, autoArchiveDuration: 1440 });
  const embed = new EmbedBuilder().setColor(0xE67E22).setTitle('📄 Commentaire — Bac 2026')
    .setDescription(`**${data.titre}**\n\n${data.extrait.substring(0, 1800)}\n\n**Problématique :** *${data.problematique}*`)
    .addFields({ name: 'Comment ça marche', value: 'Rédige ton commentaire. Tape `/end` pour la correction.' });
  await thread.send({ embeds: [embed] });
  essaySessions.set(thread.id, { type: 'com', userId: interaction.user.id, problematique: data.problematique, texte: data.extrait, titre: data.titre, messages: [] });
  registerSession(interaction.user.id, 'com', thread.id);
  await interaction.editReply(`✅ Thread créé : ${thread}`);
}

// ─── /plan ────────────────────────────────────────────────────────────────────
async function handlePlan(interaction) {
  await interaction.reply({ content: '📋 **Plan** — Choisis une œuvre :', components: [getSelectOeuvres(`plan_oeuvre_${interaction.user.id}`)], ephemeral: true });
}
async function lancerPlan(interaction, oeuvreKey) {
  await interaction.deferUpdate();
  const oeuvre = OEUVRES[oeuvreKey];
  const sujet = await callGemini(promptSujet(oeuvre.nom));
  const thread = await interaction.channel.threads.create({ name: `📋 Plan — ${interaction.user.username}`, autoArchiveDuration: 1440 });
  const embed = new EmbedBuilder().setColor(0x1ABC9C).setTitle('📋 Plan de Dissertation — Bac 2026')
    .setDescription(`**Œuvre :** ${oeuvre.nom}\n\n**Sujet :**\n*${sujet.trim()}*`)
    .addFields({ name: 'Consigne', value: 'Rédige UNIQUEMENT le plan (I/II/III avec A/B). Tape `/end` pour la correction.' });
  await thread.send({ embeds: [embed] });
  essaySessions.set(thread.id, { type: 'plan', userId: interaction.user.id, sujet: sujet.trim(), oeuvre: oeuvre.nom, messages: [] });
  registerSession(interaction.user.id, 'plan', thread.id);
  await interaction.channel.send(`✅ <@${interaction.user.id}> — Ton sujet t'attend : ${thread}`);
}

// ─── /fiche ───────────────────────────────────────────────────────────────────
async function handleFiche(interaction) {
  await interaction.reply({ content: '📄 **Fiche** — Choisis une œuvre :', components: [getSelectOeuvres(`fiche_oeuvre_${interaction.user.id}`)], ephemeral: true });
}
async function lancerFiche(interaction, oeuvreKey) {
  await interaction.deferUpdate();
  const oeuvre = OEUVRES[oeuvreKey];
  const contenu = await lireContenuCategorie(interaction.guild, oeuvreKey);
  const fiche = await callGemini(`Génère une fiche de révision claire et simple sur "${oeuvre.nom}".
Inspire-toi de commentairecompose.fr (${oeuvre.url}).
Basé sur :\n${contenu}
Structure : contexte et auteur, résumé court, personnages ou voix principaux, thèmes importants, axes d'étude pour le Bac, 5 citations essentielles avec explication courte, 5 points à retenir absolument.
Langage simple et accessible pour un lycéen de Terminale.`);
  const embed = new EmbedBuilder().setColor(0xF39C12).setTitle(`📄 Fiche — ${oeuvre.nom}`).setDescription(fiche.substring(0, 4096)).setFooter({ text: 'Bac de Français 2026 • commentairecompose.fr' });
  await interaction.channel.send({ embeds: [embed] });
  if (fiche.length > 4096) for (const chunk of fiche.substring(4096).match(/.{1,2000}/gs) || []) await interaction.channel.send(chunk);
}

// ─── /citation ────────────────────────────────────────────────────────────────
async function handleCitation(interaction) {
  await interaction.reply({ content: '💬 **Citation** — Choisis une œuvre :', components: [getSelectOeuvres(`citation_oeuvre_${interaction.user.id}`)], ephemeral: true });
}
async function lancerCitation(interaction, oeuvreKey) {
  await interaction.deferUpdate();
  const oeuvre = OEUVRES[oeuvreKey];
  const contenu = await lireContenuCategorie(interaction.guild, oeuvreKey);
  let data;
  try {
    data = JSON.parse((await callGemini(`Choisis une citation importante de "${oeuvre.nom}" souvent analysée sur commentairecompose.fr.
Basé sur :\n${contenu}
JSON uniquement : {"citation":"...","source":"...","piste":"une piste d'analyse simple en une phrase"}`)).replace(/```json|```/g, '').trim());
  } catch { return interaction.channel.send('❌ Erreur. Réessaie.'); }
  const thread = await interaction.channel.threads.create({ name: `💬 Citation — ${interaction.user.username}`, autoArchiveDuration: 1440 });
  const embed = new EmbedBuilder().setColor(0xE91E63).setTitle('💬 Analyse de Citation — Bac 2026')
    .setDescription(`**Œuvre :** ${oeuvre.nom}\n\n> *${data.citation}*\n\n**Source :** ${data.source}`)
    .addFields({ name: 'Piste d\'analyse', value: data.piste }, { name: 'Consigne', value: 'Analyse cette citation en 3 phrases max. Tape `/end` pour la correction.' });
  await thread.send({ embeds: [embed] });
  essaySessions.set(thread.id, { type: 'citation', userId: interaction.user.id, citation: data.citation, source: data.source, oeuvre: oeuvre.nom, messages: [] });
  registerSession(interaction.user.id, 'citation', thread.id);
  await interaction.channel.send(`✅ <@${interaction.user.id}> — Ta citation t'attend : ${thread}`);
}

// ─── /end ─────────────────────────────────────────────────────────────────────
async function handleEnd(interaction) {
  const session = essaySessions.get(interaction.channelId) || coursSessions.get(interaction.channelId);
  if (!session) return interaction.reply({ content: '❌ Aucune session active ici.', ephemeral: true });
  if (session.userId !== interaction.user.id) return interaction.reply({ content: '❌ Pas ton exercice.', ephemeral: true });
  await interaction.deferReply();
  const texte = session.messages.join('\n\n');
  if (!texte.trim()) return interaction.editReply('❌ Tu n\'as rien écrit.');

  let contexte;
  if (session.type === 'essay') contexte = `Œuvre : ${session.oeuvre}. Problématique : "${session.problematique}". Type : dissertation.`;
  else if (session.type === 'com') contexte = `Texte : ${session.titre}. Problématique : "${session.problematique}". Extrait : """${session.texte.substring(0, 500)}...""". Type : commentaire de texte.`;
  else if (session.type === 'plan') contexte = `Œuvre : ${session.oeuvre}. Sujet : "${session.sujet}". Type : plan de dissertation.`;
  else if (session.type === 'citation') contexte = `Œuvre : ${session.oeuvre}. Citation : "${session.citation}" (${session.source}). Type : analyse de citation en 3 phrases.`;
  else if (session.type === 'cours') contexte = `Œuvre : ${session.oeuvre}. Question : "${session.question}". Type : question de cours ouverte.`;

  const correction = await callGemini(promptCorrection(session.type, contexte, texte));
  const noteMatch = correction.match(/NOTE_GLOBALE:\s*(\d+(?:\.\d+)?)\/20/);
  const note = noteMatch ? parseFloat(noteMatch[1]) : null;
  const xpMsg = await calculerXPRedaction(interaction.guild, interaction.user.id, note, session.type);
  const display = correction.replace(/NOTE_GLOBALE:.*$/m, '').trim();

  const titres = { essay: '✅ Correction Dissertation', com: '✅ Correction Commentaire', plan: '✅ Correction Plan', citation: '✅ Correction Analyse de Citation', cours: '✅ Correction Question de Cours' };
  const embed = new EmbedBuilder().setColor(0x57F287).setTitle(titres[session.type] || '✅ Correction').setDescription(display.substring(0, 4096)).setFooter({ text: 'Continue ! 💪' });
  await interaction.editReply({ embeds: [embed] });
  if (display.length > 4096) for (const chunk of display.substring(4096).match(/.{1,2000}/gs) || []) await interaction.channel.send(chunk);
  if (xpMsg) await interaction.channel.send(xpMsg);

  unregisterSession(interaction.user.id, interaction.channelId);
  essaySessions.delete(interaction.channelId);
  coursSessions.delete(interaction.channelId);
}

// ─── /revision ────────────────────────────────────────────────────────────────
async function handleRevision(interaction) {
  await interaction.reply({ content: '📚 **Révision complète (6 étapes)** — Choisis une œuvre :', components: [getSelectOeuvres(`revision_oeuvre_${interaction.user.id}`)], ephemeral: true });
}

async function lancerRevision(interaction, oeuvreKey) {
  await interaction.deferUpdate();
  const oeuvre = OEUVRES[oeuvreKey];
  const thread = await interaction.channel.threads.create({ name: `📚 Révision — ${oeuvre.nom.split('—')[0].trim()} — ${interaction.user.username}`, autoArchiveDuration: 1440 });
  const session = { userId: interaction.user.id, oeuvreKey, oeuvre: oeuvre.nom, etape: 1, qcmPhase: 1, citationIndex: 0, citations: [], messages: [], awaitingResponse: false };
  revisionSessions.set(thread.id, session);
  registerSession(interaction.user.id, 'revision', thread.id);
  await interaction.channel.send(`✅ <@${interaction.user.id}> — Ta révision complète commence ici : ${thread}`);

  const contenu = await lireContenuCategorie(interaction.guild, oeuvreKey);
  const fiche = await callGemini(`Génère une fiche de révision claire et accessible sur "${oeuvre.nom}".
Inspire-toi de commentairecompose.fr (${oeuvre.url}).
Basé sur :\n${contenu}
Structure : contexte et auteur, résumé, personnages ou voix, thèmes, axes Bac, 5 citations avec explication, 5 points clés.
Langage simple pour un lycéen.`);

  const embed = new EmbedBuilder().setColor(0xF39C12).setTitle('📄 Étape 1/6 — Fiche de Révision')
    .setDescription(fiche.substring(0, 4096)).setFooter({ text: `${oeuvre.nom} • QCM dans 10 minutes` });
  const msg = await thread.send({ embeds: [embed] });
  if (fiche.length > 4096) for (const chunk of fiche.substring(4096).match(/.{1,2000}/gs) || []) await thread.send(chunk);
  await thread.send('⏳ **10 minutes** pour lire la fiche. Le QCM démarrera automatiquement.');

  setTimeout(async () => {
    try { await msg.delete().catch(() => {}); session.etape = 2; await revQCM(thread, session, interaction.guild); }
    catch (e) { console.error('Err étape1:', e); }
  }, 10 * 60 * 1000);
}

async function revQCM(thread, session, guild) {
  const diffs = { 1: 'facile', 2: 'moyenne', 3: 'difficile' };
  const seuils = { 1: 7, 2: 8, 3: 8 };
  const labels = { 1: '2a/6', 2: '2b/6', 3: '2c/6' };
  const diff = diffs[session.qcmPhase];
  const seuil = seuils[session.qcmPhase];
  const contenu = await lireContenuCategorie(guild, session.oeuvreKey);
  let data;
  try {
    data = JSON.parse((await callGemini(`Génère 10 questions QCM de difficulté ${diff} sur "${session.oeuvre}".
Basé sur :\n${contenu}
Questions accessibles niveau Terminale, portant sur des points importants pour le Bac.
JSON uniquement : {"questions":[{"question":"...","options":["A","B","C","D"],"reponse":0,"explication":"..."}]}`)).replace(/```json|```/g, '').trim());
  } catch { return thread.send('❌ Erreur QCM. Réessaie dans un instant.'); }

  session.qcmSession = { questions: data.questions, current: 0, score: 0, seuil, phase: session.qcmPhase };
  const embed = new EmbedBuilder().setColor(0x3498DB)
    .setTitle(`📖 Étape ${labels[session.qcmPhase]} — QCM ${diff.charAt(0).toUpperCase() + diff.slice(1)}`)
    .setDescription(`10 questions — Score requis : **${seuil}/10**`).setFooter({ text: session.oeuvre });
  await thread.send({ embeds: [embed] });
  await revEnvoyerQuestion(thread, session);
}

async function revEnvoyerQuestion(thread, session) {
  const q = session.qcmSession.questions[session.qcmSession.current];
  const embed = new EmbedBuilder().setColor(0x2B2D31)
    .setTitle(`📖 Question ${session.qcmSession.current + 1}/10`)
    .setDescription(`**${q.question}**\n\n🅐 ${q.options[0]}\n🅑 ${q.options[1]}\n🅒 ${q.options[2]}\n🅓 ${q.options[3]}`)
    .setFooter({ text: session.oeuvre });
  const row = new ActionRowBuilder().addComponents(
    ['A', 'B', 'C', 'D'].map((l, i) => new ButtonBuilder().setCustomId(`rev_qcm_${thread.id}_${i}`).setLabel(l).setStyle(ButtonStyle.Secondary))
  );
  await new Promise(r => setTimeout(r, 500));
  await thread.send({ embeds: [embed], components: [row] });
}

async function revCours(thread, session, guild) {
  const contenu = await lireContenuCategorie(guild, session.oeuvreKey);
  const types = ['le contexte historique', 'la structure de l\'œuvre', 'le personnage principal', 'le thème central', 'un procédé stylistique important'];
  const t = types[Math.floor(Math.random() * types.length)];
  const question = await callGemini(`Pose une question de cours simple et claire sur "${session.oeuvre}" portant sur : ${t}.
La réponse attendue est un court paragraphe (~demi-page A4). Question accessible à un lycéen.
Basé sur :\n${contenu}\nUNIQUEMENT la question.`);
  session.coursQuestion = question.trim();
  session.messages = [];
  session.awaitingResponse = true;
  const embed = new EmbedBuilder().setColor(0x9B59B6).setTitle('🎓 Étape 3/6 — Question de Cours')
    .setDescription(`**Question :**\n*${question.trim()}*`)
    .addFields({ name: 'Consigne', value: 'Réponds en un paragraphe développé (~demi-page A4).\nTape `/valider` quand tu as terminé.' })
    .setFooter({ text: `Score requis : 8/10 • ${session.oeuvre}` });
  await thread.send({ embeds: [embed] });
}

async function revCitation(thread, session, guild) {
  if (!session.citations.length) {
    const contenu = await lireContenuCategorie(guild, session.oeuvreKey);
    try {
      session.citations = JSON.parse((await callGemini(`Génère 5 citations importantes de "${session.oeuvre}" souvent analysées sur commentairecompose.fr.
Basé sur :\n${contenu}\nJSON uniquement : {"citations":[{"citation":"...","source":"...","piste":"piste d'analyse simple"}]}`)).replace(/```json|```/g, '').trim()).citations;
    } catch { return thread.send('❌ Erreur citations.'); }
  }
  const cit = session.citations[session.citationIndex];
  session.messages = [];
  session.awaitingResponse = true;
  const embed = new EmbedBuilder().setColor(0xE91E63).setTitle(`💬 Étape 4/6 — Citation ${session.citationIndex + 1}/5`)
    .setDescription(`> *${cit.citation}*\n\n**Source :** ${cit.source}`)
    .addFields({ name: 'Piste', value: cit.piste }, { name: 'Consigne', value: 'Analyse en **3 phrases max**. Tape `/valider` quand tu as terminé.' })
    .setFooter({ text: `Score requis : 8/10 • ${session.oeuvre}` });
  await thread.send({ embeds: [embed] });
}

async function revPlan(thread, session) {
  const sujet = await callGemini(promptSujet(session.oeuvre));
  session.planSujet = sujet.trim();
  session.messages = [];
  session.awaitingResponse = true;
  const embed = new EmbedBuilder().setColor(0x1ABC9C).setTitle('📋 Étape 5/6 — Plan de Dissertation')
    .setDescription(`**Sujet :**\n*${sujet.trim()}*`)
    .addFields({ name: 'Consigne', value: 'Rédige UNIQUEMENT le plan (I/II/III avec A/B). Tape `/valider` quand tu as terminé.' })
    .setFooter({ text: `Score requis : 8/10 • ${session.oeuvre}` });
  await thread.send({ embeds: [embed] });
}

async function revDissertation(thread, session) {
  const prob = await callGemini(promptProblematique(session.oeuvre));
  session.dissertationProb = prob.trim();
  session.messages = [];
  session.awaitingResponse = true;
  const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('📝 Étape 6/6 — Dissertation Finale')
    .setDescription(`**Problématique :**\n*${prob.trim()}*`)
    .addFields({ name: 'Consigne', value: 'Rédige ta dissertation complète (intro, développement, conclusion).\nTape `/valider` quand tu as terminé.' })
    .setFooter({ text: `Score requis : 9/10 • ${session.oeuvre}` });
  await thread.send({ embeds: [embed] });
}

// ─── /valider ─────────────────────────────────────────────────────────────────
async function handleValider(interaction) {
  const session = revisionSessions.get(interaction.channelId);
  if (!session) return interaction.reply({ content: '❌ Aucune session de révision ici.', ephemeral: true });
  if (session.userId !== interaction.user.id) return interaction.reply({ content: '❌ Pas ta session.', ephemeral: true });
  if (!session.awaitingResponse) return interaction.reply({ content: '❌ Rien à valider maintenant.', ephemeral: true });
  if (!session.messages.length) return interaction.reply({ content: '❌ Tu n\'as rien écrit.', ephemeral: true });

  await interaction.deferReply();
  session.awaitingResponse = false;
  const texte = session.messages.join('\n\n');
  session.messages = [];

  let contexte, seuil, titre;
  if (session.etape === 3) {
    seuil = 8; titre = 'Question de Cours';
    contexte = `Question : "${session.coursQuestion}". Œuvre : ${session.oeuvre}. Donne la réponse idéale attendue puis évalue l'élève. Note sur 10.`;
  } else if (session.etape === 4) {
    seuil = 8; titre = `Citation ${session.citationIndex + 1}/5`;
    const cit = session.citations[session.citationIndex];
    contexte = `Citation : "${cit.citation}" (${cit.source}). Œuvre : ${session.oeuvre}. Donne l'analyse idéale puis évalue. Note sur 10.`;
  } else if (session.etape === 5) {
    seuil = 8; titre = 'Plan de Dissertation';
    contexte = `Sujet : "${session.planSujet}". Œuvre : ${session.oeuvre}. Évalue le plan. Note sur 10.`;
  } else if (session.etape === 6) {
    seuil = 9; titre = 'Dissertation Finale';
    contexte = `Problématique : "${session.dissertationProb}". Œuvre : ${session.oeuvre}. Évalue la dissertation complète. Note sur 10.`;
  }

  const promptCorr = `${contexte}

Travail de l'élève :
"""${texte}"""

Corrige de façon bienveillante et pédagogique. Explique ce qui est bien et ce qui peut être amélioré.
NOTE_GLOBALE: X/10 seul sur une ligne à la fin.`;

  const correction = await callGemini(promptCorr);
  const noteMatch = correction.match(/NOTE_GLOBALE:\s*(\d+(?:\.\d+)?)\/10/);
  const note = noteMatch ? parseFloat(noteMatch[1]) : 0;
  const display = correction.replace(/NOTE_GLOBALE:.*$/m, '').trim();
  const passed = note >= seuil;

  const embed = new EmbedBuilder()
    .setColor(passed ? 0x57F287 : 0xED4245)
    .setTitle(`${passed ? '✅' : '❌'} Correction — ${titre}`)
    .setDescription(display.substring(0, 4096))
    .addFields({ name: 'Note', value: `**${note}/10** — Seuil : ${seuil}/10` })
    .setFooter({ text: passed ? '✅ Étape validée !' : '❌ Réessaie pour passer à la suite.' });
  await interaction.editReply({ embeds: [embed] });

  if (!passed) {
    await new Promise(r => setTimeout(r, 1000));
    session.awaitingResponse = true;
    session.messages = [];
    if (session.etape === 3) await interaction.channel.send(`🔄 Score insuffisant (${note}/10). Réponds à nouveau :\n\n*${session.coursQuestion}*\n\nTape \`/valider\` quand tu as terminé.`);
    else if (session.etape === 4) { const cit = session.citations[session.citationIndex]; await interaction.channel.send(`🔄 Score insuffisant (${note}/10). Réanalyse en 3 phrases :\n\n> *${cit.citation}*\n\nTape \`/valider\`.`); }
    else if (session.etape === 5) await interaction.channel.send(`🔄 Score insuffisant (${note}/10). Refais le plan :\n\n*${session.planSujet}*\n\nTape \`/valider\`.`);
    else if (session.etape === 6) await interaction.channel.send(`🔄 Score insuffisant (${note}/10). Corrige ta dissertation et renvoie-la. Tape \`/valider\`.`);
    return;
  }

  await new Promise(r => setTimeout(r, 1000));
  if (session.etape === 3) {
    session.etape = 4;
    await interaction.channel.send('🎉 Étape 3 validée ! Passage aux citations...');
    await revCitation(interaction.channel, session, interaction.guild);
  } else if (session.etape === 4) {
    session.citationIndex++;
    if (session.citationIndex < 5) {
      await interaction.channel.send(`✅ Citation ${session.citationIndex}/5 validée !`);
      await revCitation(interaction.channel, session, interaction.guild);
    } else {
      session.etape = 5;
      await interaction.channel.send('🎉 Toutes les citations validées ! Passage au plan...');
      await revPlan(interaction.channel, session);
    }
  } else if (session.etape === 5) {
    session.etape = 6;
    await interaction.channel.send('🎉 Plan validé ! Passage à la dissertation finale...');
    await revDissertation(interaction.channel, session);
  } else if (session.etape === 6) {
    const xpMsg = await giveXP(interaction.guild, session.userId, 1000);
    const embed2 = new EmbedBuilder().setColor(0xFFD700).setTitle('🏆 Révision Complète — Félicitations !')
      .setDescription(`Tu as maîtrisé **${session.oeuvre}** de bout en bout !\n\n🎁 **+1000 XP bonus** !\n${xpMsg}`)
      .setFooter({ text: 'Tu es prêt(e) pour le Bac ! 💪' });
    await interaction.channel.send({ embeds: [embed2] });
    unregisterSession(session.userId, interaction.channelId);
    revisionSessions.delete(interaction.channelId);
  }
}

// ─── /cancel ──────────────────────────────────────────────────────────────────
async function handleCancel(interaction) {
  const userId = interaction.user.id;
  const sessions = userActiveSessions.get(userId) || [];
  const hadQcm = qcmSessions.has(userId);
  qcmSessions.delete(userId);
  let count = sessions.length + (hadQcm ? 1 : 0);
  for (const s of sessions) {
    essaySessions.delete(s.threadId);
    coursSessions.delete(s.threadId);
    revisionSessions.delete(s.threadId);
  }
  userActiveSessions.delete(userId);
  if (count === 0) return interaction.reply({ content: '❌ Tu n\'as aucune session active en ce moment.', ephemeral: true });
  await interaction.reply({ content: `✅ **${count} session(s) annulée(s).** Tu peux relancer n'importe quelle commande.`, ephemeral: true });
}

// ─── /close ───────────────────────────────────────────────────────────────────
async function handleClose(interaction) {
  if (!interaction.channel.isThread()) return interaction.reply({ content: '❌ Thread uniquement.', ephemeral: true });
  await interaction.reply('🔒 Fermeture dans 3 secondes...');
  setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
}

// ─── /xp ──────────────────────────────────────────────────────────────────────
async function handleXp(interaction) {
  const u = getUser(interaction.user.id);
  const xpInLevel = u.xp % 500;
  const bar = '█'.repeat(Math.floor(xpInLevel / 50)) + '░'.repeat(10 - Math.floor(xpInLevel / 50));
  const embed = new EmbedBuilder().setColor(ROLES[u.level - 1].color).setTitle(`🎓 ${interaction.user.username}`)
    .addFields(
      { name: 'Niveau', value: `**${u.level}** — ${ROLES[u.level - 1].name}`, inline: true },
      { name: 'XP Total', value: `**${u.xp} XP**`, inline: true },
      { name: 'Prochain niveau', value: ROLES[u.level] ? ROLES[u.level].name : '👑 MAX', inline: true },
      { name: 'Progression', value: `${bar} ${xpInLevel}/500` }
    );
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ─── /stats ───────────────────────────────────────────────────────────────────
async function handleStats(interaction) {
  const u = getUser(interaction.user.id);
  const taux = u.totalQuestions > 0 ? Math.round((u.correctAnswers / u.totalQuestions) * 100) : 0;
  const embed = new EmbedBuilder().setColor(ROLES[u.level - 1].color).setTitle(`📊 Stats — ${interaction.user.username}`)
    .addFields(
      { name: '🎯 QCM', value: `${u.correctAnswers}/${u.totalQuestions} (${taux}%)`, inline: true },
      { name: '📝 Dissertations', value: `${u.dissertations || 0}`, inline: true },
      { name: '📄 Commentaires', value: `${u.commentaires || 0}`, inline: true },
      { name: '⭐ XP', value: `**${u.xp} XP**`, inline: true },
      { name: '🏅 Niveau', value: `**${u.level}** — ${ROLES[u.level - 1].name}`, inline: true }
    );
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ─── /classement ──────────────────────────────────────────────────────────────
async function handleClassement(interaction) {
  const top = db.prepare('SELECT * FROM users ORDER BY xp DESC LIMIT 10').all();
  if (!top.length) return interaction.reply({ content: '❌ Aucun utilisateur.', ephemeral: true });
  let desc = '';
  const medals = ['🥇', '🥈', '🥉'];
  for (let i = 0; i < top.length; i++) {
    let member; try { member = await interaction.guild.members.fetch(top[i].userId); } catch { continue; }
    desc += `${medals[i] || `**${i + 1}.**`} ${member.displayName} — **${top[i].xp} XP** — Niv. ${top[i].level} (${ROLES[top[i].level - 1].name})\n`;
  }
  const embed = new EmbedBuilder().setColor(0xFFD700).setTitle('🏆 Classement — Bac de Français 2026').setDescription(desc).setFooter({ text: 'Continue à réviser !' });
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
      if (interaction.commandName === 'cours')       return await handleCours(interaction);
      if (interaction.commandName === 'essay')       return await handleEssay(interaction);
      if (interaction.commandName === 'com')         return await handleCom(interaction);
      if (interaction.commandName === 'plan')        return await handlePlan(interaction);
      if (interaction.commandName === 'fiche')       return await handleFiche(interaction);
      if (interaction.commandName === 'citation')    return await handleCitation(interaction);
      if (interaction.commandName === 'revision')    return await handleRevision(interaction);
      if (interaction.commandName === 'valider')     return await handleValider(interaction);
      if (interaction.commandName === 'end')         return await handleEnd(interaction);
      if (interaction.commandName === 'cancel')      return await handleCancel(interaction);
      if (interaction.commandName === 'close')       return await handleClose(interaction);
      if (interaction.commandName === 'xp')          return await handleXp(interaction);
      if (interaction.commandName === 'stats')       return await handleStats(interaction);
      if (interaction.commandName === 'classement')  return await handleClassement(interaction);
    }

    if (interaction.isStringSelectMenu()) {
      const parts = interaction.customId.split('_');
      const cmd = parts[0];
      const userId = parts[parts.length - 1];
      if (interaction.user.id !== userId) return;
      if (cmd === 'qcm')      { const s = qcmSessions.get(userId); if (s) await lancerQcm(interaction, interaction.values[0], s.nbQuestions); }
      else if (cmd === 'cours')    await lancerCours(interaction, interaction.values[0]);
      else if (cmd === 'plan')     await lancerPlan(interaction, interaction.values[0]);
      else if (cmd === 'fiche')    await lancerFiche(interaction, interaction.values[0]);
      else if (cmd === 'citation') await lancerCitation(interaction, interaction.values[0]);
      else if (cmd === 'revision') await lancerRevision(interaction, interaction.values[0]);
    }

    if (interaction.isButton() && interaction.customId.startsWith('qcm_rep_')) {
      const parts = interaction.customId.split('_');
      const userId = parts[2];
      const repIndex = parseInt(parts[3]);
      if (interaction.user.id !== userId) return interaction.reply({ content: '❌ Pas ton QCM.', ephemeral: true });
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
      const corrEmbed = new EmbedBuilder().setColor(correct ? 0x57F287 : 0xED4245)
        .setTitle(correct ? '✅ Bonne réponse ! +10 XP' : '❌ Mauvaise réponse — 5 XP')
        .setDescription(`**Bonne réponse : ${['A', 'B', 'C', 'D'][q.reponse]} — ${q.options[q.reponse]}**\n\n💡 ${q.explication}`);
      await interaction.channel.send({ embeds: [corrEmbed] });
      if (xpResult.newLevel > xpResult.oldLevel) {
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        if (member) { await updateRoles(interaction.guild, member, xpResult.newLevel); await interaction.channel.send(`🎉 <@${userId}> passe au **niveau ${xpResult.newLevel}** — **${ROLES[xpResult.newLevel - 1].name}** !`); }
      }
      session.current++;
      if (session.current >= session.questions.length) {
        const u = getUser(userId);
        const scoreEmbed = new EmbedBuilder().setColor(0x5865F2).setTitle('🎓 QCM terminé !')
          .setDescription(`**Score : ${session.score}/${session.questions.length}**\n\nXP ce QCM : **${session.xpGained >= 0 ? '+' : ''}${session.xpGained} XP**\nXP total : **${u.xp} XP** — Niv. **${u.level}**`)
          .setFooter({ text: session.oeuvre });
        await interaction.channel.send({ embeds: [scoreEmbed] });
        qcmSessions.delete(userId);
      } else {
        await envoyerQuestion(interaction.channel, session, userId);
      }
    }

    if (interaction.isButton() && interaction.customId.startsWith('rev_qcm_')) {
      const parts = interaction.customId.split('_');
      const threadId = parts[2];
      const repIndex = parseInt(parts[3]);
      const session = revisionSessions.get(threadId);
      if (!session || session.userId !== interaction.user.id) return interaction.reply({ content: '❌ Pas ton QCM.', ephemeral: true });
      await interaction.deferUpdate();
      const q = session.qcmSession.questions[session.qcmSession.current];
      const correct = repIndex === q.reponse;
      if (correct) session.qcmSession.score++;
      updateStats(session.userId, correct);
      const corrEmbed = new EmbedBuilder().setColor(correct ? 0x57F287 : 0xED4245)
        .setTitle(correct ? '✅ Bonne réponse !' : '❌ Mauvaise réponse')
        .setDescription(`**Bonne réponse : ${['A', 'B', 'C', 'D'][q.reponse]} — ${q.options[q.reponse]}**\n\n💡 ${q.explication}`);
      await interaction.channel.send({ embeds: [corrEmbed] });
      session.qcmSession.current++;
      if (session.qcmSession.current >= 10) {
        const score = session.qcmSession.score;
        const seuil = session.qcmSession.seuil;
        const passed = score >= seuil;
        const resultEmbed = new EmbedBuilder().setColor(passed ? 0x57F287 : 0xED4245)
          .setTitle(`${passed ? '✅' : '❌'} QCM terminé — ${score}/10`)
          .setDescription(passed ? `Score suffisant ! Passage à l'étape suivante...` : `Score insuffisant (${score}/${seuil}). Nouveau QCM en cours...`)
          .setFooter({ text: session.oeuvre });
        await interaction.channel.send({ embeds: [resultEmbed] });
        await new Promise(r => setTimeout(r, 1500));
        if (!passed) {
          await revQCM(interaction.channel, session, interaction.guild);
        } else if (session.qcmPhase < 3) {
          session.qcmPhase++;
          await revQCM(interaction.channel, session, interaction.guild);
        } else {
          session.etape = 3;
          await interaction.channel.send('🎉 Tous les QCM validés ! Passage à la question de cours...');
          await revCours(interaction.channel, session, interaction.guild);
        }
      } else {
        await revEnvoyerQuestion(interaction.channel, session);
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
  const threadId = message.channel.id;
  const revSession = revisionSessions.get(threadId);
  if (revSession && revSession.userId === message.author.id && !message.content.startsWith('/')) {
    if (revSession.awaitingResponse) revSession.messages.push(message.content);
    return;
  }
  const session = essaySessions.get(threadId) || coursSessions.get(threadId);
  if (!session || session.userId !== message.author.id || message.content.startsWith('/')) return;
  session.messages.push(message.content);
});

client.login(DISCORD_TOKEN);
