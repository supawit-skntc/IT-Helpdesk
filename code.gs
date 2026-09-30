/****************************************************************************************
 * ระบบแจ้งปัญหาคอมพิวเตอร์และ IT
 * IT Helpdesk & Computer Problem Reporting System
 * "แจ้งง่าย ติดตามได้ แก้ไขไว ตรวจสอบได้"
 *
 * Backend : Google Apps Script + Google Sheets (Database) + Google Drive (Attachments)
 * Notify  : Telegram Bot API + Google Chat Incoming Webhook
 * Frontend: index.html (เรียก Backend ผ่าน google.script.run)
 *
 * หมายเหตุด้านความปลอดภัย
 *  - Token / Webhook อยู่ในไฟล์นี้หรือ Script Properties เท่านั้น ไม่ถูกส่งไปยัง Frontend
 *  - ฟังก์ชันที่ลงท้ายด้วย "_" เป็นฟังก์ชันภายใน (Frontend เรียกผ่าน google.script.run ไม่ได้)
 *  - ทุกฟังก์ชันที่ Frontend เรียกได้ จะตรวจสอบสิทธิ์และข้อมูลฝั่ง Backend เสมอ
 ****************************************************************************************/

// =====================================================================================
// 1) CONFIGURATION — แก้ไขค่าตรงนี้ หรือกำหนดผ่านหน้า "ตั้งค่า" (Admin) ซึ่งจะเก็บไว้ใน
//    Script Properties (PropertiesService) และมีลำดับความสำคัญสูงกว่าค่าในไฟล์นี้
// =====================================================================================
const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID';
const DRIVE_FOLDER_ID = 'YOUR_GOOGLE_DRIVE_FOLDER_ID';
const TELEGRAM_BOT_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN';
const TELEGRAM_CHAT_ID = 'YOUR_TELEGRAM_CHAT_ID';
const GOOGLE_CHAT_WEBHOOK_URL = 'YOUR_GOOGLE_CHAT_WEBHOOK_URL';

const CONFIG = {
  SPREADSHEET_ID: SPREADSHEET_ID,
  DRIVE_FOLDER_ID: DRIVE_FOLDER_ID,
  TELEGRAM_BOT_TOKEN: TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: TELEGRAM_CHAT_ID,
  GOOGLE_CHAT_WEBHOOK_URL: GOOGLE_CHAT_WEBHOOK_URL,
  TIMEZONE: 'Asia/Bangkok',
  APP_NAME: 'ระบบแจ้งปัญหาคอมพิวเตอร์และ IT',
  APP_NAME_EN: 'IT Helpdesk & Computer Problem Reporting System',
  SLOGAN: 'แจ้งง่าย ติดตามได้ แก้ไขไว ตรวจสอบได้',
  SESSION_SECONDS: 21600,               // อายุ Session 6 ชั่วโมง (สูงสุดของ CacheService)
  DASHBOARD_CACHE_SECONDS: 60,          // Cache ข้อมูล Dashboard
  MAX_FILES: 5,                         // จำนวนไฟล์แนบสูงสุดต่อ Ticket
  MAX_FILE_BYTES: 5 * 1024 * 1024,      // ขนาดไฟล์สูงสุดต่อไฟล์ 5 MB
  MAX_TOTAL_BYTES: 20 * 1024 * 1024,    // ขนาดรวมสูงสุด 20 MB
  DEFAULT_ADMIN_ID: 'admin',
  DEFAULT_ADMIN_PASSWORD: 'admin1234'   // ระบบบังคับให้เปลี่ยนรหัสผ่านนี้เมื่อเข้าสู่ระบบครั้งแรก
};

// =====================================================================================
// 2) CONSTANTS
// =====================================================================================
const STATUS = {
  NEW: 'รอรับเรื่อง',
  ACCEPTED: 'รับเรื่องแล้ว',
  IN_PROGRESS: 'กำลังดำเนินการ',
  WAITING: 'รออะไหล่ / รอข้อมูล',
  RESOLVED: 'แก้ไขแล้ว',
  CLOSED: 'ปิดงาน',
  CANCELLED: 'ยกเลิก'
};

const STATUS_LIST = [
  { value: STATUS.NEW, emoji: '🟡', color: '#f59e0b', icon: 'fa-solid fa-inbox', step: 1 },
  { value: STATUS.ACCEPTED, emoji: '🔵', color: '#3b82f6', icon: 'fa-solid fa-clipboard-check', step: 2 },
  { value: STATUS.IN_PROGRESS, emoji: '🟣', color: '#8b5cf6', icon: 'fa-solid fa-screwdriver-wrench', step: 3 },
  { value: STATUS.WAITING, emoji: '🟠', color: '#f97316', icon: 'fa-solid fa-hourglass-half', step: 3 },
  { value: STATUS.RESOLVED, emoji: '🟢', color: '#10b981', icon: 'fa-solid fa-circle-check', step: 4 },
  { value: STATUS.CLOSED, emoji: '⚫', color: '#334155', icon: 'fa-solid fa-lock', step: 5 },
  { value: STATUS.CANCELLED, emoji: '🔴', color: '#ef4444', icon: 'fa-solid fa-ban', step: 0 }
];

const OPEN_STATUSES = [STATUS.NEW, STATUS.ACCEPTED, STATUS.IN_PROGRESS, STATUS.WAITING];
const FINAL_STATUSES = [STATUS.CLOSED, STATUS.CANCELLED];

const STATUS_ACTION = {};
STATUS_ACTION[STATUS.NEW] = 'ตั้งสถานะรอรับเรื่อง';
STATUS_ACTION[STATUS.ACCEPTED] = 'รับเรื่อง';
STATUS_ACTION[STATUS.IN_PROGRESS] = 'กำลังดำเนินการ';
STATUS_ACTION[STATUS.WAITING] = 'รออะไหล่ / รอข้อมูล';
STATUS_ACTION[STATUS.RESOLVED] = 'แก้ไขแล้ว';
STATUS_ACTION[STATUS.CLOSED] = 'ปิดงาน';
STATUS_ACTION[STATUS.CANCELLED] = 'ยกเลิก';

const URGENT_PRIORITY = 'ด่วนมาก';
const PRIORITY_LIST = [
  { value: 'ปกติ', label: 'ปกติ', emoji: '🟢', color: '#10b981', level: 1 },
  { value: 'ปานกลาง', label: 'ปานกลาง', emoji: '🟡', color: '#eab308', level: 2 },
  { value: 'เร่งด่วน', label: 'เร่งด่วน', emoji: '🟠', color: '#f97316', level: 3 },
  { value: URGENT_PRIORITY, label: 'ด่วนมาก / กระทบการเรียนการสอน', emoji: '🔴', color: '#ef4444', level: 4 }
];

const PROBLEM_TYPES = [
  { value: 'Computer', icon: 'fa-solid fa-desktop' },
  { value: 'Notebook', icon: 'fa-solid fa-laptop' },
  { value: 'Printer', icon: 'fa-solid fa-print' },
  { value: 'Network / Internet', icon: 'fa-solid fa-network-wired' },
  { value: 'Wi-Fi', icon: 'fa-solid fa-wifi' },
  { value: 'Projector', icon: 'fa-solid fa-video' },
  { value: 'Software', icon: 'fa-solid fa-window-restore' },
  { value: 'Hardware', icon: 'fa-solid fa-microchip' },
  { value: 'Email', icon: 'fa-solid fa-envelope' },
  { value: 'Google Workspace', icon: 'fa-brands fa-google' },
  { value: 'Account', icon: 'fa-solid fa-user-lock' },
  { value: 'ระบบเว็บไซต์', icon: 'fa-solid fa-globe' },
  { value: 'โปรแกรม', icon: 'fa-solid fa-code' },
  { value: 'ระบบสารสนเทศ', icon: 'fa-solid fa-database' },
  { value: 'อื่น ๆ', icon: 'fa-solid fa-ellipsis' }
];

const ROLES = ['Admin', 'IT Staff', 'User'];

const RESULT_OPTIONS = [
  'แก้ไขสำเร็จ ใช้งานได้ปกติ',
  'แก้ไขได้บางส่วน',
  'เปลี่ยนอุปกรณ์ใหม่',
  'ส่งซ่อมภายนอก / ส่งเคลม',
  'ไม่สามารถแก้ไขได้',
  'ให้คำแนะนำการใช้งาน'
];

const SHEET_HEADERS = {
  Tickets: [
    'TicketID', 'CreatedAt', 'ReporterID', 'ReporterName', 'Department', 'Phone', 'Email',
    'Building', 'Floor', 'Room', 'AssetID', 'ProblemType', 'ProblemTitle', 'ProblemDetail',
    'Priority', 'Status', 'AssignedTo', 'AssignedAt', 'AcceptedAt', 'StartedAt', 'ResolvedAt',
    'ClosedAt', 'Resolution', 'RootCause', 'Cost', 'Rating', 'Feedback', 'AttachmentURL',
    'LastUpdated', 'InstallPoint', 'Result', 'CloseNote', 'ClosedBy', 'CreatedBy', 'RatedAt'
  ],
  WorkLogs: ['LogID', 'TicketID', 'DateTime', 'Staff', 'Action', 'Parts', 'Cost', 'Note'],
  History: ['HistoryID', 'TicketID', 'DateTime', 'Action', 'FromStatus', 'ToStatus', 'By', 'Note'],
  Users: ['UserID', 'Name', 'Department', 'Email', 'Phone', 'Role', 'Status', 'PasswordHash', 'LastLogin', 'CreatedAt'],
  Settings: ['Key', 'Value', 'Description']
};

const DEFAULT_SETTINGS = [
  ['ORG_NAME', 'โรงเรียน / องค์กรของคุณ', 'ชื่อหน่วยงานที่แสดงบนระบบ'],
  ['ASSIGNEES', 'IT Admin\nNetwork Admin\nComputer Technician\nเจ้าหน้าที่โสตฯ\nเจ้าหน้าที่ระบบสารสนเทศ', 'รายชื่อ/ตำแหน่งผู้รับผิดชอบงาน (บรรทัดละ 1 รายการ)'],
  ['BUILDINGS', 'อาคาร 1\nอาคาร 2\nอาคาร 3\nอาคารอเนกประสงค์\nอาคารสำนักงาน', 'รายชื่ออาคาร (บรรทัดละ 1 รายการ)'],
  ['DEPARTMENTS', 'ฝ่ายบริหารวิชาการ\nฝ่ายบริหารงานบุคคล\nฝ่ายบริหารงบประมาณ\nฝ่ายบริหารทั่วไป\nกลุ่มสาระการเรียนรู้ภาษาไทย\nกลุ่มสาระการเรียนรู้คณิตศาสตร์\nกลุ่มสาระการเรียนรู้วิทยาศาสตร์และเทคโนโลยี\nกลุ่มสาระการเรียนรู้สังคมศึกษาฯ\nกลุ่มสาระการเรียนรู้ภาษาต่างประเทศ\nกลุ่มสาระการเรียนรู้สุขศึกษาและพลศึกษา\nกลุ่มสาระการเรียนรู้ศิลปะ\nกลุ่มสาระการเรียนรู้การงานอาชีพ', 'รายชื่อกลุ่มสาระ / ฝ่าย / แผนก (บรรทัดละ 1 รายการ)'],
  ['ALLOW_GUEST_REPORT', 'TRUE', 'อนุญาตให้แจ้งปัญหาโดยไม่ต้องเข้าสู่ระบบ (TRUE/FALSE)'],
  ['NOTIFY_TELEGRAM', 'TRUE', 'เปิดการแจ้งเตือน Telegram (TRUE/FALSE)'],
  ['NOTIFY_GOOGLE_CHAT', 'TRUE', 'เปิดการแจ้งเตือน Google Chat (TRUE/FALSE)'],
  ['ATTACHMENT_SHARING', 'ANYONE_WITH_LINK', 'สิทธิ์ไฟล์แนบ: ANYONE_WITH_LINK / DOMAIN_WITH_LINK / PRIVATE']
];

const EDITABLE_SETTINGS = ['ORG_NAME', 'ASSIGNEES', 'BUILDINGS', 'DEPARTMENTS', 'ALLOW_GUEST_REPORT', 'NOTIFY_TELEGRAM', 'NOTIFY_GOOGLE_CHAT', 'ATTACHMENT_SHARING'];
const SECRET_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'GOOGLE_CHAT_WEBHOOK_URL', 'DRIVE_FOLDER_ID'];

const ALLOWED_MIME = /^(image\/(png|jpe?g|gif|webp|heic|heif|bmp)|application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|application\/vnd\.ms-(excel|powerpoint)|text\/plain|text\/csv)$/;

// Per-execution memory (แต่ละการเรียก google.script.run เป็น execution ใหม่เสมอ)
let _ss = null;
let _tables = {};
let _settings = null;
let _props = null;
let _usersCache = null;
let INTERNAL_CALL_ = false;

// =====================================================================================
// 3) WEB APP ENTRY
// =====================================================================================
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('IT Helpdesk')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=5');
}

/**
 * สร้าง/ตรวจสอบ Sheet ทั้งหมด (เรียกจาก Script Editor ครั้งแรกเพื่อขอสิทธิ์ใช้งาน หรือจากหน้า Admin)
 */
function initializeSystem(token) {
  return safe_(function () {
    ensureSchema_(true);
    const ss = getSS_();
    Logger.log('Spreadsheet: ' + ss.getUrl());
    const info = { sheets: Object.keys(SHEET_HEADERS), message: 'ตรวจสอบและสร้าง Sheet เรียบร้อยแล้ว' };
    const sess = getSession_(token);
    if (sess && sess.role === 'Admin' && !sess.mustChange) info.spreadsheetUrl = ss.getUrl();
    return info;
  });
}

/**
 * ข้อมูลเริ่มต้นเมื่อเปิดหน้าเว็บ (ค่าคงที่, การตั้งค่าสาธารณะ, ผู้ใช้ปัจจุบัน)
 */
