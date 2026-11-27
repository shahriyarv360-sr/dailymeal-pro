require('dotenv').config();
const express = require('express');

// 👇 এই দুই লাইন নতুন যোগ করুন
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']); 
// 👆 নতুন লাইন শেষ

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
// ... বাকি কোড


const { User, Mess, Bazar, Notice } = require('./models');
const webpush = require('web-push');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// HTML এবং স্ট্যাটিক ফাইল সার্ভ করার জন্য
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/uploads', express.static('uploads'));

// Create uploads folder if not exists
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// ================= Image Upload =================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ================= MongoDB Connection =================
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/dailymeal')
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.log('❌ MongoDB Error:', err));

// ================= Web Push Setup =================
try {
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (vapidPublic && vapidPrivate) {
    webpush.setVapidDetails(
      'mailto:admin@dailymeal.app',
      vapidPublic,
      vapidPrivate
    );
    console.log('✅ Web Push Configured');
  } else {
    console.log('⚠️ Web Push skipped: VAPID keys not in .env');
  }
} catch (error) {
  console.log('⚠️ Web Push skipped:', error.message);
}

// ================= Helpers =================
const JWT_SECRET = process.env.JWT_SECRET || 'secret123';
const signToken = (id) => jwt.sign({ id }, JWT_SECRET, { expiresIn: '30d' });
const normPhone = (p) => {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('880')) d = d.slice(2);
  if (d.length === 10 && d[0] === '1') d = '0' + d;
  return d;
};
const isAdminRole = (r) => r === 'super_admin' || r === 'admin_manager';

