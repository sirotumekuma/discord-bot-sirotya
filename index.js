import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import cron from 'node-cron';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
} from 'discord.js';
import { generateCertificate } from './lib/certificate.js';
import { checkUrl, formatCheck, isValidHttpUrl, normalizeUrlForCompare } from './lib/urlcheck.js';

// ===================== 設定 =====================
const {
  DISCORD_TOKEN,
  GUILD_ID,
  APPLY_CHANNEL_ID,
  ADMIN_REVIEW_CHANNEL_ID,
  LIST_CHANNEL_ID,
  PARTNER_ROLE_ID,
  BADGE_IMAGE_URL,
  BACKUP_CHANNEL_ID, // 任意（未設定ならDiscordへのバックアップ送信はスキップ）
} = process.env;

for (const [k, v] of Object.entries({
  DISCORD_TOKEN, GUILD_ID, APPLY_CHANNEL_ID, ADMIN_REVIEW_CHANNEL_ID,
  LIST_CHANNEL_ID, PARTNER_ROLE_ID, BADGE_IMAGE_URL,
})) {
  if (!v) {
    console.error(`環境変数 ${k} が設定されていません (.env を確認してください)`);
    process.exit(1);
  }
}
if (!BACKUP_CHANNEL_ID) {
  console.warn('BACKUP_CHANNEL_ID が未設定のため、Discordへの自動バックアップは無効です。');
}

// ===================== データ保存 (JSON) =====================
const DATA_DIR = path.resolve('data');
const DB_FILE = path.join(DATA_DIR, 'licenses.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

let db = { counters: {}, applications: {}, updates: {} };
if (fs.existsSync(DB_FILE)) {
  db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
}

function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}
saveDb();

function issueLicenseNumber() {
  const year = new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo', year: 'numeric' });
  db.counters[year] = (db.counters[year] ?? 0) + 1;
  return `SR-${year}-${String(db.counters[year]).padStart(3, '0')}`;
}

function normalizeLicenseNumber(input) {
  const m = String(input).match(/SR-(\d{4})-(\d{3,})/i);
  return m ? `SR-${m[1]}-${m[2]}` : null;
}

const allApps = () => Object.values(db.applications);
const findByLicenseNumber = (num) => allApps().find((a) => a.licenseNumber === num);
const approvedOf = (userId) =>
  allApps().filter((a) => a.userId === userId && a.status === 'APPROVED');

/** 同じURLが「承認済/審査中」で存在するか（変更申請の場合は自分自身の許諾を除外） */
function findUrlConflict(url, excludeLicense = null) {
  const key = normalizeUrlForCompare(url);
  for (const a of allApps()) {
    if (excludeLicense && a.licenseNumber === excludeLicense) continue;
    if ((a.status === 'PENDING' || a.status === 'APPROVED') &&
        normalizeUrlForCompare(a.siteUrl) === key) return a;
  }
  for (const u of Object.values(db.updates)) {
    if (excludeLicense && u.licenseNumber === excludeLicense) continue;
    if (u.status === 'PENDING' && normalizeUrlForCompare(u.newSiteUrl) === key) return u;
  }
  return null;
}

const fmtDate = (d) =>
  new Date(d).toLocaleDateString('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  });
const fmtDateTime = (d) => new Date(d).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
const stamp = () =>
  new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace(/\D/g, '');

// ===================== バックアップ =====================
let lastBackupAt = null;

async function sendBackup(reason) {
  try {
    saveDb();
    const name = `licenses-${stamp()}.json`;

    // ローカルにも世代保存（直近14個）
    fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, name));
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.json')).sort();
    for (const old of files.slice(0, Math.max(0, files.length - 14))) {
      fs.unlinkSync(path.join(BACKUP_DIR, old));
    }

    lastBackupAt = new Date().toISOString();
    if (!BACKUP_CHANNEL_ID) return;
    const ch = await client.channels.fetch(BACKUP_CHANNEL_ID);
    await ch.send({
      content: `🗄️ データベースバックアップ（${reason}）`,
      files: [new AttachmentBuilder(DB_FILE, { name })],
    });
  } catch (e) {
    console.error('バックアップ失敗:', e);
  }
}

// ===================== HTMLコード =====================
const HTML_TEMPLATE = `<!-- sirotya 公式許諾表記 -->
<div style="display: inline-flex; align-items: center; gap: 10px; padding: 6px 12px; border: 1px solid #2563EB; border-radius: 6px; background: #ffffff; font-family: sans-serif;">
  <img src="{BADGE_IMAGE_URL}" alt="sirotya許諾マーク" style="width: 32px; height: 32px; object-fit: contain;">
  <div style="line-height: 1.3;">
    <div style="font-size: 12px; font-weight: bold; color: #1e293b;">sirotya 許諾番号：{LICENSE_NUMBER}</div>
    <div style="font-size: 10px; color: #64748b;">sirotya 許諾管理事務局 認証済</div>
  </div>
</div>`;