function getBootstrap(token) {
  return safe_(function () {
    ensureSchema_(false);
    let sess = getSession_(token);
    if (!sess) {
      const email = activeEmail_();
      if (email) {
        const u = getUsersCached_().find(function (x) { return x.Email && x.Email.toLowerCase() === email && isActive_(x); });
        const created = u
          ? createSession_(u, {})
          : createSession_({ UserID: email, Name: email.split('@')[0], Email: email, Role: 'User', Department: '', Phone: '' }, { guest: true });
        sess = getSession_(created.token);
      }
    }
    return {
      token: sess ? sess.token : null,
      user: sess ? publicUser_(sess) : null,
      settings: publicSettings_(),
      meta: {
        appName: CONFIG.APP_NAME,
        appNameEn: CONFIG.APP_NAME_EN,
        slogan: CONFIG.SLOGAN,
        statuses: STATUS_LIST,
        priorities: PRIORITY_LIST,
        urgentPriority: URGENT_PRIORITY,
        types: PROBLEM_TYPES,
        roles: ROLES,
        results: RESULT_OPTIONS,
        maxFiles: CONFIG.MAX_FILES,
        maxFileBytes: CONFIG.MAX_FILE_BYTES,
        maxTotalBytes: CONFIG.MAX_TOTAL_BYTES,
        webAppUrl: webAppUrl_()
      },
      serverTime: now_()
    };
  });
}

// =====================================================================================
// 4) AUTHENTICATION & USERS
// =====================================================================================
function login(identifier, password) {
  return safe_(function () {
    const id = str_(identifier, 120).toLowerCase();
    const pw = String(password == null ? '' : password);
    if (!id || !pw) fail_('กรุณากรอกรหัสผู้ใช้/อีเมล และรหัสผ่าน');
    const cache = CacheService.getScriptCache();
    const key = 'lf_' + Utilities.base64EncodeWebSafe(id).slice(0, 200);
    const fails = parseInt(cache.get(key) || '0', 10);
    if (fails >= 5) fail_('เข้าสู่ระบบผิดพลาดหลายครั้ง กรุณารอ 10 นาทีแล้วลองใหม่', 'LOCKED');
    const u = readTable_('Users').rows.find(function (x) {
      return String(x.UserID).toLowerCase() === id || (x.Email && x.Email.toLowerCase() === id);
    });
    if (!u || !isActive_(u) || !verifyPassword_(pw, u.PasswordHash)) {
      cache.put(key, String(fails + 1), 600);
      fail_('รหัสผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', 'AUTH_FAIL');
    }
    cache.remove(key);
    withLock_(function () {
      const fresh = readTable_('Users').rows.find(function (x) { return x.UserID === u.UserID; });
      if (fresh) { fresh.LastLogin = now_(); writeRow_('Users', fresh, fresh._row); }
    });
    return createSession_(u, { mustChange: pw === CONFIG.DEFAULT_ADMIN_PASSWORD });
  });
}

function logout(token) {
  return safe_(function () {
    if (isToken_(token)) CacheService.getScriptCache().remove('sess_' + token);
    return true;
  });
}

function getCurrentUser(token) {
  return safe_(function () {
    const s = getSession_(token);
    return s ? publicUser_(s) : null;
  });
}

function changePassword(oldPassword, newPassword, token) {
  return safe_(function () {
    const s = getSession_(token);
    if (!s) fail_('กรุณาเข้าสู่ระบบ หรือ Session หมดอายุ', 'AUTH');
    if (s.guest) fail_('บัญชี Google Workspace ที่ไม่ได้ลงทะเบียนในระบบไม่สามารถตั้งรหัสผ่านได้');
    const np = String(newPassword == null ? '' : newPassword);
    if (np.length < 8) fail_('รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร');
    if (np === CONFIG.DEFAULT_ADMIN_PASSWORD) fail_('ไม่สามารถใช้รหัสผ่านเริ่มต้นได้');
    if (!/[A-Za-z]/.test(np) || !/[0-9]/.test(np)) fail_('รหัสผ่านใหม่ต้องประกอบด้วยตัวอักษรและตัวเลข');
    withLock_(function () {
      const u = readTable_('Users').rows.find(function (x) { return x.UserID === s.userId; });
      if (!u) fail_('ไม่พบบัญชีผู้ใช้', 'NOT_FOUND');
      if (u.PasswordHash && !verifyPassword_(String(oldPassword || ''), u.PasswordHash)) fail_('รหัสผ่านเดิมไม่ถูกต้อง');
      u.PasswordHash = hashPassword_(np);
      writeRow_('Users', u, u._row);
    });
    s.mustChange = false;
    saveSession_(s.token, s);
    return publicUser_(s);
  });
}

function getUsers(token) {
  return safe_(function () {
    requireAdmin_(token);
    return readTable_('Users').rows.map(function (u) {
      return {
        userId: u.UserID, name: u.Name, department: u.Department, email: u.Email, phone: u.Phone,
        role: u.Role, status: isActive_(u) ? 'Active' : 'Inactive', hasPassword: !!u.PasswordHash,
        lastLogin: u.LastLogin, lastLoginText: thaiDT_(u.LastLogin)
      };
    });
  });
}

function saveUser(user, token) {
  return safe_(function () {
    const admin = requireAdmin_(token);
    user = user || {};
    const data = {
      UserID: str_(user.userId, 50),
      Name: str_(user.name, 120),
      Department: str_(user.department, 120),
      Email: str_(user.email, 120).toLowerCase(),
      Phone: str_(user.phone, 30),
      Role: str_(user.role, 20),
      Status: str_(user.status, 20) || 'Active'
    };
    if (!/^[A-Za-z0-9._@-]{2,50}$/.test(data.UserID)) fail_('รหัสผู้ใช้ต้องเป็นภาษาอังกฤษ/ตัวเลข 2-50 ตัวอักษร (อนุญาต . _ - @)');
    if (!data.Name) fail_('กรุณากรอกชื่อ-นามสกุล');
    if (ROLES.indexOf(data.Role) < 0) fail_('บทบาทไม่ถูกต้อง');
    if (['Active', 'Inactive'].indexOf(data.Status) < 0) fail_('สถานะผู้ใช้ไม่ถูกต้อง');
    if (data.Email && !isEmail_(data.Email)) fail_('รูปแบบอีเมลไม่ถูกต้อง');
    const pw = String(user.password == null ? '' : user.password);
    if (pw && (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw))) fail_('รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร และมีทั้งตัวอักษรและตัวเลข');
    if (pw === CONFIG.DEFAULT_ADMIN_PASSWORD) fail_('ไม่สามารถใช้รหัสผ่านเริ่มต้นได้');

    let result;
    withLock_(function () {
      const rows = readTable_('Users').rows;
      const existing = rows.find(function (x) { return String(x.UserID).toLowerCase() === data.UserID.toLowerCase(); });
      if (user.isNew && existing) fail_('รหัสผู้ใช้ ' + data.UserID + ' มีอยู่แล้ว');
      if (!user.isNew && !existing) fail_('ไม่พบผู้ใช้ ' + data.UserID, 'NOT_FOUND');
      if (data.Email && rows.some(function (x) { return x !== existing && x.Email && x.Email.toLowerCase() === data.Email; })) {
        fail_('อีเมลนี้ถูกใช้โดยผู้ใช้อื่นแล้ว');
      }
      if (existing && existing.Role === 'Admin' && isActive_(existing) && (data.Role !== 'Admin' || data.Status !== 'Active')) {
        const otherAdmins = rows.filter(function (x) { return x !== existing && x.Role === 'Admin' && isActive_(x); });
        if (!otherAdmins.length) fail_('ต้องมีผู้ดูแลระบบ (Admin) ที่ใช้งานอยู่อย่างน้อย 1 คน');
      }
      if (existing && existing.UserID === admin.userId && data.Status !== 'Active') fail_('ไม่สามารถปิดการใช้งานบัญชีของตนเองได้');
      const obj = existing || { CreatedAt: now_(), PasswordHash: '', LastLogin: '' };
      Object.keys(data).forEach(function (k) { obj[k] = data[k]; });
      if (existing) obj.UserID = existing.UserID;
      if (pw) obj.PasswordHash = hashPassword_(pw);
      writeRow_('Users', obj, existing ? existing._row : null);
      result = { userId: obj.UserID, name: obj.Name, role: obj.Role, status: obj.Status };
    });
    clearUsersCache_();
    return result;
  });
}

function isToken_(t) { return typeof t === 'string' && /^[a-f0-9]{64}$/.test(t); }

function createSession_(user, extra) {
  extra = extra || {};
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').toLowerCase();
  const sess = {
    userId: user.UserID, name: user.Name || user.UserID, email: (user.Email || '').toLowerCase(),
    role: ROLES.indexOf(user.Role) >= 0 ? user.Role : 'User', department: user.Department || '',
    phone: user.Phone || '', mustChange: !!extra.mustChange, guest: !!extra.guest
  };
  saveSession_(token, sess);
  sess.token = token;
  return { token: token, user: publicUser_(sess) };
}

function saveSession_(token, sess) {
  const copy = {};
  Object.keys(sess).forEach(function (k) { if (k !== 'token') copy[k] = sess[k]; });
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify(copy), CONFIG.SESSION_SECONDS);
}

function getSession_(token) {
  if (!isToken_(token)) return null;
  const cache = CacheService.getScriptCache();
  const raw = cache.get('sess_' + token);
  if (!raw) return null;
  let s;
  try { s = JSON.parse(raw); } catch (e) { return null; }
  if (!s.guest) {
    const u = getUsersCached_().find(function (x) { return x.UserID === s.userId; });
    if (!u || !isActive_(u)) { cache.remove('sess_' + token); return null; }
    s.role = ROLES.indexOf(u.Role) >= 0 ? u.Role : 'User';
    s.name = u.Name || u.UserID;
    s.email = (u.Email || '').toLowerCase();
    s.department = u.Department || '';
    s.phone = u.Phone || '';
  }
  saveSession_(token, s); // sliding expiration
  s.token = token;
  return s;
}

function requireAuth_(token) {
  const s = getSession_(token);
  if (!s) fail_('กรุณาเข้าสู่ระบบ หรือ Session หมดอายุ', 'AUTH');
  if (s.mustChange) fail_('กรุณาเปลี่ยนรหัสผ่านเริ่มต้นก่อนใช้งาน', 'MUST_CHANGE');
  return s;
}

function requireRole_(token, roles) {
  const s = requireAuth_(token);
  if (roles.indexOf(s.role) < 0) fail_('คุณไม่มีสิทธิ์ดำเนินการนี้', 'FORBIDDEN');
  return s;
}

function requireStaff_(token) { return requireRole_(token, ['Admin', 'IT Staff']); }
function requireAdmin_(token) { return requireRole_(token, ['Admin']); }
function isStaffRole_(role) { return role === 'Admin' || role === 'IT Staff'; }
function isActive_(u) { return ['active', 'ใช้งาน', 'true'].indexOf(String(u.Status || '').trim().toLowerCase()) >= 0; }

function publicUser_(s) {
  return {
    userId: s.userId, name: s.name, email: s.email, role: s.role, department: s.department,
    phone: s.phone, guest: !!s.guest, mustChange: !!s.mustChange,
    isStaff: isStaffRole_(s.role), isAdmin: s.role === 'Admin'
  };
}

function getUsersCached_() {
  if (_usersCache) return _usersCache;
  const cache = CacheService.getScriptCache();
  const raw = cache.get('users_v1');
  if (raw) {
    try { _usersCache = JSON.parse(raw); return _usersCache; } catch (e) { /* rebuild */ }
  }
  _usersCache = readTable_('Users').rows.map(function (u) {
    return { UserID: u.UserID, Name: u.Name, Department: u.Department, Email: u.Email, Phone: u.Phone, Role: u.Role, Status: u.Status };
  });
  try { cache.put('users_v1', JSON.stringify(_usersCache), 300); } catch (e) { /* too large: skip cache */ }
  return _usersCache;
}

function clearUsersCache_() {
  _usersCache = null;
  CacheService.getScriptCache().remove('users_v1');
}

function activeEmail_() {
  try { return String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) { return ''; }
}

function hashPassword_(pw, salt) {
  salt = salt || Utilities.getUuid().replace(/-/g, '');
  let h = salt + '|' + pw;
  for (let i = 0; i < 200; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8));
  }
  return salt + ':' + h;
}

function verifyPassword_(pw, stored) {
  if (!stored || String(stored).indexOf(':') < 0) return false;
  const salt = String(stored).split(':')[0];
  return hashPassword_(pw, salt) === String(stored);
}