// ================= Auth Middleware =================
const auth = async (req, res, next) => {
  try {
    const header = req.header('Authorization') || '';
    const token = header.replace('Bearer ', '').trim();
    if (!token) return res.status(401).send({ error: 'No token provided' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) return res.status(401).send({ error: 'User not found' });
    req.user = user;
    next();
  } catch (error) {
    res.status(401).send({ error: 'Please authenticate.' });
  }
};

const adminOnly = (req, res, next) => {
  if (!isAdminRole(req.user.role)) return res.status(403).send({ error: 'Access Denied — admin only' });
  next();
};

// ================= HEALTH =================
app.get('/api/health', (req, res) => res.send({ status: 'ok', time: Date.now() }));

// ================= AUTH =================

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, role, referralCode, username, phone, profilePic, messName } = req.body;
    if (!name || !password) return res.status(400).send({ error: 'Name and password required' });
    if (!email && !username) return res.status(400).send({ error: 'Email or username required' });

    const emailLower = (email || '').toLowerCase().trim();
    const usernameLower = (username || '').toLowerCase().trim();

    const dupOr = [];
    if (emailLower) dupOr.push({ email: emailLower });
    if (usernameLower) dupOr.push({ username: usernameLower });
    if (phone && normPhone(phone)) dupOr.push({ phone: normPhone(phone) });
    if (dupOr.length) {
      const dup = await User.findOne({ $or: dupOr });
      if (dup) return res.status(400).send({ error: 'Account already exists with this email/username/phone' });
    }

    const hashedPassword = await bcrypt.hash(password, 8);
    let newUser = {
      name,
      email: emailLower || (usernameLower + '@mess.local'),
      username: usernameLower || undefined,
      password: hashedPassword,
      role: role || 'normal_user',
      phone: phone ? normPhone(phone) : '',
      profilePic: profilePic || '',
    };

    if (role === 'super_admin') {
      const newMess = await new Mess({ name: messName || `${name}'s Mess` }).save();
      newUser.messId = newMess._id;
      newUser.referralCode = `REF-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

      const savedUser = await new User(newUser).save();
      newMess.superAdminId = savedUser._id;
      await newMess.save();

      const token = signToken(savedUser._id);
      return res.status(201).send({ user: savedUser, token });
    } else {
      if (!referralCode) return res.status(400).send({ error: 'Referral Code Required' });
      const superAdmin = await User.findOne({ referralCode: String(referralCode).trim().toUpperCase() });
      if (!superAdmin) return res.status(400).send({ error: 'Invalid Referral Code' });
      newUser.messId = superAdmin.messId;
      newUser.referredBy = superAdmin._id;

      const user = await new User(newUser).save();
      const token = signToken(user._id);
      return res.status(201).send({ user, token });
    }
  } catch (e) {
    res.status(400).send({ error: e.message });
  }
});

// Login — email / username / phone সাপোর্ট
app.post('/api/login', async (req, res) => {
  try {
    const { email, identifier, password } = req.body;
    const lookup = String(identifier || email || '').trim();
    if (!lookup || !password) return res.status(400).send({ error: 'Credentials required' });

    const lookupLower = lookup.toLowerCase();
    const phoneDigits = normPhone(lookup);

    const or = [
      { email: lookupLower },
      { username: lookupLower },
    ];
    if (phoneDigits && phoneDigits.length === 11) or.push({ phone: phoneDigits });

    const user = await User.findOne({ $or: or });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).send({ error: 'Invalid credentials' });
    }
    const token = signToken(user._id);
    res.send({ user, token });
  } catch (e) {
    res.status(400).send({ error: e.message });
  }
});

// Google Login
app.post('/api/google-login', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).send({ error: 'No credential' });

    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
    const info = await r.json();
    if (!info || !info.email || info.email_verified === 'false') {
      return res.status(400).send({ error: 'Invalid Google token' });
    }

    const email = info.email.toLowerCase();
    let user = await User.findOne({ email });
    if (!user) {
      return res.status(404).send({ error: 'No account with this email. Please register.', googleEmail: email, googleName: info.name, googlePic: info.picture });
    }
    if (!user.profilePic && info.picture) {
      user.profilePic = info.picture;
      await user.save();
    }
    const token = signToken(user._id);
    res.send({ user, token });
  } catch (e) {
    res.status(400).send({ error: e.message });
  }
});

// Forgot password
app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email, phone, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).send({ error: 'Password must be at least 6 characters' });
    }
    const lookup = String(email || '').trim().toLowerCase();
    const phoneDigits = normPhone(phone);

    const user = await User.findOne({
      $or: [{ email: lookup }, { username: lookup }]
    });
    if (!user) return res.status(404).send({ error: 'No account with this email/username' });

    if (!user.phone || normPhone(user.phone) !== phoneDigits) {
      return res.status(400).send({ error: 'Phone number does not match' });
    }

    user.password = await bcrypt.hash(newPassword, 8);
    await user.save();
    res.send({ success: true, message: 'Password changed successfully' });
  } catch (e) {
    res.status(400).send({ error: e.message });
  }
});

// ================= USER / PROFILE =================

app.put('/api/user/profile', auth, async (req, res) => {
  try {
    const updates = { ...req.body };
    delete updates.role;
    delete updates._id;
    delete updates.password;

    if (req.body.password) {
      if (req.body.password.length < 6) {
        return res.status(400).send({ error: 'Password must be at least 6 characters' });
      }
      updates.password = await bcrypt.hash(req.body.password, 8);
    }

    if (updates.username) {
      updates.username = updates.username.toLowerCase().trim();
      const exists = await User.findOne({ username: updates.username, _id: { $ne: req.user._id } });
      if (exists) return res.status(400).send({ error: 'Username already taken' });
    }
    if (updates.phone) updates.phone = normPhone(updates.phone);

    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true }).select('-password');
    res.send(user);
  } catch (e) {
    res.status(400).send({ error: e.message });
  }
});

app.get('/api/users', auth, async (req, res) => {
  const users = await User.find({ messId: req.user.messId }).select('-password');
  res.send(users);
});

app.put('/api/user/role/:id', auth, async (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).send({ error: 'Only Super Admin can change roles' });
  const { role } = req.body;
  if (!['super_admin', 'admin_manager', 'normal_user'].includes(role)) {
    return res.status(400).send({ error: 'Invalid role' });
  }
  const user = await User.findByIdAndUpdate(req.params.id, { role }, { new: true }).select('-password');
  res.send(user);
});

// Deposit (Admin adds to member)
app.put('/api/user/:id/deposit', auth, async (req, res) => {
  try {
    if (!['super_admin','admin_manager'].includes(req.user.role)) {
      return res.status(403).send({ error: 'Forbidden' });
    }
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).send({ error: 'User not found' });
    if (String(user.messId) !== String(req.user.messId)) {
      return res.status(403).send({ error: 'Not in your mess' });
    }
    user.balance = (user.balance || 0) + Number(req.body.amount || 0);
    await user.save();
    res.send(user);
  } catch (e) {
    res.status(400).send({ error: e.message });
  }
});

// ================= BAZAR =================

app.post('/api/bazar', auth, adminOnly, upload.single('image'), async (req, res) => {
  try {
    const { items, buyers } = req.body;
    const parsedItems = JSON.parse(items || '[]');
    let total = 0;
    parsedItems.forEach(item => {
      item.totalCost = Number(item.totalCost) || (Number(item.quantity) * Number(item.ratePerUnit)) || 0;
      total += item.totalCost;
    });

    const bazar = new Bazar({
      messId: req.user.messId,
      items: parsedItems,
      buyers: JSON.parse(buyers || '[]'),
      image: req.file ? '/uploads/' + req.file.filename : null,
      handwrittenListImage: req.file ? '/uploads/' + req.file.filename : null,
      totalBazarCost: total
    });
    await bazar.save();
    res.status(201).send(bazar);
  } catch (e) {
    res.status(400).send({ error: e.message });
  }
});

app.get('/api/bazar', auth, async (req, res) => {
  const bazars = await Bazar.find({ messId: req.user.messId }).sort({ date: -1 });
  res.send(bazars);
});

app.delete('/api/bazar/:id', auth, adminOnly, async (req, res) => {
  try {
    const b = await Bazar.findOne({ _id: req.params.id, messId: req.user.messId });
    if (!b) return res.status(404).send({ error: 'Not found' });
    
    // ডিলিট করার আগে খরচের লিস্ট থেকে বাদ দিন
    const mess = await Mess.findById(req.user.messId);
    if (mess) {
      mess.expenses = (mess.expenses || []).filter(e => e.recId !== req.params.id);
      await mess.save();
    }
    
    await Bazar.deleteOne({ _id: req.params.id });
    res.send({ success: true });
  } catch (e) {
    res.status(400).send({ error: e.message });
  }
});

// ================= NOTICE & PUSH =================

app.post('/api/notice', auth, adminOnly, async (req, res) => {
  try {
    const { title, body } = req.body;
    if (!title || !body) return res.status(400).send({ error: 'Title and body required' });
    const notice = await new Notice({
      messId: req.user.messId,
      title, body,
      authorName: req.user.name
    }).save();

    const users = await User.find({ messId: req.user.messId, pushSubscription: { $exists: true, $ne: null } });
    const payload = JSON.stringify({ title, body, icon: '/icon.png' });
    users.forEach(u => {
      webpush.sendNotification(u.pushSubscription, payload).catch(err => console.log('push err:', err.message));
    });

    res.status(201).send(notice);
  } catch (e) {
    res.status(400).send({ error: e.message });
  }
});

app.get('/api/notice', auth, async (req, res) => {
  const notices = await Notice.find({ messId: req.user.messId }).sort({ createdAt: -1 }).limit(100);
  res.send(notices);
});

app.post('/api/subscribe', auth, async (req, res) => {
  try {
    if (!req.body || !req.body.endpoint) {
      return res.status(400).send({ error: 'Invalid subscription' });
    }
    await User.findByIdAndUpdate(req.user._id, { pushSubscription: req.body });
    res.status(201).send({ success: true });
  } catch (e) {
    res.status(400).send({ error: e.message });
  }
});

// ================= MONTH CLOSE =================

app.post('/api/close-month', auth, async (req, res) => {
  try {
    if (req.user.role !== 'super_admin') {
      return res.status(403).send({ error: 'Only Super Admin' });
    }
    const mess = await Mess.findById(req.user.messId);
    if (!mess) return res.status(404).send({ error: 'Mess not found' });

    const members = await User.find({ messId: req.user.messId });

    const totalExpense = (mess.expenses || []).reduce((a, b) => a + (Number(b.amt) || 0), 0);
    let totalMeals = 0;
    Object.keys(mess.meals || {}).forEach(key => {
      const m = mess.meals[key];
      if (m === 'F') totalMeals += 2.5;
      else if (m === 'HD' || m === 'HR' || m === 'D') totalMeals += 1.5;
      else if (m === 'H') totalMeals += 0.5;
      else if (m === 'N') totalMeals += 1;
      else if (m === 'T') totalMeals += 3;
      else if (m && m.startsWith && m.startsWith('C')) {
        const v = parseFloat(m.slice(1).split('_')[0]);
        if (!isNaN(v)) totalMeals += v;
      }
    });

    const mealRate = totalMeals > 0 ? totalExpense / totalMeals : 0;

    if (!mess.monthArchive) mess.monthArchive = [];
    mess.monthArchive.push({
      month: new Date().getMonth() + 1,
      year: new Date().getFullYear(),
      rate: mealRate,
      totalExpense, totalMeals,
      members: members.map(u => ({
        name: u.name,
        deposit: u.balance || 0,
        balance: u.balance || 0
      })),
      closedAt: Date.now(),
      closedBy: req.user.name
    });

    for (const u of members) {
      let userMeals = 0;
      Object.keys(mess.meals || {}).forEach(key => {
        if (key.startsWith(u._id.toString())) {
          const m = mess.meals[key];
          if (m === 'F') userMeals += 2.5;
          else if (m === 'HD' || m === 'HR' || m === 'D') userMeals += 1.5;
          else if (m === 'H') userMeals += 0.5;
          else if (m === 'N') userMeals += 1;
          else if (m === 'T') userMeals += 3;
          else if (m && m.startsWith && m.startsWith('C')) {
            const v = parseFloat(m.slice(1).split('_')[0]);
            if (!isNaN(v)) userMeals += v;
          }
        }
      });
      const cost = userMeals * mealRate;
      const newBalance = (u.balance || 0) - cost;
      await User.findByIdAndUpdate(u._id, { balance: newBalance });
    }

    mess.meals = {};
    mess.expenses = [];
    await mess.save();

    res.send({ success: true, message: 'Month closed successfully', rate: mealRate });
  } catch (e) {
    res.status(400).send({ error: e.message });
  }
});

// ================= ADMIN: manual member add/delete =================

app.post('/api/member', auth, adminOnly, async (req, res) => {
  try {
    const { name, phone, email } = req.body;
    if (!name) return res.status(400).send({ error: 'Name required' });
    const emailLower = (email || (name.toLowerCase().replace(/\s+/g, '.') + Date.now() + '@mess.local')).toLowerCase();
    const tempPass = Math.random().toString(36).slice(2, 10);
    const hashed = await bcrypt.hash(tempPass, 8);

    const user = await new User({
      name,
      email: emailLower,
      password: hashed,
      role: 'normal_user',
      phone: phone ? normPhone(phone) : '',
      messId: req.user.messId,
      balance: 0
    }).save();

    res.status(201).send({ user, tempPassword: tempPass });
  } catch (e) {
    res.status(400).send({ error: e.message });
  }
});

app.delete('/api/member/:id', auth, adminOnly, async (req, res) => {
  try {
    const u = await User.findOne({ _id: req.params.id, messId: req.user.messId });
    if (!u) return res.status(404).send({ error: 'Not found' });
    if (String(u._id) === String(req.user._id)) {
      return res.status(400).send({ error: 'Cannot delete yourself' });
    }
    await User.deleteOne({ _id: req.params.id });
    res.send({ success: true });
  } catch (e) {
    res.status(400).send({ error: e.message });
  }
});
// ================= MESS DATA (SYNC) =================

// ১. সব ডাটা লোড করা (Meal, Bazar, Notice, Requests)
app.get('/api/mess-data', auth, async (req, res) => {
  try {
    const mess = await Mess.findById(req.user.messId);
    if (!mess) return res.status(404).send({ error: 'Mess not found' });
    
    res.send({
      meals: mess.meals || {},
      expenses: mess.expenses || [],
      notices: mess.notices || [],
      mealRequests: mess.mealRequests || [],
      depositRequests: mess.depositRequests || []
    });
  } catch (e) { res.status(400).send({ error: e.message }); }
});

// ২. ডাটা আপডেট করা (Meal, Bazar, Notice, Requests)
app.post('/api/mess-data', auth, async (req, res) => {
  try {
    const { meals, expenses, notices, mealRequests, depositRequests } = req.body;
    const mess = await Mess.findById(req.user.messId);
    if (!mess) return res.status(404).send({ error: 'Mess not found' });

    // মেসে ডাটা আপডেট
    if (meals) mess.meals = meals;
    if (expenses) mess.expenses = expenses;
    if (notices) mess.notices = notices;
    if (mealRequests) mess.mealRequests = mealRequests;
    if (depositRequests) mess.depositRequests = depositRequests;

    await mess.save();
    res.send({ success: true });
  } catch (e) { res.status(400).send({ error: e.message }); }
});

// ================= 404 (Express 5 compatible) =================
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).send({ error: 'Endpoint not found: ' + req.originalUrl });
  }
  next();
});

// ================= ERROR HANDLER =================
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).send({ error: err.message || 'Internal server error' });
});

// ================= START SERVER =================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));