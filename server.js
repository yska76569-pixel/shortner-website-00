const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const multer = require('multer');
const crypto = require('crypto');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-session-secret';
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const FREE_LINK_LIMIT = Math.max(1, Number(process.env.FREE_LINK_LIMIT || 5));
const PLAN_1_PRICE = Math.max(1, Number(process.env.PLAN_1_PRICE || 100));
const PLAN_3_PRICE = Math.max(1, Number(process.env.PLAN_3_PRICE || 250));
const PLAN_1_USD = Number(process.env.PLAN_1_USD || 0.81);
const PLAN_3_USD = Number(process.env.PLAN_3_USD || 2.02);
const BKASH_NUMBER = String(process.env.BKASH_NUMBER || '').trim();
const NAGAD_NUMBER = String(process.env.NAGAD_NUMBER || '').trim();
const BINANCE_ID = String(process.env.BINANCE_ID || '').trim();
const API_RATE_LIMIT = Math.max(10, Number(process.env.API_RATE_LIMIT || 120));
const AUTO_BACKUP_HOURS = Math.max(1, Number(process.env.AUTO_BACKUP_HOURS || 24));
const BLOCKED_DOMAINS = String(process.env.BLOCKED_DOMAINS || '')
  .split(',').map(v => v.trim().toLowerCase()).filter(Boolean);

const paymentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.mimetype || '')) {
      return cb(new Error('Payment screenshot must be PNG, JPG or WEBP'));
    }
    cb(null, true);
  }
});

app.set('trust proxy', 1);

// ===== DOMAIN CONFIG =====
const BASE_URL = (process.env.BASE_URL || 'https://thispersonisbrandshortner.world').replace(/\/$/, '');
const BASE_HOST = new URL(BASE_URL).hostname.toLowerCase();
const CUSTOM_DOMAINS = [
  process.env.DOMAIN_1, process.env.DOMAIN_2, process.env.DOMAIN_3,
  process.env.DOMAIN_4, process.env.DOMAIN_5, process.env.DOMAIN_6,
  process.env.DOMAIN_7, process.env.DOMAIN_8, process.env.DOMAIN_9, process.env.DOMAIN_10
].filter(Boolean)
  .map(d => String(d).trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase())
  .filter((d, i, arr) => d && d !== BASE_HOST && arr.indexOf(d) === i);
const AVAILABLE_DOMAINS = [BASE_HOST, ...CUSTOM_DOMAINS];
const PREVIEW_DESCRIPTION = process.env.PREVIEW_DESCRIPTION || 'Fast, clean and secure short links powered by THIS PERSON IS BRAND.';

// ===== VIEW ENGINE / STATIC =====
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(async (req,res,next)=>{
  res.locals.announcement=await getActiveAnnouncement();
  next();
});

// ===== MIDDLEWARE =====
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);
const apiV1Limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: API_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/v1/', apiV1Limiter);

