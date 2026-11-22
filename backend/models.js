const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  username: { type: String, unique: true, sparse: true, lowercase: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['super_admin', 'admin_manager', 'normal_user'], default: 'normal_user' },
  phone: { type: String, default: '' },
  room: { type: String, default: '' },
  profilePic: { type: String, default: '' },
  balance: { type: Number, default: 0 },
  messId: { type: mongoose.Schema.Types.ObjectId, ref: 'Mess' },
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  pushSubscription: { type: Object },
}, { timestamps: true });

const messSchema = new mongoose.Schema({
  name: { type: String, required: true },
  superAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  
  // পুরনো ফিল্ড
  meals: { type: Object, default: {} },
  expenses: { type: Array, default: [] },
  monthArchive: { type: Array, default: [] },
  closedMonths: { type: Object, default: {} },

  // 👇 এই ৩টা নতুন লাইন যোগ করুন
  notices: { type: Array, default: [] },
  mealRequests: { type: Array, default: [] },
  depositRequests: { type: Array, default: [] },

  createdAt: { type: Date, default: Date.now }
});

const bazarSchema = new mongoose.Schema({
  messId: { type: mongoose.Schema.Types.ObjectId, ref: 'Mess', required: true },
  date: { type: Date, default: Date.now },
  items: [{
    itemName: String,
    quantity: Number,
    unit: String,
    ratePerUnit: Number,
    totalCost: Number,
    mode: String,
    buyer: String
  }],
  buyers: [String],
  image: String,
  handwrittenListImage: String,
  totalBazarCost: { type: Number, default: 0 }
}, { timestamps: true });

const noticeSchema = new mongoose.Schema({
  messId: { type: mongoose.Schema.Types.ObjectId, ref: 'Mess' },
  title: String,
  body: String,
  authorName: String,
  createdAt: { type: Date, default: Date.now }
});

module.exports = {
  User: mongoose.model('User', userSchema),
  Mess: mongoose.model('Mess', messSchema),
  Bazar: mongoose.model('Bazar', bazarSchema),
  Notice: mongoose.model('Notice', noticeSchema)
};