const buildHtmlCode = (licenseNumber) =>
  HTML_TEMPLATE
    .replaceAll('{LICENSE_NUMBER}', `第 ${licenseNumber} 号`)
    .replaceAll('{BADGE_IMAGE_URL}', BADGE_IMAGE_URL);

const htmlCodeMessage = (licenseNumber) =>
  `**Webサイト貼り付け用HTMLコード**\n\`\`\`html\n${buildHtmlCode(licenseNumber)}\n\`\`\``;

// ===================== 許諾証＆通知 =====================
async function makeCertificate(app) {
  return generateCertificate({
    siteName: app.siteName,
    licenseNumber: app.licenseNumber,
    issuedAt: app.approvedAt,
  });
}

/** Embed(許諾証画像つき) + HTMLコードの2通を作る */
function noticePayloads(app, certBuf, title, description, withCode = true) {
  const embed = new EmbedBuilder().setColor(0x22c55e).setTitle(title).setDescription(description);
  const files = [];
  if (certBuf) {
    embed.setImage('attachment://certificate.png');
    files.push(new AttachmentBuilder(certBuf, { name: 'certificate.png' }));
  }
  const payloads = [{ embeds: [embed], files }];
  if (withCode) payloads.push({ content: htmlCodeMessage(app.licenseNumber) });
  return payloads;
}

/** DM → 失敗したら申請チャンネルにプライベートスレッドを作って通知 */
async function deliverToApplicant(app, payloads, threadName, allowThread = true) {
  try {
    const user = await client.users.fetch(app.userId);
    for (const p of payloads) await user.send(p);
    return { ok: true, via: 'dm' };
  } catch (e) {
    console.error('DM送信失敗:', e.message);
  }
  if (!allowThread) return { ok: false };
  try {
    const applyChannel = await client.channels.fetch(APPLY_CHANNEL_ID);
    const thread = await applyChannel.threads.create({
      name: threadName,
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: 10080,
    });
    await thread.members.add(app.userId);
    await thread.send({
      content: `<@${app.userId}> DMを送信できなかったため、こちらでお知らせします。`,
    });
    for (const p of payloads) await thread.send(p);
    return { ok: true, via: 'thread', thread };
  } catch (e) {
    console.error('スレッド通知失敗:', e);
    return { ok: false };
  }
}

const listText = (app) =>
  [
    `**第 ${app.licenseNumber} 号** ｜ **${escapeMarkdown(app.siteName)}**`,
    `URL：${app.siteUrl}`,
    `認定日：${fmtDate(app.approvedAt)}`,
  ].join('\n');

// ===================== UI部品 =====================
/** kind: 'a' = 新規申請, 'u' = 登録情報の変更申請 */
const reviewRow = (kind, id, disabled = false) => {
  const p = kind === 'u' ? 'u' : '';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${p}approve_${id}`)
      .setLabel('✅ 承認して発行')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${p}reject_${id}`)
      .setLabel('❌ 却下')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
};

const textInput = (id, label, style, { placeholder = '', max = 100, value } = {}) => {
  const t = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(style)
    .setRequired(true)
    .setMaxLength(max);
  if (placeholder) t.setPlaceholder(placeholder);
  if (value) t.setValue(value.slice(0, max));
  return new ActionRowBuilder().addComponents(t);
};

const buildApplyModal = () =>
  new ModalBuilder()
    .setCustomId('apply_modal')
    .setTitle('sirotya 使用許諾 申請フォーム')
    .addComponents(
      textInput('applicant_name', '申請者名', TextInputStyle.Short, { placeholder: '例: 〇〇管理人' }),
      textInput('site_name', '対象Webサイト名', TextInputStyle.Short),
      textInput('site_url', '掲載予定URL', TextInputStyle.Short, { placeholder: 'https://example.com', max: 300 }),
      textInput('site_desc', 'サイトの概要・用途', TextInputStyle.Paragraph, { max: 1000 }),
    );

const buildUpdateModal = (app) =>
  new ModalBuilder()
    .setCustomId(`update_modal_${app.licenseNumber}`)
    .setTitle(`登録情報の変更（第 ${app.licenseNumber} 号）`.slice(0, 45))
    .addComponents(
      textInput('new_site_name', '新しいサイト名', TextInputStyle.Short, { value: app.siteName }),
      textInput('new_site_url', '新しいURL', TextInputStyle.Short, { value: app.siteUrl, max: 300 }),
    );

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

// 却下理由（運営がセレクトメニューで選ぶ）
const REJECT_REASONS = [
  {
    key: 'unreachable',
    label: 'URLにアクセスできない',
    text: 'ご申請のURLにアクセスできませんでした。URLに誤りがないか、サイトが公開状態かをご確認ください。',
  },
  {
    key: 'incomplete',
    label: 'サイト内容が未完成・準備中',
    text: 'サイトの内容が未完成、または準備中のため、現時点では審査できませんでした。公開準備が整ってから改めてご申請ください。',
  },
  {
    key: 'terms',
    label: '利用規約に抵触',
    text: 'サイトの内容が利用規約に抵触するおそれがあるため、今回は許諾を見送りました。内容をご確認・修正のうえ、再度ご申請ください。',
  },
  { key: 'other', label: 'その他（自由記述）', text: null },
];

