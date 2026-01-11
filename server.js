const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const admin = require('firebase-admin');

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
        salesCount: 0,               // ← إضافة حقل عدد المبيعات (يبدأ بـ 0)
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
      .orderBy('createdAt', 'desc')
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
   Register Download / Increase Sales Count
========================= */
app.get('/download/:productId', async (req, res) => {
  const { productId } = req.params;

  try {
    const productRef = db.collection('products').doc(productId);
    const productDoc = await productRef.get();

    if (!productDoc.exists) {
      return res.status(404).json({ message: 'Product not found' });
    }

    // زيادة عدد المبيعات بمقدار 1
    await productRef.update({
      salesCount: admin.firestore.FieldValue.increment(1)
    });

    // إعادة توجيه المستخدم لتحميل الملف الفعلي (من Cloudinary)
    const productData = productDoc.data();
    const downloadUrl = productData.fileUrl.replace('/upload/', '/upload/fl_attachment/');

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
