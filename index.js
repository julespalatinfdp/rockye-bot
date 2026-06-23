const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  ButtonBuilder, ButtonStyle, ActionRowBuilder,
  PermissionFlagsBits, SlashCommandBuilder, REST, Routes,
  ChannelType, StringSelectMenuBuilder, StringSelectMenuOptionBuilder
} = require('discord.js');

// ─────────────────────────────────────────
// CONFIG — modifie ici ou via variables d'env
// ─────────────────────────────────────────
const GUILD_ID        = process.env.GUILD_ID        || '1019184268070633503';
const MODO_ROLE_ID    = process.env.MODO_ROLE_ID    || '1019237918969176195';
const CATEGORY_ID     = process.env.CATEGORY_ID     || '1519011358757224651';
const ROLE_NAME       = process.env.ROLE_NAME       || 'RocKyy Event';
const POINTS_WIN      = 3;
const POINTS_LOSS     = 1;
const AUTO_DELETE_MS  = 15000; // 15s après validation avant suppression du canal

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ─────────────────────────────────────────
// STATE EN MÉMOIRE
// ─────────────────────────────────────────
// scores[userId] = { points, wins, losses }
const scores = {};
// matchChannels[channelId] = { player1Id, player2Id, resultProposed: { winnerId, proposedBy } | null }
const matchChannels = {};
// queue : liste des userIds en attente de match
const queue = [];

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
function initScore(userId) {
  if (!scores[userId]) scores[userId] = { points: 0, wins: 0, losses: 0 };
}

function getOrCreateRole(guild) {
  return guild.roles.cache.find(r => r.name === ROLE_NAME)
    || guild.roles.create({ name: ROLE_NAME, reason: 'RocKyy Event - création automatique' });
}

function buildInscriptionEmbed() {
  return new EmbedBuilder()
    .setTitle('🎮 RocKyy Event - Inscription')
    .setDescription(
      "Clique sur le bouton ci-dessous pour t'inscrire à l'événement.\n\n" +
      "Tu recevras le rôle **RocKyy Event** et accèderas au salon https://discord.com/channels/1019184268070633503/1519014283961307317"
    )
    .setColor('#7289DA');
}

function buildMatchmakingEmbed() {
  return new EmbedBuilder()
    .setTitle('⚔️ Trouver un match')
    .setDescription(
      "Clique sur le bouton ci-dessous pour lancer une recherche de match.\n\n" +
      "Le bot te mettra en relation avec un autre joueur inscrit et créera un canal privé entre vous."
    )
    .setColor('#e67e22');
}

function buildRulesEmbed(player1, player2) {
  return new EmbedBuilder()
    .setTitle('⚔️ Match trouvé !')
    .setDescription(
      `<@${player1}> vs <@${player2}>\n\n` +
      "**Règles du match :**\n" +
      `🏆 Victoire : **${POINTS_WIN} points**\n` +
      `📉 Défaite : **${POINTS_LOSS} point**\n\n` +
      "Jouez votre match puis utilisez les boutons ci-dessous pour enregistrer le résultat."
    )
    .setColor('#e67e22');
}

function buildClassementEmbed(guild) {
  const sorted = Object.entries(scores)
    .sort(([, a], [, b]) => b.points - a.points)
    .slice(0, 20);

  if (sorted.length === 0) {
    return new EmbedBuilder()
      .setTitle('🏆 Classement RocKyy Event')
      .setDescription('Aucun match joué pour le moment.')
      .setColor('#f1c40f');
  }

  const medals = ['🥇', '🥈', '🥉'];
  const lines = sorted.map(([userId, data], i) => {
    const prefix = medals[i] || `**${i + 1}.**`;
    return `${prefix} <@${userId}> - **${data.points} pts** (${data.wins}V / ${data.losses}D)`;
  });

  return new EmbedBuilder()
    .setTitle('🏆 Classement RocKyy Event')
    .setDescription(lines.join('\n'))
    .setColor('#f1c40f');
}