// ===================== クライアント =====================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
  console.log(`ログイン完了: ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName('setup_panel')
      .setDescription('申請パネルを申請チャンネルに設置します（管理者用）')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName('verify')
      .setDescription('許諾番号が正式に発行されたものか確認します')
      .addStringOption((o) => o.setName('number').setDescription('例: SR-2026-001').setRequired(true)),
    new SlashCommandBuilder()
      .setName('revoke')
      .setDescription('許諾を取り消します（管理者用）')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((o) => o.setName('number').setDescription('例: SR-2026-001').setRequired(true)),
    new SlashCommandBuilder()
      .setName('my_license')
      .setDescription('自分の許諾証画像とHTMLコードを再表示します（本人にのみ表示）'),
    new SlashCommandBuilder()
      .setName('update_site')
      .setDescription('登録済みサイトのURL・サイト名の変更を申請します')
      .addStringOption((o) =>
        o.setName('number').setDescription('許諾番号（複数持っている場合のみ必要）').setRequired(false)),
    new SlashCommandBuilder()
      .setName('stats')
      .setDescription('申請・承認の統計を表示します（運営用）')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  ].map((c) => c.toJSON());

  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.commands.set(commands);
  console.log('スラッシュコマンドを登録しました');

  // 毎日0:00（日本時間）に自動バックアップ
  cron.schedule('0 0 * * *', () => sendBackup('毎日0時の定期バックアップ'), {
    timezone: 'Asia/Tokyo',
  });
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'setup_panel': return await cmdSetupPanel(interaction);
        case 'verify': return await cmdVerify(interaction);
        case 'revoke': return await cmdRevoke(interaction);
        case 'my_license': return await cmdMyLicense(interaction);
        case 'update_site': return await cmdUpdateSite(interaction);
        case 'stats': return await cmdStats(interaction);
      }
    } else if (interaction.isButton()) {
      return await onButton(interaction);
    } else if (interaction.isStringSelectMenu()) {
      return await onSelect(interaction);
    } else if (interaction.isModalSubmit()) {
      return await onModal(interaction);
    }
  } catch (err) {
    console.error('interaction error:', err);
    const msg = ephemeral('⚠️ 内部エラーが発生しました。運営にお問い合わせください。');
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

// ===================== ルーティング =====================
async function onButton(interaction) {
  const id = interaction.customId;
  if (id === 'open_apply_modal') return interaction.showModal(buildApplyModal());

  const i = id.indexOf('_');
  const action = id.slice(0, i);
  const key = id.slice(i + 1);
  switch (action) {
    case 'approve': return handleApprove(interaction, key);
    case 'reject': return promptRejectReason(interaction, 'a', key);
    case 'uapprove': return handleUpdateApprove(interaction, key);
    case 'ureject': return promptRejectReason(interaction, 'u', key);
  }
}

async function onSelect(interaction) {
  const id = interaction.customId;
  if (!id.startsWith('rsel_')) return;
  // rsel_<kind>_<id>
  const rest = id.slice(5);
  const kind = rest[0];
  const key = rest.slice(2);
  const reasonKey = interaction.values[0];

  if (!canReview(interaction)) {
    return interaction.reply(ephemeral('❌ この操作を行う権限がありません。'));
  }

  if (reasonKey === 'other') {
    const modal = new ModalBuilder()
      .setCustomId(`rmodal_${kind}_${key}`)
      .setTitle('却下理由（申請者にDM送信されます）')
      .addComponents(
        textInput('reason', '却下理由', TextInputStyle.Paragraph, {
          placeholder: '申請者に伝える理由を入力してください', max: 500,
        }),
      );
    return interaction.showModal(modal);
  }

  const reason = REJECT_REASONS.find((r) => r.key === reasonKey);
  await interaction.update({ content: '処理中…', components: [] });
  const warnings = await finalizeReject(interaction, kind, key, reason.text, reason.label);
  await interaction.editReply({
    content: ['✅ 却下して申請者に通知しました。', ...warnings].join('\n'),
  });
}

async function onModal(interaction) {
  const id = interaction.customId;
  if (id === 'apply_modal') return handleApplySubmit(interaction);
  if (id.startsWith('update_modal_')) return handleUpdateSubmit(interaction, id.slice('update_modal_'.length));
  if (id.startsWith('rmodal_')) {
    const rest = id.slice('rmodal_'.length);
    const kind = rest[0];
    const key = rest.slice(2);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const text = interaction.fields.getTextInputValue('reason').trim();
    const warnings = await finalizeReject(interaction, kind, key, text, 'その他');
    return interaction.editReply({
      content: ['✅ 却下して申請者に通知しました。', ...warnings].join('\n'),
    });
  }
}

const canReview = (interaction) =>
  interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

// ===================== 申請パネル =====================
async function cmdSetupPanel(interaction) {
  const channel = await client.channels.fetch(APPLY_CHANNEL_ID);
  const embed = new EmbedBuilder()
    .setColor(0x2563eb)
    .setTitle('☕ sirotya Webサイト掲載・連携許諾 申請窓口')
    .setDescription(
      [
        'sirotya のWebサイト掲載・連携許諾の申請を受け付けています。',
        '',
        '・申請は **無料** です。',
        '・審査で承認されると、**許諾番号**（第 SR-○○○○-○○○ 号）、**許諾証画像**、**認証バッジ（埋め込みHTMLコード）** が発行され、DMでお届けします。',
        '・DMを受け取れる設定にしてからご申請ください。',
        '・DMを消してしまった場合は `/my_license`、サイトのURL・名称を変更した場合は `/update_site` をご利用ください。',
        '',
        '下のボタンから申請フォームを開いてください。',
      ].join('\n'),
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('open_apply_modal')
      .setLabel('📝 許諾を申請する')
      .setStyle(ButtonStyle.Primary),
  );
  await channel.send({ embeds: [embed], components: [row] });
  await interaction.reply(ephemeral('✅ 申請パネルを設置しました。'));
}

// ===================== 新規申請の受付 =====================
async function handleApplySubmit(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // URL確認に時間がかかるため

  const applicantName = interaction.fields.getTextInputValue('applicant_name').trim();
  const siteName = interaction.fields.getTextInputValue('site_name').trim();
  const siteUrl = interaction.fields.getTextInputValue('site_url').trim();
  const siteDesc = interaction.fields.getTextInputValue('site_desc').trim();

  if (!isValidHttpUrl(siteUrl)) {
    return interaction.editReply('❌ URLは `http://` または `https://` から始まる正しい形式で入力してください。お手数ですが、もう一度申請してください。');
  }
  if (findUrlConflict(siteUrl)) {
    return interaction.editReply('❌ このURLはすでに登録または申請中です。心当たりがない場合は運営にお問い合わせください。');
  }

  const check = await checkUrl(siteUrl);
  if (!check.ok) {
    return interaction.editReply(`❌ URLにアクセスできませんでした（${check.reason}）。正しいURLか確認して、もう一度申請してください。`);
  }

  // 確認中に同じURLが申請された場合に備え、登録直前に再チェック
  if (findUrlConflict(siteUrl)) {
    return interaction.editReply('❌ このURLはすでに登録または申請中です。');
  }

  const appId = crypto.randomBytes(4).toString('hex');
  const app = {
    id: appId,
    userId: interaction.user.id,
    applicantName,
    siteName,
    siteUrl,
    siteDesc,
    status: 'PENDING',
    appliedAt: new Date().toISOString(),
    urlCheck: check,
    licenseNumber: null,
    approvedAt: null,
    reviewMessageId: null,
    listMessageId: null,
  };
  db.applications[appId] = app;
  saveDb();

  const embed = new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle('📥 新規 許諾申請')
    .addFields(
      { name: '申請者', value: `<@${interaction.user.id}>（ID: ${interaction.user.id}）` },
      { name: '申請者名', value: applicantName },
      { name: 'サイト名', value: siteName },
      { name: 'URL', value: siteUrl },
      { name: '自動疎通チェック', value: formatCheck(check) },
      { name: '概要・用途', value: siteDesc },
      { name: '申請日時', value: fmtDateTime(app.appliedAt) },
    )
    .setFooter({ text: `申請ID: ${appId}` });

  try {
    const reviewChannel = await client.channels.fetch(ADMIN_REVIEW_CHANNEL_ID);
    const msg = await reviewChannel.send({
      embeds: [embed],
      components: [reviewRow('a', appId)],
      allowedMentions: { parse: [] },
    });
    app.reviewMessageId = msg.id;
    saveDb();
  } catch (e) {
    // 審査チャンネルへ投稿できなかった場合は申請データを取り消す（再申請できるように）
    console.error('審査チャンネルへの投稿に失敗:', e);
    delete db.applications[appId];
    saveDb();
    return interaction.editReply('⚠️ 申請を運営へ送信できませんでした。お手数ですが運営にお問い合わせください。');
  }

  await interaction.editReply('✅ 申請を受け付けました。審査完了までDMにて結果をお知らせします。');
}

