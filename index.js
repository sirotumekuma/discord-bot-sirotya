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

const emptyDb = () => ({ counters: {}, applications: {}, updates: {}, blocked: {} });
let db = emptyDb();
let dbWasEmptyAtBoot = true;

if (fs.existsSync(DB_FILE)) {
  try {
    db = { ...emptyDb(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
    dbWasEmptyAtBoot =
      Object.keys(db.applications).length === 0 && Object.keys(db.counters).length === 0;
  } catch (e) {
    // 壊れたファイルは退避してから新規開始（上書きで失わないため）
    console.error('licenses.json の読み込みに失敗しました。退避して新規開始します:', e);
    fs.copyFileSync(DB_FILE, path.join(DATA_DIR, `licenses.corrupt-${Date.now()}.json`));
  }
}

const isValidDb = (d) =>
  d && typeof d === 'object' &&
  d.applications && typeof d.applications === 'object' &&
  d.counters && typeof d.counters === 'object';

const isEmptyDb = () =>
  Object.keys(db.applications).length === 0 &&
  Object.keys(db.counters).length === 0 &&
  Object.keys(db.updates).length === 0;

let backupDirty = false;
let backupTimer = null;

function writeDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

/** 保存すると、20秒後にDiscordへ自動バックアップする（連続した変更はまとめて1回） */
function saveDb() {
  writeDb();
  backupDirty = true;
  if (!BACKUP_CHANNEL_ID) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => sendBackup('データ更新に伴う自動バックアップ'), 20_000);
}
writeDb();

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
const BACKUP_FILE_RE = /^licenses-\d+\.json$/;

/** バックアップチャンネルが埋まらないよう、古いものを削除（最新50件を残す） */
async function pruneBackupChannel(ch) {
  const msgs = await ch.messages.fetch({ limit: 100 });
  const mine = [...msgs.values()].filter(
    (m) => m.author.id === client.user.id && m.attachments.some((a) => BACKUP_FILE_RE.test(a.name)),
  );
  for (const m of mine.slice(50)) await m.delete().catch(() => {});
}

async function sendBackup(reason) {
  clearTimeout(backupTimer);
  if (isEmptyDb()) return false; // 空のデータで、有効なバックアップを押し流さない
  backupDirty = false;
  try {
    writeDb();
    const name = `licenses-${stamp()}.json`;

    // ローカルにも世代保存（直近30個）
    fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, name));
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => BACKUP_FILE_RE.test(f)).sort();
    for (const old of files.slice(0, Math.max(0, files.length - 30))) {
      fs.unlinkSync(path.join(BACKUP_DIR, old));
    }

    lastBackupAt = new Date().toISOString();
    if (!BACKUP_CHANNEL_ID) return true;
    const ch = await client.channels.fetch(BACKUP_CHANNEL_ID);
    await ch.send({
      content: `🗄️ データベースバックアップ（${reason}）`,
      files: [new AttachmentBuilder(DB_FILE, { name })],
    });
    pruneBackupChannel(ch).catch(() => {});
    return true;
  } catch (e) {
    console.error('バックアップ失敗:', e);
    backupDirty = true;
    return false;
  }
}