// ─────────────────────────────────────────
// CRÉER UN CANAL DE MATCH
// ─────────────────────────────────────────
async function createMatchChannel(guild, player1Id, player2Id) {
  const channel = await guild.channels.create({
    name: `match-${guild.members.cache.get(player1Id)?.user.username || player1Id}`,
    type: ChannelType.GuildText,
    parent: CATEGORY_ID,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: player1Id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      { id: player2Id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      { id: MODO_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    ],
  });

  matchChannels[channel.id] = { player1Id, player2Id, resultProposed: null };

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`valider_vainqueur:${channel.id}`)
      .setLabel('✅ Valider un vainqueur')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`afk:${channel.id}`)
      .setLabel('⏰ Adversaire AFK')
      .setStyle(ButtonStyle.Danger),
  );

  await channel.send({
    content: `<@${player1Id}> <@${player2Id}>`,
    embeds: [buildRulesEmbed(player1Id, player2Id)],
    components: [row],
  });

  return channel;
}

// ─────────────────────────────────────────
// INTERACTIONS
// ─────────────────────────────────────────
client.on('interactionCreate', async interaction => {

  // ── SLASH COMMANDS ───────────────────────
  if (interaction.isChatInputCommand()) {

    // /post-inscription
    if (interaction.commandName === 'post-inscription') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '❌ Réservé aux admins.', ephemeral: true });
      }
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('inscription')
          .setLabel("🎮 S'inscrire")
          .setStyle(ButtonStyle.Primary),
      );
      await interaction.channel.send({ embeds: [buildInscriptionEmbed()], components: [row] });
      return interaction.reply({ content: '✅ Message d\'inscription posté.', ephemeral: true });
    }

    // /classement
    if (interaction.commandName === 'classement') {
      if (!interaction.member.roles.cache.has(MODO_ROLE_ID) && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '❌ Réservé aux modérateurs.', ephemeral: true });
      }
      await interaction.channel.send({ embeds: [buildClassementEmbed(interaction.guild)] });
      return interaction.reply({ content: '✅ Classement posté.', ephemeral: true });
    }

    // /valider-modo
    if (interaction.commandName === 'valider-modo') {
      if (!interaction.member.roles.cache.has(MODO_ROLE_ID) && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '❌ Réservé aux modérateurs.', ephemeral: true });
      }
      const channelId = interaction.options.getString('canal_id');
      const winnerId  = interaction.options.getString('gagnant_id');
      const match = matchChannels[channelId];
      if (!match) return interaction.reply({ content: '❌ Canal de match introuvable.', ephemeral: true });

      const loserId = match.player1Id === winnerId ? match.player2Id : match.player1Id;
      initScore(winnerId); initScore(loserId);
      scores[winnerId].points += POINTS_WIN; scores[winnerId].wins++;
      scores[loserId].points  += POINTS_LOSS; scores[loserId].losses++;

      const ch = interaction.guild.channels.cache.get(channelId);
      if (ch) {
        await ch.send({
          embeds: [new EmbedBuilder()
            .setTitle('✅ Résultat validé par un modérateur')
            .setDescription(`<@${winnerId}> remporte le match !\n+${POINTS_WIN} pts | <@${loserId}> +${POINTS_LOSS} pt`)
            .setColor('#2ecc71')]
        });
        setTimeout(() => ch.delete().catch(() => {}), AUTO_DELETE_MS);
      }
      delete matchChannels[channelId];
      return interaction.reply({ content: `✅ Résultat enregistré. Canal supprimé dans ${AUTO_DELETE_MS / 1000}s.`, ephemeral: true });
    }

    // /post-chercher-match
    if (interaction.commandName === 'post-chercher-match') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '❌ Réservé aux admins.', ephemeral: true });
      }
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('chercher_match')
          .setLabel('⚔️ Chercher un match')
          .setStyle(ButtonStyle.Danger),
      );
      await interaction.channel.send({ embeds: [buildMatchmakingEmbed()], components: [row] });
      return interaction.reply({ content: '✅ Message de recherche de match posté.', ephemeral: true });
    }
  }

  // ── BOUTONS ──────────────────────────────
  if (interaction.isButton()) {
    const [action, channelId] = interaction.customId.split(':');

    // Bouton chercher un match
    if (action === 'chercher_match') {
      const userId = interaction.user.id;
      const guild  = interaction.guild;
      const member = interaction.member;
      const role   = guild.roles.cache.find(r => r.name === ROLE_NAME);

      if (!role || !member.roles.cache.has(role.id)) {
        return interaction.reply({ content: `❌ Tu dois d'abord t'inscrire avec le rôle **${ROLE_NAME}**.`, ephemeral: true });
      }
      if (queue.includes(userId)) {
        return interaction.reply({ content: '⏳ Tu es déjà dans la file d\'attente.', ephemeral: true });
      }
      const alreadyInMatch = Object.values(matchChannels).some(m => m.player1Id === userId || m.player2Id === userId);
      if (alreadyInMatch) {
        return interaction.reply({ content: '❌ Tu as déjà un match en cours.', ephemeral: true });
      }

      if (queue.length === 0 || queue.findIndex(id => id !== userId) === -1) {
        queue.push(userId);
        return interaction.reply({ content: '⏳ Tu es dans la file d\'attente. Un adversaire va être trouvé dès qu\'un joueur se connecte...', ephemeral: true });
      }

      const opponentIdx = queue.findIndex(id => id !== userId);
      const opponentId = queue.splice(opponentIdx, 1)[0];
      await interaction.reply({ content: '✅ Adversaire trouvé ! Ton canal de match a été créé.', ephemeral: true });
      await createMatchChannel(guild, userId, opponentId);
    }

    // Bouton inscription
    if (action === 'inscription') {
      const guild  = interaction.guild;
      const member = interaction.member;
      let role = guild.roles.cache.find(r => r.name === ROLE_NAME);
      if (!role) role = await guild.roles.create({ name: ROLE_NAME, reason: 'RocKyy Event' });

      if (member.roles.cache.has(role.id)) {
        return interaction.reply({ content: '✅ Tu es déjà inscrit !', ephemeral: true });
      }
      await member.roles.add(role);
      initScore(member.id);
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle('🎉 Inscription validée !')
          .setDescription(`Tu as reçu le rôle **${ROLE_NAME}** et accès au salon https://discord.com/channels/1019184268070633503/1519014283961307317`)
          .setColor('#2ecc71')],
        ephemeral: true,
      });
    }

    // Bouton valider vainqueur
    if (action === 'valider_vainqueur') {
      const match = matchChannels[channelId];
      if (!match) return interaction.reply({ content: '❌ Match introuvable.', ephemeral: true });
      const { player1Id, player2Id } = match;

      if (interaction.user.id !== player1Id && interaction.user.id !== player2Id) {
        return interaction.reply({ content: '❌ Tu ne fais pas partie de ce match.', ephemeral: true });
      }

      // Si un résultat est déjà proposé
      if (match.resultProposed) {
        const { winnerId, proposedBy } = match.resultProposed;
        if (proposedBy === interaction.user.id) {
          return interaction.reply({ content: '⏳ Tu as déjà proposé un résultat. En attente de validation adverse.', ephemeral: true });
        }
        // L'autre joueur confirme
        if (interaction.user.id !== proposedBy) {
          const loserId = player1Id === winnerId ? player2Id : player1Id;
          initScore(winnerId); initScore(loserId);
          scores[winnerId].points += POINTS_WIN; scores[winnerId].wins++;
          scores[loserId].points  += POINTS_LOSS; scores[loserId].losses++;

          const ch = interaction.guild.channels.cache.get(channelId);
          await interaction.update({ components: [] });
          await interaction.channel.send({
            embeds: [new EmbedBuilder()
              .setTitle('🏆 Résultat confirmé !')
              .setDescription(`<@${winnerId}> remporte le match !\n+${POINTS_WIN} pts | <@${loserId}> +${POINTS_LOSS} pt\n\nCe canal sera supprimé dans ${AUTO_DELETE_MS / 1000} secondes.`)
              .setColor('#2ecc71')]
          });
          delete matchChannels[channelId];
          setTimeout(() => ch?.delete().catch(() => {}), AUTO_DELETE_MS);
          return;
        }
      }

      // Première proposition : sélectionner le gagnant
      const options = [player1Id, player2Id].map(id => {
        const user = interaction.guild.members.cache.get(id)?.user;
        return new StringSelectMenuOptionBuilder()
          .setLabel(user?.username || id)
          .setValue(id);
      });

      const select = new StringSelectMenuBuilder()
        .setCustomId(`select_winner:${channelId}`)
        .setPlaceholder('Choisis le vainqueur')
        .addOptions(options);

      return interaction.reply({
        content: '👇 Qui a gagné ?',
        components: [new ActionRowBuilder().addComponents(select)],
        ephemeral: true,
      });
    }

    // Bouton AFK
    if (action === 'afk') {
      const match = matchChannels[channelId];
      if (!match) return interaction.reply({ content: '❌ Match introuvable.', ephemeral: true });
      if (interaction.user.id !== match.player1Id && interaction.user.id !== match.player2Id) {
        return interaction.reply({ content: '❌ Tu ne fais pas partie de ce match.', ephemeral: true });
      }

      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`afk_confirm:${channelId}`).setLabel('✅ Oui, supprimer').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`afk_cancel`).setLabel('❌ Non, annuler').setStyle(ButtonStyle.Secondary),
      );

      return interaction.reply({
        content: "Ton adversaire est AFK. Il ne répond pas à tes sollicitations depuis plus d'1 heure. Tu souhaites supprimer ce match et en relancer un autre. Est-ce que tu valides cela ?",
        components: [confirmRow],
        ephemeral: true,
      });
    }

    // AFK confirmé
    if (action === 'afk_confirm') {
      const match = matchChannels[channelId];
      if (!match) return interaction.reply({ content: '❌ Match introuvable.', ephemeral: true });

      const ch = interaction.guild.channels.cache.get(channelId);
      await interaction.update({ content: '✅ Match supprimé. Tu peux relancer une recherche dans **#trouve-ton-match**.', components: [] });
      delete matchChannels[channelId];
      setTimeout(() => ch?.delete().catch(() => {}), 3000);
      return;
    }

    // AFK annulé
    if (action === 'afk_cancel') {
      return interaction.update({ content: '↩️ Action annulée.', components: [] });
    }
  }

  // ── SELECT MENU (choix du vainqueur) ─────
  if (interaction.isStringSelectMenu()) {
    const [action, channelId] = interaction.customId.split(':');

    if (action === 'select_winner') {
      const match = matchChannels[channelId];
      if (!match) return interaction.reply({ content: '❌ Match introuvable.', ephemeral: true });

      const winnerId   = interaction.values[0];
      const proposedBy = interaction.user.id;
      const opponentId = match.player1Id === proposedBy ? match.player2Id : match.player1Id;

      match.resultProposed = { winnerId, proposedBy };

      await interaction.update({ content: `✅ Tu as déclaré <@${winnerId}> vainqueur. En attente de confirmation de <@${opponentId}>...`, components: [] });

      const ch = interaction.guild.channels.cache.get(channelId);
      await ch?.send({
        embeds: [new EmbedBuilder()
          .setTitle('⚠️ Résultat en attente de confirmation')
          .setDescription(
            `<@${proposedBy}> a déclaré <@${winnerId}> vainqueur.\n\n` +
            `<@${opponentId}> : clique sur **✅ Valider un vainqueur** pour confirmer.\n\n` +
            `En cas de désaccord, un <@&${MODO_ROLE_ID}> sera appelé automatiquement.`
          )
          .setColor('#e67e22')]
      });

      // Timeout 5 min : si pas confirmé, tag modo
      setTimeout(async () => {
        if (matchChannels[channelId]?.resultProposed) {
          await ch?.send({
            content: `<@&${MODO_ROLE_ID}> ⚠️ Le résultat du match entre <@${match.player1Id}> et <@${match.player2Id}> n'a pas été confirmé. Merci d'intervenir.\n\nCommande : \`/valider-modo canal_id:${channelId} gagnant_id:ID_DU_GAGNANT\``
          });
        }
      }, 5 * 60 * 1000);
    }
  }
});

// ─────────────────────────────────────────
// DÉPLOIEMENT SLASH COMMANDS
// ─────────────────────────────────────────
async function deployCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('post-inscription')
      .setDescription('Poste le message d\'inscription à l\'événement')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName('post-chercher-match')
      .setDescription('Poste le message de recherche de match dans le canal')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName('classement')
      .setDescription('Affiche le classement de l\'événement')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    new SlashCommandBuilder()
      .setName('valider-modo')
      .setDescription('Valide manuellement le résultat d\'un match (modérateurs)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addStringOption(opt =>
        opt.setName('canal_id').setDescription('ID du canal de match').setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName('gagnant_id').setDescription('ID Discord du gagnant').setRequired(true)
      ),
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('🔄 Déploiement des slash commands...');
    await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, GUILD_ID), { body: commands });
    console.log('✅ Slash commands déployées !');
  } catch (err) {
    console.error('❌ Erreur déploiement :', err);
  }
}

client.once('ready', async () => {
  console.log(`🤖 Bot connecté : ${client.user.tag}`);
  await deployCommands();
});

client.login(process.env.DISCORD_TOKEN);