// ===================== 審査メッセージの更新 =====================
async function markReviewMessage(kind, rec, color, resultText) {
  const ch = await client.channels.fetch(ADMIN_REVIEW_CHANNEL_ID);
  const msg = await ch.messages.fetch(rec.reviewMessageId);
  const embed = EmbedBuilder.from(msg.embeds[0])
    .setColor(color)
    .addFields({ name: '審査結果', value: resultText.slice(0, 1024) });
  await msg.edit({ embeds: [embed], components: [reviewRow(kind, rec.id, true)] });
}

// ===================== 承認（新規）=====================
async function handleApprove(interaction, appId) {
  if (!canReview(interaction)) {
    return interaction.reply(ephemeral('❌ この操作を行う権限がありません。'));
  }
  await interaction.deferUpdate();

  const app = db.applications[appId];
  if (!app) return interaction.followUp(ephemeral('申請データが見つかりません。'));
  if (app.status !== 'PENDING') return interaction.followUp(ephemeral('この申請はすでに処理済みです。'));

  // 1. 発番＆保存（先に確定させて二重処理を防ぐ）
  const licenseNumber = issueLicenseNumber();
  app.status = 'APPROVED';
  app.licenseNumber = licenseNumber;
  app.approvedAt = new Date().toISOString();
  app.reviewedBy = interaction.user.id;
  saveDb();

  const warnings = [];

  // 2. ロール付与
  try {
    const member = await interaction.guild.members.fetch(app.userId);
    await member.roles.add(PARTNER_ROLE_ID);
  } catch (e) {
    console.error('ロール付与失敗:', e);
    warnings.push('ロールの付与に失敗しました（ユーザー退出、またはBotのロール順位/権限を確認してください）。');
  }

  // 3. 認定サイト一覧へ投稿（メッセージIDを保存 → 後で自動更新できるように）
  try {
    const listChannel = await client.channels.fetch(LIST_CHANNEL_ID);
    const listMsg = await listChannel.send({ content: listText(app), allowedMentions: { parse: [] } });
    app.listMessageId = listMsg.id;
    saveDb();
  } catch (e) {
    console.error('一覧投稿失敗:', e);
    warnings.push('認定サイト一覧への投稿に失敗しました。');
  }

  // 4. 許諾証画像を生成
  let certBuf = null;
  try {
    certBuf = await makeCertificate(app);
  } catch (e) {
    console.error('許諾証生成失敗:', e);
    warnings.push('許諾証画像の生成に失敗しました（画像なしで通知しました）。`/my_license` で再発行できます。');
  }

  // 5. 申請者へ通知（DM → 失敗時スレッド）
  const payloads = noticePayloads(
    app,
    certBuf,
    '✅ 許諾申請が承認されました',
    [
      `**${escapeMarkdown(app.siteName)}** の掲載・連携許諾が承認されました。`,
      '',
      `**許諾番号：第 ${licenseNumber} 号**`,
      '',
      '下の許諾証画像は、画像を長押し（PCは右クリック）で保存できます。',
      '続けて送るHTMLコードをWebサイトに貼り付けてご利用ください。',
      '',
      'DMを消してしまった場合は `/my_license` で再表示できます。',
    ].join('\n'),
  );
  const result = await deliverToApplicant(app, payloads, `許諾通知-${licenseNumber}`);
  if (result.via === 'thread') {
    warnings.push(`DMが送れなかったため、プライベートスレッド（${result.thread}）で通知しました。`);
  } else if (!result.ok) {
    warnings.push('⚠️ DMもスレッド通知も失敗しました。申請者へ手動で連絡してください（申請者は /my_license でも取得できます）。');
  }

  // 6. 審査メッセージを更新
  await markReviewMessage(
    'a', app, 0x22c55e,
    `${interaction.user}（${interaction.user.tag}）により承認済（第 ${licenseNumber} 号）`,
  );

  if (warnings.length) await interaction.followUp(ephemeral(warnings.join('\n')));

  void sendBackup(`承認処理（第 ${licenseNumber} 号）`);
}

