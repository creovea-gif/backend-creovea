async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const token = authHeader.split('Bearer ')[1];

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded; // email, uid
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid token' });
  }
}

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

/* =========================
   CORS
========================= */
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
}));

/* =========================
   Body Parsers
========================= */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================
   Firebase Admin
========================= */
const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON
);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

/* =========================
   Cloudinary Config
========================= */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/* =========================
   Multer + Cloudinary Storage
========================= */
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: 'creovia_products',
    resource_type: 'auto',
    public_id: `${Date.now()}-${file.originalname}`,
  }),
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

/* =========================
   Upload Product
========================= */
app.post(
  '/upload',
  upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'preview', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { name, desc, type, price } = req.body;

      if (!name || !desc || !type || !price) {
        return res.status(400).json({
          message: 'Missing required fields',
        });
      }

      if (!req.files?.file || !req.files?.preview) {
        return res.status(400).json({
          message: 'File or preview image missing',
        });
      }

      const fileUrl = req.files.file[0].path;
      const previewImage = req.files.preview[0].path;

     const productData = {
    name,
    description: desc,
    type,
    price: Number(price),
    previewImage,
    fileUrl,
    salesCount: 0,
    sellerEmail: req.body.sellerEmail, // ← هذا السطر الجديد
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
};


      const docRef = await db.collection('products').add(productData);

      res.json({
        message: 'Product uploaded successfully!',
        product: { id: docRef.id, ...productData },
      });
    } catch (error) {
      console.error('Upload error:', error);
      res.status(500).json({
        message: 'Upload failed',
        error: error.message,
      });
    }
  }
);


/* =========================
   Get All Products
========================= */
app.get('/products', async (req, res) => {
  try {
    const snapshot = await db
      .collection('products')
      .orderBy('createdAt', 'desc') // ترتيب من الأحدث
      .get();

    const products = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json(products);
  } catch (error) {
    console.error('Fetch products error:', error);
    res.status(500).json({
      message: 'Failed to fetch products',
    });
  }
});

/* =========================
   Seller Dashboard Data
========================= */
app.get('/seller-dashboard', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ message: 'Email required' });

    // جلب منتجات البائع
    const snapshot = await db
  .collection('products')
  .where('sellerEmail', '==', email)
  .get();


    let productsCount = snapshot.size;
    let totalDownloads = 0;
    let totalSalesAmount = 0;
    const products = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      const sales = data.salesCount || 0;
      const price = data.price || 0;
      totalDownloads += sales;
      totalSalesAmount += sales * price;
      products.push({
        name: data.name,
        sales
      });
    });

    // جلب مجموع المسحوبات
    let withdrawnAmount = 0;
    const payoutSnap = await db.collection('payout_requests')
      .where('sellerEmail', '==', email)
      .where('status', 'in', ['pending','approved'])
      .get();

    payoutSnap.forEach(doc => {
      withdrawnAmount += doc.data().amount || 0;
    });

    const grossEarnings = totalSalesAmount * 0.7;
    const sellerEarnings = Math.max(grossEarnings - withdrawnAmount, 0);

    res.json({
      productsCount,
      totalDownloads,
      sellerEarnings,
      products
    });

  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ message: 'Dashboard fetch failed' });
  }
});


/* =========================
   Request Payout
========================= */
app.post('/request-payout', verifyFirebaseToken, async (req, res) => {
  try {
    const sellerEmail = req.user.email;
    const { amount } = req.body;

    if (!amount) {
      return res.status(400).json({ message: 'Missing amount' });
    }

    if (amount < 50) {
      return res.status(400).json({ message: 'Minimum payout is $50' });
    }

    // 🔹 حساب إجمالي المبيعات
    const productsSnap = await db
      .collection('products')
      .where('sellerEmail', '==', sellerEmail)
      .get();

    let totalSalesAmount = 0;

    productsSnap.forEach(doc => {
      const data = doc.data();
      totalSalesAmount += (data.salesCount || 0) * (data.price || 0);
    });

    const grossEarnings = totalSalesAmount * 0.7;

    // 🔹 حساب المسحوبات السابقة
    let withdrawnAmount = 0;
    const payoutSnap = await db
      .collection('payout_requests')
      .where('sellerEmail', '==', sellerEmail)
      .where('status', 'in', ['pending', 'approved'])
      .get();

    payoutSnap.forEach(doc => {
      withdrawnAmount += doc.data().amount || 0;
    });

    const availableBalance = grossEarnings - withdrawnAmount;

    if (availableBalance < amount) {
      return res.status(400).json({
        message: `Insufficient balance. Available: $${availableBalance.toFixed(2)}`
      });
    }

    // 🔹 منع طلبين معلقين
    const pendingSnap = await db
      .collection('payout_requests')
      .where('sellerEmail', '==', sellerEmail)
      .where('status', '==', 'pending')
      .get();

    if (!pendingSnap.empty) {
      return res.status(400).json({
        message: 'You already have a pending payout request'
      });
    }

    // 🔹 إنشاء طلب السحب
    await db.collection('payout_requests').add({
      sellerEmail,
      amount,
      status: 'pending',
      requestedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true });

  } catch (error) {
    console.error('Payout error:', error);
    res.status(500).json({ message: 'Payout request failed' });
  }
});