// ===== POSTGRESQL: APP DATA + SESSIONS =====
const dbUrl = (process.env.DATABASE_URL || '').trim();
if (!dbUrl) {
  console.error('❌ DATABASE_URL is required for V6 Full PostgreSQL.');
  console.error('Set DATABASE_URL in the Railway website service, then redeploy.');
  process.exit(1);
}
const isRailwayInternal = /\.railway\.internal(?::\d+)?\//i.test(dbUrl);
const pool = new Pool({
  connectionString: dbUrl,
  ssl: isRailwayInternal ? false : { rejectUnauthorized: false },
  max: 12,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
pool.on('error', err => console.error('PostgreSQL pool error:', err.message));

const sessionStore = new pgSession({
  pool,
  tableName: 'user_sessions',
  createTableIfMissing: true,
  pruneSessionInterval: 60 * 15,
  errorLog: err => console.error('PostgreSQL session store error:', err)
});

app.use(session({
  store: sessionStore,
  proxy: true,
  name: 'tpib.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 30,
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax'
  }
}));

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      telegram_id TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL DEFAULT '',
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      profile_photo TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL DEFAULT 'Asia/Dhaka',
      account_status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      total_links INTEGER NOT NULL DEFAULT 0,
      total_clicks BIGINT NOT NULL DEFAULT 0,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS links (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      selected_domain TEXT NOT NULL,
      original_url TEXT NOT NULL,
      short_code TEXT NOT NULL,
      custom_slug TEXT,
      title TEXT NOT NULL DEFAULT '',
      clicks BIGINT NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      is_expired BOOLEAN NOT NULL DEFAULT FALSE,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(selected_domain, short_code)
    );

    CREATE TABLE IF NOT EXISTS clicks (
      id BIGSERIAL PRIMARY KEY,
      link_id BIGINT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ip_address TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      device TEXT NOT NULL DEFAULT 'Unknown',
      browser TEXT NOT NULL DEFAULT 'Unknown',
      os TEXT NOT NULL DEFAULT 'Unknown',
      country TEXT NOT NULL DEFAULT 'Unknown',
      country_code TEXT NOT NULL DEFAULT 'XX',
      city TEXT NOT NULL DEFAULT '',
      region TEXT NOT NULL DEFAULT '',
      referrer TEXT NOT NULL DEFAULT '',
      is_bot BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS online_users (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      username TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL DEFAULT '',
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_type TEXT NOT NULL DEFAULT 'free';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_until TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_reason TEXT NOT NULL DEFAULT '';

    CREATE TABLE IF NOT EXISTS payments (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_months INTEGER NOT NULL CHECK (plan_months IN (1,3)),
      amount INTEGER NOT NULL,
      method TEXT NOT NULL,
      transaction_id TEXT NOT NULL UNIQUE,
      screenshot BYTEA,
      screenshot_mime TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      admin_note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

    ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key_prefix TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key_created_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS api_enabled BOOLEAN NOT NULL DEFAULT FALSE;

    ALTER TABLE links ADD COLUMN IF NOT EXISTS password_hash TEXT;
    ALTER TABLE links ADD COLUMN IF NOT EXISTS password_enabled BOOLEAN NOT NULL DEFAULT FALSE;

    CREATE TABLE IF NOT EXISTS notifications (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'info',
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id BIGSERIAL PRIMARY KEY,
      admin_email TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      target_type TEXT NOT NULL DEFAULT '',
      target_id TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL DEFAULT '',
      ip_address TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS domain_settings (
      domain TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      maintenance BOOLEAN NOT NULL DEFAULT FALSE,
      last_health TEXT NOT NULL DEFAULT 'unknown',
      last_checked_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS app_backups (
      id BIGSERIAL PRIMARY KEY,
      backup_data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by TEXT NOT NULL DEFAULT 'automatic'
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id BIGSERIAL PRIMARY KEY,
      message TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_backups_created ON app_backups(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(is_active, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_links_user_id ON links(user_id);
    CREATE INDEX IF NOT EXISTS idx_links_domain_code ON links(selected_domain, short_code);
    CREATE INDEX IF NOT EXISTS idx_clicks_user_id ON clicks(user_id);
    CREATE INDEX IF NOT EXISTS idx_clicks_link_id ON clicks(link_id);
    CREATE INDEX IF NOT EXISTS idx_clicks_created_at ON clicks(created_at);
    CREATE INDEX IF NOT EXISTS idx_online_last_seen ON online_users(last_seen);
  `);
  for (const domain of AVAILABLE_DOMAINS) {
    await pool.query(`INSERT INTO domain_settings(domain,enabled,maintenance)
      VALUES($1,TRUE,FALSE) ON CONFLICT(domain) DO NOTHING`, [normalizeHost(domain)]);
  }
  console.log('✅ Full app database tables ready: users, links, clicks, online_users, payments, api, notifications, audit, domains, backups');
}

function toIso(v) { return v ? new Date(v).toISOString() : null; }
function mapUser(r) {
  if (!r) return null;
  return {
    id: Number(r.id), telegramId: r.telegram_id, username: r.username,
    firstName: r.first_name, lastName: r.last_name, displayName: r.display_name,
    email: r.email, profilePhoto: r.profile_photo, timezone: r.timezone,
    accountStatus: r.account_status, createdAt: toIso(r.created_at), lastLogin: toIso(r.last_login),
    totalLinks: Number(r.total_links || 0), totalClicks: Number(r.total_clicks || 0), isAdmin: !!r.is_admin,
    planType: r.plan_type || 'free', premiumUntil: toIso(r.premium_until), blockedReason: r.blocked_reason || '',
    isPremium: (r.plan_type === 'premium' && r.premium_until && new Date(r.premium_until) > new Date()),
    apiEnabled: !!r.api_enabled, apiKeyPrefix: r.api_key_prefix || '', apiKeyCreatedAt: toIso(r.api_key_created_at)
  };
}
function mapLink(r) {
  if (!r) return null;
  return {
    id: Number(r.id), userId: Number(r.user_id), selectedDomain: r.selected_domain,
    originalUrl: r.original_url, shortCode: r.short_code, customSlug: r.custom_slug,
    title: r.title || '', clicks: Number(r.clicks || 0), isActive: !!r.is_active,
    isExpired: !!r.is_expired, expiresAt: toIso(r.expires_at), createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at),
    passwordEnabled: !!r.password_enabled
  };
}
function mapClick(r) {
  return {
    id: Number(r.id), linkId: Number(r.link_id), userId: Number(r.user_id), ipAddress: r.ip_address,
    userAgent: r.user_agent, device: r.device, browser: r.browser, os: r.os,
    country: r.country, countryCode: r.country_code, city: r.city, region: r.region,
    referrer: r.referrer, isBot: !!r.is_bot, createdAt: toIso(r.created_at)
  };
}
function mapOnline(r) {
  return { id: Number(r.user_id), username: r.username, displayName: r.display_name, lastSeen: new Date(r.last_seen).getTime() };
}

async function migrateLegacyJsonIfPossible() {
  const legacyPath = path.join(__dirname, 'data.json');
  if (!fs.existsSync(legacyPath)) return;
  try {
    const count = await pool.query('SELECT COUNT(*)::int AS count FROM users');
    if (Number(count.rows[0].count) > 0) return;
    const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    if (!legacy || !Array.isArray(legacy.users) || legacy.users.length === 0) return;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const u of legacy.users) {
        await client.query(`INSERT INTO users
          (id, telegram_id, username, first_name, last_name, display_name, email, profile_photo, timezone, account_status, created_at, last_login, total_links, total_clicks, is_admin)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (telegram_id) DO NOTHING`,
          [u.id, String(u.telegramId || u.id), u.username||'', u.firstName||'', u.lastName||'', u.displayName||'', u.email||'', u.profilePhoto||'', u.timezone||'Asia/Dhaka', u.accountStatus||'active', u.createdAt||new Date(), u.lastLogin||new Date(), u.totalLinks||0, u.totalClicks||0, !!u.isAdmin]);
      }
      for (const l of (legacy.links || [])) {
        await client.query(`INSERT INTO links
          (id,user_id,selected_domain,original_url,short_code,custom_slug,title,clicks,is_active,is_expired,expires_at,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
          [l.id,l.userId,normalizeHost(l.selectedDomain||BASE_HOST),l.originalUrl,l.shortCode,l.customSlug||null,l.title||'',l.clicks||0,l.isActive!==false,!!l.isExpired,l.expiresAt||null,l.createdAt||new Date(),l.updatedAt||new Date()]);
      }
      for (const c of (legacy.clicks || [])) {
        await client.query(`INSERT INTO clicks
          (id,link_id,user_id,ip_address,user_agent,device,browser,os,country,country_code,city,region,referrer,is_bot,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING`,
          [c.id,c.linkId,c.userId,c.ipAddress||'',c.userAgent||'',c.device||'Unknown',c.browser||'Unknown',c.os||'Unknown',c.country||'Unknown',c.countryCode||'XX',c.city||'',c.region||'',c.referrer||'',!!c.isBot,c.createdAt||new Date()]);
      }
      await client.query("SELECT setval(pg_get_serial_sequence('users','id'), COALESCE((SELECT MAX(id) FROM users),1), true)");
      await client.query("SELECT setval(pg_get_serial_sequence('links','id'), COALESCE((SELECT MAX(id) FROM links),1), true)");
      await client.query("SELECT setval(pg_get_serial_sequence('clicks','id'), COALESCE((SELECT MAX(id) FROM clicks),1), true)");
      await client.query('COMMIT');
      console.log(`✅ Legacy data.json migrated to PostgreSQL (${legacy.users.length} users)`);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('Legacy migration skipped/failed:', e.message);
    } finally { client.release(); }
  } catch (e) { console.error('Legacy migration check failed:', e.message); }
}

// ===== COUNTRY DATA =====
// Keep the familiar country names/flags from the previous version, but also
// support any ISO-3166 alpha-2 code returned by geoip-lite.
const knownCountries = {
  BD:{name:'Bangladesh',flag:'🇧🇩'},IN:{name:'India',flag:'🇮🇳'},US:{name:'United States',flag:'🇺🇸'},GB:{name:'United Kingdom',flag:'🇬🇧'},DE:{name:'Germany',flag:'🇩🇪'},FR:{name:'France',flag:'🇫🇷'},JP:{name:'Japan',flag:'🇯🇵'},CN:{name:'China',flag:'🇨🇳'},AU:{name:'Australia',flag:'🇦🇺'},CA:{name:'Canada',flag:'🇨🇦'},BR:{name:'Brazil',flag:'🇧🇷'},NG:{name:'Nigeria',flag:'🇳🇬'},PK:{name:'Pakistan',flag:'🇵🇰'},SA:{name:'Saudi Arabia',flag:'🇸🇦'},AE:{name:'UAE',flag:'🇦🇪'},SG:{name:'Singapore',flag:'🇸🇬'},RU:{name:'Russia',flag:'🇷🇺'},TR:{name:'Turkey',flag:'🇹🇷'},MX:{name:'Mexico',flag:'🇲🇽'},AR:{name:'Argentina',flag:'🇦🇷'},EG:{name:'Egypt',flag:'🇪🇬'},ID:{name:'Indonesia',flag:'🇮🇩'},KR:{name:'South Korea',flag:'🇰🇷'},IT:{name:'Italy',flag:'🇮🇹'},ES:{name:'Spain',flag:'🇪🇸'},ZA:{name:'South Africa',flag:'🇿🇦'},MY:{name:'Malaysia',flag:'🇲🇾'},PH:{name:'Philippines',flag:'🇵🇭'},VN:{name:'Vietnam',flag:'🇻🇳'},TH:{name:'Thailand',flag:'🇹🇭'},NL:{name:'Netherlands',flag:'🇳🇱'},SE:{name:'Sweden',flag:'🇸🇪'},NO:{name:'Norway',flag:'🇳🇴'},DK:{name:'Denmark',flag:'🇩🇰'},FI:{name:'Finland',flag:'🇫🇮'},PL:{name:'Poland',flag:'🇵🇱'},UA:{name:'Ukraine',flag:'🇺🇦'},RO:{name:'Romania',flag:'🇷🇴'},GR:{name:'Greece',flag:'🇬🇷'},PT:{name:'Portugal',flag:'🇵🇹'},BE:{name:'Belgium',flag:'🇧🇪'},CH:{name:'Switzerland',flag:'🇨🇭'},AT:{name:'Austria',flag:'🇦🇹'},HU:{name:'Hungary',flag:'🇭🇺'},CZ:{name:'Czech Republic',flag:'🇨🇿'},IE:{name:'Ireland',flag:'🇮🇪'},NZ:{name:'New Zealand',flag:'🇳🇿'},CL:{name:'Chile',flag:'🇨🇱'},CO:{name:'Colombia',flag:'🇨🇴'},PE:{name:'Peru',flag:'🇵🇪'},VE:{name:'Venezuela',flag:'🇻🇪'}
};

function countryFlag(code) {
  const c = String(code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '🌐';
  return String.fromCodePoint(...[...c].map(ch => 127397 + ch.charCodeAt(0)));
}

let regionNames = null;
try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (_) {}

function countryInfo(code) {
  const c = String(code || 'XX').toUpperCase();
  if (knownCountries[c]) return knownCountries[c];
  let name = c === 'XX' ? 'Unknown' : c;
  try { if (regionNames && c !== 'XX') name = regionNames.of(c) || c; } catch (_) {}
  return { name, flag: c === 'XX' ? '🌐' : countryFlag(c) };
}

const countries = new Proxy(knownCountries, {
  get(target, prop) {
    if (typeof prop !== 'string') return target[prop];
    return target[prop] || countryInfo(prop);
  }
});

function generateShortCode() {
  const chars='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code=''; for(let i=0;i<6;i++) code += chars.charAt(Math.floor(Math.random()*chars.length));
  return code;
}
function isBot(ua){ return /bot|crawler|spider|scraper|facebook|twitter|linkedin|pinterest|slack|discord|whatsapp|telegram|instagram/i.test(ua||''); }
function isSocialPreviewBot(ua){ return /facebookexternalhit|facebot|twitterbot|linkedinbot|whatsapp|telegrambot|discordbot|slackbot|pinterest|skypeuripreview/i.test(ua||''); }
function getDeviceInfo(ua='') {
  let device='Desktop',browser='Unknown',os='Unknown';
  if (/Tablet|iPad/i.test(ua)) device='Tablet'; else if (/Mobile|Android|iPhone/i.test(ua)) device='Mobile';
  if (ua.includes('Chrome')&&!ua.includes('Edg')) browser='Chrome'; else if(ua.includes('Firefox')) browser='Firefox'; else if(ua.includes('Safari')&&!ua.includes('Chrome')) browser='Safari'; else if(ua.includes('Edg')) browser='Edge'; else if(ua.includes('Opera')) browser='Opera';
  if(ua.includes('Windows')) os='Windows'; else if(ua.includes('Mac OS')) os='macOS'; else if(ua.includes('Android')) os='Android'; else if(/iPhone|iPad/.test(ua)) os='iOS'; else if(ua.includes('Linux')) os='Linux';
  return {device,browser,os};
}
function normalizeClientIp(ip) {
  let value = String(ip || '').trim();
  // Railway/Express can expose IPv4 as IPv4-mapped IPv6.
  if (value.startsWith('::ffff:')) value = value.slice(7);
  // If a comma-separated forwarded chain ever reaches here, use the first IP.
  if (value.includes(',')) value = value.split(',')[0].trim();
  // Remove brackets around IPv6 literals.
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  return value;
}
function normalizeHost(host){ return String(host||'').split(':')[0].toLowerCase().replace(/^www\./,''); }
function domainOrigin(domain){ const clean=normalizeHost(domain); return clean===normalizeHost(BASE_HOST)?BASE_URL:`https://${clean}`; }
function getBaseUrl(req){ const host=normalizeHost(req.get('host')); return AVAILABLE_DOMAINS.map(normalizeHost).includes(host)?domainOrigin(host):BASE_URL; }
function buildShortUrl(link){ return `${domainOrigin(normalizeHost(link.selectedDomain||BASE_HOST))}/${link.shortCode}`; }
function escapeHtml(v){ return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }

function sha256(v){ return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function makeApiKey(){ return 'tpib_live_' + crypto.randomBytes(24).toString('hex'); }
function hashLinkPassword(password){
  const salt=crypto.randomBytes(16).toString('hex');
  const hash=crypto.scryptSync(String(password),salt,64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyLinkPassword(password,stored){
  try{
    const [salt,expected]=String(stored||'').split(':');
    if(!salt||!expected)return false;
    const actual=crypto.scryptSync(String(password),salt,64);
    const exp=Buffer.from(expected,'hex');
    return exp.length===actual.length && crypto.timingSafeEqual(exp,actual);
  }catch(e){ return false; }
}
function isPrivateHostname(host){
  const h=String(host||'').toLowerCase();
  return h==='localhost'||h==='127.0.0.1'||h==='0.0.0.0'||h==='::1'||
    /^10\./.test(h)||/^192\.168\./.test(h)||/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)||
    h.endsWith('.local')||h.endsWith('.internal');
}
function validateDestinationUrl(raw){
  try{
    const u=new URL(String(raw||''));
    if(!['http:','https:'].includes(u.protocol)) return 'Only http:// or https:// links are allowed.';
    const host=normalizeHost(u.hostname);
    if(!host) return 'Invalid destination host.';
    if(isPrivateHostname(host)) return 'Private/local network URLs are not allowed.';
    if(AVAILABLE_DOMAINS.map(normalizeHost).includes(host)) return 'Shortener domains cannot be used as destination URLs.';
    if(BLOCKED_DOMAINS.includes(host) || BLOCKED_DOMAINS.some(d=>host.endsWith('.'+d))) return 'This destination domain is blocked by the administrator.';
    if(String(raw).length>4096) return 'Destination URL is too long.';
    return null;
  }catch(e){ return 'Invalid URL format.'; }
}
async function notifyUser(userId,title,message,type='info'){
  await pool.query('INSERT INTO notifications(user_id,title,message,type) VALUES($1,$2,$3,$4)',
    [userId,String(title).slice(0,160),String(message).slice(0,2000),String(type).slice(0,30)]);
}
async function auditAdmin(req,action,targetType='',targetId='',details=''){
  try{
    await pool.query(`INSERT INTO admin_audit_logs(admin_email,action,target_type,target_id,details,ip_address)
      VALUES($1,$2,$3,$4,$5,$6)`,
      [ADMIN_EMAIL,String(action),String(targetType),String(targetId),String(details).slice(0,4000),normalizeClientIp(req.ip||'')]);
  }catch(e){ console.error('Audit log error:',e.message); }
}
async function getEnabledDomains(){
  const q=await pool.query('SELECT domain FROM domain_settings WHERE enabled=TRUE AND maintenance=FALSE ORDER BY domain=$1 DESC, domain ASC',[normalizeHost(BASE_HOST)]);
  const list=q.rows.map(r=>normalizeHost(r.domain)).filter(d=>AVAILABLE_DOMAINS.map(normalizeHost).includes(d));
  return list.length ? list : [normalizeHost(BASE_HOST)];
}
async function getDomainChoices(){
  const q=await pool.query('SELECT domain,enabled,maintenance,last_health FROM domain_settings ORDER BY domain=$1 DESC,domain ASC',[normalizeHost(BASE_HOST)]);
  const configured=new Set(AVAILABLE_DOMAINS.map(normalizeHost));
  return q.rows.filter(r=>configured.has(normalizeHost(r.domain))).map(r=>({
    domain:normalizeHost(r.domain),enabled:!!r.enabled,maintenance:!!r.maintenance,lastHealth:r.last_health||'unknown',
    selectable:!!r.enabled && !r.maintenance
  }));
}
async function isDomainEnabled(domain){
  const d=normalizeHost(domain);
  const q=await pool.query('SELECT enabled,maintenance FROM domain_settings WHERE domain=$1',[d]);
  return q.rowCount ? (!!q.rows[0].enabled && !q.rows[0].maintenance) : d===normalizeHost(BASE_HOST);
}
async function authenticateApiKey(req,res,next){
  try{
    const raw=String(req.get('x-api-key')||req.get('authorization')||'').replace(/^Bearer\s+/i,'').trim();
    if(!raw) return res.status(401).json({error:'API key required'});
    const hash=sha256(raw);
    const q=await pool.query('SELECT * FROM users WHERE api_key_hash=$1 AND api_enabled=TRUE LIMIT 1',[hash]);
    if(!q.rowCount) return res.status(401).json({error:'Invalid or revoked API key'});
    const user=mapUser(q.rows[0]);
    if(user.accountStatus==='blocked') return res.status(403).json({error:'Account blocked'});
    if(!user.isPremium) return res.status(403).json({error:'Premium plan required for API access'});
    req.apiUser=user;
    next();
  }catch(e){ console.error('API auth error:',e); res.status(500).json({error:'API authentication error'}); }
}
async function createBackupSnapshot(createdBy='automatic'){
  const [users,links,clicks,payments,domains,notifications]=await Promise.all([
    pool.query(`SELECT id,telegram_id,username,first_name,last_name,display_name,email,timezone,account_status,created_at,last_login,total_links,total_clicks,is_admin,plan_type,premium_until,api_enabled,api_key_prefix FROM users ORDER BY id`),
    pool.query('SELECT * FROM links ORDER BY id'),
    pool.query('SELECT * FROM clicks ORDER BY id DESC LIMIT 100000'),
    pool.query(`SELECT id,user_id,plan_months,amount,method,transaction_id,status,admin_note,created_at,reviewed_at FROM payments ORDER BY id`),
    pool.query('SELECT * FROM domain_settings ORDER BY domain'),
    pool.query('SELECT * FROM notifications ORDER BY id DESC LIMIT 10000')
  ]);
  const payload={version:'6.6',createdAt:new Date().toISOString(),users:users.rows,links:links.rows,clicks:clicks.rows,payments:payments.rows,domains:domains.rows,notifications:notifications.rows};
  await pool.query('INSERT INTO app_backups(backup_data,created_by) VALUES($1::jsonb,$2)',[JSON.stringify(payload),createdBy]);
  await pool.query(`DELETE FROM app_backups WHERE id NOT IN (SELECT id FROM app_backups ORDER BY created_at DESC LIMIT 7)`);
  return payload;
}
async function getActiveAnnouncement(){
  try{
    const q=await pool.query("SELECT id,message,updated_at FROM announcements WHERE is_active=TRUE ORDER BY updated_at DESC,id DESC LIMIT 1");
    return q.rowCount?q.rows[0]:null;
  }catch(e){ console.error('Announcement load error:',e.message); return null; }
}
async function maybeCreateAutomaticBackup(){
  try{
    const q=await pool.query("SELECT created_at FROM app_backups WHERE created_by='automatic' ORDER BY created_at DESC LIMIT 1");
    const last=q.rowCount?new Date(q.rows[0].created_at).getTime():0;
    if(!last || Date.now()-last >= AUTO_BACKUP_HOURS*3600000) {
      await createBackupSnapshot('automatic');
      console.log('✅ Automatic app snapshot created');
    }
  }catch(e){ console.error('Automatic backup error:',e.message); }
}
function renderSocialPreview(req,res,link){
  const shortUrl=buildShortUrl(link), host=normalizeHost(link.selectedDomain||req.get('host')||BASE_HOST), title=host, description=PREVIEW_DESCRIPTION;
  res.set('Cache-Control','public, max-age=300');
  return res.status(200).type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><link rel="canonical" href="${escapeHtml(shortUrl)}"><meta property="og:type" content="website"><meta property="og:site_name" content="${escapeHtml(title)}"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(shortUrl)}"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}"></head><body></body></html>`);
}

async function getUserById(id){ const r=await pool.query('SELECT * FROM users WHERE id=$1',[id]); return mapUser(r.rows[0]); }
async function getAdminState(req) {
  if (req.session?.admin === true) return true;
  if (req.session?.user?.id) {
    const u = await getUserById(req.session.user.id);
    return !!u?.isAdmin;
  }
  return false;
}
async function adminMiddleware(req,res,next){
  try {
    if (await getAdminState(req)) return next();
    return res.redirect('/admin/login');
  } catch(e) {
    console.error('Admin auth error:', e);
    return res.redirect('/admin/login?error=' + encodeURIComponent('Admin authentication failed'));
  }
}
function expectedPlanAmount(months){ return Number(months) === 3 ? PLAN_3_PRICE : PLAN_1_PRICE; }
function paymentConfig(){ return {
  bkashNumber:BKASH_NUMBER, nagadNumber:NAGAD_NUMBER, binanceId:BINANCE_ID,
  bkashConfigured:!!BKASH_NUMBER, nagadConfigured:!!NAGAD_NUMBER, binanceConfigured:!!BINANCE_ID
}; }

async function getActiveOnlineUsers(){
  await pool.query("DELETE FROM online_users WHERE last_seen < NOW() - INTERVAL '5 minutes'");
  const r=await pool.query('SELECT * FROM online_users ORDER BY last_seen DESC'); return r.rows.map(mapOnline);
}
async function markOnline(user){
  if(!user) return;
  await pool.query(`INSERT INTO online_users(user_id,username,display_name,last_seen) VALUES($1,$2,$3,NOW())
    ON CONFLICT(user_id) DO UPDATE SET username=EXCLUDED.username, display_name=EXCLUDED.display_name, last_seen=NOW()`,[user.id,user.username||'',user.displayName||'']);
}

async function authMiddleware(req,res,next){
  try {
    if(req.session?.user?.id){
      const user=await getUserById(req.session.user.id);
      if(user){
        if (user.accountStatus === 'blocked') {
          delete req.session.user;
          return req.session.save(() => res.redirect('/login?error=' + encodeURIComponent('Your account is blocked. Contact admin.')));
        }
        req.user=user;
        return next();
      }

      // Session may survive a deploy even when the old user row no longer exists.
      // Clear that stale user session before redirecting to login.
      delete req.session.user;
      if(req.originalUrl!=='/login') req.session.returnTo=req.originalUrl;
      return req.session.save((err)=>{
        if(err) console.error('Stale session save error:',err);
        res.redirect('/login');
      });
    }

    if(req.originalUrl!=='/login') req.session.returnTo=req.originalUrl;
    return res.redirect('/login');
  } catch(e){
    console.error('Auth error:',e);
    return res.redirect('/login?error='+encodeURIComponent('Database connection error'));
  }
}

// ===== ONLINE HEARTBEAT =====
// Never write to online_users until the referenced user is confirmed to exist.
// This prevents foreign-key errors from stale PostgreSQL sessions after migration/redeploy.
app.use(async (req,res,next)=>{
  if(!req.session?.user?.id) return next();

  try {
    const user=await getUserById(req.session.user.id);

    if(!user){
      console.warn(`⚠️ Stale session cleared for missing user id ${req.session.user.id}`);
      delete req.session.user;
      return req.session.save((err)=>{
        if(err) console.error('Stale session cleanup error:',err);
        next();
      });
    }

    await markOnline(user);
  } catch(e){
    console.error('Online heartbeat error:',e.message);
  }

  next();
});

// ===== HOME =====
app.get('/', async (req,res)=>{
  try {
    const [activeUsers,totalR,recentR] = await Promise.all([
      getActiveOnlineUsers(), pool.query('SELECT COUNT(*)::int AS count FROM users'),
      pool.query('SELECT * FROM users ORDER BY created_at DESC LIMIT 30')
    ]);
    const loggedUser=req.session?.user?.id?await getUserById(req.session.user.id):null;
    res.render('index',{page:'home',user:loggedUser,onlineUsers:activeUsers.length,onlineUserList:activeUsers.map(u=>({name:u.displayName||u.username||'User'})),totalUsers:Number(totalR.rows[0].count),registeredUserList:recentR.rows.map(mapUser).map(u=>({name:u.displayName||[u.firstName,u.lastName].filter(Boolean).join(' ')||u.username||'User',username:u.username||''})),countries,error:req.query.error||null,success:req.query.success||null,info:null,shortUrl:null,customDomains:CUSTOM_DOMAINS,availableDomains:AVAILABLE_DOMAINS,baseDomain:BASE_HOST,baseUrl:BASE_URL});
  }catch(e){ console.error('Home error:',e); res.status(500).send('Database error: '+e.message); }
});

// ===== LOGIN =====
app.get('/login',async(req,res)=>{
  try {
    if(req.session?.user?.id){ const u=await getUserById(req.session.user.id); if(u) return res.redirect('/dashboard'); }
    const [activeUsers,totalR]=await Promise.all([getActiveOnlineUsers(),pool.query('SELECT COUNT(*)::int AS count FROM users')]);
    res.render('index',{page:'login',user:null,onlineUsers:activeUsers.length,onlineUserList:activeUsers.map(u=>({name:u.displayName||u.username||'User'})),countries,error:req.query.error||null,success:req.query.success||null,info:null,shortUrl:req.query.shortUrl||null,totalUsers:Number(totalR.rows[0].count),customDomains:CUSTOM_DOMAINS,availableDomains:AVAILABLE_DOMAINS,baseDomain:BASE_HOST,baseUrl:getBaseUrl(req)});
  }catch(e){ console.error('Login page error:',e); res.status(500).send('Login page error: '+e.message); }
});

app.post('/login',async(req,res)=>{
  try {
    const {telegramId,username,firstName,lastName,email,timezone}=req.body;
    if(!telegramId||!username||!firstName) return res.redirect('/login?error='+encodeURIComponent('Please fill in all required fields'));
    const displayName=firstName+(lastName?' '+lastName:'');
    const q=await pool.query(`INSERT INTO users(telegram_id,username,first_name,last_name,display_name,email,timezone,last_login)
      VALUES($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username,first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,display_name=EXCLUDED.display_name,email=CASE WHEN EXCLUDED.email<>'' THEN EXCLUDED.email ELSE users.email END,timezone=EXCLUDED.timezone,last_login=NOW()
      RETURNING *`,[String(telegramId),String(username),String(firstName),String(lastName||''),displayName,String(email||''),String(timezone||'Asia/Dhaka')]);
    let user=mapUser(q.rows[0]);
    if (ADMIN_EMAIL && String(user.email || '').toLowerCase() === ADMIN_EMAIL && !user.isAdmin) {
      const adminRow = await pool.query('UPDATE users SET is_admin=TRUE WHERE id=$1 RETURNING *',[user.id]);
      user = mapUser(adminRow.rows[0]);
    }
    if (user.accountStatus === 'blocked') return res.redirect('/login?error=' + encodeURIComponent('Your account is blocked. Contact admin.'));
    await markOnline(user);
    req.session.user={id:user.id,telegramId:user.telegramId,username:user.username,displayName:user.displayName,firstName:user.firstName,email:user.email,profilePhoto:user.profilePhoto,timezone:user.timezone,isAdmin:user.isAdmin};
    const requested=req.session.returnTo; const returnTo=requested&&requested!=='/login'&&requested.startsWith('/')?requested:'/dashboard'; delete req.session.returnTo;
    return req.session.save(err=>{ if(err){console.error('Session save error:',err);return res.redirect('/login?error='+encodeURIComponent('Could not save login session'));} res.redirect(returnTo); });
  }catch(e){ console.error('Login error:',e); res.redirect('/login?error='+encodeURIComponent('Login failed: '+e.message)); }
});

app.post('/logout',async(req,res)=>{
  try { if(req.session?.user?.id) await pool.query('DELETE FROM online_users WHERE user_id=$1',[req.session.user.id]); } catch(e){}
  req.session.destroy(()=>res.redirect('/'));
});

// ===== DASHBOARD =====
app.get('/dashboard',authMiddleware,async(req,res)=>{
  try {
    const freshUser=await getUserById(req.user.id);
    const linkR=await pool.query('SELECT * FROM links WHERE user_id=$1 ORDER BY created_at DESC',[req.user.id]);
    const links=linkR.rows.map(mapLink).map(l=>({...l,shortUrl:buildShortUrl(l)}));
    const linkUsage=links.length;
    const linksRemaining=freshUser.isPremium?null:Math.max(0,FREE_LINK_LIMIT-linkUsage);
    const clickR=await pool.query('SELECT * FROM clicks WHERE user_id=$1 ORDER BY created_at DESC',[req.user.id]);
    const clicks=clickR.rows.map(mapClick);
    let totalClicks=0,todayClicks=0,yesterdayClicks=0,weekClicks=0,monthClicks=0,yearClicks=0,botClicks=0;
    const now=new Date(),today=new Date(now);today.setHours(0,0,0,0);
    const yesterday=new Date(today);yesterday.setDate(yesterday.getDate()-1);
    const weekAgo=new Date(today);weekAgo.setDate(weekAgo.getDate()-7);
    const monthAgo=new Date(today);monthAgo.setDate(monthAgo.getDate()-30);
    const yearStart=new Date(today.getFullYear(),0,1);
    const countryMap={},deviceMap={},referrerMap={},browserMap={},uniqueIps=new Set(),weekData=[0,0,0,0,0,0,0];

    // V7.6 graph series: exact last 7 calendar days. Existing weekData remains unchanged.
    const chartDays=[];
    for(let i=6;i>=0;i--){
      const cd=new Date(today);
      cd.setDate(cd.getDate()-i);
      const key=`${cd.getFullYear()}-${String(cd.getMonth()+1).padStart(2,'0')}-${String(cd.getDate()).padStart(2,'0')}`;
      chartDays.push({
        key,
        date: cd.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}),
        day: cd.toLocaleDateString('en-US',{weekday:'long'}),
        clicks:0
      });
    }
    const chartDayMap=new Map(chartDays.map((d,i)=>[d.key,i]));

    for(const click of clicks){
      if(click.isBot){botClicks++;continue;} totalClicks++; const d=new Date(click.createdAt);
      if(click.ipAddress) uniqueIps.add(click.ipAddress);
      const clickKey=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      if(chartDayMap.has(clickKey)) chartDays[chartDayMap.get(clickKey)].clicks++;
      if(d>=today)todayClicks++; else if(d>=yesterday && d<today)yesterdayClicks++;
      if(d>=weekAgo){weekClicks++;const di=d.getDay(),ai=di===0?6:di-1;weekData[ai]++;}
      if(d>=monthAgo)monthClicks++; if(d>=yearStart)yearClicks++;
      const rf=click.referrer||'Direct'; referrerMap[rf]=(referrerMap[rf]||0)+1;
      const br=click.browser||'Unknown'; browserMap[br]=(browserMap[br]||0)+1;
      const cc=click.countryCode||'XX';countryMap[cc]=(countryMap[cc]||0)+1; const dk=(click.device||'Unknown')+'|'+(click.browser||'Unknown')+'|'+(click.os||'Unknown'); if(!deviceMap[dk])deviceMap[dk]={device:click.device,browser:click.browser,os:click.os,count:0};deviceMap[dk].count++;
    }
    const realClicks=totalClicks,clickRate=(totalClicks+botClicks)>0?Math.round(totalClicks/(totalClicks+botClicks)*100):0;
    const countryStats=Object.entries(countryMap).map(([countryCode,count])=>({countryCode,count})).sort((a,b)=>b.count-a.count).slice(0,15);
    const deviceStats=Object.values(deviceMap).sort((a,b)=>b.count-a.count).slice(0,20);
    const topReferrers=Object.entries(referrerMap).map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count).slice(0,8);
    const browserStats=Object.entries(browserMap).map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count).slice(0,8);
    const uniqueClicks=uniqueIps.size;
    const activeUsers=await getActiveOnlineUsers();
    const domainChoices=await getDomainChoices();
    const dashboardDomains=domainChoices.filter(d=>d.selectable).map(d=>d.domain);
    res.render('index',{page:'dashboard',user:freshUser,links,totalClicks,todayClicks,yesterdayClicks,weekClicks,monthClicks,yearClicks,uniqueClicks,topReferrers,browserStats,botClicks,realClicks,clickRate,onlineUsers:activeUsers.length,countryStats,deviceStats,weekData,chartDays,countries,onlineUserList:activeUsers.map(u=>({name:u.displayName||u.username||'User'})),freeLinkLimit:FREE_LINK_LIMIT,linkUsage,linksRemaining,error:req.query.error||null,success:req.query.success||null,info:null,shortUrl:null,customDomains:dashboardDomains.filter(d=>d!==normalizeHost(BASE_HOST)),availableDomains:dashboardDomains,domainChoices,baseDomain:BASE_HOST,baseUrl:getBaseUrl(req)});
  }catch(e){ console.error('Dashboard error:',e); res.redirect('/?error='+encodeURIComponent('Dashboard database error')); }
});

// ===== MY LINKS PAGE =====
app.get('/my-links',authMiddleware,async(req,res)=>{
  try{
    const freshUser=await getUserById(req.user.id);
    const r=await pool.query('SELECT * FROM links WHERE user_id=$1 ORDER BY created_at DESC',[req.user.id]);
    const links=r.rows.map(mapLink).map(l=>({...l,shortUrl:buildShortUrl(l)}));
    const active=await getActiveOnlineUsers();
    const domainChoices=await getDomainChoices();
    const enabledDomains=domainChoices.filter(d=>d.selectable).map(d=>d.domain);
    res.render('index',{page:'my-links',user:freshUser,links,onlineUsers:active.length,onlineUserList:active.map(u=>({name:u.displayName||u.username||'User'})),countries,error:req.query.error||null,success:req.query.success||null,info:null,shortUrl:null,customDomains:enabledDomains.filter(d=>d!==normalizeHost(BASE_HOST)),availableDomains:enabledDomains,domainChoices,baseDomain:BASE_HOST,baseUrl:BASE_URL});
  }catch(e){console.error('My links page error:',e);res.redirect('/dashboard?error='+encodeURIComponent('Could not load your short links.'));}
});

// ===== SHORT LINK PAGE =====
app.get('/shorten-page',authMiddleware,async(req,res)=>{
  try {
    const r=await pool.query('SELECT * FROM links WHERE user_id=$1 ORDER BY created_at DESC LIMIT 12',[req.user.id]);
    const links=r.rows.map(mapLink).map(l=>({...l,shortUrl:buildShortUrl(l)})); const active=await getActiveOnlineUsers();
    const domainChoices=await getDomainChoices();
    const enabledDomains=domainChoices.filter(d=>d.selectable).map(d=>d.domain), enabledCustom=enabledDomains.filter(d=>d!==normalizeHost(BASE_HOST));
    res.render('index',{page:'shorten',user:req.user,links,onlineUsers:active.length,onlineUserList:active.map(u=>({name:u.displayName||u.username||'User'})),countries,error:req.query.error||null,success:req.query.success||null,info:null,shortUrl:req.query.shortUrl||null,customDomains:enabledCustom,availableDomains:enabledDomains,domainChoices,baseDomain:BASE_HOST,baseUrl:BASE_URL});
  }catch(e){console.error('Shorten page error:',e);res.redirect('/dashboard?error='+encodeURIComponent('Could not open short link page'));}
});

app.post('/shorten',authMiddleware,async(req,res)=>{
  try {
    const {originalUrl,customSlug,expiresIn,domain,linkPassword}=req.body;
    const requestedDomain=normalizeHost(domain||BASE_HOST);
    const enabledDomains=await getEnabledDomains();
    const selectedDomain=enabledDomains.map(normalizeHost).includes(requestedDomain)?requestedDomain:normalizeHost(BASE_HOST);
    if(!(await isDomainEnabled(selectedDomain))) return res.redirect('/shorten-page?error='+encodeURIComponent('Selected domain is currently disabled or under maintenance.'));
    const freshUser = await getUserById(req.user.id);
    if (!freshUser.isPremium) {
      const countR = await pool.query('SELECT COUNT(*)::int AS count FROM links WHERE user_id=$1',[req.user.id]);
      if (Number(countR.rows[0].count) >= FREE_LINK_LIMIT) {
        return res.redirect('/plans?error=' + encodeURIComponent(`Free plan limit reached (${FREE_LINK_LIMIT} links). Upgrade to Premium for unlimited links.`));
      }
    }
    if(!originalUrl)return res.redirect('/shorten-page?error='+encodeURIComponent('Please enter a URL'));
    const unsafe=validateDestinationUrl(originalUrl);
    if(unsafe)return res.redirect('/shorten-page?error='+encodeURIComponent(unsafe));
    let shortCode=String(customSlug||'').trim();
    if(shortCode){
      if(!/^[A-Za-z0-9_-]{2,80}$/.test(shortCode))return res.redirect('/shorten-page?error='+encodeURIComponent('Custom slug may use letters, numbers, - and _ only'));
      const ex=await pool.query('SELECT 1 FROM links WHERE selected_domain=$1 AND short_code=$2',[selectedDomain,shortCode]);
      if(ex.rowCount)return res.redirect('/shorten-page?error='+encodeURIComponent('Custom slug already taken on this domain'));
    } else {
      for(let i=0;i<12;i++){const c=generateShortCode();const ex=await pool.query('SELECT 1 FROM links WHERE selected_domain=$1 AND short_code=$2',[selectedDomain,c]);if(!ex.rowCount){shortCode=c;break;}}
      if(!shortCode)throw new Error('Could not generate unique short code');
    }
    let expiresAt=null;if(expiresIn){const days=parseInt(expiresIn);if(!isNaN(days))expiresAt=new Date(Date.now()+days*86400000);}
    const passwordEnabled=!!String(linkPassword||'').trim();
    if(passwordEnabled && !freshUser.isPremium) return res.redirect('/plans?error='+encodeURIComponent('Password-protected links are a Premium feature.'));
    const passwordHash=passwordEnabled?hashLinkPassword(linkPassword):null;
    const q=await pool.query(`INSERT INTO links(user_id,selected_domain,original_url,short_code,custom_slug,expires_at,password_hash,password_enabled)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id,selectedDomain,originalUrl,shortCode,customSlug||null,expiresAt,passwordHash,passwordEnabled]);
    await pool.query('UPDATE users SET total_links=total_links+1 WHERE id=$1',[req.user.id]);
    const link=mapLink(q.rows[0]); const shortUrl=buildShortUrl(link);
    await notifyUser(req.user.id,'Short link created',`${shortUrl} was created successfully.`,'success');
    res.redirect('/shorten-page?success='+encodeURIComponent('Link created successfully!')+'&shortUrl='+encodeURIComponent(shortUrl));
  }catch(e){console.error('Shorten error:',e);res.redirect('/shorten-page?error='+encodeURIComponent('Failed to create short link: '+e.message));}
});

// ===== QR =====
app.get('/qr/:code',async(req,res)=>{
  try {
    const code=String(req.params.code||'').trim();
    const requestedDomain=req.query.domain ? normalizeHost(req.query.domain) : '';

    let q;
    if(requestedDomain){
      q=await pool.query(
        'SELECT * FROM links WHERE LOWER(selected_domain)=LOWER($1) AND short_code=$2 ORDER BY id DESC LIMIT 1',
        [requestedDomain,code]
      );
    }else{
      // Backward compatibility: only use a code-only result when it resolves to one link.
      q=await pool.query(
        'SELECT * FROM links WHERE short_code=$1 ORDER BY id DESC LIMIT 2',
        [code]
      );
      if(q.rowCount>1){
        return res.status(400).json({error:'Domain is required for this QR code'});
      }
    }

    if(!q.rowCount)return res.status(404).json({error:'Short link not found for the selected domain'});

    const link=mapLink(q.rows[0]);
    const exactDomain=normalizeHost(link.selectedDomain||link.selected_domain||requestedDomain||BASE_HOST);
    const url=`https://${exactDomain}/${encodeURIComponent(link.shortCode||code)}`;

    const qr=await QRCode.toDataURL(url,{
      errorCorrectionLevel:'H',
      margin:3,
      scale:10,
      width:420,
      color:{dark:'#000000',light:'#FFFFFF'}
    });

    res.set('Cache-Control','no-store');
    res.json({qr,url,domain:exactDomain,shortCode:link.shortCode||code});
  }catch(e){
    console.error('QR error:',e);
    res.status(500).json({error:'Failed to generate QR code'});
  }
});

// ===== LINK MANAGEMENT =====

// ===== V7.11 CANONICAL USER LINK ACTIONS =====
// These routes match the My Links forms exactly.
// Free/Premium plan does NOT affect editing an already-created link.
app.post('/links/:id/update',authMiddleware,async(req,res)=>{
  try{
    const id=Number(req.params.id);
    const newUrl=String(req.body.originalUrl||req.body.newUrl||'').trim();
    if(!Number.isFinite(id)||id<=0)return res.redirect('/my-links?error='+encodeURIComponent('Invalid link ID'));
    if(!newUrl)return res.redirect('/my-links?error='+encodeURIComponent('Please enter a destination URL'));

    const unsafe=validateDestinationUrl(newUrl);
    if(unsafe)return res.redirect('/my-links?error='+encodeURIComponent(unsafe));

    const q=await pool.query(
      'UPDATE links SET original_url=$1,updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING id',
      [newUrl,id,req.user.id]
    );
    if(!q.rowCount)return res.redirect('/my-links?error='+encodeURIComponent('Link not found or you do not own this link'));

    await notifyUser(req.user.id,'Short link updated','Your destination URL was updated successfully.','success');
    res.redirect('/my-links?success='+encodeURIComponent('Link updated successfully!'));
  }catch(e){
    console.error('User link update error:',e);
    res.redirect('/my-links?error='+encodeURIComponent('Failed to update link'));
  }
});

app.post('/links/:id/toggle',authMiddleware,async(req,res)=>{
  try{
    const id=Number(req.params.id);
    const q=await pool.query(
      'UPDATE links SET is_active=NOT is_active,updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING id,is_active',
      [id,req.user.id]
    );
    if(!q.rowCount)return res.redirect('/my-links?error='+encodeURIComponent('Link not found or you do not own this link'));
    res.redirect('/my-links?success='+encodeURIComponent(q.rows[0].is_active?'Link enabled successfully!':'Link disabled successfully!'));
  }catch(e){
    console.error('User link toggle error:',e);
    res.redirect('/my-links?error='+encodeURIComponent('Failed to change link status'));
  }
});

app.post('/links/:id/delete',authMiddleware,async(req,res)=>{
  try{
    const id=Number(req.params.id);
    const q=await pool.query(
      'DELETE FROM links WHERE id=$1 AND user_id=$2 RETURNING id',
      [id,req.user.id]
    );
    if(!q.rowCount)return res.redirect('/my-links?error='+encodeURIComponent('Link not found or you do not own this link'));
    await pool.query('UPDATE users SET total_links=GREATEST(total_links-1,0) WHERE id=$1',[req.user.id]);
    res.redirect('/my-links?success='+encodeURIComponent('Link deleted successfully!'));
  }catch(e){
    console.error('User link delete error:',e);
    res.redirect('/my-links?error='+encodeURIComponent('Failed to delete link'));
  }
});

app.post('/update-link/:id',authMiddleware,async(req,res)=>{
  try{
    const newUrl=String(req.body.newUrl||req.body.originalUrl||'').trim();
    if(!newUrl)return res.redirect('/dashboard?error='+encodeURIComponent('Please enter a URL'));
    const unsafe=validateDestinationUrl(newUrl);
    if(unsafe)return res.redirect('/dashboard?error='+encodeURIComponent(unsafe));
    const q=await pool.query('UPDATE links SET original_url=$1,updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING id',[newUrl,Number(req.params.id),req.user.id]);
    if(!q.rowCount)return res.redirect('/dashboard?error='+encodeURIComponent('Link not found'));
    res.redirect('/dashboard?success='+encodeURIComponent('Link updated successfully!'));
  }catch(e){res.redirect('/dashboard?error='+encodeURIComponent('Failed to update link'));}
});
app.post('/toggle-link/:id',authMiddleware,async(req,res)=>{
  try{const q=await pool.query('UPDATE links SET is_active=NOT is_active,updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING id',[Number(req.params.id),req.user.id]);if(!q.rowCount)return res.redirect('/dashboard?error='+encodeURIComponent('Link not found'));res.redirect('/dashboard?success='+encodeURIComponent('Link toggled successfully!'));}catch(e){res.redirect('/dashboard?error='+encodeURIComponent('Failed to toggle link'));}
});
app.post('/delete-link/:id',authMiddleware,async(req,res)=>{
  try{const q=await pool.query('DELETE FROM links WHERE id=$1 AND user_id=$2 RETURNING id',[Number(req.params.id),req.user.id]);if(!q.rowCount)return res.redirect('/dashboard?error='+encodeURIComponent('Link not found'));await pool.query('UPDATE users SET total_links=GREATEST(total_links-1,0) WHERE id=$1',[req.user.id]);res.redirect('/dashboard?success='+encodeURIComponent('Link deleted successfully!'));}catch(e){res.redirect('/dashboard?error='+encodeURIComponent('Failed to delete link'));}
});

// ===== USER APIs =====
app.get('/api/user-data',authMiddleware,async(req,res)=>{
  try{const user=await getUserById(req.user.id);const [lr,cr]=await Promise.all([pool.query('SELECT COUNT(*)::int AS count FROM links WHERE user_id=$1',[user.id]),pool.query('SELECT COUNT(*)::int AS count FROM clicks WHERE user_id=$1 AND is_bot=FALSE',[user.id])]);const fields=['displayName','email','username','firstName','lastName'];const filled=fields.filter(f=>user[f]).length;res.json({...user,totalLinks:Number(lr.rows[0].count),totalClicks:Number(cr.rows[0].count),completion:Math.round(filled/fields.length*100)});}catch(e){res.status(500).json({error:'Failed to load user data'});}
});
app.post('/api/update-profile',authMiddleware,async(req,res)=>{
  try{const current=await getUserById(req.user.id);const first=req.body.firstName!==undefined?String(req.body.firstName):current.firstName,last=req.body.lastName!==undefined?String(req.body.lastName):current.lastName,display=req.body.displayName!==undefined?String(req.body.displayName):(first+(last?' '+last:'')),email=req.body.email!==undefined?String(req.body.email):current.email,photo=req.body.profilePhoto!==undefined?String(req.body.profilePhoto):current.profilePhoto,tz=req.body.timezone!==undefined?String(req.body.timezone):current.timezone;const q=await pool.query('UPDATE users SET first_name=$1,last_name=$2,display_name=$3,email=$4,profile_photo=$5,timezone=$6 WHERE id=$7 RETURNING *',[first,last,display,email,photo,tz,current.id]);const user=mapUser(q.rows[0]);await markOnline(user);Object.assign(req.session.user,{displayName:user.displayName,firstName:user.firstName,email:user.email,profilePhoto:user.profilePhoto,timezone:user.timezone});res.json({success:true,user});}catch(e){res.status(500).json({error:'Failed to update profile'});}
});
app.post('/api/update-timezone',authMiddleware,async(req,res)=>{
  try{if(!req.body.timezone)return res.status(400).json({error:'Timezone is required'});await pool.query('UPDATE users SET timezone=$1 WHERE id=$2',[String(req.body.timezone),req.user.id]);req.session.user.timezone=String(req.body.timezone);res.json({success:true,timezone:req.body.timezone});}catch(e){res.status(500).json({error:'Failed to update timezone'});}
});
app.get('/api/online-users',async(req,res)=>{try{const a=await getActiveOnlineUsers();res.json({count:a.length,users:a.map(u=>({name:u.displayName||u.username||'User'}))});}catch(e){res.json({count:0,users:[]});}});


// ===== PREMIUM API KEY =====
app.get('/api-access', authMiddleware, async(req,res)=>{
  try{
    const user=await getUserById(req.user.id), active=await getActiveOnlineUsers();
    res.render('index',{page:'api-access',user,onlineUsers:active.length,onlineUserList:active.map(u=>({name:u.displayName||u.username||'User'})),countries,
      error:req.query.error||null,success:req.query.success||null,info:null,shortUrl:null,
      customDomains:(await getEnabledDomains()).filter(d=>d!==normalizeHost(BASE_HOST)),availableDomains:await getEnabledDomains(),baseDomain:BASE_HOST,baseUrl:BASE_URL,
      generatedApiKey:req.session.generatedApiKey||null});
    delete req.session.generatedApiKey;
  }catch(e){res.redirect('/dashboard?error='+encodeURIComponent('Could not open API access page'));}
});
app.post('/api-access/generate', authMiddleware, async(req,res)=>{
  try{
    const user=await getUserById(req.user.id);
    if(!user.isPremium)return res.redirect('/plans?error='+encodeURIComponent('API access is available to Premium users only.'));
    const key=makeApiKey(),hash=sha256(key),prefix=key.slice(0,18);
    await pool.query('UPDATE users SET api_key_hash=$1,api_key_prefix=$2,api_key_created_at=NOW(),api_enabled=TRUE WHERE id=$3',[hash,prefix,user.id]);
    req.session.generatedApiKey=key;
    await notifyUser(user.id,'API key generated','A new Premium API key was generated. Store it safely; it is shown only once.','success');
    req.session.save(()=>res.redirect('/api-access?success='+encodeURIComponent('New API key generated. Copy it now — it will not be shown again.')));
  }catch(e){res.redirect('/api-access?error='+encodeURIComponent('Could not generate API key'));}
});
app.post('/api-access/revoke', authMiddleware, async(req,res)=>{
  try{
    await pool.query("UPDATE users SET api_key_hash=NULL,api_key_prefix='',api_key_created_at=NULL,api_enabled=FALSE WHERE id=$1",[req.user.id]);
    await notifyUser(req.user.id,'API key revoked','Your API key has been revoked.','info');
    res.redirect('/api-access?success='+encodeURIComponent('API key revoked'));
  }catch(e){res.redirect('/api-access?error='+encodeURIComponent('Could not revoke API key'));}
});

// Premium REST API
app.post('/api/v1/shorten', authenticateApiKey, async(req,res)=>{
  try{
    const user=req.apiUser;
    const originalUrl=String(req.body.url||req.body.originalUrl||'').trim();
    const customSlug=String(req.body.customSlug||'').trim();
    const requestedDomain=normalizeHost(req.body.domain||BASE_HOST);
    const enabled=await getEnabledDomains();
    if(!enabled.includes(requestedDomain))return res.status(400).json({error:'Domain is unavailable or disabled'});
    const unsafe=validateDestinationUrl(originalUrl); if(unsafe)return res.status(400).json({error:unsafe});
    let shortCode=customSlug;
    if(shortCode){
      if(!/^[A-Za-z0-9_-]{2,80}$/.test(shortCode))return res.status(400).json({error:'Invalid customSlug'});
      const ex=await pool.query('SELECT 1 FROM links WHERE selected_domain=$1 AND short_code=$2',[requestedDomain,shortCode]);
      if(ex.rowCount)return res.status(409).json({error:'customSlug already exists on this domain'});
    } else {
      for(let i=0;i<12;i++){const c=generateShortCode();const ex=await pool.query('SELECT 1 FROM links WHERE selected_domain=$1 AND short_code=$2',[requestedDomain,c]);if(!ex.rowCount){shortCode=c;break;}}
    }
    let expiresAt=null; const days=Number(req.body.expiresIn||0); if(days>0)expiresAt=new Date(Date.now()+days*86400000);
    const password=String(req.body.password||'').trim();
    const q=await pool.query(`INSERT INTO links(user_id,selected_domain,original_url,short_code,custom_slug,expires_at,password_hash,password_enabled)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [user.id,requestedDomain,originalUrl,shortCode,customSlug||null,expiresAt,password?hashLinkPassword(password):null,!!password]);
    await pool.query('UPDATE users SET total_links=total_links+1 WHERE id=$1',[user.id]);
    const link=mapLink(q.rows[0]),shortUrl=buildShortUrl(link);
    res.status(201).json({success:true,id:link.id,shortUrl,domain:link.selectedDomain,shortCode:link.shortCode,expiresAt:link.expiresAt,passwordProtected:link.passwordEnabled});
  }catch(e){console.error('API shorten error:',e);res.status(500).json({error:'Could not create short link'});}
});
app.get('/api/v1/links', authenticateApiKey, async(req,res)=>{
  try{
    const q=await pool.query('SELECT * FROM links WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[req.apiUser.id]);
    res.json({links:q.rows.map(mapLink).map(l=>({...l,shortUrl:buildShortUrl(l)}))});
  }catch(e){res.status(500).json({error:'Could not load links'});}
});
app.get('/api/v1/stats', authenticateApiKey, async(req,res)=>{
  try{
    const q=await pool.query(`SELECT COUNT(*) FILTER (WHERE is_bot=FALSE)::bigint AS real_clicks,
      COUNT(*) FILTER (WHERE is_bot=TRUE)::bigint AS bot_clicks,
      COUNT(DISTINCT NULLIF(ip_address,'')) FILTER (WHERE is_bot=FALSE)::bigint AS unique_visitors
      FROM clicks WHERE user_id=$1`,[req.apiUser.id]);
    const l=await pool.query('SELECT COUNT(*)::bigint AS links FROM links WHERE user_id=$1',[req.apiUser.id]);
    res.json({links:Number(l.rows[0].links),realClicks:Number(q.rows[0].real_clicks),botClicks:Number(q.rows[0].bot_clicks),uniqueVisitors:Number(q.rows[0].unique_visitors)});
  }catch(e){res.status(500).json({error:'Could not load stats'});}
});

// ===== NOTIFICATIONS =====
app.get('/notifications', authMiddleware, async(req,res)=>{
  try{
    const active=await getActiveOnlineUsers();
    const q=await pool.query('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[req.user.id]);
    res.render('index',{page:'notifications',user:await getUserById(req.user.id),notifications:q.rows,onlineUsers:active.length,onlineUserList:active.map(u=>({name:u.displayName||u.username||'User'})),countries,
      error:req.query.error||null,success:req.query.success||null,info:null,shortUrl:null,
      customDomains:CUSTOM_DOMAINS,availableDomains:AVAILABLE_DOMAINS,baseDomain:BASE_HOST,baseUrl:BASE_URL});
  }catch(e){res.redirect('/dashboard?error='+encodeURIComponent('Could not load notifications'));}
});
app.post('/notifications/read-all', authMiddleware, async(req,res)=>{
  await pool.query('UPDATE notifications SET is_read=TRUE WHERE user_id=$1',[req.user.id]);
  res.redirect('/notifications?success='+encodeURIComponent('Notifications marked as read'));
});

// ===== LEGAL / FAQ =====
app.get('/faq', async(req,res)=>renderStaticPage(req,res,'faq'));
app.get('/privacy', async(req,res)=>renderStaticPage(req,res,'privacy'));
app.get('/terms', async(req,res)=>renderStaticPage(req,res,'terms'));
async function renderStaticPage(req,res,page){
  try{
    const active=await getActiveOnlineUsers();
    const user=req.session?.user?.id?await getUserById(req.session.user.id):null;
    res.render('index',{page,user,onlineUsers:active.length,onlineUserList:active.map(u=>({name:u.displayName||u.username||'User'})),countries,error:null,success:null,info:null,shortUrl:null,customDomains:CUSTOM_DOMAINS,availableDomains:AVAILABLE_DOMAINS,baseDomain:BASE_HOST,baseUrl:BASE_URL});
  }catch(e){res.status(500).send('Page error');}
}


// ===== PLANS / MANUAL PAYMENT =====
app.get('/plans', authMiddleware, async (req,res)=>{
  try {
    const active = await getActiveOnlineUsers();
    const payments = await pool.query('SELECT id,plan_months,amount,method,transaction_id,status,admin_note,created_at,reviewed_at FROM payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',[req.user.id]);
    const user = await getUserById(req.user.id);
    const pay = paymentConfig();
    res.render('index',{
      page:'plans',user,onlineUsers:active.length,onlineUserList:active.map(u=>({name:u.displayName||u.username||'User'})),
      countries,error:req.query.error||null,success:req.query.success||null,info:null,shortUrl:null,
      customDomains:CUSTOM_DOMAINS,availableDomains:AVAILABLE_DOMAINS,baseDomain:BASE_HOST,baseUrl:BASE_URL,
      freeLinkLimit:FREE_LINK_LIMIT,plan1Price:PLAN_1_PRICE,plan3Price:PLAN_3_PRICE,plan1Usd:PLAN_1_USD,plan3Usd:PLAN_3_USD,
      bkashNumber:pay.bkashNumber,nagadNumber:pay.nagadNumber,binanceId:pay.binanceId,
      bkashConfigured:pay.bkashConfigured,nagadConfigured:pay.nagadConfigured,binanceConfigured:pay.binanceConfigured,
      paymentHistory:payments.rows
    });
  } catch(e){ console.error('Plans page error:',e); res.redirect('/dashboard?error='+encodeURIComponent('Could not load plans')); }
});

app.get('/api/payment-config-status', authMiddleware, async(req,res)=>{
  try{
    const p=paymentConfig();
    res.json({bkash:p.bkashConfigured?'SET':'MISSING',nagad:p.nagadConfigured?'SET':'MISSING',binance:p.binanceConfigured?'SET':'MISSING'});
  }catch(e){res.status(500).json({error:'Could not read payment configuration'});}
});

app.post('/payments', authMiddleware, paymentUpload.single('screenshot'), async (req,res)=>{
  try {
    const months = Number(req.body.planMonths);
    if (![1,3].includes(months)) return res.redirect('/plans?error='+encodeURIComponent('Invalid plan'));
    const method = String(req.body.method||'').toLowerCase();
    if (!['bkash','nagad','binance'].includes(method)) return res.redirect('/plans?error='+encodeURIComponent('Choose bKash, Nagad or Binance'));

    // bKash/Nagad use Transaction ID. Binance uses Order ID in the same secure reference field.
    const txn = String(req.body.transactionId||req.body.orderId||'').trim();
    const refName = method === 'binance' ? 'Binance Order ID' : 'transaction ID';
    if (txn.length < 4) return res.redirect('/plans?error='+encodeURIComponent('Enter a valid '+refName));
    if (!req.file) return res.redirect('/plans?error='+encodeURIComponent('Upload payment screenshot'));

    const amount = expectedPlanAmount(months);
    await pool.query(`INSERT INTO payments(user_id,plan_months,amount,method,transaction_id,screenshot,screenshot_mime)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[req.user.id,months,amount,method,txn,req.file.buffer,req.file.mimetype]);

    await notifyUser(req.user.id,'Payment submitted',
      method==='binance' ? 'Your Binance payment proof and Order ID are pending admin review.' : 'Your Send Money payment is pending admin review.',
      'info');

    res.redirect('/plans?success='+encodeURIComponent('Payment submitted. Admin will review it.'));
  } catch(e){
    const msg = e.code === '23505' ? 'This transaction/order ID was already submitted.' : ('Payment submission failed: '+e.message);
    res.redirect('/plans?error='+encodeURIComponent(msg));
  }
});

// ===== ADMIN =====
app.get('/admin/login', async (req,res)=>{
  if (await getAdminState(req)) return res.redirect('/admin');
  let active=[]; try{active=await getActiveOnlineUsers();}catch(e){}
  res.render('index',{page:'admin-login',user:null,onlineUsers:active.length,onlineUserList:active.map(u=>({name:u.displayName||u.username||'User'})),countries,
    error:req.query.error||null,success:null,info:null,shortUrl:null,customDomains:CUSTOM_DOMAINS,availableDomains:AVAILABLE_DOMAINS,baseDomain:BASE_HOST,baseUrl:BASE_URL});
});
app.post('/admin/login', async (req,res)=>{
  const email=String(req.body.email||'').trim().toLowerCase(), password=String(req.body.password||'');
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return res.redirect('/admin/login?error='+encodeURIComponent('ADMIN_EMAIL / ADMIN_PASSWORD are not configured in Railway Variables.'));
  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) return res.redirect('/admin/login?error='+encodeURIComponent('Invalid admin credentials'));
  req.session.admin=true;
  return req.session.save(()=>res.redirect('/admin'));
});
app.post('/admin/logout', (req,res)=>{ delete req.session.admin; req.session.save(()=>res.redirect('/admin/login')); });

app.get('/admin', adminMiddleware, async (req,res)=>{
  try {
    const [usersR,linksR,payR,active,totalClicksR,botClicksR,auditR,domainsR,backupsR,announcementsR] = await Promise.all([
      pool.query('SELECT * FROM users ORDER BY created_at DESC LIMIT 500'),
      pool.query(`SELECT l.*,u.display_name,u.username FROM links l JOIN users u ON u.id=l.user_id ORDER BY l.created_at DESC LIMIT 500`),
      pool.query(`SELECT p.*,u.display_name,u.username,u.email FROM payments p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 300`),
      getActiveOnlineUsers(),
      pool.query('SELECT COUNT(*)::bigint AS count FROM clicks WHERE is_bot=FALSE'),
      pool.query('SELECT COUNT(*)::bigint AS count FROM clicks WHERE is_bot=TRUE'),
      pool.query('SELECT * FROM admin_audit_logs ORDER BY created_at DESC LIMIT 100'),
      pool.query('SELECT * FROM domain_settings ORDER BY domain=$1 DESC,domain ASC',[normalizeHost(BASE_HOST)]),
      pool.query('SELECT id,created_at,created_by FROM app_backups ORDER BY created_at DESC LIMIT 20'),
      pool.query('SELECT * FROM announcements ORDER BY updated_at DESC,id DESC LIMIT 20')
    ]);
    const users=usersR.rows.map(mapUser);
    res.render('index',{page:'admin',user:req.session?.user?.id?await getUserById(req.session.user.id):null,onlineUsers:active.length,onlineUserList:active.map(u=>({name:u.displayName||u.username||'User'})),countries,
      error:req.query.error||null,success:req.query.success||null,info:null,shortUrl:null,customDomains:CUSTOM_DOMAINS,availableDomains:AVAILABLE_DOMAINS,baseDomain:BASE_HOST,baseUrl:BASE_URL,
      adminUsers:users,adminLinks:linksR.rows,adminPayments:payR.rows,adminAudit:auditR.rows,adminDomains:domainsR.rows,adminBackups:backupsR.rows,adminAnnouncements:announcementsR.rows,
      adminStats:{totalUsers:users.length,online:active.length,totalLinks:linksR.rows.length,totalClicks:Number(totalClicksR.rows[0].count),botClicks:Number(botClicksR.rows[0].count),pendingPayments:payR.rows.filter(p=>p.status==='pending').length},
      freeLinkLimit:FREE_LINK_LIMIT,plan1Price:PLAN_1_PRICE,plan3Price:PLAN_3_PRICE,plan1Usd:PLAN_1_USD,plan3Usd:PLAN_3_USD,bkashNumber:BKASH_NUMBER,nagadNumber:NAGAD_NUMBER,binanceId:BINANCE_ID
    });
  }catch(e){console.error('Admin page error:',e);res.redirect('/admin/login?error='+encodeURIComponent('Admin page database error'));}
});

app.post('/admin/users/:id/block', adminMiddleware, async(req,res)=>{
  try{
    const id=Number(req.params.id),u=await getUserById(id); if(!u)return res.redirect('/admin?error='+encodeURIComponent('User not found'));
    const next=u.accountStatus==='blocked'?'active':'blocked';
    await pool.query('UPDATE users SET account_status=$1,blocked_reason=$2 WHERE id=$3',[next,next==='blocked'?String(req.body.reason||'Blocked by admin'):'',id]);
    if(next==='blocked') await pool.query('DELETE FROM online_users WHERE user_id=$1',[id]);
    await auditAdmin(req,'user_status','user',id,`status=${next}`);
    await notifyUser(id,'Account status updated',`Your account is now ${next}.`,next==='blocked'?'warning':'success');
    res.redirect('/admin?success='+encodeURIComponent(`User ${next}`));
  }catch(e){res.redirect('/admin?error='+encodeURIComponent('Could not update user'));}
});
app.post('/admin/users/:id/plan', adminMiddleware, async(req,res)=>{
  try{
    const id=Number(req.params.id),months=Number(req.body.months||0);
    if(months===0) await pool.query("UPDATE users SET plan_type='free',premium_until=NULL WHERE id=$1",[id]);
    else if([1,3,6,12].includes(months)) await pool.query("UPDATE users SET plan_type='premium',premium_until=GREATEST(COALESCE(premium_until,NOW()),NOW()) + ($1 || ' months')::interval WHERE id=$2",[months,id]);
    else throw new Error('Invalid months');
    await auditAdmin(req,'user_plan','user',id,`months=${months}`);
    await notifyUser(id,'Plan updated',months===0?'Your account is now on the Free plan.':`Premium access was extended by ${months} month(s).`,'success');
    res.redirect('/admin?success='+encodeURIComponent('User plan updated'));
  }catch(e){res.redirect('/admin?error='+encodeURIComponent('Could not update plan'));}
});
app.post('/admin/links/:id/toggle', adminMiddleware, async(req,res)=>{
  try{const id=Number(req.params.id);await pool.query('UPDATE links SET is_active=NOT is_active,updated_at=NOW() WHERE id=$1',[id]);await auditAdmin(req,'link_toggle','link',id,'');res.redirect('/admin?success='+encodeURIComponent('Link status updated'));}catch(e){res.redirect('/admin?error='+encodeURIComponent('Could not update link'));}
});
app.post('/admin/links/:id/delete', adminMiddleware, async(req,res)=>{
  try{const id=Number(req.params.id);await pool.query('DELETE FROM links WHERE id=$1',[id]);await auditAdmin(req,'link_delete','link',id,'');res.redirect('/admin?success='+encodeURIComponent('Link deleted'));}catch(e){res.redirect('/admin?error='+encodeURIComponent('Could not delete link'));}
});
app.get('/admin/payments/:id/screenshot', adminMiddleware, async(req,res)=>{
  try{const q=await pool.query('SELECT screenshot,screenshot_mime FROM payments WHERE id=$1',[Number(req.params.id)]);if(!q.rowCount||!q.rows[0].screenshot)return res.status(404).send('No screenshot');res.type(q.rows[0].screenshot_mime||'image/jpeg').send(q.rows[0].screenshot);}catch(e){res.status(500).send('Screenshot error');}
});
app.post('/admin/payments/:id/approve', adminMiddleware, async(req,res)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const q=await client.query("SELECT * FROM payments WHERE id=$1 FOR UPDATE",[Number(req.params.id)]);
    if(!q.rowCount)throw new Error('Payment not found');
    const p=q.rows[0];
    if(p.status!=='approved'){
      await client.query("UPDATE users SET plan_type='premium',premium_until=GREATEST(COALESCE(premium_until,NOW()),NOW()) + ($1 || ' months')::interval WHERE id=$2",[p.plan_months,p.user_id]);
      await client.query("UPDATE payments SET status='approved',admin_note=$1,reviewed_at=NOW() WHERE id=$2",[String(req.body.note||''),p.id]);
    }
    await client.query('COMMIT'); await auditAdmin(req,'payment_approve','payment',p.id,`user=${p.user_id}; months=${p.plan_months}`); await notifyUser(p.user_id,'Payment approved',`Your ${p.plan_months}-month Premium plan is active.`,'success'); res.redirect('/admin?success='+encodeURIComponent('Payment approved and Premium activated'));
  }catch(e){await client.query('ROLLBACK');res.redirect('/admin?error='+encodeURIComponent(e.message));}finally{client.release();}
});
app.post('/admin/payments/:id/reject', adminMiddleware, async(req,res)=>{
  try{const id=Number(req.params.id);const q=await pool.query("UPDATE payments SET status='rejected',admin_note=$1,reviewed_at=NOW() WHERE id=$2 RETURNING user_id",[String(req.body.note||'Rejected by admin'),id]);await auditAdmin(req,'payment_reject','payment',id,'');if(q.rowCount)await notifyUser(q.rows[0].user_id,'Payment rejected','Your payment request was rejected. Check the admin note or contact support.','warning');res.redirect('/admin?success='+encodeURIComponent('Payment rejected'));}catch(e){res.redirect('/admin?error='+encodeURIComponent('Could not reject payment'));}
});


// ===== ADMIN ANNOUNCEMENTS =====
app.post('/admin/announcement', adminMiddleware, async(req,res)=>{
  try{
    const message=String(req.body.message||'').trim();
    if(!message)return res.redirect('/admin?error='+encodeURIComponent('Announcement message is required.'));
    if(message.length>500)return res.redirect('/admin?error='+encodeURIComponent('Announcement is too long (max 500 characters).'));
    await pool.query('UPDATE announcements SET is_active=FALSE,updated_at=NOW() WHERE is_active=TRUE');
    const q=await pool.query('INSERT INTO announcements(message,is_active) VALUES($1,TRUE) RETURNING id',[message]);
    await auditAdmin(req,'announcement_publish','announcement',q.rows[0].id,message);
    res.redirect('/admin?success='+encodeURIComponent('Announcement published'));
  }catch(e){console.error('Announcement publish error:',e);res.redirect('/admin?error='+encodeURIComponent('Could not publish announcement'));}
});
app.post('/admin/announcement/:id/toggle', adminMiddleware, async(req,res)=>{
  try{
    const id=Number(req.params.id),q=await pool.query('SELECT is_active FROM announcements WHERE id=$1',[id]);
    if(!q.rowCount)return res.redirect('/admin?error='+encodeURIComponent('Announcement not found'));
    const next=!q.rows[0].is_active;
    if(next)await pool.query('UPDATE announcements SET is_active=FALSE,updated_at=NOW() WHERE is_active=TRUE');
    await pool.query('UPDATE announcements SET is_active=$1,updated_at=NOW() WHERE id=$2',[next,id]);
    await auditAdmin(req,'announcement_toggle','announcement',id,`active=${next}`);
    res.redirect('/admin?success='+encodeURIComponent(next?'Announcement activated':'Announcement turned off'));
  }catch(e){res.redirect('/admin?error='+encodeURIComponent('Could not update announcement'));}
});
app.post('/admin/announcement/:id/delete', adminMiddleware, async(req,res)=>{
  try{const id=Number(req.params.id);await pool.query('DELETE FROM announcements WHERE id=$1',[id]);await auditAdmin(req,'announcement_delete','announcement',id,'');res.redirect('/admin?success='+encodeURIComponent('Announcement deleted'));}
  catch(e){res.redirect('/admin?error='+encodeURIComponent('Could not delete announcement'));}
});

app.post('/admin/users/:id/delete', adminMiddleware, async(req,res)=>{
  try{
    const id=Number(req.params.id);
    await pool.query('DELETE FROM users WHERE id=$1',[id]);
    await auditAdmin(req,'user_delete','user',id,'Cascade deleted user data');
    res.redirect('/admin?success='+encodeURIComponent('User deleted'));
  }catch(e){res.redirect('/admin?error='+encodeURIComponent('Could not delete user'));}
});
app.post('/admin/domains/:domain/toggle', adminMiddleware, async(req,res)=>{
  try{
    const domain=normalizeHost(req.params.domain);
    if(domain===normalizeHost(BASE_HOST)) return res.redirect('/admin?error='+encodeURIComponent('Base domain cannot be disabled.'));
    const q=await pool.query('UPDATE domain_settings SET enabled=NOT enabled WHERE domain=$1 RETURNING enabled',[domain]);
    await auditAdmin(req,'domain_toggle','domain',domain,q.rowCount?`enabled=${q.rows[0].enabled}`:'not found');
    res.redirect('/admin?success='+encodeURIComponent('Domain status updated'));
  }catch(e){res.redirect('/admin?error='+encodeURIComponent('Could not update domain'));}
});
app.post('/admin/domains/:domain/maintenance', adminMiddleware, async(req,res)=>{
  try{
    const domain=normalizeHost(req.params.domain);
    const q=await pool.query('UPDATE domain_settings SET maintenance=NOT maintenance WHERE domain=$1 RETURNING maintenance',[domain]);
    await auditAdmin(req,'domain_maintenance','domain',domain,q.rowCount?`maintenance=${q.rows[0].maintenance}`:'not found');
    res.redirect('/admin?success='+encodeURIComponent('Domain maintenance status updated'));
  }catch(e){res.redirect('/admin?error='+encodeURIComponent('Could not update domain maintenance'));}
});
app.post('/admin/domains/check', adminMiddleware, async(req,res)=>{
  try{
    for(const domain of AVAILABLE_DOMAINS){
      let status='down';
      try{
        const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),5000);
        const r=await fetch(`${domainOrigin(domain)}/health`,{method:'GET',signal:controller.signal,redirect:'manual'});
        clearTimeout(timer); status=r.ok?'healthy':`http-${r.status}`;
      }catch(e){status='down';}
      await pool.query('UPDATE domain_settings SET last_health=$1,last_checked_at=NOW() WHERE domain=$2',[status,normalizeHost(domain)]);
    }
    await auditAdmin(req,'domain_health_check','domain','','Checked all configured domains');
    res.redirect('/admin?success='+encodeURIComponent('Domain health check completed'));
  }catch(e){res.redirect('/admin?error='+encodeURIComponent('Domain health check failed'));}
});
app.post('/admin/backup/create', adminMiddleware, async(req,res)=>{
  try{await createBackupSnapshot(ADMIN_EMAIL||'admin');await auditAdmin(req,'backup_create','backup','','Manual snapshot created');res.redirect('/admin?success='+encodeURIComponent('Database snapshot created'));}catch(e){res.redirect('/admin?error='+encodeURIComponent('Backup failed'));}
});
app.get('/admin/backup/:id/download', adminMiddleware, async(req,res)=>{
  try{
    const q=await pool.query('SELECT backup_data,created_at FROM app_backups WHERE id=$1',[Number(req.params.id)]);
    if(!q.rowCount)return res.status(404).send('Backup not found');
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('Content-Disposition',`attachment; filename="tpib-backup-${req.params.id}.json"`);
    res.send(JSON.stringify(q.rows[0].backup_data,null,2));
  }catch(e){res.status(500).send('Backup download failed');}
});