// ===================== 却下（定型理由つき）=====================
async function promptRejectReason(interaction, kind, key) {
  if (!canReview(interaction)) {
    return interaction.reply(ephemeral('❌ この操作を行う権限がありません。'));
  }
  const rec = kind === 'a' ? db.applications[key] : db.updates[key];
  if (!rec) return interaction.reply(ephemeral('申請データが見つかりません。'));
  if (rec.status !== 'PENDING') return interaction.reply(ephemeral('この申請はすでに処理済みです。'));

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`rsel_${kind}_${key}`)
    .setPlaceholder('却下理由を選択してください')
    .addOptions(REJECT_REASONS.map((r) => ({ label: r.label, value: r.key })));

  await interaction.reply({
    content: '却下理由を選んでください。選んだ内容が申請者へDMで送信されます。',
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  });
}

/** 却下の確定処理。注意が必要な点を文字列配列で返す */
async function finalizeReject(interaction, kind, key, reasonText, reasonLabel) {
  const warnings = [];
  const rec = kind === 'a' ? db.applications[key] : db.updates[key];
  if (!rec) return ['申請データが見つかりません。'];
  if (rec.status !== 'PENDING') return ['この申請はすでに処理済みです。'];

  rec.status = 'REJECTED';
  rec.rejectReason = reasonText;
  rec.rejectLabel = reasonLabel;
  rec.rejectedAt = new Date().toISOString();
  rec.reviewedBy = interaction.user.id;
  saveDb();

  const siteName = kind === 'a' ? rec.siteName : rec.newSiteName;
  const howTo =
    kind === 'a'
      ? `内容を修正のうえ、<#${APPLY_CHANNEL_ID}> のボタンから**再度ご申請いただけます**。`
      : '内容を修正のうえ、`/update_site` から**再度ご申請いただけます**。';

  const embed = new EmbedBuilder()
    .setColor(0xef4444)
    .setTitle(kind === 'a' ? '許諾申請の結果について' : '登録情報の変更申請の結果について')
    .setDescription(
      [
        `**${escapeMarkdown(siteName)}** の${kind === 'a' ? '許諾申請' : '変更申請'}について、審査の結果、今回は見送りとなりました。`,
        '',
        '**見送りの理由**',
        reasonText,
        '',
        howTo,
        'ご不明な点があれば、運営までお気軽にお問い合わせください。',
      ].join('\n'),
    );

  const result = await deliverToApplicant(
    { userId: rec.userId }, [{ embeds: [embed] }], '', false,
  );
  if (!result.ok) warnings.push('申請者へのDM送信に失敗しました（DMを閉じている可能性があります）。');

  try {
    await markReviewMessage(
      kind, rec, 0xef4444,
      `${interaction.user}（${interaction.user.tag}）により却下済\n理由：${reasonLabel}${reasonLabel === 'その他' ? `\n${reasonText}` : ''}`,
    );
  } catch (e) {
    console.error('審査メッセージ更新失敗:', e);
    warnings.push('審査メッセージの更新に失敗しました。');
  }
  return warnings;
}