/** 起動時にデータが空なら、バックアップチャンネルの最新ファイルから復元する */
async function restoreFromDiscord() {
  if (!BACKUP_CHANNEL_ID) return false;
  try {
    const ch = await client.channels.fetch(BACKUP_CHANNEL_ID);
    const msgs = await ch.messages.fetch({ limit: 100 });
    for (const m of msgs.values()) { // 新しい順
      if (m.author.id !== client.user.id) continue;
      const att = m.attachments.find((a) => BACKUP_FILE_RE.test(a.name));
      if (!att) continue;
      const res = await fetch(att.url, { signal: AbortSignal.timeout(15000) });
      const data = await res.json();
      if (!isValidDb(data)) continue;
      db = { ...emptyDb(), ...data };
      writeDb();
      return true;
    }
  } catch (e) {
    console.error('Discordからの復元に失敗:', e);
  }
  return false;
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

  // データが空（再デプロイ等で消えた）なら、Discordのバックアップから自動復元
  if (dbWasEmptyAtBoot) {
    const restored = await restoreFromDiscord();
    console.log(
      restored
        ? '✅ Discordのバックアップからデータを復元しました'
        : '復元できるバックアップが見つかりませんでした（新規状態で開始します）',
    );
  }

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
    // ---- v2.1 追加 ----
    new SlashCommandBuilder()
      .setName('help')
      .setDescription('使えるコマンドの一覧を表示します'),
    new SlashCommandBuilder()
      .setName('my_applications')
      .setDescription('自分の申請状況を確認します（本人にのみ表示）'),
    new SlashCommandBuilder()
      .setName('cancel_application')
      .setDescription('審査中の申請を取り下げます'),
    new SlashCommandBuilder()
      .setName('pending')
      .setDescription('審査待ちの申請一覧を表示します（運営用）')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName('licenses')
      .setDescription('許諾の一覧を表示します（運営用）')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((o) =>
        o.setName('status').setDescription('絞り込む状態（省略時：承認済）').addChoices(
          { name: '承認済', value: 'APPROVED' },
          { name: '審査中', value: 'PENDING' },
          { name: '却下', value: 'REJECTED' },
          { name: '取消済', value: 'REVOKED' },
          { name: '取り下げ', value: 'CANCELLED' },
        )),
    new SlashCommandBuilder()
      .setName('lookup')
      .setDescription('申請・許諾を検索します（運営用）')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption((o) => o.setName('user').setDescription('ユーザーで検索'))
      .addStringOption((o) =>
        o.setName('keyword').setDescription('許諾番号・サイト名・URL・申請IDの一部')),
    new SlashCommandBuilder()
      .setName('reissue')
      .setDescription('許諾証とHTMLコードを申請者へ再送します（運営用）')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((o) => o.setName('number').setDescription('例: SR-2026-001').setRequired(true)),
    new SlashCommandBuilder()
      .setName('reinstate')
      .setDescription('取り消した許諾を復活させます（運営用）')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((o) => o.setName('number').setDescription('例: SR-2026-001').setRequired(true)),
    new SlashCommandBuilder()
      .setName('delete_application')
      .setDescription('申請データを完全に削除します（運営用）')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((o) =>
        o.setName('target').setDescription('申請ID（/pending・/lookupで確認）または許諾番号').setRequired(true)),
    new SlashCommandBuilder()
      .setName('block')
      .setDescription('ユーザーを申請禁止にします（運営用）')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption((o) => o.setName('user').setDescription('対象ユーザー').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('理由（運営用メモ）')),
    new SlashCommandBuilder()
      .setName('unblock')
      .setDescription('申請禁止を解除します（運営用）')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption((o) => o.setName('user').setDescription('対象ユーザー').setRequired(true)),
    new SlashCommandBuilder()
      .setName('export')
      .setDescription('申請データをCSVで出力します（運営用）')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName('backup_now')
      .setDescription('今すぐデータをバックアップします（運営用）')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName('restore')
      .setDescription('バックアップのJSONファイルからデータを復元します（管理者用）')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addAttachmentOption((o) =>
        o.setName('file').setDescription('バックアップのJSONファイル').setRequired(true)),
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
        case 'help': return await cmdHelp(interaction);
        case 'my_applications': return await cmdMyApplications(interaction);
        case 'cancel_application': return await cmdCancelApplication(interaction);
        case 'pending': return await cmdPending(interaction);
        case 'licenses': return await cmdLicenses(interaction);
        case 'lookup': return await cmdLookup(interaction);
        case 'reissue': return await cmdReissue(interaction);
        case 'reinstate': return await cmdReinstate(interaction);
        case 'delete_application': return await cmdDeleteApplication(interaction);
        case 'block': return await cmdBlock(interaction);
        case 'unblock': return await cmdUnblock(interaction);
        case 'export': return await cmdExport(interaction);
        case 'backup_now': return await cmdBackupNow(interaction);
        case 'restore': return await cmdRestore(interaction);
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
  if (id === 'open_apply_modal') {
    if (db.blocked[interaction.user.id]) {
      return interaction.reply(ephemeral('❌ 現在、申請を受け付けできません。詳細は運営にお問い合わせください。'));
    }
    return interaction.showModal(buildApplyModal());
  }

  const i = id.indexOf('_');
  const action = id.slice(0, i);
  const key = id.slice(i + 1);
  switch (action) {
    case 'approve': return handleApprove(interaction, key);
    case 'reject': return promptRejectReason(interaction, 'a', key);
    case 'uapprove': return handleUpdateApprove(interaction, key);
    case 'ureject': return promptRejectReason(interaction, 'u', key);
    case 'delok': return handleDeleteConfirm(interaction, key);
    case 'delno': return interaction.update({ content: 'キャンセルしました。', components: [] });
  }
}