// ===== HEALTH =====
app.get('/health',async(req,res)=>{
  try{const db=await pool.query('SELECT NOW() AS now');res.json({status:'ok',database:'postgresql',dbTime:db.rows[0].now,domains:AVAILABLE_DOMAINS,baseUrl:BASE_URL,uptime:process.uptime()});}catch(e){res.status(500).json({status:'error',database:'down',error:e.message});}
});

// ===== PASSWORD-PROTECTED SHORT LINKS =====
app.post('/unlock/:id', async(req,res)=>{
  try{
    const q=await pool.query('SELECT * FROM links WHERE id=$1',[Number(req.params.id)]);
    if(!q.rowCount)return res.status(404).send('Link not found');
    const row=q.rows[0],link=mapLink(row);
    if(!row.password_enabled || !row.password_hash)return res.redirect(buildShortUrl(link));
    if(!verifyLinkPassword(req.body.password,row.password_hash)){
      return res.redirect(`${buildShortUrl(link)}?unlockError=1`);
    }
    if(!req.session.unlockedLinks)req.session.unlockedLinks={};
    req.session.unlockedLinks[String(link.id)]=Date.now()+30*60*1000;
    req.session.save(()=>res.redirect(buildShortUrl(link)));
  }catch(e){res.status(500).send('Unlock failed');}
});