function ensureDefaultAdmin_() {
  const t = readTable_('Users');
  if (t.rows.some(function (u) { return u.Role === 'Admin' && isActive_(u); })) return;
  let email = '';
  try { email = String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (e) { /* ignore */ }
  const existing = t.rows.find(function (u) { return String(u.UserID).toLowerCase() === CONFIG.DEFAULT_ADMIN_ID; });
  const admin = existing || {};
  admin.UserID = CONFIG.DEFAULT_ADMIN_ID;
  admin.Name = admin.Name || 'ผู้ดูแลระบบ';
  admin.Department = admin.Department || 'งานเทคโนโลยีสารสนเทศ';
  admin.Email = admin.Email || (t.rows.some(function (u) { return u.Email && u.Email.toLowerCase() === email; }) ? '' : email);
  admin.Phone = admin.Phone || '';
  admin.Role = 'Admin';
  admin.Status = 'Active';
  admin.PasswordHash = hashPassword_(CONFIG.DEFAULT_ADMIN_PASSWORD);
  admin.CreatedAt = admin.CreatedAt || now_();
  writeRow_('Users', admin, existing ? existing._row : null);
  clearUsersCache_();
}

// =====================================================================================
// 5) TICKETS
// =====================================================================================
function generateTicketId() {
  return safe_(function () { return computeNextTicketId_().id; });
}

function computeNextTicketId_() {
  const ymd = fmtDate_(new Date(), 'yyyyMMdd');
  const prefix = 'IT-' + ymd + '-';
  let max = 0;
  readTable_('Tickets').rows.forEach(function (r) {
    if (String(r.TicketID).indexOf(prefix) === 0) {
      const n = parseInt(String(r.TicketID).slice(prefix.length), 10);
      if (n > max) max = n;
    }
  });
  const last = parseInt(getProps_()['SEQ_' + ymd] || '0', 10);
  const next = Math.max(max, last) + 1;
  return { id: prefix + (next < 10000 ? ('0000' + next).slice(-4) : String(next)), seq: next, ymd: ymd };
}

/** ต้องเรียกภายใน withLock_ เท่านั้น */
function generateTicketId_() {
  const n = computeNextTicketId_();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SEQ_' + n.ymd, String(n.seq));
  Object.keys(getProps_()).forEach(function (k) {
    if (/^SEQ_\d{8}$/.test(k) && k !== 'SEQ_' + n.ymd) props.deleteProperty(k);
  });
  _props = null;
  return n.id;
}

function createTicket(data, token) {
  return safe_(function () {
    data = data || {};
    if (data.website) fail_('ไม่สามารถบันทึกข้อมูลได้'); // honeypot กันบอท
    const sess = getSession_(token);
    if (sess && sess.mustChange) fail_('กรุณาเปลี่ยนรหัสผ่านเริ่มต้นก่อนใช้งาน', 'MUST_CHANGE');
    if (!sess && String(getSettingsMap_().ALLOW_GUEST_REPORT).toUpperCase() === 'FALSE') {
      fail_('กรุณาเข้าสู่ระบบก่อนแจ้งปัญหา', 'AUTH');
    }
    const input = validateTicketInput_(data, false);
    const files = validateFiles_(data.attachments);

    const cache = CacheService.getScriptCache();
    const rk = 'rl_' + input.Phone.replace(/\D/g, '');
    const cnt = parseInt(cache.get(rk) || '0', 10);
    if (cnt >= 15) fail_('มีการแจ้งปัญหาจากหมายเลขนี้บ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่', 'RATE_LIMIT');
    cache.put(rk, String(cnt + 1), 3600);

    let ticket;
    withLock_(function () {
      const id = generateTicketId_();
      const ts = now_();
      ticket = {};
      SHEET_HEADERS.Tickets.forEach(function (h) { ticket[h] = ''; });
      Object.keys(input).forEach(function (k) { ticket[k] = input[k]; });
      ticket.TicketID = id;
      ticket.CreatedAt = ts;
      ticket.Status = STATUS.NEW;
      ticket.Cost = '0';
      ticket.LastUpdated = ts;
      ticket.CreatedBy = sess ? (sess.email || sess.userId) : '';
      if (sess && !input.ReporterID && !sess.guest) ticket.ReporterID = sess.userId;
      if (sess && !input.Email && sess.email) ticket.Email = sess.email;
      writeRow_('Tickets', ticket);
      addHistory_(id, 'แจ้งปัญหา', '', STATUS.NEW, input.ReporterName, 'ความเร่งด่วน: ' + priorityLabel_(input.Priority));
    });

    let warning = '';
    if (files.length) {
      const urls = [];
      files.forEach(function (f, i) {
        try { urls.push(saveFileToDrive_(f, ticket.TicketID, i + 1).url); }
        catch (e) { warning = 'ไม่สามารถบันทึกไฟล์แนบบางไฟล์ได้: ' + e.message; }
      });
      if (urls.length) {
        withLock_(function () {
          const row = getTicketRow_(ticket.TicketID);
          row.AttachmentURL = urls.join('\n');
          writeRow_('Tickets', row, row._row);
          ticket.AttachmentURL = row.AttachmentURL;
        });
      }
    }

    invalidateCache_();
    notifyEvent_(ticket.Priority === URGENT_PRIORITY ? 'URGENT' : 'NEW', ticket, {});

    return {
      ticketId: ticket.TicketID,
      createdAt: ticket.CreatedAt,
      createdAtText: thaiDT_(ticket.CreatedAt),
      reporterName: ticket.ReporterName,
      problemType: ticket.ProblemType,
      problemTitle: ticket.ProblemTitle,
      priority: ticket.Priority,
      status: ticket.Status,
      attachmentCount: parseAttachments_(ticket.AttachmentURL).length,
      warning: warning
    };
  });
}

function getTicketById(ticketId, token, verify) {
  return safe_(function () {
    const id = normalizeTicketId_(ticketId);
    const sess = getSession_(token);
    const row = getTicketRow_(id);
    let access = 'public';
    const staff = sess && !sess.mustChange && isStaffRole_(sess.role);
    if (staff) access = 'staff';
    else if (isOwner_(row, sess, '')) access = 'owner';
    let verifyFailed = false;
    if (!staff && access === 'public' && str_(verify, 120)) {
      checkVerifyRate_(id);
      if (isOwner_(row, null, verify)) access = 'owner';
      else { verifyFailed = true; bumpVerifyRate_(id); }
    }
    const isOwner = access === 'owner' || (staff && isOwner_(row, sess, ''));
    return {
      access: access,
      verifyFailed: verifyFailed,
      ticket: ticketView_(row, access),
      timeline: buildTimeline_(id, access),
      workLogs: access === 'public' ? [] : getWorkLogs_(id),
      canRate: [STATUS.RESOLVED, STATUS.CLOSED].indexOf(row.Status) >= 0 && !row.Rating,
      needVerify: !isOwner,
      assignees: staff ? getAssigneeOptions_() : []
    };
  });
}

function getTickets(params, token) {
  return safe_(function () {
    requireStaff_(token);
    const p = params || {};
    const all = readTable_('Tickets').rows;
    const statusCounts = { all: all.length, urgent: 0 };
    STATUS_LIST.forEach(function (s) { statusCounts[s.value] = 0; });
    const buildings = {}, assignees = {};
    all.forEach(function (r) {
      if (statusCounts[r.Status] != null) statusCounts[r.Status]++;
      if (isUrgentOpen_(r)) statusCounts.urgent++;
      if (r.Building) buildings[r.Building] = 1;
      if (r.AssignedTo) assignees[r.AssignedTo] = 1;
    });
    const rows = filterTickets_(all, p);
    sortTickets_(rows, p.sort);
    const page = paginate_(rows, p.page, p.pageSize);
    return {
      items: page.items.map(ticketListItem_),
      total: page.total, page: page.page, pageSize: page.pageSize, totalPages: page.totalPages,
      statusCounts: statusCounts,
      buildings: Object.keys(buildings).sort(),
      assignees: Object.keys(assignees).sort()
    };
  });
}

function getMyTickets(params, token) {
  return safe_(function () {
    const p = params || {};
    const sess = getSession_(token);
    if (sess && sess.mustChange) fail_('กรุณาเปลี่ยนรหัสผ่านเริ่มต้นก่อนใช้งาน', 'MUST_CHANGE');
    const all = readTable_('Tickets').rows;
    let rows;
    let mode;
    if (sess) {
      mode = 'account';
      rows = all.filter(function (r) { return isOwner_(r, sess, ''); });
    } else {
      mode = 'verify';
      const key = str_(p.reporterKey, 120).toLowerCase();
      const phone = str_(p.phone, 30).replace(/\D/g, '');
      if (!key || phone.length < 6) fail_('กรุณากรอกรหัสผู้แจ้งหรืออีเมล และเบอร์โทรศัพท์ที่ใช้แจ้งปัญหา');
      const rk = 'mt_' + Utilities.base64EncodeWebSafe(key).slice(0, 100);
      const cache = CacheService.getScriptCache();
      const tries = parseInt(cache.get(rk) || '0', 10);
      if (tries >= 20) fail_('ค้นหาบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่', 'RATE_LIMIT');
      cache.put(rk, String(tries + 1), 600);
      rows = all.filter(function (r) {
        const idMatch = (r.ReporterID && r.ReporterID.toLowerCase() === key) || (r.Email && r.Email.toLowerCase() === key);
        return idMatch && String(r.Phone).replace(/\D/g, '') === phone;
      });
    }
    if (p.status) rows = rows.filter(function (r) { return p.status === '__open' ? OPEN_STATUSES.indexOf(r.Status) >= 0 : r.Status === p.status; });
    sortTickets_(rows, 'newest');
    const page = paginate_(rows, p.page, p.pageSize || 10);
    return {
      mode: mode,
      items: page.items.map(ticketListItem_),
      total: page.total, page: page.page, pageSize: page.pageSize, totalPages: page.totalPages
    };
  });
}

/** ข้อมูลโดยย่อ (ไม่มีข้อมูลส่วนบุคคล) ของ Ticket ที่แจ้งจากอุปกรณ์นี้ */
function getTicketsBrief(ids) {
  return safe_(function () {
    const list = (Array.isArray(ids) ? ids : []).slice(0, 20).map(function (x) { return str_(x, 30).toUpperCase(); })
      .filter(function (x) { return /^IT-\d{8}-\d{4,6}$/.test(x); });
    const rows = readTable_('Tickets').rows;
    return list.map(function (id) {
      const r = rows.find(function (x) { return x.TicketID === id; });
      if (!r) return null;
      return {
        TicketID: r.TicketID, ProblemTitle: r.ProblemTitle, ProblemType: r.ProblemType, Status: r.Status,
        Priority: r.Priority, createdAtText: thaiDT_(r.CreatedAt), Room: r.Room, Building: r.Building
      };
    }).filter(Boolean);
  });
}

function updateTicket(ticketId, data, token) {
  return safe_(function () {
    const sess = requireStaff_(token);
    const id = normalizeTicketId_(ticketId);
    const input = validateTicketInput_(data || {}, true);
    const labels = {
      ReporterID: 'รหัสผู้แจ้ง', ReporterName: 'ชื่อผู้แจ้ง', Department: 'แผนก', Phone: 'เบอร์โทร', Email: 'อีเมล',
      Building: 'อาคาร', Floor: 'ชั้น', Room: 'ห้อง', InstallPoint: 'จุดติดตั้ง', AssetID: 'หมายเลขครุภัณฑ์',
      ProblemType: 'ประเภทปัญหา', ProblemTitle: 'หัวข้อปัญหา', ProblemDetail: 'รายละเอียด', Priority: 'ความเร่งด่วน'
    };
    let row, changed = [], oldPriority;
    withLock_(function () {
      row = getTicketRow_(id);
      if (FINAL_STATUSES.indexOf(row.Status) >= 0 && sess.role !== 'Admin') fail_('Ticket ที่ปิด/ยกเลิกแล้ว แก้ไขได้เฉพาะ Admin', 'FORBIDDEN');
      oldPriority = row.Priority;
      Object.keys(input).forEach(function (k) {
        if (String(row[k] || '') !== String(input[k])) { row[k] = input[k]; changed.push(labels[k] || k); }
      });
      if (!changed.length) fail_('ไม่มีข้อมูลที่เปลี่ยนแปลง');
      row.LastUpdated = now_();
      writeRow_('Tickets', row, row._row);
      addHistory_(id, 'แก้ไขข้อมูล Ticket', row.Status, row.Status, sess.name, 'แก้ไข: ' + changed.join(', '));
    });
    invalidateCache_();
    if (row.Priority === URGENT_PRIORITY && oldPriority !== URGENT_PRIORITY && OPEN_STATUSES.indexOf(row.Status) >= 0) {
      notifyEvent_('URGENT', row, { escalated: true, by: sess.name });
    }
    return { ticketId: id, changed: changed };
  });
}

function acceptTicket(ticketId, note, token) {
  return safe_(function () {
    const sess = requireStaff_(token);
    const id = normalizeTicketId_(ticketId);
    const n = str_(note, 1000);
    let row;
    withLock_(function () {
      row = getTicketRow_(id);
      if (row.Status !== STATUS.NEW) fail_('Ticket นี้ถูกรับเรื่องไปแล้ว (สถานะปัจจุบัน: ' + row.Status + ')');
      applyStatus_(row, STATUS.ACCEPTED, sess, now_());
      if (!row.AssignedTo) { row.AssignedTo = sess.name; row.AssignedAt = row.LastUpdated; }
      writeRow_('Tickets', row, row._row);
      addHistory_(id, 'รับเรื่อง', STATUS.NEW, STATUS.ACCEPTED, sess.name, n || ('ผู้รับผิดชอบ: ' + row.AssignedTo));
    });
    invalidateCache_();
    notifyEvent_('ACCEPT', row, { from: STATUS.NEW, to: STATUS.ACCEPTED, note: n, by: sess.name });
    return ticketListItem_(row);
  });
}

function assignTicket(ticketId, staff, note, token) {
  return safe_(function () {
    const sess = requireStaff_(token);
    const id = normalizeTicketId_(ticketId);
    const name = str_(staff, 120);
    const n = str_(note, 1000);
    if (!name) fail_('กรุณาเลือกผู้รับผิดชอบ');
    if (getAssigneeOptions_().indexOf(name) < 0) fail_('ไม่พบผู้รับผิดชอบนี้ในรายชื่อที่กำหนด');
    let row, from;
    withLock_(function () {
      row = getTicketRow_(id);
      if (FINAL_STATUSES.indexOf(row.Status) >= 0) fail_('ไม่สามารถมอบหมาย Ticket ที่ปิดหรือยกเลิกแล้ว');
      from = row.Status;
      const ts = now_();
      row.AssignedTo = name;
      row.AssignedAt = ts;
      if (row.Status === STATUS.NEW) applyStatus_(row, STATUS.ACCEPTED, sess, ts);
      row.LastUpdated = ts;
      writeRow_('Tickets', row, row._row);
      addHistory_(id, 'มอบหมายงาน', from, row.Status, sess.name, 'มอบหมายให้: ' + name + (n ? ' — ' + n : ''));
    });
    invalidateCache_();
    notifyEvent_('ASSIGN', row, { from: from, to: row.Status, staff: name, note: n, by: sess.name });
    return ticketListItem_(row);
  });
}

function updateTicketStatus(ticketId, status, note, token) {
  return safe_(function () {
    const sess = requireStaff_(token);
    const id = normalizeTicketId_(ticketId);
    const st = str_(status, 40);
    const n = str_(note, 1000);
    if (!STATUS_LIST.some(function (s) { return s.value === st; })) fail_('สถานะไม่ถูกต้อง');
    if (st === STATUS.CLOSED) fail_('กรุณาใช้แท็บ "ปิดงาน" เพื่อกรอกข้อมูลการปิดงาน');
    if (st === STATUS.CANCELLED && !n) fail_('กรุณาระบุเหตุผลการยกเลิกในช่องหมายเหตุ');
    let row, from;
    withLock_(function () {
      row = getTicketRow_(id);
      from = row.Status;
      if (from === st) fail_('Ticket อยู่ในสถานะ "' + st + '" อยู่แล้ว');
      if (FINAL_STATUSES.indexOf(from) >= 0 && sess.role !== 'Admin') fail_('Ticket นี้ปิด/ยกเลิกแล้ว เฉพาะ Admin เท่านั้นที่เปิดงานใหม่ได้', 'FORBIDDEN');
      applyStatus_(row, st, sess, now_());
      writeRow_('Tickets', row, row._row);
      addHistory_(id, FINAL_STATUSES.indexOf(from) >= 0 ? 'เปิดงานใหม่' : (STATUS_ACTION[st] || 'เปลี่ยนสถานะ'), from, st, sess.name, n);
    });
    invalidateCache_();
    const event = st === STATUS.RESOLVED ? 'RESOLVED' : (st === STATUS.ACCEPTED ? 'ACCEPT' : 'STATUS');
    notifyEvent_(event, row, { from: from, to: st, note: n, by: sess.name });
    return ticketListItem_(row);
  });
}

function addWorkLog(data, token) {
  return safe_(function () {
    const sess = requireStaff_(token);
    data = data || {};
    const id = normalizeTicketId_(data.ticketId);
    const action = str_(data.action, 2000);
    if (!action) fail_('กรุณากรอกรายละเอียดการดำเนินการ');
    const parts = str_(data.parts, 500);
    const cost = parseCost_(data.cost);
    const note = str_(data.note, 1000);
    let row, from, statusChanged = false, log;
    withLock_(function () {
      row = getTicketRow_(id);
      if (row.Status === STATUS.CANCELLED) fail_('ไม่สามารถบันทึก Work Log ใน Ticket ที่ยกเลิกแล้ว');
      const ts = now_();
      log = { LogID: 'LOG-' + fmtDate_(new Date(), 'yyyyMMddHHmmss') + '-' + randomCode_(4), TicketID: id, DateTime: ts, Staff: sess.name, Action: action, Parts: parts, Cost: String(cost), Note: note };
      writeRow_('WorkLogs', log);
      const total = readTable_('WorkLogs').rows.reduce(function (sum, l) {
        return l.TicketID === id ? sum + (parseFloat(l.Cost) || 0) : sum;
      }, 0);
      row.Cost = String(Math.round(total * 100) / 100);
      from = row.Status;
      if (data.setInProgress && (row.Status === STATUS.NEW || row.Status === STATUS.ACCEPTED)) {
        applyStatus_(row, STATUS.IN_PROGRESS, sess, ts);
        statusChanged = true;
        addHistory_(id, 'กำลังดำเนินการ', from, STATUS.IN_PROGRESS, sess.name, 'เริ่มดำเนินการ (จาก Work Log)');
      }
      row.LastUpdated = ts;
      writeRow_('Tickets', row, row._row);
    });
    invalidateCache_();
    if (statusChanged) notifyEvent_('STATUS', row, { from: from, to: STATUS.IN_PROGRESS, note: action, by: sess.name });
    return { log: log, totalCost: row.Cost };
  });
}

function closeTicket(ticketId, data, token) {
  return safe_(function () {
    const sess = requireStaff_(token);
    const id = normalizeTicketId_(ticketId);
    data = data || {};
    const resolution = str_(data.resolution, 2000);
    const rootCause = str_(data.rootCause, 1000);
    const result = str_(data.result, 300);
    const note = str_(data.note, 1000);
    const missing = [];
    if (!resolution) missing.push('วิธีการแก้ไข');
    if (!rootCause) missing.push('สาเหตุของปัญหา');
    if (!result) missing.push('ผลการดำเนินงาน');
    if (missing.length) fail_('กรุณากรอก: ' + missing.join(', '));
    let row, from;
    withLock_(function () {
      row = getTicketRow_(id);
      from = row.Status;
      if (FINAL_STATUSES.indexOf(from) >= 0) fail_('Ticket นี้ปิดหรือยกเลิกไปแล้ว');
      applyStatus_(row, STATUS.CLOSED, sess, now_());
      row.Resolution = resolution;
      row.RootCause = rootCause;
      row.Result = result;
      row.CloseNote = note;
      row.ClosedBy = sess.name;
      if (!row.AssignedTo) { row.AssignedTo = sess.name; row.AssignedAt = row.ClosedAt; }
      writeRow_('Tickets', row, row._row);
      addHistory_(id, 'ปิดงาน', from, STATUS.CLOSED, sess.name, 'วิธีแก้ไข: ' + resolution + '\nสาเหตุ: ' + rootCause + '\nผล: ' + result + (note ? '\nหมายเหตุ: ' + note : ''));
    });
    invalidateCache_();
    notifyEvent_('CLOSED', row, { from: from, to: STATUS.CLOSED, note: note, by: sess.name });
    return ticketListItem_(row);
  });
}

function submitRating(ticketId, rating, feedback, verify, token) {
  return safe_(function () {
    const id = normalizeTicketId_(ticketId);
    const r = parseInt(rating, 10);
    if (!(r >= 1 && r <= 5)) fail_('กรุณาให้คะแนน 1–5 ดาว');
    const fb = str_(feedback, 1000);
    const sess = getSession_(token);
    let row;
    withLock_(function () {
      row = getTicketRow_(id);
      if ([STATUS.RESOLVED, STATUS.CLOSED].indexOf(row.Status) < 0) fail_('สามารถประเมินได้เมื่อ Ticket แก้ไขแล้วหรือปิดงานแล้วเท่านั้น');
      if (row.Rating) fail_('Ticket นี้ได้รับการประเมินแล้ว ขอบคุณค่ะ/ครับ');
      if (!isOwner_(row, sess, '')) {
        checkVerifyRate_(id);
        if (!isOwner_(row, null, verify)) {
          bumpVerifyRate_(id);
          fail_('ข้อมูลยืนยันตัวตนไม่ถูกต้อง กรุณากรอกเบอร์โทรศัพท์หรืออีเมลที่ใช้แจ้งปัญหา', 'VERIFY');
        }
      }
      const ts = now_();
      row.Rating = String(r);
      row.Feedback = fb;
      row.RatedAt = ts;
      row.LastUpdated = ts;
      writeRow_('Tickets', row, row._row);
      addHistory_(id, 'ประเมินความพึงพอใจ', row.Status, row.Status, row.ReporterName, stars_(r) + (fb ? ' — ' + fb : ''));
    });
    invalidateCache_();
    notifyEvent_('RATING', row, { rating: r, feedback: fb });
    return { ticketId: id, rating: r };
  });
}

/** อัปโหลดไฟล์แนบเพิ่มเติม (เจ้าหน้าที่) data = {ticketId, name, mimeType, data(base64)} */
function uploadAttachment(data, token) {
  return safe_(function () {
    const sess = requireStaff_(token);
    data = data || {};
    const id = normalizeTicketId_(data.ticketId);
    getTicketRow_(id);
    const files = validateFiles_([data]);
    if (!files.length) fail_('ไม่พบไฟล์ที่ต้องการอัปโหลด');
    const saved = saveFileToDrive_(files[0], id, fmtDate_(new Date(), 'HHmmss'));
    withLock_(function () {
      const row = getTicketRow_(id);
      const list = parseAttachments_(row.AttachmentURL).map(function (a) { return a.url; });
      list.push(saved.url);
      row.AttachmentURL = list.join('\n');
      row.LastUpdated = now_();
      writeRow_('Tickets', row, row._row);
      addHistory_(id, 'แนบไฟล์เพิ่มเติม', row.Status, row.Status, sess.name, saved.name);
    });
    return saved;
  });
}

// ---------- Ticket helpers ----------
function validateTicketInput_(d, partial) {
  const map = {
    ReporterID: ['reporterId', 50], ReporterName: ['reporterName', 120], Department: ['department', 120],
    Phone: ['phone', 30], Email: ['email', 120], Building: ['building', 100], Floor: ['floor', 30],
    Room: ['room', 100], InstallPoint: ['installPoint', 150], AssetID: ['assetId', 60],
    ProblemType: ['problemType', 50], ProblemTitle: ['problemTitle', 200], ProblemDetail: ['problemDetail', 5000],
    Priority: ['priority', 30]
  };
  const labels = {
    ReporterName: 'ชื่อ-นามสกุล', Department: 'กลุ่มสาระ/ฝ่าย/แผนก', Phone: 'เบอร์โทรศัพท์', Building: 'อาคาร',
    Room: 'ห้อง', ProblemType: 'ประเภทปัญหา', ProblemTitle: 'หัวข้อปัญหา', ProblemDetail: 'รายละเอียดปัญหา', Priority: 'ระดับความเร่งด่วน'
  };
  const out = {};
  Object.keys(map).forEach(function (k) {
    const src = map[k][0];
    if (partial && !(src in d)) return;
    out[k] = str_(d[src], map[k][1]);
  });
  if (out.Email != null) out.Email = out.Email.toLowerCase();
  const missing = Object.keys(labels).filter(function (k) { return (!partial || k in out) && !out[k]; });
  if (missing.length) fail_('กรุณากรอกข้อมูลให้ครบถ้วน: ' + missing.map(function (k) { return labels[k]; }).join(', '));
  if (out.Phone != null) {
    if (!/^[0-9+\-\s().]{6,20}$/.test(out.Phone) || out.Phone.replace(/\D/g, '').length < 6) fail_('รูปแบบเบอร์โทรศัพท์ไม่ถูกต้อง');
  }
  if (out.Email && !isEmail_(out.Email)) fail_('รูปแบบอีเมลไม่ถูกต้อง');
  if (out.ProblemType != null && !PROBLEM_TYPES.some(function (t) { return t.value === out.ProblemType; })) fail_('ประเภทปัญหาไม่ถูกต้อง');
  if (out.Priority != null && !PRIORITY_LIST.some(function (p) { return p.value === out.Priority; })) fail_('ระดับความเร่งด่วนไม่ถูกต้อง');
  if (out.ProblemTitle != null && out.ProblemTitle.length < 3) fail_('หัวข้อปัญหาสั้นเกินไป');
  return out;
}

function validateFiles_(list) {
  if (!list) return [];
  if (!Array.isArray(list)) fail_('รูปแบบไฟล์แนบไม่ถูกต้อง');
  if (list.length > CONFIG.MAX_FILES) fail_('แนบไฟล์ได้สูงสุด ' + CONFIG.MAX_FILES + ' ไฟล์');
  let total = 0;
  return list.map(function (f) {
    f = f || {};
    const name = str_(f.name, 150).replace(/[\\/:*?"<>|#%]/g, '_') || 'file';
    const mime = str_(f.mimeType, 120).toLowerCase();
    let b64 = String(f.data || '');
    const comma = b64.indexOf('base64,');
    if (comma >= 0) b64 = b64.slice(comma + 7);
    if (!b64 || !/^[A-Za-z0-9+/=\r\n]+$/.test(b64)) fail_('ข้อมูลไฟล์ ' + name + ' ไม่ถูกต้อง');
    if (!ALLOWED_MIME.test(mime)) fail_('ไม่รองรับไฟล์ประเภท ' + (mime || 'ไม่ทราบ') + ' (' + name + ')');
    const size = Math.floor(b64.replace(/[\r\n=]/g, '').length * 3 / 4);
    if (size > CONFIG.MAX_FILE_BYTES) fail_('ไฟล์ ' + name + ' มีขนาดเกิน ' + Math.round(CONFIG.MAX_FILE_BYTES / 1048576) + ' MB');
    total += size;
    if (total > CONFIG.MAX_TOTAL_BYTES) fail_('ขนาดไฟล์แนบรวมเกิน ' + Math.round(CONFIG.MAX_TOTAL_BYTES / 1048576) + ' MB');
    return { name: name, mimeType: mime, data: b64 };
  });
}

function normalizeTicketId_(id) {
  const s = str_(id, 30).toUpperCase();
  if (!/^IT-\d{8}-\d{4,6}$/.test(s)) fail_('รูปแบบ Ticket ID ไม่ถูกต้อง (ตัวอย่าง: IT-20260909-0001)', 'INVALID_ID');
  return s;
}

function getTicketRow_(id) {
  const r = readTable_('Tickets').rows.find(function (x) { return x.TicketID === id; });
  if (!r) fail_('ไม่พบ Ticket ' + id, 'NOT_FOUND');
  return r;
}

function applyStatus_(row, st, sess, ts) {
  if (st !== STATUS.NEW && st !== STATUS.CANCELLED && !row.AcceptedAt) row.AcceptedAt = ts;
  if ([STATUS.IN_PROGRESS, STATUS.WAITING, STATUS.RESOLVED, STATUS.CLOSED].indexOf(st) >= 0 && !row.StartedAt) row.StartedAt = ts;
  if (st === STATUS.RESOLVED) row.ResolvedAt = ts;
  if (st === STATUS.CLOSED) { if (!row.ResolvedAt) row.ResolvedAt = ts; row.ClosedAt = ts; }
  if (OPEN_STATUSES.indexOf(st) >= 0) { row.ResolvedAt = ''; row.ClosedAt = ''; }
  if ((st === STATUS.ACCEPTED || st === STATUS.IN_PROGRESS) && !row.AssignedTo) { row.AssignedTo = sess.name; row.AssignedAt = ts; }
  row.Status = st;
  row.LastUpdated = ts;
}

function isOwner_(row, sess, verify) {
  if (sess && !sess.mustChange) {
    const em = String(sess.email || '').toLowerCase();
    if (em && row.Email && row.Email.toLowerCase() === em) return true;
    if (em && row.CreatedBy && row.CreatedBy.toLowerCase() === em) return true;
    if (!sess.guest && sess.userId && row.ReporterID && row.ReporterID.toLowerCase() === String(sess.userId).toLowerCase()) return true;
    if (!sess.guest && sess.userId && row.CreatedBy && row.CreatedBy.toLowerCase() === String(sess.userId).toLowerCase()) return true;
  }
  const v = str_(verify, 120).toLowerCase();
  if (!v) return false;
  if (row.Email && v === row.Email.toLowerCase()) return true;
  const digits = v.replace(/\D/g, '');
  return digits.length >= 6 && digits === String(row.Phone || '').replace(/\D/g, '');
}

function checkVerifyRate_(id) {
  const n = parseInt(CacheService.getScriptCache().get('vf_' + id) || '0', 10);
  if (n >= 10) fail_('ยืนยันตัวตนผิดหลายครั้ง กรุณารอ 10 นาทีแล้วลองใหม่', 'RATE_LIMIT');
}

function bumpVerifyRate_(id) {
  const cache = CacheService.getScriptCache();
  const n = parseInt(cache.get('vf_' + id) || '0', 10);
  cache.put('vf_' + id, String(n + 1), 600);
}

function isUrgentOpen_(r) { return r.Priority === URGENT_PRIORITY && OPEN_STATUSES.indexOf(r.Status) >= 0; }

function filterTickets_(rows, p) {
  const q = str_(p.search, 100).toLowerCase();
  const status = str_(p.status, 40);
  const type = str_(p.type, 50);
  const priority = str_(p.priority, 30);
  const reporter = str_(p.reporter, 100).toLowerCase();
  const building = str_(p.building, 100).toLowerCase();
  const assignee = str_(p.assignedTo, 120);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(p.dateFrom || '') ? p.dateFrom : '';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(p.dateTo || '') ? p.dateTo : '';
  const fields = ['TicketID', 'ReporterName', 'ReporterID', 'Room', 'Building', 'ProblemType', 'ProblemTitle', 'ProblemDetail', 'AssignedTo', 'AssetID', 'Department', 'InstallPoint'];
  return rows.filter(function (r) {
    if (status) {
      if (status === '__open') { if (OPEN_STATUSES.indexOf(r.Status) < 0) return false; }
      else if (status === '__pending') { if ([STATUS.NEW, STATUS.ACCEPTED].indexOf(r.Status) < 0) return false; }
      else if (status === '__inprogress') { if ([STATUS.IN_PROGRESS, STATUS.WAITING].indexOf(r.Status) < 0) return false; }
      else if (status === '__urgent') { if (!isUrgentOpen_(r)) return false; }
      else if (r.Status !== status) return false;
    }
    if (type && r.ProblemType !== type) return false;
    if (priority && r.Priority !== priority) return false;
    if (reporter && (String(r.ReporterName) + ' ' + String(r.ReporterID)).toLowerCase().indexOf(reporter) < 0) return false;
    if (building && String(r.Building).toLowerCase().indexOf(building) < 0) return false;
    if (assignee) {
      if (assignee === '__none') { if (r.AssignedTo) return false; }
      else if (r.AssignedTo !== assignee) return false;
    }
    const d = String(r.CreatedAt).slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (q) {
      let hit = false;
      for (let i = 0; i < fields.length; i++) {
        if (String(r[fields[i]] || '').toLowerCase().indexOf(q) >= 0) { hit = true; break; }
      }
      if (!hit) return false;
    }
    return true;
  });
}

function sortTickets_(rows, sort) {
  const plevel = {};
  PRIORITY_LIST.forEach(function (p) { plevel[p.value] = p.level; });
  rows.sort(function (a, b) {
    if (sort !== 'oldest' && sort !== 'newest') {
      const ua = isUrgentOpen_(a) ? 1 : 0, ub = isUrgentOpen_(b) ? 1 : 0;
      if (ua !== ub) return ub - ua;
      if (sort === 'priority') {
        const pa = plevel[a.Priority] || 0, pb = plevel[b.Priority] || 0;
        if (pa !== pb) return pb - pa;
      }
    }
    if (sort === 'oldest') return String(a.CreatedAt) < String(b.CreatedAt) ? -1 : 1;
    return String(a.CreatedAt) < String(b.CreatedAt) ? 1 : -1;
  });
}

function paginate_(rows, page, pageSize) {
  const size = [5, 10, 20, 50, 100].indexOf(parseInt(pageSize, 10)) >= 0 ? parseInt(pageSize, 10) : 20;
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const pg = Math.min(Math.max(1, parseInt(page, 10) || 1), totalPages);
  return { items: rows.slice((pg - 1) * size, pg * size), total: total, page: pg, pageSize: size, totalPages: totalPages };
}

function ticketListItem_(r) {
  return {
    TicketID: r.TicketID, CreatedAt: r.CreatedAt, createdAtText: thaiDT_(r.CreatedAt),
    ReporterName: r.ReporterName, Department: r.Department, Building: r.Building, Floor: r.Floor, Room: r.Room,
    ProblemType: r.ProblemType, ProblemTitle: r.ProblemTitle, Priority: r.Priority, Status: r.Status,
    AssignedTo: r.AssignedTo, Rating: r.Rating, LastUpdated: r.LastUpdated, lastUpdatedText: thaiDT_(r.LastUpdated),
    hasAttachment: !!r.AttachmentURL, isUrgent: isUrgentOpen_(r)
  };
}

function ticketView_(r, access) {
  const atts = parseAttachments_(r.AttachmentURL);
  const v = {
    TicketID: r.TicketID, CreatedAt: r.CreatedAt, createdAtText: thaiDT_(r.CreatedAt),
    Department: r.Department, Building: r.Building, Floor: r.Floor, Room: r.Room, InstallPoint: r.InstallPoint,
    ProblemType: r.ProblemType, ProblemTitle: r.ProblemTitle, Priority: r.Priority, Status: r.Status,
    AssignedTo: r.AssignedTo, assignedAtText: thaiDT_(r.AssignedAt), acceptedAtText: thaiDT_(r.AcceptedAt),
    startedAtText: thaiDT_(r.StartedAt), resolvedAtText: thaiDT_(r.ResolvedAt), closedAtText: thaiDT_(r.ClosedAt),
    lastUpdatedText: thaiDT_(r.LastUpdated), Result: r.Result, Rating: r.Rating,
    durationText: r.ResolvedAt ? durationText_(minutesBetween_(r.CreatedAt, r.ResolvedAt)) : '',
    elapsedText: durationText_(minutesBetween_(r.CreatedAt, r.ResolvedAt || now_())),
    isUrgent: isUrgentOpen_(r), attachmentCount: atts.length,
    ReporterName: access === 'public' ? maskName_(r.ReporterName) : r.ReporterName
  };
  if (access !== 'public') {
    v.ReporterID = r.ReporterID; v.Phone = r.Phone; v.Email = r.Email; v.AssetID = r.AssetID;
    v.ProblemDetail = r.ProblemDetail; v.Resolution = r.Resolution; v.RootCause = r.RootCause;
    v.CloseNote = r.CloseNote; v.ClosedBy = r.ClosedBy; v.Cost = r.Cost; v.Feedback = r.Feedback;
    v.ratedAtText = thaiDT_(r.RatedAt); v.attachments = atts;
  } else {
    v.attachments = [];
  }
  return v;
}

function parseAttachments_(s) {
  return String(s || '').split(/\s+/).filter(function (u) { return /^https:\/\/drive\.google\.com\//.test(u); })
    .map(function (u) {
      const m = u.match(/\/d\/([A-Za-z0-9_-]+)/) || u.match(/[?&]id=([A-Za-z0-9_-]+)/);
      return { url: u, id: m ? m[1] : '' };
    });
}

function maskName_(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '-';
  if (parts.length === 1) return parts[0].slice(0, 3) + '***';
  return parts[0] + ' ' + parts[1].charAt(0) + '.';
}

function addHistory_(ticketId, action, from, to, by, note) {
  writeRow_('History', {
    HistoryID: 'H-' + fmtDate_(new Date(), 'yyyyMMddHHmmss') + '-' + randomCode_(4),
    TicketID: ticketId, DateTime: now_(), Action: action, FromStatus: from || '', ToStatus: to || '',
    By: by || '', Note: note || ''
  });
}

function getWorkLogs_(id) {
  return readTable_('WorkLogs').rows.filter(function (l) { return l.TicketID === id; })
    .sort(function (a, b) { return String(a.DateTime) < String(b.DateTime) ? -1 : 1; })
    .map(function (l) {
      return { LogID: l.LogID, DateTime: l.DateTime, dateTimeText: thaiDT_(l.DateTime), Staff: l.Staff, Action: l.Action, Parts: l.Parts, Cost: l.Cost, Note: l.Note };
    });
}

function buildTimeline_(id, access) {
  const items = readTable_('History').rows.filter(function (h) { return h.TicketID === id; }).map(function (h, i) {
    return { kind: 'history', seq: i, time: h.DateTime, timeText: thaiDT_(h.DateTime), action: h.Action, from: h.FromStatus, to: h.ToStatus, by: h.By, note: h.Note };
  });
  if (access !== 'public') {
    getWorkLogs_(id).forEach(function (l, i) {
      items.push({ kind: 'worklog', seq: 1000 + i, time: l.DateTime, timeText: l.dateTimeText, action: 'บันทึกการดำเนินงาน', by: l.Staff, note: l.Action, parts: l.Parts, cost: l.Cost, extraNote: l.Note });
    });
  }
  items.sort(function (a, b) {
    if (a.time === b.time) return a.seq - b.seq;
    return String(a.time) < String(b.time) ? -1 : 1;
  });
  return items;
}

function getAssigneeOptions_() {
  const list = listSetting_('ASSIGNEES');
  getUsersCached_().forEach(function (u) {
    if (isActive_(u) && isStaffRole_(u.Role) && u.Name && list.indexOf(u.Name) < 0) list.push(u.Name);
  });
  return list;
}

// =====================================================================================
// 6) DASHBOARD & REPORTS
// =====================================================================================
function getDashboardData(token) {
  return safe_(function () {
    const cache = CacheService.getScriptCache();
    const cached = cache.get('dash_v1');
    if (cached) return JSON.parse(cached);
    const data = buildDashboard_();
    try { cache.put('dash_v1', JSON.stringify(data), CONFIG.DASHBOARD_CACHE_SECONDS); } catch (e) { /* ignore */ }
    return data;
  });
}

function buildDashboard_() {
  const rows = readTable_('Tickets').rows;
  const today = today_();
  const month = today.slice(0, 7);
  const st = computeStats_(rows);
  const cards = {
    total: rows.length, today: 0, month: 0,
    pending: (st.byStatus[STATUS.NEW] || 0) + (st.byStatus[STATUS.ACCEPTED] || 0),
    inProgress: (st.byStatus[STATUS.IN_PROGRESS] || 0) + (st.byStatus[STATUS.WAITING] || 0),
    resolved: st.byStatus[STATUS.RESOLVED] || 0,
    closed: st.byStatus[STATUS.CLOSED] || 0,
    cancelled: st.byStatus[STATUS.CANCELLED] || 0,
    urgent: st.urgentOpen,
    avgResolutionMinutes: st.avgResolutionMinutes,
    avgResolutionText: st.avgResolutionText,
    avgRating: st.avgRating,
    ratingCount: st.ratingCount
  };
  rows.forEach(function (r) {
    const d = String(r.CreatedAt).slice(0, 10);
    if (d === today) cards.today++;
    if (d.slice(0, 7) === month) cards.month++;
  });

  const days = [];
  for (let i = 13; i >= 0; i--) days.push(addDays_(today, -i));
  const created = {}, resolved = {};
  rows.forEach(function (r) {
    const c = String(r.CreatedAt).slice(0, 10); created[c] = (created[c] || 0) + 1;
    if (r.ResolvedAt) { const x = String(r.ResolvedAt).slice(0, 10); resolved[x] = (resolved[x] || 0) + 1; }
  });

  const urgentList = rows.filter(isUrgentOpen_).sort(function (a, b) { return String(a.CreatedAt) < String(b.CreatedAt) ? 1 : -1; })
    .slice(0, 10).map(function (r) {
      return { TicketID: r.TicketID, ProblemTitle: r.ProblemTitle, ProblemType: r.ProblemType, Building: r.Building, Room: r.Room, Status: r.Status, AssignedTo: r.AssignedTo, createdAtText: thaiDT_(r.CreatedAt), elapsedText: durationText_(minutesBetween_(r.CreatedAt, now_())) };
    });
  const recent = rows.slice().sort(function (a, b) { return String(a.CreatedAt) < String(b.CreatedAt) ? 1 : -1; })
    .slice(0, 8).map(function (r) {
      return { TicketID: r.TicketID, ProblemTitle: r.ProblemTitle, ProblemType: r.ProblemType, Priority: r.Priority, Status: r.Status, Building: r.Building, Room: r.Room, createdAtText: thaiDT_(r.CreatedAt), isUrgent: isUrgentOpen_(r) };
    });

  return {
    cards: cards,
    byType: st.byType, byBuilding: st.byBuilding.slice(0, 10), byDepartment: st.byDepartment.slice(0, 10),
    byStatus: st.byStatusList, byPriority: st.byPriority,
    topStaff: st.staff.slice(0, 8),
    recurring: st.recurring.slice(0, 8),
    recurringLocations: st.recurringLocations.slice(0, 8),
    trend: {
      labels: days.map(function (d) { return d.slice(8, 10) + '/' + d.slice(5, 7); }),
      created: days.map(function (d) { return created[d] || 0; }),
      resolved: days.map(function (d) { return resolved[d] || 0; })
    },
    urgentList: urgentList,
    recent: recent,
    updatedAt: now_(),
    updatedAtText: thaiDT_(now_())
  };
}

function computeStats_(rows) {
  const byStatus = {}, byType = {}, byPriority = {}, byBuilding = {}, byDept = {}, staff = {}, titles = {}, locs = {};
  let resSum = 0, resN = 0, ratingSum = 0, ratingN = 0, cost = 0, urgentOpen = 0;
  rows.forEach(function (r) {
    inc_(byStatus, r.Status || 'ไม่ระบุ');
    inc_(byType, r.ProblemType || 'ไม่ระบุ');
    inc_(byPriority, r.Priority || 'ไม่ระบุ');
    inc_(byBuilding, r.Building || 'ไม่ระบุ');
    inc_(byDept, r.Department || 'ไม่ระบุ');
    if (isUrgentOpen_(r)) urgentOpen++;
    const m = r.ResolvedAt ? minutesBetween_(r.CreatedAt, r.ResolvedAt) : null;
    if (m != null && m >= 0) { resSum += m; resN++; }
    const rt = parseInt(r.Rating, 10);
    if (rt >= 1 && rt <= 5) { ratingSum += rt; ratingN++; }
    cost += parseFloat(r.Cost) || 0;
    if (r.AssignedTo) {
      const s = staff[r.AssignedTo] || (staff[r.AssignedTo] = { name: r.AssignedTo, total: 0, open: 0, done: 0, resSum: 0, resN: 0, ratingSum: 0, ratingN: 0, cost: 0 });
      s.total++;
      if (OPEN_STATUSES.indexOf(r.Status) >= 0) s.open++;
      if (r.Status === STATUS.RESOLVED || r.Status === STATUS.CLOSED) s.done++;
      if (m != null && m >= 0) { s.resSum += m; s.resN++; }
      if (rt >= 1 && rt <= 5) { s.ratingSum += rt; s.ratingN++; }
      s.cost += parseFloat(r.Cost) || 0;
    }
    const tkey = (r.ProblemType || '') + '|' + String(r.ProblemTitle || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const t = titles[tkey] || (titles[tkey] = { title: r.ProblemTitle, type: r.ProblemType, count: 0, last: '' });
    t.count++;
    if (String(r.CreatedAt) > t.last) t.last = String(r.CreatedAt);
    const lkey = [r.Building, r.Room, r.ProblemType].join('|');
    const l = locs[lkey] || (locs[lkey] = { location: [r.Room, r.Building].filter(Boolean).join(' • '), type: r.ProblemType, count: 0 });
    l.count++;
  });
  const avg = resN ? resSum / resN : null;
  return {
    total: rows.length,
    byStatus: byStatus,
    byStatusList: STATUS_LIST.map(function (s) { return { label: s.value, value: byStatus[s.value] || 0, color: s.color }; }),
    byType: toList_(byType),
    byPriority: PRIORITY_LIST.map(function (p) { return { label: p.value, value: byPriority[p.value] || 0, color: p.color }; }),
    byBuilding: toList_(byBuilding),
    byDepartment: toList_(byDept),
    urgentOpen: urgentOpen,
    avgResolutionMinutes: avg == null ? null : Math.round(avg),
    avgResolutionText: avg == null ? '-' : durationText_(avg),
    avgRating: ratingN ? Math.round(ratingSum / ratingN * 100) / 100 : null,
    ratingCount: ratingN,
    totalCost: Math.round(cost * 100) / 100,
    staff: Object.keys(staff).map(function (k) {
      const s = staff[k];
      return {
        name: s.name, total: s.total, open: s.open, done: s.done,
        avgResolutionText: s.resN ? durationText_(s.resSum / s.resN) : '-',
        avgRating: s.ratingN ? Math.round(s.ratingSum / s.ratingN * 100) / 100 : null,
        cost: Math.round(s.cost * 100) / 100
      };
    }).sort(function (a, b) { return b.total - a.total; }),
    recurring: Object.keys(titles).map(function (k) { return titles[k]; }).filter(function (t) { return t.count >= 2; })
      .sort(function (a, b) { return b.count - a.count; }).map(function (t) { return { title: t.title, type: t.type, count: t.count, lastText: thaiDT_(t.last) }; }),
    recurringLocations: Object.keys(locs).map(function (k) { return locs[k]; }).filter(function (l) { return l.count >= 2; })
      .sort(function (a, b) { return b.count - a.count; }),
    topProblems: Object.keys(titles).map(function (k) { return titles[k]; })
      .sort(function (a, b) { return b.count - a.count; }).slice(0, 10).map(function (t) { return { title: t.title, type: t.type, count: t.count }; })
  };
}

function getReports(startDate, endDate, token) {
  return safe_(function () {
    requireStaff_(token);
    const range = validateRange_(startDate, endDate);
    const rows = rowsInRange_(range.start, range.end);
    const st = computeStats_(rows);
    const logs = readTable_('WorkLogs').rows.filter(function (l) {
      const d = String(l.DateTime).slice(0, 10); return d >= range.start && d <= range.end;
    });
    const logStaff = {};
    logs.forEach(function (l) {
      const s = logStaff[l.Staff] || (logStaff[l.Staff] = { logs: 0, cost: 0 });
      s.logs++; s.cost += parseFloat(l.Cost) || 0;
    });
    st.staff.forEach(function (s) { s.workLogs = logStaff[s.name] ? logStaff[s.name].logs : 0; });
    Object.keys(logStaff).forEach(function (name) {
      if (!st.staff.some(function (s) { return s.name === name; })) {
        st.staff.push({ name: name, total: 0, open: 0, done: 0, avgResolutionText: '-', avgRating: null, cost: 0, workLogs: logStaff[name].logs });
      }
    });

    const dayCount = Math.round((parseDT_(range.end + ' 12:00:00') - parseDT_(range.start + ' 12:00:00')) / 86400000) + 1;
    const monthly = dayCount > 62;
    const keys = [];
    if (monthly) {
      let d = range.start.slice(0, 7);
      while (d <= range.end.slice(0, 7) && keys.length < 60) {
        keys.push(d);
        const y = parseInt(d.slice(0, 4), 10), m = parseInt(d.slice(5, 7), 10);
        d = m === 12 ? (y + 1) + '-01' : y + '-' + ('0' + (m + 1)).slice(-2);
      }
    } else {
      for (let i = 0; i < dayCount; i++) keys.push(addDays_(range.start, i));
    }
    const created = {}, done = {};
    rows.forEach(function (r) {
      const k = String(r.CreatedAt).slice(0, monthly ? 7 : 10);
      created[k] = (created[k] || 0) + 1;
      if (r.ResolvedAt) { const k2 = String(r.ResolvedAt).slice(0, monthly ? 7 : 10); done[k2] = (done[k2] || 0) + 1; }
    });
    const resolvedCount = (st.byStatus[STATUS.RESOLVED] || 0) + (st.byStatus[STATUS.CLOSED] || 0);
    return {
      range: { start: range.start, end: range.end, text: thaiDate_(range.start) + ' – ' + thaiDate_(range.end), days: dayCount },
      summary: {
        total: st.total,
        open: OPEN_STATUSES.reduce(function (s, k) { return s + (st.byStatus[k] || 0); }, 0),
        resolved: resolvedCount,
        closed: st.byStatus[STATUS.CLOSED] || 0,
        cancelled: st.byStatus[STATUS.CANCELLED] || 0,
        urgent: rows.filter(function (r) { return r.Priority === URGENT_PRIORITY; }).length,
        avgResolutionText: st.avgResolutionText,
        avgRating: st.avgRating,
        ratingCount: st.ratingCount,
        totalCost: st.totalCost,
        resolveRate: st.total ? Math.round(resolvedCount / st.total * 1000) / 10 : 0,
        workLogs: logs.length
      },
      byStatus: st.byStatusList, byType: st.byType, byPriority: st.byPriority,
      byBuilding: st.byBuilding, byDepartment: st.byDepartment,
      staff: st.staff, topProblems: st.topProblems, recurring: st.recurring.slice(0, 10),
      trend: {
        labels: keys.map(function (k) { return monthly ? thaiMonth_(k) : k.slice(8, 10) + '/' + k.slice(5, 7); }),
        created: keys.map(function (k) { return created[k] || 0; }),
        resolved: keys.map(function (k) { return done[k] || 0; })
      }
    };
  });
}

/** data = {startDate, endDate, saveToDrive} → {filename, content, url?} */
function exportCSV(data, token) {
  return safe_(function () {
    requireStaff_(token);
    data = data || {};
    const range = validateRange_(data.startDate, data.endDate);
    const rows = rowsInRange_(range.start, range.end).sort(function (a, b) { return String(a.CreatedAt) < String(b.CreatedAt) ? -1 : 1; });
    const cols = [
      ['TicketID', 'Ticket ID'], ['CreatedAt', 'วันที่แจ้ง'], ['ReporterID', 'รหัสผู้แจ้ง'], ['ReporterName', 'ผู้แจ้ง'],
      ['Department', 'กลุ่มสาระ/ฝ่าย/แผนก'], ['Phone', 'เบอร์โทร'], ['Email', 'อีเมล'], ['Building', 'อาคาร'], ['Floor', 'ชั้น'],
      ['Room', 'ห้อง'], ['InstallPoint', 'จุดติดตั้ง'], ['AssetID', 'หมายเลขครุภัณฑ์'], ['ProblemType', 'ประเภทปัญหา'],
      ['ProblemTitle', 'หัวข้อปัญหา'], ['ProblemDetail', 'รายละเอียด'], ['Priority', 'ความเร่งด่วน'], ['Status', 'สถานะ'],
      ['AssignedTo', 'ผู้รับผิดชอบ'], ['AssignedAt', 'วันที่มอบหมาย'], ['AcceptedAt', 'วันที่รับเรื่อง'], ['StartedAt', 'วันที่เริ่มดำเนินการ'],
      ['ResolvedAt', 'วันที่แก้ไขเสร็จ'], ['ClosedAt', 'วันที่ปิดงาน'], ['__duration', 'ระยะเวลาแก้ไข'], ['Resolution', 'วิธีการแก้ไข'],
      ['RootCause', 'สาเหตุ'], ['Result', 'ผลการดำเนินงาน'], ['Cost', 'ค่าใช้จ่าย (บาท)'], ['Rating', 'คะแนนความพึงพอใจ'],
      ['Feedback', 'ความคิดเห็น'], ['AttachmentURL', 'ไฟล์แนบ']
    ];
    const lines = [cols.map(function (c) { return csvCell_(c[1]); }).join(',')];
    rows.forEach(function (r) {
      lines.push(cols.map(function (c) {
        if (c[0] === '__duration') return csvCell_(r.ResolvedAt ? durationText_(minutesBetween_(r.CreatedAt, r.ResolvedAt)) : '');
        return csvCell_(r[c[0]]);
      }).join(','));
    });
    const content = '﻿' + lines.join('\r\n');
    const filename = 'IT-Helpdesk-Report_' + range.start + '_to_' + range.end + '.csv';
    const out = { filename: filename, content: content, count: rows.length };
    if (data.saveToDrive) {
      const file = getDriveFolder_().createFile(Utilities.newBlob(content, 'text/csv', filename));
      out.url = file.getUrl();
    }
    return out;
  });
}

function validateRange_(startDate, endDate) {
  const s = str_(startDate, 10), e = str_(endDate, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) fail_('รูปแบบวันที่ไม่ถูกต้อง');
  if (s > e) fail_('วันที่เริ่มต้นต้องไม่มากกว่าวันที่สิ้นสุด');
  return { start: s, end: e };
}

function rowsInRange_(start, end) {
  return readTable_('Tickets').rows.filter(function (r) {
    const d = String(r.CreatedAt).slice(0, 10); return d >= start && d <= end;
  });
}

// =====================================================================================
// 7) SETTINGS
// =====================================================================================
function getSettings(token) {
  return safe_(function () {
    const sess = getSession_(token);
    const out = { settings: publicSettings_() };
    if (sess && sess.role === 'Admin' && !sess.mustChange) {
      const raw = getSettingsMap_();
      out.raw = {};
      EDITABLE_SETTINGS.forEach(function (k) { out.raw[k] = raw[k] == null ? '' : String(raw[k]); });
      const ss = getSS_();
      let folderUrl = '';
      try { folderUrl = getDriveFolder_().getUrl(); } catch (e) { folderUrl = ''; }
      const chatId = cfg_('TELEGRAM_CHAT_ID');
      out.system = {
        telegramConfigured: !!(cfg_('TELEGRAM_BOT_TOKEN') && chatId),
        telegramTokenSet: !!cfg_('TELEGRAM_BOT_TOKEN'),
        telegramChatIdMasked: chatId ? chatId.slice(0, 3) + '****' + chatId.slice(-2) : '',
        googleChatConfigured: !!cfg_('GOOGLE_CHAT_WEBHOOK_URL'),
        driveFolderConfigured: !!cfg_('DRIVE_FOLDER_ID'),
        driveFolderUrl: folderUrl,
        spreadsheetUrl: ss.getUrl(),
        spreadsheetName: ss.getName(),
        webAppUrl: webAppUrl_(),
        timezone: CONFIG.TIMEZONE,
        ownerEmail: (function () { try { return Session.getEffectiveUser().getEmail(); } catch (e) { return ''; } })()
      };
    }
    return out;
  });
}

function saveSettings(settings, token) {
  return safe_(function () {
    requireAdmin_(token);
    settings = settings || {};
    const clean = {};
    EDITABLE_SETTINGS.forEach(function (k) {
      if (!(k in settings)) return;
      let v = settings[k];
      if (Array.isArray(v)) v = v.join('\n');
      v = str_(String(v == null ? '' : v).replace(/\r\n/g, '\n'), 5000);
      if (['ALLOW_GUEST_REPORT', 'NOTIFY_TELEGRAM', 'NOTIFY_GOOGLE_CHAT'].indexOf(k) >= 0) v = /^(true|1|yes|on)$/i.test(v) ? 'TRUE' : 'FALSE';
      if (k === 'ATTACHMENT_SHARING' && ['ANYONE_WITH_LINK', 'DOMAIN_WITH_LINK', 'PRIVATE'].indexOf(v) < 0) fail_('ค่าสิทธิ์ไฟล์แนบไม่ถูกต้อง');
      if (k === 'ORG_NAME' && !v) fail_('กรุณากรอกชื่อหน่วยงาน');
      if (k === 'ASSIGNEES' && !v) fail_('กรุณากำหนดรายชื่อผู้รับผิดชอบอย่างน้อย 1 รายการ');
      clean[k] = v;
    });
    withLock_(function () {
      const t = readTable_('Settings');
      Object.keys(clean).forEach(function (k) {
        const row = t.rows.find(function (r) { return r.Key === k; });
        const desc = (DEFAULT_SETTINGS.find(function (d) { return d[0] === k; }) || [])[2] || '';
        if (row) { row.Value = clean[k]; writeRow_('Settings', row, row._row); }
        else writeRow_('Settings', { Key: k, Value: clean[k], Description: desc });
      });
    });
    _settings = null;
    CacheService.getScriptCache().removeAll(['settings_v1', 'dash_v1']);
    return publicSettings_();
  });
}

/** บันทึกค่าลับลง Script Properties (ไม่ส่งค่ากลับไปยัง Frontend) — ใส่ "-" เพื่อลบค่า */
function saveSecretConfig(cfg, token) {
  return safe_(function () {
    requireAdmin_(token);
    cfg = cfg || {};
    const props = PropertiesService.getScriptProperties();
    const updated = [];
    SECRET_KEYS.forEach(function (k) {
      const v = str_(cfg[k], 500);
      if (!v) return;
      if (v === '-') { props.deleteProperty(k); updated.push(k + ' (ลบ)'); return; }
      if (k === 'TELEGRAM_BOT_TOKEN' && !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(v)) fail_('รูปแบบ Telegram Bot Token ไม่ถูกต้อง');
      if (k === 'TELEGRAM_CHAT_ID' && !/^(-?\d{3,20}|@[A-Za-z0-9_]{4,})$/.test(v)) fail_('รูปแบบ Telegram Chat ID ไม่ถูกต้อง');
      if (k === 'GOOGLE_CHAT_WEBHOOK_URL' && !/^https:\/\/chat\.googleapis\.com\/v1\/spaces\/[^\s]+$/.test(v)) fail_('รูปแบบ Google Chat Webhook URL ไม่ถูกต้อง');
      if (k === 'DRIVE_FOLDER_ID') {
        if (!/^[A-Za-z0-9_-]{10,}$/.test(v)) fail_('รูปแบบ Google Drive Folder ID ไม่ถูกต้อง');
        try { DriveApp.getFolderById(v).getName(); } catch (e) { fail_('ไม่สามารถเข้าถึงโฟลเดอร์ Google Drive นี้ได้'); }
      }
      props.setProperty(k, v);
      updated.push(k);
    });
    _props = null;
    if (!updated.length) fail_('ไม่มีค่าที่ต้องการบันทึก');
    return { updated: updated };
  });
}

function testNotification(channel, token) {
  return safe_(function () {
    const sess = requireAdmin_(token);
    const text = '✅ ทดสอบการแจ้งเตือน — ' + CONFIG.APP_NAME + '\n\nหน่วยงาน: ' + (getSettingsMap_().ORG_NAME || '-') +
      '\nผู้ทดสอบ: ' + sess.name + '\nเวลา: ' + thaiDT_(now_()) + '\n\nหากเห็นข้อความนี้ แสดงว่าการเชื่อมต่อสำเร็จ 🎉';
    const out = {};
    INTERNAL_CALL_ = true;
    try {
      if (channel === 'telegram' || channel === 'all') out.telegram = unwrap_(sendTelegramNotification({ text: text }));
      if (channel === 'googlechat' || channel === 'all') out.googleChat = unwrap_(sendGoogleChatNotification({ text: '*' + text.split('\n')[0] + '*\n' + text.split('\n').slice(1).join('\n') }));
    } finally {
      INTERNAL_CALL_ = false;
    }
    return out;
  });
}

function publicSettings_() {
  const s = getSettingsMap_();
  return {
    ORG_NAME: s.ORG_NAME || '',
    ASSIGNEES: listSetting_('ASSIGNEES'),
    BUILDINGS: listSetting_('BUILDINGS'),
    DEPARTMENTS: listSetting_('DEPARTMENTS'),
    ALLOW_GUEST_REPORT: String(s.ALLOW_GUEST_REPORT).toUpperCase() !== 'FALSE',
    NOTIFY_TELEGRAM: String(s.NOTIFY_TELEGRAM).toUpperCase() !== 'FALSE',
    NOTIFY_GOOGLE_CHAT: String(s.NOTIFY_GOOGLE_CHAT).toUpperCase() !== 'FALSE'
  };
}

function getSettingsMap_() {
  if (_settings) return _settings;
  const cache = CacheService.getScriptCache();
  const c = cache.get('settings_v1');
  if (c) {
    try { _settings = JSON.parse(c); return _settings; } catch (e) { /* rebuild */ }
  }
  const map = {};
  DEFAULT_SETTINGS.forEach(function (d) { map[d[0]] = d[1]; });
  readTable_('Settings').rows.forEach(function (r) { if (r.Key) map[r.Key] = r.Value; });
  try { cache.put('settings_v1', JSON.stringify(map), 300); } catch (e) { /* ignore */ }
  _settings = map;
  return map;
}

function listSetting_(key) {
  return String(getSettingsMap_()[key] || '').split(/\r?\n|,/).map(function (x) { return x.trim(); }).filter(Boolean);
}

// =====================================================================================
// 8) NOTIFICATIONS — Telegram & Google Chat
// =====================================================================================
/**
 * ส่งข้อความ Telegram — data = { text } (เรียกจากภายใน) หรือ { text, token } (Admin ทดสอบจากหน้าเว็บ)
 */
function sendTelegramNotification(data) {
  return safe_(function () {
    data = data || {};
    if (!INTERNAL_CALL_) requireAdmin_(data.token);
    const botToken = cfg_('TELEGRAM_BOT_TOKEN');
    const chatId = cfg_('TELEGRAM_CHAT_ID');
    if (!botToken || !chatId) return { sent: false, message: 'ยังไม่ได้ตั้งค่า Telegram Bot Token / Chat ID' };
    const text = str_(data.text || data.message, 4000);
    if (!text) fail_('ไม่มีข้อความที่จะส่ง');
    try {
      const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + botToken + '/sendMessage', {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ chat_id: chatId, text: text, disable_web_page_preview: true }),
        muteHttpExceptions: true
      });
      const code = res.getResponseCode();
      let desc = '';
      try { desc = JSON.parse(res.getContentText()).description || ''; } catch (e) { desc = ''; }
      return { sent: code === 200, code: code, message: code === 200 ? 'ส่ง Telegram สำเร็จ' : ('Telegram ตอบกลับ ' + code + ' ' + desc) };
    } catch (e) {
      return { sent: false, message: String(e.message || e).split(botToken).join('***') };
    }
  });
}

/**
 * ส่งข้อความ Google Chat — data = { text } (เรียกจากภายใน) หรือ { text, token } (Admin)
 */
function sendGoogleChatNotification(data) {
  return safe_(function () {
    data = data || {};
    if (!INTERNAL_CALL_) requireAdmin_(data.token);
    const url = cfg_('GOOGLE_CHAT_WEBHOOK_URL');
    if (!url) return { sent: false, message: 'ยังไม่ได้ตั้งค่า Google Chat Webhook URL' };
    const text = str_(data.text || data.message, 4000);
    if (!text) fail_('ไม่มีข้อความที่จะส่ง');
    try {
      const res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json; charset=UTF-8',
        payload: JSON.stringify({ text: text }),
        muteHttpExceptions: true
      });
      const code = res.getResponseCode();
      return { sent: code === 200, code: code, message: code === 200 ? 'ส่ง Google Chat สำเร็จ' : ('Google Chat ตอบกลับ ' + code) };
    } catch (e) {
      return { sent: false, message: String(e.message || e).split(url).join('***') };
    }
  });
}

function notifyEvent_(event, row, extra) {
  const results = {};
  try {
    const s = getSettingsMap_();
    INTERNAL_CALL_ = true;
    if (String(s.NOTIFY_TELEGRAM).toUpperCase() !== 'FALSE') {
      results.telegram = unwrap_(sendTelegramNotification({ text: buildMessage_(event, row, extra || {}, 'telegram') }));
    }
    if (String(s.NOTIFY_GOOGLE_CHAT).toUpperCase() !== 'FALSE') {
      results.googleChat = unwrap_(sendGoogleChatNotification({ text: buildMessage_(event, row, extra || {}, 'chat') }));
    }
  } catch (e) {
    console.error('notifyEvent_ error: ' + (e && e.message ? e.message : e));
  } finally {
    INTERNAL_CALL_ = false;
  }
  return results;
}

function buildMessage_(event, r, x, channel) {
  const chat = channel === 'chat';
  const clean = function (v) {
    const s = String(v == null || v === '' ? '-' : v);
    return chat ? s.replace(/</g, '‹').replace(/>/g, '›').replace(/\*/g, '∗') : s;
  };
  const B = function (label) { return chat ? '*' + label + '*' : label; };
  const url = webAppUrl_();
  const link = url ? (url + '?ticket=' + encodeURIComponent(r.TicketID)) : '';
  const location = clean([r.Room, r.Building, r.Floor ? 'ชั้น ' + r.Floor : ''].filter(Boolean).join(' • '));
  const detail = String(r.ProblemDetail || '').length > 400 ? String(r.ProblemDetail).slice(0, 400) + '…' : r.ProblemDetail;
  const duration = durationText_(minutesBetween_(r.CreatedAt, r.ResolvedAt || r.ClosedAt || now_()));
  const L = [];

  if (event === 'NEW' || event === 'URGENT') {
    if (chat) {
      L.push(event === 'URGENT'
        ? '🚨🔴 ' + B('IT HELP DESK — ปัญหาด่วนมาก!' + (x.escalated ? ' (ปรับระดับความเร่งด่วน)' : '')) + '\n⚠️ กระทบการเรียนการสอน กรุณาดำเนินการทันที'
        : '🚨 ' + B('IT HELP DESK — แจ้งปัญหาใหม่'));
      L.push('');
      L.push(B('Ticket:') + ' ' + r.TicketID);
      L.push(B('ผู้แจ้ง:') + ' ' + clean(r.ReporterName));
      L.push(B('แผนก:') + ' ' + clean(r.Department));
      L.push(B('สถานที่:') + ' ' + location);
      if (r.AssetID) L.push(B('ครุภัณฑ์:') + ' ' + clean(r.AssetID));
      L.push(B('ประเภท:') + ' ' + clean(r.ProblemType));
      L.push(B('ความเร่งด่วน:') + ' ' + priorityLabel_(r.Priority));
      L.push('');
      L.push(B('ปัญหา:'));
      L.push(clean(r.ProblemTitle));
      if (detail) L.push(clean(detail));
      L.push('');
      L.push(B('สถานะ:') + ' ' + statusLabel_(r.Status));
      L.push('⏰ ' + thaiDT_(r.CreatedAt));
      if (link) L.push('🔗 <' + link + '|เปิดดู Ticket ในระบบ>');
    } else {
      L.push(event === 'URGENT'
        ? '🚨🚨 แจ้งปัญหา IT ด่วนมาก!' + (x.escalated ? ' (ปรับระดับความเร่งด่วน)' : '') + '\n⚠️ กระทบการเรียนการสอน'
        : '🚨 แจ้งปัญหา IT ใหม่');
      L.push('');
      L.push('🎫 Ticket: ' + r.TicketID);
      L.push('');
      L.push('👤 ผู้แจ้ง: ' + clean(r.ReporterName));
      L.push('🏢 แผนก: ' + clean(r.Department));
      L.push('📍 ห้อง: ' + location);
      if (r.AssetID) L.push('🏷️ ครุภัณฑ์: ' + clean(r.AssetID));
      L.push('');
      L.push('💻 ประเภท: ' + clean(r.ProblemType));
      L.push('⚠️ ความเร่งด่วน: ' + priorityLabel_(r.Priority));
      L.push('');
      L.push('📝 ปัญหา:');
      L.push(clean(r.ProblemTitle));
      if (detail) L.push(clean(detail));
      L.push('');
      L.push('⏰ เวลาแจ้ง:');
      L.push(thaiDT_(r.CreatedAt));
      L.push('');
      L.push('🔗 กรุณาเข้าสู่ระบบเพื่อดำเนินการ');
      if (link) L.push(link);
    }
    return L.join('\n');
  }

  if (event === 'RESOLVED' || event === 'CLOSED') {
    const title = event === 'CLOSED' ? '⚫ ปิดงานเรียบร้อย' : '✅ แก้ไขปัญหาเรียบร้อย';
    L.push(chat ? B('IT HELP DESK — ' + title) : title);
    L.push('');
    L.push((chat ? B('Ticket:') + ' ' : '🎫 ') + r.TicketID);
    L.push('');
    L.push(chat ? B('ปัญหา:') : '💻 ปัญหา:');
    L.push(clean(r.ProblemTitle));
    L.push('');
    L.push(chat ? B('ผู้ดำเนินการ:') : '👨‍💻 ผู้ดำเนินการ:');
    L.push(clean(x.by || r.AssignedTo));
    L.push('');
    L.push(chat ? B('วิธีแก้ไข:') : '🔧 วิธีแก้ไข:');
    L.push(clean(event === 'CLOSED' ? r.Resolution : (x.note || r.Resolution)));
    if (event === 'CLOSED') {
      L.push('');
      L.push((chat ? B('สาเหตุ:') : '🔍 สาเหตุ:') + ' ' + clean(r.RootCause));
      L.push((chat ? B('ผลการดำเนินงาน:') : '📋 ผลการดำเนินงาน:') + ' ' + clean(r.Result));
      if (parseFloat(r.Cost) > 0) L.push((chat ? B('ค่าใช้จ่าย:') : '💰 ค่าใช้จ่าย:') + ' ' + formatMoney_(r.Cost) + ' บาท');
    }
    L.push('');
    L.push(chat ? B('ระยะเวลาดำเนินการ:') : '⏱️ ระยะเวลาดำเนินการ:');
    L.push(duration);
    if (chat) L.push('\n' + B('สถานะ:') + ' ' + statusLabel_(r.Status));
    return L.join('\n');
  }

  if (event === 'RATING') {
    L.push(chat ? '⭐ ' + B('IT HELP DESK — ผลประเมินความพึงพอใจ') : '⭐ ผลประเมินความพึงพอใจ');
    L.push('');
    L.push((chat ? B('Ticket:') + ' ' : '🎫 ') + r.TicketID);
    L.push((chat ? B('ปัญหา:') : '💻 ปัญหา:') + ' ' + clean(r.ProblemTitle));
    L.push((chat ? B('ผู้รับผิดชอบ:') : '👨‍💻 ผู้รับผิดชอบ:') + ' ' + clean(r.AssignedTo));
    L.push((chat ? B('คะแนน:') : '🌟 คะแนน:') + ' ' + stars_(x.rating) + ' (' + x.rating + '/5)');
    if (x.feedback) L.push((chat ? B('ความคิดเห็น:') : '💬 ความคิดเห็น:') + ' ' + clean(x.feedback));
    return L.join('\n');
  }

  // ACCEPT / ASSIGN / STATUS
  const headers = {
    ACCEPT: ['📥 รับเรื่องแล้ว', '📥 IT HELP DESK — รับเรื่องแล้ว'],
    ASSIGN: ['👨‍💻 มอบหมายงาน', '👨‍💻 IT HELP DESK — มอบหมายงาน'],
    STATUS: ['🔄 อัปเดต Ticket', '🔄 IT HELP DESK — อัปเดตสถานะ']
  };
  const h = headers[event] || headers.STATUS;
  L.push(chat ? B(h[1]) : h[0]);
  L.push('');
  L.push((chat ? B('Ticket:') + ' ' : '🎫 ') + r.TicketID);
  if (chat) {
    L.push(B('ปัญหา:') + ' ' + clean(r.ProblemTitle));
    L.push(B('สถานที่:') + ' ' + location);
    L.push(B('ความเร่งด่วน:') + ' ' + priorityLabel_(r.Priority));
    L.push(B('สถานะ:') + ' ' + (x.from && x.from !== x.to ? statusLabel_(x.from) + ' ➡️ ' : '') + statusLabel_(x.to || r.Status));
    L.push(B('ผู้รับผิดชอบ:') + ' ' + clean(x.staff || r.AssignedTo));
    if (x.by) L.push(B('ดำเนินการโดย:') + ' ' + clean(x.by));
    if (x.note) L.push(B('หมายเหตุ:') + ' ' + clean(x.note));
    if (link) L.push('🔗 <' + link + '|เปิดดู Ticket>');
  } else {
    L.push('💻 ' + clean(r.ProblemTitle));
    L.push('');
    L.push('สถานะ:');
    if (x.from && x.from !== x.to) { L.push(statusLabel_(x.from)); L.push('➡️'); }
    L.push(statusLabel_(x.to || r.Status));
    L.push('');
    L.push('👨‍💻 ผู้รับผิดชอบ:');
    L.push(clean(x.staff || r.AssignedTo));
    if (x.by && x.by !== (x.staff || r.AssignedTo)) { L.push(''); L.push('🧑‍🔧 ดำเนินการโดย: ' + clean(x.by)); }
    L.push('');
    L.push('📝 หมายเหตุ:');
    L.push(clean(x.note));
  }
  return L.join('\n');
}

// =====================================================================================
// 9) GOOGLE DRIVE (ATTACHMENTS)
// =====================================================================================
function getDriveFolder_() {
  const id = cfg_('DRIVE_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  const props = PropertiesService.getScriptProperties();
  const auto = props.getProperty('AUTO_DRIVE_FOLDER_ID');
  if (auto) {
    try { return DriveApp.getFolderById(auto); } catch (e) { /* recreate */ }
  }
  const folder = DriveApp.createFolder('IT Helpdesk Attachments');
  props.setProperty('AUTO_DRIVE_FOLDER_ID', folder.getId());
  _props = null;
  return folder;
}

function saveFileToDrive_(f, ticketId, idx) {
  const blob = Utilities.newBlob(Utilities.base64Decode(f.data), f.mimeType, ticketId + '_' + idx + '_' + f.name);
  const file = getDriveFolder_().createFile(blob);
  file.setDescription('ไฟล์แนบ Ticket ' + ticketId);
  const mode = String(getSettingsMap_().ATTACHMENT_SHARING || 'ANYONE_WITH_LINK').toUpperCase();
  if (mode !== 'PRIVATE') {
    try {
      file.setSharing(mode === 'DOMAIN_WITH_LINK' ? DriveApp.Access.DOMAIN_WITH_LINK : DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (e) {
      try { file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW); } catch (e2) { /* ตามนโยบายองค์กร */ }
    }
  }
  return { id: file.getId(), url: 'https://drive.google.com/file/d/' + file.getId() + '/view', name: file.getName() };
}

// =====================================================================================
// 10) SPREADSHEET DATA LAYER
// =====================================================================================
function getSS_() {
  if (_ss) return _ss;
  const id = cfg_('SPREADSHEET_ID');
  if (id) { _ss = SpreadsheetApp.openById(id); return _ss; }
  let active = null;
  try { active = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { active = null; }
  if (active) { _ss = active; return _ss; }
  const props = PropertiesService.getScriptProperties();
  const autoId = props.getProperty('AUTO_SPREADSHEET_ID');
  if (autoId) {
    try { _ss = SpreadsheetApp.openById(autoId); return _ss; } catch (e) { _ss = null; }
  }
  _ss = SpreadsheetApp.create('IT Helpdesk Database');
  props.setProperty('AUTO_SPREADSHEET_ID', _ss.getId());
  _props = null;
  return _ss;
}

function ensureSchema_(force) {
  const cache = CacheService.getScriptCache();
  if (!force && cache.get('schema_ok_v1')) return;
  withLock_(function () {
    const ss = getSS_();
    Object.keys(SHEET_HEADERS).forEach(function (name) {
      const sh = ss.getSheetByName(name);
      if (!sh) { createSheet_(ss, name); return; }
      const headers = SHEET_HEADERS[name];
      const lastCol = sh.getLastColumn();
      const current = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (v) { return String(v).trim(); }) : [];
      if (!current.join('')) {
        ensureCols_(sh, headers.length);
        sh.getRange(1, 1, 1, headers.length).setValues([headers]);
        styleHeader_(sh, 1, headers.length);
        if (name === 'Settings' && sh.getLastRow() <= 1) seedSettings_(sh);
        delete _tables[name];
        return;
      }
      const missing = headers.filter(function (h) { return current.indexOf(h) < 0; });
      if (missing.length) {
        ensureCols_(sh, lastCol + missing.length);
        sh.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
        styleHeader_(sh, lastCol + 1, missing.length);
        if (sh.getMaxRows() > 1) sh.getRange(2, lastCol + 1, sh.getMaxRows() - 1, missing.length).setNumberFormat('@');
        delete _tables[name];
      }
    });
    ss.getSheets().forEach(function (sh) {
      if (/^(Sheet1|แผ่น1|แผ่นงาน1)$/.test(sh.getName()) && sh.getLastRow() === 0 && ss.getSheets().length > 1) {
        try { ss.deleteSheet(sh); } catch (e) { /* ignore */ }
      }
    });
    ensureDefaultAdmin_();
  });
  cache.put('schema_ok_v1', '1', 21600);
}

function createSheet_(ss, name) {
  const headers = SHEET_HEADERS[name];
  let sh;
  try { sh = ss.insertSheet(name); } catch (e) { sh = ss.getSheetByName(name); if (sh) return sh; throw e; }
  ensureCols_(sh, headers.length);
  sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  styleHeader_(sh, 1, headers.length);
  sh.setFrozenRows(1);
  if (name === 'Settings') seedSettings_(sh);
  delete _tables[name];
  return sh;
}

function ensureCols_(sh, n) {
  const max = sh.getMaxColumns();
  if (max < n) sh.insertColumnsAfter(max, n - max);
}

function styleHeader_(sh, col, n) {
  sh.getRange(1, col, 1, n).setFontWeight('bold').setBackground('#1e3a8a').setFontColor('#ffffff');
}

function seedSettings_(sh) {
  sh.getRange(2, 1, DEFAULT_SETTINGS.length, 3).setNumberFormat('@').setValues(DEFAULT_SETTINGS);
}

function getSheet_(name) {
  const ss = getSS_();
  return ss.getSheetByName(name) || createSheet_(ss, name);
}

/** อ่านทั้ง Sheet ครั้งเดียว (Batch) แล้วแปลงเป็น Object ตามชื่อคอลัมน์ */
function readTable_(name) {
  if (_tables[name]) return _tables[name];
  const sh = getSheet_(name);
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  const values = lastRow && lastCol ? sh.getRange(1, 1, lastRow, lastCol).getValues() : [];
  const headers = values.length ? values[0].map(function (h) { return String(h).trim(); }) : SHEET_HEADERS[name].slice();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    let empty = true;
    for (let j = 0; j < r.length; j++) { if (r[j] !== '' && r[j] != null) { empty = false; break; } }
    if (empty) continue;
    const o = { _row: i + 1 };
    headers.forEach(function (h, j) { if (h) o[h] = cellToStr_(r[j]); });
    SHEET_HEADERS[name].forEach(function (h) { if (!(h in o)) o[h] = ''; });
    rows.push(o);
  }
  _tables[name] = { sheet: sh, headers: headers, rows: rows };
  return _tables[name];
}

/** เขียน 1 แถว (อัปเดตแถวเดิมถ้ามี rowNum หรือเพิ่มแถวใหม่) ด้วย setValues ครั้งเดียว */
function writeRow_(name, obj, rowNum) {
  const t = readTable_(name);
  const sh = t.sheet;
  let headers = t.headers;
  if (!headers.join('')) {
    headers = SHEET_HEADERS[name].slice();
    ensureCols_(sh, headers.length);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    styleHeader_(sh, 1, headers.length);
  }
  const row = headers.map(function (h) { return h ? sheetSafe_(obj[h]) : ''; });
  let r = rowNum;
  if (!r) {
    r = sh.getLastRow() + 1;
    if (r > sh.getMaxRows()) {
      sh.insertRowsAfter(sh.getMaxRows(), 200);
      sh.getRange(r, 1, 200, headers.length).setNumberFormat('@');
    }
  }
  sh.getRange(r, 1, 1, row.length).setNumberFormat('@').setValues([row]);
  delete _tables[name];
  return r;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) fail_('ระบบกำลังประมวลผลคำขออื่นอยู่ กรุณาลองใหม่อีกครั้ง', 'BUSY');
  _tables = {};
  try {
    return fn();
  } finally {
    try { SpreadsheetApp.flush(); } catch (e) { /* ignore */ }
    lock.releaseLock();
  }
}

function invalidateCache_() {
  CacheService.getScriptCache().remove('dash_v1');
}

// =====================================================================================
// 11) UTILITIES
// =====================================================================================
function safe_(fn) {
  try {
    return { ok: true, data: fn() };
  } catch (e) {
    if (e && e.userMessage) return { ok: false, code: e.code || 'ERROR', message: e.userMessage };
    console.error(e && e.stack ? e.stack : e);
    return { ok: false, code: 'SERVER', message: 'เกิดข้อผิดพลาดในระบบ: ' + (e && e.message ? e.message : String(e)) };
  }
}

function unwrap_(res) { return res && res.ok ? res.data : { sent: false, message: res && res.message ? res.message : 'error' }; }

function fail_(message, code) {
  const e = new Error(message);
  e.userMessage = message;
  e.code = code || 'VALIDATION';
  throw e;
}

function getProps_() {
  if (!_props) _props = PropertiesService.getScriptProperties().getProperties();
  return _props;
}

function cfg_(key) {
  const p = getProps_()[key];
  if (p) return String(p).trim();
  const v = CONFIG[key];
  if (!v || /^YOUR_/.test(String(v))) return '';
  return String(v).trim();
}

function webAppUrl_() {
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

function str_(v, max) {
  let s = v == null ? '' : String(v);
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

function sheetSafe_(v) {
  const s = v == null ? '' : String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function cellToStr_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? '' : fmtDate_(v, 'yyyy-MM-dd HH:mm:ss');
  }
  const s = String(v);
  return /^'[=+\-@]/.test(s) ? s.slice(1) : s;
}

function csvCell_(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function isEmail_(s) { return /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]{2,}$/.test(String(s)); }

function parseCost_(v) {
  if (v === '' || v == null) return 0;
  const n = parseFloat(String(v).replace(/,/g, ''));
  if (isNaN(n) || n < 0 || n > 10000000) fail_('ค่าใช้จ่ายไม่ถูกต้อง');
  return Math.round(n * 100) / 100;
}

function randomCode_(n) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function inc_(o, k) { o[k] = (o[k] || 0) + 1; }

function toList_(o) {
  return Object.keys(o).map(function (k) { return { label: k, value: o[k] }; }).sort(function (a, b) { return b.value - a.value; });
}

function now_() { return fmtDate_(new Date(), 'yyyy-MM-dd HH:mm:ss'); }
function today_() { return fmtDate_(new Date(), 'yyyy-MM-dd'); }
function fmtDate_(d, pattern) { return Utilities.formatDate(d, CONFIG.TIMEZONE, pattern); }

/** แปลง 'yyyy-MM-dd HH:mm:ss' (เวลาไทย UTC+7) เป็น Date */
function parseDT_(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], (+m[4] || 0) - 7, +m[5] || 0, +m[6] || 0));
}

