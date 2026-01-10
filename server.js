const express = require('express');
const path = require('path');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 10000;

// Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Multer + Cloudinary Storage
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: { folder: 'creovia_products', allowed_formats: ['jpg','png','pdf','zip'] }
});
const upload = multer({ storage: storage });

// ملفات ثابتة
app.use(express.static(__dirname));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// رفع الملفات + تخزين بيانات المنتج في Firebase
app.post('/upload', upload.array('files'), async (req, res) => {
  try {
    const { name, desc } = req.body;
    const files = req.files;
    const fileUrls = files.map(f => f.path);

    await db.collection('products').add({
      name,
      description: desc,
      files: fileUrls,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ message: 'Product uploaded successfully!', files: fileUrls });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error uploading product', error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