// ===== SHORT URL REDIRECT (keep after all named routes) =====
app.get('/:code',async(req,res)=>{
  try{
    const code=req.params.code;if(['favicon.ico','robots.txt','sitemap.xml'].includes(code))return res.status(404).send('Not found');
    const requestHost=normalizeHost(req.get('host'));const q=await pool.query('SELECT * FROM links WHERE selected_domain=$1 AND short_code=$2 AND is_active=TRUE LIMIT 1',[requestHost,code]);if(!q.rowCount)return res.status(404).send('Link not found or inactive');let link=mapLink(q.rows[0]);
    if(link.isExpired||(link.expiresAt&&new Date(link.expiresAt)<new Date())){await pool.query('UPDATE links SET is_expired=TRUE WHERE id=$1',[link.id]);return res.status(410).send('This link has expired');}
    const uaPre=req.headers['user-agent']||'';
    if(q.rows[0].password_enabled && q.rows[0].password_hash && !isSocialPreviewBot(uaPre)){
      const unlocked=req.session?.unlockedLinks?.[String(link.id)];
      if(!unlocked || Number(unlocked)<Date.now()){
        const active=await getActiveOnlineUsers();
        const user=req.session?.user?.id?await getUserById(req.session.user.id):null;
        return res.status(401).render('index',{page:'link-password',user,link,unlockError:req.query.unlockError==='1',onlineUsers:active.length,onlineUserList:active.map(u=>({name:u.displayName||u.username||'User'})),countries,error:null,success:null,info:null,shortUrl:null,customDomains:CUSTOM_DOMAINS,availableDomains:AVAILABLE_DOMAINS,baseDomain:BASE_HOST,baseUrl:getBaseUrl(req)});
      }
    }
    const ip=normalizeClientIp(req.ip||req.connection.remoteAddress||''),ua=req.headers['user-agent']||'',ref=req.headers['referer']||req.headers['referrer']||'',bot=isBot(ua),di=getDeviceInfo(ua);let countryCode='XX';try{const geo=require('geoip-lite').lookup(ip);if(geo?.country)countryCode=String(geo.country).toUpperCase();}catch(e){}
    await pool.query(`INSERT INTO clicks(link_id,user_id,ip_address,user_agent,device,browser,os,country,country_code,referrer,is_bot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[link.id,link.userId,ip,ua,di.device,di.browser,di.os,countryInfo(countryCode).name,countryCode,ref,bot]);
    if(!bot){await Promise.all([pool.query('UPDATE links SET clicks=clicks+1 WHERE id=$1',[link.id]),pool.query('UPDATE users SET total_clicks=total_clicks+1 WHERE id=$1',[link.userId])]);}
    if(isSocialPreviewBot(ua))return renderSocialPreview(req,res,link);res.set('Cache-Control','no-store');return res.redirect(302,link.originalUrl);
  }catch(e){console.error('Redirect error:',e);res.status(500).send('Error redirecting');}
});

// ===== 404 =====
app.use(async(req,res)=>{
  let user=null,active=[];try{if(req.session?.user?.id)user=await getUserById(req.session.user.id);active=await getActiveOnlineUsers();}catch(e){}
  res.status(404).render('index',{page:'404',user,onlineUsers:active.length,onlineUserList:active.map(u=>({name:u.displayName||u.username||'User'})),countries,error:'Page not found',success:null,info:null,shortUrl:null,customDomains:CUSTOM_DOMAINS,availableDomains:AVAILABLE_DOMAINS,baseDomain:BASE_HOST,baseUrl:getBaseUrl(req)});
});

async function start(){
  try{
    await pool.query('SELECT 1');
    console.log('✅ PostgreSQL connected');
    await initDatabase();
    await migrateLegacyJsonIfPossible();
    await maybeCreateAutomaticBackup();
    setInterval(()=>maybeCreateAutomaticBackup(), Math.min(AUTO_BACKUP_HOURS,6)*3600000).unref();
    console.log('✅ Session store: PostgreSQL');
    app.listen(PORT,'0.0.0.0',()=>{
      console.log(`🚀 Server running on port ${PORT}`);console.log(`📡 Base URL: ${BASE_URL}`);console.log('🌐 Available Domains:');AVAILABLE_DOMAINS.forEach((d,i)=>console.log(`   ${i+1}. https://${d}`));console.log(`✅ Health check: ${BASE_URL}/health`);console.log(`🔐 Login page: ${BASE_URL}/login`);console.log(`📊 Dashboard: ${BASE_URL}/dashboard`);
    });
  }catch(e){console.error('❌ Database startup failed:',e);process.exit(1);}
}
start();