// ===================== /my_license =====================
async function cmdMyLicense(interaction) {
  const mine = approvedOf(interaction.user.id);
  if (!mine.length) {
    return interaction.reply(ephemeral('有効な許諾が見つかりませんでした。まだ申請していない場合は、申請チャンネルからご申請ください。'));
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const list = mine.slice(0, 5);
  for (let i = 0; i < list.length; i++) {
    const app = list[i];
    let files = [];
    try {
      const buf = await makeCertificate(app);
      files = [new AttachmentBuilder(buf, { name: `certificate_${app.licenseNumber}.png` })];
    } catch (e) {
      console.error('許諾証生成失敗:', e);
    }
    const payload = {
      content: `**第 ${app.licenseNumber} 号** ｜ **${escapeMarkdown(app.siteName)}**\n${htmlCodeMessage(app.licenseNumber)}`,
      files,
    };
    if (i === 0) await interaction.editReply(payload);
    else await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
  }
  if (mine.length > list.length) {
    await interaction.followUp(
      ephemeral(`許諾が ${mine.length} 件ありますが、最初の ${list.length} 件のみ表示しています。`),
    );
  }
}

// ===================== /update_site（変更申請）=====================
async function cmdUpdateSite(interaction) {
  const mine = approvedOf(interaction.user.id);
  const numOpt = interaction.options.getString('number');
  let target;

  if (!mine.length) {
    return interaction.reply(ephemeral('変更できる許諾が見つかりませんでした。'));
  }
  if (numOpt) {
    const num = normalizeLicenseNumber(numOpt);
    target = mine.find((a) => a.licenseNumber === num);
    if (!target) return interaction.reply(ephemeral('その許諾番号は、あなたの有効な許諾に見つかりませんでした。'));
  } else if (mine.length === 1) {
    target = mine[0];
  } else {
    const nums = mine.map((a) => `・第 ${a.licenseNumber} 号（${a.siteName}）`).join('\n');
    return interaction.reply(
      ephemeral(`許諾が複数あります。\`number\` に許諾番号を指定して、もう一度実行してください。\n${nums}`),
    );
  }

  const pending = Object.values(db.updates).some(
    (u) => u.licenseNumber === target.licenseNumber && u.status === 'PENDING',
  );
  if (pending) {
    return interaction.reply(ephemeral('この許諾にはすでに変更申請が審査中です。結果をお待ちください。'));
  }
  return interaction.showModal(buildUpdateModal(target));
}

async function handleUpdateSubmit(interaction, licenseNumber) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const app = findByLicenseNumber(licenseNumber);
  if (!app || app.status !== 'APPROVED' || app.userId !== interaction.user.id) {
    return interaction.editReply('❌ 対象の許諾が見つからないか、すでに無効になっています。');
  }

  const newName = interaction.fields.getTextInputValue('new_site_name').trim();
  const newUrl = interaction.fields.getTextInputValue('new_site_url').trim();

  if (!isValidHttpUrl(newUrl)) {
    return interaction.editReply('❌ URLは `http://` または `https://` から始まる正しい形式で入力してください。');
  }
  const urlChanged = newUrl !== app.siteUrl;
  if (newName === app.siteName && !urlChanged) {
    return interaction.editReply('変更内容がありません。');
  }

  let check = null;
  if (urlChanged) {
    if (findUrlConflict(newUrl, app.licenseNumber)) {
      return interaction.editReply('❌ このURLはすでに登録または申請中です。');
    }
    check = await checkUrl(newUrl);
    if (!check.ok) {
      return interaction.editReply(`❌ URLにアクセスできませんでした（${check.reason}）。正しいURLか確認してください。`);
    }
    if (findUrlConflict(newUrl, app.licenseNumber)) {
      return interaction.editReply('❌ このURLはすでに登録または申請中です。');
    }
  }

  const id = crypto.randomBytes(4).toString('hex');
  const rec = {
    id,
    licenseNumber: app.licenseNumber,
    userId: interaction.user.id,
    oldSiteName: app.siteName,
    oldSiteUrl: app.siteUrl,
    newSiteName: newName,
    newSiteUrl: newUrl,
    status: 'PENDING',
    requestedAt: new Date().toISOString(),
    urlCheck: check,
    reviewMessageId: null,
  };
  db.updates[id] = rec;
  saveDb();

  const embed = new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle('🔁 登録情報の変更申請')
    .addFields(
      { name: '許諾番号', value: `第 ${app.licenseNumber} 号` },
      { name: '申請者', value: `<@${interaction.user.id}>（ID: ${interaction.user.id}）` },
      { name: 'サイト名', value: newName === app.siteName ? `${app.siteName}（変更なし）` : `${app.siteName} → **${newName}**` },
      { name: 'URL', value: urlChanged ? `${app.siteUrl}\n→ **${newUrl}**` : `${app.siteUrl}（変更なし）` },
      { name: '自動疎通チェック', value: urlChanged ? formatCheck(check) : '（URL変更なし）' },
      { name: '申請日時', value: fmtDateTime(rec.requestedAt) },
    )
    .setFooter({ text: `変更申請ID: ${id}` });

  const reviewChannel = await client.channels.fetch(ADMIN_REVIEW_CHANNEL_ID);
  const msg = await reviewChannel.send({
    embeds: [embed],
    components: [reviewRow('u', id)],
    allowedMentions: { parse: [] },
  });
  rec.reviewMessageId = msg.id;
  saveDb();

  await interaction.editReply('✅ 変更申請を受け付けました。審査結果はDMでお知らせします。許諾番号はそのまま引き継がれます。');
}