/* =========================
   Register Payment & Generate Download Link
========================= */
app.post('/record-payment', async (req, res) => {
  const { productId, orderId } = req.body;

  try {
    // 1️⃣ الحصول على Access Token من PayPal
    const tokenRes = await axios.post(
      `${process.env.PAYPAL_API}/v1/oauth2/token`,
      'grant_type=client_credentials',
      {
        auth: {
          username: process.env.PAYPAL_CLIENT_ID,
          password: process.env.PAYPAL_SECRET
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const accessToken = tokenRes.data.access_token;

    // 2️⃣ التحقق من الطلب
    const orderRes = await axios.get(
      `${process.env.PAYPAL_API}/v2/checkout/orders/${orderId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

// ⚠️ إذا لم يكن مكتمل، نقوم بالـ CAPTURE
let finalStatus = orderRes.data.status;

// إذا لم يكتمل، حاول عمل capture مرة واحدة
if (finalStatus !== 'COMPLETED') {
    try {
        const captureRes = await axios.post(
            `${process.env.PAYPAL_API}/v2/checkout/orders/${orderId}/capture`,
            {},
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        finalStatus = captureRes.data.status;
    } catch (captureError) {
        console.warn('Capture failed:', captureError.response?.data || captureError.message);
        // لو فشل capture في Sandbox، نسمح مؤقتًا لتجربة الكتب
        if (process.env.NODE_ENV !== 'production') {
            finalStatus = 'COMPLETED'; // السماح مؤقتًا في التطوير
        } else {
            return res.status(400).json({ message: 'Payment not completed' });
        }
    }
}

if (finalStatus !== 'COMPLETED') {
    return res.status(400).json({ message: 'Payment not completed' });
}


   // 3️⃣ جلب المنتج
const productRef = db.collection('products').doc(productId);
const productDoc = await productRef.get();

if (!productDoc.exists) {
  return res.status(404).json({ message: 'Product not found' });
}

// 🔥 خذ بيانات المنتج أولاً
const productData = productDoc.data();

// 4️⃣ زيادة المبيعات
await productRef.update({
  salesCount: admin.firestore.FieldValue.increment(1)
});

// ✅ تسجيل عملية البيع (الآن productData موجود)
await db.collection('payments').add({
  productId,
  sellerEmail: productData.sellerEmail,
  price: productData.price,
  sellerShare: productData.price * 0.7,
  orderId,
  createdAt: admin.firestore.FieldValue.serverTimestamp()
});

// رابط التحميل
const downloadUrl = productData.fileUrl;

     await db.collection('purchases').add({
  productId,
  buyerUid: req.user.uid,   // مهم جدًا
  createdAt: admin.firestore.FieldValue.serverTimestamp()
});

     
res.json({ success: true, downloadUrl });


  } catch (error) {
    console.error('PayPal verify error:', error.response?.data || error.message);
    res.status(500).json({ message: 'Payment verification failed' });
  }
});

/* =========================
   Register Download / Increase Sales Count (القديم - يمكن إزالته لاحقاً إذا أردت حماية كاملة)
========================= */
app.get('/download/:productId', async (req, res) => {
  const { productId } = req.params;

  try {
    const productRef = db.collection('products').doc(productId);
    const productDoc = await productRef.get();

    if (!productDoc.exists) {
      return res.status(404).json({ message: 'Product not found' });
    }

    // زيادة عدد المبيعات (يمكن تعطيل هذا إذا أردت أن الدفع فقط يزيد المبيعات)
  

    const productData = productDoc.data();
    const downloadUrl = productData.fileUrl;


    res.redirect(downloadUrl);
  } catch (error) {
    console.error('Download tracking error:', error);
    res.status(500).json({ message: 'Server error during download tracking' });
  }
});

/* =========================
   Health Check
========================= */
app.get('/', (req, res) => {
  res.send('Creovia backend is running ✅');
});

/* =========================
   Start Server
========================= */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});