async function onSelect(interaction) {
  const id = interaction.customId;
  if (id === 'cancelsel') return handleCancelSelect(interaction);
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
        '・申請状況は `/my_applications`、審査中の申請の取り下げは `/cancel_application` で行えます。',
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

  if (db.blocked[interaction.user.id]) {
    return interaction.editReply('❌ 現在、申請を受け付けできません。詳細は運営にお問い合わせください。');
  }
  const pendingCount = allApps().filter(
    (a) => a.userId === interaction.user.id && a.status === 'PENDING',
  ).length;
  if (pendingCount >= 3) {
    return interaction.editReply('❌ 審査中の申請が多すぎます（上限3件）。結果をお待ちいただくか、`/cancel_application` で取り下げてください。');
  }

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

  await interaction.editReply('✅ 申請を受け付けました。審査完了までDMにて結果をお知らせします。\n申請を取り下げる場合は `/cancel_application`、状況の確認は `/my_applications` をご利用ください。');
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

  if (db.blocked[interaction.user.id]) {
    return interaction.editReply('❌ 現在、申請を受け付けできません。詳細は運営にお問い合わせください。');
  }

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
  try {
    const lc = await client.channels.fetch(LIST_CHANNEL_ID);
    if (!app.listMessageId) throw new Error('no list message id');
    const lm = await lc.messages.fetch(app.listMessageId);
    await lm.delete();
    app.listMessageId = null;
    saveDb();
    notes.push('認定サイト一覧の投稿を削除しました。');
  } catch {
    notes.push('認定サイト一覧の投稿を自動削除できませんでした。必要に応じて手動で削除してください。');
  }

  await interaction.editReply(`✅ 第 ${num} 号（${app.siteName}）を取消済にしました。\n${notes.join('\n')}`);
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
      { name: '取り下げ', value: `${count('CANCELLED')} 件`, inline: true },
      { name: '申請禁止ユーザー', value: `${Object.keys(db.blocked).length} 人`, inline: true },
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

// ===================== v2.1 追加機能 =====================
const STATUS_LABEL = {
  PENDING: '審査中',
  APPROVED: '承認済',
  REJECTED: '却下',
  REVOKED: '取消済',
  CANCELLED: '取り下げ',
};

async function requireStaff(interaction) {
  if (canReview(interaction)) return true;
  await interaction.reply(ephemeral('❌ このコマンドは運営（サーバー管理権限）のみ使用できます。'));
  return false;
}

/** 申請ID / 変更申請ID / 許諾番号から対象を探す */
function resolveRecord(target) {
  const t = String(target).trim();
  if (db.applications[t]) return { kind: 'a', rec: db.applications[t] };
  if (db.updates[t]) return { kind: 'u', rec: db.updates[t] };
  const num = normalizeLicenseNumber(t);
  if (num) {
    const a = findByLicenseNumber(num);
    if (a) return { kind: 'a', rec: a };
  }
  return null;
}

const reviewLink = (rec) =>
  rec.reviewMessageId
    ? `https://discord.com/channels/${GUILD_ID}/${ADMIN_REVIEW_CHANNEL_ID}/${rec.reviewMessageId}`
    : null;

// ---------- /help ----------
async function cmdHelp(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0x2563eb)
    .setTitle('📖 sirotya 許諾管理Bot コマンド一覧')
    .addFields(
      {
        name: '一般ユーザー',
        value: [
          '`/verify` 許諾番号が正式に発行されたものか確認',
          '`/my_license` 自分の許諾証画像とHTMLコードを再表示',
          '`/my_applications` 自分の申請状況を確認',
          '`/cancel_application` 審査中の申請を取り下げ',
          '`/update_site` 登録済みサイトのURL・名称の変更を申請',
        ].join('\n'),
      },
      {
        name: '運営（サーバー管理権限）',
        value: [
          '`/pending` 審査待ちの一覧',
          '`/licenses` 許諾の一覧（状態で絞り込み）',
          '`/lookup` ユーザー・キーワードで検索',
          '`/reissue` 許諾証とHTMLコードを再送',
          '`/reinstate` 取り消した許諾を復活',
          '`/delete_application` 申請データを完全に削除',
          '`/block` `/unblock` ユーザーの申請禁止／解除',
          '`/stats` 統計　`/export` CSV出力　`/backup_now` 即時バックアップ',
        ].join('\n'),
      },
      {
        name: '管理者',
        value: '`/setup_panel` 申請パネル設置　`/revoke` 許諾の取消　`/restore` バックアップから復元',
      },
    );
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ---------- /my_applications ----------
async function cmdMyApplications(interaction) {
  const uid = interaction.user.id;
  const mine = allApps()
    .filter((a) => a.userId === uid)
    .sort((a, b) => b.appliedAt.localeCompare(a.appliedAt))
    .slice(0, 10);
  const ups = Object.values(db.updates).filter((u) => u.userId === uid && u.status === 'PENDING');
  if (!mine.length) return interaction.reply(ephemeral('申請の履歴はありません。'));

  const embed = new EmbedBuilder().setColor(0x2563eb).setTitle('📋 あなたの申請状況');
  for (const a of mine) {
    const lines = [`URL：${a.siteUrl}`, `申請日：${fmtDate(a.appliedAt)}`];
    if (a.status === 'APPROVED') lines.push(`許諾番号：第 ${a.licenseNumber} 号`);
    if (a.status === 'PENDING') lines.push('取り下げる場合は `/cancel_application`');
    if (a.status === 'REJECTED') {
      lines.push(`見送りの理由：${a.rejectReason ?? '（記録なし）'}`, '内容を修正のうえ、再度申請できます。');
    }
    if (a.status === 'REVOKED') lines.push('この許諾は取り消されています。');
    embed.addFields({
      name: `${STATUS_LABEL[a.status] ?? a.status} ｜ ${a.siteName}`.slice(0, 256),
      value: lines.join('\n').slice(0, 1024),
    });
  }
  if (ups.length) embed.setFooter({ text: `変更申請 ${ups.length} 件が審査中です` });
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ---------- /cancel_application（申請者本人による取り下げ）----------
async function cmdCancelApplication(interaction) {
  const uid = interaction.user.id;
  const items = [
    ...allApps()
      .filter((a) => a.userId === uid && a.status === 'PENDING')
      .map((a) => ({
        value: `a:${a.id}`,
        label: `【新規】${a.siteName}`.slice(0, 100),
        description: `申請日 ${fmtDate(a.appliedAt)}`,
      })),
    ...Object.values(db.updates)
      .filter((u) => u.userId === uid && u.status === 'PENDING')
      .map((u) => ({
        value: `u:${u.id}`,
        label: `【変更】${u.newSiteName}`.slice(0, 100),
        description: `第 ${u.licenseNumber} 号 / 申請日 ${fmtDate(u.requestedAt)}`,
      })),
  ].slice(0, 25);

  if (!items.length) return interaction.reply(ephemeral('取り下げできる審査中の申請はありません。'));

  const menu = new StringSelectMenuBuilder()
    .setCustomId('cancelsel')
    .setPlaceholder('取り下げる申請を選んでください')
    .addOptions(items);
  return interaction.reply({
    content: '取り下げる申請を選んでください。選ぶとすぐに取り下げられます（取り下げ後は、あらためて申請できます）。',
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleCancelSelect(interaction) {
  const [kind, id] = interaction.values[0].split(':');
  const rec = kind === 'a' ? db.applications[id] : db.updates[id];
  if (!rec || rec.userId !== interaction.user.id) {
    return interaction.update({ content: '❌ 対象の申請が見つかりません。', components: [] });
  }
  if (rec.status !== 'PENDING') {
    return interaction.update({ content: 'すでに審査が完了しているため、取り下げできません。', components: [] });
  }

  rec.status = 'CANCELLED';
  rec.cancelledAt = new Date().toISOString();
  saveDb();

  try {
    await markReviewMessage(kind, rec, 0x6b7280, '申請者本人により取り下げ済');
  } catch (e) {
    console.error('審査メッセージ更新失敗（取り下げ）:', e);
  }
  const name = kind === 'a' ? rec.siteName : rec.newSiteName;
  return interaction.update({ content: `✅ 「${name}」の申請を取り下げました。`, components: [] });
}

// ---------- /pending ----------
async function cmdPending(interaction) {
  if (!(await requireStaff(interaction))) return;
  const lines = [];
  for (const a of allApps().filter((x) => x.status === 'PENDING')) {
    const link = reviewLink(a);
    lines.push(
      `・**新規** ${escapeMarkdown(a.siteName)} ｜ <@${a.userId}> ｜ ID: \`${a.id}\`${link ? ` ｜ [審査メッセージ](${link})` : ''}`,
    );
  }
  for (const u of Object.values(db.updates).filter((x) => x.status === 'PENDING')) {
    const link = reviewLink(u);
    lines.push(
      `・**変更** 第 ${u.licenseNumber} 号 → ${escapeMarkdown(u.newSiteName)} ｜ <@${u.userId}> ｜ ID: \`${u.id}\`${link ? ` ｜ [審査メッセージ](${link})` : ''}`,
    );
  }
  if (!lines.length) return interaction.reply(ephemeral('✅ 審査待ちの申請はありません。'));

  const shown = lines.slice(0, 20);
  const embed = new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle(`⏳ 審査待ち ${lines.length} 件`)
    .setDescription(shown.join('\n').slice(0, 4000));
  if (lines.length > shown.length) embed.setFooter({ text: `他 ${lines.length - shown.length} 件` });
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ---------- /licenses ----------
async function cmdLicenses(interaction) {
  if (!(await requireStaff(interaction))) return;
  const status = interaction.options.getString('status') ?? 'APPROVED';
  const rows = allApps()
    .filter((a) => a.status === status)
    .sort((a, b) => (a.licenseNumber ?? a.appliedAt).localeCompare(b.licenseNumber ?? b.appliedAt));
  if (!rows.length) return interaction.reply(ephemeral(`「${STATUS_LABEL[status]}」のデータはありません。`));

  const MAX = 20;
  const lines = rows.slice(0, MAX).map(
    (a) =>
      `${a.licenseNumber ? `**第 ${a.licenseNumber} 号**` : `ID: \`${a.id}\``} ｜ ${escapeMarkdown(a.siteName)} ｜ <@${a.userId}>\n${a.siteUrl}`,
  );
  const embed = new EmbedBuilder()
    .setColor(0x2563eb)
    .setTitle(`📚 ${STATUS_LABEL[status]} 一覧`)
    .setDescription(lines.join('\n\n').slice(0, 4000))
    .setFooter({ text: `全 ${rows.length} 件中 ${Math.min(rows.length, MAX)} 件を表示（全件は /export）` });
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ---------- /lookup ----------
async function cmdLookup(interaction) {
  if (!(await requireStaff(interaction))) return;
  const user = interaction.options.getUser('user');
  const kw = interaction.options.getString('keyword')?.trim().toLowerCase();
  if (!user && !kw) return interaction.reply(ephemeral('ユーザーまたはキーワードのどちらかを指定してください。'));

  const rows = allApps()
    .filter(
      (a) =>
        (!user || a.userId === user.id) &&
        (!kw ||
          [a.licenseNumber, a.siteName, a.siteUrl, a.applicantName, a.id].some((v) =>
            String(v ?? '').toLowerCase().includes(kw))),
    )
    .sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
  if (!rows.length) return interaction.reply(ephemeral('該当するデータは見つかりませんでした。'));

  const embed = new EmbedBuilder().setColor(0x2563eb).setTitle(`🔎 検索結果 ${rows.length} 件`);
  if (user && db.blocked[user.id]) {
    embed.setDescription(`⛔ このユーザーは申請禁止中です（理由：${db.blocked[user.id].reason}）`);
  }
  for (const a of rows.slice(0, 5)) {
    const value = [
      `サイト：${a.siteName}`,
      `URL：${a.siteUrl}`,
      `申請者：<@${a.userId}>（${a.applicantName}）`,
      `申請ID：${a.id}`,
      `申請日：${fmtDateTime(a.appliedAt)}`,
      a.approvedAt ? `承認日：${fmtDateTime(a.approvedAt)}` : null,
      a.rejectReason ? `却下理由：${a.rejectReason}` : null,
      a.history?.length ? `変更履歴：${a.history.length} 件` : null,
    ].filter(Boolean).join('\n');
    embed.addFields({
      name: `${a.licenseNumber ? `第 ${a.licenseNumber} 号` : '（番号なし）'} ｜ ${STATUS_LABEL[a.status] ?? a.status}`.slice(0, 256),
      value: value.slice(0, 1024),
    });
  }
  if (rows.length > 5) embed.setFooter({ text: `他 ${rows.length - 5} 件（条件を絞ってください）` });
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ---------- /reissue ----------
async function cmdReissue(interaction) {
  if (!(await requireStaff(interaction))) return;
  const num = normalizeLicenseNumber(interaction.options.getString('number'));
  const app = num && findByLicenseNumber(num);
  if (!app || app.status !== 'APPROVED') {
    return interaction.reply(ephemeral('❌ 有効な（承認済の）許諾番号が見つかりません。'));
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let certBuf = null;
  try {
    certBuf = await makeCertificate(app);
  } catch (e) {
    console.error('許諾証生成失敗:', e);
  }
  const payloads = noticePayloads(
    app,
    certBuf,
    '📮 許諾証の再送',
    [
      `運営より、**${escapeMarkdown(app.siteName)}** の許諾証を再送します。`,
      '',
      `**許諾番号：第 ${app.licenseNumber} 号**`,
      '',
      '続けて送るHTMLコードをWebサイトに貼り付けてご利用ください。',
    ].join('\n'),
  );
  const r = await deliverToApplicant(app, payloads, `許諾再送-${app.licenseNumber}`);
  if (r.via === 'dm') return interaction.editReply('✅ 申請者のDMへ再送しました。');
  if (r.via === 'thread') return interaction.editReply(`✅ DMが送れなかったため、プライベートスレッド（${r.thread}）で送りました。`);
  return interaction.editReply('❌ 再送に失敗しました（DM・スレッドとも不可）。手動で連絡してください。');
}

// ---------- /reinstate ----------
async function cmdReinstate(interaction) {
  if (!(await requireStaff(interaction))) return;
  const num = normalizeLicenseNumber(interaction.options.getString('number'));
  const app = num && findByLicenseNumber(num);
  if (!app) return interaction.reply(ephemeral('❌ 該当する許諾番号が見つかりません。'));
  if (app.status !== 'REVOKED') return interaction.reply(ephemeral('この許諾は取消済ではありません。'));
  if (findUrlConflict(app.siteUrl, app.licenseNumber)) {
    return interaction.reply(ephemeral('❌ このURLは他の許諾・申請で使われているため、復活できません。'));
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  app.status = 'APPROVED';
  delete app.revokedAt;
  delete app.revokedBy;
  app.reinstatedAt = new Date().toISOString();
  saveDb();

  const notes = [];
  try {
    const member = await interaction.guild.members.fetch(app.userId);
    await member.roles.add(PARTNER_ROLE_ID);
    notes.push('ロールを付与しました。');
  } catch {
    notes.push('ロールの付与に失敗しました。');
  }
  try {
    const lc = await client.channels.fetch(LIST_CHANNEL_ID);
    const m = await lc.send({ content: listText(app), allowedMentions: { parse: [] } });
    app.listMessageId = m.id;
    saveDb();
    notes.push('認定サイト一覧に再投稿しました。');
  } catch {
    notes.push('認定サイト一覧への再投稿に失敗しました。');
  }
  const r = await deliverToApplicant(
    app,
    [{ content: `**${app.siteName}** の許諾（第 ${num} 号）が再び有効になりました。\`/my_license\` で許諾証を確認できます。` }],
    '', false,
  );
  notes.push(r.ok ? '申請者にDMで通知しました。' : '申請者へのDM通知に失敗しました。');
  return interaction.editReply(`✅ 第 ${num} 号（${app.siteName}）を復活させました。\n${notes.join('\n')}`);
}

// ---------- /delete_application（運営による完全削除）----------
async function cmdDeleteApplication(interaction) {
  if (!(await requireStaff(interaction))) return;
  const found = resolveRecord(interaction.options.getString('target'));
  if (!found) return interaction.reply(ephemeral('❌ 該当する申請が見つかりません。申請IDは `/pending` や `/lookup` で確認できます。'));
  const { kind, rec } = found;
  if (rec.status === 'APPROVED') {
    return interaction.reply(ephemeral('❌ 承認済みの許諾は削除できません。先に `/revoke` で取り消してください。'));
  }
  const name = kind === 'a' ? rec.siteName : rec.newSiteName;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`delok_${kind}_${rec.id}`)
      .setLabel('🗑️ 完全に削除する')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('delno_0')
      .setLabel('キャンセル')
      .setStyle(ButtonStyle.Secondary),
  );
  return interaction.reply({
    content: [
      '以下の申請データを**完全に削除**します。元に戻せません（申請者への通知は行いません）。',
      `・種別：${kind === 'a' ? '新規申請' : '変更申請'}（${STATUS_LABEL[rec.status] ?? rec.status}）`,
      `・サイト：${name}`,
      `・申請者：<@${rec.userId}>`,
      `・ID：\`${rec.id}\``,
    ].join('\n'),
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleDeleteConfirm(interaction, key) {
  if (!canReview(interaction)) {
    return interaction.update({ content: '❌ この操作を行う権限がありません。', components: [] });
  }
  const kind = key[0];
  const id = key.slice(2);
  const rec = kind === 'a' ? db.applications[id] : db.updates[id];
  if (!rec) return interaction.update({ content: 'すでに削除されています。', components: [] });
  if (rec.status === 'APPROVED') {
    return interaction.update({ content: '❌ 承認済みの許諾は削除できません。', components: [] });
  }

  // 審査メッセージ・一覧投稿が残っていれば削除
  if (rec.reviewMessageId) {
    try {
      const ch = await client.channels.fetch(ADMIN_REVIEW_CHANNEL_ID);
      const m = await ch.messages.fetch(rec.reviewMessageId);
      await m.delete();
    } catch { /* すでに無い場合は無視 */ }
  }
  if (kind === 'a') {
    if (rec.listMessageId) {
      try {
        const lc = await client.channels.fetch(LIST_CHANNEL_ID);
        const m = await lc.messages.fetch(rec.listMessageId);
        await m.delete();
      } catch { /* 無視 */ }
    }
    // この許諾番号に紐づく変更申請も削除
    if (rec.licenseNumber) {
      for (const [uid, u] of Object.entries(db.updates)) {
        if (u.licenseNumber === rec.licenseNumber) delete db.updates[uid];
      }
    }
    delete db.applications[id];
  } else {
    delete db.updates[id];
  }
  saveDb();
  return interaction.update({ content: '🗑️ 削除しました。', components: [] });
}

// ---------- /block /unblock ----------
async function cmdBlock(interaction) {
  if (!(await requireStaff(interaction))) return;
  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason') ?? '（未記入）';
  db.blocked[user.id] = { reason, at: new Date().toISOString(), by: interaction.user.id };
  saveDb();
  return interaction.reply(
    ephemeral(`⛔ <@${user.id}> を申請禁止にしました。\n・理由：${reason}\n・すでに審査中の申請は残っています。必要に応じて却下・削除してください。`),
  );
}

async function cmdUnblock(interaction) {
  if (!(await requireStaff(interaction))) return;
  const user = interaction.options.getUser('user');
  if (!db.blocked[user.id]) return interaction.reply(ephemeral('このユーザーは申請禁止になっていません。'));
  delete db.blocked[user.id];
  saveDb();
  return interaction.reply(ephemeral(`✅ <@${user.id}> の申請禁止を解除しました。`));
}

// ---------- /export ----------
async function cmdExport(interaction) {
  if (!(await requireStaff(interaction))) return;
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // 表計算ソフトの数式注入対策
    return `"${s.replace(/"/g, '""')}"`;
  };
  const head = ['申請ID', '状態', '許諾番号', '申請者ID', '申請者名', 'サイト名', 'URL', '概要', '申請日時', '承認日時', '却下・取消日時', '却下理由'];
  const rows = allApps()
    .sort((a, b) => a.appliedAt.localeCompare(b.appliedAt))
    .map((a) =>
      [
        a.id, STATUS_LABEL[a.status] ?? a.status, a.licenseNumber, a.userId, a.applicantName,
        a.siteName, a.siteUrl, a.siteDesc, a.appliedAt, a.approvedAt,
        a.rejectedAt ?? a.revokedAt ?? a.cancelledAt, a.rejectReason,
      ].map(cell).join(','));
  const csv = '\uFEFF' + [head.map(cell).join(','), ...rows].join('\r\n');
  return interaction.reply({
    content: `📤 ${rows.length} 件を出力しました。個人情報を含むため、取り扱いにご注意ください。`,
    files: [new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: `applications-${stamp()}.csv` })],
    flags: MessageFlags.Ephemeral,
  });
}

// ---------- /backup_now ----------
async function cmdBackupNow(interaction) {
  if (!(await requireStaff(interaction))) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (isEmptyDb()) return interaction.editReply('データがまだ空のため、バックアップは作成しませんでした。');
  const ok = await sendBackup('手動バックアップ');
  if (!ok) return interaction.editReply('❌ バックアップに失敗しました。Botの権限（バックアップチャンネルへの送信・添付）を確認してください。');
  return interaction.editReply(
    BACKUP_CHANNEL_ID
      ? '✅ バックアップチャンネルに送信しました。'
      : '✅ Bot内にバックアップを保存しました（BACKUP_CHANNEL_ID が未設定のため、Discordには送っていません）。',
  );
}

// ---------- /restore ----------
async function cmdRestore(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply(ephemeral('❌ このコマンドは管理者のみ使用できます。'));
  }
  const att = interaction.options.getAttachment('file', true);
  if (!/\.json$/i.test(att.name) || att.size > 8 * 1024 * 1024) {
    return interaction.reply(ephemeral('❌ 8MB以下のJSONファイルを指定してください。'));
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let data;
  try {
    const res = await fetch(att.url, { signal: AbortSignal.timeout(15000) });
    data = await res.json();
  } catch {
    return interaction.editReply('❌ ファイルを読み込めませんでした。');
  }
  if (!isValidDb(data)) {
    return interaction.editReply('❌ バックアップファイルの形式が正しくありません。');
  }

  await sendBackup('復元前の退避'); // 現在のデータを念のため保存
  db = { ...emptyDb(), ...data };
  saveDb();
  return interaction.editReply(
    `✅ 復元しました（申請 ${Object.keys(db.applications).length} 件）。復元前のデータは、バックアップチャンネルに退避済みです。`,
  );
}

// ---------- 終了時の最終バックアップ（再デプロイ・再起動でデータを失わないため）----------
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${sig} を受信：終了前にバックアップします`);
    try {
      if (backupDirty) await sendBackup('シャットダウン前の保存');
    } catch { /* 無視 */ }
    process.exit(0);
  });
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