async function handleUpdateApprove(interaction, id) {
  if (!canReview(interaction)) {
    return interaction.reply(ephemeral('❌ この操作を行う権限がありません。'));
  }
  await interaction.deferUpdate();

  const rec = db.updates[id];
  if (!rec) return interaction.followUp(ephemeral('申請データが見つかりません。'));
  if (rec.status !== 'PENDING') return interaction.followUp(ephemeral('この申請はすでに処理済みです。'));

  const app = findByLicenseNumber(rec.licenseNumber);
  if (!app || app.status !== 'APPROVED') {
    return interaction.followUp(ephemeral('元の許諾がすでに無効（取消済など）のため、承認できません。却下してください。'));
  }

  const warnings = [];

  // 1. データ更新（履歴を残す）
  app.history = app.history ?? [];
  app.history.push({
    changedAt: new Date().toISOString(),
    oldSiteName: app.siteName,
    oldSiteUrl: app.siteUrl,
  });
  app.siteName = rec.newSiteName;
  app.siteUrl = rec.newSiteUrl;
  rec.status = 'APPROVED';
  rec.approvedAt = new Date().toISOString();
  rec.reviewedBy = interaction.user.id;
  saveDb();

  // 2. 認定サイト一覧の自動更新（メッセージが無ければ新規投稿）
  try {
    const listChannel = await client.channels.fetch(LIST_CHANNEL_ID);
    let edited = false;
    if (app.listMessageId) {
      try {
        const m = await listChannel.messages.fetch(app.listMessageId);
        await m.edit({ content: listText(app), allowedMentions: { parse: [] } });
        edited = true;
      } catch { /* 消されている場合は新規投稿へ */ }
    }
    if (!edited) {
      const m = await listChannel.send({ content: listText(app), allowedMentions: { parse: [] } });
      app.listMessageId = m.id;
      saveDb();
      warnings.push('一覧の元メッセージが見つからなかったため、新しく投稿しました（古い投稿が残っていれば手動で削除してください）。');
    }
  } catch (e) {
    console.error('一覧更新失敗:', e);
    warnings.push('認定サイト一覧の更新に失敗しました。手動で修正してください。');
  }

  // 3. 新しい許諾証をDM（サイト名が変わるため）
  let certBuf = null;
  try {
    certBuf = await makeCertificate(app);
  } catch (e) {
    console.error('許諾証生成失敗:', e);
  }
  const payloads = noticePayloads(
    app,
    certBuf,
    '✅ 登録情報の変更が承認されました',
    [
      `許諾番号 **第 ${app.licenseNumber} 号** はそのまま、登録情報を更新しました。`,
      '',
      `サイト名：**${escapeMarkdown(app.siteName)}**`,
      `URL：${app.siteUrl}`,
      '',
      '更新後の許諾証画像を添付しています。',
    ].join('\n'),
    false,
  );
  const result = await deliverToApplicant(app, payloads, '', false);
  if (!result.ok) {
    warnings.push('申請者へのDM送信に失敗しました（申請者は /my_license で最新の許諾証を取得できます）。');
  }

  await markReviewMessage(
    'u', rec, 0x22c55e,
    `${interaction.user}（${interaction.user.tag}）により承認済（第 ${app.licenseNumber} 号の登録情報を更新）`,
  );
  if (warnings.length) await interaction.followUp(ephemeral(warnings.join('\n')));

  void sendBackup(`変更承認（第 ${app.licenseNumber} 号）`);
}

