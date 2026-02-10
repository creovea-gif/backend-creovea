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
const allowedOrigins = [
  'http://creovia.uk',
  'http://www.creovia.uk',
  'https://creovia.uk',
  'https://www.creovia.uk'
];

app.use(cors({
  origin: function(origin, callback) {
    if(!origin) return callback(null, true); // يسمح بالطلبات من Postman أو curl
    if(allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  methods: ['GET','POST']
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
  verifyFirebaseToken,
  upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'preview', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { name, desc, type, price, pages } = req.body;


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
 filePath: fileUrl,

  salesCount: 0,
  sellerEmail: req.user.email,
  pages: pages ? Number(pages) : null, // ✅ اختياري
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
app.get('/seller-dashboard', verifyFirebaseToken, async (req, res) => {
const sellerEmail = req.user.email;

  try {
   
    // جلب منتجات البائع
    const snapshot = await db
  .collection('products')
  .where('sellerEmail', '==', sellerEmail)

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
     .where('sellerEmail', '==', sellerEmail)

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
   PayPal Config (Sandbox)
========================= */

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_SECRET;

const PAYPAL_BASE = "https://api-m.sandbox.paypal.com";


/* =========================
   Register Payment & Generate Download Link
========================= */
app.post('/record-payment', async (req, res) => {
  const { productId, orderId } = req.body;

  try {

    if (!productId || !orderId) {
      return res.status(400).json({ message: 'Missing productId or orderId' });
    }

    // 1️⃣ Get PayPal access token
    const tokenRes = await axios.post(
      `${PAYPAL_BASE}/v1/oauth2/token`,
      'grant_type=client_credentials',
      {
        auth: {
          username: PAYPAL_CLIENT_ID,
          password: PAYPAL_SECRET
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const accessToken = tokenRes.data.access_token;

    // 2️⃣ Get order details
    const orderRes = await axios.get(
      `${PAYPAL_BASE}/v2/checkout/orders/${orderId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    const order = orderRes.data;

    console.log("PAYPAL STATUS:", order.status);

    // 3️⃣ IMPORTANT: must be completed
    if (order.status !== "COMPLETED") {
      return res.status(400).json({
        message: 'Payment not completed',
        status: order.status
      });
    }

    // 4️⃣ Get product
    const productRef = db.collection('products').doc(productId);
    const productDoc = await productRef.get();

    if (!productDoc.exists) {
      return res.status(404).json({
        message: 'Product not found'
      });
    }

    const productData = productDoc.data();

    // 5️⃣ Prevent duplicate payment
    const existingPayment = await db
      .collection('payments')
      .where('orderId', '==', orderId)
      .limit(1)
      .get();

    if (!existingPayment.empty) {
      return res.json({
        success: true,
        downloadUrl: `https://api.creovia.uk/secure-download/${productId}/${orderId}`
      });
    }

    // 6️⃣ Increase sales count
    await productRef.update({
      salesCount: admin.firestore.FieldValue.increment(1)
    });

    // 7️⃣ Save payment
    await db.collection('payments').add({
      productId,
      orderId,
      sellerEmail: productData.sellerEmail,
      price: productData.price,
      sellerShare: productData.price * 0.7,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 8️⃣ Return download link
    res.json({
      success: true,
      downloadUrl: `https://api.creovia.uk/secure-download/${productId}/${orderId}`
    });

  } catch (error) {

    console.error("PAYPAL ERROR:", error.response?.data || error.message);

    res.status(500).json({
      message: 'Payment verification failed',
      error: error.response?.data || error.message
    });

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
   Secure Download (PROTECTED)
========================= */
app.get('/secure-download/:productId/:orderId', async (req, res) => {
  const { productId, orderId } = req.params;

  try {
    // تحقق من الدفع
    const paymentSnap = await db
      .collection('payments')
      .where('orderId', '==', orderId)
      .where('productId', '==', productId)
      .limit(1)
      .get();

    if (paymentSnap.empty) {
      return res.status(403).send('Unauthorized download');
    }

    // جلب المنتج
    const productDoc = await db
      .collection('products')
      .doc(productId)
      .get();

    if (!productDoc.exists) {
      return res.status(404).send('Product not found');
    }

    const productData = productDoc.data();

    // إعادة التوجيه للملف
    res.redirect(productData.filePath);

  } catch (error) {
    console.error('Secure download error:', error);
    res.status(500).send('Download failed');
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















