function addDays_(ymd, n) {
  const d = parseDT_(ymd + ' 12:00:00');
  return fmtDate_(new Date(d.getTime() + n * 86400000), 'yyyy-MM-dd');
}

function minutesBetween_(a, b) {
  const da = parseDT_(a), db = parseDT_(b);
  if (!da || !db) return null;
  return (db.getTime() - da.getTime()) / 60000;
}

function durationText_(mins) {
  if (mins == null || isNaN(mins) || mins < 0) return '-';
  mins = Math.round(mins);
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  const parts = [];
  if (d) parts.push(d + ' วัน');
  if (h) parts.push(h + ' ชั่วโมง');
  if (m || !parts.length) parts.push(m + ' นาที');
  return parts.join(' ');
}

/** 'yyyy-MM-dd HH:mm:ss' → 'dd/MM/พ.ศ. HH:mm' */
function thaiDT_(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return '';
  return m[3] + '/' + m[2] + '/' + (parseInt(m[1], 10) + 543) + (m[4] ? ' ' + m[4] + ':' + m[5] : '');
}

function thaiDate_(s) { return thaiDT_(String(s).slice(0, 10)); }

function thaiMonth_(ym) {
  const names = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  return names[parseInt(ym.slice(5, 7), 10) - 1] + ' ' + String(parseInt(ym.slice(0, 4), 10) + 543).slice(-2);
}

function statusLabel_(s) {
  const x = STATUS_LIST.find(function (i) { return i.value === s; });
  return x ? x.emoji + ' ' + s : String(s || '-');
}

function priorityLabel_(p) {
  const x = PRIORITY_LIST.find(function (i) { return i.value === p; });
  return x ? x.emoji + ' ' + x.value : String(p || '-');
}

function stars_(n) {
  n = Math.max(0, Math.min(5, parseInt(n, 10) || 0));
  return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
}

function formatMoney_(v) {
  const n = parseFloat(v) || 0;
  return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