// ===================== /verify =====================
async function cmdVerify(interaction) {
  const num = normalizeLicenseNumber(interaction.options.getString('number'));
  const app = num && findByLicenseNumber(num);

  if (!app) {
    return interaction.reply(ephemeral('❌ 該当する許諾番号は見つかりませんでした。番号をご確認ください（例: SR-2026-001）。'));
  }
  if (app.status === 'REVOKED') {
    return interaction.reply(ephemeral(`⚠️ 第 ${num} 号は **取消済** です（${app.siteName}）。この番号による許諾は無効です。`));
  }
  return interaction.reply(
    ephemeral(`✅ 第 ${num} 号は **${app.siteName}**（${app.siteUrl}）に対して正式に発行されています。`),
  );
}

// ===================== /revoke =====================
async function cmdRevoke(interaction) {
  const num = normalizeLicenseNumber(interaction.options.getString('number'));
  const app = num && findByLicenseNumber(num);

  if (!app) return interaction.reply(ephemeral('❌ 該当する許諾番号が見つかりません。'));
  if (app.status === 'REVOKED') return interaction.reply(ephemeral('すでに取消済です。'));

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  app.status = 'REVOKED';
  app.revokedAt = new Date().toISOString();
  app.revokedBy = interaction.user.id;
  // 審査中の変更申請があれば自動で却下扱いにする
  for (const u of Object.values(db.updates)) {
    if (u.licenseNumber === num && u.status === 'PENDING') u.status = 'REJECTED';
  }
  saveDb();

  const notes = [];
  if (!approvedOf(app.userId).length) {
    try {
      const member = await interaction.guild.members.fetch(app.userId);
      await member.roles.remove(PARTNER_ROLE_ID);
      notes.push('ロールを剥奪しました。');
    } catch {
      notes.push('ロールの剥奪に失敗しました（ユーザー退出、または権限を確認してください）。');
    }
  } else {
    notes.push('このユーザーは他に有効な許諾を持つため、ロールは維持しています。');
  }

  const r = await deliverToApplicant(
    app,
    [{ content: `**${app.siteName}** に発行されていた許諾（第 ${num} 号）は取り消されました。\nWebサイトから許諾表記を削除してください。` }],
    '', false,
  );
  notes.push(r.ok ? '申請者にDMで通知しました。' : '申請者へのDM通知に失敗しました。');
  notes.push('※ 認定サイト一覧の過去投稿は自動では削除されません。必要に応じて手動で削除してください。');

  await interaction.editReply(`✅ 第 ${num} 号（${app.siteName}）を取消済にしました。\n${notes.join('\n')}`);
  void sendBackup(`取消処理（第 ${num} 号）`);
}

// ===================== /stats =====================
async function cmdStats(interaction) {
  const apps = allApps();
  const count = (s) => apps.filter((a) => a.status === s).length;
  const pendingUpdates = Object.values(db.updates).filter((u) => u.status === 'PENDING').length;
  const issued = Object.entries(db.counters)
    .map(([y, n]) => `${y}年: ${n}件`)
    .join(' / ') || 'なし';

  const embed = new EmbedBuilder()
    .setColor(0x2563eb)
    .setTitle('📊 sirotya 許諾管理 統計')
    .addFields(
      { name: '総申請数', value: `${apps.length} 件`, inline: true },
      { name: '承認済みサイト', value: `${count('APPROVED')} 件`, inline: true },
      { name: '審査待ち', value: `${count('PENDING')} 件`, inline: true },
      { name: '却下', value: `${count('REJECTED')} 件`, inline: true },
      { name: '取消済', value: `${count('REVOKED')} 件`, inline: true },
      { name: '変更申請（審査待ち）', value: `${pendingUpdates} 件`, inline: true },
      { name: '許諾番号の発行数', value: issued },
      {
        name: '最終バックアップ',
        value: lastBackupAt ? fmtDateTime(lastBackupAt) : '（Bot起動後はまだ実行されていません）',
      },
    )
    .setTimestamp();
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// Render(Web Service)用：ポートを開いて生存確認に応答する
// Background Worker で動かす場合は、このブロックは不要です。
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('sirotya license bot is running');
  })
  .listen(process.env.PORT || 3000, () => {
    console.log('ヘルスチェック用サーバー起動');
  });

client.login(DISCORD_TOKEN);
